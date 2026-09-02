"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  Confirm,
  Empty,
  ErrorNote,
  Field,
  Loading,
  Note,
  OkNote,
  Pill,
  SectionTitle,
  Table,
  Td,
  When,
  inputClass,
} from "@/components/ui";
import type { Entitlement, ReviewCampaign, ReviewItem, Tool } from "@/lib/types";
import { ACTION_PASSWORD_HEADER } from "@/lib/guard-header";

/**
 * Scheduled entitlement reviews.
 *
 * The shape of this screen follows the one rule the reviews library is built
 * on: deciding and doing are not the same act. A reviewer works through the
 * rows marking keep or revoke, and every one of those is a recorded opinion
 * that changes nobody's access. Applying them is a separate button, behind a
 * confirmation that counts the people and names the tools, because that click
 * is the one that removes access from real accounts.
 *
 * Two things are therefore never allowed to blur here. A row marked revoke is
 * not a revoked row, and it is drawn as a decision rather than an outcome
 * until it has been applied. And a failed apply is not a quiet retry: the
 * per-row result comes back with its own reason and stays on screen in red,
 * because the person almost certainly still has the access.
 *
 * Closing a campaign with rows nobody touched is allowed and audited as such.
 * The confirmation says the words that will end up in the trail — never
 * reviewed — rather than letting a reviewer close a half-done review believing
 * it reads as finished.
 */

/** Mirrors `DueTool` from the reviews library, which is server-only. */
type Due = { tool: Tool; lastReviewedAt?: string; dueSince: number };

type Row = Entitlement & { toolName: string };

type Feed = {
  campaigns: ReviewCampaign[];
  due: Due[];
  tools: Tool[];
  entitlements: Row[];
};

type ApplyResult = {
  campaignId: string;
  campaignName: string;
  applied: number;
  failed: number;
  results: { entitlementId: string; ok: boolean; detail: string }[];
  /** Frozen at apply time: the campaign reloads and its items move on. */
  labels: Record<string, string>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function readJson<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `The request failed with status ${res.status}.`;
    throw new Error(detail);
  }
  return body as T;
}

function decidedCount(campaign: ReviewCampaign): number {
  return campaign.items.filter((item) => item.decision !== "pending").length;
}

function pendingRevokes(campaign: ReviewCampaign): ReviewItem[] {
  return campaign.items.filter((item) => item.decision === "revoke" && !item.appliedAt);
}

export function ReviewsPanel() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Open-a-review form.
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [dueInDays, setDueInDays] = useState("14");
  const [opening, setOpening] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formOk, setFormOk] = useState<string | null>(null);

  // Per-row decisions.
  // Keyed by `campaignId:entitlementId`; a row nobody typed into stays absent
  // so the stored note keeps showing through.
  const [notes, setNotes] = useState<Record<string, string | undefined>>({});
  const [deciding, setDeciding] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  // Applying, closing, summarising.
  const [applying, setApplying] = useState<ReviewCampaign | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

  const [closing, setClosing] = useState<ReviewCampaign | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const [summarising, setSummarising] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ campaignId: string; text: string } | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // `loading` starts true and `load` does not set it, so that the mount effect
  // below triggers no synchronous state update — React flags that as a
  // cascading render, and it is also just wasted work when the initial value is
  // already correct. A manual refresh raises the flag itself, from the handler.
  const load = useCallback(async () => {
    try {
      setFeed(await readJson<Feed>(await fetch("/api/reviews")));
      setLoadError(null);
    } catch (error) {
      setFeed(null);
      setLoadError(message(error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // Deferred by a microtask rather than called straight from the effect body.
    // `load` updates state, and doing that synchronously during the effect
    // flush costs a cascading render for no benefit — the first paint already
    // shows the loading state.
    void Promise.resolve().then(load);
  }, [load]);

  const campaigns = feed?.campaigns ?? [];
  const due = feed?.due ?? [];
  const tools = feed?.tools ?? [];
  const entitlements = feed?.entitlements ?? [];

  const open = campaigns.filter((campaign) => campaign.status === "open");
  const closed = campaigns.filter((campaign) => campaign.status === "closed");
  const overdue = due.filter((row) => row.dueSince >= 0);
  const upcoming = due.filter((row) => row.dueSince < 0);

  const grantOf = (id: string): Row | undefined => entitlements.find((row) => row.id === id);

  /** Names come from the register first: it resolves archived tools too. */
  function nameOf(item: ReviewItem): string {
    return (
      grantOf(item.entitlementId)?.toolName ??
      tools.find((tool) => tool.id === item.toolId)?.name ??
      item.toolId
    );
  }

  async function openReview(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setFormOk(null);
    setOpening(true);
    try {
      const data = await readJson<{ campaign: ReviewCampaign }>(
        await fetch("/api/reviews", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            toolIds: scope.length ? scope : undefined,
            dueInDays: dueInDays === "" ? undefined : dueInDays,
          }),
        }),
      );
      const count = data.campaign.items.length;
      setFormOk(
        count === 0
          ? `Opened "${data.campaign.name}" with nothing in scope. No active grant matched, so there is nothing for a reviewer to decide.`
          : `Opened "${data.campaign.name}" over ${count} ${count === 1 ? "grant" : "grants"}, frozen as they stand now. Each tool owner has been told about their own share. Nothing is revoked by opening it.`,
      );
      setName("");
      setScope([]);
      await load();
    } catch (error) {
      setFormError(message(error));
    }
    setOpening(false);
  }

  async function decide(
    campaign: ReviewCampaign,
    item: ReviewItem,
    decision: "keep" | "revoke",
  ) {
    const key = `${campaign.id}:${item.entitlementId}`;
    setDeciding(key);
    setRowError(null);
    try {
      const data = await readJson<{ campaign: ReviewCampaign }>(
        await fetch("/api/reviews", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            campaignId: campaign.id,
            entitlementId: item.entitlementId,
            decision,
            note: notes[key]?.trim() || undefined,
          }),
        }),
      );
      // Only this campaign is swapped in. A full reload would re-sort the list
      // under a reviewer part-way through forty rows, and nothing else on the
      // screen changed: a decision provisions nothing.
      setFeed((current) =>
        current
          ? {
              ...current,
              campaigns: current.campaigns.map((entry) =>
                entry.id === data.campaign.id ? data.campaign : entry,
              ),
            }
          : current,
      );
    } catch (error) {
      setRowError(message(error));
    }
    setDeciding(null);
  }

  async function apply(password: string) {
    if (!applying) return;
    setApplyBusy(true);
    setApplyError(null);
    const campaign = applying;
    const labels: Record<string, string> = {};
    for (const item of campaign.items) {
      labels[item.entitlementId] = `${item.personEmail} → ${nameOf(item)}`;
    }
    try {
      const data = await readJson<{
        applied: number;
        failed: number;
        results: { entitlementId: string; ok: boolean; detail: string }[];
      }>(
        await fetch("/api/reviews/apply", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [ACTION_PASSWORD_HEADER]: password,
          },
          body: JSON.stringify({ campaignId: campaign.id }),
        }),
      );
      setApplyResult({
        campaignId: campaign.id,
        campaignName: campaign.name,
        applied: data.applied,
        failed: data.failed,
        results: data.results,
        labels,
      });
      setApplying(null);
      await load();
    } catch (error) {
      setApplyError(message(error));
    }
    setApplyBusy(false);
  }

  async function close() {
    if (!closing) return;
    setCloseBusy(true);
    setCloseError(null);
    try {
      await readJson<{ campaign: ReviewCampaign }>(
        await fetch(`/api/reviews?id=${encodeURIComponent(closing.id)}`, { method: "DELETE" }),
      );
      setClosing(null);
      await load();
    } catch (error) {
      setCloseError(message(error));
    }
    setCloseBusy(false);
  }

  async function summarise(campaign: ReviewCampaign) {
    setSummarising(campaign.id);
    setSummaryError(null);
    setSummary(null);
    try {
      const data = await readJson<{ text: string }>(
        await fetch("/api/assist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "review-summary",
            campaignName: campaign.name,
            // Sent field by field so the draft is written from what the rows
            // actually say — including the ones nobody decided.
            rows: campaign.items.map((item) => ({
              person: item.personEmail,
              tool: nameOf(item),
              decision: item.decision,
              reviewer: item.reviewer,
              decidedAt: item.decidedAt,
              note: item.note,
              appliedAt: item.appliedAt,
            })),
          }),
        }),
      );
      setSummary({ campaignId: campaign.id, text: data.text });
    } catch (error) {
      setSummaryError(message(error));
    }
    setSummarising(null);
  }

  /** The count and the tool names that go in the apply confirmation. */
  function revokePlan(campaign: ReviewCampaign): {
    rows: ReviewItem[];
    people: number;
    tools: string;
    toolCount: number;
  } {
    const rows = pendingRevokes(campaign);
    const byTool = new Map<string, number>();
    for (const item of rows) {
      const label = nameOf(item);
      byTool.set(label, (byTool.get(label) ?? 0) + 1);
    }
    return {
      rows,
      people: new Set(rows.map((item) => item.personEmail)).size,
      tools: [...byTool.entries()].map(([label, count]) => `${label} (${count})`).join(", "),
      toolCount: byTool.size,
    };
  }

  const plan = applying ? revokePlan(applying) : null;
  const closingUndecided = closing
    ? closing.items.filter((item) => item.decision === "pending").length
    : 0;
  const closingUnapplied = closing ? pendingRevokes(closing).length : 0;

  return (
    <div className="space-y-6">
      <SectionTitle
        right={
          <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => {
              setLoading(true);
              void load();
            }}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        }
      >
        Access reviews
      </SectionTitle>

      {rowError ? <ErrorNote>{rowError}</ErrorNote> : null}
      {!applying && applyError ? <ErrorNote>{applyError}</ErrorNote> : null}
      {!closing && closeError ? <ErrorNote>{closeError}</ErrorNote> : null}

      {applyResult ? (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">Applied: {applyResult.campaignName}</h3>
            <Button
              variant="ghost"
              className="px-3 py-1.5 text-xs"
              onClick={() => setApplyResult(null)}
            >
              Dismiss
            </Button>
          </div>

          {applyResult.results.length === 0 ? (
            <Note>
              Nothing was applied. No row in this campaign was marked revoke and still waiting, so
              no provider call was made.
            </Note>
          ) : applyResult.failed === 0 ? (
            <OkNote>
              {applyResult.applied} {applyResult.applied === 1 ? "revoke" : "revokes"} carried out
              and confirmed by the provider.
            </OkNote>
          ) : (
            <ErrorNote>
              {applyResult.applied} of {applyResult.results.length} carried out.{" "}
              {applyResult.failed} failed, and the people on those rows may still have the access —
              their entitlements are left at pending-revoke, not revoked.
            </ErrorNote>
          )}

          <ul className="space-y-2">
            {applyResult.results.map((result) => (
              <li
                key={result.entitlementId}
                className={`rounded-xl px-4 py-3 text-sm ring-1 ${
                  result.ok
                    ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                    : "bg-red-50 text-red-700 ring-red-200"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {applyResult.labels[result.entitlementId] ?? result.entitlementId}
                  </span>
                  <Pill
                    state={result.ok ? "revoked" : "failed"}
                    label={result.ok ? "revoked" : "still held"}
                  />
                </div>
                <p className="mt-1">{result.detail}</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {loadError ? (
        <ErrorNote>
          The reviews could not be read: {loadError}. Nothing below is shown because the read
          failed — campaigns may be open and overdue and not listed here.
        </ErrorNote>
      ) : loading && !feed ? (
        <Loading label="Reading review schedules…" />
      ) : (
        <>
          <div className="space-y-3">
            <SectionTitle>Review cadence</SectionTitle>

            {due.length === 0 ? (
              <Empty
                title="No tool has a review schedule"
                hint="A cadence of zero days disables the schedule for a tool, and a catalogue with no tools has nothing to schedule. Set a cadence in the Catalogue tab to have tools appear here."
              />
            ) : (
              <div className="space-y-3">
                {overdue.length > 0 ? (
                  <Card className="space-y-3 border-amber-200 bg-amber-50/60">
                    <div>
                      <h3 className="font-medium text-amber-900">
                        {overdue.length} {overdue.length === 1 ? "tool is" : "tools are"} past the
                        review cadence
                      </h3>
                      <p className="mt-1 text-sm text-amber-800">
                        Measured from the last closed campaign that covered the tool. A tool nobody
                        has ever reviewed counts from the day it was added, which is why a new
                        catalogue reads as overdue rather than as fresh.
                      </p>
                    </div>
                    <ul className="space-y-2">
                      {overdue.map((row) => (
                        <li
                          key={row.tool.id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white px-4 py-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{row.tool.name}</p>
                            <p className="text-xs text-black/50">
                              {row.lastReviewedAt ? (
                                <>
                                  last reviewed <When at={row.lastReviewedAt} relative={false} />
                                </>
                              ) : (
                                <span className="font-medium text-amber-800">never reviewed</span>
                              )}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Pill
                              state="overdue"
                              label={
                                row.dueSince === 0
                                  ? "due today"
                                  : `${row.dueSince} ${row.dueSince === 1 ? "day" : "days"} over`
                              }
                            />
                            <Button
                              variant="ghost"
                              className="px-3 py-1.5 text-xs"
                              onClick={() => {
                                setScope([row.tool.id]);
                                setName(`${row.tool.name} access review`);
                                setFormOk(null);
                                setFormError(null);
                              }}
                            >
                              Scope a review
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : (
                  <OkNote>
                    Every tool with a cadence has been reviewed inside it. Nothing is overdue.
                  </OkNote>
                )}

                {upcoming.length > 0 ? (
                  <Card className="p-0">
                    <p className="border-b border-black/8 px-5 py-3 text-xs tracking-wide text-black/45 uppercase">
                      Not yet due
                    </p>
                    <ul className="divide-y divide-black/5">
                      {upcoming.map((row) => (
                        <li
                          key={row.tool.id}
                          className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm">{row.tool.name}</p>
                            <p className="text-xs text-black/50">
                              {row.lastReviewedAt ? (
                                <>
                                  last reviewed <When at={row.lastReviewedAt} relative={false} />
                                </>
                              ) : (
                                "never reviewed"
                              )}
                            </p>
                          </div>
                          <Pill
                            state="ok"
                            label={`due in ${-row.dueSince} ${-row.dueSince === 1 ? "day" : "days"}`}
                          />
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : null}
              </div>
            )}
          </div>

          <Card className="space-y-4">
            <div>
              <h3 className="font-medium">Open a review</h3>
              <p className="mt-1 text-sm text-black/55">
                A campaign freezes the register as it stands right now into a list of rows to
                decide. It has to be frozen: a review of a live query cannot be answered, because
                nobody can say afterwards what was actually looked at. Opening one notifies each
                tool owner about their own rows and changes nobody&rsquo;s access.
              </p>
            </div>

            <form onSubmit={openReview} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" hint="Left blank it is named after today's date.">
                  <input
                    className={inputClass}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Q3 access review"
                  />
                </Field>
                <Field
                  label="Due in (days)"
                  hint="Only the date owners are asked to decide by. Nothing happens when it passes."
                >
                  <input
                    className={inputClass}
                    type="number"
                    min="0"
                    step="1"
                    value={dueInDays}
                    onChange={(event) => setDueInDays(event.target.value)}
                  />
                </Field>
              </div>

              {/* Checkboxes rather than a native multiple select: the scope
                  decides whose access gets looked at, and a control where
                  ctrl-clicking wrong silently drops a tool is the wrong one. */}
              <div className="space-y-1.5">
                <span className="block text-sm font-medium">Tools in scope</span>
                {tools.length === 0 ? (
                  <p className="text-sm text-black/55">
                    The catalogue is empty, so there is nothing to scope a review to.
                  </p>
                ) : (
                  <div className="max-h-52 space-y-1 overflow-y-auto rounded-xl border border-black/15 px-3.5 py-2.5">
                    {tools.map((tool) => (
                      <label key={tool.id} className="flex items-center gap-2.5 py-1 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-current"
                          checked={scope.includes(tool.id)}
                          onChange={(event) =>
                            setScope((current) =>
                              event.target.checked
                                ? [...current, tool.id]
                                : current.filter((id) => id !== tool.id),
                            )
                          }
                        />
                        <span>
                          {tool.name}
                          {tool.vendor ? (
                            <span className="text-black/45"> · {tool.vendor}</span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <span className="block text-xs text-black/45">
                  {scope.length === 0
                    ? "None selected, so every active grant in the register goes in scope."
                    : `${scope.length} selected. Only grants of ${scope.length === 1 ? "this tool" : "these tools"} go in scope.`}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={opening}>
                  {opening ? "Opening…" : "Open the review"}
                </Button>
                {scope.length > 0 ? (
                  <Button type="button" variant="ghost" onClick={() => setScope([])}>
                    Clear scope
                  </Button>
                ) : null}
              </div>
            </form>

            {formError ? <ErrorNote>{formError}</ErrorNote> : null}
            {formOk ? <OkNote>{formOk}</OkNote> : null}
          </Card>

          <div className="space-y-3">
            <SectionTitle>Open campaigns</SectionTitle>

            {open.length === 0 ? (
              <Empty
                title="No review is open"
                hint="Open one above. Until a campaign exists, nobody is being asked to confirm that the access on record is still the access people need."
              />
            ) : (
              open.map((campaign) => {
                const total = campaign.items.length;
                const done = decidedCount(campaign);
                const waiting = pendingRevokes(campaign);
                return (
                  <Card key={campaign.id} className="space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-medium">{campaign.name}</h3>
                        <p className="text-xs text-black/50">
                          opened <When at={campaign.createdAt} /> by {campaign.createdBy} · due{" "}
                          <When at={campaign.dueAt} relative={false} />
                          {campaign.toolIds.length
                            ? ` · ${campaign.toolIds.length} ${campaign.toolIds.length === 1 ? "tool" : "tools"} in scope`
                            : " · every tool in scope"}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill state="open" />
                        <span className="tnum text-xs font-medium text-black/60">
                          {done} of {total} decided
                        </span>
                      </div>
                    </div>

                    {total === 0 ? (
                      <Note>
                        This campaign has no rows. Nothing was in scope when it opened, so there is
                        nothing to decide and nothing to apply.
                      </Note>
                    ) : (
                      <Table
                        head={["Person", "Tool", "Granted", "Last review", "Decision", "Note", ""]}
                      >
                        {campaign.items.map((item) => {
                          const key = `${campaign.id}:${item.entitlementId}`;
                          const grant = grantOf(item.entitlementId);
                          const busy = deciding === key;
                          return (
                            <tr
                              key={item.entitlementId}
                              className={
                                item.decision === "revoke" && !item.appliedAt
                                  ? "bg-red-50/40"
                                  : undefined
                              }
                            >
                              <Td>
                                <span className="font-medium">{item.personEmail}</span>
                              </Td>
                              <Td className="text-black/70">{nameOf(item)}</Td>
                              <Td className="text-black/60">
                                {grant ? (
                                  <>
                                    <When at={grant.grantedAt} relative={false} />
                                    <span className="block text-xs text-black/45">
                                      {grant.source === "imported"
                                        ? "imported — nobody here granted it"
                                        : `via ${grant.source}`}
                                    </span>
                                  </>
                                ) : (
                                  // The feed carries active grants only, so a
                                  // missing one is ambiguous in exactly the way
                                  // that matters — say which two ways.
                                  <span className="text-xs text-black/50">
                                    not in the active register any more: revoked since this
                                    campaign opened, or a revoke failed and it is sitting at
                                    pending-revoke. The Entitlements tab says which.
                                  </span>
                                )}
                              </Td>
                              <Td className="text-black/60">
                                {grant?.lastReviewedAt ? (
                                  <>
                                    <When at={grant.lastReviewedAt} relative={false} />
                                    {grant.lastReviewDecision ? (
                                      <span className="block text-xs text-black/45">
                                        decided {grant.lastReviewDecision}
                                      </span>
                                    ) : null}
                                  </>
                                ) : (
                                  <span className="text-black/35">never reviewed</span>
                                )}
                              </Td>
                              <Td>
                                <Pill state={item.decision} />
                                {item.appliedAt ? (
                                  <span className="mt-1 block text-xs text-black/45">
                                    applied <When at={item.appliedAt} relative={false} />
                                  </span>
                                ) : item.decision === "revoke" ? (
                                  <span className="mt-1 block max-w-40 text-xs font-medium text-red-700">
                                    decided, not applied — they still have it
                                  </span>
                                ) : null}
                                {item.reviewer ? (
                                  <span className="mt-1 block text-xs text-black/45">
                                    by {item.reviewer}
                                  </span>
                                ) : null}
                              </Td>
                              <Td>
                                <input
                                  className={`${inputClass} min-w-44 py-1.5 text-xs`}
                                  value={notes[key] ?? item.note ?? ""}
                                  onChange={(event) =>
                                    setNotes((current) => ({
                                      ...current,
                                      [key]: event.target.value,
                                    }))
                                  }
                                  placeholder="Optional. Saved with the decision."
                                />
                              </Td>
                              <Td>
                                <div className="flex flex-wrap justify-end gap-2">
                                  <Button
                                    variant="approve"
                                    className="px-3 py-1.5 text-xs"
                                    disabled={busy || Boolean(item.appliedAt)}
                                    onClick={() => void decide(campaign, item, "keep")}
                                  >
                                    Keep
                                  </Button>
                                  <Button
                                    variant="danger"
                                    className="px-3 py-1.5 text-xs"
                                    disabled={busy || Boolean(item.appliedAt)}
                                    onClick={() => void decide(campaign, item, "revoke")}
                                  >
                                    Revoke
                                  </Button>
                                </div>
                              </Td>
                            </tr>
                          );
                        })}
                      </Table>
                    )}

                    {waiting.length > 0 ? (
                      <Note>
                        {waiting.length} {waiting.length === 1 ? "row is" : "rows are"} marked
                        revoke and not applied. Marking is not removing: those people still have
                        the access until somebody applies the decisions.
                      </Note>
                    ) : null}

                    <div className="flex flex-wrap gap-2 border-t border-black/8 pt-4">
                      <Button
                        variant="danger"
                        disabled={waiting.length === 0}
                        onClick={() => {
                          setApplying(campaign);
                          setApplyError(null);
                          setApplyResult(null);
                        }}
                      >
                        Apply revoke decisions
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setClosing(campaign);
                          setCloseError(null);
                        }}
                      >
                        Close the campaign
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={summarising === campaign.id}
                        onClick={() => void summarise(campaign)}
                      >
                        {summarising === campaign.id ? "Summarising…" : "Summarise"}
                      </Button>
                      {waiting.length === 0 ? (
                        <span className="self-center text-xs text-black/45">
                          Nothing is waiting to be applied.
                        </span>
                      ) : null}
                    </div>

                    {summary?.campaignId === campaign.id ? (
                      <div className="space-y-2 rounded-xl bg-black/[0.03] px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs tracking-wide text-black/45 uppercase">
                            Drafted summary
                          </p>
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-xs"
                            onClick={() => setSummary(null)}
                          >
                            Dismiss
                          </Button>
                        </div>
                        <p className="text-sm whitespace-pre-wrap">{summary.text}</p>
                        <p className="text-xs text-black/45">
                          A draft written from the rows above. Read it against them before it goes
                          anywhere — it is the campaign&rsquo;s own record that counts, not this.
                        </p>
                      </div>
                    ) : null}
                  </Card>
                );
              })
            )}
          </div>

          {summaryError ? <ErrorNote>{summaryError}</ErrorNote> : null}

          {closed.length > 0 ? (
            <div className="space-y-3">
              <SectionTitle>Closed</SectionTitle>
              <Table head={["Campaign", "Closed", "Scope", "Kept", "Revoked", "Never reviewed"]}>
                {closed.map((campaign) => {
                  const keep = campaign.items.filter((item) => item.decision === "keep").length;
                  const revoke = campaign.items.filter(
                    (item) => item.decision === "revoke",
                  ).length;
                  const never = campaign.items.filter(
                    (item) => item.decision === "pending",
                  ).length;
                  const unapplied = pendingRevokes(campaign).length;
                  return (
                    <tr key={campaign.id}>
                      <Td>
                        <span className="font-medium">{campaign.name}</span>
                        <span className="block text-xs text-black/45">by {campaign.createdBy}</span>
                      </Td>
                      <Td className="text-black/60">
                        <When at={campaign.closedAt ?? campaign.createdAt} />
                      </Td>
                      <Td className="text-black/60">
                        {campaign.toolIds.length
                          ? `${campaign.toolIds.length} ${campaign.toolIds.length === 1 ? "tool" : "tools"}`
                          : "every tool"}
                      </Td>
                      <Td className="tnum text-black/70">{keep}</Td>
                      <Td className="tnum">
                        {revoke}
                        {unapplied > 0 ? (
                          <span className="block text-xs font-medium text-red-700">
                            {unapplied} never applied — still held
                          </span>
                        ) : null}
                      </Td>
                      <Td className="tnum">
                        {never > 0 ? (
                          <span className="font-medium text-amber-800">{never}</span>
                        ) : (
                          <span className="text-black/50">0</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </Table>
            </div>
          ) : null}
        </>
      )}

      <Confirm
        open={applying !== null}
        title="Apply the revoke decisions"
        consequence={
          !applying || !plan
            ? ""
            : `${plan.people} ${plan.people === 1 ? "person loses" : "people lose"} access to ` +
              `${plan.toolCount} ${plan.toolCount === 1 ? "tool" : "tools"}: ${plan.tools}. ` +
              "Each row is a provider call made now — a group membership removed, a licence " +
              "revoked — and they lose the tool as soon as it takes effect. Rows on a manual tool " +
              "have no API path and are not removed here: they are left at pending-revoke for " +
              "somebody to finish in the vendor console. Any call the provider refuses is left " +
              "the same way, and that person very likely still has the access — the results below " +
              "will name each one. Decisions already applied are not repeated, and nothing here " +
              "is undone from this screen: getting the access back means a new request and an " +
              "approval."
        }
        confirmLabel={
          plan ? `Revoke ${plan.rows.length} ${plan.rows.length === 1 ? "row" : "rows"}` : "Revoke"
        }
        variant="danger"
        busy={applyBusy}
        requirePassword
        onConfirm={(password) => void apply(password)}
        onCancel={() => {
          setApplying(null);
          setApplyError(null);
        }}
      >
        {applyError ? <ErrorNote>{applyError}</ErrorNote> : null}
      </Confirm>

      <Confirm
        open={closing !== null}
        title="Close this campaign"
        consequence={
          !closing
            ? ""
            : [
                `"${closing.name}" is closed and becomes the record of what was decided by the deadline. It cannot take another decision afterwards.`,
                closingUndecided > 0
                  ? `${closingUndecided} ${closingUndecided === 1 ? "row has" : "rows have"} no decision. Closing records ${closingUndecided === 1 ? "it" : "them"} as never reviewed, in those words, in the audit trail. The access stays exactly as it is, and nobody will have confirmed that it should still be there.`
                  : "Every row has a decision.",
                closingUnapplied > 0
                  ? `${closingUnapplied} revoke ${closingUnapplied === 1 ? "decision was" : "decisions were"} never applied. Closing does not apply them: those people keep the access.`
                  : "Nothing is left waiting to be applied.",
                "Closing revokes nothing on its own.",
              ].join(" ")
        }
        confirmLabel="Close it"
        variant={closingUndecided > 0 ? "danger" : "primary"}
        busy={closeBusy}
        onConfirm={() => void close()}
        onCancel={() => {
          setClosing(null);
          setCloseError(null);
        }}
      >
        {closeError ? <ErrorNote>{closeError}</ErrorNote> : null}
      </Confirm>
    </div>
  );
}
