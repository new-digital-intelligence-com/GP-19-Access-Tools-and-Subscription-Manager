"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, ErrorNote, Note, inputClass } from "@/components/ui";
import type { ZapierStatus } from "@/lib/types";
import { Markdown } from "@/components/Markdown";

/**
 * The assistant, over the same register the rest of the console reads.
 *
 * It is a reading surface with exactly one thing it can write: `raise_request`,
 * which creates a pending request and routes it to a named human. There is no
 * approve, grant, revoke or suspend tool anywhere in its toolset, and the note
 * under the composer says so permanently rather than once. That line is not
 * decoration — a model with no approve tool can still write "I've approved
 * that", and a reader who believes it is exactly as badly served as one whose
 * access really was granted by a bot.
 *
 * The tool-call chips above each answer are the other half of the same point:
 * they show what was actually looked at, so an answer built from nothing is
 * visibly an answer built from nothing.
 */

type Message = { role: "user" | "assistant"; content: string; trace?: string[] };

const SUGGESTIONS = [
  "Which accounts still hold access after being suspended?",
  "What are we paying for that nobody uses?",
  "Who has access to the sensitive tools?",
  "Raise a Figma request for someone",
];

type Status = {
  zapier: ZapierStatus;
  model: { configured: boolean };
  operator: { email: string; configured: boolean };
};

export function AskPanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  // What the assistant can and cannot reach, said before the first question
  // rather than discovered from a thin answer.
  useEffect(() => {
    fetch("/api/status")
      .then((res) => (res.ok ? (res.json() as Promise<Status>) : Promise.reject(new Error())))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setError(null);
    const next: Message[] = [...messages, { role: "user", content: question }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The whole conversation goes back every turn: the agent is stateless
        // and a follow-up like "and revoke the second one" is unreadable
        // without the turn that listed them.
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }),
      });
      const body: unknown = await res.json().catch(() => null);
      const field = (key: string): string | undefined => {
        if (typeof body !== "object" || body === null) return undefined;
        const value = (body as Record<string, unknown>)[key];
        return typeof value === "string" ? value : undefined;
      };
      if (!res.ok) {
        setError(field("error") ?? `The assistant failed with status ${res.status}.`);
        return;
      }
      const trace = (body as { trace?: unknown } | null)?.trace;
      setMessages([
        ...next,
        {
          role: "assistant",
          content: field("reply") ?? "The model returned nothing.",
          trace: Array.isArray(trace) ? trace.filter((n): n is string => typeof n === "string") : [],
        },
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message
          ? `The request did not complete: ${caught.message}`
          : "The request did not complete. Nothing was sent to the model.",
      );
    } finally {
      setBusy(false);
    }
  }

  const modelDown = status !== null && !status.model.configured;
  const providerDown = status !== null && status.zapier.state !== "ready";

  return (
    <div className="flex min-h-[60vh] flex-col">
      <div className="flex-1 space-y-4">
        {modelDown ? (
          <ErrorNote>
            The assistant is not configured, so every question here will fail. The rest of the
            console does not need it: approvals, provisioning and reviews all still work.
          </ErrorNote>
        ) : null}

        {providerDown ? (
          <Note>
            The integration connection is {status?.zapier.state}
            {status?.zapier.detail ? `: ${status.zapier.detail}` : "."} The assistant can still
            read this app&rsquo;s own register — the catalogue, the entitlements, requests, reviews
            and the audit trail — but it cannot look anything up in Google Workspace, so treat any
            answer about accounts as unavailable rather than as no accounts.
          </Note>
        ) : null}

        {messages.length === 0 ? (
          <div className="space-y-4">
            <p className="text-sm text-black/55">
              Ask about the register: who holds what, what is going unused, what a request or a
              revoke actually did. The assistant reads; it does not decide.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => void send(suggestion)}
                  disabled={busy}
                  className="rounded-xl border border-black/10 bg-white px-4 py-3 text-left text-sm transition hover:border-brand/40 hover:bg-brand/[0.03] disabled:opacity-40"
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <Card className="text-sm text-black/55">
              <p>
                The last one raises a pending request and routes it to whoever owns the tool. That
                is the only thing said in this panel that reaches anybody: the request waits for a
                named approver in the Requests tab, and nothing is provisioned until they decide.
              </p>
            </Card>
          </div>
        ) : null}

        {messages.map((message, index) => (
          <div key={index} className={message.role === "user" ? "flex justify-end" : ""}>
            <div
              className={
                message.role === "user"
                  ? "max-w-[85%] rounded-2xl bg-black px-4 py-2.5 text-sm text-white"
                  : "max-w-[85%] space-y-2"
              }
            >
              {message.role === "assistant" && message.trace && message.trace.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {message.trace.map((call, position) => (
                    <span
                      key={position}
                      className="rounded-md bg-black/[0.05] px-2 py-0.5 font-mono text-[11px] text-black/55"
                    >
                      {call}
                    </span>
                  ))}
                </div>
              ) : null}
              {message.role === "assistant" && message.trace && message.trace.length === 0 ? (
                <p className="text-[11px] text-black/40">
                  answered without calling a tool — from the conversation, not from the register
                </p>
              ) : null}
              {/* The model writes Markdown whether or not it was asked to. The
                  reader's own message is shown verbatim — rendering their text
                  as Markdown would mangle an address or a justification that
                  happens to contain an asterisk. */}
              {message.role === "assistant" ? (
                <Markdown text={message.content} />
              ) : (
                <div className="text-sm leading-relaxed whitespace-pre-wrap">
                  {message.content}
                </div>
              )}
            </div>
          </div>
        ))}

        {busy ? <p className="text-sm text-black/45">Reading the register…</p> : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
        className="mt-4 space-y-2 border-t border-black/10 pt-4"
      >
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask about access, spend, requests or the trail…"
            disabled={busy}
            className={inputClass}
          />
          <Button type="submit" disabled={busy || !input.trim()}>
            {busy ? "Working…" : "Send"}
          </Button>
        </div>
        <p className="text-xs text-black/45">
          The assistant cannot approve or provision anything. The most it can do is raise a
          request, and a person decides it.
        </p>
      </form>
    </div>
  );
}
