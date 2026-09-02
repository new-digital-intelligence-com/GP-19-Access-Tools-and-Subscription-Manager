"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { ConnectorStrip } from "@/components/ConnectorStrip";
import { Tabs } from "@/components/ui";
import { AskPanel } from "@/components/panels/AskPanel";
import { AuditPanel } from "@/components/panels/AuditPanel";
import { CatalogPanel } from "@/components/panels/CatalogPanel";
import { EntitlementsPanel } from "@/components/panels/EntitlementsPanel";
import { LifecyclePanel } from "@/components/panels/LifecyclePanel";
import { OverviewPanel } from "@/components/panels/OverviewPanel";
import { PeoplePanel } from "@/components/panels/PeoplePanel";
import { RequestsPanel } from "@/components/panels/RequestsPanel";
import { ReviewsPanel } from "@/components/panels/ReviewsPanel";
import { SettingsPanel } from "@/components/panels/SettingsPanel";
import type { ZapierStatus } from "@/lib/types";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "requests", label: "Requests" },
  { id: "entitlements", label: "Entitlements" },
  { id: "catalog", label: "Catalogue" },
  { id: "people", label: "People" },
  { id: "reviews", label: "Reviews" },
  { id: "lifecycle", label: "Lifecycle" },
  { id: "audit", label: "Audit" },
  { id: "ai", label: "Ask AI" },
  { id: "settings", label: "Settings" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const PANELS: Record<TabId, React.ComponentType> = {
  overview: OverviewPanel,
  requests: RequestsPanel,
  entitlements: EntitlementsPanel,
  catalog: CatalogPanel,
  people: PeoplePanel,
  reviews: ReviewsPanel,
  lifecycle: LifecyclePanel,
  audit: AuditPanel,
  ai: AskPanel,
  settings: SettingsPanel,
};

function isTab(value: string | null): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

/** Only the part of `/api/status` the console frame itself reads. */
type Status = {
  zapier: ZapierStatus;
  operator: { email: string; configured: boolean };
  counts: { pendingRequests: number };
};

/**
 * `useSearchParams` suspends on the prerender pass, so the reader has to sit
 * under a boundary of its own — without it the build fails outright rather
 * than degrading.
 */
export default function AccessConsole() {
  return (
    <Suspense fallback={<ConsoleFallback />}>
      <Console />
    </Suspense>
  );
}

function Console() {
  const params = useSearchParams();
  const requested = params.get("tab");

  const [tab, setTab] = useState<TabId>(() =>
    isTab(requested) ? requested : "overview",
  );
  const [status, setStatus] = useState<Status | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  /** Bumped on every tab switch to re-read the frame's own numbers. */
  const [reading, setReading] = useState(0);
  /** The `?tab=` we last reconciled against, so a repeat does not fight a click. */
  const [seen, setSeen] = useState(requested);

  // A shared link, the back button, or a card on the landing page can all name
  // a different tab after mount; follow the URL when it does.
  //
  // Adjusted during render rather than in an effect. React re-runs this
  // component before touching the DOM, so the right panel is painted once —
  // an effect would render the old tab first and then immediately replace it.
  if (requested !== seen) {
    setSeen(requested);
    if (isTab(requested) && requested !== tab) setTab(requested);
  }

  // Keep `?tab=` linkable without a navigation: replaceState leaves the panel
  // mounted and does not bury the page the reader arrived from in history.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") === tab) return;
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url);
  }, [tab]);

  function change(next: TabId) {
    setTab(next);
    setReading((n) => n + 1);
  }

  // Re-read on every tab switch. Approving a request in one panel changes the
  // badge and the connector state the rest of the frame is showing, and one
  // small call per switch is cheaper than a store shared across ten panels.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/status")
      .then((r) =>
        r.ok ? (r.json() as Promise<Status>) : Promise.reject(new Error(String(r.status))),
      )
      .then((d) => {
        if (cancelled) return;
        setStatus(d);
        setStatusFailed(false);
      })
      .catch(() => {
        // Keep the last good reading rather than blanking the header: a stale
        // count is honest about being a count; an empty one is not.
        if (!cancelled) setStatusFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reading]);

  const pending = status?.counts.pendingRequests ?? 0;
  const tabs: readonly { id: TabId; label: string; badge?: number }[] = TABS.map(
    (entry) => (entry.id === "requests" && pending > 0 ? { ...entry, badge: pending } : entry),
  );

  // Nothing to hand down while the first read is still failing — let the strip
  // fetch for itself so it can report the outage in its own words.
  const zapier = status ? status.zapier : statusFailed ? undefined : null;

  const Panel = PANELS[tab];

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <AppHeader
        title="Access console"
        subtitle="Requests, entitlements, reviews and the trail of who decided what."
        right={
          status === null ? (
            <span className="inline-block h-7 w-44 animate-pulse rounded-full bg-black/[0.06]" />
          ) : status.operator.configured ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-black/60">
              <span className="size-1.5 rounded-full bg-brand" />
              Acting as {status.operator.email}
            </span>
          ) : (
            // Every approval is recorded against the operator, so a missing one
            // means the trail would name nobody.
            <span className="inline-flex items-center gap-2 rounded-full bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 ring-1 ring-red-200">
              No operator set — decisions would be attributed to nobody
            </span>
          )
        }
      />

      <ConnectorStrip zapier={zapier} />

      <Tabs tabs={tabs} active={tab} onChange={change} />

      <Panel />
    </div>
  );
}

/** Shown for the prerender pass, before the URL is readable. */
function ConsoleFallback() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <AppHeader
        title="Access console"
        subtitle="Requests, entitlements, reviews and the trail of who decided what."
      />
      <div className="mb-6 h-24 animate-pulse rounded-2xl border border-black/10 bg-white" />
      <div className="h-12 animate-pulse rounded-xl border border-black/8 bg-white" />
    </div>
  );
}
