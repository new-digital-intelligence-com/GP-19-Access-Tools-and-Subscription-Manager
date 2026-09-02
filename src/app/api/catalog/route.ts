import { NextResponse } from "next/server";
import { record } from "@/lib/audit";
import {
  archiveTool,
  getTool,
  listTools,
  provisioningGap,
  saveTool,
  type ToolDraft,
} from "@/lib/catalog";
import { seatUsage } from "@/lib/entitlements";
import { slackChannels as channels } from "@/lib/providers/notify";
import { storage } from "@/lib/providers/drive";
import { operator } from "@/lib/settings";
import type { ProvisioningMethod, Tool } from "@/lib/types";

export const runtime = "nodejs";

/**
 * The tool catalogue.
 *
 * Both writes go through `catalog.saveTool`, and both refuse an entry whose
 * provisioning method has no identifier behind it — a `google-group` tool with
 * no group address, say. Refusing it here costs an approver one correction;
 * discovering it at approval time costs them a decision they thought had taken
 * effect and had not.
 */

const METHODS: ProvisioningMethod[] = ["google-group", "google-license", "manual"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

function failed(error: unknown, fallback: string) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 500 },
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `null` means the caller sent something that is not a usable quantity. */
function nonNegative(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Build a `ToolDraft` from request JSON, keeping whatever the caller did not
 * send. `existing` is the stored row on a PATCH: a partial update must not
 * quietly reset the fields it says nothing about.
 */
function draftFrom(body: Record<string, unknown>, existing?: Tool): ToolDraft | string {
  const name = text(body.name) || existing?.name || "";
  if (!name) return "A tool name is required.";

  const rawMethod = body.provisioning ?? existing?.provisioning;
  if (typeof rawMethod !== "string" || !METHODS.includes(rawMethod as ProvisioningMethod)) {
    return `provisioning must be one of: ${METHODS.join(", ")}.`;
  }
  const provisioning = rawMethod as ProvisioningMethod;

  const ownerEmail = (text(body.ownerEmail) || existing?.ownerEmail || "").toLowerCase();
  if (ownerEmail && !EMAIL.test(ownerEmail)) {
    return `"${ownerEmail}" is not a valid owner address. The owner is who approvals route to.`;
  }

  const costPerSeat = nonNegative(body.costPerSeat, existing?.costPerSeat ?? 0);
  if (costPerSeat === null) return "costPerSeat must be a number, zero or more.";

  const seatsPurchased = nonNegative(body.seatsPurchased, existing?.seatsPurchased ?? 0);
  if (seatsPurchased === null) return "seatsPurchased must be a whole number of seats, zero or more.";

  const reviewCadenceDays = nonNegative(body.reviewCadenceDays, existing?.reviewCadenceDays ?? 0);
  if (reviewCadenceDays === null) {
    return "reviewCadenceDays must be a number of days, zero or more. Zero disables the schedule.";
  }

  const roles = Array.isArray(body.roles)
    ? body.roles.map((role) => String(role).trim()).filter(Boolean)
    : typeof body.roles === "string"
      ? body.roles.split(",").map((role) => role.trim()).filter(Boolean)
      : (existing?.roles ?? []);

  return {
    id: existing?.id,
    name,
    vendor: text(body.vendor) || existing?.vendor || "",
    category: text(body.category) || existing?.category || "",
    ownerEmail,
    costPerSeat,
    seatsPurchased: Math.round(seatsPurchased),
    provisioning,
    groupEmail: text(body.groupEmail) || existing?.groupEmail,
    productId: text(body.productId) || existing?.productId,
    skuId: text(body.skuId) || existing?.skuId,
    roles,
    reviewCadenceDays,
    sensitive:
      typeof body.sensitive === "boolean" ? body.sensitive : (existing?.sensitive ?? false),
    notes: text(body.notes) || existing?.notes,
    // Carried forward rather than read from the body: an update that omits it
    // would otherwise un-archive a tool nobody meant to bring back.
    archivedAt: existing?.archivedAt,
  };
}

/** The gap check wants a whole Tool; the id and date are irrelevant to it. */
function gapIn(draft: ToolDraft, createdAt: string): string | null {
  return provisioningGap({ ...draft, id: draft.id ?? "unsaved", createdAt });
}

function describe(tool: Tool): string {
  return [
    `${tool.provisioning} provisioning`,
    tool.groupEmail && `group ${tool.groupEmail}`,
    tool.skuId && `sku ${tool.skuId}`,
    `${tool.seatsPurchased} seats at ${tool.costPerSeat} each`,
    `owner ${tool.ownerEmail || "unset"}`,
    tool.sensitive && "marked sensitive",
  ]
    .filter(Boolean)
    .join(", ");
}

export async function GET(request: Request) {
  try {
    const includeArchived =
      new URL(request.url).searchParams.get("includeArchived") === "1";
    // The Slack channel list is best effort and only feeds a picker: a tool
    // with a channel already set must still be editable when Slack is down,
    // so a failure here degrades the form to a free-text id rather than
    // failing the whole catalogue read.
    const [tools, usage, slackChannels, driveStorage] = await Promise.all([
      listTools(includeArchived),
      seatUsage(),
      channels().catch(() => []),
      // Guarded like the channel list: the catalogue must stay readable when
      // Drive is not, and an unreadable pool is a state the card draws.
      storage().catch((error: unknown) => ({
        available: false,
        detail: error instanceof Error ? error.message : "Drive storage could not be read.",
        limit: null,
        usage: null,
        usageInDrive: null,
        usageInTrash: null,
      })),
    ]);
    return NextResponse.json({ tools, usage, slackChannels, storage: driveStorage });
  } catch (error) {
    return failed(error, "The catalogue could not be read.");
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("The request body must be JSON.");
  }

  // POST always creates; an update carries its id and goes through PATCH.
  const draft = draftFrom(body);
  if (typeof draft === "string") return bad(draft);

  const gap = gapIn(draft, new Date().toISOString());
  if (gap) {
    return bad(
      `${gap} Add it before saving, or an approver will release access that this app cannot carry out.`,
    );
  }

  try {
    const tool = await saveTool(draft);
    await record({
      actor: operator(),
      action: "catalog.created",
      subject: tool.name,
      result: "ok",
      detail: `Added to the catalogue: ${describe(tool)}.`,
      toolId: tool.id,
    });
    return NextResponse.json({ tool });
  } catch (error) {
    return failed(error, "The tool could not be saved.");
  }
}

export async function PATCH(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("The request body must be JSON.");
  }

  const id = text(body.id);
  if (!id) return bad("An id is required to update a tool.");

  const existing = await getTool(id);
  if (!existing) {
    return NextResponse.json({ error: `No tool with id ${id}.` }, { status: 404 });
  }

  const draft = draftFrom(body, existing);
  if (typeof draft === "string") return bad(draft);

  const gap = gapIn(draft, existing.createdAt);
  if (gap) {
    return bad(
      `${gap} Add it before saving, or an approver will release access that this app cannot carry out.`,
    );
  }

  try {
    const tool = await saveTool(draft);
    await record({
      actor: operator(),
      action: "catalog.updated",
      subject: tool.name,
      result: "ok",
      detail: `Catalogue entry updated: ${describe(tool)}.`,
      toolId: tool.id,
    });
    return NextResponse.json({ tool });
  } catch (error) {
    return failed(error, "The tool could not be saved.");
  }
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) return bad("An id is required.");

  try {
    const tool = await archiveTool(id);
    if (!tool) {
      return NextResponse.json({ error: `No tool with id ${id}.` }, { status: 404 });
    }
    await record({
      actor: operator(),
      action: "catalog.archived",
      subject: tool.name,
      result: "info",
      detail:
        "Archived, not deleted. Existing entitlements and audit entries still point at this " +
        "tool id, and archiving does not revoke anyone's access.",
      toolId: tool.id,
    });
    return NextResponse.json({ tool });
  } catch (error) {
    return failed(error, "The tool could not be archived.");
  }
}
