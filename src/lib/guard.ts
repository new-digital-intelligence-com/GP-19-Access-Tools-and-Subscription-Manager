import "server-only";
import { timingSafeEqual } from "node:crypto";
import { ACTION_PASSWORD_HEADER } from "./guard-header";

/**
 * A confirmation password on the actions that change or falsify real access.
 *
 * **What this is.** A deliberate pause in front of the handful of clicks that
 * cannot be taken back: approving a grant, revoking access, offboarding
 * somebody, applying a whole review campaign's revokes, or hand-marking a row
 * revoked when nothing was actually removed. Typing a password takes a second
 * and makes the difference between a considered action and a misclick on a
 * row you thought was something else.
 *
 * **What this is not.** It is not authentication. There is no sign-in in this
 * app; one shared secret in `.env.local` cannot tell two people apart, cannot
 * be revoked for one of them, and does not appear in the audit trail — the
 * trail still attributes everything to `OPERATOR_EMAIL`. Anyone who can read
 * the env file can perform every action in it. Treat it as a seatbelt, and put
 * real authentication in front of this app before it leaves your machine.
 *
 * The check is server-side on purpose. Comparing in the browser would ship the
 * secret to every visitor and stop nothing.
 */

export { ACTION_PASSWORD_HEADER } from "./guard-header";

export class ActionPasswordError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ActionPasswordError";
    this.status = status;
  }
}

/** Length-independent comparison, so the response time leaks nothing. */
function matches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself be an
  // oracle. Compare a fixed-size digest-shaped pair instead: pad both to the
  // longer length and AND in an explicit length check.
  const size = Math.max(a.length, b.length);
  const left = Buffer.alloc(size);
  const right = Buffer.alloc(size);
  a.copy(left);
  b.copy(right);
  return timingSafeEqual(left, right) && a.length === b.length;
}

/**
 * Throw unless the request carries the right password.
 *
 * Fails **closed** when `ACTION_PASSWORD` is unset. A guard that silently
 * switches itself off is worse than no guard: the screen still shows the
 * password box, so everyone believes the pause is there when it is not.
 */
export function requireActionPassword(request: Request): void {
  const expected = process.env.ACTION_PASSWORD?.trim();

  if (!expected) {
    throw new ActionPasswordError(
      "ACTION_PASSWORD is not set, so this action is blocked. Add it to .env.local " +
        "and restart — the confirmation password is required for anything that " +
        "changes access.",
      503,
    );
  }

  const supplied = request.headers.get(ACTION_PASSWORD_HEADER) ?? "";
  if (!supplied) {
    throw new ActionPasswordError("This action needs the confirmation password.", 401);
  }
  if (!matches(supplied, expected)) {
    throw new ActionPasswordError("That confirmation password is not right.", 403);
  }
}

/** Whether the guard is usable at all, for the status screen. */
export function actionPasswordConfigured(): boolean {
  return Boolean(process.env.ACTION_PASSWORD?.trim());
}
