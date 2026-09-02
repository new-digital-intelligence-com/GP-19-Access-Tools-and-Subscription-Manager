"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Loading,
  Note,
  OkNote,
  Pill,
  SectionTitle,
  inputClass,
} from "@/components/ui";
import type { Settings, ZapierStatus } from "@/lib/types";
import {
  PINNED_CHAT_LABEL,
  PINNED_CHAT_SPACE,
  PINNED_SLACK_CHANNEL,
  PINNED_SLACK_LABEL,
} from "@/lib/pinned";

/**
 * Settings, which are governance rather than preferences.
 *
 * The approver list decides who is allowed to release access; the cadence
 * decides how long a stale grant sits unnoticed; the notification channels
 * decide whether an approver ever hears about a request at all. So each field
 * says what it changes downstream, and the two that can silently break routing
 * — an empty approver list, and chat notifications with no space to post to —
 * say so on the spot instead of failing quietly later.
 *
 * The operator identity is shown here and cannot be edited: it comes from the
 * environment, not the store, because an audit trail whose actor can be typed
 * into a form answers nobody's question about who approved something.
 */

type Room = { value: string; label: string };
type Feed = { settings: Settings; chatRooms: Room[]; slackChannels?: Room[] };

/** Mirrors `SyncResult` from the sheets library, which is server-only. */
type PublishResult = {
  ok: boolean;
  detail: string;
  written?: Record<string, number>;
  url?: string;
  tasksUsed?: number;
};

type Status = {
  zapier: ZapierStatus;
  operator: { email: string; configured: boolean };
};

/** The form's own shape: approvers are edited as text, saved as an array. */
type Form = {
  domain: string;
  approvers: string;
  defaultReviewCadenceDays: string;
  offboardingSlaDays: string;
  currency: string;
  notifyEmail: boolean;
  notifyChat: boolean;
  chatRoom: string;
  registerSheetId: string;
  notifySlack: boolean;
  slackChannel: string;
  voice: string;
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

function toForm(settings: Settings): Form {
  return {
    domain: settings.domain,
    approvers: settings.approvers.join("\n"),
    defaultReviewCadenceDays: String(settings.defaultReviewCadenceDays),
    offboardingSlaDays: String(settings.offboardingSlaDays),
    currency: settings.currency,
    notifyEmail: settings.notify.email,
    notifyChat: settings.notify.chat,
    chatRoom: settings.chatRoom ?? "",
    registerSheetId: settings.registerSheetId ?? "",
    notifySlack: settings.notify.slack,
    slackChannel: settings.slackChannel ?? "",
    voice: settings.voice,
  };
}

function approverList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

export function SettingsPanel() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [status, setStatus] = useState<Status | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<PublishResult | null>(null);

  // `loading` starts true and `load` does not set it, so that the mount effect
  // below triggers no synchronous state update — React flags that as a
  // cascading render, and it is also just wasted work when the initial value is
  // already correct. A manual refresh raises the flag itself, from the handler.
  const load = useCallback(async () => {
    try {
      const data = await readJson<Feed>(await fetch("/api/settings"));
      setFeed(data);
      setForm(toForm(data.settings));
      setDirty(false);
      setLoadError(null);
    } catch (error) {
      setFeed(null);
      setForm(null);
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

  // The operator address and the Zapier state both come from the environment
  // rather than the store, and both explain things this form cannot fix.
  useEffect(() => {
    fetch("/api/status")
      .then(readJson<Status>)
      .then((data) => {
        setStatus(data);
        setStatusFailed(false);
      })
      .catch(() => setStatusFailed(true));
  }, []);

  function change(patch: Partial<Form>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
    setSaved(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaveError(null);
    setSaved(null);

    const cadence = Number(form.defaultReviewCadenceDays);
    const sla = Number(form.offboardingSlaDays);
    // Blank parses as zero, and zero is a real setting here: it switches the
    // review schedule off. Nobody means that by clearing a box, so it is
    // refused rather than saved.
    if (form.defaultReviewCadenceDays.trim() === "" || !Number.isFinite(cadence) || cadence < 0) {
      setSaveError(
        "The review cadence must be a number of days. Zero switches scheduled reviews off, so " +
          "write it out if that is what you mean.",
      );
      return;
    }
    if (form.offboardingSlaDays.trim() === "" || !Number.isFinite(sla) || sla < 0) {
      setSaveError("The offboarding SLA must be a number of days, zero or more.");
      return;
    }

    setSaving(true);
    try {
      const data = await readJson<{ settings: Settings }>(
        await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            domain: form.domain.trim(),
            approvers: approverList(form.approvers),
            defaultReviewCadenceDays: cadence,
            offboardingSlaDays: sla,
            currency: form.currency.trim(),
            notify: {
              email: form.notifyEmail,
              chat: form.notifyChat,
              slack: form.notifySlack,
            },
            // Display-only above, so the pinned value is what gets stored.
            chatRoom: PINNED_CHAT_SPACE,
            registerSheetId: form.registerSheetId.trim(),
            slackChannel: form.slackChannel.trim(),
            voice: form.voice.trim(),
          }),
        }),
      );
      setFeed((current) => (current ? { ...current, settings: data.settings } : current));
      setForm(toForm(data.settings));
      setDirty(false);
      setSaved(
        data.settings.approvers.length > 0
          ? `Saved. Requests for tools with no owner now route to ${data.settings.approvers.join(", ")}.`
          : "Saved. No approvers are configured, so a request for a tool with no owner has nobody to go to.",
      );
    } catch (error) {
      // The API validates rather than merging blind: a rejected address comes
      // back named, and nothing was written.
      setSaveError(`${message(error)} Nothing was saved.`);
    }
    setSaving(false);
  }

  /**
   * Publish on demand. Each run costs a few metered Zapier tasks, which is
   * exactly why it is a button and not something that fires on every write.
   */
  async function publish() {
    setPublishing(true);
    setPublished(null);
    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await response.json()) as PublishResult & { error?: string };
      setPublished(
        data.error ? { ok: false, detail: data.error } : { ...data, ok: response.ok && data.ok },
      );
    } catch (error) {
      setPublished({ ok: false, detail: message(error) });
    }
    setPublishing(false);
  }

  // `chatRooms` is still fetched and still worth having — an empty list means
  // the Zapier app is not in any space, which is the one thing that stops
  // Chat notifications working. It just no longer feeds a picker.
  const chatSpaceVisible = (feed?.chatRooms ?? []).some(
    (room) => room.value === PINNED_CHAT_SPACE,
  );
  const slackList = feed?.slackChannels ?? [];
  const approvers = form ? approverList(form.approvers) : [];

  return (
    <div className="space-y-6">
      <SectionTitle
        right={
          <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => {
              setLoading(true);
              void load();
            }}>
            {loading ? "Reading…" : "Reload"}
          </Button>
        }
      >
        Settings
      </SectionTitle>

      <Card className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-medium">Acting as</h3>
          {statusFailed ? (
            <Pill state="unavailable" label="could not be read" />
          ) : status === null ? (
            <span className="inline-block h-5 w-24 animate-pulse rounded-full bg-black/[0.06]" />
          ) : (
            <Pill
              state={status.operator.configured ? "active" : "failed"}
              label={status.operator.configured ? "configured" : "not set"}
            />
          )}
        </div>
        {statusFailed ? (
          <ErrorNote>
            The operator identity could not be read, so this screen cannot tell you who decisions
            would be attributed to. It is not a sign that none is set.
          </ErrorNote>
        ) : status === null ? (
          <p className="text-sm text-black/45">Reading the operator identity…</p>
        ) : (
          <>
            <p className="font-mono text-sm">{status.operator.email}</p>
            <p className="text-sm text-black/55">
              Every approval, revoke and audit entry this app writes is attributed to that address.
              It is read from OPERATOR_EMAIL in the environment and cannot be changed here, because
              a trail whose actor is typed into a form cannot answer the only question anyone asks
              of it.
            </p>
            {!status.operator.configured ? (
              <ErrorNote>
                OPERATOR_EMAIL is not set, so approvals are refused outright rather than recorded
                against nobody. Set it in .env.local and restart; until then nothing can be
                approved from this console.
              </ErrorNote>
            ) : null}
          </>
        )}
      </Card>

      {loadError ? (
        <ErrorNote>
          The settings could not be read: {loadError}. The stored values are unchanged — this
          screen simply cannot show them, so do not re-enter them blind.
        </ErrorNote>
      ) : loading && !form ? (
        <Loading label="Reading settings…" />
      ) : !form ? null : (
        <form onSubmit={save} className="space-y-6">
          <Card className="space-y-4">
            <div>
              <h3 className="font-medium">Organisation</h3>
              <p className="mt-1 text-sm text-black/55">
                The domain is used to sanity-check addresses, and the currency labels every cost in
                this app. Neither converts anything: a figure entered on a tool is shown exactly as
                entered, with this label next to it.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Workspace domain" hint="The Google Workspace primary domain.">
                <input
                  className={inputClass}
                  value={form.domain}
                  onChange={(event) => change({ domain: event.target.value })}
                  placeholder="acme.com"
                />
              </Field>
              <Field label="Currency" hint="A display label, such as USD, EUR or GBP.">
                <input
                  className={inputClass}
                  value={form.currency}
                  onChange={(event) => change({ currency: event.target.value })}
                  placeholder="USD"
                />
              </Field>
            </div>
          </Card>

          <Card className="space-y-4">
            <div>
              <h3 className="font-medium">Approvals and review</h3>
              <p className="mt-1 text-sm text-black/55">
                A request is routed to the tool&rsquo;s owner. These approvers are the fallback for
                a tool that has none, so an empty list means such a request reaches nobody and
                waits where only this console looks.
              </p>
            </div>

            <Field
              label="Approvers"
              hint="One email address per line. Saved as a list, lower-cased and de-duplicated."
            >
              <textarea
                className={`${inputClass} min-h-28 font-mono`}
                value={form.approvers}
                onChange={(event) => change({ approvers: event.target.value })}
                placeholder={"security@acme.com\nops@acme.com"}
              />
            </Field>

            {approvers.length === 0 ? (
              <Note>
                No approvers are listed. Any request for a tool without an owner will be raised
                with nowhere to go, and nobody will be notified about it.
              </Note>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Default review cadence (days)"
                hint="Used for a tool that does not set its own. Zero switches scheduled reviews off."
              >
                <input
                  className={inputClass}
                  type="number"
                  min={0}
                  value={form.defaultReviewCadenceDays}
                  onChange={(event) => change({ defaultReviewCadenceDays: event.target.value })}
                />
              </Field>
              <Field
                label="Offboarding SLA (days)"
                hint="How long an account may sit suspended while still holding access before it counts as overdue."
              >
                <input
                  className={inputClass}
                  type="number"
                  min={0}
                  value={form.offboardingSlaDays}
                  onChange={(event) => change({ offboardingSlaDays: event.target.value })}
                />
              </Field>
            </div>
          </Card>

          <Card className="space-y-4">
            <div>
              <h3 className="font-medium">Notifications</h3>
              <p className="mt-1 text-sm text-black/55">
                Where an approver is told a request is waiting. Both channels go through the same
                integration connection, so both stop working when it does — a request raised during
                an outage is still recorded, but nobody hears about it.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-2.5 rounded-xl border border-black/15 px-4 py-2.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-brand"
                  checked={form.notifyEmail}
                  onChange={(event) => change({ notifyEmail: event.target.checked })}
                />
                Email the approver
              </label>
              <label className="flex items-center gap-2.5 rounded-xl border border-black/15 px-4 py-2.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-brand"
                  checked={form.notifyChat}
                  onChange={(event) => change({ notifyChat: event.target.checked })}
                />
                Post to a Google Chat space
              </label>
              <label className="flex items-center gap-2.5 rounded-xl border border-black/15 px-4 py-2.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-brand"
                  checked={form.notifySlack}
                  onChange={(event) => change({ notifySlack: event.target.checked })}
                />
                Post to Slack, mentioning the approver
              </label>
            </div>

            {!form.notifyEmail && !form.notifyChat && !form.notifySlack ? (
              <Note>
                Both channels are off. Requests will be raised and routed, and the approver will
                only find out by opening the Requests tab.
              </Note>
            ) : null}

            <Field
              label="Slack channel"
              hint="Approvals are posted here and the approver is @-mentioned. Leave it empty to direct-message them instead."
            >
              {/* The connection can see every channel in the workspace,
                  including other AI Employees'. Only this one belongs to
                  GP-19, so it is the only choice offered — picking a wrong
                  channel is not a visible failure, the approval just lands
                  where nobody is watching for it. */}
              <select
                className={inputClass}
                value={form.slackChannel}
                onChange={(event) => change({ slackChannel: event.target.value })}
              >
                <option value="">No Slack channel — direct-message the approver</option>
                <option value={PINNED_SLACK_CHANNEL}>#{PINNED_SLACK_LABEL}</option>
              </select>
              {slackList.length > 1 ? (
                <span className="mt-1 block text-xs text-black/45">
                  The connection can see {slackList.length} channels; this deployment is pinned to
                  the one above.
                </span>
              ) : null}
            </Field>

            {/* Not a choice. There is exactly one space for this employee, and
                letting somebody pick another only creates a way to post
                approvals somewhere nobody reads. Shown so the operator can see
                where they go, and confirm it is the space they expect. */}
            <Field
              label="Google Chat space"
              hint="Fixed for this deployment. Approvals are posted here and the approver is mentioned."
            >
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-black/10 bg-black/[0.02] px-3.5 py-2.5 text-sm">
                <span className="font-medium">{PINNED_CHAT_LABEL}</span>
                <span className="font-mono text-[11px] text-black/40">{PINNED_CHAT_SPACE}</span>
              </div>
            </Field>

            {form.chatRoom && form.chatRoom !== PINNED_CHAT_SPACE ? (
              <Note>
                Settings currently hold a different space ({form.chatRoom}). Saving from this
                screen replaces it with the one above.
              </Note>
            ) : null}

            {/* The space existing is not the same as the app being in it, and
                that is the failure people lose an afternoon to. */}
            {!chatSpaceVisible ? (
              <Note>
                The connection cannot see that space, so a post to it will fail. Open the space in
                Google Chat, then Apps &amp; integrations, and add the Zapier app.
              </Note>
            ) : null}
          </Card>

          <Card className="space-y-4">
            <div>
              <h3 className="font-medium">Shared register</h3>
              <p className="mt-1 text-sm text-black/55">
                The catalogue, entitlements, requests, reviews and audit trail live in files on
                this machine, so Claude — which only reaches Zapier — cannot see them. Publishing
                them to a Google Sheet closes that gap: this app writes it, Claude reads it.
              </p>
            </div>

            <Field
              label="Google Sheet id"
              hint="Create an empty sheet, share it with the Google account connected to Zapier, and paste its id or full URL."
            >
              <input
                className={inputClass}
                value={form.registerSheetId}
                onChange={(event) => change({ registerSheetId: event.target.value })}
                placeholder="1AbC…"
              />
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="ghost"
                disabled={publishing || !form.registerSheetId.trim() || dirty}
                onClick={() => void publish()}
              >
                {publishing ? "Publishing…" : "Publish the register now"}
              </Button>
              {dirty ? (
                <span className="text-xs text-black/45">Save first — it publishes what is stored.</span>
              ) : null}
            </div>

            {published ? (
              published.ok ? (
                <OkNote>
                  {published.detail}
                  {published.written
                    ? ` Rows: ${Object.entries(published.written)
                        .map(([k, v]) => `${k} ${v}`)
                        .join(", ")}.`
                    : ""}
                  {published.tasksUsed ? ` Used ${published.tasksUsed} Zapier tasks.` : ""}
                </OkNote>
              ) : (
                <ErrorNote>{published.detail}</ErrorNote>
              )
            ) : null}

            {/* A copy, not the source. Worth saying where somebody might edit it
                and expect the app to notice. */}
            <p className="text-xs text-black/45">
              This is a one-way copy taken when you press the button — nothing reads back from it.
              Editing the sheet by hand changes nothing here, and the next publish overwrites it.
            </p>
          </Card>

          <Card className="space-y-4">
            <div>
              <h3 className="font-medium">House voice</h3>
              <p className="mt-1 text-sm text-black/55">
                Appended to every drafting prompt: justifications, decision notes, review summaries
                and offboarding briefs. It shapes tone only — it cannot loosen the rule that a
                draft may use no fact it was not given.
              </p>
            </div>
            <Field label="Voice" hint="Written as an instruction, in the second person.">
              <textarea
                className={`${inputClass} min-h-28`}
                value={form.voice}
                onChange={(event) => change({ voice: event.target.value })}
                placeholder="Plain, specific and short. Name the person, the tool and the date."
              />
            </Field>
          </Card>

          {saveError ? <ErrorNote>{saveError}</ErrorNote> : null}
          {saved ? <OkNote>{saved}</OkNote> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
            {dirty ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  if (feed) setForm(toForm(feed.settings));
                  setDirty(false);
                  setSaveError(null);
                  setSaved(null);
                }}
              >
                Discard changes
              </Button>
            ) : null}
            <span className="text-xs text-black/45">
              {dirty
                ? "Unsaved changes. Every save is written to the audit trail with the fields that changed."
                : "Saved settings. Every change is recorded in the audit trail."}
            </span>
          </div>
        </form>
      )}
    </div>
  );
}
