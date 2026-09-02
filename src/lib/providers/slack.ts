import "server-only";
import { callTool } from "../zapier";

/**
 * Slack, in two unrelated roles.
 *
 * **A notification channel.** Approvals reach a person faster in a DM than in
 * an inbox, and unlike Google Chat — which has no space shared with the
 * connection — Slack answers today.
 *
 * **A thing people have access to.** A private channel is an access surface
 * like any other: it holds decisions and customer detail, and nobody ever
 * leaves one. Channel membership is therefore a provisioning method, so a
 * channel can be requested, approved, reviewed and revoked exactly like a
 * Figma seat.
 *
 * Nothing here throws. A failed notification must not roll back a decision
 * that has already been recorded, and a failed grant has to reach the audit
 * trail as a result rather than unwind past its caller.
 */

export type SlackUser = { id: string; name?: string; email?: string };

/**
 * Resolve an email to a Slack user id.
 *
 * Every write below needs an id, and an email is the only handle this app
 * holds — the register keys on work email, and Slack keys on `U…`.
 */
export async function findUserByEmail(
  email: string,
): Promise<{ ok: boolean; user?: SlackUser; error?: string }> {
  const result = await callTool("slack_find_user_by_email", {
    email,
    output_hint: "the user's id, real name, display name and email",
  });
  if (!result.ok) return { ok: false, error: result.error };

  const row = result.results[0];
  // Slack's lookup returns `user_id`; the raw API and most other Zapier Slack
  // actions use `id`. Reading only one of them reports a real account as
  // missing, and the caller then says so to the operator.
  const id = str(row?.user_id) ?? str(row?.id);
  if (!id) return { ok: true };
  return {
    ok: true,
    user: {
      id,
      name: str(row?.real_name) ?? str(row?.name),
      email: str(row?.email) ?? email,
    },
  };
}

/** Direct-message one person, resolving their id from their email first. */
export async function dm(input: {
  email: string;
  text: string;
}): Promise<{ ok: boolean; detail: string }> {
  const found = await findUserByEmail(input.email);
  if (!found.ok) {
    return { ok: false, detail: found.error ?? "Slack could not be reached." };
  }
  if (!found.user) {
    // Not an error worth failing on: plenty of approvers have no Slack account,
    // and the caller still has email. Say which, so the gap is visible.
    return { ok: false, detail: `No Slack account matches ${input.email}.` };
  }

  const result = await callTool("slack_send_direct_message", {
    channel: found.user.id,
    text: input.text,
    // Booleans, not "yes"/"no". A string is rejected by schema validation
    // before the message is sent, so the failure looks like a delivery
    // problem when it is really a type error.
    as_bot: true,
    output_hint: "the sent message timestamp and channel",
  });
  return {
    ok: result.ok,
    detail: result.ok
      ? `Messaged ${found.user.name ?? input.email} on Slack.`
      : (result.error ?? "Slack rejected the message."),
  };
}

/**
 * The name a channel post appears under.
 *
 * Only channel messages can carry it — `slack_send_direct_message` has no
 * `username` field at all, so a DM always shows as the connected Zapier app
 * whatever this says.
 */
export const BOT_NAME = "Tools And Subscription Manager";

/** `<@U…>` is a real mention that notifies; an @name in plain text is not. */
export function mention(userId: string): string {
  return `<@${userId}>`;
}

export async function postToChannel(input: {
  channel: string;
  text: string;
  /** Slack id of the person this is for; prefixed as a real mention. */
  mentionUserId?: string;
}): Promise<{ ok: boolean; detail: string }> {
  const text = input.mentionUserId
    ? `${mention(input.mentionUserId)} ${input.text}`
    : input.text;

  const result = await callTool("slack_send_channel_message", {
    channel: input.channel,
    text,
    as_bot: true,
    username: BOT_NAME,
    // Slack only turns `<@U…>` into a notifying mention when this is on.
    link_names: true,
    // Without this the send fails on any channel the connection has not been
    // added to, which is most of them, and reads as a permissions mystery.
    add_app_to_channel: true,
    output_hint: "the sent message timestamp and channel",
  });
  return {
    ok: result.ok,
    detail: result.ok
      ? `Posted to ${input.channel}.`
      : (result.error ?? "Slack rejected the message."),
  };
}

/** Channels the connection can see, for the catalogue and settings pickers. */
export async function channels(): Promise<{ value: string; label: string }[]> {
  const out: { value: string; label: string }[] = [];
  let cursor: string | undefined;

  // The enum pages, and a truncated channel list in a picker silently hides
  // the one someone is looking for.
  for (let page = 0; page < 5; page++) {
    const result = await callTool("list_dynamic_enum_values", {
      tool_name: "slack_send_channel_message",
      property_name: "channel",
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok) break;
    const payload = (result.data ?? {}) as {
      values?: { value?: string; label?: string }[];
      next_cursor?: string;
    };
    for (const row of payload.values ?? []) {
      const value = String(row.value ?? "");
      if (value) out.push({ value, label: String(row.label ?? value) });
    }
    if (!payload.next_cursor) break;
    cursor = payload.next_cursor;
  }
  return out;
}

/**
 * Add someone to a channel.
 *
 * Note the argument names against `removeFromChannel` below: invite takes
 * `users` and `channel`, remove takes `userId` and `channelId`. They are not
 * symmetrical, and passing one shape to the other fails with a schema error
 * rather than doing nothing visible.
 */
export async function inviteToChannel(
  email: string,
  channelId: string,
): Promise<{ ok: boolean; detail: string }> {
  const found = await findUserByEmail(email);
  if (!found.ok) return { ok: false, detail: found.error ?? "Slack could not be reached." };
  if (!found.user) {
    return {
      ok: false,
      detail: `No Slack account matches ${email}, so there is nobody to add to the channel.`,
    };
  }

  const result = await callTool("slack_invite_user_to_channel", {
    // An array, unlike `slack_remove_user_from_channel`'s single `userId`.
    users: [found.user.id],
    channel: channelId,
    output_hint: "the channel id and the members added",
  });
  return {
    ok: result.ok,
    detail: result.ok
      ? `Added ${email} to Slack channel ${channelId}.`
      : (result.error ?? "Slack refused the invite."),
  };
}

export async function removeFromChannel(
  email: string,
  channelId: string,
): Promise<{ ok: boolean; detail: string }> {
  const found = await findUserByEmail(email);
  if (!found.ok) return { ok: false, detail: found.error ?? "Slack could not be reached." };
  if (!found.user) {
    // No account means nothing to remove. Reported as done rather than failed:
    // the desired end state — this person is not in the channel — is true.
    return { ok: true, detail: `No Slack account matches ${email}; nothing to remove.` };
  }

  const result = await callTool("slack_remove_user_from_channel", {
    userId: found.user.id,
    channelId,
    output_hint: "confirmation that the member was removed",
  });
  return {
    ok: result.ok,
    detail: result.ok
      ? `Removed ${email} from Slack channel ${channelId}.`
      : (result.error ?? "Slack refused the removal."),
  };
}

/** Who is actually in a channel — for reconciling the register against Slack. */
export async function channelMembers(
  channelId: string,
): Promise<{ ok: boolean; memberIds: string[]; error?: string }> {
  const result = await callTool("slack_get_conversation_members", {
    channel: channelId,
    output_hint: "the user id of every member",
  });
  if (!result.ok) return { ok: false, memberIds: [], error: result.error };
  return {
    ok: true,
    memberIds: result.results
      .map((row) => str(row.id) ?? str(row.user) ?? str(row.member))
      .filter((id): id is string => Boolean(id)),
  };
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}
