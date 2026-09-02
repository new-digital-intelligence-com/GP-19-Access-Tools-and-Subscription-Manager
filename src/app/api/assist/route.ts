import { NextResponse } from "next/server";
import { complete, explainModelError } from "@/lib/anthropic";
import { getSettings, voicePrompt } from "@/lib/settings";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * Drafting help for the four places in this app where someone has to write
 * prose: a justification on a request, a note on a decision, the summary of a
 * review campaign, and the brief that goes with an offboard.
 *
 * Tool-free on purpose. These are single completions over facts the caller
 * already has on screen — giving the model a tool here would only let it go
 * looking for facts the panel did not ask about, at several times the cost.
 *
 * The whole risk in this endpoint is fabrication. A drafted justification that
 * invents a business reason does not merely read badly: it gets access
 * approved on grounds nobody ever offered, and the approval trail then records
 * a decision made against a fiction. So every prompt is built from the request
 * body and nothing else, required facts are checked before the model is called
 * at all, and a thin body comes back as a 400 rather than as fluent invention.
 */

const KINDS = ["justification", "decision-note", "review-summary", "offboard-brief"] as const;

type Kind = (typeof KINDS)[number];

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** Outranks the per-kind brief, and says so, because the brief asks for prose. */
const GUARD = `Ground rules. These outrank everything else you are asked for below.

- Use only the facts given. Do not invent a business reason, a project, a
  customer, a deadline, a policy, a cost, a date, a job title or a name that is
  not in front of you. Do not soften a gap by guessing what was probably meant.
- A blank or short answer is better than a plausible invention. If the facts are
  too thin to write what was asked for, write one sentence naming what is
  missing, and nothing else.
- Never state that access was granted, removed, approved or denied unless the
  facts say it was. An attempted removal that failed is not a removal.
- Write plain sentences for a busy reader. No greeting, no sign-off, no
  headings, no bullet characters unless the brief asks for a list, no markdown,
  no emoji, no exclamation marks, no em dashes.
- Output the text itself and nothing else: no preamble, no "here is", no
  options to choose between, no quotes around it.`;

type Draft = { system: string; prompt: string; maxTokens: number };
type Built = { ok: true; draft: Draft } | { ok: false; error: string };

function bad(error: string): Built {
  return { ok: false, error };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function points(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((entry) => text(entry) || scalar(entry)).filter(Boolean);
}

/**
 * Rows are rendered field by field rather than summarised here.
 *
 * The panels own their row shapes and will grow fields; a formatter that knows
 * the shape would silently drop whatever it had not been taught, and a dropped
 * `appliedAt` or `status` is exactly the field that decides whether the draft
 * is true. Every key present is shown, so the model reads what the caller sent.
 */
function describeRow(row: unknown): string {
  if (row === null || typeof row !== "object") return scalar(row);
  return Object.entries(row as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${scalar(value)}`)
    .join("; ");
}

function rowList(rows: unknown): string[] {
  return Array.isArray(rows) ? rows.map((row) => `- ${describeRow(row)}`) : [];
}

function fieldOf(row: unknown, key: string): string {
  if (row === null || typeof row !== "object") return "";
  return scalar((row as Record<string, unknown>)[key]).trim().toLowerCase();
}

function facts(lines: (string | false | undefined)[]): string {
  return lines.filter(Boolean).join("\n");
}

function justification(body: Record<string, unknown>): Built {
  const toolName = text(body.toolName);
  const role = text(body.role);
  const reason = text(body.reason);

  if (!toolName) return bad("A tool name is required to draft a justification.");
  if (!reason) {
    return bad(
      "A justification needs the requester's own reason to work from. Nothing was given, " +
        "and a business case invented here would be read by an approver as the requester's. " +
        "Type a line about what the access is for and try again.",
    );
  }

  return {
    ok: true,
    draft: {
      system: `You write the business justification on an access request, in the requester's
voice, first person. Two or three sentences, no more. An approver who has never
met this person reads it and decides: it has to say what the access is for and
what work stops without it, in the requester's own terms. It is not a plea and
not a policy statement. Do not name a manager, a project, a customer or a date
unless the reason below names one.`,
      prompt: facts([
        `Tool: ${toolName}`,
        role && `Role or plan tier requested: ${role}`,
        `The requester's reason, verbatim:\n${reason}`,
      ]),
      maxTokens: 500,
    },
  };
}

function decisionNote(body: Record<string, unknown>): Built {
  const toolName = text(body.toolName);
  const requester = text(body.requester);
  const decision = text(body.decision).toLowerCase();
  const reasons = points(body.points);

  if (!toolName) return bad("A tool name is required to draft a decision note.");
  if (!requester) {
    return bad("The requester is required: a decision note is written to a named person.");
  }
  if (decision !== "approve" && decision !== "deny") {
    return bad('Decision must be either "approve" or "deny".');
  }
  // Mirrors `deny()` in the requests library, which refuses a blank reason for
  // the same reason: a denial the requester cannot act on is a dead end, and
  // the model would have to make the reason up to fill the gap.
  if (decision === "deny" && reasons.length === 0) {
    return bad(
      "A denial needs at least one point to work from. The requester has to be told what " +
        "would change the answer, and that cannot be invented here.",
    );
  }

  const brief =
    decision === "approve"
      ? `You write the note that goes out with an approved access request. Two or
three sentences to the requester. Confirm what was approved and any condition or
expiry attached to it, then say what happens next. Provisioning is attempted
after approval and can still fail, so do not promise the access is live; say it
has been approved and that they will see it once it is applied.`
      : `You write the note that goes out with a denied access request. Two or three
sentences to the requester, direct and not apologetic. Say what was denied and
why, in the words of the points below. It must end by saying what would change
the answer: the concrete thing they could do, provide or wait for. Do not offer
a route that the points do not support, and do not invent an alternative tool.`;

  return {
    ok: true,
    draft: {
      system: brief,
      prompt: facts([
        `Tool: ${toolName}`,
        `Requester (this note is addressed to them): ${requester}`,
        `Decision: ${decision === "approve" ? "approved" : "denied"}`,
        reasons.length
          ? `Points the approver gave, and the only grounds you may use:\n${reasons
              .map((point) => `- ${point}`)
              .join("\n")}`
          : "The approver gave no further points. Keep the note to the decision itself.",
      ]),
      maxTokens: 500,
    },
  };
}

function reviewSummary(body: Record<string, unknown>): Built {
  const campaignName = text(body.campaignName);
  if (!campaignName) return bad("A campaign name is required to summarise a review.");

  const rows = Array.isArray(body.rows) ? body.rows : [];

  // Counted here rather than left to the model: "how many are still undecided"
  // is the one number a review summary must not get wrong, and arithmetic over
  // a long list is the part a small model is worst at.
  let keep = 0;
  let revoke = 0;
  let undecided = 0;
  let applied = 0;
  for (const row of rows) {
    const decision = fieldOf(row, "decision");
    if (decision === "keep") keep++;
    else if (decision === "revoke") revoke++;
    else undecided++;
    if (fieldOf(row, "appliedAt")) applied++;
  }

  return {
    ok: true,
    draft: {
      system: `You summarise the outcome of an access review campaign for the people who have
to sign it off. One paragraph, four to six sentences. Cover what was in scope,
what was kept, what was marked for removal, and what has actually been carried
out so far.

Be honest about what is unfinished. If any item is still undecided, say so and
give the number in the same breath as the totals, never as a footnote: a review
reported as complete when nobody looked at part of it is a false record, and it
is signed off on the strength of this paragraph. A decision of "revoke" is a
decision, not a removal; only call something removed where the row says it was
applied. Do not name individual people unless naming one is the point, and do
not recommend anything that the rows do not support.`,
      prompt: facts([
        `Campaign: ${campaignName}`,
        `Items in the campaign: ${rows.length}`,
        `Counted from the rows: ${keep} kept, ${revoke} marked for removal, ${undecided} still undecided, ${applied} carried out.`,
        rows.length
          ? `Rows:\n${rowList(rows).join("\n")}`
          : "The campaign has no items. Say that plainly and do not describe an outcome.",
      ]),
      maxTokens: 900,
    },
  };
}

function offboardBrief(body: Record<string, unknown>): Built {
  const person = text(body.person);
  if (!person) return bad("A person is required to draft an offboarding brief.");

  const entitlements = Array.isArray(body.entitlements) ? body.entitlements : [];
  const workspace =
    typeof body.workspaceActive === "boolean"
      ? body.workspaceActive
        ? "The Google Workspace account is active. Until it is suspended, the person can still sign in, and any access that hangs off the account persists."
        : "The Google Workspace account is not active: it is already suspended, or no account was found for this address."
      : "The state of the Google Workspace account was not reported. Say that it could not be read rather than assuming either way.";

  return {
    ok: true,
    draft: {
      system: `You write the short brief an operator reads immediately before offboarding
someone. Its whole job is to be exact about the difference between what will be
taken away and what will not, because everything in the second list is still
live access after the offboard is run and somebody has to go and deal with it by
hand.

Structure: one opening sentence naming the person, then a plain list of what
will be removed, then a plain list of what will not be and why, then the state
of the Workspace account. Keep it under about 150 words. Use "- " for the list
lines.

How to read the entitlement rows.
- status "active": held now, and in scope for removal.
- status "pending-revoke": a previous removal was attempted and FAILED. The
  person may still hold it. It is not removed; list it under what will not be
  removed, and say a human has to finish it.
- status "revoked": already gone. Do not list it as being removed now.
- provisioning "google-group" or "google-license": the app can remove this
  itself.
- provisioning "manual": there is no API path, so the app cannot remove it.
  Somebody has to do it in the vendor's own console. It belongs under what will
  not be removed.
If a row does not say how it is provisioned, say the method is not recorded
rather than assuming the app can remove it.`,
      prompt: facts([
        `Person being offboarded: ${person}`,
        workspace,
        entitlements.length
          ? `Entitlements on record (${entitlements.length}):\n${rowList(entitlements).join("\n")}`
          : "No entitlements are on record for this person in this app. Say so plainly, and note that it means nothing was recorded here, not that they hold no access anywhere.",
      ]),
      maxTokens: 900,
    },
  };
}

function build(kind: Kind, body: Record<string, unknown>): Built {
  switch (kind) {
    case "justification":
      return justification(body);
    case "decision-note":
      return decisionNote(body);
    case "review-summary":
      return reviewSummary(body);
    case "offboard-brief":
      return offboardBrief(body);
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "The request body must be JSON." }, { status: 400 });
  }

  if (!isKind(body.kind)) {
    return NextResponse.json(
      { error: `Unknown kind. Expected one of: ${KINDS.join(", ")}.` },
      { status: 400 },
    );
  }

  const built = build(body.kind, body);
  if (!built.ok) {
    return NextResponse.json({ error: built.error }, { status: 400 });
  }

  try {
    const settings = await getSettings();
    const drafted = await complete({
      system: [built.draft.system, GUARD, voicePrompt(settings)].join("\n\n"),
      prompt: built.draft.prompt,
      maxTokens: built.draft.maxTokens,
      // Lower than the shared default. These drafts are reports of fact that a
      // person acts on, and the variety a higher temperature buys is bought
      // with exactly the embellishment the ground rules forbid.
      temperature: 0.2,
    });

    return NextResponse.json({ text: drafted });
  } catch (error) {
    const { message, status } = explainModelError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
