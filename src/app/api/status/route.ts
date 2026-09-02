import { NextResponse } from "next/server";
import { checkApiKey } from "@/lib/anthropic";
import { actionPasswordConfigured } from "@/lib/guard";
import { listTools } from "@/lib/catalog";
import { expiredGrants, listEntitlements, seatUsage } from "@/lib/entitlements";
import { listRequests } from "@/lib/requests";
import { overdueTools } from "@/lib/reviews";
import {
  DEFAULT_SETTINGS,
  getSettings,
  operator,
  operatorConfigured,
} from "@/lib/settings";
import { zapierStatus } from "@/lib/zapier";
import type { ZapierStatus } from "@/lib/types";

export const runtime = "nodejs";

/**
 * One call behind the landing page and the console header.
 *
 * Two rules shape it. First, every contributing read is guarded on its own:
 * an unreachable Zapier must not blank the counts, because those counts come
 * from this app's own register and are still true during an upstream outage.
 * Second, a read that fails becomes a visible alert rather than a zero — the
 * difference between "nobody has access" and "we could not check" is the
 * whole reason anyone opens this screen.
 */

type Alert = { level: "warn" | "error"; text: string };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Degrade one number, not the page — and say out loud which number it was. */
function guard<T>(what: string, work: Promise<T>, fallback: T, alerts: Alert[]): Promise<T> {
  return work.catch((error: unknown) => {
    alerts.push({
      level: "error",
      text: `${what} could not be read: ${reason(error)}. The figure shown is not a count of zero.`,
    });
    return fallback;
  });
}

/**
 * Whether the assistant is usable, decided by the same check the routes use.
 *
 * Only the boolean is published. Which model answers is an implementation
 * detail, and a field nothing renders is exactly how one leaks back onto a
 * screen later.
 */
function modelStatus(): { configured: boolean } {
  try {
    checkApiKey();
    return { configured: true };
  } catch {
    return { configured: false };
  }
}

const ZAPIER_PROBE_FAILED: ZapierStatus = {
  state: "unavailable",
  detail: "The connectivity probe itself failed.",
};

export async function GET() {
  const alerts: Alert[] = [];

  const [zapier, settings, pending, active, pendingRevoke, tools, overdue, expired, usage] =
    await Promise.all([
      guard("Integration connectivity", zapierStatus(), ZAPIER_PROBE_FAILED, alerts),
      guard("Settings", getSettings(), DEFAULT_SETTINGS, alerts),
      guard("Pending requests", listRequests({ status: "pending" }), [], alerts),
      guard("Active entitlements", listEntitlements({ status: "active" }), [], alerts),
      guard("Failed revokes", listEntitlements({ status: "pending-revoke" }), [], alerts),
      guard("The tool catalogue", listTools(), [], alerts),
      guard("Overdue reviews", overdueTools(), [], alerts),
      guard("Expired grants", expiredGrants(), [], alerts),
      guard("Seat usage", seatUsage(), [], alerts),
    ]);

  const model = modelStatus();
  const failedRevokes = pendingRevoke.length;
  const manualTools = new Set(
    tools.filter((tool) => tool.provisioning === "manual").map((tool) => tool.id),
  );

  if (zapier.state === "unconfigured") {
    alerts.push({
      level: "error",
      text:
        `Integrations are not configured${zapier.detail ? ` (${zapier.detail})` : ""}. ` +
        "Provisioning, the Workspace directory and notifications are all unavailable until they are.",
    });
  } else if (zapier.state === "unavailable") {
    alerts.push({
      level: "error",
      text:
        `Integrations are not responding${zapier.detail ? `: ${zapier.detail}` : "."} ` +
        "Access changes and notifications will fail. The counts below come from this app's own " +
        "register and are unaffected.",
    });
  }

  // The guard fails closed, so an unset password does not weaken anything — it
  // stops the app doing its job. That is worth an error rather than a note.
  if (!actionPasswordConfigured()) {
    alerts.push({
      level: "error",
      text:
        "ACTION_PASSWORD is not set, so approving, revoking, offboarding and applying a " +
        "review's decisions are all blocked. Add it to .env.local and restart.",
    });
  }

  if (!model.configured) {
    alerts.push({
      level: "warn",
      text:
        "The assistant is not configured, so it and every drafting action will fail. Add its " +
        "API key to .env.local. Approvals, provisioning and reviews do not need it.",
    });
  }

  // An approval attributed to a placeholder address answers nobody's question
  // about who released the access, which is the one thing the trail is for.
  if (!operatorConfigured()) {
    alerts.push({
      level: "error",
      text:
        "OPERATOR_EMAIL is not set. Approvals and audit entries would be attributed to nobody, " +
        "so set it in .env.local before deciding anything.",
    });
  }

  if (settings.approvers.length === 0 && !tools.some((tool) => tool.ownerEmail)) {
    alerts.push({
      level: "error",
      text:
        "No approvers are configured and no tool has an owner, so there is nobody to route an " +
        "access request to. Add approvers in Settings, or set an owner on each tool.",
    });
  }

  // "pending-revoke" means the revoke was attempted and refused. It must never
  // read like "revoked": the person is very likely still holding the access.
  // `pending-revoke` covers two different situations that need different
  // sentences. Either the provider refused the removal, or the tool has no API
  // path and a human still has to do it in the vendor's console. Both mean the
  // access may remain — which is why they share a status — but telling someone
  // to "retry" a manual tool sends them to a button that will never help.
  if (failedRevokes > 0) {
    const awaitingHand = pendingRevoke.filter((entitlement) =>
      manualTools.has(entitlement.toolId),
    ).length;
    const refused = failedRevokes - awaitingHand;

    if (refused > 0) {
      alerts.push({
        level: "error",
        text:
          `${count(refused, "revoke", "revokes")} the provider refused. Those entitlements are ` +
          "marked pending-revoke, not revoked, and the people may still have the access. " +
          "Retry them in Entitlements.",
      });
    }
    if (awaitingHand > 0) {
      alerts.push({
        level: "warn",
        text:
          `${count(awaitingHand, "revoke is", "revokes are")} waiting on a manual step. These ` +
          "tools have no API path, so the access is still live until someone removes it in the " +
          "vendor's own console and marks it revoked.",
      });
    }
  }

  if (overdue.length > 0) {
    alerts.push({
      level: "warn",
      text: `${count(overdue.length, "tool is", "tools are")} past the review cadence. Open a review campaign.`,
    });
  }

  if (expired.length > 0) {
    alerts.push({
      level: "warn",
      text:
        `${count(expired.length, "grant is", "grants are")} past the agreed expiry date and still ` +
        "active. Time-bound access that nobody removed is access nobody agreed to.",
    });
  }

  // Errors first: the header shows the top of this list.
  alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));

  const money = (total: number) => Math.round(total * 100) / 100;

  return NextResponse.json({
    zapier,
    model,
    operator: { email: operator(), configured: operatorConfigured() },
    counts: {
      pendingRequests: pending.length,
      activeEntitlements: active.length,
      tools: tools.length,
      overdueReviews: overdue.length,
      expiredGrants: expired.length,
      failedRevokes,
    },
    spend: {
      monthly: money(usage.reduce((total, row) => total + row.monthlySpend, 0)),
      waste: money(usage.reduce((total, row) => total + row.monthlyWaste, 0)),
      currency: settings.currency,
    },
    alerts,
  });
}
