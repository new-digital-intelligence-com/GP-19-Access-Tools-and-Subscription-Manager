import "server-only";
import { readStore, writeStore } from "./store";
import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  domain: process.env.WORKSPACE_DOMAIN ?? "",
  approvers: [],
  defaultReviewCadenceDays: 90,
  notify: { email: true, chat: true, slack: true },
  chatRoom: "",
  slackChannel: "",
  currency: "USD",
  registerSheetId: "",
  offboardingSlaDays: 1,
  voice:
    "Plain, specific and short. Name the person, the tool and the date. No filler, " +
    "no apologising, no hedging about what was or was not done.",
};

export async function getSettings(): Promise<Settings> {
  const stored = await readStore<Partial<Settings>>("settings", {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    notify: { ...DEFAULT_SETTINGS.notify, ...(stored.notify ?? {}) },
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await writeStore("settings", next);
  return next;
}

/**
 * Who this app acts as.
 *
 * There is no sign-in yet, so every audit entry and every approval decision is
 * attributed to one configured address. It is read from the environment rather
 * than defaulted, because an audit trail attributed to "system" cannot answer
 * the only question anyone asks of it: who approved this.
 */
export const UNATTRIBUTED = "unattributed@localhost";

export function operator(): string {
  return process.env.OPERATOR_EMAIL?.trim().toLowerCase() || UNATTRIBUTED;
}

/** True when the operator address is a real one rather than the placeholder. */
export function operatorConfigured(): boolean {
  return Boolean(process.env.OPERATOR_EMAIL?.trim());
}

/**
 * Whether an address sits outside the organisation's own domain.
 *
 * A **warning**, never a block. Real organisations have real people on other
 * domains — contractors, an acquired team, a second brand — and refusing them
 * outright would mean the app is wrong about a person the operator can see is
 * legitimate. What it must not do is let a typo'd or unfamiliar address slide
 * past an approver unremarked, because the address is the one field nobody
 * re-reads and the one that decides who actually receives the access.
 *
 * Returns null when no domain is configured: an unset domain means "we do not
 * know what normal looks like here", which is not the same as "this is fine".
 */
export function outsideDomain(email: string, settings: Settings): string | null {
  const domain = settings.domain.trim().toLowerCase().replace(/^@/, "");
  if (!domain) return null;

  const at = email.lastIndexOf("@");
  if (at < 0) return `${email} is not an email address.`;

  const theirs = email.slice(at + 1).trim().toLowerCase();
  // A subdomain of the primary domain is still the organisation.
  if (theirs === domain || theirs.endsWith(`.${domain}`)) return null;

  return `${email} is outside ${domain}.`;
}

/** The tone block appended to every drafting prompt. */
export function voicePrompt(settings: Settings): string {
  return [
    `House style: ${settings.voice}`,
    settings.domain && `Workspace domain: ${settings.domain}`,
    settings.currency && `Costs are in ${settings.currency}.`,
  ]
    .filter(Boolean)
    .join("\n");
}
