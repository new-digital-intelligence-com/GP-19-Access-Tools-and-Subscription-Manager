"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
  Stat,
  Table,
  Td,
  When,
  inputClass,
} from "@/components/ui";
import type { Entitlement, Person, Tool } from "@/lib/types";
import { ACTION_PASSWORD_HEADER } from "@/lib/guard-header";

/**
 * Lifecycle signals: access that has outlived the account holding it.
 *
 * The one claim this panel is not allowed to make is the obvious one. There is
 * no HR system here — Google Workspace knows about accounts, not employment —
 * so a suspended account, an account nobody has signed into since March, and a
 * grant pointing at an address with no account behind it are three reasons to
 * look, and none of them says anybody left. Every heading, every empty state
 * and every confirmation below is worded to keep that distinction, because the
 * action on offer is removing somebody's real access.
 *
 * The second rule is the same one the rest of the console runs on: a scan that
 * could not read the directory renders as an outage, never as "everyone's
 * access is in order", and an offboard reports every step it took, ok or not.
 * A half-finished offboard shown as a success is the failure this screen was
 * built to prevent.
 */

/** Mirrors `Holding` from the lifecycle library, which is server-only. */
type Holding = { entitlement: Entitlement; tool?: Tool };

/** Mirrors `SignalFinding`: an account still holding access, and what it costs. */
type SignalFinding = {
  person: Person;
  entitlements: Holding[];
  monthlyCost: number;
  idleDays?: number;
};

/** Mirrors `JoinerFinding`. */
type JoinerFinding = { person: Person; entitlementCount: number; ageDays: number };

/** Mirrors `OrphanFinding`: a register row whose address has no account. */
type OrphanFinding = { personEmail: string; entitlements: number; monthlyCost: number };

/** Mirrors `LifecycleScan`. Four result sets, and they mean different things. */
type LifecycleScan = {
  available: boolean;
  detail?: string;
  scannedAt: string;
  headcount: number;
  dormantAfterDays: number;
  departures: SignalFinding[];
  dormant: SignalFinding[];
  joiners: JoinerFinding[];
  orphans: OrphanFinding[];
};

type OffboardStep = {
  step: string;
  ok: boolean;
  detail: string;
  /** Nothing was sent: the tool has no API path and a human still has the job. */
  manual?: boolean;
};
type OffboardResult = { steps: OffboardStep[]; allOk: boolean };

/** What the operator is looking at when the dialog is open. */
type Dialog = { finding: SignalFinding; suspend: boolean };

/** The last offboard, kept on screen with everything it did and did not do. */
type Outcome = {
  personEmail: string;
  suspended: boolean;
  /** Tools with no API path, whose step can report ok having sent nothing. */
  manualTools: string[];
  result: OffboardResult;
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

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function plural(n: number, singular: string, many: string): string {
  return `${n} ${n === 1 ? singular : many}`;
}

/**
 * The pill key picks the colour; the label carries the meaning.
 *
 * An archived account still holding paid access is the worse of the two, so it
 * reads red where a suspended one reads amber. Neither says anything about the
 * person, which is why the label always names the *account*.
 */
function accountTone(state: Person["accountState"]): string {
  if (state === "archived") return "overdue";
  if (state === "suspended") return "pending";
  return "active";
}

function idleLabel(days: number | undefined, person: Person): string {
  if (days === undefined) {
    return person.lastLoginAt ? "idle time unknown" : "never signed in";
  }
  return person.lastLoginAt
    ? `${plural(days, "day", "days")} since the last sign-in`
    : `${plural(days, "day", "days")} old, never signed in`;
}

/** One account still holding access, with the grants named rather than counted. */
function SignalCard({
  finding,
  currency,
  dormantAfterDays,
  busy,
  briefing,
  onOffboard,
  onBrief,
}: {
  finding: SignalFinding;
  currency: string;
  /** Set on the dormant list only: the threshold that put this row here. */
  dormantAfterDays?: number;
  busy: boolean;
  briefing: boolean;
  onOffboard: (finding: SignalFinding) => void;
  onBrief: (finding: SignalFinding) => void;
}) {
  const { person } = finding;
  const failed = finding.entitlements.filter(
    (holding) => holding.entitlement.status === "pending-revoke",
  );

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="font-medium">{person.displayName || person.workEmail}</h4>
          <p className="text-xs text-black/50">
            {person.workEmail}
            {person.jobTitle ? ` · ${person.jobTitle}` : ""}
            {person.department ? ` · ${person.department}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill state={accountTone(person.accountState)} label={`${person.accountState} account`} />
          {person.isAdmin ? <Pill state="overdue" label="Workspace admin" /> : null}
          <Pill
            state="info"
            label={plural(finding.entitlements.length, "entitlement", "entitlements")}
          />
        </div>
      </div>

      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs tracking-wide text-black/45 uppercase">Idle</p>
          <p className="tnum mt-1">{idleLabel(finding.idleDays, person)}</p>
          {dormantAfterDays !== undefined ? (
            <p className="text-xs text-black/45">
              this scan counts {dormantAfterDays} days without a sign-in as dormant
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-xs tracking-wide text-black/45 uppercase">Last sign-in</p>
          <p className="mt-1">
            {person.lastLoginAt ? (
              <When at={person.lastLoginAt} />
            ) : (
              <span className="text-black/45">never</span>
            )}
          </p>
          {person.suspensionReason ? (
            <p className="text-xs text-black/45">reason given: {person.suspensionReason}</p>
          ) : null}
        </div>
        <div>
          <p className="text-xs tracking-wide text-black/45 uppercase">Still costing</p>
          <p className="tnum mt-1 font-medium">{money(finding.monthlyCost, currency)} / month</p>
        </div>
      </div>

      <div>
        <p className="text-xs tracking-wide text-black/45 uppercase">Access still held</p>
        <ul className="mt-1.5 space-y-1.5">
          {finding.entitlements.map(({ entitlement, tool }) => (
            <li
              key={entitlement.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-black/[0.03] px-4 py-2.5 text-sm"
            >
              <span className="min-w-0">
                <span className="font-medium">{tool?.name ?? entitlement.toolId}</span>
                {entitlement.role ? (
                  <span className="text-black/50"> · {entitlement.role}</span>
                ) : null}
                {tool ? (
                  <span className="text-black/45">
                    {" "}
                    · {tool.provisioning.replace(/-/g, " ")}
                  </span>
                ) : (
                  <span className="text-black/45"> · catalogue entry not readable here</span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <span className="tnum text-black/60">
                  {money(tool?.costPerSeat ?? 0, currency)} / month
                </span>
                <Pill state={entitlement.status} />
              </span>
            </li>
          ))}
        </ul>
      </div>

      {failed.length > 0 ? (
        <ErrorNote>
          {plural(failed.length, "grant was", "grants were")} already marked pending-revoke: a
          removal was attempted and the provider refused it, so {person.workEmail} probably still
          holds that access. Offboarding retries it, and will say so either way.
        </ErrorNote>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-black/8 pt-4">
        <Button variant="danger" disabled={busy} onClick={() => onOffboard(finding)}>
          Offboard
        </Button>
        <Button variant="ghost" disabled={briefing} onClick={() => onBrief(finding)}>
          {briefing ? "Drafting…" : "Brief"}
        </Button>
      </div>
    </Card>
  );
}

export function LifecyclePanel() {
  const [scan, setScan] = useState<LifecycleScan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currency, setCurrency] = useState("");

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [reason, setReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const [briefing, setBriefing] = useState<string | null>(null);
  const [brief, setBrief] = useState<{ personEmail: string; text: string } | null>(null);
  const [briefError, setBriefError] = useState<string | null>(null);

  // `loading` starts true and `load` does not set it, so that the mount effect
  // below triggers no synchronous state update — React flags that as a
  // cascading render, and it is also just wasted work when the initial value is
  // already correct. A manual refresh raises the flag itself, from the handler.
  const load = useCallback(async () => {
    try {
      setScan(await readJson<LifecycleScan>(await fetch("/api/lifecycle")));
      setLoadError(null);
    } catch (error) {
      // Findings from a previous pass are dropped rather than left on screen:
      // acting on a stale list is how somebody offboards the wrong account.
      setScan(null);
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

  // Only for the currency label on the costs below. A failure here leaves the
  // numbers unlabelled, which is worth far less than blocking the scan on it.
  useEffect(() => {
    fetch("/api/status")
      .then(readJson<{ spend: { currency: string } }>)
      .then((data) => setCurrency(data.spend.currency))
      .catch(() => setCurrency(""));
  }, []);

  function openOffboard(finding: SignalFinding) {
    setDialog({
      finding,
      // On by default only where the account is still live. Re-suspending an
      // already suspended account is a no-op that reads like an action, and
      // tick-by-default on a live account is the step most easily forgotten.
      suspend: finding.person.accountState === "active",
    });
    setReason("");
    setDialogError(null);
    setOutcome(null);
  }

  async function runOffboard(password: string) {
    if (!dialog) return;
    setBusy(true);
    setDialogError(null);
    try {
      const result = await readJson<OffboardResult>(
        await fetch("/api/lifecycle", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [ACTION_PASSWORD_HEADER]: password,
          },
          body: JSON.stringify({
            personEmail: dialog.finding.person.workEmail,
            suspendAccount: dialog.suspend,
            reason: reason.trim() || undefined,
          }),
        }),
      );
      setOutcome({
        personEmail: dialog.finding.person.workEmail,
        suspended: dialog.suspend,
        manualTools: dialog.finding.entitlements
          .filter((holding) => holding.tool?.provisioning === "manual")
          .map((holding) => holding.tool?.name ?? holding.entitlement.toolId),
        result,
      });
      setDialog(null);
      setReason("");
      await load();
    } catch (error) {
      setDialogError(message(error));
    }
    setBusy(false);
  }

  async function draftBrief(finding: SignalFinding) {
    setBriefing(finding.person.workEmail);
    setBriefError(null);
    setBrief(null);
    try {
      const data = await readJson<{ text: string }>(
        await fetch("/api/assist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "offboard-brief",
            person: `${finding.person.displayName || finding.person.workEmail} (${finding.person.workEmail})`,
            workspaceActive: finding.person.accountState === "active",
            // Sent field by field. The brief's whole job is separating what
            // this app can remove from what it cannot, and it can only do that
            // if it can see each grant's status and provisioning method.
            entitlements: finding.entitlements.map(({ entitlement, tool }) => ({
              tool: tool?.name ?? entitlement.toolId,
              role: entitlement.role,
              status: entitlement.status,
              provisioning: tool?.provisioning,
              grantedAt: entitlement.grantedAt,
              monthlyCost: tool?.costPerSeat,
            })),
          }),
        }),
      );
      setBrief({ personEmail: finding.person.workEmail, text: data.text });
    } catch (error) {
      setBriefError(message(error));
    }
    setBriefing(null);
  }

  const findings = scan
    ? scan.departures.length + scan.dormant.length + scan.joiners.length + scan.orphans.length
    : 0;
  const orphanSpend = scan?.orphans.reduce((total, row) => total + row.monthlyCost, 0) ?? 0;

  return (
    <div className="space-y-6">
      <SectionTitle
        right={
          <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => {
              setLoading(true);
              void load();
            }}>
            {loading ? "Scanning…" : "Rescan"}
          </Button>
        }
      >
        Lifecycle signals
      </SectionTitle>

      <p className="text-sm text-black/55">
        These are signals from the Google Workspace account directory, not facts about employment:
        no HR system is connected, so each row below is a reason to look at somebody&rsquo;s access,
        never proof that they left.
      </p>

      {outcome ? (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">Offboarding {outcome.personEmail}</h3>
            <div className="flex items-center gap-2">
              <Pill
                state={outcome.result.allOk ? "ok" : "failed"}
                label={outcome.result.allOk ? "every step reported ok" : "partial"}
              />
              <Button
                variant="ghost"
                className="px-3 py-1.5 text-xs"
                onClick={() => setOutcome(null)}
              >
                Dismiss
              </Button>
            </div>
          </div>

          {outcome.result.allOk ? (
            <OkNote>
              Every step came back ok. The ones marked “needs a hand” sent nothing to a vendor —
              that access is still live until someone removes it by hand.
            </OkNote>
          ) : (
            <ErrorNote>
              This offboarding is partial.{" "}
              {plural(
                outcome.result.steps.filter((step) => !step.ok).length,
                "step",
                "steps",
              )}{" "}
              of {outcome.result.steps.length} failed, so {outcome.personEmail} may still hold the
              access those steps were meant to remove. Fix the cause and run it again, or finish
              those steps by hand and mark the entitlements revoked.
            </ErrorNote>
          )}

          <ul className="space-y-2">
            {outcome.result.steps.map((step, index) => (
              <li
                key={index}
                className="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-black/[0.03] px-4 py-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium">{step.step}</p>
                  <p className="text-black/60">{step.detail}</p>
                </div>
                {/* A manual tool's revoke returns ok having sent nothing, so "ok"
                    on its own would read as done while the access is still live. */}
                <Pill
                  state={!step.ok ? "failed" : step.manual ? "pending" : "ok"}
                  label={!step.ok ? "failed" : step.manual ? "needs a hand" : "ok"}
                />
              </li>
            ))}
            {outcome.result.steps.length === 0 ? (
              <li className="rounded-xl bg-black/[0.03] px-4 py-3 text-sm text-black/60">
                No steps ran. There was nothing recorded to revoke and the Workspace account was
                left alone.
              </li>
            ) : null}
          </ul>

          {outcome.manualTools.length > 0 ? (
            <Note>
              {outcome.manualTools.join(", ")} {outcome.manualTools.length === 1 ? "has" : "have"}{" "}
              no API path, so nothing was sent to the vendor even where the step says ok. Those
              entitlements are left pending-revoke: remove the seats in the vendor console, then
              mark them revoked in the register.
            </Note>
          ) : null}

          {!outcome.suspended ? (
            <p className="text-sm text-black/55">
              The Workspace account was not touched. If it is still active, the person can sign in
              and anything that hangs off the account stays with them.
            </p>
          ) : null}
        </Card>
      ) : null}

      {briefError ? <ErrorNote>{briefError}</ErrorNote> : null}

      {brief ? (
        <Card className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">Brief for {brief.personEmail}</h3>
            <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => setBrief(null)}>
              Dismiss
            </Button>
          </div>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{brief.text}</p>
          <p className="text-xs text-black/45">
            Drafted from the rows on this card and nothing else. It is a note to read before
            acting; it changes no access by itself.
          </p>
        </Card>
      ) : null}

      {loadError ? (
        <ErrorNote>
          The lifecycle scan could not be run: {loadError}. Nothing was checked, so this is not a
          finding that everyone&rsquo;s access is in order.
        </ErrorNote>
      ) : loading && !scan ? (
        <Card className="space-y-2">
          <Loading label="Reading the Workspace directory…" />
          <p className="text-sm text-black/55">
            The directory is read a page at a time and compared against every active grant in the
            register, so this takes a while on a real organisation. A scan only looks; nothing is
            changed by it.
          </p>
        </Card>
      ) : !scan ? null : !scan.available ? (
        <Card className="space-y-3 border-red-200 bg-red-50/60">
          <h3 className="font-medium text-red-800">
            The Workspace directory could not be read, so nothing was checked
          </h3>
          <p className="text-sm text-red-800">
            {scan.detail ?? "The directory call did not come back."}
          </p>
          <p className="text-sm text-red-800">
            This is an outage, not a finding. It does not mean everyone&rsquo;s access is in order,
            and it does not mean there is nothing to offboard — it means this app cannot currently
            see the accounts it would compare the register against. The Entitlements tab still
            shows the register itself, which is this app&rsquo;s own data and unaffected.
          </p>
          <div>
            <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => {
              setLoading(true);
              void load();
            }}>
              {loading ? "Scanning…" : "Try the scan again"}
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <Card>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
              <Stat
                label="Accounts read"
                value={scan.headcount}
                hint={`scanned ${new Date(scan.scannedAt).toLocaleTimeString(undefined, { timeStyle: "short" })}`}
              />
              <Stat
                label="Suspended or archived"
                value={scan.departures.length}
                hint="still holding access"
              />
              <Stat
                label="Dormant"
                value={scan.dormant.length}
                hint={`no sign-in for ${scan.dormantAfterDays} days`}
              />
              <Stat label="New accounts" value={scan.joiners.length} hint="created recently" />
              <Stat
                label="No account at all"
                value={scan.orphans.length}
                hint={orphanSpend > 0 ? `${money(orphanSpend, currency)} / month` : "grants only"}
              />
            </div>
          </Card>

          {scan.detail ? (
            <Note>
              {scan.detail} Anything past that point was not compared against the register, so
              treat this scan as incomplete rather than clean.
            </Note>
          ) : null}

          {findings === 0 ? (
            <Empty
              title="Nothing on this scan is worth reviewing"
              hint={`${plural(scan.headcount, "account was", "accounts were")} read and compared against the register: no suspended or archived account still holds access, nothing has sat unused for ${scan.dormantAfterDays} days, and every grant points at an account that exists.`}
            />
          ) : null}

          {scan.departures.length > 0 ? (
            <div className="space-y-3">
              <SectionTitle>Suspended or archived accounts still holding access</SectionTitle>
              <p className="text-sm text-black/55">
                The account is switched off in Workspace and the register still shows live grants
                against it. An account is also suspended for a security hold, a long leave or a
                mistake, so read this as access to review rather than as somebody having left.
              </p>
              {scan.departures.map((finding) => (
                <SignalCard
                  key={finding.person.workEmail}
                  finding={finding}
                  currency={currency}
                  busy={busy}
                  briefing={briefing === finding.person.workEmail}
                  onOffboard={openOffboard}
                  onBrief={(row) => void draftBrief(row)}
                />
              ))}
            </div>
          ) : null}

          {scan.dormant.length > 0 ? (
            <div className="space-y-3">
              <SectionTitle>Dormant accounts still holding access</SectionTitle>
              <p className="text-sm text-black/55">
                Active accounts nobody has signed into for {scan.dormantAfterDays} days or more,
                still holding paid seats. Sabbaticals, shared service accounts and people who only
                use a tool through SSO all land here, so this is a list to ask about, not a list to
                clear.
              </p>
              {scan.dormant.map((finding) => (
                <SignalCard
                  key={finding.person.workEmail}
                  finding={finding}
                  currency={currency}
                  dormantAfterDays={scan.dormantAfterDays}
                  busy={busy}
                  briefing={briefing === finding.person.workEmail}
                  onOffboard={openOffboard}
                  onBrief={(row) => void draftBrief(row)}
                />
              ))}
            </div>
          ) : null}

          {scan.joiners.length > 0 ? (
            <div className="space-y-3">
              <SectionTitle>New accounts</SectionTitle>
              <p className="text-sm text-black/55">
                Accounts created in the last few weeks. Nothing is wrong with any of them — this is
                here so somebody with no tools yet is noticed before they ask.
              </p>
              <Table head={["Account", "Created", "Age", "Entitlements", ""]}>
                {scan.joiners.map((joiner) => (
                  <tr key={joiner.person.workEmail}>
                    <Td>
                      <span className="font-medium">
                        {joiner.person.displayName || joiner.person.workEmail}
                      </span>
                      <span className="block text-xs text-black/45">
                        {joiner.person.workEmail}
                        {joiner.person.jobTitle ? ` · ${joiner.person.jobTitle}` : ""}
                      </span>
                    </Td>
                    <Td className="text-black/60">
                      <When at={joiner.person.createdAt} relative={false} />
                    </Td>
                    <Td className="tnum text-black/60">
                      {plural(joiner.ageDays, "day", "days")} old
                    </Td>
                    <Td className="tnum">
                      {joiner.entitlementCount === 0 ? (
                        <span className="text-black/45">none recorded</span>
                      ) : (
                        joiner.entitlementCount
                      )}
                    </Td>
                    <Td>
                      <div className="flex justify-end">
                        <Link
                          href="/access?tab=requests"
                          className="rounded-xl border border-black/15 px-3 py-1.5 text-xs font-medium transition hover:border-brand/50 hover:bg-brand/[0.04]"
                        >
                          Raise a request
                        </Link>
                      </div>
                    </Td>
                  </tr>
                ))}
              </Table>
            </div>
          ) : null}

          {scan.orphans.length > 0 ? (
            <div className="space-y-3">
              <SectionTitle>Grants with no Workspace account</SectionTitle>
              <Card className="space-y-3 border-red-200 bg-red-50/60">
                <p className="text-sm text-red-800">
                  This is the strongest signal on the page. Every other list is a question about
                  whether access is still justified; this one is the register paying{" "}
                  {money(orphanSpend, currency)} a month for seats held by addresses that have no
                  Workspace account behind them at all. Nobody can sign in with them, so the money
                  buys nothing, and the row itself is evidence the register drifted out of step
                  with the directory — either the account went and the grant never did, or the
                  address was recorded wrongly in the first place.
                </p>
                <Table head={["Address on the grant", "Entitlements", "Monthly cost"]}>
                  {scan.orphans.map((orphan) => (
                    <tr key={orphan.personEmail}>
                      <Td className="font-medium">{orphan.personEmail}</Td>
                      <Td className="tnum">{orphan.entitlements}</Td>
                      <Td className="tnum">{money(orphan.monthlyCost, currency)}</Td>
                    </tr>
                  ))}
                </Table>
                <p className="text-sm text-red-800">
                  There is no account to offboard here, so these are cleared in the register: open{" "}
                  <Link href="/access?tab=entitlements" className="underline">
                    Entitlements
                  </Link>
                  , filter on the address, and revoke each grant with the reason recorded. Check
                  the spelling first — a typo in an email address produces exactly this row.
                </p>
              </Card>
            </div>
          ) : null}
        </>
      )}

      <Confirm
        open={dialog !== null}
        title={dialog ? `Offboard ${dialog.finding.person.workEmail}` : ""}
        consequence={
          !dialog
            ? ""
            : `Revokes ${plural(dialog.finding.entitlements.length, "entitlement", "entitlements")} ` +
              `held by ${dialog.finding.person.workEmail}, one provider call at a time, and frees ` +
              `${money(dialog.finding.monthlyCost, currency)} a month. ` +
              (dialog.suspend
                ? "The Workspace account is suspended as well, so sign-in stops. "
                : "The Workspace account is left as it is. ") +
              "Every step is reported back with its result, and a call the provider refuses leaves " +
              "that entitlement pending-revoke with the access probably still live."
        }
        confirmLabel="Offboard"
        variant="danger"
        busy={busy}
        requirePassword
        onConfirm={(password) => void runOffboard(password)}
        onCancel={() => {
          setDialog(null);
          setDialogError(null);
        }}
      >
        {dialog ? (
          <div className="space-y-4">
            <div>
              <p className="text-xs tracking-wide text-black/45 uppercase">
                What will be revoked ({dialog.finding.entitlements.length})
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {dialog.finding.entitlements.map(({ entitlement, tool }) => (
                  <li
                    key={entitlement.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-black/[0.03] px-3.5 py-2 text-sm"
                  >
                    <span>
                      <span className="font-medium">{tool?.name ?? entitlement.toolId}</span>
                      {entitlement.role ? (
                        <span className="text-black/50"> · {entitlement.role}</span>
                      ) : null}
                      {tool?.provisioning === "manual" ? (
                        <span className="block text-xs text-amber-800">
                          no API path — this app cannot remove it, somebody has to do it in the
                          vendor console
                        </span>
                      ) : null}
                    </span>
                    <span className="tnum text-xs text-black/55">
                      {money(tool?.costPerSeat ?? 0, currency)} / month
                    </span>
                  </li>
                ))}
                {dialog.finding.entitlements.length === 0 ? (
                  <li className="rounded-xl bg-black/[0.03] px-3.5 py-2 text-sm text-black/60">
                    Nothing is recorded against this address in the register.
                  </li>
                ) : null}
              </ul>
            </div>

            <label className="flex items-start gap-3 rounded-xl bg-black/[0.03] px-4 py-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-brand"
                checked={dialog.suspend}
                onChange={(event) =>
                  setDialog((current) =>
                    current ? { ...current, suspend: event.target.checked } : current,
                  )
                }
              />
              <span>
                <span className="font-medium">Also suspend the Workspace account</span>
                <span className="mt-0.5 block text-black/60">
                  Suspending stops sign-in and is reversible: the mailbox, the Drive files and the
                  address all survive it, and an admin can lift it in a click. Nothing here deletes
                  the account — deletion destroys that data and is a separate, deliberate act in
                  the Google admin console.
                </span>
                {dialog.finding.person.accountState !== "active" ? (
                  <span className="mt-1 block text-black/45">
                    This account is already {dialog.finding.person.accountState}, so leaving the box
                    unticked changes nothing about sign-in.
                  </span>
                ) : null}
              </span>
            </label>

            <Field
              label="Reason (optional)"
              hint="Written into the audit trail against every revoke this runs. Without one the trail records the generic offboarding reason."
            >
              <textarea
                className={`${inputClass} min-h-20`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Account suspended since March and the seats are still being billed."
              />
            </Field>

            {dialogError ? <ErrorNote>{dialogError}</ErrorNote> : null}
          </div>
        ) : null}
      </Confirm>
    </div>
  );
}
