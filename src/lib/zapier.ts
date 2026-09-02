import "server-only";

/**
 * A minimal MCP client for Zapier's remote server.
 *
 * Every integration in this app — Google Workspace Admin, Gmail and Google
 * Chat — is a Zapier MCP tool, so this file is the only place that
 * speaks to the outside world. Two callers use it:
 *
 * - the API routes, which call one tool deterministically (no model involved);
 * - the agent, which is handed the same tools as Anthropic tool definitions.
 *
 * Zapier speaks MCP over Streamable HTTP: a JSON-RPC POST whose response is
 * either JSON or an SSE stream, plus an `mcp-session-id` header to carry on
 * the same session. The SDK is not used because the whole client is this file
 * and an extra dependency would only hide the session handling that actually
 * needs to be visible here.
 */

export const ZAPIER_URL =
  process.env.ZAPIER_MCP_URL ?? "https://mcp.zapier.com/api/v1/connect";

/** MCP tool shape, narrowed to what this app reads. */
export type McpTool = {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
};

export type ToolResult = {
  /** False for BOTH a protocol-level and an in-payload Zapier failure. */
  ok: boolean;
  /** Text content joined; Zapier returns its payload as a JSON string here. */
  text: string;
  /** Parsed `text`, when it is JSON. Most Zapier results are. */
  data: unknown;
  /** Zapier's own message when the underlying action failed. */
  error?: string;
  /** `data.results` when Zapier returned the usual search/action envelope. */
  results: Record<string, unknown>[];
  /** Zapier task consumption, so the UI can show what a run actually cost. */
  tasksUsed: number;
};

export class ZapierNotConfiguredError extends Error {
  constructor() {
    super(
      "ZAPIER_MCP_TOKEN is not set. Copy .env.example to .env.local and paste the " +
        "token from mcp.zapier.com -> your MCP server -> Connect.",
    );
    this.name = "ZapierNotConfiguredError";
  }
}

function token(): string {
  const value = process.env.ZAPIER_MCP_TOKEN;
  if (!value) throw new ZapierNotConfiguredError();
  return value;
}

export function zapierConfigured(): boolean {
  return Boolean(process.env.ZAPIER_MCP_TOKEN);
}

/**
 * A response can be `application/json` or an SSE stream carrying one message.
 * Both are read to completion here; nothing in this app streams tool output.
 */
async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const type = response.headers.get("content-type") ?? "";

  if (!type.includes("text/event-stream")) {
    return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  }

  // Take the last `data:` line that parses — Zapier sends one message per
  // stream, but pings and comments are legal in between.
  let parsed: Record<string, unknown> = {};
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      /* a partial frame; keep the last good one */
    }
  }
  return parsed;
}

/** Session ids are cheap to re-mint and expire server-side; cache one. */
let sessionId: string | null = null;
let handshake: Promise<string> | null = null;

async function post(
  message: Record<string, unknown>,
  session: string | null,
): Promise<{ envelope: Record<string, unknown>; response: Response }> {
  const response = await fetch(ZAPIER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(message),
    // Zapier actions call a third-party API behind the scenes; some are slow.
    signal: AbortSignal.timeout(120_000),
  });
  return { envelope: await readEnvelope(response), response };
}

async function connect(): Promise<string> {
  const { envelope, response } = await post(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "gp19-access-manager", version: "0.1.0" },
      },
    },
    null,
  );

  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Zapier rejected the MCP token (HTTP " +
          response.status +
          "). Regenerate it at mcp.zapier.com -> your server -> Connect."
        : `Zapier MCP handshake failed (HTTP ${response.status}).`,
    );
  }
  if (envelope.error) throw new Error(describeRpcError(envelope.error));

  const id = response.headers.get("mcp-session-id");
  if (!id) throw new Error("Zapier MCP did not return a session id.");

  // The spec requires this notification before any other request; Zapier
  // tolerates its absence today, but a server that does not would fail here
  // in a way that is very hard to read from a tools/list error.
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, id).catch(() => {});
  return id;
}

async function session(): Promise<string> {
  if (sessionId) return sessionId;
  handshake ??= connect()
    .then((id) => {
      sessionId = id;
      return id;
    })
    .finally(() => {
      handshake = null;
    });
  return handshake;
}

function describeRpcError(error: unknown): string {
  const e = error as { message?: string; code?: number; data?: unknown };
  const detail =
    typeof e?.data === "string" ? ` ${e.data}` : e?.data ? ` ${JSON.stringify(e.data)}` : "";
  return `${e?.message ?? "Zapier MCP error"}${detail}`;
}

/** One JSON-RPC round trip, re-handshaking once if the session has expired. */
async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = await session();
    const { envelope, response } = await post(
      { jsonrpc: "2.0", id: Date.now(), method, params },
      id,
    );

    // 404 is how a Streamable HTTP server says "that session is gone".
    if (response.status === 404 && attempt === 0) {
      sessionId = null;
      continue;
    }
    if (!response.ok) {
      throw new Error(`Zapier MCP ${method} failed (HTTP ${response.status}).`);
    }
    if (envelope.error) throw new Error(describeRpcError(envelope.error));
    return envelope.result as T;
  }
  throw new Error(`Zapier MCP ${method} failed: session could not be re-established.`);
}

/** The catalogue changes only when the user edits their Zapier server. */
let toolCache: { at: number; tools: McpTool[] } | null = null;
const TOOL_TTL_MS = 5 * 60_000;

export async function listTools(force = false): Promise<McpTool[]> {
  if (!force && toolCache && Date.now() - toolCache.at < TOOL_TTL_MS) {
    return toolCache.tools;
  }
  const all: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await rpc<{ tools: McpTool[]; nextCursor?: string }>(
      "tools/list",
      cursor ? { cursor } : {},
    );
    all.push(...(page.tools ?? []));
    cursor = page.nextCursor;
  } while (cursor);

  toolCache = { at: Date.now(), tools: all };
  return all;
}

/**
 * Call one Zapier tool.
 *
 * Never throws on a tool-level failure: a Zapier action that returns an error
 * is a *result* the caller has to record in the audit trail, not an exception
 * to unwind through. Only transport and protocol faults throw.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const result = await rpc<{
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  }>("tools/call", { name, arguments: args });

  const text = (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();

  let data: unknown = result.structuredContent ?? null;
  if (data === null && text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  // Zapier reports an action failure *inside* the payload as well as through
  // the protocol flag — `{"isError":true,"error":"...Error code 401."}` is a
  // dead connection, not a transport problem. Reading only `result.isError`
  // would let an unauthorized integration look like an empty result, which is
  // exactly the confusion this app must never create about access state.
  const envelope = (data ?? {}) as {
    isError?: boolean;
    error?: string;
    results?: unknown;
    billingTasksUsed?: number;
  };
  const failed = Boolean(result.isError) || envelope.isError === true;

  return {
    ok: !failed,
    text,
    data,
    error: failed ? (envelope.error ?? text ?? "Zapier action failed.") : undefined,
    results: normaliseResults(envelope.results),
    tasksUsed: Number(envelope.billingTasksUsed ?? 0),
  };
}

/**
 * Zapier returns `results` as an array for a search and as a bare **object**
 * for an action that yields exactly one thing — `slack_find_user_by_email`
 * does the latter. Code reading `results[0]` then sees nothing and concludes
 * the record does not exist, which is how "no Slack account matches" gets
 * reported for an account that is right there. One shape out, always.
 */
function normaliseResults(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") return [value as Record<string, unknown>];
  return [];
}

/**
 * Call a tool and throw if it failed.
 *
 * Use only where a failure genuinely cannot be recorded and shown — a status
 * probe, a directory read. Anything that changes access uses `callTool` and
 * writes the failure to the audit trail instead of unwinding.
 */
export async function callToolOrThrow(
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const result = await callTool(name, args);
  if (!result.ok) throw new Error(`${name}: ${result.error}`);
  return result;
}

/** Which Zapier apps are wired up, for the connector strip and `/api/status`. */
export async function zapierStatus(): Promise<import("./types").ZapierStatus> {
  if (!zapierConfigured()) {
    return { state: "unconfigured", detail: "ZAPIER_MCP_TOKEN is not set." };
  }
  try {
    const tools = await listTools();
    const counts = new Map<string, number>();
    for (const tool of tools) {
      counts.set(appOf(tool.name), (counts.get(appOf(tool.name)) ?? 0) + 1);
    }
    return {
      state: "ready",
      apps: [...counts.entries()]
        .map(([app, count]) => ({ app, tools: count }))
        .sort((a, b) => b.tools - a.tools),
    };
  } catch (error) {
    return {
      state: "unavailable",
      detail: error instanceof Error ? error.message : "Zapier MCP is unreachable.",
    };
  }
}

/**
 * Group tools by the app they belong to.
 *
 * Zapier names a tool after its app, except where an action was renamed:
 * `write_slack_edit_message` is a Slack tool that does not begin with "slack".
 * A bare prefix match files those under "helpers" and understates the app, so
 * the mapping is explicit rather than derived.
 */
const APP_PREFIXES: [string, string][] = [
  ["google_workspace_admin", "google_workspace_admin"],
  ["google_chat", "google_chat"],
  ["google_drive", "google_drive"],
  ["google_sheets", "google_sheets"],
  ["bamboohr", "bamboohr"],
  ["gmail", "gmail"],
  ["slack", "slack"],
  ["write_slack", "slack"],
];

export function appOf(toolName: string): string {
  return APP_PREFIXES.find(([prefix]) => toolName.startsWith(prefix))?.[1] ?? "helpers";
}

/** Reset the cached session and tool list. Used by the status route's retry. */
export function resetZapier() {
  sessionId = null;
  toolCache = null;
}
