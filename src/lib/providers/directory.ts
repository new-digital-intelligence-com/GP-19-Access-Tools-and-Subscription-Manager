import "server-only";
import { callTool } from "../zapier";
import type { Person } from "../types";

/**
 * The Google Workspace directory — the app's source of truth for people.
 *
 * There is no HR system wired in, and that changes what this module is allowed
 * to claim. Workspace knows about *accounts*, not employment: it can tell you
 * an account was suspended, or that nobody has signed in for four months, but
 * it cannot tell you someone left the company. Those are strong signals worth
 * acting on and weak evidence of employment status, so everything here is
 * named as a signal and the UI is expected to present it as one.
 *
 * A directory outage is a *state*, not an error to work around. Callers get
 * `{ available: false }` and must say so rather than presenting an empty
 * directory as "no employees".
 */

export type Directory = {
  available: boolean;
  people: Person[];
  detail?: string;
};

/**
 * The whole directory in one call.
 *
 * `projection=full` is what carries job title, department and the manager
 * relation; the default projection omits all three, and a directory with no
 * departments is close to useless for deciding who owns what. 500 is the
 * endpoint's maximum page size.
 */
export async function directory(maxPages = 4): Promise<Directory> {
  const people: Person[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    // `querystring` is typed as a record, not a string — passing an encoded
    // query returns "expected record, received string" and no rows.
    const result = await callTool("google_workspace_admin_make_api_get_request", {
      url: "https://admin.googleapis.com/admin/directory/v1/users",
      querystring: {
        customer: "my_customer",
        maxResults: "500",
        projection: "full",
        orderBy: "email",
        ...(pageToken ? { pageToken } : {}),
      },
      output_hint:
        "for every user: id, primaryEmail, name, suspended, suspensionReason, archived, " +
        "creationTime, lastLoginTime, orgUnitPath, isAdmin, organizations and relations",
    });

    if (!result.ok) {
      return {
        available: false,
        people: [],
        detail: result.error ?? "The Workspace directory could not be read.",
      };
    }

    const { users, next } = unwrap(result.data, result.results);
    people.push(...users.map(toPerson).filter((person) => person.workEmail));

    if (!next) return { available: true, people };
    pageToken = next;
  }

  // Stopping silently at the page cap would understate the directory, and an
  // access review over "most of the company" is not an access review.
  return {
    available: true,
    people,
    detail:
      `Stopped after ${maxPages} pages (${people.length} accounts). The directory is ` +
      "larger than this scan covered, so anyone past that point was not checked.",
  };
}

/** One account by primary email or alias. Cheaper than the whole directory. */
export async function findPerson(
  email: string,
): Promise<{ available: boolean; person?: Person; detail?: string }> {
  const result = await callTool("google_workspace_admin_find_user_by_email", {
    email_to_search_for: email,
    output_hint:
      "the user's id, primaryEmail, name, suspended, archived, orgUnitPath, isAdmin, " +
      "creationTime, lastLoginTime, organizations and relations",
  });
  if (!result.ok) return { available: false, detail: result.error };
  const row = result.results[0];
  return { available: true, person: row ? toPerson(row) : undefined };
}

/** Groups an account belongs to — the grant mechanism for most tools here. */
export async function groupsFor(
  email: string,
): Promise<{ available: boolean; groups: { email: string; name?: string }[]; detail?: string }> {
  const result = await callTool("google_workspace_admin_make_api_get_request", {
    url: "https://admin.googleapis.com/admin/directory/v1/groups",
    querystring: { userKey: email },
    output_hint: "each group's email and name",
  });
  if (!result.ok) return { available: false, groups: [], detail: result.error };

  const payload = (result.data ?? {}) as Record<string, unknown>;
  const rows = pickArray(payload, result.results, ["groups"]);
  return {
    available: true,
    groups: rows
      .map((row) => ({ email: (str(row.email) ?? "").toLowerCase(), name: str(row.name) }))
      .filter((group) => group.email),
  };
}

/**
 * Zapier hands back the API's JSON in one of several shapes depending on how
 * the action wrapped it, so the users array is looked for rather than assumed.
 */
function unwrap(
  data: unknown,
  results: Record<string, unknown>[],
): { users: Record<string, unknown>[]; next?: string } {
  const payload = (data ?? {}) as Record<string, unknown>;

  // Zapier sometimes returns the whole API response as results[0].
  const first = results[0] as Record<string, unknown> | undefined;
  if (first && Array.isArray(first.users)) {
    return { users: first.users as Record<string, unknown>[], next: str(first.nextPageToken) };
  }
  if (Array.isArray(payload.users)) {
    return {
      users: payload.users as Record<string, unknown>[],
      next: str(payload.nextPageToken),
    };
  }
  // Otherwise the rows themselves are the users.
  return { users: results, next: str(payload.nextPageToken) };
}

function pickArray(
  payload: Record<string, unknown>,
  results: Record<string, unknown>[],
  keys: string[],
): Record<string, unknown>[] {
  for (const key of keys) {
    const value = payload[key] ?? (results[0] as Record<string, unknown> | undefined)?.[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return results;
}

function toPerson(row: Record<string, unknown>): Person {
  const name = (row.name ?? {}) as Record<string, unknown>;
  const orgs = Array.isArray(row.organizations)
    ? (row.organizations as Record<string, unknown>[])
    : [];
  const relations = Array.isArray(row.relations)
    ? (row.relations as Record<string, unknown>[])
    : [];
  const manager = relations.find(
    (relation) => str(relation.type)?.toLowerCase() === "manager",
  );

  const suspended = truthy(row.suspended);
  const archived = truthy(row.archived);
  const workEmail = (str(row.primaryEmail) ?? "").toLowerCase();

  return {
    id: str(row.id) ?? workEmail,
    workEmail,
    displayName:
      str(name.fullName) ??
      `${str(name.givenName) ?? ""} ${str(name.familyName) ?? ""}`.trim() ??
      workEmail,
    jobTitle: str(orgs[0]?.title),
    department: str(orgs[0]?.department) ?? str(row.orgUnitPath),
    managerEmail: str(manager?.value)?.toLowerCase(),
    orgUnitPath: str(row.orgUnitPath),
    isAdmin: truthy(row.isAdmin),
    accountState: archived ? "archived" : suspended ? "suspended" : "active",
    suspensionReason: str(row.suspensionReason),
    createdAt: str(row.creationTime),
    // Google returns the Unix epoch for an account that has never signed in.
    // Passing that through would render as "1970" and read like stale data
    // rather than "never", so it is dropped instead.
    lastLoginAt: neverLoggedIn(str(row.lastLoginTime)) ? undefined : str(row.lastLoginTime),
    syncedAt: new Date().toISOString(),
  };
}

function neverLoggedIn(value?: string): boolean {
  if (!value) return true;
  const time = new Date(value).getTime();
  return Number.isNaN(time) || time <= 0;
}

/**
 * An account no longer in use, as far as Workspace can tell.
 *
 * Suspended or archived. This is a signal, not a termination: an account is
 * also suspended for a security hold, a long leave of absence, or a mistake.
 * Callers must present it as "worth reviewing", never as "this person left".
 */
export function looksDeparted(person: Person): boolean {
  return person.accountState !== "active";
}

/** Active accounts nobody has signed into for `days`. Never-logged-in counts. */
export function looksDormant(person: Person, days: number, asOf = new Date()): boolean {
  if (person.accountState !== "active") return false;
  if (!person.lastLoginAt) {
    // Never signed in, but only interesting once the account has had time to
    // be used — a two-day-old account with no login is a joiner, not a risk.
    if (!person.createdAt) return false;
    return asOf.getTime() - new Date(person.createdAt).getTime() > days * 86_400_000;
  }
  return asOf.getTime() - new Date(person.lastLoginAt).getTime() > days * 86_400_000;
}

function truthy(value: unknown): boolean {
  return value === true || value === "true";
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}
