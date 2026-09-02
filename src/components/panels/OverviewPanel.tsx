"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Loading,
  Note,
  Pill,
  SectionTitle,
  Stat,
  When,
} from "@/components/ui";
import type { AccessRequest, Tool, ZapierStatus } from "@/lib/types";

/**
 * The console's first screen: what needs a decision, what is not true any more,
 * and what the subscriptions are costing.
 *
 * Four reads back it, each one guarded on its own. A dead Zapier or an
 * unreadable catalogue takes out its own block and nothing else — the pending
 * queue comes from this app's own store and is still exactly right while the
 * upstream is down, so blanking the page over one failed fetch would hide the
 * approvals that are the reason anyone opened it.
 */

type Alert = { level: "warn" | "error"; text: string };

type Status = {
  zapier: ZapierStatus;
  model: { configured: boolean };
  operator: { email: string; configured: boolean };
  counts: {
    pendingRequests: number;
    activeEntitlements: number;
    tools: number;
    overdueReviews: number;
    expiredGrants: number;
    failedRevokes: number;
  };
  spend: { monthly: number; waste: number; currency: string };
  alerts: Alert[];
};

type PendingRequest = AccessRequest & { toolName: string };

/** Mirrors `SeatUsage` from the entitlements library, which is server-only. */
type Usage = {
  tool: Tool;
  active: number;
  purchased: number;
  idle: number;
  monthlyWaste: number;
  monthlySpend: number;
};

/** Mirrors `DueTool` from the reviews library, likewise server-only. */
type Due = { tool: Tool; lastReviewedAt?: string; dueSince: number };

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

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/**
 * Tab switch when the console passed a handler, a plain link otherwise, so the
 * panel still works when it is rendered outside the tabbed console.
 */
function Go({
  tab,
  label,
  onNavigate,
}: {
  tab: string;
  label: string;
  onNavigate?: (tab: string) => void;
}) {
  if (onNavigate) {
    return (
      <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => onNavigate(tab)}>
        {label}
      </Button>
    );
  }
  return (
    <Link
      href={`/access?tab=${tab}`}
      className="rounded-xl border border-black/15 px-3 py-1.5 text-xs font-medium transition hover:border-brand/50 hover:bg-brand/[0.04]"
    >
      {label}
    </Link>
  );
}

export function OverviewPanel({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRequest[] | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [due, setDue] = useState<Due[] | null>(null);
  const [dueError, setDueError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // `loading` starts true and `load` does not set it, so that the mount effect
  // below triggers no synchronous state update — React flags that as a
  // cascading render, and it is also just wasted work when the initial value is
  // already correct. A manual refresh raises the flag itself, from the handler.
  const load = useCallback(async () => {
    await Promise.all([
      (async () => {
        try {
          setStatus(await readJson<Status>(await fetch("/api/status")));
          setStatusError(null);
        } catch (error) {
          setStatus(null);
          setStatusError(message(error));
        }
      })(),
      (async () => {
        try {
          const data = await readJson<{ requests: PendingRequest[] }>(
            await fetch("/api/requests?status=pending"),
          );
          setPending(data.requests);
          setPendingError(null);
        } catch (error) {
          setPending(null);
          setPendingError(message(error));
        }
      })(),
      (async () => {
        try {
          const data = await readJson<{ usage: Usage[] }>(await fetch("/api/catalog"));
          setUsage(data.usage);
          setUsageError(null);
        } catch (error) {
          setUsage(null);
          setUsageError(message(error));
        }
      })(),
      (async () => {
        try {
          const data = await readJson<{ due: Due[] }>(await fetch("/api/reviews"));
          setDue(data.due);
          setDueError(null);
        } catch (error) {
          setDue(null);
          setDueError(message(error));
        }
      })(),
    ]);
    setLoading(false);
  }, []);

  useEffect(() => {
    // Deferred by a microtask rather than called straight from the effect body.
    // `load` updates state, and doing that synchronously during the effect
    // flush costs a cascading render for no benefit — the first paint already
    // shows the loading state.
    void Promise.resolve().then(load);
  }, [load]);

  if (loading && !status && !statusError) return <Loading label="Reading the register…" />;

  const currency = status?.spend.currency ?? "";
  const idle = (usage ?? []).filter((row) => row.monthlyWaste > 0).slice(0, 3);
  const overdue = (due ?? []).filter((row) => row.dueSince >= 0).slice(0, 5);

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
        Where things stand
      </SectionTitle>

      {statusError ? (
        <ErrorNote>
          The status read failed: {statusError}. The figures below are missing, not zero.
        </ErrorNote>
      ) : null}

      {status ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Pill
              state={status.zapier.state}
              label={`Integrations ${status.zapier.state.replace(/-/g, " ")}`}
            />
            {/* Which model answers is an implementation detail; whether the
                assistant can answer at all is not. Only the second is shown. */}
            <Pill
              state={status.model.configured ? "ok" : "error"}
              label={status.model.configured ? "assistant ready" : "assistant unavailable"}
            />
            <Pill
              state={status.operator.configured ? "ok" : "error"}
              label={
                status.operator.configured
                  ? `deciding as ${status.operator.email}`
                  : "no operator set"
              }
            />
            {status.zapier.detail ? (
              <span className="text-xs text-black/45">{status.zapier.detail}</span>
            ) : null}
          </div>

          <Card>
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-6">
              <Stat
                label="Pending requests"
                value={status.counts.pendingRequests}
                hint="waiting on a human"
              />
              <Stat
                label="Active entitlements"
                value={status.counts.activeEntitlements}
                hint="live grants on record"
              />
              <Stat label="Tools" value={status.counts.tools} hint="in the catalogue" />
              <Stat
                label="Failed revokes"
                value={status.counts.failedRevokes}
                hint={
                  status.counts.failedRevokes
                    ? "access may still be held"
                    : "none outstanding"
                }
              />
              <Stat
                label="Monthly spend"
                value={money(status.spend.monthly, currency)}
                hint={`${money(status.spend.waste, currency)} on idle seats`}
              />
              <Stat
                label="Overdue reviews"
                value={status.counts.overdueReviews}
                hint={`${status.counts.expiredGrants} expired grants still active`}
              />
            </div>
          </Card>

          {status.alerts.length ? (
            <div className="space-y-2">
              {status.alerts.map((alert, index) =>
                alert.level === "error" ? (
                  <ErrorNote key={index}>{alert.text}</ErrorNote>
                ) : (
                  <Note key={index}>{alert.text}</Note>
                ),
              )}
            </div>
          ) : (
            <Note>
              Nothing is flagged: the integrations answer, approvals are attributable, and no revoke
              is outstanding.
            </Note>
          )}
        </>
      ) : null}

      <div className="space-y-3">
        <SectionTitle right={<Go tab="requests" label="Open requests" onNavigate={onNavigate} />}>
          Waiting on an approver
        </SectionTitle>

        {pendingError ? (
          <ErrorNote>
            The pending queue could not be read: {pendingError}. This is not the same as an empty
            queue — requests may be waiting and not shown.
          </ErrorNote>
        ) : !pending ? (
          <Loading label="Reading the queue…" />
        ) : pending.length === 0 ? (
          <Empty
            title="No request is waiting"
            hint="Nothing is pending a decision. New requests appear here the moment they are raised."
          />
        ) : (
          <Card className="p-0">
            <ul className="divide-y divide-black/5">
              {pending.map((request) => (
                <li
                  key={request.id}
                  className="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">
                      {request.requesterName ?? request.requesterEmail}
                      <span className="text-black/40"> → </span>
                      {request.toolName}
                      {request.role ? (
                        <span className="text-black/45"> ({request.role})</span>
                      ) : null}
                    </p>
                    <p className="text-xs text-black/50">
                      raised <When at={request.createdAt} />
                      {request.approverEmail ? ` · routed to ${request.approverEmail}` : ""}
                    </p>
                    {!request.approverEmail ? (
                      <p className="text-xs font-medium text-red-700">
                        Nobody was told. This request has no approver, so it will sit here until
                        somebody opens this screen.
                      </p>
                    ) : !request.notifications?.length ? (
                      <p className="text-xs font-medium text-amber-800">
                        No notification was recorded, so {request.approverEmail} may not know it
                        exists.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill state="pending" />
                    <Go tab="requests" label="Open" onNavigate={onNavigate} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <SectionTitle right={<Go tab="catalog" label="Catalogue" onNavigate={onNavigate} />}>
            Paying for seats nobody holds
          </SectionTitle>

          {usageError ? (
            <ErrorNote>
              Seat usage could not be read: {usageError}. Treat the waste figure above as unknown
              rather than nil.
            </ErrorNote>
          ) : !usage ? (
            <Loading label="Reading seat usage…" />
          ) : idle.length === 0 ? (
            <Empty
              title="No idle seats"
              hint="Every paid seat in the catalogue is held by somebody, or no costs are recorded yet."
            />
          ) : (
            <Card className="p-0">
              <ul className="divide-y divide-black/5">
                {idle.map((row) => (
                  <li
                    key={row.tool.id}
                    className="flex items-start justify-between gap-3 px-5 py-3.5"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{row.tool.name}</p>
                      <p className="tnum text-xs text-black/50">
                        {row.active} of {row.purchased} seats held · {row.idle} idle
                      </p>
                    </div>
                    <p className="tnum text-sm font-semibold whitespace-nowrap">
                      {money(row.monthlyWaste, currency)}
                      <span className="font-normal text-black/45"> /mo</span>
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-3">
          <SectionTitle right={<Go tab="reviews" label="Reviews" onNavigate={onNavigate} />}>
            Past the review cadence
          </SectionTitle>

          {dueError ? (
            <ErrorNote>
              Review schedules could not be read: {dueError}. Nothing here means unread, not up to
              date.
            </ErrorNote>
          ) : !due ? (
            <Loading label="Reading review schedules…" />
          ) : overdue.length === 0 ? (
            <Empty
              title="No tool is overdue"
              hint="Every tool with a cadence has been reviewed inside it. A cadence of zero days disables the schedule."
            />
          ) : (
            <Card className="p-0">
              <ul className="divide-y divide-black/5">
                {overdue.map((row) => (
                  <li
                    key={row.tool.id}
                    className="flex items-start justify-between gap-3 px-5 py-3.5"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{row.tool.name}</p>
                      <p className="text-xs text-black/50">
                        {row.lastReviewedAt ? (
                          <>
                            last reviewed <When at={row.lastReviewedAt} relative={false} />
                          </>
                        ) : (
                          "never reviewed in this app"
                        )}
                      </p>
                    </div>
                    <Pill
                      state="overdue"
                      label={`${row.dueSince} ${row.dueSince === 1 ? "day" : "days"} over`}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
