import "server-only";
import { mutate, newId, readStore } from "./store";
import { getTool, provisioningGap } from "./catalog";
import { activeGrant, grantAccess } from "./entitlements";
import { record } from "./audit";
import { announce } from "./providers/notify";
import { UNATTRIBUTED, getSettings, outsideDomain } from "./settings";
import type { AccessRequest, Tool } from "./types";

/**
 * Access requests and their approvals.
 *
 * The one invariant this whole app is built around: **no access is provisioned
 * without an approval decision recorded against a named human.** It is
 * enforced here rather than in the UI, because the UI is not the only caller —
 * the agent and the Claude Code skill reach the same functions.
 *
 * `approve()` is deliberately the only path from a request to a grant, and it
 * requires an `approver` address that is not the requester. There is no
 * "auto-approve" flag and no way to pass one.
 */

export class ApprovalError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ApprovalError";
    this.status = status;
  }
}

export async function listRequests(filter?: {
  status?: AccessRequest["status"];
  requesterEmail?: string;
  toolId?: string;
}): Promise<AccessRequest[]> {
  const all = await readStore<AccessRequest[]>("requests", []);
  return all
    .filter((request) => {
      if (filter?.status && request.status !== filter.status) return false;
      if (
        filter?.requesterEmail &&
        request.requesterEmail !== filter.requesterEmail.toLowerCase()
      )
        return false;
      if (filter?.toolId && request.toolId !== filter.toolId) return false;
      return true;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getRequest(id: string): Promise<AccessRequest | undefined> {
  return (await readStore<AccessRequest[]>("requests", [])).find((r) => r.id === id);
}

/** Who decides this one: the tool's owner, else the configured approvers. */
export async function approverFor(tool: Tool): Promise<string> {
  const settings = await getSettings();
  return tool.ownerEmail || settings.approvers[0] || "";
}

export async function createRequest(input: {
  requesterEmail: string;
  requesterName?: string;
  toolId: string;
  role?: string;
  justification: string;
  expiresAt?: string;
  /** Set the app URL so the notification can link straight to the decision. */
  appUrl?: string;
}): Promise<AccessRequest> {
  const requesterEmail = input.requesterEmail.trim().toLowerCase();
  if (!requesterEmail) throw new ApprovalError("A requester email is required.");
  if (!input.justification.trim()) {
    throw new ApprovalError(
      "A justification is required. An approver cannot decide on a request that " +
        "does not say what the access is for.",
    );
  }

  const tool = await getTool(input.toolId);
  if (!tool) throw new ApprovalError(`No tool with id ${input.toolId} in the catalogue.`, 404);

  if (await activeGrant(requesterEmail, tool.id)) {
    throw new ApprovalError(
      `${requesterEmail} already has active access to ${tool.name}. Revoke it first ` +
        "if the role needs to change.",
      409,
    );
  }

  const approverEmail = await approverFor(tool);
  const settings = await getSettings();
  const external = outsideDomain(requesterEmail, settings);

  const request: AccessRequest = {
    id: newId("req"),
    requesterEmail,
    requesterName: input.requesterName,
    toolId: tool.id,
    role: input.role,
    justification: input.justification.trim(),
    expiresAt: input.expiresAt,
    status: "pending",
    createdAt: new Date().toISOString(),
    approverEmail: approverEmail || undefined,
    notifications: [],
  };

  await mutate<AccessRequest[], void>("requests", [], (all) => ({
    next: [request, ...all],
    result: undefined,
  }));

  await record({
    actor: requesterEmail,
    action: "request.created",
    subject: `${requesterEmail} → ${tool.name}`,
    result: "info",
    detail: request.justification,
    requestId: request.id,
    toolId: tool.id,
    personEmail: requesterEmail,
  });

  if (external) {
    await record({
      actor: "system",
      action: "request.external-domain",
      subject: `${requesterEmail} → ${tool.name}`,
      result: "info",
      detail: `${external} The approver was told; this is a flag, not a refusal.`,
      requestId: request.id,
      toolId: tool.id,
      personEmail: requesterEmail,
    });
  }

  const deliveries = await announce({
    to: approverEmail,
    subject: `Access request: ${request.requesterName ?? requesterEmail} → ${tool.name}`,
    body: notificationBody(request, tool, external),
    chatTitle: `Access request · ${tool.name}`,
    buttonText: input.appUrl ? "Review the request" : undefined,
    buttonUrl: input.appUrl ? `${input.appUrl}/access?tab=requests` : undefined,
  }).catch(() => []);

  if (deliveries.length) {
    await mutate<AccessRequest[], void>("requests", [], (all) => ({
      next: all.map((current) =>
        current.id === request.id
          ? {
              ...current,
              notifications: deliveries.map((d) => ({
                channel: d.channel,
                at: d.at,
                detail: d.detail,
              })),
            }
          : current,
      ),
      result: undefined,
    }));
    request.notifications = deliveries.map((d) => ({
      channel: d.channel,
      at: d.at,
      detail: d.detail,
    }));
  }

  // An unroutable request is a request nobody will ever see. Surface it in the
  // trail so it shows up on screen rather than sitting silently pending.
  if (!approverEmail) {
    await record({
      actor: "system",
      action: "request.unrouted",
      subject: request.id,
      result: "error",
      detail:
        `${tool.name} has no owner and Settings lists no approvers, so nobody was ` +
        "notified. Set an owner or an approver, then re-notify.",
      requestId: request.id,
      toolId: tool.id,
    });
  }

  return request;
}

function notificationBody(request: AccessRequest, tool: Tool, external?: string | null): string {
  return [
    `${request.requesterName ?? request.requesterEmail} is asking for access to ${tool.name}.`,
    request.role ? `Role: ${request.role}` : "",
    request.expiresAt ? `Requested until: ${request.expiresAt.slice(0, 10)}` : "Requested with no end date.",
    "",
    `Reason given: ${request.justification}`,
    "",
    // The address is the field nobody re-reads, and it decides who actually
    // receives the access. An unfamiliar domain goes in front of the approver
    // rather than into a log they will never open.
    external ? `CHECK THE ADDRESS: ${external} Confirm it is the right person before approving.` : "",
    tool.sensitive ? "This tool is marked sensitive — it needs a named approver." : "",
    `Nothing is provisioned until you approve. Request id: ${request.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Approve and provision.
 *
 * Three checks run before anything is granted, and each of them can only be
 * satisfied by a human at the keyboard:
 *
 * - the request must still be pending (no re-approving a decided one);
 * - the approver must be a real address that is not the requester;
 * - the tool must actually be provisionable as configured.
 *
 * A provisioning failure leaves the request `failed`, never `provisioned`.
 */
export async function approve(input: {
  requestId: string;
  approverEmail: string;
  note?: string;
  appUrl?: string;
}): Promise<AccessRequest> {
  const approverEmail = input.approverEmail.trim().toLowerCase();
  const request = await getRequest(input.requestId);
  if (!request) throw new ApprovalError(`No request with id ${input.requestId}.`, 404);
  if (request.status !== "pending") {
    throw new ApprovalError(
      `This request is already ${request.status}; it cannot be approved again.`,
      409,
    );
  }
  if (!approverEmail || approverEmail === UNATTRIBUTED) {
    // The placeholder is not a lesser address, it is the absence of one. An
    // approval trail whose approver column reads "unattributed" cannot answer
    // the only question ever asked of it, so the grant is refused instead.
    throw new ApprovalError(
      "An approver address is required. Set OPERATOR_EMAIL in .env.local, or pass " +
        "the approver explicitly — an approval attributed to nobody is not an approval.",
    );
  }
  if (approverEmail === request.requesterEmail) {
    throw new ApprovalError(
      "A request cannot be approved by the person who raised it. Route it to the " +
        "tool's owner or another approver.",
      403,
    );
  }

  const tool = await getTool(request.toolId);
  if (!tool) throw new ApprovalError(`Request points at unknown tool ${request.toolId}.`, 404);

  const gap = provisioningGap(tool);
  if (gap) {
    throw new ApprovalError(
      `${gap} Fix the catalogue entry before approving, or the grant will be recorded ` +
        "without anything backing it.",
    );
  }

  await settle(request.id, {
    status: "approved",
    decidedAt: new Date().toISOString(),
    decidedBy: approverEmail,
    decisionNote: input.note,
  });

  await record({
    actor: approverEmail,
    action: "request.approved",
    subject: `${request.requesterEmail} → ${tool.name}`,
    result: "ok",
    detail: input.note ?? "Approved with no note.",
    requestId: request.id,
    toolId: tool.id,
    personEmail: request.requesterEmail,
  });

  const grant = await grantAccess({
    personEmail: request.requesterEmail,
    personName: request.requesterName,
    toolId: tool.id,
    role: request.role,
    source: "request",
    grantedBy: approverEmail,
    requestId: request.id,
    expiresAt: request.expiresAt,
  });

  const settled = await settle(request.id, {
    status: grant.ok ? "provisioned" : "failed",
    provisionResult: { ok: grant.ok, detail: grant.detail, at: new Date().toISOString() },
    entitlementId: grant.entitlement?.id,
  });

  await announce({
    to: request.requesterEmail,
    subject: grant.ok
      ? `Approved: your access to ${tool.name}`
      : `Approved, but not yet live: ${tool.name}`,
    body: [
      `${approverEmail} approved your request for ${tool.name}.`,
      input.note ? `Note: ${input.note}` : "",
      "",
      grant.ok
        ? grant.manual
          ? `It still needs a manual step in ${tool.vendor || tool.name}: ${grant.detail}`
          : grant.detail
        : `Provisioning failed and access is NOT live: ${grant.detail}`,
      request.expiresAt ? `\nThis access is set to expire on ${request.expiresAt.slice(0, 10)}.` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    chatTitle: `Access ${grant.ok ? "granted" : "failed"} · ${tool.name}`,
    buttonText: input.appUrl ? "Open the register" : undefined,
    buttonUrl: input.appUrl ? `${input.appUrl}/access?tab=entitlements` : undefined,
  }).catch(() => []);

  return settled ?? request;
}

export async function deny(input: {
  requestId: string;
  approverEmail: string;
  note: string;
}): Promise<AccessRequest> {
  const approverEmail = input.approverEmail.trim().toLowerCase();
  const request = await getRequest(input.requestId);
  if (!request) throw new ApprovalError(`No request with id ${input.requestId}.`, 404);
  if (request.status !== "pending") {
    throw new ApprovalError(`This request is already ${request.status}.`, 409);
  }
  if (!input.note.trim()) {
    throw new ApprovalError(
      "A denial needs a reason. The requester has to know what would change the answer.",
    );
  }

  const tool = await getTool(request.toolId);
  const settled = await settle(request.id, {
    status: "denied",
    decidedAt: new Date().toISOString(),
    decidedBy: approverEmail,
    decisionNote: input.note.trim(),
  });

  await record({
    actor: approverEmail,
    action: "request.denied",
    subject: `${request.requesterEmail} → ${tool?.name ?? request.toolId}`,
    result: "info",
    detail: input.note.trim(),
    requestId: request.id,
    toolId: request.toolId,
    personEmail: request.requesterEmail,
  });

  await announce({
    to: request.requesterEmail,
    subject: `Not approved: ${tool?.name ?? "access request"}`,
    body: [
      `${approverEmail} did not approve your request for ${tool?.name ?? request.toolId}.`,
      "",
      `Reason: ${input.note.trim()}`,
    ].join("\n"),
    chatTitle: `Access denied · ${tool?.name ?? request.toolId}`,
  }).catch(() => []);

  return settled ?? request;
}

export async function cancelRequest(
  requestId: string,
  actor: string,
): Promise<AccessRequest | undefined> {
  const request = await getRequest(requestId);
  if (!request) throw new ApprovalError(`No request with id ${requestId}.`, 404);
  if (request.status !== "pending") {
    throw new ApprovalError(`This request is already ${request.status}.`, 409);
  }
  const settled = await settle(requestId, {
    status: "cancelled",
    decidedAt: new Date().toISOString(),
    decidedBy: actor,
  });
  await record({
    actor,
    action: "request.cancelled",
    subject: requestId,
    result: "info",
    detail: "Withdrawn before a decision.",
    requestId,
    toolId: request.toolId,
    personEmail: request.requesterEmail,
  });
  return settled;
}

/** Re-send the approval notification for a request that was never routed. */
export async function renotify(
  requestId: string,
  appUrl?: string,
): Promise<AccessRequest | undefined> {
  const request = await getRequest(requestId);
  if (!request) throw new ApprovalError(`No request with id ${requestId}.`, 404);
  if (request.status !== "pending") {
    throw new ApprovalError("Only a pending request can be re-notified.", 409);
  }
  const tool = await getTool(request.toolId);
  if (!tool) throw new ApprovalError(`Unknown tool ${request.toolId}.`, 404);

  const approverEmail = request.approverEmail ?? (await approverFor(tool));
  const deliveries = await announce({
    to: approverEmail,
    subject: `Reminder — access request: ${request.requesterEmail} → ${tool.name}`,
    body: notificationBody(request, tool, outsideDomain(request.requesterEmail, await getSettings())),
    chatTitle: `Access request reminder · ${tool.name}`,
    buttonText: appUrl ? "Review the request" : undefined,
    buttonUrl: appUrl ? `${appUrl}/access?tab=requests` : undefined,
  });

  return settle(requestId, {
    approverEmail: approverEmail || undefined,
    notifications: [
      ...(request.notifications ?? []),
      ...deliveries.map((d) => ({ channel: d.channel, at: d.at, detail: d.detail })),
    ],
  });
}

async function settle(
  id: string,
  patch: Partial<AccessRequest>,
): Promise<AccessRequest | undefined> {
  return mutate<AccessRequest[], AccessRequest | undefined>("requests", [], (all) => {
    const next = all.map((current) =>
      current.id === id ? { ...current, ...patch } : current,
    );
    return { next, result: next.find((current) => current.id === id) };
  });
}
