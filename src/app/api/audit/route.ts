import { NextResponse } from "next/server";
import { listAudit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * The audit trail, read-only.
 *
 * There is deliberately no POST here. The trail is append-only, and the only
 * writers are the domain modules that actually did the thing being recorded —
 * `requests`, `entitlements`, `reviews`, `lifecycle`, `catalog` writes. An
 * endpoint that let a caller post an entry would let anyone write history that
 * never happened, which costs the trail the only property that makes it worth
 * keeping. Nothing edits or deletes entries either, for the same reason.
 */

const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 200;

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;

    const rawLimit = Number(params.get("limit"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const events = await listAudit({
      personEmail: params.get("personEmail")?.trim().toLowerCase() || undefined,
      toolId: params.get("toolId")?.trim() || undefined,
      requestId: params.get("requestId")?.trim() || undefined,
      // Matched as a substring, so "revoke" covers revoke.provisioned,
      // revoke.failed and revoke.manual-required in one filter.
      action: params.get("action")?.trim() || undefined,
      limit,
    });

    return NextResponse.json({ events });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "The audit trail could not be read.",
      },
      { status: 500 },
    );
  }
}
