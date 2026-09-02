import "server-only";
import * as workspace from "./providers/workspace";
import * as slack from "./providers/slack";
import type { ProvisionOutcome } from "./providers/workspace";
import type { Tool } from "./types";

/**
 * One place that turns "this tool was approved for this person" into a call.
 *
 * It lives above the providers rather than inside one of them. The dispatch
 * used to sit in the Google Workspace provider, which meant adding Slack would
 * have made the Workspace module import Slack — the wrong way round, and the
 * shape that quietly turns two providers into one tangled file by the fourth.
 *
 * Adding a provider is now: write the module, add a `ProvisioningMethod`, and
 * add a case here. The compiler finds every other place that needs updating,
 * because every switch on the method is exhaustive.
 */

export type { ProvisionOutcome };

/** Carry out an approved grant. Never decides *whether* — only carries out. */
export async function grant(
  tool: Tool,
  email: string,
  role?: string,
): Promise<ProvisionOutcome> {
  switch (tool.provisioning) {
    case "google-group":
      if (!tool.groupEmail) {
        return { ok: false, detail: `${tool.name} has no group address configured.` };
      }
      // Slack and Google both take a role, but neither maps cleanly onto the
      // catalogue's free-text roles, so membership is always plain MEMBER and
      // the role is recorded on the entitlement rather than pushed upstream.
      return workspace.addToGroup(email, tool.groupEmail, "MEMBER");

    case "google-license":
      if (!tool.productId || !tool.skuId) {
        return { ok: false, detail: `${tool.name} has no productId/skuId configured.` };
      }
      return workspace.assignLicense(email, tool.productId, tool.skuId);

    case "slack-channel": {
      if (!tool.slackChannelId) {
        return { ok: false, detail: `${tool.name} has no Slack channel configured.` };
      }
      const outcome = await slack.inviteToChannel(email, tool.slackChannelId);
      return { ok: outcome.ok, detail: outcome.detail };
    }

    case "manual":
      return {
        ok: true,
        manual: true,
        detail:
          `${tool.name} has no API path. Grant it in the vendor's admin console for ` +
          `${email}${role ? ` as ${role}` : ""}, then mark the entitlement provisioned.`,
      };
  }
}

/** Carry out a revoke. Mirrors `grant`, including the manual case. */
export async function revoke(tool: Tool, email: string): Promise<ProvisionOutcome> {
  switch (tool.provisioning) {
    case "google-group":
      if (!tool.groupEmail) {
        return { ok: false, detail: `${tool.name} has no group address configured.` };
      }
      return workspace.removeFromGroup(email, tool.groupEmail);

    case "google-license":
      if (!tool.productId || !tool.skuId) {
        return { ok: false, detail: `${tool.name} has no productId/skuId configured.` };
      }
      return workspace.revokeLicense(email, tool.productId, tool.skuId);

    case "slack-channel": {
      if (!tool.slackChannelId) {
        return { ok: false, detail: `${tool.name} has no Slack channel configured.` };
      }
      const outcome = await slack.removeFromChannel(email, tool.slackChannelId);
      return { ok: outcome.ok, detail: outcome.detail };
    }

    case "manual":
      return {
        ok: true,
        manual: true,
        detail:
          `${tool.name} has no API path. Remove ${email} in the vendor's admin ` +
          `console, then mark the entitlement revoked.`,
      };
  }
}
