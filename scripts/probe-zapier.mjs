#!/usr/bin/env node
/**
 * Verification harness for the Zapier MCP server.
 *
 * Run it before blaming the app. It answers the three questions that account
 * for nearly every "it does nothing" report, and it answers them separately,
 * because they have different fixes:
 *
 *   1. Is the token good?          -> the handshake succeeds or 401s
 *   2. Which apps are exposed?     -> the tool list, grouped
 *   3. Do those apps actually work? -> one read-only call per app
 *
 * A Zapier app can be present in the tool list and still be dead: the account
 * behind it reports its failure *inside* the payload as
 * {"isError":true,"error":"… Error code 401."} while the MCP call itself
 * returns 200. That is the state this script exists to make visible.
 *
 *   node scripts/probe-zapier.mjs
 *
 * Reads ZAPIER_MCP_URL and ZAPIER_MCP_TOKEN from the environment or .env.local.
 * Every call it makes is read-only.
 */
import { readFileSync } from "node:fs";

function loadEnv() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    /* no .env.local; rely on the environment */
  }
}
loadEnv();

const URL_ = process.env.ZAPIER_MCP_URL ?? "https://mcp.zapier.com/api/v1/connect";
const TOKEN = process.env.ZAPIER_MCP_TOKEN;

if (!TOKEN) {
  console.error("ZAPIER_MCP_TOKEN is not set. Add it to .env.local and re-run.");
  process.exit(1);
}

let session = null;

async function post(message) {
  const response = await fetch(URL_, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(message),
  });
  const body = await response.text();
  let parsed = {};
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        parsed = JSON.parse(line.slice(5).trim());
      } catch {
        /* keep the last good frame */
      }
    }
  } else if (body) {
    parsed = JSON.parse(body);
  }
  return { response, parsed };
}

async function rpc(method, params) {
  const { response, parsed } = await post({ jsonrpc: "2.0", id: Date.now(), method, params });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  if (parsed.error) throw new Error(`${method}: ${parsed.error.message ?? "rpc error"}`);
  return parsed.result;
}

/**
 * Zapier names a tool after its app, except where an action was renamed —
 * `write_slack_edit_message` is a Slack tool that does not start with "slack".
 * Grouping by a bare prefix would file those under "helpers" and quietly
 * understate the app they belong to, so the map is explicit.
 */
const APP_PREFIXES = [
  ["google_workspace_admin", "google_workspace_admin"],
  ["bamboohr", "bamboohr"],
  ["gmail", "gmail"],
  ["google_chat", "google_chat"],
  ["google_drive", "google_drive"],
  ["google_sheets", "google_sheets"],
  ["slack", "slack"],
  ["write_slack", "slack"],
];

function appOf(name) {
  return APP_PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1] ?? "helpers";
}

/** One cheap read per app this project depends on. */
const HEALTH_CHECKS = [
  {
    app: "google_workspace_admin",
    tool: "google_workspace_admin_find_user_by_email",
    args: {
      email_to_search_for: "gp19-probe-no-such-user@example.invalid",
      output_hint: "the user id and primaryEmail",
    },
    reads: "the Workspace directory (lookup)",
  },
  {
    // The lookup above can succeed on a connection that cannot list the
    // directory, and the whole lifecycle scan depends on the list. Check both.
    app: "google_workspace_admin",
    tool: "google_workspace_admin_make_api_get_request",
    args: {
      url: "https://admin.googleapis.com/admin/directory/v1/users",
      querystring: { customer: "my_customer", maxResults: "1", projection: "full" },
      output_hint: "one user's primaryEmail, suspended flag and creationTime",
    },
    reads: "the Workspace directory (list)",
  },
  {
    app: "gmail",
    tool: "gmail_find_email",
    args: {
      query: "subject:gp19-probe-nothing-matches-this",
      output_hint: "the subject and id of any matching message",
    },
    reads: "the mailbox",
  },
  {
    app: "google_chat",
    tool: "list_dynamic_enum_values",
    args: { tool_name: "google_chat_create_message", property_name: "room" },
    reads: "the list of Chat spaces",
  },
  {
    app: "slack",
    tool: "slack_find_user_by_email",
    args: {
      email: "gp19-probe-nobody@example.invalid",
      output_hint: "the user id, name and email",
    },
    reads: "the Slack user directory",
  },
  {
    // Channel membership is a provisioning method, so the channel list is
    // load-bearing and not just a picker convenience.
    app: "slack",
    tool: "list_dynamic_enum_values",
    args: { tool_name: "slack_send_channel_message", property_name: "channel" },
    reads: "the list of Slack channels",
  },
];

function unwrap(result) {
  const text = (result.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
  let data = result.structuredContent ?? null;
  if (data === null && text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  const failed = Boolean(result.isError) || data?.isError === true;
  // "unknown error" is useless in a diagnostic. Zapier puts its message in
  // `error`, but a rejected request can instead come back as a bare string, a
  // `message` field, or the raw text — fall through all of them before giving
  // up, and truncate rather than hide.
  const message =
    data?.error ??
    data?.message ??
    (typeof data === "string" ? data : undefined) ??
    (text ? text.slice(0, 400) : undefined);
  return { failed, error: message, data, text };
}

async function main() {
  process.stdout.write(`Connecting to ${URL_}\n`);
  const { response, parsed } = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "gp19-probe", version: "0.1.0" },
    },
  });

  if (!response.ok) {
    console.error(
      response.status === 401 || response.status === 403
        ? `  token rejected (HTTP ${response.status}). Regenerate it at mcp.zapier.com.`
        : `  handshake failed (HTTP ${response.status}).`,
    );
    process.exit(1);
  }
  session = response.headers.get("mcp-session-id");
  const server = parsed.result?.serverInfo ?? {};
  console.log(`  ok — ${server.name ?? "server"} ${server.version ?? ""}\n`);
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });

  const { tools = [] } = await rpc("tools/list", {});
  const counts = new Map();
  for (const tool of tools) {
    const app = appOf(tool.name);
    counts.set(app, (counts.get(app) ?? 0) + 1);
  }

  console.log(`Tools exposed: ${tools.length}`);
  for (const [app, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${app}`);
  }

  console.log("\nLive read per app this project uses:");
  let broken = 0;
  for (const check of HEALTH_CHECKS) {
    if (!tools.some((t) => t.name === check.tool)) {
      console.log(`  SKIP  ${check.app} — ${check.tool} is not in this server`);
      continue;
    }
    try {
      const outcome = unwrap(await rpc("tools/call", { name: check.tool, arguments: check.args }));
      if (outcome.failed) {
        broken++;
        console.log(`  FAIL  ${check.app} — ${outcome.error ?? "unknown error"}`);
        if (String(outcome.error ?? "").includes("401")) {
          console.log(
            `        the Zapier connection for this app needs re-authorising; ` +
              `reading ${check.reads} is blocked until it is`,
          );
        }
      } else {
        const rows = Array.isArray(outcome.data?.results)
          ? outcome.data.results.length
          : Array.isArray(outcome.data?.values)
            ? outcome.data.values.length
            : null;
        console.log(
          `  OK    ${check.app} — read ${check.reads}` +
            (rows === null ? "" : ` (${rows} row${rows === 1 ? "" : "s"})`),
        );
        if (check.app === "slack" && check.reads.includes("channels") && rows === 0) {
          console.log(
            "        no channels are visible to the connection — Slack channel " +
              "provisioning and the fallback channel both need at least one",
          );
        }
        if (check.app === "google_chat" && rows === 0) {
          console.log(
            "        no Chat spaces are visible to the connection — share a space " +
              "with it, or chat notifications will have nowhere to go",
          );
        }
      }
    } catch (error) {
      broken++;
      console.log(`  FAIL  ${check.app} — ${error.message}`);
    }
  }

  console.log(
    broken
      ? `\n${broken} app${broken === 1 ? "" : "s"} unhealthy. Fix the connection at ` +
          "mcp.zapier.com before relying on the feature it backs."
      : "\nAll checked apps answered.",
  );
  process.exit(broken ? 2 : 0);
}

main().catch((error) => {
  console.error(`\nProbe failed: ${error.message}`);
  process.exit(1);
});
