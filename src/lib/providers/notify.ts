import "server-only";
import { callTool } from "../zapier";
import * as slack from "./slack";
import * as workspace from "./workspace";
import { getSettings } from "../settings";

/**
 * Notification out — Gmail, Google Chat and Slack.
 *
 * An approval nobody was told about is a request that sits pending until it
 * expires, so delivery is reported honestly: `sent` is per channel, and a
 * channel that is switched off is reported as skipped rather than silently
 * dropped.
 *
 * Never throws. A notification failure must not roll back a decision that has
 * already been made and recorded.
 */

/** The display name on outgoing mail. The address comes from the connection. */
const SENDER_NAME = "GP-19 Access Manager";

export type Delivery = {
  channel: "email" | "chat" | "slack";
  sent: boolean;
  detail: string;
  at: string;
};

/**
 * Gmail takes recipients as an **array of strings**, not a comma-separated
 * one. Passing a string is rejected before the send even runs, with
 * `expected array, received string` — a schema error, not a delivery failure,
 * so nothing reaches the approver and nothing in Gmail explains why.
 */
function recipients(value?: string): string[] | undefined {
  const list = (value ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  html?: boolean;
}): Promise<Delivery> {
  const at = new Date().toISOString();
  const to = recipients(input.to);
  if (!to) {
    return { channel: "email", sent: false, detail: "No recipient address.", at };
  }
  const result = await callTool("gmail_send_email", {
    to,
    cc: recipients(input.cc),
    subject: input.subject,
    body: input.body,
    body_type: input.html ? "html" : "plain",
    // Without this the mail arrives from a bare address with no display name.
    // An approval request is a thing somebody has to act on, and it should be
    // obvious at a glance in an inbox what sent it — the address alone reads
    // like a mailing-list bounce. The account itself is whichever Google
    // account is connected upstream; only the label is set here.
    from_name: SENDER_NAME,
    output_hint: "the sent message id and thread id",
  });
  return {
    channel: "email",
    sent: result.ok,
    detail: result.ok ? `Emailed ${input.to}.` : (result.error ?? "Gmail rejected the send."),
    at,
  };
}

export async function sendChat(input: {
  text: string;
  title?: string;
  subtitle?: string;
  buttonText?: string;
  buttonUrl?: string;
  room?: string;
  /** Work email of the approver; mentioned in the space if they resolve. */
  to?: string;
}): Promise<Delivery> {
  const at = new Date().toISOString();
  const settings = await getSettings();
  const room = input.room ?? settings.chatRoom;
  if (!room) {
    return {
      channel: "chat",
      sent: false,
      detail: "No Google Chat space is configured in Settings.",
      at,
    };
  }

  // The picker stores an id; a human typing into the empty-picker fallback
  // naturally types the space's *name*. Chat only accepts the id, and sending
  // a name comes back as an opaque 500 from Zapier's bot service that reads
  // like an outage. Refuse it here, where the reason can be stated.
  if (/\s/.test(room) || /[[\]]/.test(room)) {
    return {
      channel: "chat",
      sent: false,
      detail:
        `"${room}" looks like a space name, not a space id. Google Chat needs the id ` +
        "(it looks like `spaces/AAAA…`). Pick the space from the list in Settings — and if " +
        "the list is empty, the Zapier app is not a member of the space yet: open the space, " +
        "then Apps & integrations, and add it.",
      at,
    };
  }
  // Chat mentions are `<users/{directory id}>`. An email in the body is plain
  // text: it reads like a mention and notifies nobody, which is the worst of
  // both — it looks handled and no one was told.
  const id = input.to ? await workspace.directoryId(input.to).catch(() => null) : null;
  const text = id ? `<users/${id}> ${input.text}` : input.text;

  const result = await callTool("google_chat_create_message", {
    room,
    text,
    title: input.title,
    subtitle: input.subtitle,
    // Chat rejects a button with no target, so both go or neither does.
    buttonText: input.buttonUrl ? input.buttonText : undefined,
    buttonUrl: input.buttonUrl,
    output_hint: "the created message name and thread",
  });
  // Zapier posts Chat through its own bot service, and that service answers
  // 500 when the Zapier app is not a member of the target space. The space
  // existing is not enough — somebody has to add the app to it — and the raw
  // "Got 500 calling POST .../notify" says nothing a reader can act on.
  const failedThroughBot =
    !result.ok && /\b500\b/.test(result.error ?? "") && /zapier-bot/.test(result.error ?? "");

  return {
    channel: "chat",
    sent: result.ok,
    detail: result.ok
      ? id
        ? `Posted to ${room} and mentioned ${input.to}.`
        : `Posted to ${room}.${input.to ? ` ${input.to} has no directory entry, so nobody was mentioned.` : ""}`
      : failedThroughBot
        ? `Google Chat refused the post to ${room}. The usual cause is that the Zapier app is ` +
          "not a member of that space — open the space, then Apps & integrations, and add it. " +
          `Underlying error: ${result.error}`
        : (result.error ?? "Google Chat rejected the message."),
    at,
  };
}

/**
 * Slack.
 *
 * A configured channel wins over a DM, and the approver is **mentioned** in
 * it. The mention is what makes that safe: a bare approval in a shared channel
 * is everybody's job and therefore nobody's, but `<@U…>` puts it on one named
 * person's unread list while the rest of the team can still see the queue
 * exists. With no channel set it falls back to a DM.
 *
 * Only the channel post can carry a sender name — `slack_send_direct_message`
 * has no `username` field — so a DM shows as the connected app regardless.
 */
export async function sendSlack(input: {
  to?: string;
  text: string;
}): Promise<Delivery> {
  const at = new Date().toISOString();
  const settings = await getSettings();

  // Resolved first either way: it is the mention in a channel, and the
  // recipient of a DM.
  const found = input.to ? await slack.findUserByEmail(input.to) : null;
  const userId = found?.user?.id;

  if (settings.slackChannel) {
    const posted = await slack.postToChannel({
      channel: settings.slackChannel,
      text: input.text,
      mentionUserId: userId,
    });
    return {
      channel: "slack",
      sent: posted.ok,
      detail: posted.ok
        ? userId
          ? `${posted.detail} ${input.to} was mentioned.`
          : // Worth saying out loud: the post went up, but the person it is
            // for was not tagged and may never look at that channel.
            `${posted.detail} ${input.to ?? "The approver"} has no Slack account, so nobody was mentioned.`
        : posted.detail,
      at,
    };
  }

  if (!input.to) {
    return {
      channel: "slack",
      sent: false,
      detail: "No Slack channel is configured and there is no approver to message.",
      at,
    };
  }

  const direct = await slack.dm({ email: input.to, text: input.text });
  return {
    channel: "slack",
    sent: direct.ok,
    detail: direct.ok
      ? direct.detail
      : `${direct.detail} Set a Slack channel in Settings so approvals still land somewhere.`,
    at,
  };
}

/**
 * Try one channel without letting it take the others down.
 *
 * `callTool` returns tool-level failures but *throws* on a transport or
 * protocol fault, and the three senders used to run in one unguarded chain.
 * One Slack hiccup therefore rejected the whole call, the caller's
 * `.catch(() => [])` discarded every row, and a request whose email had
 * already gone out was recorded as "nobody was told" — the app stating the
 * opposite of what happened, which is the one thing it must never do.
 */
async function attempt(
  channel: Delivery["channel"],
  send: () => Promise<Delivery>,
): Promise<Delivery> {
  try {
    return await send();
  } catch (error) {
    return {
      channel,
      sent: false,
      detail: error instanceof Error ? error.message : `${channel} failed unexpectedly.`,
      at: new Date().toISOString(),
    };
  }
}

/**
 * Send on whichever channels Settings has enabled.
 *
 * Returns one row per attempt, successful or not. A failed row is the point:
 * it is what the request card reads to say "this channel did not deliver"
 * instead of silently implying the approver was reached.
 */
export async function announce(input: {
  to?: string;
  subject: string;
  body: string;
  chatTitle?: string;
  buttonText?: string;
  buttonUrl?: string;
}): Promise<Delivery[]> {
  const settings = await getSettings();
  const deliveries: Delivery[] = [];

  if (settings.notify.email && input.to) {
    deliveries.push(
      await attempt("email", () =>
        sendEmail({ to: input.to as string, subject: input.subject, body: input.body }),
      ),
    );
  }
  if (settings.notify.chat) {
    deliveries.push(
      await attempt("chat", () =>
        sendChat({
          // Chat has no `username` field, so the app always posts as the
          // Zapier app. The card title is the only place the sending system
          // can be named, so it carries the same name Slack posts under.
          title: slack.BOT_NAME,
          subtitle: input.chatTitle ?? input.subject,
          text: input.body,
          buttonText: input.buttonText,
          buttonUrl: input.buttonUrl,
          to: input.to,
        }),
      ),
    );
  }
  if (settings.notify.slack) {
    deliveries.push(
      await attempt("slack", () =>
        sendSlack({
          to: input.to,
          // Slack has no subject line, so it has to lead the message or the
          // reader sees a wall of body text with no idea what it is about.
          text: [
            `*${input.subject}*`,
            input.body,
            input.buttonUrl ? `<${input.buttonUrl}|${input.buttonText ?? "Open"}>` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        }),
      ),
    );
  }
  return deliveries;
}

/** Available Google Chat spaces, for the Settings picker. */
export async function chatRooms(): Promise<{ value: string; label: string }[]> {
  const result = await callTool("list_dynamic_enum_values", {
    tool_name: "google_chat_create_message",
    property_name: "room",
  });
  const payload = (result.data ?? {}) as { values?: { value?: string; label?: string }[] };
  return (payload.values ?? [])
    .map((row) => ({ value: String(row.value ?? ""), label: String(row.label ?? row.value ?? "") }))
    .filter((row) => row.value);
}

/** Slack channels the connection can see, for the Settings picker. */
export async function slackChannels(): Promise<{ value: string; label: string }[]> {
  return slack.channels();
}
