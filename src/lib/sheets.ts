import "server-only";
import { callTool } from "./zapier";
import { readStore } from "./store";
import type {
  AccessRequest,
  AuditEvent,
  Entitlement,
  ReviewCampaign,
  Settings,
  Tool,
} from "./types";

/**
 * Publish the register to a Google Sheet, so Claude can read it.
 *
 * The register — catalogue, entitlements, requests, reviews, audit — lives in
 * `.data/*.json` on whichever machine runs the app. Claude, talking only to
 * Zapier, cannot see those files, so `/access` in the Claude app knows the real
 * systems but not *why* anyone has access or who approved it. A shared Sheet
 * closes that gap: the app writes it, Claude reads it.
 *
 * **Why a deliberate sync and not a mirror on every write.** Each Zapier call
 * costs a task against a metered plan. Writing a row the ordinary way needs the
 * spreadsheet id resolved, the worksheet resolved, its dynamic column schema
 * fetched, then the write — four calls for one row, on every approval. That is
 * a bill and a latency cost paid forever for something nobody reads between
 * demos. So the whole register goes up in **three calls**, when a human asks
 * for it: read the tab list, add any missing tabs, write everything at once.
 *
 * The Sheet is a **published copy, never the source of truth.** The app keeps
 * reading and writing its local files; nothing here reads back. That keeps the
 * approval path fast and free, and means a stale or hand-edited Sheet can
 * never corrupt the register.
 */

/** One tab per collection, in the order a reader would want them. */
const TABS = [
  "catalog",
  "entitlements",
  "requests",
  "reviews",
  "audit",
  "settings",
] as const;

export type SyncResult = {
  ok: boolean;
  detail: string;
  /** Rows written per tab, so the caller can report what actually went up. */
  written?: Record<string, number>;
  url?: string;
  /** Zapier tasks this run consumed. */
  tasksUsed?: number;
};

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Cells must be strings; anything structured is JSON so nothing is lost. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Header row plus one row per record, with a stable column order. */
function grid(records: Record<string, unknown>[], columns: string[]): string[][] {
  return [columns, ...records.map((r) => columns.map((c) => cell(r[c])))];
}

export async function syncRegister(spreadsheetId: string): Promise<SyncResult> {
  const id = spreadsheetId.trim();
  if (!id) {
    return { ok: false, detail: "No spreadsheet id is configured in Settings." };
  }
  // A full Sheets URL pasted instead of the id is the obvious mistake; take it.
  const sheetId = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(id)?.[1] ?? id;

  let tasks = 0;

  // ── 1. which tabs already exist ─────────────────────────────────────────
  const info = await callTool("google_sheets_make_api_get_request", {
    url: `${SHEETS_API}/${sheetId}`,
    querystring: { fields: "sheets.properties.title" },
    output_hint: "the title of every sheet tab",
  });
  tasks += info.tasksUsed;
  if (!info.ok) {
    return {
      ok: false,
      detail:
        `The spreadsheet could not be read: ${info.error} ` +
        "Check the id, and that the Google account connected to Zapier can open it.",
      tasksUsed: tasks,
    };
  }

  const existing = new Set(
    JSON.stringify(info.data ?? {})
      .match(/"title"\s*:\s*"([^"]+)"/g)
      ?.map((m) => m.replace(/.*"title"\s*:\s*"/, "").replace(/"$/, "")) ?? [],
  );
  const missing = TABS.filter((tab) => !existing.has(tab));

  // ── 2. add any missing tabs, all in one request ─────────────────────────
  if (missing.length) {
    const add = await callTool("google_sheets_make_api_mutating_request", {
      url: `${SHEETS_API}/${sheetId}:batchUpdate`,
      method: "POST",
      body: JSON.stringify({
        requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
      }),
      output_hint: "confirmation that the sheets were added",
    });
    tasks += add.tasksUsed;
    if (!add.ok) {
      return {
        ok: false,
        detail: `Tabs ${missing.join(", ")} could not be created: ${add.error}`,
        tasksUsed: tasks,
      };
    }
  }

  // ── 3. the whole register, in a single write ────────────────────────────
  const [catalog, entitlements, requests, reviews, audit, settings] = await Promise.all([
    readStore<Tool[]>("catalog", []),
    readStore<Entitlement[]>("entitlements", []),
    readStore<AccessRequest[]>("requests", []),
    readStore<ReviewCampaign[]>("reviews", []),
    readStore<AuditEvent[]>("audit", []),
    readStore<Partial<Settings>>("settings", {}),
  ]);

  const data = [
    {
      range: "catalog!A1",
      values: grid(catalog as unknown as Record<string, unknown>[], [
        "id", "name", "vendor", "category", "ownerEmail", "costPerSeat",
        "seatsPurchased", "provisioning", "groupEmail", "productId", "skuId",
        "slackChannelId", "roles", "reviewCadenceDays", "sensitive", "notes",
        "createdAt", "archivedAt",
      ]),
    },
    {
      range: "entitlements!A1",
      values: grid(entitlements as unknown as Record<string, unknown>[], [
        "id", "personEmail", "personName", "toolId", "role", "status", "source",
        "grantedAt", "grantedBy", "expiresAt", "revokedAt", "revokedBy",
        "requestId", "lastReviewedAt", "lastReviewDecision", "provisionNote",
      ]),
    },
    {
      range: "requests!A1",
      values: grid(requests as unknown as Record<string, unknown>[], [
        "id", "requesterEmail", "requesterName", "toolId", "role", "justification",
        "expiresAt", "status", "createdAt", "approverEmail", "decidedAt",
        "decidedBy", "decisionNote", "provisionResult", "entitlementId",
        "notifications",
      ]),
    },
    {
      range: "reviews!A1",
      values: grid(reviews as unknown as Record<string, unknown>[], [
        "id", "name", "toolIds", "createdAt", "createdBy", "dueAt", "status",
        "closedAt", "items",
      ]),
    },
    {
      // Newest first, and capped: a Sheet is a window on the trail, not the
      // trail itself. The file on disk stays complete and authoritative.
      range: "audit!A1",
      values: grid(
        (audit as unknown as Record<string, unknown>[]).slice(0, 2000),
        ["at", "actor", "action", "subject", "result", "detail", "requestId", "toolId", "personEmail"],
      ),
    },
    {
      // Key/value rather than one wide row — it is read by a person as often
      // as by a model.
      range: "settings!A1",
      values: [
        ["setting", "value"],
        ...Object.entries(settings).map(([k, v]) => [k, cell(v)]),
      ],
    },
  ];

  const write = await callTool("google_sheets_make_api_mutating_request", {
    url: `${SHEETS_API}/${sheetId}/values:batchUpdate`,
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data }),
    output_hint: "the number of updated cells",
  });
  tasks += write.tasksUsed;

  if (!write.ok) {
    return { ok: false, detail: `The register could not be written: ${write.error}`, tasksUsed: tasks };
  }

  return {
    ok: true,
    detail: `Published to the sheet. ${missing.length ? `Created ${missing.join(", ")}. ` : ""}`,
    written: {
      catalog: catalog.length,
      entitlements: entitlements.length,
      requests: requests.length,
      reviews: reviews.length,
      audit: Math.min(audit.length, 2000),
    },
    url: `https://docs.google.com/spreadsheets/d/${sheetId}`,
    tasksUsed: tasks,
  };
}
