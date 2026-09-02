import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { listTools as listCatalog, getTool } from "./catalog";
import { listEntitlements, seatUsage, expiredGrants } from "./entitlements";
import { createRequest, listRequests, getRequest } from "./requests";
import { listCampaigns, reviewsDue } from "./reviews";
import { listAudit } from "./audit";
import { scan } from "./lifecycle";
import { getSettings } from "./settings";

/**
 * The app's own tools, handed to the agent alongside the Zapier catalogue.
 *
 * What is here matters less than what is not. There is no `approve_request`,
 * no `grant_access`, no `revoke_access` and no `offboard` — the agent can
 * read the register, reason about it and *raise* a request, and that is the
 * end of its authority. Approval and provisioning are reachable only from a
 * human action in the UI or a signed API call, so no prompt, however phrased,
 * can talk the model into granting access.
 *
 * This is enforced by absence rather than by instruction, because an
 * instruction is a request and a missing tool is a fact.
 */

export const NATIVE_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_catalog",
    description:
      "List the managed tools and subscriptions: name, vendor, owner, cost per seat, " +
      "seats purchased, how it is provisioned, and whether it is marked sensitive.",
    input_schema: {
      type: "object",
      properties: {
        includeArchived: { type: "boolean", description: "Include archived tools." },
      },
    },
  },
  {
    name: "list_entitlements",
    description:
      "Who holds what. Filter by person email, tool id or status (active, revoked, " +
      "pending-revoke). 'pending-revoke' means a revoke was attempted and did not " +
      "succeed — the person may still have the access.",
    input_schema: {
      type: "object",
      properties: {
        personEmail: { type: "string" },
        toolId: { type: "string" },
        status: { type: "string", enum: ["active", "revoked", "pending-revoke"] },
      },
    },
  },
  {
    name: "list_requests",
    description:
      "Access requests and their decisions. Filter by status: pending, approved, " +
      "denied, provisioned, failed, cancelled.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "approved", "denied", "provisioned", "failed", "cancelled"],
        },
        requesterEmail: { type: "string" },
        toolId: { type: "string" },
      },
    },
  },
  {
    name: "get_request",
    description: "One access request in full, including its decision and provisioning result.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "raise_request",
    description:
      "Raise an access request on someone's behalf. This does NOT grant access: it " +
      "creates a pending request, routes it to the tool's owner and notifies them. " +
      "A human approver still has to decide. Requires a real justification — say what " +
      "the access is for, in the requester's own words where you have them.",
    input_schema: {
      type: "object",
      properties: {
        requesterEmail: { type: "string", description: "Work email of the person who needs access." },
        toolId: { type: "string", description: "Tool id from list_catalog." },
        role: { type: "string", description: "Role or plan tier, if the tool has them." },
        justification: { type: "string", description: "Why this person needs this access." },
        expiresAt: { type: "string", description: "ISO date for time-bound access. Omit for open-ended." },
      },
      required: ["requesterEmail", "toolId", "justification"],
    },
  },
  {
    name: "seat_usage",
    description:
      "Seats paid for against seats actually held, per tool, with the monthly cost of " +
      "the idle ones. Use this for any question about subscription waste or spend.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "reviews_status",
    description:
      "Review campaigns and which tools are past their review cadence. `dueSince` is " +
      "days overdue; negative means not yet due.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "expired_grants",
    description:
      "Entitlements whose expiry date has passed but which are still active. These are " +
      "the time-bound grants nobody removed.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "lifecycle_scan",
    description:
      "Compare the Google Workspace directory against the register. Returns: " +
      "`departures` (suspended or archived accounts that still hold access), " +
      "`dormant` (active accounts nobody has signed into that still hold access), " +
      "`joiners` (recently created accounts) and `orphans` (register rows for " +
      "addresses with no Workspace account at all). Read-only. These are SIGNALS " +
      "worth reviewing, not statements about employment — no HR system is " +
      "connected, so never say someone has left the company. If the directory is " +
      "unreachable this returns available:false, which is NOT 'everyone's access is " +
      "in order' and must be reported as an outage.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_audit",
    description:
      "The audit trail. Filter by person, tool, request id or action substring. " +
      "Failures are recorded here too — a 'revoke.failed' entry means access remains.",
    input_schema: {
      type: "object",
      properties: {
        personEmail: { type: "string" },
        toolId: { type: "string" },
        requestId: { type: "string" },
        action: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "read_settings",
    description:
      "Operating settings: Workspace domain, approvers, review cadence, notification " +
      "channels, currency and the offboarding SLA.",
    input_schema: { type: "object", properties: {} },
  },
];

export function isNativeTool(name: string): boolean {
  return NATIVE_TOOLS.some((tool) => tool.name === name);
}

/** Dispatch one native tool call and return the JSON the model will read. */
export async function runNativeTool(
  name: string,
  input: Record<string, unknown>,
  context: { actor: string; appUrl?: string },
): Promise<string> {
  try {
    switch (name) {
      case "list_catalog":
        return json(await listCatalog(Boolean(input.includeArchived)));

      case "list_entitlements": {
        const rows = await listEntitlements({
          personEmail: str(input.personEmail),
          toolId: str(input.toolId),
          status: str(input.status) as never,
        });
        // Tool ids mean nothing to a reader; carry the name alongside.
        const names = new Map((await listCatalog(true)).map((t) => [t.id, t.name]));
        return json(rows.map((row) => ({ ...row, toolName: names.get(row.toolId) ?? row.toolId })));
      }

      case "list_requests":
        return json(
          await listRequests({
            status: str(input.status) as never,
            requesterEmail: str(input.requesterEmail),
            toolId: str(input.toolId),
          }),
        );

      case "get_request": {
        const request = await getRequest(String(input.id));
        return request ? json(request) : json({ error: `No request with id ${input.id}.` });
      }

      case "raise_request": {
        const tool = await getTool(String(input.toolId));
        if (!tool) {
          return json({
            error: `No tool with id ${input.toolId}. Call list_catalog and use an id from it.`,
          });
        }
        const request = await createRequest({
          requesterEmail: String(input.requesterEmail),
          toolId: tool.id,
          role: str(input.role),
          justification: String(input.justification ?? ""),
          expiresAt: str(input.expiresAt),
          appUrl: context.appUrl,
        });
        return json({
          created: request,
          reminder:
            `Request ${request.id} is PENDING. Nothing has been granted. ` +
            `${request.approverEmail ?? "No approver"} has been asked to decide.`,
        });
      }

      case "seat_usage":
        return json(await seatUsage());

      case "reviews_status":
        return json({ campaigns: await listCampaigns(), due: await reviewsDue() });

      case "expired_grants":
        return json(await expiredGrants());

      case "lifecycle_scan":
        return json(await scan());

      case "read_audit":
        return json(
          await listAudit({
            personEmail: str(input.personEmail),
            toolId: str(input.toolId),
            requestId: str(input.requestId),
            action: str(input.action),
            limit: Number(input.limit) || 60,
          }),
        );

      case "read_settings":
        return json(await getSettings());

      default:
        return json({ error: `Unknown tool ${name}.` });
    }
  } catch (error) {
    // A tool error is data the model should see and explain, not an exception
    // that aborts the turn and loses the rest of the conversation.
    return json({ error: error instanceof Error ? error.message : "Tool failed." });
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
