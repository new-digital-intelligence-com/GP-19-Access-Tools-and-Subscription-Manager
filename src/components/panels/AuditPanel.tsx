"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Loading,
  Note,
  Pill,
  SectionTitle,
  Table,
  Td,
  When,
  inputClass,
} from "@/components/ui";
import type { AuditEvent, Tool } from "@/lib/types";

/**
 * The trail: what happened, who caused it, and whether it worked.
 *
 * Read-only by design — there is no way to write an entry from here, because a
 * trail anyone can add to answers nothing. What this panel has to get right is
 * the reading of it. Failures are recorded exactly like successes, so half the
 * value is in the rows that say a call did *not* work: `revoke.failed` is not
 * a footnote about a retry, it is a person who still has the access. The table
 * says that in words rather than leaving it to a red dot.
 *
 * The copy button exports what is on screen rather than everything, so an
 * answer pasted into a ticket is the answer to the question that was asked.
 */

type Filters = {
  personEmail: string;
  toolId: string;
  requestId: string;
  action: string;
  limit: number;
};

const EMPTY: Filters = { personEmail: "", toolId: "", requestId: "", action: "", limit: 200 };

/** The API caps at 2000; anything above that is silently clamped there. */
const LIMITS = [50, 200, 500, 1000, 2000];

/** Substrings that pull out the questions people actually come here with. */
const SHORTCUTS: { label: string; action: string }[] = [
  { label: "Approvals", action: "request.approved" },
  { label: "Grants", action: "grant" },
  { label: "Revokes", action: "revoke" },
  { label: "Failed revokes", action: "revoke.failed" },
  { label: "Offboarding", action: "offboard" },
];

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

export function AuditPanel() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Only to make the tool filter usable. The trail itself carries tool ids.
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  // `loading` starts true and `load` does not set it, so that the mount effect
  // below triggers no synchronous state update — React flags that as a
  // cascading render, and it is also just wasted work when the initial value is
  // already correct. A manual refresh raises the flag itself, from the handler.
  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filters.personEmail) params.set("personEmail", filters.personEmail);
    if (filters.toolId) params.set("toolId", filters.toolId);
    if (filters.requestId) params.set("requestId", filters.requestId);
    if (filters.action) params.set("action", filters.action);
    params.set("limit", String(filters.limit));
    try {
      const data = await readJson<{ events: AuditEvent[] }>(
        await fetch(`/api/audit?${params.toString()}`),
      );
      setEvents(data.events);
      setLoadError(null);
    } catch (error) {
      setEvents(null);
      setLoadError(message(error));
    }
    setLoading(false);
  }, [filters]);

  useEffect(() => {
    // Deferred by a microtask rather than called straight from the effect body.
    // `load` updates state, and doing that synchronously during the effect
    // flush costs a cascading render for no benefit — the first paint already
    // shows the loading state.
    void Promise.resolve().then(load);
  }, [load]);

  // Best effort. A catalogue that will not load costs the picker, not the
  // trail, so the filter degrades to the tool id rather than disappearing.
  useEffect(() => {
    fetch("/api/catalog?includeArchived=1")
      .then(readJson<{ tools: Tool[] }>)
      .then((data) => setTools(data.tools))
      .catch(() => setTools(null));
  }, []);

  function apply(event: React.FormEvent) {
    event.preventDefault();
    setFilters({
      ...draft,
      personEmail: draft.personEmail.trim().toLowerCase(),
      requestId: draft.requestId.trim(),
      action: draft.action.trim(),
    });
  }

  function shortcut(action: string) {
    const next = { ...draft, action };
    setDraft(next);
    setFilters(next);
  }

  async function copy() {
    setCopyError(null);
    if (!events || events.length === 0) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(events, null, 2));
      setCopied(`Copied ${events.length} ${events.length === 1 ? "row" : "rows"} as JSON.`);
      window.setTimeout(() => setCopied(null), 4000);
    } catch (error) {
      // Clipboard access is denied outright in some browsers and over plain
      // http. Saying so beats a button that looks like it worked.
      setCopyError(
        `The clipboard could not be written: ${message(error)}. Select the table and copy it by hand instead.`,
      );
    }
  }

  const rows = events ?? [];
  const filtered = Boolean(
    filters.personEmail || filters.toolId || filters.requestId || filters.action,
  );
  const capped = rows.length >= filters.limit;
  const failures = rows.filter((event) => event.result === "error").length;

  return (
    <div className="space-y-6">
      <SectionTitle
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              className="px-3 py-1.5 text-xs"
              disabled={rows.length === 0}
              onClick={() => void copy()}
            >
              Copy as JSON
            </Button>
            <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => {
              setLoading(true);
              void load();
            }}>
              {loading ? "Reading…" : "Refresh"}
            </Button>
          </div>
        }
      >
        Audit trail
      </SectionTitle>

      <p className="text-sm text-black/55">
        Append-only: entries are written by the code that did the thing, and nothing here edits or
        deletes them. Failures are recorded exactly like successes, which is the point — a{" "}
        <code className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-xs">revoke.failed</code>{" "}
        line means the removal was attempted and refused, so the access stayed where it was.
      </p>

      <Card className="space-y-4">
        <form onSubmit={apply} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Person" hint="Exact work email.">
              <input
                className={inputClass}
                value={draft.personEmail}
                onChange={(event) => setDraft({ ...draft, personEmail: event.target.value })}
                placeholder="priya@acme.com"
              />
            </Field>
            <Field
              label="Tool"
              hint={tools === null ? "The catalogue could not be read; filter by tool id." : undefined}
            >
              {tools === null ? (
                <input
                  className={inputClass}
                  value={draft.toolId}
                  onChange={(event) => setDraft({ ...draft, toolId: event.target.value })}
                  placeholder="tool id"
                />
              ) : (
                <select
                  className={inputClass}
                  value={draft.toolId}
                  onChange={(event) => setDraft({ ...draft, toolId: event.target.value })}
                >
                  <option value="">Every tool</option>
                  {tools.map((tool) => (
                    <option key={tool.id} value={tool.id}>
                      {tool.name}
                      {tool.archivedAt ? " (archived)" : ""}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Request id" hint="Everything one request caused.">
              <input
                className={inputClass}
                value={draft.requestId}
                onChange={(event) => setDraft({ ...draft, requestId: event.target.value })}
                placeholder="req_…"
              />
            </Field>
            <Field label="Action" hint="Matched as a substring.">
              <input
                className={inputClass}
                value={draft.action}
                onChange={(event) => setDraft({ ...draft, action: event.target.value })}
                placeholder="revoke"
              />
            </Field>
            <Field label="Rows" hint="Most recent first.">
              <select
                className={inputClass}
                value={draft.limit}
                onChange={(event) => setDraft({ ...draft, limit: Number(event.target.value) })}
              >
                {LIMITS.map((limit) => (
                  <option key={limit} value={limit}>
                    {limit}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Apply filters</Button>
            {filtered || filters.limit !== EMPTY.limit ? (
              <Button
                type="button"
                variant="ghost"
                className="px-3 py-1.5 text-xs"
                onClick={() => {
                  setDraft(EMPTY);
                  setFilters(EMPTY);
                }}
              >
                Clear filters
              </Button>
            ) : null}
            <span className="tnum text-xs text-black/45">
              {rows.length} {rows.length === 1 ? "entry" : "entries"}
              {failures > 0 ? ` · ${failures} recorded as failures` : ""}
            </span>
          </div>
        </form>

        <div className="flex flex-wrap items-center gap-2 border-t border-black/8 pt-4">
          <span className="text-xs text-black/45">Common questions:</span>
          {SHORTCUTS.map((entry) => (
            <button
              key={entry.action}
              type="button"
              onClick={() => shortcut(entry.action)}
              className={`rounded-xl px-3 py-1.5 text-xs font-medium transition ${
                filters.action === entry.action
                  ? "bg-brand text-white"
                  : "border border-black/15 text-black/60 hover:border-brand/50 hover:bg-brand/[0.04]"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </Card>

      {copied ? <Note>{copied}</Note> : null}
      {copyError ? <ErrorNote>{copyError}</ErrorNote> : null}

      {loadError ? (
        <ErrorNote>
          The audit trail could not be read: {loadError}. Nothing is listed because the read
          failed, not because nothing happened — do not take this screen as evidence either way
          until it loads.
        </ErrorNote>
      ) : loading && !events ? (
        <Loading label="Reading the trail…" />
      ) : rows.length === 0 ? (
        <Empty
          title={filtered ? "Nothing in the trail matches these filters" : "The trail is empty"}
          hint={
            filtered
              ? "Action is matched as a substring, so a shorter one catches more: revoke covers revoke.provisioned, revoke.failed and revoke.manual-required. Widen or clear the filters to see everything."
              : "Entries are written the moment something happens — a request raised, a decision made, a grant provisioned or refused. An empty trail means nothing has happened yet in this deployment."
          }
        />
      ) : (
        <div className="space-y-3">
          {capped ? (
            <Note>
              Showing the most recent {filters.limit} entries, which is the limit set above. There
              are almost certainly older ones — raise the limit or filter down before concluding
              something never happened.
            </Note>
          ) : null}

          <Table head={["When", "Actor", "Action", "Subject", "Result", "Detail"]}>
            {rows.map((event) => (
              <tr key={event.id} className={event.result === "error" ? "bg-red-50/40" : undefined}>
                <Td className="text-black/60">
                  <When at={event.at} />
                </Td>
                <Td className="text-black/70">{event.actor}</Td>
                <Td>
                  <span className="font-mono text-xs">{event.action}</span>
                </Td>
                <Td>
                  <span className="break-words">{event.subject}</span>
                  {event.requestId ? (
                    <span className="block font-mono text-[11px] text-black/40">
                      {event.requestId}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <Pill state={event.result === "error" ? "failed" : event.result} />
                </Td>
                <Td className="max-w-md text-black/60">
                  <span className="break-words">{event.detail}</span>
                  {event.result === "error" ? (
                    <span className="mt-1 block text-xs font-medium text-red-700">
                      This step did not work. Whatever it was going to change was left as it was.
                    </span>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </div>
  );
}
