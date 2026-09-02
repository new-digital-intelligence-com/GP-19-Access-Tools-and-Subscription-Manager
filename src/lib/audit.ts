import "server-only";
import { append, newId, readStore } from "./store";
import type { AuditEvent } from "./types";

/**
 * The audit trail.
 *
 * Append-only by construction: there is no update and no delete in this
 * module, and nothing else in the app writes `audit.json`. A trail you can
 * edit answers no question worth asking.
 *
 * Every provisioning attempt is recorded whether it succeeded or failed. A
 * failed revoke that leaves no entry is the worst outcome here — it reads
 * afterwards as access that was removed.
 */
export async function record(
  event: Omit<AuditEvent, "id" | "at">,
): Promise<AuditEvent> {
  const entry: AuditEvent = { ...event, id: newId("evt"), at: new Date().toISOString() };
  // `append`, never a rewrite — the trail only ever grows at the front.
  return append<AuditEvent>("audit", entry);
}

export async function listAudit(filter?: {
  personEmail?: string;
  toolId?: string;
  requestId?: string;
  action?: string;
  since?: string;
  limit?: number;
}): Promise<AuditEvent[]> {
  const log = await readStore<AuditEvent[]>("audit", []);
  const matched = log.filter((event) => {
    if (filter?.personEmail && event.personEmail !== filter.personEmail) return false;
    if (filter?.toolId && event.toolId !== filter.toolId) return false;
    if (filter?.requestId && event.requestId !== filter.requestId) return false;
    if (filter?.action && !event.action.includes(filter.action)) return false;
    if (filter?.since && event.at < filter.since) return false;
    return true;
  });
  return matched.slice(0, filter?.limit ?? 200);
}
