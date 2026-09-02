/**
 * The header the confirmation password travels in.
 *
 * Kept apart from `guard.ts` because that file is `server-only` and pulls in
 * `node:crypto`; a client component importing it would break the build. This
 * module is a single string so both sides can agree on it without either
 * reaching into the other's runtime.
 *
 * A header, not a query parameter — URLs end up in server logs and browser
 * history, and a password in either is a password on disk.
 */
export const ACTION_PASSWORD_HEADER = "x-action-password";
