import "server-only";
import * as dir from "./providers/directory";
import * as workspace from "./providers/workspace";
import { listEntitlements, revokeAccess } from "./entitlements";
import { listTools } from "./catalog";
import { record } from "./audit";
import { getSettings } from "./settings";
import type { Entitlement, Person, Tool } from "./types";

/**
 * Lifecycle: the accounts whose access no longer looks justified.
 *
 * Two rules shape this module.
 *
 * **Detection is automatic, action is not.** Findings are surfaced with
 * everything an operator needs to act; the revoke runs only when a human
 * triggers it, one person at a time. There is no cron that removes access.
 *
 * **Everything here is a signal, not a fact about employment.** No HR system
 * is connected, so the only evidence available is what Google Workspace holds:
 * an account is suspended, an account has not been signed into for months, an
 * entitlement points at an address with no account behind it at all. Each of
 * those is a good reason to look, and none of them proves someone left. The
 * wording throughout — `departures`, `looksDeparted`, "worth reviewing" —
 * is deliberate, and the UI must not upgrade it to a claim about a person.
 */

export type Holding = { entitlement: Entitlement; tool?: Tool };

export type SignalFinding = {
  person: Person;
  /** Live entitlements the account still holds. */
  entitlements: Holding[];
  monthlyCost: number;
  /** Days since the account was suspended or last used, where known. */
  idleDays?: number;
};

export type JoinerFinding = {
  person: Person;
  entitlementCount: number;
  /** Days since the account was created. */
  ageDays: number;
};

export type OrphanFinding = {
  personEmail: string;
  entitlements: number;
  monthlyCost: number;
};

export type LifecycleScan = {
  available: boolean;
  detail?: string;
  scannedAt: string;
  headcount: number;
  /** How many days without a sign-in counts as dormant for this scan. */
  dormantAfterDays: number;
  /** Suspended or archived accounts that still hold access. */
  departures: SignalFinding[];
  /** Active accounts nobody has signed into, that still hold access. */
  dormant: SignalFinding[];
  /** Accounts created recently. */
  joiners: JoinerFinding[];
  /** Register rows for addresses with no Workspace account at all. */
  orphans: OrphanFinding[];
};

const DAY = 86_400_000;

/**
 * Compare the Workspace directory against the register.
 *
 * Read-only. Nothing in this function changes access anywhere. One directory
 * call covers every account, so unlike a per-person probe it stays fast on a
 * real org.
 */
export async function scan(options?: {
  joinerWindowDays?: number;
  dormantAfterDays?: number;
}): Promise<LifecycleScan> {
  const scannedAt = new Date().toISOString();
  const joinerWindow = options?.joinerWindowDays ?? 30;
  const dormantAfterDays = options?.dormantAfterDays ?? 60;

  const [directory, entitlements, tools] = await Promise.all([
    dir.directory(),
    listEntitlements({ status: "active" }),
    listTools(true),
  ]);

  if (!directory.available) {
    return {
      available: false,
      detail:
        directory.detail ??
        "The Workspace directory could not be read. Nothing was checked, so this is " +
          "not a finding that everyone's access is in order.",
      scannedAt,
      headcount: 0,
      dormantAfterDays,
      departures: [],
      dormant: [],
      joiners: [],
      orphans: [],
    };
  }

  const toolById = new Map(tools.map((tool) => [tool.id, tool]));
  const byPerson = new Map<string, Entitlement[]>();
  for (const entitlement of entitlements) {
    byPerson.set(entitlement.personEmail, [
      ...(byPerson.get(entitlement.personEmail) ?? []),
      entitlement,
    ]);
  }

  const now = new Date();
  const holdings = (email: string): Holding[] =>
    (byPerson.get(email) ?? []).map((entitlement) => ({
      entitlement,
      tool: toolById.get(entitlement.toolId),
    }));
  const cost = (rows: Holding[]) =>
    rows.reduce((sum, row) => sum + (row.tool?.costPerSeat ?? 0), 0);
  const daysSince = (at?: string) =>
    at ? Math.floor((now.getTime() - new Date(at).getTime()) / DAY) : undefined;

  const departures: SignalFinding[] = [];
  const dormant: SignalFinding[] = [];
  const joiners: JoinerFinding[] = [];

  for (const person of directory.people) {
    const rows = holdings(person.workEmail);

    if (dir.looksDeparted(person)) {
      // A suspended account with no entitlements needs no action from this
      // app, so it is not a finding — only access outliving its account is.
      if (rows.length) {
        departures.push({
          person,
          entitlements: rows,
          monthlyCost: cost(rows),
          idleDays: daysSince(person.lastLoginAt),
        });
      }
      continue;
    }

    if (rows.length && dir.looksDormant(person, dormantAfterDays, now)) {
      dormant.push({
        person,
        entitlements: rows,
        monthlyCost: cost(rows),
        idleDays: daysSince(person.lastLoginAt ?? person.createdAt),
      });
    }

    const age = daysSince(person.createdAt);
    if (age !== undefined && age >= 0 && age <= joinerWindow) {
      joiners.push({ person, entitlementCount: rows.length, ageDays: age });
    }
  }

  const known = new Set(directory.people.map((person) => person.workEmail));
  const orphans: OrphanFinding[] = [...byPerson.entries()]
    .filter(([email]) => !known.has(email))
    .map(([personEmail, held]) => ({
      personEmail,
      entitlements: held.length,
      monthlyCost: held.reduce(
        (sum, e) => sum + (toolById.get(e.toolId)?.costPerSeat ?? 0),
        0,
      ),
    }))
    .sort((a, b) => b.monthlyCost - a.monthlyCost);

  return {
    available: true,
    // A partial directory read is carried through: a scan that covered most of
    // the company must not be reported as if it covered all of it.
    detail: directory.detail,
    scannedAt,
    headcount: directory.people.length,
    dormantAfterDays,
    departures: departures.sort((a, b) => b.monthlyCost - a.monthlyCost),
    dormant: dormant.sort((a, b) => (b.idleDays ?? 0) - (a.idleDays ?? 0)),
    joiners: joiners.sort((a, b) => a.ageDays - b.ageDays),
    orphans,
  };
}

export type OffboardStep = {
  step: string;
  ok: boolean;
  detail: string;
  /**
   * True when nothing was sent to a provider because the tool has no API path.
   *
   * Without this the step is indistinguishable from a completed one: a `manual`
   * tool's revoke returns ok, and a green row saying "Revoke GitHub" would read
   * as done when the access is still live and a human has the job.
   */
  manual?: boolean;
};

/**
 * Remove one person's access.
 *
 * Explicitly triggered, one person at a time, and every step is reported
 * whether it worked or not. A partial offboarding reported as a success is the
 * failure this design exists to avoid, so the caller gets the full list rather
 * than a boolean.
 *
 * The Workspace account is *suspended*, never deleted: suspension is
 * reversible and preserves the mailbox and Drive data. Deletion stays a
 * separate, deliberately requested action.
 */
export async function offboard(input: {
  personEmail: string;
  actor: string;
  suspendAccount: boolean;
  reason?: string;
}): Promise<{ steps: OffboardStep[]; allOk: boolean }> {
  const email = input.personEmail.trim().toLowerCase();
  const reason =
    input.reason?.trim() ||
    "Offboarding: the Workspace account is no longer in use and its access was reviewed.";
  const settings = await getSettings();
  const held = await listEntitlements({ personEmail: email, status: "active" });
  const tools = new Map((await listTools(true)).map((tool) => [tool.id, tool.name]));
  const steps: OffboardStep[] = [];

  await record({
    actor: input.actor,
    action: "offboard.started",
    subject: email,
    result: "info",
    detail: `${held.length} active entitlement${held.length === 1 ? "" : "s"} to remove.`,
    personEmail: email,
  });

  for (const entitlement of held) {
    const outcome = await revokeAccess({
      entitlementId: entitlement.id,
      revokedBy: input.actor,
      reason,
    });
    steps.push({
      step: `Revoke ${tools.get(entitlement.toolId) ?? entitlement.toolId}`,
      ok: outcome.ok,
      detail: outcome.detail,
      manual: outcome.manual,
    });
  }

  if (input.suspendAccount) {
    const outcome = await workspace.suspendUser(email);
    steps.push({ step: "Suspend Workspace account", ok: outcome.ok, detail: outcome.detail });
    await record({
      actor: input.actor,
      action: outcome.ok ? "offboard.suspended" : "offboard.suspend-failed",
      subject: email,
      result: outcome.ok ? "ok" : "error",
      detail: outcome.detail,
      personEmail: email,
    });
  }

  const failed = steps.filter((step) => !step.ok).length;
  const handoffs = steps.filter((step) => step.manual).length;
  const allOk = failed === 0;

  await record({
    actor: input.actor,
    action: failed ? "offboard.partial" : handoffs ? "offboard.handoff" : "offboard.completed",
    subject: email,
    result: failed ? "error" : handoffs ? "info" : "ok",
    detail: failed
      ? `${failed} of ${steps.length} steps failed; access may remain.`
      : handoffs
        ? `${steps.length - handoffs} removed through the provider; ` +
          `${handoffs} still need doing by hand in the vendor's console, so that access is live.`
        : `${steps.length} step${steps.length === 1 ? "" : "s"} completed within the ` +
          `${settings.offboardingSlaDays}-day offboarding SLA policy.`,
    personEmail: email,
  });

  return { steps, allOk };
}
