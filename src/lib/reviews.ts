import "server-only";
import { mutate, newId, readStore } from "./store";
import { getTool, listTools } from "./catalog";
import { listEntitlements, revokeAccess } from "./entitlements";
import { record } from "./audit";
import { announce } from "./providers/notify";
import { getSettings } from "./settings";
import type { Entitlement, ReviewCampaign, ReviewItem, Tool } from "./types";

/**
 * Scheduled entitlement reviews.
 *
 * A campaign is a frozen snapshot of who held what at the moment it opened.
 * It has to be frozen: a review of a live query is unanswerable, because the
 * set changes under the reviewer and nobody can say afterwards what was
 * actually looked at.
 *
 * A `revoke` decision does not remove access on its own. `applyDecisions` does
 * that, and it records the result of every attempt — including the ones the
 * provider refused.
 */

export async function listCampaigns(): Promise<ReviewCampaign[]> {
  return (await readStore<ReviewCampaign[]>("reviews", [])).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export async function getCampaign(id: string): Promise<ReviewCampaign | undefined> {
  return (await readStore<ReviewCampaign[]>("reviews", [])).find((c) => c.id === id);
}

export async function openCampaign(input: {
  name: string;
  toolIds?: string[];
  dueInDays?: number;
  createdBy: string;
  appUrl?: string;
}): Promise<ReviewCampaign> {
  const settings = await getSettings();
  const scope = input.toolIds?.length ? input.toolIds : [];
  const entitlements = await listEntitlements({ status: "active" });
  const inScope = scope.length
    ? entitlements.filter((e) => scope.includes(e.toolId))
    : entitlements;

  const due = new Date();
  due.setDate(due.getDate() + (input.dueInDays ?? 14));

  const campaign: ReviewCampaign = {
    id: newId("rev"),
    name: input.name.trim() || `Access review ${new Date().toISOString().slice(0, 10)}`,
    toolIds: scope,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
    dueAt: due.toISOString(),
    status: "open",
    items: inScope.map((entitlement) => ({
      entitlementId: entitlement.id,
      personEmail: entitlement.personEmail,
      toolId: entitlement.toolId,
      decision: "pending" as const,
    })),
  };

  await mutate<ReviewCampaign[], void>("reviews", [], (all) => ({
    next: [campaign, ...all],
    result: undefined,
  }));

  await record({
    actor: input.createdBy,
    action: "review.opened",
    subject: campaign.name,
    result: "info",
    detail: `${campaign.items.length} entitlements in scope, due ${campaign.dueAt.slice(0, 10)}.`,
  });

  // Reviewers are the tool owners, so each hears about their own scope only.
  const owners = await reviewersFor(campaign);
  for (const [owner, count] of owners) {
    await announce({
      to: owner,
      subject: `Access review due ${campaign.dueAt.slice(0, 10)}: ${campaign.name}`,
      body: [
        `${count} entitlement${count === 1 ? "" : "s"} you own ${count === 1 ? "is" : "are"} up for review.`,
        `Decide keep or revoke for each by ${campaign.dueAt.slice(0, 10)}.`,
        "",
        "Nothing is revoked automatically — a revoke happens only when you choose it",
        "and it is applied.",
      ].join("\n"),
      chatTitle: `Access review · ${campaign.name}`,
      buttonText: input.appUrl ? "Open the review" : undefined,
      buttonUrl: input.appUrl ? `${input.appUrl}/access?tab=reviews` : undefined,
    }).catch(() => []);
  }

  if (settings.approvers.length === 0 && owners.size === 0) {
    await record({
      actor: "system",
      action: "review.unrouted",
      subject: campaign.id,
      result: "error",
      detail: "No tool owners and no approvers configured, so nobody was notified.",
    });
  }

  return campaign;
}

/** Owner address → how many items in this campaign are theirs. */
async function reviewersFor(campaign: ReviewCampaign): Promise<Map<string, number>> {
  const tools = new Map((await listTools(true)).map((tool) => [tool.id, tool]));
  const counts = new Map<string, number>();
  for (const item of campaign.items) {
    const owner = tools.get(item.toolId)?.ownerEmail;
    if (!owner) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return counts;
}

export async function decideItem(input: {
  campaignId: string;
  entitlementId: string;
  decision: Exclude<ReviewItem["decision"], "pending">;
  reviewer: string;
  note?: string;
}): Promise<ReviewCampaign | undefined> {
  const campaign = await mutate<ReviewCampaign[], ReviewCampaign | undefined>(
    "reviews",
    [],
    (all) => {
      const next = all.map((current) =>
        current.id === input.campaignId
          ? {
              ...current,
              items: current.items.map((item) =>
                item.entitlementId === input.entitlementId
                  ? {
                      ...item,
                      decision: input.decision,
                      reviewer: input.reviewer,
                      decidedAt: new Date().toISOString(),
                      note: input.note,
                    }
                  : item,
              ),
            }
          : current,
      );
      return { next, result: next.find((current) => current.id === input.campaignId) };
    },
  );

  await record({
    actor: input.reviewer,
    action: `review.${input.decision}`,
    subject: input.entitlementId,
    result: "info",
    detail: input.note ?? `Reviewer chose ${input.decision}.`,
  });

  // A `keep` is a positive statement about this grant; stamp it on the
  // entitlement so the next campaign can show when it was last confirmed.
  if (input.decision === "keep") {
    await mutate<Entitlement[], void>("entitlements", [], (all) => ({
      next: all.map((entitlement) =>
        entitlement.id === input.entitlementId
          ? {
              ...entitlement,
              lastReviewedAt: new Date().toISOString(),
              lastReviewDecision: "keep" as const,
            }
          : entitlement,
      ),
      result: undefined,
    }));
  }

  return campaign;
}

/**
 * Carry out the `revoke` decisions in a campaign.
 *
 * Separate from deciding, and never automatic. A reviewer marking twelve rows
 * "revoke" is stating an intent; someone still has to press the button that
 * removes twelve people's access, and see what came back.
 */
export async function applyDecisions(input: {
  campaignId: string;
  actor: string;
}): Promise<{ applied: number; failed: number; results: { entitlementId: string; ok: boolean; detail: string }[] }> {
  const campaign = await getCampaign(input.campaignId);
  if (!campaign) throw new Error(`No review campaign with id ${input.campaignId}.`);

  const pending = campaign.items.filter(
    (item) => item.decision === "revoke" && !item.appliedAt,
  );

  const results: { entitlementId: string; ok: boolean; detail: string }[] = [];
  for (const item of pending) {
    const outcome = await revokeAccess({
      entitlementId: item.entitlementId,
      revokedBy: input.actor,
      reason: `Access review "${campaign.name}"${item.note ? `: ${item.note}` : ""}`,
    });
    results.push({ entitlementId: item.entitlementId, ok: outcome.ok, detail: outcome.detail });

    if (outcome.ok) {
      await mutate<ReviewCampaign[], void>("reviews", [], (all) => ({
        next: all.map((current) =>
          current.id === campaign.id
            ? {
                ...current,
                items: current.items.map((current2) =>
                  current2.entitlementId === item.entitlementId
                    ? { ...current2, appliedAt: new Date().toISOString() }
                    : current2,
                ),
              }
            : current,
        ),
        result: undefined,
      }));
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  await record({
    actor: input.actor,
    action: "review.applied",
    subject: campaign.name,
    result: failed ? "error" : "ok",
    detail: `${results.length - failed} revoked, ${failed} failed.`,
  });

  return { applied: results.length - failed, failed, results };
}

export async function closeCampaign(
  id: string,
  actor: string,
): Promise<ReviewCampaign | undefined> {
  const campaign = await getCampaign(id);
  if (!campaign) return undefined;
  const undecided = campaign.items.filter((item) => item.decision === "pending").length;

  const closed = await mutate<ReviewCampaign[], ReviewCampaign | undefined>(
    "reviews",
    [],
    (all) => {
      const next = all.map((current) =>
        current.id === id
          ? { ...current, status: "closed" as const, closedAt: new Date().toISOString() }
          : current,
      );
      return { next, result: next.find((current) => current.id === id) };
    },
  );

  await record({
    actor,
    action: "review.closed",
    subject: campaign.name,
    result: undecided ? "info" : "ok",
    detail: undecided
      ? `Closed with ${undecided} entitlement${undecided === 1 ? "" : "s"} never reviewed.`
      : "Every entitlement in scope was decided.",
  });

  return closed;
}

export type DueTool = { tool: Tool; lastReviewedAt?: string; dueSince: number };

/**
 * Which tools are past their review cadence.
 *
 * Measured from the last *closed* campaign that covered the tool, not from the
 * last time anyone looked at the screen. `dueSince` is days overdue; negative
 * means not yet due.
 */
export async function reviewsDue(asOf = new Date()): Promise<DueTool[]> {
  const [tools, campaigns, settings] = await Promise.all([
    listTools(),
    listCampaigns(),
    getSettings(),
  ]);
  const closed = campaigns.filter((c) => c.status === "closed" && c.closedAt);

  return tools
    // A cadence of 0 disables the schedule for that tool; it is never "due".
    .filter((tool) => (tool.reviewCadenceDays || settings.defaultReviewCadenceDays) > 0)
    .map<DueTool>((tool) => {
      const cadence = tool.reviewCadenceDays || settings.defaultReviewCadenceDays;
      const covering = closed.filter(
        (c) => c.toolIds.length === 0 || c.toolIds.includes(tool.id),
      );
      const last = covering[0]?.closedAt;
      // With no closed campaign, the clock runs from when the tool was added —
      // a tool nobody has ever reviewed should read as overdue, not as fresh.
      const since = last
        ? (asOf.getTime() - new Date(last).getTime()) / 86_400_000
        : (asOf.getTime() - new Date(tool.createdAt).getTime()) / 86_400_000;
      return { tool, lastReviewedAt: last, dueSince: Math.floor(since - cadence) };
    })
    .sort((a, b) => b.dueSince - a.dueSince);
}

/** Convenience for the dashboard: only the tools actually overdue. */
export async function overdueTools(asOf = new Date()): Promise<DueTool[]> {
  return (await reviewsDue(asOf)).filter((row) => row.dueSince >= 0);
}

export async function toolName(id: string): Promise<string> {
  return (await getTool(id))?.name ?? id;
}
