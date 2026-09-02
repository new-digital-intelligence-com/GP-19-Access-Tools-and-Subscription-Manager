import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { MODEL, TOKEN_BUDGET, anthropic, checkApiKey } from "./anthropic";
import { NATIVE_TOOLS, isNativeTool, runNativeTool } from "./native-tools";
import { callTool, listTools as listZapierTools, zapierConfigured } from "./zapier";

export type ChatMessage = Anthropic.MessageParam;

/**
 * The agent's Zapier surface, deliberately narrow.
 *
 * Two filters apply. The first is relevance: 127 tools on a small model costs
 * accuracy as well as tokens, and Drive, Sheets and Slack have nothing to do
 * with who holds a licence. The second is authority: every tool that *changes*
 * access — create, suspend, delete a user; add or remove a group member;
 * assign or revoke a licence — is excluded outright.
 *
 * The agent can therefore read the whole identity estate and change none of
 * it. Provisioning happens on the approval path in `requests.ts`, where a
 * named human has already decided. A model cannot be prompted past a tool it
 * was never given.
 */
const READ_ONLY_PREFIXES = ["google_workspace_admin_find_"];

const ALLOWED_EXACT = new Set([
  "google_workspace_admin_make_api_get_request",
  // A draft is inert — it lands in the operator's own mailbox and sends only
  // when a person clicks send, which makes "draft the offboarding note" safe.
  "gmail_create_draft",
  "gmail_find_email",
  // Zapier's own resolvers, needed to turn a label into a real id.
  "list_dynamic_enum_values",
  "get_dynamic_properties_schema",
]);

/** Never handed to the model, whatever else matches. */
const DENIED = [
  // BambooHR is present in the Zapier server but is not wired into this app —
  // its connection was not authorised, and a half-working HR source is worse
  // than none: the model would read a 401 as "no employees" and answer that
  // nobody has left. Denied outright rather than left to fail at runtime.
  "bamboohr_find_employee",
  "bamboohr_get_summary_of_who_s_out",
  "bamboohr_make_api_get_request",
  "bamboohr_make_api_mutating_request",
  "bamboohr_create_employee",
  "bamboohr_update_employee",
  "bamboohr_respond_to_time_off_request",
  "bamboohr_upload_employee_file",
  "bamboohr_add_timesheet_clock_entries",
  "google_workspace_admin_create_user",
  "google_workspace_admin_update_user",
  "google_workspace_admin_delete_user",
  "google_workspace_admin_suspend_user",
  "google_workspace_admin_add_user_to_group",
  "google_workspace_admin_remove_user_from_group",
  "google_workspace_admin_assign_license",
  "google_workspace_admin_revoke_license",
  "google_workspace_admin_assign_role_to_user",
  "google_workspace_admin_remove_role_from_user",
  "google_workspace_admin_create_group",
  "google_workspace_admin_make_api_mutating_request",
  "gmail_send_email",
  "gmail_delete_email",
  // Posting to a shared space is an outward action with no audit entry behind
  // it. The agent does not need one: `raise_request` notifies the approver
  // through the app's own path, which records who was told and when. Leaving
  // the raw tool available would let the model announce things to a room with
  // nothing in the trail to say it did.
  "google_chat_create_message",
];

export function agentMayCall(name: string): boolean {
  // Fail closed on the whole app, not just the tools listed today: a tool
  // added to the Zapier server later must not silently become reachable.
  if (name.startsWith("bamboohr")) return false;
  if (DENIED.includes(name)) return false;
  if (ALLOWED_EXACT.has(name)) return true;
  return READ_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The Zapier tools the agent gets, as Anthropic tool definitions. */
async function zapierToolDefs(): Promise<Anthropic.Tool[]> {
  if (!zapierConfigured()) return [];
  const tools = await listZapierTools();
  return tools
    .filter((tool) => agentMayCall(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: (tool.description ?? "").slice(0, 900),
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
}

/**
 * The tool-calling loop.
 *
 * Anthropic differs from OpenAI-shaped APIs in three ways that matter here:
 * the system prompt is a top-level parameter rather than a message, tool calls
 * arrive as `tool_use` content blocks (not a `tool_calls` array), and results
 * go back as `tool_result` blocks inside a *user* message.
 */
export async function runAgent({
  system,
  messages,
  actor,
  appUrl,
}: {
  system: string;
  messages: ChatMessage[];
  /** Who the conversation is attributed to in the audit trail. */
  actor: string;
  appUrl?: string;
}): Promise<{ reply: string; trace: string[] }> {
  checkApiKey();

  const tools: Anthropic.ToolUnion[] = [...NATIVE_TOOLS, ...(await zapierToolDefs())];
  const conversation: ChatMessage[] = [...trimHistory(messages)];
  const trace: string[] = [];

  for (let turn = 0; turn < TOKEN_BUDGET.maxTurns; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: TOKEN_BUDGET.maxTokens,
      system,
      messages: conversation,
      tools,
    });

    conversation.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const reply = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { reply, trace };
    }

    const calls = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    trace.push(...calls.map((call) => call.name));

    const blocks: Anthropic.ToolResultBlockParam[] = await Promise.all(
      calls.map(async (call) => ({
        type: "tool_result" as const,
        tool_use_id: call.id,
        content: truncate(
          await dispatch(call.name, (call.input ?? {}) as Record<string, unknown>, {
            actor,
            appUrl,
          }),
        ),
      })),
    );

    conversation.push({ role: "user", content: blocks });
  }

  return {
    reply: "I hit the tool-call limit before finishing. Try a narrower request.",
    trace,
  };
}

async function dispatch(
  name: string,
  input: Record<string, unknown>,
  context: { actor: string; appUrl?: string },
): Promise<string> {
  if (isNativeTool(name)) return runNativeTool(name, input, context);

  // Belt and braces: the tool list already excludes these, but a model can
  // hallucinate a name, and a hallucinated `revoke_license` must fail closed.
  if (!agentMayCall(name)) {
    return JSON.stringify({
      error:
        `${name} is not available to the assistant. Changing access requires a human ` +
        "approval in the app — raise a request instead, or tell the operator what to do.",
    });
  }

  const result = await callTool(name, input);
  return result.ok
    ? result.text || JSON.stringify(result.data)
    : JSON.stringify({ error: result.error, tool: name });
}

/** Long tool output is trimmed rather than dropped, so the model still sees
 *  the shape of the result and can say what it truncated. */
function truncate(text: string): string {
  return text.length > TOKEN_BUDGET.toolResultChars
    ? `${text.slice(0, TOKEN_BUDGET.toolResultChars)}\n...[truncated]`
    : text;
}

/** A tool result must never lead: it would orphan its assistant tool_use. */
function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  const recent = messages.slice(-TOKEN_BUDGET.historyMessages);
  const start = recent.findIndex((m) => m.role === "user");
  return start <= 0 ? recent : recent.slice(start);
}
