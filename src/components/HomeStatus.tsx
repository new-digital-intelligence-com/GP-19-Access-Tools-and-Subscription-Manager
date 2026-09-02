"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ErrorNote, Stat } from "@/components/ui";

type Alert = { level: "warn" | "error"; text: string };

/** Only the part of `/api/status` this strip reads. */
type Status = {
  zapier: { state: "ready" | "unconfigured" | "unavailable"; detail?: string };
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

/**
 * Live state on the landing page.
 *
 * Loaded after paint so a slow upstream never blocks the hero, and written so
 * the three outcomes never look alike: a failed revoke is red and says the
 * person probably still has the access; an upstream that could not be read is
 * red and says so in those words; a genuinely quiet queue is grey and calm.
 * Colour alone carries none of it — each state leads with a sentence.
 */
export function HomeStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/status")
      .then((r) =>
        r.ok ? (r.json() as Promise<Status>) : Promise.reject(new Error(String(r.status))),
      )
      .then((d) => {
        if (!cancelled) setStatus(d);
      })
      .catch(() => {
        if (!cancelled) setUnreachable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const failedRevokes = status?.counts.failedRevokes ?? 0;
  const upstream = status && status.zapier.state !== "ready" ? status.zapier : null;

  // The status route is the single author of alert copy and already words both
  // of these. They get a stronger treatment here, so drop its plainer twin
  // rather than say the same thing twice on one screen.
  const rest = (status?.alerts ?? []).filter(
    (a) =>
      !(failedRevokes > 0 && a.text.includes("pending-revoke")) &&
      !(upstream !== null && a.text.startsWith("Integrations are")),
  );

  const quiet =
    status !== null &&
    upstream === null &&
    failedRevokes === 0 &&
    rest.length === 0 &&
    status.counts.pendingRequests === 0;

  return (
    <div className="mt-10 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {status === null ? (
          <>
            <Skeleton />
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </>
        ) : (
          <>
            <Tile
              href="/access?tab=requests"
              label="Pending approvals"
              value={status.counts.pendingRequests}
              hint={
                status.counts.pendingRequests === 0
                  ? "nothing waiting on a human"
                  : "each one waits for a named approver"
              }
              accent={status.counts.pendingRequests > 0}
            />
            <Tile
              href="/access?tab=entitlements"
              label="Active entitlements"
              value={status.counts.activeEntitlements}
              hint={
                status.counts.expiredGrants > 0
                  ? `${status.counts.expiredGrants} past the agreed expiry`
                  : "grants on record right now"
              }
            />
            <Tile
              href="/access?tab=catalog"
              label="Tools tracked"
              value={status.counts.tools}
              hint={
                status.counts.overdueReviews > 0
                  ? `${status.counts.overdueReviews} past review cadence`
                  : "subscriptions in the catalogue"
              }
            />
            <Tile
              href="/access?tab=catalog"
              label="Monthly spend"
              value={money(status.spend.monthly, status.spend.currency)}
              hint={
                status.spend.waste > 0
                  ? `${money(status.spend.waste, status.spend.currency)} on seats nobody holds`
                  : "no idle seats"
              }
            />
          </>
        )}
      </div>

      {unreachable && (
        <ErrorNote>
          The status endpoint did not answer, so none of the figures above could
          be loaded. Nothing here is a count of zero — reload, and check the
          server log if it keeps happening.
        </ErrorNote>
      )}

      {/* A failed revoke is the one state that reads as safe and is not: the
          entitlement is marked pending-revoke, and the person very likely still
          holds the access. */}
      {failedRevokes > 0 && (
        <Link
          href="/access?tab=entitlements"
          className="block rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900 ring-1 ring-red-200 transition hover:ring-red-300"
        >
          <span className="font-medium">
            {failedRevokes === 1
              ? "A revoke failed"
              : `${failedRevokes} revokes failed`}
          </span>{" "}
          — those entitlements are marked pending-revoke, not revoked, so the
          people may still have the access. Retry them, or finish the removal in
          the vendor console and mark them by hand.{" "}
          <span className="whitespace-nowrap underline underline-offset-2">
            Open the register →
          </span>
        </Link>
      )}

      {/* "Could not be read" and "there is nothing" are different answers.
          Provisioning, the people directory and both notifiers all arrive
          through the one integration connection, so while it is down the directory is
          unreadable rather than empty. */}
      {upstream && (
        <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900 ring-1 ring-red-200">
          <span className="font-medium">
            {upstream.state === "unconfigured"
              ? "Integrations are not configured."
              : "Integrations are not responding."}
          </span>{" "}
          Google Workspace provisioning, the people directory and both
          notification channels answer through it. Until it is back, an empty
          people list means the directory could not be read — not that there is
          nobody in it. The counts above come from this app&apos;s own register
          and are unaffected.
          {upstream.detail && (
            <span className="mt-1 block text-red-800/80">{upstream.detail}</span>
          )}
        </div>
      )}

      {rest.map((note) => (
        <div
          key={note.text}
          className={`rounded-xl px-4 py-3 text-sm ring-1 ${
            note.level === "error"
              ? "bg-red-50 text-red-900 ring-red-200"
              : "bg-amber-50 text-amber-900 ring-amber-200"
          }`}
        >
          {/* Told apart by word first, colour second. */}
          <span className="font-medium">
            {note.level === "error" ? "Blocked" : "Worth a look"} —{" "}
          </span>
          {note.text}
        </div>
      ))}

      {quiet && (
        <p className="rounded-xl bg-black/[0.03] px-4 py-3 text-sm text-black/55 ring-1 ring-black/10">
          Nothing is waiting on an approver, every revoke has gone through, and
          all upstreams answered.
        </p>
      )}
    </div>
  );
}

function Tile({
  href,
  label,
  value,
  hint,
  accent = false,
}: {
  href: string;
  label: string;
  value: React.ReactNode;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group relative overflow-hidden rounded-2xl border border-black/8 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-lg"
    >
      {/* Red hairline that fills in on hover — already filled when the tile is
          the one with work waiting on it. */}
      <span
        aria-hidden
        className={`absolute inset-x-0 top-0 h-0.5 bg-brand transition-transform duration-300 group-hover:scale-x-100 ${
          accent ? "" : "origin-left scale-x-0"
        }`}
      />
      <Stat label={label} value={value} hint={hint} />
    </Link>
  );
}

function Skeleton() {
  return (
    <div className="rounded-2xl border border-black/8 bg-white p-5 shadow-sm">
      <div className="h-8 w-16 animate-pulse rounded bg-black/[0.07]" />
      <div className="mt-2 h-4 w-28 animate-pulse rounded bg-black/[0.06]" />
      <div className="mt-2 h-3 w-36 animate-pulse rounded bg-black/[0.04]" />
    </div>
  );
}

/**
 * `Settings.currency` is a free-text label, so it is not necessarily an ISO
 * code. Try to format with it, and fall back to printing it beside the number
 * rather than letting a currency error take out the landing page.
 */
function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${Math.round(amount).toLocaleString()} ${currency}`.trim();
  }
}
