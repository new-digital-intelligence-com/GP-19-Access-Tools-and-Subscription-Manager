import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Claude Haiku 4.5 has a 200K context window. These budgets are set against
 * that: the agent is handed a curated slice of the Zapier catalogue rather
 * than all 127 tools, because a long tool list on a small model costs accuracy
 * as well as tokens — and picking the wrong provisioning tool is not a
 * cosmetic error here.
 */
export const TOKEN_BUDGET = {
  /** Max characters of a single tool result fed back to the model. */
  toolResultChars: 16000,
  /** Max prior messages replayed on each turn. */
  historyMessages: 30,
  /** Max tool-calling rounds before giving up. */
  maxTurns: 12,
  /** Response cap per turn. */
  maxTokens: 8000,
};

function checkApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "The assistant's API key is not set. Copy .env.example to .env.local and " +
        "fill in ANTHROPIC_API_KEY — the README says where to get one.",
    );
  }
}

/** Reads ANTHROPIC_API_KEY from the environment. */
export const anthropic = new Anthropic();

/**
 * Haiku 4.5 predates adaptive thinking and `output_config.effort` — both are
 * rejected on this model, so neither is set anywhere in this app.
 */
export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

/** Anthropic rejects `max_tokens` omissions and unknown params; keep this shared. */
export async function complete({
  system,
  prompt,
  maxTokens = 2000,
  temperature = 0.4,
}: {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  checkApiKey();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Consistent, human error text for model failures. */
export function explainModelError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (/rate_limit|429/i.test(message)) {
    return {
      message: "Rate limited by the model provider. Wait a moment and retry.",
      status: 429,
    };
  }
  if (/authentication|401|api key|ANTHROPIC_API_KEY/i.test(message)) {
    return {
      message: "The assistant's API key is missing or invalid. Check .env.local.",
      status: 401,
    };
  }
  return { message, status: 500 };
}

export { checkApiKey };
