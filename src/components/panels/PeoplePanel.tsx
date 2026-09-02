"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import type { Entitlement, Person } from "@/lib/types";

/**
 * The Google Workspace directory.
 *
 * This screen is the one place in the app where it is easiest to say something
 * untrue about a person, so it is built to keep three things apart.
 *
 * An unreadable directory is an outage, drawn as an outage. An empty table
 * would read as "nobody has an account", and that is the sentence this panel
 * exists to never write.
 *
 * A *successful* read that stopped at its page cap is not an outage — it is a
 * complete-looking table missing its tail. It gets a warning above the rows in
 * a different colour, because presenting a partial directory as the whole one
 * is the quiet failure here rather than the loud one.
 *
 * And an account state is a fact about an account. Workspace does not hold
 * employment, no HR system is connected, and nothing on this screen may be
 * phrased as though one were: suspended, archived and dormant are signals
 * worth reviewing, and each is left as exactly that.
 */

type Feed = { available: boolean; detail?: string; people: Person[] };

/** Mirrors `AccountState` from the workspace provider, which is server-only. */
type AccountState = {
  found: boolean;
  userId?: string;
  suspended?: boolean;
  archived?: boolean;
  orgUnitPath?: string;
  lastLoginTime?: string;
  isAdmin?: boolean;
};

type Detail = {
  available: boolean;
  detail?: string;
  person?: Person;
  account: AccountState;
  entitlements: (Entitlement & { toolName: string })[];
};

type StateFilter = "all" | Person["accountState"];

const FILTERS: { id: StateFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "suspended", label: "Suspended" },
  { id: "archived", label: "Archived" },
];

/**
 * Account state mapped onto the shared pill palette.
 *
 * Suspended gets the amber "worth a look" tone rather than the red failure
 * tone: red would read as a verdict on the person, and it is not one.
 */
const TONE: Record<Person["accountState"], string> = {
  active: "active",
  suspended: "due",
  archived: "closed",
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

function matches(person: Person, query: string): boolean {
  if (!query) return true;
  const haystack = [
    person.displayName,
    person.workEmail,
    person.jobTitle,
    person.department,
    person.orgUnitPath,
    person.managerEmail,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

/** Absent `lastLoginAt` is the word, never a date. Google's epoch is dropped upstream. */
function LastSignIn({ at }: { at?: string }) {
  if (!at) return <span className="font-medium text-black/55">Never</span>;
  return <When at={at} />;
}

export function PeoplePanel() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const detailRef = useRef<HTMLDivElement>(null);

  // `loading` starts true and `load` does not set it, so that the mount effect
  // below triggers no synchronous state update — React flags that as a
  // cascading render, and it is also just wasted work when the initial value is
  // already correct. A manual refresh raises the flag itself, from the handler.
  const load = useCallback(async () => {
    try {
      setFeed(await readJson<Feed>(await fetch("/api/people")));
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

  async function select(email: string) {
    setSelected(email);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    // Scrolled to before the read finishes so the block the reader is waiting
    // on is the one in front of them, not one that appeared off-screen.
    detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      setDetail(
        await readJson<Detail>(await fetch(`/api/people?email=${encodeURIComponent(email)}`)),
      );
    } catch (error) {
      setDetailError(message(error));
    }
    setDetailLoading(false);
  }

  const people = feed?.people ?? [];
  const query = search.trim().toLowerCase();
  const shown = people.filter(
    (person) =>
      (stateFilter === "all" || person.accountState === stateFilter) && matches(person, query),
  );
  const counts: Record<StateFilter, number> = {
    all: people.length,
    active: people.filter((person) => person.accountState === "active").length,
    suspended: people.filter((person) => person.accountState === "suspended").length,
    archived: people.filter((person) => person.accountState === "archived").length,
  };
  const filtered = stateFilter !== "all" || query.length > 0;
  const outage = feed !== null && !feed.available;
  const truncated = feed !== null && feed.available && Boolean(feed.detail);
  const selectedRow = selected ? people.find((person) => person.workEmail === selected) : undefined;

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
        Workspace directory
      </SectionTitle>

      <p className="max-w-3xl text-sm text-black/55">
        This is the Google Workspace account directory, not an HR record. Nothing here knows who
        works at the company: a suspended, archived or long-unused account is a signal worth
        reviewing, never a statement about anyone&rsquo;s employment.
      </p>

      {loadError ? (
        <ErrorNote>
          The directory read failed outright: {loadError}. No accounts are listed because the call
          did not return, which is not a finding that nobody has an account.
        </ErrorNote>
      ) : loading && !feed ? (
        <Loading label="Reading the Workspace directory…" />
      ) : outage ? (
        // Deliberately a card and not a table with nothing in it: an empty
        // table is the shape this failure must never be allowed to take.
        <Card className="space-y-3 border-red-200 bg-red-50/70">
          <div className="flex flex-wrap items-center gap-2">
            <Pill state="unavailable" label="directory unavailable" />
            <h3 className="font-medium text-red-800">The directory could not be read</h3>
          </div>
          <p className="text-sm text-red-800">
            {feed?.detail ??
              "Google Workspace returned nothing and gave no reason. The connection is the first thing to check."}
          </p>
          <p className="text-sm text-red-800">
            No account list is shown, and none should be inferred. Everything downstream of this
            read — who has an account, which accounts are suspended, who has not signed in — is
            simply unknown until it succeeds. The entitlement register is stored in this app and is
            unaffected.
          </p>
          <div>
            <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => {
              setLoading(true);
              void load();
            }}>
              Try again
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {truncated ? (
            <Note>
              <span className="font-medium">This directory is incomplete.</span> The read
              succeeded, so what is below is real — it is just not all of it. {feed?.detail} Anyone
              past that point is missing from the table, the filters and the counts, so do not
              treat an absence here as an absence of an account.
            </Note>
          ) : null}

          <div ref={detailRef} className="scroll-mt-6 space-y-6">
            {selected ? (
              <Card className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-medium">{selectedRow?.displayName ?? selected}</h3>
                    <p className="text-xs text-black/50">{selected}</p>
                  </div>
                  <Button
                    variant="ghost"
                    className="px-3 py-1.5 text-xs"
                    onClick={() => {
                      setSelected(null);
                      setDetail(null);
                      setDetailError(null);
                    }}
                  >
                    Close
                  </Button>
                </div>

                {detailError ? (
                  <ErrorNote>
                    This account could not be looked up: {detailError}. Nothing below is a finding
                    about the account — the read did not complete.
                  </ErrorNote>
                ) : detailLoading || !detail ? (
                  <Loading label="Reading the account…" />
                ) : (
                  <>
                    {/* Three different things that all look alike if you let
                        them: the lookup failed, the lookup worked and found no
                        account, or the lookup worked and the state came back
                        empty anyway. Only the middle one is a fact about an
                        address. */}
                    {!detail.available ? (
                      <ErrorNote>
                        The Workspace lookup for {selected} failed
                        {detail.detail ? `: ${detail.detail}` : "."} That is an outage, not an
                        answer — it does not mean there is no account for this address.
                      </ErrorNote>
                    ) : !detail.account.found && detail.person ? (
                      <Note>
                        The directory has a record for this address, but the account-state read
                        came back with nothing. Treat the account facts as unread rather than as
                        absent, and try again before acting on them.
                      </Note>
                    ) : !detail.account.found ? (
                      <Note>
                        No Workspace account for this address. That is worth reviewing and it is
                        not a conclusion about a person: the address may be an alias, a shared
                        mailbox, a domain that is not managed here, or simply spelled differently
                        in the register.
                      </Note>
                    ) : (
                      <div className="grid gap-4 rounded-xl bg-black/[0.03] px-4 py-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                        <div>
                          <p className="text-xs tracking-wide text-black/45 uppercase">
                            Account state
                          </p>
                          <p className="mt-1 flex flex-wrap items-center gap-1.5">
                            {detail.account.archived ? (
                              <Pill state="closed" label="archived" />
                            ) : detail.account.suspended ? (
                              <Pill state="due" label="suspended" />
                            ) : (
                              <Pill state="active" label="active" />
                            )}
                            {detail.account.isAdmin ? (
                              <Pill state="overdue" label="admin" />
                            ) : null}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs tracking-wide text-black/45 uppercase">Org unit</p>
                          <p className="mt-1">
                            {detail.account.orgUnitPath ?? (
                              <span className="text-black/40">not recorded</span>
                            )}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs tracking-wide text-black/45 uppercase">
                            Last sign-in
                          </p>
                          <p className="mt-1">
                            <LastSignIn at={detail.account.lastLoginTime} />
                          </p>
                        </div>
                        <div>
                          <p className="text-xs tracking-wide text-black/45 uppercase">
                            Workspace id
                          </p>
                          <p className="mt-1 text-black/60">
                            {detail.account.userId ?? (
                              <span className="text-black/40">not returned</span>
                            )}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs tracking-wide text-black/45 uppercase">
                            Admin rights
                          </p>
                          <p className="mt-1">
                            {detail.account.isAdmin ? "Yes — this account is an admin" : "No"}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs tracking-wide text-black/45 uppercase">
                            Directory record
                          </p>
                          <p className="mt-1 text-black/60">
                            {detail.person?.jobTitle ?? "no job title"}
                            {detail.person?.department ? ` · ${detail.person.department}` : ""}
                          </p>
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      <p className="text-xs tracking-wide text-black/45 uppercase">
                        What the register says they hold
                      </p>
                      {detail.entitlements.length === 0 ? (
                        <p className="rounded-xl bg-black/[0.03] px-4 py-3 text-sm text-black/60">
                          Nothing is recorded against this address in the entitlement register.
                          That means nothing was recorded here — not that they hold no access
                          anywhere.
                        </p>
                      ) : (
                        <ul className="divide-y divide-black/5 rounded-xl border border-black/10">
                          {detail.entitlements.map((row) => (
                            <li
                              key={row.id}
                              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium">{row.toolName}</p>
                                <p className="text-xs text-black/50">
                                  {row.role ? `${row.role} · ` : ""}granted{" "}
                                  <When at={row.grantedAt} />
                                </p>
                              </div>
                              <div className="flex flex-col items-end gap-1">
                                <Pill state={row.status} />
                                {row.status === "pending-revoke" ? (
                                  <span className="text-xs font-medium text-red-700">
                                    revoke failed — access may remain
                                  </span>
                                ) : null}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )}
              </Card>
            ) : null}
          </div>

          <Card className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Not a <Field>: that renders a label, and a label wrapping a
                  row of buttons is the wrong element for a filter group. */}
              <div className="space-y-1.5">
                <span className="block text-sm font-medium">Account state</span>
                <div className="flex flex-wrap gap-2">
                  {FILTERS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setStateFilter(option.id)}
                      className={`tnum rounded-xl px-3 py-1.5 text-xs font-medium transition ${
                        stateFilter === option.id
                          ? "bg-brand text-white"
                          : "border border-black/15 text-black/60 hover:border-brand/50 hover:bg-brand/[0.04]"
                      }`}
                    >
                      {option.label} {counts[option.id]}
                    </button>
                  ))}
                </div>
                <span className="block text-xs text-black/45">
                  Filters this view only. Nothing about an account is changed here.
                </span>
              </div>
              <Field label="Search" hint="Name, email, job title, department or org unit.">
                <input
                  className={inputClass}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="priya, design, /contractors"
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="tnum text-xs text-black/45">
                Showing {shown.length} of {people.length}{" "}
                {people.length === 1 ? "account" : "accounts"}
                {truncated ? " that this scan reached" : ""}.
              </span>
              {filtered ? (
                <Button
                  variant="ghost"
                  className="px-3 py-1.5 text-xs"
                  onClick={() => {
                    setStateFilter("all");
                    setSearch("");
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </div>
          </Card>

          {people.length === 0 ? (
            <Empty
              title="The directory read returned no accounts"
              hint="The call succeeded and came back with nothing. For a live Workspace domain that is worth checking rather than believing — start with what the connected Workspace account is scoped to."
            />
          ) : shown.length === 0 ? (
            <Empty
              title="No account matches these filters"
              hint="Clear the search or widen the state filter. The accounts are there; this view is hiding them."
            />
          ) : (
            <Table
              head={[
                "Name",
                "Work email",
                "Job title",
                "Department",
                "Org unit",
                "Account",
                "Last sign-in",
              ]}
            >
              {shown.map((person) => (
                <tr
                  key={person.id}
                  onClick={() => void select(person.workEmail)}
                  className={`cursor-pointer transition hover:bg-brand/[0.04] ${
                    selected === person.workEmail ? "bg-brand/[0.06]" : ""
                  }`}
                >
                  <Td>
                    <button
                      type="button"
                      // The row is clickable for the mouse; the button is what
                      // makes the same thing reachable from the keyboard.
                      onClick={(event) => {
                        event.stopPropagation();
                        void select(person.workEmail);
                      }}
                      className="text-left font-medium hover:text-brand-ink"
                    >
                      {person.displayName || person.workEmail}
                    </button>
                    {person.isAdmin ? (
                      <span className="mt-1 block">
                        <Pill state="overdue" label="admin" />
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-black/60">{person.workEmail}</Td>
                  <Td className="text-black/60">
                    {person.jobTitle ?? <span className="text-black/35">—</span>}
                  </Td>
                  <Td className="text-black/60">
                    {person.department ?? <span className="text-black/35">—</span>}
                  </Td>
                  <Td className="text-black/60">
                    {person.orgUnitPath ?? <span className="text-black/35">—</span>}
                  </Td>
                  <Td>
                    <Pill state={TONE[person.accountState]} label={person.accountState} />
                    {person.accountState === "suspended" && person.suspensionReason ? (
                      <span className="mt-1 block max-w-44 text-xs text-black/45">
                        {person.suspensionReason}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-black/60">
                    <LastSignIn at={person.lastLoginAt} />
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </div>
  );
}
