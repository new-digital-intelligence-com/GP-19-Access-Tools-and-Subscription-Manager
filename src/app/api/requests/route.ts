import { NextResponse } from "next/server";
import { ApprovalError, createRequest, listRequests } from "@/lib/requests";
import { listTools } from "@/lib/catalog";
import { getSettings } from "@/lib/settings";
import type { AccessRequest, RequestStatus } from "@/lib/types";

export const runtime = "nodejs";

const STATUSES: RequestStatus[] = [
  "pending",
  "approved",
  "denied",
  "provisioned",
  "failed",
  "cancelled",
];

function isStatus(value: string): value is RequestStatus {
  return (STATUSES as string[]).includes(value);
}

/**
 * `ApprovalError` messages are written for the person on the other end of the
 * screen — they name the missing justification, the self-approval, the
 * catalogue gap. Rewriting them here into "Bad request" would throw away the
 * only part of the response anyone can act on, so the message and the status
 * both pass through unchanged.
 */
function failure(error: unknown, fallbackStatus = 500) {
  const status = error instanceof ApprovalError ? error.status : fallbackStatus;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Unknown error" },
    { status },
  );
}

export async function GET(request: Request) {
  try {
    const status = new URL(request.url).searchParams.get("status")?.trim() ?? "";

    // A typo in the filter must not quietly return everything: the screen would
    // then claim to be showing "denied" while listing the lot. Resolving the
    // filter to a typed value here — rather than guarding and re-testing at the
    // call site — is what lets the compiler agree it is a RequestStatus.
    let filter: { status: RequestStatus } | undefined;
    if (status && status !== "all") {
      if (!isStatus(status)) {
        return NextResponse.json(
          { error: `Unknown request status "${status}".` },
          { status: 400 },
        );
      }
      filter = { status };
    }

    const [requests, all, settings] = await Promise.all([
      listRequests(filter),
      // Archived tools are included only to resolve names — a request raised
      // before the catalogue row was archived still has to read as itself.
      listTools(true),
      getSettings(),
    ]);

    const names = new Map(all.map((tool) => [tool.id, tool.name]));
    const withNames: (AccessRequest & { toolName: string })[] = requests.map((item) => ({
      ...item,
      toolName: names.get(item.toolId) ?? item.toolId,
    }));

    return NextResponse.json({
      requests: withNames,
      tools: all.filter((tool) => !tool.archivedAt),
      // So the panel can flag an unfamiliar requester address in front of the
      // approver, where the decision is actually made.
      domain: settings.domain,
    });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Raise a request. This provisions nothing — it creates the record an approver
 * later decides on, and notifies them. The grant only ever happens in
 * `/api/requests/decide`.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<{
      requesterEmail: string;
      requesterName: string;
      toolId: string;
      role: string;
      justification: string;
      expiresAt: string;
    }>;

    const toolId = typeof body.toolId === "string" ? body.toolId.trim() : "";
    if (!toolId) {
      return NextResponse.json({ error: "A tool id is required." }, { status: 400 });
    }

    // The empty-string defaults are deliberate: `createRequest` already refuses
    // a blank requester or justification with a message that explains why, and
    // that message is better than anything a shape check here would produce.
    const created = await createRequest({
      requesterEmail: typeof body.requesterEmail === "string" ? body.requesterEmail : "",
      requesterName: body.requesterName?.trim() || undefined,
      toolId,
      role: body.role?.trim() || undefined,
      justification: typeof body.justification === "string" ? body.justification : "",
      expiresAt: body.expiresAt?.trim() || undefined,
      // Lets the approval notification link straight at the decision instead of
      // asking the approver to go and find the request.
      appUrl: new URL(request.url).origin,
    });

    return NextResponse.json({ request: created });
  } catch (error) {
    return failure(error);
  }
}
