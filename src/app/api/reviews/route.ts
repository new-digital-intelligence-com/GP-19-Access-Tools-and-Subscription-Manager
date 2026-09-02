import { NextResponse } from "next/server";
import { listTools } from "@/lib/catalog";
import { listEntitlements } from "@/lib/entitlements";
import {
  closeCampaign,
  decideItem,
  getCampaign,
  listCampaigns,
  openCampaign,
  reviewsDue,
} from "@/lib/reviews";
import { operator } from "@/lib/settings";
import type { Entitlement, ReviewItem } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Access reviews: open a campaign, decide its items, close it.
 *
 * Nothing on this route changes anyone's access. A `revoke` decision is a
 * statement of intent recorded against a named reviewer; the removal happens
 * only when someone runs `/api/reviews/apply` and sees what came back. Keeping
 * the two apart is what makes a reviewer able to work through forty rows
 * without forty irreversible actions firing behind them.
 */

type Decision = Exclude<ReviewItem["decision"], "pending">;

const DECISIONS: Decision[] = ["keep", "revoke"];

function isDecision(value: unknown): value is Decision {
  return typeof value === "string" && (DECISIONS as string[]).includes(value);
}

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

function failure(error: unknown, status = 500) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Unknown error" },
    { status },
  );
}

/**
 * Everything the reviews panel needs in one read: the campaigns, which tools
 * are past their cadence, the catalogue, and the live register.
 *
 * The entitlements are decorated with `toolName` because a review is a human
 * judgement — "should Priya still have tool_a1b2c3" is not a question anyone
 * can answer, and asking the client to join two lists to find out invites the
 * screen to show an id when the join misses.
 */
export async function GET() {
  try {
    const [campaigns, due, all, entitlements] = await Promise.all([
      listCampaigns(),
      reviewsDue(),
      // Archived tools are read for their names only: a campaign opened before
      // a tool was archived still has rows that have to read as themselves.
      listTools(true),
      listEntitlements({ status: "active" }),
    ]);

    const names = new Map(all.map((tool) => [tool.id, tool.name]));
    const withNames: (Entitlement & { toolName: string })[] = entitlements.map((item) => ({
      ...item,
      toolName: names.get(item.toolId) ?? item.toolId,
    }));

    return NextResponse.json({
      campaigns,
      due,
      tools: all.filter((tool) => !tool.archivedAt),
      entitlements: withNames,
    });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Open a campaign. `openCampaign` freezes the current register into items and
 * notifies each tool owner about their own slice of it.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<{
      name: string;
      toolIds: string[];
      /** A form sends this as a string; both shapes are accepted. */
      dueInDays: number | string;
    }>;

    let toolIds: string[] | undefined;
    if (body.toolIds !== undefined && body.toolIds !== null) {
      if (!Array.isArray(body.toolIds) || body.toolIds.some((id) => typeof id !== "string")) {
        return bad("toolIds must be an array of tool ids. Omit it to review every tool.");
      }
      toolIds = body.toolIds.map((id) => id.trim()).filter(Boolean);

      // A scope naming a tool the catalogue does not have produces a campaign
      // with no items, and an empty campaign reads on screen as "nothing needs
      // reviewing" — the opposite of what happened.
      const known = new Set((await listTools(true)).map((tool) => tool.id));
      const missing = toolIds.filter((id) => !known.has(id));
      if (missing.length) {
        return bad(`No tool in the catalogue with id ${missing.join(", ")}.`);
      }
    }

    let dueInDays: number | undefined;
    if (body.dueInDays !== undefined && body.dueInDays !== null && body.dueInDays !== "") {
      const parsed = Number(body.dueInDays);
      // Checked rather than passed through: a non-number lands in a Date and
      // the campaign is stored with a due date nobody can sort, chase or show.
      if (!Number.isFinite(parsed) || parsed < 0) {
        return bad("dueInDays must be a number of days, zero or more.");
      }
      dueInDays = Math.round(parsed);
    }

    const campaign = await openCampaign({
      // Left as the raw string on purpose: `openCampaign` trims it and falls
      // back to a dated name, so a blank one is a default rather than an error.
      name: typeof body.name === "string" ? body.name : "",
      toolIds,
      dueInDays,
      createdBy: operator(),
      // Owners are notified out of band; the link drops them on the review
      // rather than asking them to go and find it.
      appUrl: new URL(request.url).origin,
    });

    return NextResponse.json({ campaign });
  } catch (error) {
    return failure(error);
  }
}

/** Record one reviewer's decision on one item. */
export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as Partial<{
      campaignId: string;
      entitlementId: string;
      decision: Decision;
      note: string;
    }>;

    const campaignId = typeof body.campaignId === "string" ? body.campaignId.trim() : "";
    const entitlementId = typeof body.entitlementId === "string" ? body.entitlementId.trim() : "";
    if (!campaignId || !entitlementId) {
      return bad("A campaign id and an entitlement id are both required.");
    }
    if (!isDecision(body.decision)) {
      return bad(`Decision must be one of ${DECISIONS.join(", ")}.`);
    }

    // Checked before `decideItem` runs, because that function writes an audit
    // entry for the decision either way: a mistyped id would otherwise leave a
    // trail saying somebody reviewed something that was never in scope.
    const campaign = await getCampaign(campaignId);
    if (!campaign) return bad(`No review campaign with id ${campaignId}.`, 404);

    // A closed campaign is the record of what was decided by the deadline, and
    // its closing entry already counts the items nobody looked at. Editing a
    // decision into it afterwards would contradict that entry.
    if (campaign.status === "closed") {
      return bad(
        "This campaign is closed. Open a new campaign to review these entitlements again.",
        409,
      );
    }

    if (!campaign.items.some((item) => item.entitlementId === entitlementId)) {
      return bad(
        `Entitlement ${entitlementId} is not in this campaign. A campaign is a frozen snapshot ` +
          "of who held what when it opened, so it cannot take a decision on a grant made since.",
        404,
      );
    }

    const updated = await decideItem({
      campaignId,
      entitlementId,
      decision: body.decision,
      // There is no sign-in yet, so the reviewer is the configured operator.
      // A decision with no name on it is not a review.
      reviewer: operator(),
      note: typeof body.note === "string" ? body.note.trim() || undefined : undefined,
    });

    if (!updated) {
      return bad(`Campaign ${campaignId} could not be read back after the decision.`, 404);
    }

    // Deliberately no provider call here. A `revoke` recorded on this route
    // means "this should go", not "this is gone"; the person still has the
    // access until /api/reviews/apply says otherwise.
    return NextResponse.json({ campaign: updated });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Close a campaign.
 *
 * Closing decides nothing and revokes nothing. Any `revoke` that was never
 * applied stays unapplied and those people keep their access — which is why
 * `closeCampaign` audits how many items were never reviewed.
 */
export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    if (!id) return bad("A campaign id is required.");

    const campaign = await closeCampaign(id, operator());
    if (!campaign) return bad(`No review campaign with id ${id}.`, 404);

    return NextResponse.json({ campaign });
  } catch (error) {
    return failure(error);
  }
}
