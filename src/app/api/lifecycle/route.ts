import { NextResponse } from "next/server";
import { offboard, scan, type LifecycleScan } from "@/lib/lifecycle";
import { operator } from "@/lib/settings";
import { ActionPasswordError, requireActionPassword } from "@/lib/guard";

export const runtime = "nodejs";

/**
 * Both halves talk to Zapier one call at a time: the scan pages the whole
 * Workspace directory, and an offboard revokes each tool in series.
 * Neither fits in a default serverless window, and a cut-off offboard is the
 * worst possible outcome — half the access removed, nothing reported.
 */
export const maxDuration = 300;

/**
 * Lifecycle signals.
 *
 * Detection is automatic; action is not. GET only looks, POST acts on exactly
 * one person because a human asked for that person.
 */

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * The scan, returned as-is.
 *
 * `available: false` comes back as a 200 carrying the reason. It is a state
 * the panel draws — "the Workspace directory could not be read, so nothing was
 * checked" —
 * and it has to be distinguishable from a clean scan that found nobody. A 5xx
 * would flatten both into "something went wrong" and let an outage read as an
 * clean scan, which is the one misreading this module exists to prevent.
 */
export async function GET() {
  try {
    return NextResponse.json(await scan());
  } catch (error) {
    // A transport or configuration fault throws instead of returning
    // `available: false`, but it is the same state as far as the screen is
    // concerned, so it is shaped the same way rather than sent as an error the
    // panel has no place to render.
    const unavailable: LifecycleScan = {
      available: false,
      detail:
        `The lifecycle scan could not run: ${reason(error)}. Nothing was checked, so this is ` +
        "not a finding that everyone's access is in order.",
      scannedAt: new Date().toISOString(),
      headcount: 0,
      dormantAfterDays: 0,
      departures: [],
      dormant: [],
      joiners: [],
      orphans: [],
    };
    return NextResponse.json(unavailable);
  }
}

/**
 * Remove one person's access.
 *
 * Deliberately not gated on a fresh directory read. The operator triggering
 * this has the scan in front of them, and requiring a second lookup would make
 * offboarding impossible during exactly the outage in which someone most needs
 * to remove a departed person's access by hand.
 */
export async function POST(request: Request) {
  try {
    requireActionPassword(request);
  } catch (error) {
    if (error instanceof ActionPasswordError) return bad(error.message, error.status);
    throw error;
  }

  try {
    const body = (await request.json()) as Partial<{
      personEmail: string;
      suspendAccount: boolean;
      reason: string;
    }>;

    const personEmail = typeof body.personEmail === "string" ? body.personEmail.trim() : "";
    if (!personEmail) {
      return bad("A person email is required.");
    }

    // No default, on purpose. Suspending the Workspace account is a different
    // act from removing tool access: it takes away mail and sign-in, and it is
    // the step the operator is most likely to want separately. Defaulting it
    // either locks someone out nobody meant to lock out, or quietly leaves a
    // account live while the response reads like a full offboard.
    if (typeof body.suspendAccount !== "boolean") {
      return bad(
        "suspendAccount must be true or false. Suspending the Workspace account is a separate " +
          "decision from revoking tool access, so it is never assumed.",
      );
    }

    const result = await offboard({
      personEmail,
      actor: operator(),
      suspendAccount: body.suspendAccount,
      reason: typeof body.reason === "string" ? body.reason.trim() || undefined : undefined,
    });

    // Every step comes back, failures included, as a 200. `allOk: false` means
    // the offboard was partial: some access remains and the failing steps say
    // which. Returning an error status instead would throw away the list of
    // what did happen, and someone would have to guess where to resume.
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          `${reason(error)} The offboard may have completed some steps before it stopped; ` +
          "check the audit trail and this person's entitlements before retrying.",
      },
      { status: 500 },
    );
  }
}
