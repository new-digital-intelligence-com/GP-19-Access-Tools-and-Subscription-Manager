import { NextResponse } from "next/server";
import {
  importEntitlement,
  listEntitlements,
  markEntitlement,
  revokeAccess,
} from "@/lib/entitlements";
import { listTools } from "@/lib/catalog";
import { operator } from "@/lib/settings";
import type { Entitlement, EntitlementStatus } from "@/lib/types";
import { ActionPasswordError, requireActionPassword } from "@/lib/guard";

export const runtime = "nodejs";

const STATUSES: EntitlementStatus[] = ["active", "revoked", "pending-revoke"];

function isStatus(value: unknown): value is EntitlementStatus {
  return typeof value === "string" && (STATUSES as string[]).includes(value);
}

function failure(error: unknown, status = 500) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Unknown error" },
    // A wrong or missing confirmation password carries its own status, and the
    // panel branches on it: 401 asks again, 403 says it was wrong, 503 says the
    // guard is not configured at all.
    { status: error instanceof ActionPasswordError ? error.status : status },
  );
}

/** The register: who holds what, filtered the way the panel asks for it. */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const personEmail = params.get("personEmail")?.trim() || undefined;
    const toolId = params.get("toolId")?.trim() || undefined;
    const status = params.get("status")?.trim() ?? "";

    // A filter value nobody recognises must not fall back to "no filter" — the
    // table would then show every row under a heading that says otherwise.
    // Resolving it to a typed value here is also what lets the compiler agree
    // it is an EntitlementStatus at the call site.
    let wanted: EntitlementStatus | undefined;
    if (status && status !== "all") {
      if (!isStatus(status)) {
        return NextResponse.json(
          { error: `Unknown entitlement status "${status}".` },
          { status: 400 },
        );
      }
      wanted = status;
    }

    const [entitlements, all] = await Promise.all([
      listEntitlements({ personEmail, toolId, status: wanted }),
      // Archived tools are read too: access to a tool nobody manages any more
      // is exactly the access a review needs to see, and it still needs a name.
      listTools(true),
    ]);

    const names = new Map(all.map((tool) => [tool.id, tool.name]));
    const withNames: (Entitlement & { toolName: string })[] = entitlements.map((item) => ({
      ...item,
      toolName: names.get(item.toolId) ?? item.toolId,
    }));

    return NextResponse.json({
      entitlements: withNames,
      tools: all.filter((tool) => !tool.archivedAt),
    });
  } catch (error) {
    return failure(error);
  }
}

/**
 * IMPORT ONLY — record access that already exists in the provider.
 *
 * This calls `importEntitlement`, which writes a row and provisions nothing.
 * It is how a subscription that predates this app gets into the register so
 * reviews can reach it; the row is marked `source: "imported"` precisely
 * because nobody here approved it.
 *
 * Granting does not happen on this route and must never be added to it. The
 * only path from "no access" to "access" is an approved request, through
 * `requests.approve()` in `/api/requests/decide`. Wiring `grantAccess` in here
 * would create access with no approver's name on it — the one thing this app
 * exists to prevent. If someone needs access, raise a request.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<{
      personEmail: string;
      personName: string;
      toolId: string;
      role: string;
    }>;

    const personEmail = typeof body.personEmail === "string" ? body.personEmail.trim() : "";
    const toolId = typeof body.toolId === "string" ? body.toolId.trim() : "";
    if (!personEmail || !toolId) {
      return NextResponse.json(
        { error: "A person email and a tool id are both required to import a grant." },
        { status: 400 },
      );
    }

    const entitlement = await importEntitlement({
      personEmail,
      personName: body.personName?.trim() || undefined,
      toolId,
      role: body.role?.trim() || undefined,
      actor: operator(),
    });

    // Undefined means the register already holds an active grant of this tool
    // to this person. Importing a second one would double-count the seat and
    // give a review two rows to decide on for one piece of access.
    if (!entitlement) {
      return NextResponse.json(
        {
          error:
            `${personEmail} already has an active grant of this tool in the register. ` +
            "Revoke the existing one first if the role needs to change.",
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ entitlement });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Set a status by hand, for after a human finished a `manual` tool in the
 * vendor's own console. This changes the record, not the provider — it is the
 * human asserting what they already did, which is why `markEntitlement` audits
 * it as an off-API change under their name.
 */
export async function PATCH(request: Request) {
  try {
    // Hand-marking is gated because of what it can hide: setting a row to
    // "revoked" without having removed anything makes the register state
    // something untrue, and the next review skips that person entirely.
    requireActionPassword(request);

    const body = (await request.json()) as Partial<{ id: string; status: EntitlementStatus }>;
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      return NextResponse.json({ error: "An entitlement id is required." }, { status: 400 });
    }
    if (!isStatus(body.status)) {
      return NextResponse.json(
        { error: `Status must be one of ${STATUSES.join(", ")}.` },
        { status: 400 },
      );
    }

    const entitlement = await markEntitlement(id, body.status, operator());
    if (!entitlement) {
      return NextResponse.json(
        { error: `No entitlement with id ${id}.` },
        { status: 404 },
      );
    }
    return NextResponse.json({ entitlement });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Revoke. The reason is not optional.
 *
 * An entitlement that disappears with no reason attached is unreviewable six
 * months later: the trail shows access was removed and nothing shows why, so
 * nobody can tell a routine offboard from a mistake worth undoing.
 */
export async function DELETE(request: Request) {
  try {
    requireActionPassword(request);

    const params = new URL(request.url).searchParams;
    const id = params.get("id")?.trim() ?? "";
    const reason = params.get("reason")?.trim() ?? "";

    if (!id) {
      return NextResponse.json({ error: "An entitlement id is required." }, { status: 400 });
    }
    if (!reason) {
      return NextResponse.json(
        { error: "A reason is required. A revoke with no reason cannot be reviewed later." },
        { status: 400 },
      );
    }

    const result = await revokeAccess({ entitlementId: id, revokedBy: operator(), reason });

    // No entitlement came back at all: the call never reached the provider
    // because the id, or the tool it points at, does not exist. That is a bad
    // request, not a refused revoke.
    if (!result.entitlement) {
      return NextResponse.json({ error: result.detail }, { status: 404 });
    }

    // A refused revoke is a 200 carrying `ok: false`, deliberately. The request
    // succeeded — we asked, and the provider said no — and the entitlement is
    // now `pending-revoke`, meaning the person may still have the access. The
    // client has to be able to say "revoke failed, access may remain" with the
    // provider's own words underneath, which a generic error status would flatten
    // into "something went wrong". `ok: true` with a `pending-revoke` status is
    // the third case: the provider has no API path and a human must finish it.
    return NextResponse.json({
      ok: result.ok,
      detail: result.detail,
      entitlement: result.entitlement,
    });
  } catch (error) {
    return failure(error);
  }
}
