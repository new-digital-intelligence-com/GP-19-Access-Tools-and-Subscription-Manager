import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Single source of truth for how access is handled.
 *
 * The plugin's skill is the contract. Rather than restating those rules in a
 * second prompt that can drift, the app reads the same file the
 * `gp-19-access-manager` skill loads, so a rule changed once applies to Claude Code,
 * the Claude app and this app's own agent alike.
 */
const RULES_PATH = path.join(
  process.cwd(),
  "plugins/gp-19-access-manager/skills/gp-19-access-manager/references/rules.md",
);

let cached: string | null = null;

/** Strip frontmatter and the heading; keep the rules themselves. */
function normalize(markdown: string) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

/**
 * The invariants that survive without the plugin directory.
 *
 * A deploy that ships only `src/` must not quietly lose the approval rule —
 * that is the one thing this app cannot be wrong about — so the fallback
 * carries it verbatim rather than degrading to something vaguer.
 */
const FALLBACK = [
  "Nothing is provisioned without an approval decision recorded against a named human.",
  "You never approve. You prepare a request and present it; a person decides.",
  "A request cannot be approved by the person who raised it.",
  "Report only what the provider returned. Never state that access was granted or",
  "removed unless the call came back successful — a failed revoke is not a revoke.",
  "Google Workspace knows about accounts, not employment. A suspended account, a",
  "dormant one, or a register row with no account behind it is a signal worth",
  "reviewing — never proof that a person left the company. Say signal, not fact.",
  "Suspend rather than delete an account unless deletion was explicitly asked for.",
  "Every access change — success or failure — is written to the audit trail.",
  "An unreachable provider is a state to report, never an empty result to present as a finding.",
].join("\n");

export async function accessRules(): Promise<string> {
  if (cached) return cached;
  try {
    cached = normalize(await readFile(RULES_PATH, "utf8"));
  } catch {
    cached = FALLBACK;
  }
  return cached;
}
