import { NextResponse } from "next/server";
import { record } from "@/lib/audit";
import { chatRooms, slackChannels } from "@/lib/providers/notify";
import { getSettings, operator, saveSettings } from "@/lib/settings";
import type { Settings } from "@/lib/types";
import {
  PINNED_CHAT_LABEL,
  PINNED_CHAT_SPACE,
  PINNED_SLACK_LABEL,
  chatSpaceAllowed,
  slackChannelAllowed,
} from "@/lib/pinned";

export const runtime = "nodejs";

/**
 * Settings are governance, not preferences: the approver list decides who is
 * allowed to release access, and the cadence decides how long a stale grant
 * can sit unnoticed. So writes are validated rather than merged blind, and
 * every change is written to the audit trail.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET() {
  try {
    const settings = await getSettings();
    // Best effort: the room picker is a convenience, and Zapier being down is
    // no reason to refuse to show the settings that are stored locally.
    const [rooms, channels] = await Promise.all([
      chatRooms().catch(() => []),
      slackChannels().catch(() => []),
    ]);
    return NextResponse.json({ settings, chatRooms: rooms, slackChannels: channels });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Settings could not be read." },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("The request body must be JSON.");
  }

  const current = await getSettings();
  const patch: Partial<Settings> = {};

  if ("approvers" in body) {
    if (!Array.isArray(body.approvers)) {
      return bad("approvers must be an array of email addresses.");
    }
    const approvers: string[] = [];
    for (const entry of body.approvers) {
      if (typeof entry !== "string") {
        return bad("Every approver must be an email address written as a string.");
      }
      const email = entry.trim().toLowerCase();
      if (!email) continue;
      if (!EMAIL.test(email)) {
        return bad(
          `"${entry}" is not a valid email address. An approval has to reach a real person, ` +
            "so the address is checked before it is saved.",
        );
      }
      if (!approvers.includes(email)) approvers.push(email);
    }
    patch.approvers = approvers;
  }

  if ("defaultReviewCadenceDays" in body) {
    const value = Number(body.defaultReviewCadenceDays);
    if (!Number.isFinite(value) || value < 0) {
      return bad("defaultReviewCadenceDays must be a number of days, zero or more.");
    }
    patch.defaultReviewCadenceDays = value;
  }

  if ("offboardingSlaDays" in body) {
    const value = Number(body.offboardingSlaDays);
    if (!Number.isFinite(value) || value < 0) {
      return bad("offboardingSlaDays must be a number of days, zero or more.");
    }
    patch.offboardingSlaDays = value;
  }

  if ("domain" in body) patch.domain = text(body.domain).toLowerCase();
  if ("voice" in body) patch.voice = text(body.voice) || current.voice;
  if ("currency" in body) patch.currency = text(body.currency) || current.currency;

  // Pinned, not merely defaulted. Restricting the dropdown is cosmetic — this
  // route is what stores the value, and an approval posted to another team's
  // channel is not a visible failure: it goes out, it looks fine, and nobody
  // who needed to see it does.
  if ("chatRoom" in body) {
    const room = text(body.chatRoom);
    if (!chatSpaceAllowed(room)) {
      return bad(
        `This deployment posts to "${PINNED_CHAT_LABEL}" (${PINNED_CHAT_SPACE}) and no other ` +
          "space. Send that value, or an empty string to switch Google Chat off.",
      );
    }
    patch.chatRoom = room;
  }

  if ("slackChannel" in body) {
    const channel = text(body.slackChannel);
    if (!slackChannelAllowed(channel)) {
      return bad(
        `This deployment posts to #${PINNED_SLACK_LABEL} and no other channel. Send that ` +
          "channel id, or an empty string to direct-message the approver instead.",
      );
    }
    patch.slackChannel = channel;
  }

  if ("registerSheetId" in body) {
    // A pasted URL is the obvious mistake; keep the id out of it.
    const raw = text(body.registerSheetId);
    patch.registerSheetId =
      /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(raw)?.[1] ?? raw;
  }

  if ("notify" in body) {
    if (typeof body.notify !== "object" || body.notify === null || Array.isArray(body.notify)) {
      return bad("notify must be an object with email, chat and slack flags.");
    }
    const notify = body.notify as Record<string, unknown>;
    // Merged against the stored value: `saveSettings` replaces the whole
    // object, so a patch carrying only one channel would switch off the other.
    patch.notify = {
      email: typeof notify.email === "boolean" ? notify.email : current.notify.email,
      chat: typeof notify.chat === "boolean" ? notify.chat : current.notify.chat,
      slack: typeof notify.slack === "boolean" ? notify.slack : current.notify.slack,
    };
  }

  const changed = Object.keys(patch);
  if (changed.length === 0) {
    return NextResponse.json({ settings: current });
  }

  try {
    const settings = await saveSettings(patch);
    await record({
      actor: operator(),
      action: "settings.updated",
      subject: "settings",
      result: "info",
      detail: `Changed ${changed.join(", ")}. Approvers are now: ${
        settings.approvers.length ? settings.approvers.join(", ") : "none configured"
      }.`,
    });
    return NextResponse.json({ settings });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Settings could not be saved." },
      { status: 500 },
    );
  }
}
