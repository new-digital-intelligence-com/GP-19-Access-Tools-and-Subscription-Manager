"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  Confirm,
  Empty,
  ErrorNote,
  Field,
  Loading,
  Note,
  OkNote,
  Pill,
  SectionTitle,
  Table,
  Td,
  When,
  inputClass,
} from "@/components/ui";
import type { AccessRequest, Tool } from "@/lib/types";
import { ACTION_PASSWORD_HEADER } from "@/lib/guard-header";

/**
 * The approval surface.
 *
 * Everything here is arranged around one rule: an approver is about to change
 * somebody's real access, and the screen has to tell them exactly what will
 * happen before they click and exactly what did happen afterwards.
 *
 * So the confirmation names the provider call ("adds them to marketing@acme.com"),
 * never "are you sure"; a request nobody was notified about says so in red
 * rather than looking identical to one that was routed; and a decision whose
 * provisioning step failed is shown as a recorded approval with dead access,
 * because that is what it is. The panel never says "granted" on the strength of
 * having asked.
 */

type RequestRow = AccessRequest & { toolName: string };
type Feed = { requests: RequestRow[]; tools: Tool[]; domain?: string };
type Filter = "pending" | "all" | "decided";
type ActionKind = "approve" | "deny" | "cancel";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "all", label: "All" },
  { id: "decided", label: "Decided" },
];

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function readJson<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `The request failed with status ${res.status}.`;
    throw new Error(detail);
  }
  return body as T;
}

function post<T>(url: string, body: unknown, password?: string): Promise<T> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(password ? { [ACTION_PASSWORD_HEADER]: password } : {}),
    },
    body: JSON.stringify(body),
  }).then(readJson<T>);
}

/**
 * What approving actually does to the provider, in the provider's own terms.
 *
 * A gap in the catalogue entry is named here too: `approve()` refuses those,
 * and an approver deserves to read that before clicking rather than after.
 */
/**
 * Mirrors `outsideDomain` in the settings library, which is server-only.
 *
 * A warning, never a block: plenty of legitimate people sit on another domain.
 * The point is that the address is the field nobody re-reads, and it decides
 * who actually ends up with the access.
 */
function outsideDomain(email: string, domain?: string): string | null {
  const expected = (domain ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!expected) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return `${email} is not an email address.`;
  const theirs = email.slice(at + 1).trim().toLowerCase();
  if (theirs === expected || theirs.endsWith(`.${expected}`)) return null;
  return `${email} is outside ${expected}.`;
}

function grantEffect(tool: Tool | undefined, person: string, toolName: string): string {
  if (!tool) {
    return (
      `the catalogue entry for ${toolName} could not be read here, so what this changes in ` +
      "the provider cannot be named"
    );
  }
  switch (tool.provisioning) {
    case "google-group":
      return tool.groupEmail
        ? `adds ${person} to the Google group ${tool.groupEmail}`
        : `no group address is set on ${tool.name}, so the approval will be refused until the catalogue entry is fixed`;
    case "google-license":
      return tool.productId && tool.skuId
        ? `assigns Google licence ${tool.skuId} to ${person} and uses a paid seat`
        : `no productId or skuId is set on ${tool.name}, so the approval will be refused until the catalogue entry is fixed`;
    case "slack-channel":
      return tool.slackChannelId
        ? `invites ${person} to the Slack channel ${tool.slackChannelId}`
        : `no Slack channel is set on ${tool.name}, so the approval will be refused until the catalogue entry is fixed`;
    case "manual":
      return (
        `records the approval only. ${tool.vendor || tool.name} has no API path, so somebody ` +
        `still has to grant it by hand in the vendor console before ${person} can sign in`
      );
  }
}

function revocationHint(tool: Tool | undefined): string {
  if (tool?.provisioning === "manual") {
    return "Undoing it means removing the access by hand and marking the entitlement revoked.";
  }
  return "Undoing it means revoking the entitlement in the register, which is a second provider call.";
}

/** Honest reading of a decided request. Green only when the provider agreed. */
function Outcome({ request, tool }: { request: RequestRow; tool: Tool | undefined }) {
  const detail = request.provisionResult?.detail;
  const manual = tool?.provisioning === "manual";

  if (request.status === "failed") {
    return (
      <ErrorNote>
        Provisioning failed and the access is not live. {detail ?? "No detail was returned."} The
        approval stands and is recorded against {request.decidedBy ?? "the approver"} — it is the
        grant that did not happen. Fix the cause and revoke or re-raise, but do not tell{" "}
        {request.requesterEmail} they have access.
      </ErrorNote>
    );
  }

  if (request.status === "provisioned" && manual) {
    return (
      <Note>
        Approved and recorded, and nothing was provisioned by API.{" "}
        {detail ?? `${request.toolName} has no API path.`} The access is not live until somebody
        does it in the vendor console.
      </Note>
    );
  }

  if (request.status === "provisioned") {
    return <OkNote>Provisioned. {detail ?? "The provider confirmed the grant."}</OkNote>;
  }

  if (request.status === "approved") {
    return (
      <Note>
        Approved, and no provisioning result came back. Treat the access as not yet live and check
        the audit trail before telling {request.requesterEmail} anything.
      </Note>
    );
  }

  if (request.status === "denied") {
    return (
      <div className="rounded-xl bg-black/[0.04] px-4 py-3 text-sm text-black/70">
        Denied by {request.decidedBy ?? "an approver"}
        {request.decisionNote ? `: ${request.decisionNote}` : "."} Nothing was provisioned.
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-black/[0.04] px-4 py-3 text-sm text-black/70">
      Withdrawn before a decision. Nothing was provisioned.
    </div>
  );
}

export function RequestsPanel() {
  const [filter, setFilter] = useState<Filter>("pending");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [approver, setApprover] = useState<{ email: string; configured: boolean } | null>(null);

  // The raise-a-request form.
  const [requesterEmail, setRequesterEmail] = useState("");
  const [requesterName, setRequesterName] = useState("");
  const [toolId, setToolId] = useState("");
  const [role, setRole] = useState("");
  const [justification, setJustification] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formOk, setFormOk] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [drafting, setDrafting] = useState(false);

  // Decisions.
  const [action, setAction] = useState<{ kind: ActionKind; request: RequestRow } | null>(null);
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<RequestRow | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  // `loading` starts true and `load` does not set it, so that the mount effect
  // below triggers no synchronous state update — React flags that as a
  // cascading render, and it is also just wasted work when the initial value is
  // already correct. A manual refresh raises the flag itself, from the handler.
  const load = useCallback(async () => {
    try {
      // "decided" is a view over the same read: the API filters on one status at
      // a time, and splitting client-side keeps the counts on both lists honest.
      const query = filter === "pending" ? "pending" : "all";
      setFeed(await readJson<Feed>(await fetch(`/api/requests?status=${query}`)));
      setLoadError(null);
    } catch (error) {
      setFeed(null);
      setLoadError(message(error));
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    // Deferred by a microtask rather than called straight from the effect body.
    // `load` updates state, and doing that synchronously during the effect
    // flush costs a cascading render for no benefit — the first paint already
    // shows the loading state.
    void Promise.resolve().then(load);
  }, [load]);

  // Only to name who the decision will be attributed to. `approve()` refuses an
  // unattributed one outright, so it is worth saying before the dialog opens.
  useEffect(() => {
    fetch("/api/status")
      .then(readJson<{ operator: { email: string; configured: boolean } }>)
      .then((data) => setApprover(data.operator))
      .catch(() => setApprover(null));
  }, []);

  const tools = feed?.tools ?? [];
  const domain = feed?.domain;
  const selectedTool = tools.find((tool) => tool.id === toolId);
  const toolOf = (id: string): Tool | undefined => tools.find((tool) => tool.id === id);

  const all = feed?.requests ?? [];
  const pending = all.filter((request) => request.status === "pending");
  const decided = all.filter((request) => request.status !== "pending");
  const shown = filter === "decided" ? [] : pending;

  async function draft() {
    setFormError(null);
    if (!selectedTool) {
      setFormError("Choose the tool first — the draft is written from the tool and your reason.");
      return;
    }
    if (!justification.trim()) {
      setFormError(
        "Write a line about what the access is for. The draft rewrites your reason and will " +
          "not invent a business case; an approver would read the invention as yours.",
      );
      return;
    }
    setDrafting(true);
    try {
      const data = await post<{ text: string }>("/api/assist", {
        kind: "justification",
        toolName: selectedTool.name,
        role: role || undefined,
        reason: justification,
      });
      setJustification(data.text);
    } catch (error) {
      setFormError(message(error));
    }
    setDrafting(false);
  }

  async function raise(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setFormOk(null);
    setSubmitting(true);
    try {
      const created = await post<{ request: AccessRequest }>("/api/requests", {
        requesterEmail,
        requesterName: requesterName || undefined,
        toolId,
        role: role || undefined,
        justification,
        expiresAt: expiresAt || undefined,
      });
      setFormOk(
        created.request.approverEmail
          ? `Raised and routed to ${created.request.approverEmail}. Nothing is provisioned until they approve.`
          : "Raised, but there is nobody to route it to: the tool has no owner and Settings lists no approvers. Use notify again once one is set.",
      );
      setRequesterEmail("");
      setRequesterName("");
      setRole("");
      setJustification("");
      setExpiresAt("");
      setFilter("pending");
      await load();
    } catch (error) {
      setFormError(message(error));
    }
    setSubmitting(false);
  }

  function open(kind: ActionKind, request: RequestRow) {
    setAction({ kind, request });
    setNote("");
    setActionError(null);
    setResult(null);
  }

  async function decide(password: string) {
    if (!action) return;
    // The API refuses a blank denial note with a message worth reading, but the
    // approver should not have to make the round trip to find that out.
    if (action.kind === "deny" && !note.trim()) {
      setActionError(
        "A denial needs a reason. The requester has to be told what would change the answer.",
      );
      return;
    }
    setBusy(action.request.id);
    setActionError(null);
    try {
      const data = await post<{ request: AccessRequest }>(
        "/api/requests/decide",
        {
          id: action.request.id,
          decision: action.kind,
          note: note.trim() || undefined,
        },
        // Only an approval is gated server-side; sending the header on a deny
        // would be harmless but misleading about what the pause is protecting.
        action.kind === "approve" ? password : undefined,
      );
      setResult({ ...data.request, toolName: action.request.toolName });
      setAction(null);
      setNote("");
      await load();
    } catch (error) {
      setActionError(message(error));
    }
    setBusy(null);
  }

  async function renotify(request: RequestRow) {
    setBusy(request.id);
    setActionError(null);
    setResult(null);
    try {
      const data = await post<{ request: AccessRequest }>("/api/requests/decide", {
        id: request.id,
        decision: "renotify",
      });
      const sent = data.request.notifications?.length ?? 0;
      setActionError(
        sent > 0
          ? null
          : "The re-notify call returned without recording a delivery. Nobody has been told yet.",
      );
      await load();
    } catch (error) {
      setActionError(message(error));
    }
    setBusy(null);
  }

  const dialogTitle =
    action?.kind === "approve"
      ? "Approve and provision"
      : action?.kind === "deny"
        ? "Deny this request"
        : "Withdraw this request";

  const dialogConsequence = !action
    ? ""
    : action.kind === "approve"
      ? `Grants ${action.request.toolName} to ${action.request.requesterEmail} now — ` +
        `${grantEffect(toolOf(action.request.toolId), action.request.requesterEmail, action.request.toolName)}. ` +
        `The decision is recorded against ${approver?.email ?? "the configured operator"} and cannot be ` +
        `taken back from here. ${revocationHint(toolOf(action.request.toolId))}` +
        // Last thing before the password box: the address is what decides who
        // actually receives this, and it is the field nobody re-reads.
        (outsideDomain(action.request.requesterEmail, domain)
          ? ` CHECK THE ADDRESS: ${outsideDomain(action.request.requesterEmail, domain)} Confirm it is the right person.`
          : "")
      : action.kind === "deny"
        ? `Denies ${action.request.toolName} for ${action.request.requesterEmail}. Nothing is provisioned, ` +
          "and the reason you write below is emailed to them as the answer."
        : `Closes this request with no decision. Nothing is granted and ${action.request.requesterEmail} ` +
          "is not notified, so tell them yourself if they are waiting.";

  return (
    <div className="space-y-6">
      <SectionTitle
        right={
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((option) => (
              <button
                key={option.id}
                onClick={() => setFilter(option.id)}
                className={`rounded-xl px-3 py-1.5 text-xs font-medium transition ${
                  filter === option.id
                    ? "bg-brand text-white"
                    : "border border-black/15 text-black/60 hover:border-brand/50 hover:bg-brand/[0.04]"
                }`}
              >
                {option.label}
              </button>
            ))}
            <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => {
              setLoading(true);
              void load();
            }}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        }
      >
        Access requests
      </SectionTitle>

      {approver && !approver.configured ? (
        <ErrorNote>
          No operator address is configured, so a decision made here would be attributed to nobody.
          Approvals are refused until OPERATOR_EMAIL is set in .env.local.
        </ErrorNote>
      ) : null}

      {!action && actionError ? <ErrorNote>{actionError}</ErrorNote> : null}

      {result ? (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {result.requesterEmail}
              <span className="text-black/40"> → </span>
              {result.toolName}
            </p>
            <div className="flex items-center gap-2">
              <Pill state={result.status} />
              <Button
                variant="ghost"
                className="px-3 py-1.5 text-xs"
                onClick={() => setResult(null)}
              >
                Dismiss
              </Button>
            </div>
          </div>
          <Outcome request={result} tool={toolOf(result.toolId)} />
        </Card>
      ) : null}

      <Card className="space-y-4">
        <div>
          <h3 className="font-medium">Raise a request</h3>
          <p className="mt-1 text-sm text-black/55">
            This creates the record an approver decides on and notifies them. It provisions
            nothing: the access only exists once somebody approves it.
          </p>
        </div>

        {loadError ? null : tools.length === 0 && !loading ? (
          <Note>
            The catalogue is empty, so there is nothing to request. Add a tool in the Catalogue tab
            first.
          </Note>
        ) : null}

        <form onSubmit={raise} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Requester email" hint="The person who will hold the access.">
              <input
                className={inputClass}
                type="email"
                required
                value={requesterEmail}
                onChange={(event) => setRequesterEmail(event.target.value)}
                placeholder="priya@acme.com"
              />
            </Field>
            <Field label="Requester name" hint="Optional. Shown to the approver.">
              <input
                className={inputClass}
                value={requesterName}
                onChange={(event) => setRequesterName(event.target.value)}
                placeholder="Priya Nair"
              />
            </Field>
            <Field label="Tool">
              <select
                className={inputClass}
                required
                value={toolId}
                onChange={(event) => {
                  setToolId(event.target.value);
                  setRole("");
                }}
              >
                <option value="">Choose a tool…</option>
                {tools.map((tool) => (
                  <option key={tool.id} value={tool.id}>
                    {tool.name}
                    {tool.vendor ? ` · ${tool.vendor}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Role"
              hint={
                selectedTool?.provisioning === "manual"
                  ? "This tool has no API path: an approval here ends in a task for a human."
                  : "Optional. The plan tier or role being asked for."
              }
            >
              {selectedTool?.roles.length ? (
                <select
                  className={inputClass}
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                >
                  <option value="">No specific role</option>
                  {selectedTool.roles.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={inputClass}
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  placeholder="member"
                />
              )}
            </Field>
          </div>

          <Field
            label="Justification"
            hint="Written to the approver. Draft it rewrites what you type here and stays editable — nothing is sent until you raise the request."
          >
            <textarea
              className={`${inputClass} min-h-28`}
              required
              value={justification}
              onChange={(event) => setJustification(event.target.value)}
              placeholder="What the access is for, and what stops without it."
            />
          </Field>

          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="w-full sm:w-64">
              <Field label="Expires" hint="Optional. Time-bound access is reviewed as it nears.">
                <input
                  className={inputClass}
                  type="date"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" onClick={() => void draft()} disabled={drafting}>
                {drafting ? "Drafting…" : "Draft it"}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Raising…" : "Raise a request"}
              </Button>
            </div>
          </div>
        </form>

        {formError ? <ErrorNote>{formError}</ErrorNote> : null}
        {formOk ? <OkNote>{formOk}</OkNote> : null}
      </Card>

      {loadError ? (
        <ErrorNote>
          The request list could not be read: {loadError}. This is not an empty queue — decisions
          may be waiting and not shown.
        </ErrorNote>
      ) : loading && !feed ? (
        <Loading label="Reading requests…" />
      ) : filter !== "decided" && shown.length === 0 ? (
        <Empty
          title="No request is waiting on a decision"
          hint="Raised requests appear here with everything an approver needs to decide, and stay until somebody does."
        />
      ) : (
        <div className="space-y-4">
          {shown.map((request) => {
            const tool = toolOf(request.toolId);
            const deliveries = request.notifications ?? [];
            return (
              <Card key={request.id} className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-medium">
                      {request.requesterName ?? request.requesterEmail}
                      <span className="text-black/40"> → </span>
                      {request.toolName}
                    </h3>
                    <p className="text-xs text-black/50">
                      {request.requesterEmail} · raised <When at={request.createdAt} />
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill state="pending" />
                    {request.role ? <Pill state="info" label={request.role} /> : null}
                    {tool?.sensitive ? <Pill state="overdue" label="sensitive" /> : null}
                    {tool ? (
                      <Pill state="info" label={tool.provisioning.replace(/-/g, " ")} />
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <p className="text-xs tracking-wide text-black/45 uppercase">
                      Requested expiry
                    </p>
                    <p className="mt-1">
                      {request.expiresAt ? (
                        <When at={request.expiresAt} relative={false} />
                      ) : (
                        <span className="text-black/45">No end date requested</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs tracking-wide text-black/45 uppercase">Routed to</p>
                    <p className="mt-1">
                      {request.approverEmail ?? (
                        <span className="font-medium text-red-700">nobody</span>
                      )}
                    </p>
                  </div>
                </div>

                <div>
                  <p className="text-xs tracking-wide text-black/45 uppercase">Justification</p>
                  <p className="mt-1 rounded-xl bg-black/[0.03] px-4 py-3 text-sm whitespace-pre-wrap">
                    {request.justification}
                  </p>
                </div>

                {!request.approverEmail ? (
                  <ErrorNote>
                    Nobody was told about this request. It has no approver, because the tool has no
                    owner and Settings lists no approvers, so it is waiting somewhere only this
                    screen looks. Set an owner or an approver, then notify again.
                  </ErrorNote>
                ) : deliveries.length === 0 ? (
                  <Note>
                    No notification was recorded for {request.approverEmail}. The message either
                    failed or was never sent, so assume they do not know this request exists.
                  </Note>
                ) : (
                  <div className="rounded-xl bg-black/[0.03] px-4 py-3 text-sm">
                    <p className="text-xs tracking-wide text-black/45 uppercase">Notified</p>
                    <ul className="mt-1 space-y-1">
                      {deliveries.map((delivery, index) => (
                        <li key={index} className="text-black/70">
                          {delivery.channel} · <When at={delivery.at} /> — {delivery.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 border-t border-black/8 pt-4">
                  <Button
                    variant="approve"
                    disabled={busy === request.id}
                    onClick={() => open("approve", request)}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy === request.id}
                    onClick={() => open("deny", request)}
                  >
                    Deny
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy === request.id}
                    onClick={() => void renotify(request)}
                  >
                    {busy === request.id ? "Working…" : "Notify again"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy === request.id}
                    onClick={() => open("cancel", request)}
                  >
                    Withdraw
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {filter !== "pending" && !loadError ? (
        <div className="space-y-3">
          <SectionTitle
            right={
              decided.length ? (
                <Button
                  variant="ghost"
                  className="px-3 py-1.5 text-xs"
                  onClick={() => setShowDecided((open) => !open)}
                >
                  {showDecided ? "Hide" : `Show ${decided.length}`}
                </Button>
              ) : undefined
            }
          >
            Decided
          </SectionTitle>

          {decided.length === 0 ? (
            <Empty
              title="Nothing has been decided yet"
              hint="Approvals, denials and withdrawals stay here permanently, with the note the decider left."
            />
          ) : showDecided ? (
            <Table head={["Decided", "Requester", "Tool", "Outcome", "Decided by", "Note"]}>
              {decided.map((request) => (
                <tr key={request.id}>
                  <Td className="text-black/60">
                    <When at={request.decidedAt ?? request.createdAt} />
                  </Td>
                  <Td>{request.requesterEmail}</Td>
                  <Td>{request.toolName}</Td>
                  <Td>
                    <Pill state={request.status} />
                    {request.status === "failed" ? (
                      <p className="mt-1 text-xs font-medium text-red-700">
                        The approval stands; the access is not live.{" "}
                        {request.provisionResult?.detail}
                      </p>
                    ) : null}
                    {request.status === "approved" ? (
                      <p className="mt-1 text-xs font-medium text-amber-800">
                        Awaiting a manual step — not yet live.
                      </p>
                    ) : null}
                  </Td>
                  <Td className="text-black/60">{request.decidedBy ?? "—"}</Td>
                  <Td className="max-w-xs text-black/60">
                    {request.decisionNote ?? <span className="text-black/35">no note</span>}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : null}
        </div>
      ) : null}

      <Confirm
        open={action !== null}
        title={dialogTitle}
        consequence={dialogConsequence}
        confirmLabel={
          action?.kind === "approve"
            ? "Approve and provision"
            : action?.kind === "deny"
              ? "Deny"
              : "Withdraw"
        }
        variant={action?.kind === "approve" ? "approve" : "danger"}
        requirePassword={action?.kind === "approve"}
        busy={busy !== null}
        onConfirm={(password) => void decide(password)}
        onCancel={() => {
          setAction(null);
          setActionError(null);
        }}
      >
        {action?.kind !== "cancel" ? (
          <Field
            label={action?.kind === "deny" ? "Reason (required)" : "Note (optional)"}
            hint={
              action?.kind === "deny"
                ? "Emailed to the requester as the answer. Say what would change it."
                : "Kept on the request and in the audit trail."
            }
          >
            <textarea
              className={`${inputClass} min-h-24`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                action?.kind === "deny"
                  ? "Ask again with the project named, or use the shared account instead."
                  : "Anything the trail should carry."
              }
            />
          </Field>
        ) : null}
        {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}
      </Confirm>
    </div>
  );
}
