import "server-only";
import { mutate, newId, readStore } from "./store";
import type { Tool } from "./types";

/**
 * The catalogue of managed tools and subscriptions.
 *
 * `provisioning` is the field that matters: it decides whether an approval can
 * be carried out by this app at all. A `manual` tool is still tracked, still
 * reviewed and still audited — it just ends with a task for a human instead of
 * an API call, and the app says so rather than implying the grant happened.
 */
export async function listTools(includeArchived = false): Promise<Tool[]> {
  const tools = await readStore<Tool[]>("catalog", []);
  return tools
    .filter((tool) => includeArchived || !tool.archivedAt)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTool(id: string): Promise<Tool | undefined> {
  return (await readStore<Tool[]>("catalog", [])).find((tool) => tool.id === id);
}

export type ToolDraft = Omit<Tool, "id" | "createdAt"> & { id?: string };

export async function saveTool(draft: ToolDraft): Promise<Tool> {
  return mutate<Tool[], Tool>("catalog", [], (tools) => {
    const existing = draft.id ? tools.find((tool) => tool.id === draft.id) : undefined;
    const tool: Tool = {
      ...normalise(draft),
      id: existing?.id ?? draft.id ?? newId("tool"),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    return {
      next: existing
        ? tools.map((current) => (current.id === tool.id ? tool : current))
        : [...tools, tool],
      result: tool,
    };
  });
}

/**
 * Archive rather than delete.
 *
 * Entitlements and audit entries point at a tool id. Deleting the row would
 * leave the trail referring to something that no longer has a name, which
 * defeats the point of keeping the trail.
 */
export async function archiveTool(id: string): Promise<Tool | undefined> {
  return mutate<Tool[], Tool | undefined>("catalog", [], (tools) => {
    const tool = tools.find((current) => current.id === id);
    if (!tool) return { next: tools, result: undefined };
    const archived = { ...tool, archivedAt: new Date().toISOString() };
    return {
      next: tools.map((current) => (current.id === id ? archived : current)),
      result: archived,
    };
  });
}

function normalise(draft: ToolDraft): Omit<Tool, "id" | "createdAt"> {
  return {
    name: draft.name.trim(),
    vendor: draft.vendor?.trim() ?? "",
    category: draft.category?.trim() || "Uncategorised",
    ownerEmail: draft.ownerEmail?.trim().toLowerCase() ?? "",
    costPerSeat: Number(draft.costPerSeat) || 0,
    seatsPurchased: Number(draft.seatsPurchased) || 0,
    provisioning: draft.provisioning,
    groupEmail: draft.groupEmail?.trim().toLowerCase() || undefined,
    productId: draft.productId?.trim() || undefined,
    skuId: draft.skuId?.trim() || undefined,
    slackChannelId: draft.slackChannelId?.trim() || undefined,
    roles: (draft.roles ?? []).map((role) => role.trim()).filter(Boolean),
    reviewCadenceDays: Number(draft.reviewCadenceDays) || 0,
    sensitive: Boolean(draft.sensitive),
    notes: draft.notes?.trim() || undefined,
    archivedAt: draft.archivedAt,
  };
}

/**
 * Whether this app can actually carry out a grant for the tool as configured.
 *
 * Checked before an approval, not after: telling an approver the access is
 * live and then discovering the group address is missing is the failure this
 * prevents.
 */
export function provisioningGap(tool: Tool): string | null {
  if (tool.provisioning === "google-group" && !tool.groupEmail) {
    return `${tool.name} is provisioned by Google group membership but has no group address set.`;
  }
  if (tool.provisioning === "google-license" && !(tool.productId && tool.skuId)) {
    return `${tool.name} is provisioned by Google licence but has no productId/skuId set.`;
  }
  if (tool.provisioning === "slack-channel" && !tool.slackChannelId) {
    return `${tool.name} is provisioned by Slack channel membership but has no channel set.`;
  }
  return null;
}
