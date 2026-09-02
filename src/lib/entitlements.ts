import "server-only";
import { mutate, newId, readStore } from "./store";
import { getTool, listTools } from "./catalog";
import { record } from "./audit";
import * as provisioning from "./provisioning";
import type { Entitlement, Tool } from "./types";

/**
 * The entitlement register: who has what, since when, and on whose authority.
 *
 * This is the only place a grant becomes a fact. `grantAccess` provisions
 * first and records second, so the register never claims access that the
 * provider refused. A refused grant is written to the audit trail and
 * returned — it is not silently retried and it does not create a row.
 */

export async function listEntitlements(filter?: {
  personEmail?: string;
  toolId?: string;
  status?: Entitlement["status"];
}): Promise<Entitlement[]> {
  const all = await readStore<Entitlement[]>("entitlements", []);
  return all
    .filter((entitlement) => {
      if (filter?.personEmail && entitlement.personEmail !== filter.personEmail.toLowerCase())
        return false;
      if (filter?.toolId && entitlement.toolId !== filter.toolId) return false;
      if (filter?.status && entitlement.status !== filter.status) return false;
      return true;
    })
    .sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
}

export async function getEntitlement(id: string): Promise<Entitlement | undefined> {
  return (await readStore<Entitlement[]>("entitlements", [])).find((e) => e.id === id);
}

/** An existing live grant of the same tool to the same person, if any. */
export async function activeGrant(
  personEmail: string,
  toolId: string,
): Promise<Entitlement | undefined> {
  return (await listEntitlements({ personEmail, toolId, status: "active" }))[0];
}

export type GrantInput = {
  personEmail: string;
  personName?: string;
  toolId: string;
  role?: string;
  source: Entitlement["source"];
  grantedBy: string;
  requestId?: string;
  expiresAt?: string;
};

export type GrantResult = {
  ok: boolean;
  detail: string;
  entitlement?: Entitlement;
  /** True when the provider has no API path and a human must finish the job. */
  manual?: boolean;
};

/**
 * Provision, then register.
 *
 * The order is the whole safety property: if the provider call fails there is
 * no entitlement row, so the register cannot show access that does not exist.
 * The reverse order would be one failed call away from an untrue answer to
 * "who has access to this".
 */
export async function grantAccess(input: GrantInput): Promise<GrantResult> {
  const email = input.personEmail.trim().toLowerCase();
  const tool = await getTool(input.toolId);
  if (!tool) return { ok: false, detail: `No tool with id ${input.toolId} in the catalogue.` };

  const existing = await activeGrant(email, tool.id);
  if (existing) {
    return {
      ok: true,
      detail: `${email} already has active access to ${tool.name}; nothing was changed.`,
      entitlement: existing,
    };
  }

  const outcome = await provisioning.grant(tool, email, input.role);

  await record({
    actor: input.grantedBy,
    action: outcome.manual ? "grant.manual-required" : outcome.ok ? "grant.provisioned" : "grant.failed",
    subject: `${email} → ${tool.name}`,
    result: outcome.ok ? "ok" : "error",
    detail: outcome.detail,
    requestId: input.requestId,
    toolId: tool.id,
    personEmail: email,
  });

  if (!outcome.ok) return { ok: false, detail: outcome.detail };

  const entitlement: Entitlement = {
    id: newId("ent"),
    personEmail: email,
    personName: input.personName,
    toolId: tool.id,
    role: input.role,
    status: "active",
    source: input.source,
    grantedAt: new Date().toISOString(),
    grantedBy: input.grantedBy,
    expiresAt: input.expiresAt,
    requestId: input.requestId,
    provisionNote: outcome.detail,
  };

  await mutate<Entitlement[], void>("entitlements", [], (all) => ({
    next: [entitlement, ...all],
    result: undefined,
  }));

  return { ok: true, detail: outcome.detail, entitlement, manual: outcome.manual };
}

/**
 * Revoke, and say plainly when the provider refused.
 *
 * A failed revoke leaves the entitlement `pending-revoke` rather than
 * `revoked`. Marking it revoked would remove it from every "who has access"
 * answer while the person still has the access — the exact failure an access
 * review exists to catch.
 */
export async function revokeAccess(input: {
  entitlementId: string;
  revokedBy: string;
  reason: string;
}): Promise<{ ok: boolean; detail: string; entitlement?: Entitlement; manual?: boolean }> {
  const entitlement = await getEntitlement(input.entitlementId);
  if (!entitlement) return { ok: false, detail: `No entitlement with id ${input.entitlementId}.` };
  if (entitlement.status === "revoked") {
    return { ok: true, detail: "Already revoked; nothing was changed.", entitlement };
  }

  const tool = await getTool(entitlement.toolId);
  if (!tool) {
    return { ok: false, detail: `Entitlement points at unknown tool ${entitlement.toolId}.` };
  }

  const outcome = await provisioning.revoke(tool, entitlement.personEmail);

  await record({
    actor: input.revokedBy,
    action: outcome.manual
      ? "revoke.manual-required"
      : outcome.ok
        ? "revoke.provisioned"
        : "revoke.failed",
    subject: `${entitlement.personEmail} → ${tool.name}`,
    result: outcome.ok ? "ok" : "error",
    detail: `${outcome.detail} Reason: ${input.reason}`,
    toolId: tool.id,
    personEmail: entitlement.personEmail,
    requestId: entitlement.requestId,
  });

  const updated = await mutate<Entitlement[], Entitlement | undefined>(
    "entitlements",
    [],
    (all) => {
      const next = all.map((current) =>
        current.id === entitlement.id
          ? {
              ...current,
              status: (outcome.ok && !outcome.manual
                ? "revoked"
                : outcome.ok
                  ? "pending-revoke"
                  : "pending-revoke") as Entitlement["status"],
              revokedAt: outcome.ok && !outcome.manual ? new Date().toISOString() : undefined,
              revokedBy: input.revokedBy,
              provisionNote: outcome.detail,
            }
          : current,
      );
      return { next, result: next.find((current) => current.id === entitlement.id) };
    },
  );

  return { ok: outcome.ok, detail: outcome.detail, entitlement: updated, manual: outcome.manual };
}

/** Force an entitlement's status after a human finished a `manual` tool by hand. */
export async function markEntitlement(
  id: string,
  status: Entitlement["status"],
  actor: string,
): Promise<Entitlement | undefined> {
  const updated = await mutate<Entitlement[], Entitlement | undefined>(
    "entitlements",
    [],
    (all) => {
      const next = all.map((current) =>
        current.id === id
          ? {
              ...current,
              status,
              revokedAt: status === "revoked" ? new Date().toISOString() : current.revokedAt,
              revokedBy: status === "revoked" ? actor : current.revokedBy,
            }
          : current,
      );
      return { next, result: next.find((current) => current.id === id) };
    },
  );
  if (updated) {
    await record({
      actor,
      action: "entitlement.marked",
      subject: `${updated.personEmail} → ${updated.toolId}`,
      result: "info",
      detail: `Status set to ${status} by hand after an off-API change.`,
      toolId: updated.toolId,
      personEmail: updated.personEmail,
    });
  }
  return updated;
}

/**
 * Import a grant that already exists in the provider.
 *
 * Marked `source: "imported"` and never provisioned — the access is already
 * there. Reviews treat these no differently, which is the point: the ones
 * nobody in this app granted are exactly the ones worth reviewing.
 */
export async function importEntitlement(input: {
  personEmail: string;
  personName?: string;
  toolId: string;
  role?: string;
  actor: string;
}): Promise<Entitlement | undefined> {
  const email = input.personEmail.trim().toLowerCase();
  if (await activeGrant(email, input.toolId)) return undefined;

  const entitlement: Entitlement = {
    id: newId("ent"),
    personEmail: email,
    personName: input.personName,
    toolId: input.toolId,
    role: input.role,
    status: "active",
    source: "imported",
    grantedAt: new Date().toISOString(),
    grantedBy: input.actor,
    provisionNote: "Imported from the provider; this app did not grant it.",
  };
  await mutate<Entitlement[], void>("entitlements", [], (all) => ({
    next: [entitlement, ...all],
    result: undefined,
  }));
  await record({
    actor: input.actor,
    action: "entitlement.imported",
    subject: `${email} → ${input.toolId}`,
    result: "info",
    detail: "Existing access recorded in the register without provisioning.",
    toolId: input.toolId,
    personEmail: email,
  });
  return entitlement;
}

export type SeatUsage = {
  tool: Tool;
  active: number;
  purchased: number;
  /** Paid-for seats nobody holds. Negative means over-assigned. */
  idle: number;
  monthlyWaste: number;
  monthlySpend: number;
};

/** Seats paid for against seats actually held — the subscription-waste view. */
export async function seatUsage(): Promise<SeatUsage[]> {
  const [tools, entitlements] = await Promise.all([
    listTools(),
    listEntitlements({ status: "active" }),
  ]);
  return tools
    .map((tool) => {
      const active = entitlements.filter((e) => e.toolId === tool.id).length;
      const idle = tool.seatsPurchased - active;
      return {
        tool,
        active,
        purchased: tool.seatsPurchased,
        idle,
        monthlyWaste: Math.max(0, idle) * tool.costPerSeat,
        monthlySpend: tool.seatsPurchased * tool.costPerSeat,
      };
    })
    .sort((a, b) => b.monthlyWaste - a.monthlyWaste);
}

/** Grants whose `expiresAt` has passed but which are still active. */
export async function expiredGrants(asOf = new Date()): Promise<Entitlement[]> {
  const active = await listEntitlements({ status: "active" });
  return active.filter(
    (e) => e.expiresAt && new Date(e.expiresAt).getTime() <= asOf.getTime(),
  );
}
