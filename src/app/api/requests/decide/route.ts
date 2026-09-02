import { NextResponse } from "next/server";
import {
  ApprovalError,
  approve,
  cancelRequest,
  deny,
  renotify,
} from "@/lib/requests";
import { operator } from "@/lib/settings";
import { ActionPasswordError, requireActionPassword } from "@/lib/guard";

export const runtime = "nodejs";

/**
 * The decision endpoint — the only route in this app that can cause a grant.
 *
 * It causes one by calling `requests.approve()` and nothing else. There is no
 * grant path here, no "provision now" shortcut and no flag that skips the
 * decision: every check that makes an approval an approval (still pending, an
 * approver who is not the requester, a tool that can actually be provisioned)
 * lives inside `approve()`, so routing around it would route around all of
 * them. If a later change needs access to appear without a decision, that is a
 * change to the product, not a change to this file.
 */

type Decision = "approve" | "deny" | "cancel" | "renotify";

const DECISIONS: Decision[] = ["approve", "deny", "cancel", "renotify"];

function isDecision(value: unknown): value is Decision {
  return typeof value === "string" && (DECISIONS as string[]).includes(value);
}

/**
 * `ApprovalError` carries both the status and a message written for the person
 * reading it: "a request cannot be approved by the person who raised it", "this
 * request is already denied", "fix the catalogue entry before approving". Those
 * are the whole response as far as the approver is concerned, so they reach the
 * client verbatim.
 */
function failure(error: unknown, fallbackStatus = 500) {
  const status =
    error instanceof ApprovalError || error instanceof ActionPasswordError
      ? error.status
      : fallbackStatus;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Unknown error" },
    { status },
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<{
      id: string;
      decision: Decision;
      approverEmail: string;
      note: string;
    }>;

    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      return NextResponse.json({ error: "A request id is required." }, { status: 400 });
    }
    if (!isDecision(body.decision)) {
      return NextResponse.json(
        { error: `Decision must be one of ${DECISIONS.join(", ")}.` },
        { status: 400 },
      );
    }

    // Every decision is attributed to a named address. There is no sign-in yet,
    // so an unspecified approver falls back to the configured operator rather
    // than to "system" — an approval nobody's name is on is not an approval,
    // and `approve()` refuses the placeholder in the same breath.
    const approverEmail = body.approverEmail?.trim() || operator();
    const appUrl = new URL(request.url).origin;
    const note = typeof body.note === "string" ? body.note : "";

    if (body.decision === "approve") {
      // Only approve is gated. Denying, cancelling and re-notifying change no
      // access, and putting a password in front of "deny" would make the safe
      // option the slow one — which is how people learn to approve by reflex.
      requireActionPassword(request);

      const decided = await approve({ requestId: id, approverEmail, note: note || undefined, appUrl });

      // A request that comes back `failed` is a *successful decision* with a
      // failed provisioning step: the approval is recorded and audited, the
      // provider refused the grant, and the person does not have access. That
      // is a 200 with `request.status === "failed"` and `provisionResult.detail`
      // saying what happened — not an error response. Returning 5xx here would
      // let the client show "something went wrong" over a decision that was in
      // fact made, and hide the one sentence explaining why access is not live.
      return NextResponse.json({ request: decided });
    }

    if (body.decision === "deny") {
      // The blank note is passed through on purpose: `deny()` refuses it with
      // "a denial needs a reason. The requester has to know what would change
      // the answer." — better than any message this route could invent.
      return NextResponse.json({ request: await deny({ requestId: id, approverEmail, note }) });
    }

    if (body.decision === "cancel") {
      const cancelled = await cancelRequest(id, approverEmail);
      if (!cancelled) {
        return NextResponse.json(
          { error: `Request ${id} could not be read back after cancelling.` },
          { status: 404 },
        );
      }
      return NextResponse.json({ request: cancelled });
    }

    // Re-notify is the repair for a request that was never routed anywhere.
    // Unlike the notifications sent alongside a decision, a failure here is not
    // swallowed: the entire point of the action is the delivery, so a Zapier
    // outage has to come back as an error rather than a silent second nothing.
    const renotified = await renotify(id, appUrl);
    if (!renotified) {
      return NextResponse.json(
        { error: `Request ${id} could not be read back after re-notifying.` },
        { status: 404 },
      );
    }
    return NextResponse.json({ request: renotified });
  } catch (error) {
    return failure(error);
  }
}
