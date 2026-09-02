import { NextResponse } from "next/server";
import { applyDecisions, getCampaign } from "@/lib/reviews";
import { operator } from "@/lib/settings";
import { ActionPasswordError, requireActionPassword } from "@/lib/guard";

export const runtime = "nodejs";

/**
 * One provider call per revoked row, in series, each one a network round trip
 * through Zapier. A campaign of thirty revokes is minutes of work, and the
 * default serverless ceiling would cut it off halfway — with some people's
 * access already gone and no response saying which.
 */
export const maxDuration = 300;

/**
 * Carry out the `revoke` decisions in a campaign.
 *
 * This is the only route that removes access as a result of a review, and it
 * runs only when a human asks for it. The decisions themselves were recorded
 * earlier, against named reviewers, on PATCH /api/reviews.
 */

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  try {
    // The widest action in the app: one click can remove dozens of people's
    // access, so it gets the same pause as a single revoke.
    requireActionPassword(request);
  } catch (error) {
    if (error instanceof ActionPasswordError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  try {
    const body = (await request.json()) as Partial<{ campaignId: string }>;
    const campaignId = typeof body.campaignId === "string" ? body.campaignId.trim() : "";
    if (!campaignId) return bad("A campaign id is required.");

    // Looked up first so an unknown id is a 404 rather than the bare Error
    // `applyDecisions` throws, which would surface as a 500 and read like the
    // revokes were attempted and something broke.
    const campaign = await getCampaign(campaignId);
    if (!campaign) return bad(`No review campaign with id ${campaignId}.`, 404);

    const outcome = await applyDecisions({ campaignId, actor: operator() });

    // Returned exactly as it came back, including the failures.
    //
    // A partial application is the normal case, not an exception: some rows
    // revoke, a `manual` tool has no API path, a group removal is refused. Each
    // failed row leaves its entitlement in `pending-revoke` — the person very
    // likely still has the access — so the client needs every row's own detail
    // to say which. Collapsing this into a 5xx would hide both halves: the
    // rows that did work, and the reason the others did not.
    return NextResponse.json(outcome);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `${error.message} Some revokes in this campaign may already have been applied; ` +
              "reload the campaign before retrying."
            : "Unknown error",
      },
      { status: 500 },
    );
  }
}
