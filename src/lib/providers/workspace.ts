import "server-only";
import { callTool, type ToolResult } from "../zapier";

/**
 * Google Workspace Admin, reached through Zapier MCP.
 *
 * This is the only module that grants or removes access in a real system. Two
 * rules hold throughout:
 *
 * 1. Nothing here decides *whether* to act. Callers pass an approved decision;
 *    this module carries it out and reports exactly what came back.
 * 2. A failure is returned, never thrown. "Revoke failed" has to reach the
 *    audit trail and the screen — an exception that unwinds past the caller
 *    leaves the register claiming the access is gone when it is not.
 */

/** Every Zapier tool requires a natural-language hint for what to extract. */
type Hint = string;

export type ProvisionOutcome = {
  ok: boolean;
  /** Human-readable, safe to put straight into the audit trail. */
  detail: string;
  /** Present when the provider was actually called. */
  raw?: unknown;
  /** True when nothing was attempted because a human has to do it. */
  manual?: boolean;
};

function outcome(result: ToolResult, success: string): ProvisionOutcome {
  return result.ok
    ? { ok: true, detail: success, raw: result.data }
    : { ok: false, detail: result.error ?? "The provider rejected the call.", raw: result.data };
}

/** Look a Workspace account up by primary email or alias. */
export async function findUser(email: string): Promise<{
  found: boolean;
  user?: Record<string, unknown>;
  error?: string;
}> {
  const hint: Hint =
    "the user's id, primaryEmail, name, suspended flag, orgUnitPath, isAdmin and lastLoginTime";
  const result = await callTool("google_workspace_admin_find_user_by_email", {
    email_to_search_for: email,
    output_hint: hint,
  });
  if (!result.ok) return { found: false, error: result.error };
  const user = result.results[0];
  return { found: Boolean(user), user };
}

/** Account state for one address, for the person detail view. */
export type AccountState = {
  found: boolean;
  userId?: string;
  suspended?: boolean;
  archived?: boolean;
  orgUnitPath?: string;
  lastLoginTime?: string;
  isAdmin?: boolean;
};

export async function accountState(email: string): Promise<AccountState> {
  const { found, user } = await findUser(email);
  if (!found || !user) return { found: false };
  return {
    found: true,
    userId: str(user.id) ?? str(user.primaryEmail),
    suspended: user.suspended === true || user.suspended === "true",
    archived: user.archived === true || user.archived === "true",
    orgUnitPath: str(user.orgUnitPath),
    // Google reports the Unix epoch for an account that has never signed in;
    // showing "1970" reads as stale data rather than "never".
    lastLoginTime: neverUsed(str(user.lastLoginTime)) ? undefined : str(user.lastLoginTime),
    isAdmin: user.isAdmin === true || user.isAdmin === "true",
  };
}

function neverUsed(value?: string): boolean {
  if (!value) return true;
  const time = new Date(value).getTime();
  return Number.isNaN(time) || time <= 0;
}

/**
 * The Google directory id for an address, or null.
 *
 * Google Chat mentions are `<users/{id}>` against this id — an email address
 * in the message body is just text, and the person it names is never notified.
 */
export async function directoryId(email: string): Promise<string | null> {
  // The hint has to spell out "string", because Zapier writes the jq filter
  // that shapes the result from it. Asking for a "numeric id" makes it emit
  // `.id | tonumber`, and a 21-digit Google id does not survive a float64:
  // 106565216140552947902 comes back as 106565216140552950000. That still
  // looks like an id, still renders, and mentions nobody — the worst kind of
  // wrong, because nothing about it reads as broken.
  const result = await callTool("google_workspace_admin_find_user_by_email", {
    email_to_search_for: email,
    output_hint:
      "the id exactly as a string of digits, unchanged, plus primaryEmail. " +
      "Do not convert the id to a number.",
  });
  if (!result.ok) return null;

  const id = result.results[0]?.id;
  if (typeof id === "string" && /^\d+$/.test(id)) return id;

  // A number here means the precision was already lost upstream. Mentioning a
  // rounded id silently tags nobody, so decline rather than post a lie.
  return null;
}

export async function createUser(input: {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  jobTitle?: string;
  department?: string;
  managersEmail?: string;
  orgUnit?: string;
}): Promise<ProvisionOutcome> {
  const result = await callTool("google_workspace_admin_create_user", {
    email: input.email,
    first_name: input.firstName,
    last_name: input.lastName,
    password: input.password,
    job_title: input.jobTitle,
    department: input.department,
    managers_email: input.managersEmail,
    organizational_unit: input.orgUnit,
    change_password_at_next_login: "true",
    output_hint: "the created user's id and primaryEmail",
  });
  return outcome(result, `Created Workspace account ${input.email}.`);
}

/**
 * Suspend, not delete.
 *
 * Suspension is reversible and keeps the mailbox and Drive data intact, which
 * is what an offboarding actually needs on day one. Deletion is a separate,
 * explicitly requested action.
 */
export async function suspendUser(email: string): Promise<ProvisionOutcome> {
  const result = await callTool("google_workspace_admin_suspend_user", {
    user_id: email,
    output_hint: "the suspended user's primaryEmail and suspended flag",
  });
  return outcome(result, `Suspended Workspace account ${email}.`);
}

export async function deleteUser(email: string): Promise<ProvisionOutcome> {
  const result = await callTool("google_workspace_admin_delete_user", {
    user_id: email,
    output_hint: "confirmation that the user was deleted",
  });
  return outcome(result, `Deleted Workspace account ${email}. This cannot be undone.`);
}

export async function addToGroup(
  email: string,
  groupEmail: string,
  role = "MEMBER",
): Promise<ProvisionOutcome> {
  const result = await callTool("google_workspace_admin_add_user_to_group", {
    email,
    group_id: groupEmail,
    role,
    output_hint: "the membership id, group email and member role",
  });
  return outcome(result, `Added ${email} to ${groupEmail}.`);
}

export async function removeFromGroup(
  email: string,
  groupEmail: string,
): Promise<ProvisionOutcome> {
  const result = await callTool("google_workspace_admin_remove_user_from_group", {
    email,
    group_id: groupEmail,
    output_hint: "confirmation that the membership was removed",
  });
  return outcome(result, `Removed ${email} from ${groupEmail}.`);
}

export async function assignLicense(
  email: string,
  productId: string,
  skuId: string,
): Promise<ProvisionOutcome> {
  const result = await callTool("google_workspace_admin_assign_license", {
    userId: email,
    productId,
    skuId,
    output_hint: "the assigned licence's productId, skuId and userId",
  });
  return outcome(result, `Assigned licence ${skuId} to ${email}.`);
}

export async function revokeLicense(
  email: string,
  productId: string,
  skuId: string,
): Promise<ProvisionOutcome> {
  const result = await callTool("google_workspace_admin_revoke_license", {
    userId: email,
    productId,
    skuId,
    output_hint: "confirmation that the licence was revoked",
  });
  return outcome(result, `Revoked licence ${skuId} from ${email}.`);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : typeof value === "number" ? String(value) : undefined;
}
