/**
 * The exact channels this deployment is allowed to notify.
 *
 * One Zapier account holds several MCP servers, and the same app can be
 * connected several times across them with different accounts behind each.
 * The Slack picker therefore lists every channel the connection can see, and
 * the Chat picker every space — including ones belonging to other AI Employees
 * on the same workspace. Picking the wrong one is not a visible failure:
 * approvals go out, they look fine, and they land where nobody is watching for
 * them.
 *
 * So the choice is pinned rather than merely defaulted. These are the same
 * values recorded in the skill's "exact accounts" table, and both surfaces are
 * expected to agree.
 *
 * Shared by the UI and the settings route on purpose: restricting a dropdown
 * is cosmetic, since the API is what actually stores the value.
 */

export const PINNED_SLACK_CHANNEL = "C0BUDBP7PL2";
export const PINNED_SLACK_LABEL = "ai-employee-gp-19access-tools-and-subscription-manager";

export const PINNED_CHAT_SPACE = "spaces/AAQA6gxZY40";
export const PINNED_CHAT_LABEL = "AI-Employee [GP-19] Access Tools And Subscription Manager";

/** Empty is allowed — it means "do not use this channel", not "use any". */
export function slackChannelAllowed(value: string): boolean {
  const v = value.trim();
  return v === "" || v === PINNED_SLACK_CHANNEL;
}

export function chatSpaceAllowed(value: string): boolean {
  const v = value.trim();
  return v === "" || v === PINNED_CHAT_SPACE;
}
