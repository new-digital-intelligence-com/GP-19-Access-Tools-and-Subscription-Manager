"use client";

import { useEffect, useState } from "react";
import { Pill } from "@/components/ui";
import type { ZapierStatus } from "@/lib/types";

/** Tools are named after the app they belong to. */
const APP_LABELS: Record<string, string> = {
  google_workspace_admin: "Google Workspace Admin",
  gmail: "Gmail",
  google_chat: "Google Chat",
  // Not on the server any more; kept so an older server still renders a
  // readable name instead of a raw slug.
  bamboohr: "BambooHR",
  google_drive: "Google Drive",
  google_sheets: "Google Sheets",
  slack: "Slack",
  helpers: "Other tools",
};

/**
 * The three this app actually calls.
 *
 * Anything else the connection exposes is listed too, dimmed — a count of 33
 * Slack tools next to the ones in use is the clearest way to say "reachable,
 * but nothing here touches it", and it stops the strip reading as a promise
 * that the app does something with them.
 */
const IN_USE = new Set([
  "google_workspace_admin",
  "gmail",
  "google_chat",
  "slack",
  "google_drive",
]);

/** What stops working, per state, in the words of the thing that stops. */
const CONSEQUENCE: Record<ZapierStatus["state"], string> = {
  ready:
    "Provisioning and the people directory through Google Workspace Admin, Slack channel membership, Drive storage capacity, and approval notices over Gmail, Slack and Google Chat.",
  unconfigured:
    "Nothing can be provisioned, the directory cannot be read and no approver can be notified. Add the integration credentials to .env.local and restart — see the README.",
  unavailable:
    "Grants, revokes, directory reads and notifications will all fail while this lasts. An empty people list right now means unreadable, not empty.",
};

const TONE: Record<ZapierStatus["state"], string> = {
  ready: "border-black/10 bg-white",
  unconfigured: "border-amber-200 bg-amber-50",
  unavailable: "border-red-200 bg-red-50",
};

/**
 * The one upstream, shown at the top of the console.
 *
 * Every integration in this product arrives over a single connection, so its
 * state explains most of what a panel below can and cannot show. The
 * console already fetches `/api/status` for the pending-request badge and
 * passes the result down; the strip only fetches for itself when nobody hands
 * it anything, so a page never pays for the same call twice.
 *
 * `undefined` means "no parent is managing this"; `null` means "the parent is
 * still loading".
 */
export function ConnectorStrip({ zapier }: { zapier?: ZapierStatus | null }) {
  const [own, setOwn] = useState<ZapierStatus | null>(null);
  const [ownFailed, setOwnFailed] = useState(false);
  const managed = zapier !== undefined;

  useEffect(() => {
    if (managed) return;
    let cancelled = false;
    fetch("/api/status")
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{ zapier: ZapierStatus }>)
          : Promise.reject(new Error(String(r.status))),
      )
      .then((d) => {
        if (!cancelled) setOwn(d.zapier);
      })
      .catch(() => {
        if (!cancelled) setOwnFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [managed]);

  const status = managed ? zapier : own;

  // The probe failing is itself a state worth naming: it is not "ready".
  if (!status) {
    return ownFailed ? (
      <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-900">
        <span className="font-medium">Connector state unknown.</span> The status
        endpoint did not answer, so this page cannot say whether the
        integrations are reachable. Treat every panel below as unverified until
        it does.
      </div>
    ) : (
      <div className="mb-6 rounded-2xl border border-black/10 bg-white px-5 py-4">
        <div className="h-4 w-40 animate-pulse rounded bg-black/[0.07]" />
        <div className="mt-2.5 h-3 w-full max-w-xl animate-pulse rounded bg-black/[0.05]" />
        <div className="mt-3 flex gap-2">
          <div className="h-6 w-32 animate-pulse rounded-lg bg-black/[0.05]" />
          <div className="h-6 w-24 animate-pulse rounded-lg bg-black/[0.05]" />
          <div className="h-6 w-28 animate-pulse rounded-lg bg-black/[0.05]" />
        </div>
      </div>
    );
  }

  const apps = status.apps ?? [];

  return (
    <div className={`mb-6 rounded-2xl border px-5 py-4 ${TONE[status.state]}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-medium">Integrations</span>
        <Pill
          state={status.state}
          label={
            status.state === "ready"
              ? "Ready"
              : status.state === "unconfigured"
                ? "Not configured"
                : "Unavailable"
          }
        />
        <span className="font-mono text-[11px] tracking-[0.18em] text-black/35 uppercase">
          One connection, every integration
        </span>
      </div>

      <p
        className={`mt-2 max-w-3xl text-sm ${
          status.state === "ready" ? "text-black/55" : "text-black/70"
        }`}
      >
        {CONSEQUENCE[status.state]}
      </p>

      {status.detail && status.state !== "ready" && (
        <p className="mt-1.5 max-w-3xl text-xs text-black/50">{status.detail}</p>
      )}

      {status.state === "ready" &&
        (apps.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {[...apps]
              .sort(
                (a, b) =>
                  Number(IN_USE.has(b.app)) - Number(IN_USE.has(a.app)) ||
                  b.tools - a.tools,
              )
              .map((app) => {
                const used = IN_USE.has(app.app);
                return (
                  <span
                    key={app.app}
                    title={
                      used
                        ? "This app is wired into the console."
                        : "Exposed by the server, but nothing in this app calls it."
                    }
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium ${
                      used
                        ? "bg-black/[0.05] text-black/60"
                        : "border border-dashed border-black/12 text-black/35"
                    }`}
                  >
                    {APP_LABELS[app.app] ?? app.app.replace(/_/g, " ")}
                    <span
                      className={`tnum rounded px-1 ${
                        used
                          ? "bg-white text-black/45 ring-1 ring-black/5"
                          : "text-black/30"
                      }`}
                    >
                      {app.tools}
                    </span>
                  </span>
                );
              })}
            <span className="ml-1 text-[11px] text-black/35">
              dashed = reachable, not used here
            </span>
          </div>
        ) : (
          // Connected and holding no tools is a real configuration, and it
          // means nothing can be provisioned — say it rather than show a gap.
          <p className="mt-3 text-xs text-black/50">
            The connection answered but exposes no actions, so there is
            nothing to call. Enable the Google Workspace Admin, Gmail, Slack and
            Google Chat actions on it — the README says where.
          </p>
        ))}
    </div>
  );
}
