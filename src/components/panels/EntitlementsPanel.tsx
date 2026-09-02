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
import type { Entitlement, Tool } from "@/lib/types";
import { ACTION_PASSWORD_HEADER } from "@/lib/guard-header";

/**
 * The register: who holds what, since when, and on whose authority.
 *
 * The one thing this table must never do is read as tidier than the truth.
 * `pending-revoke` means a removal was attempted and the provider refused it,
 * so the person probably still has the access — every such row says that in
 * words, because a coloured dot next to "revoke" is exactly how somebody
 * concludes the access is gone. Import writes a row and provisions nothing,
 * and says so on the form rather than in a tooltip.
 */

type Row = Entitlement & { toolName: string };
type Feed = { entitlements: Row[]; tools: Tool[] };
type Filters = { personEmail: string; toolId: string; status: string };
type Dialog = { kind: "revoke" | "mark"; row: Row };

const STATUS_OPTIONS: { id: string; label: string }[] = [
  { id: "all", label: "Any status" },
  { id: "active", label: "Active" },
  { id: "pending-revoke", label: "Revoke failed" },
  { id: "revoked", label: "Revoked" },
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

function expired(row: Row): boolean {
  return (
    row.status === "active" && Boolean(row.expiresAt) && Date.parse(row.expiresAt ?? "") <= Date.now()
  );
}

/** What a revoke will actually ask the provider to do, in its own terms. */
function revokeEffect(tool: Tool | undefined, row: Row): string {
  if (!tool) {
    return (
      `The catalogue entry for ${row.toolName} could not be read here, so what this asks the ` +
      "provider to do cannot be named."
    );
  }
  switch (tool.provisioning) {
    case "google-group":
      return tool.groupEmail
        ? `Asks Google to remove ${row.personEmail} from the group ${tool.groupEmail}. They lose ${tool.name} as soon as it takes effect.`
        : `${tool.name} has no group address set, so the call has nothing to act on and will fail.`;
    case "google-license":
      return tool.productId && tool.skuId
        ? `Revokes Google licence ${tool.skuId} from ${row.personEmail} and frees the paid seat.`
        : `${tool.name} has no productId or skuId set, so the call has nothing to act on and will fail.`;
    case "slack-channel":
      return tool.slackChannelId
        ? `Asks Slack to remove ${row.personEmail} from channel ${tool.slackChannelId}. They lose the channel's history and anything posted in it from that moment.`
        : `${tool.name} has no Slack channel set, so the call has nothing to act on and will fail.`;
    case "manual":
      return (
        `${tool.name} has no API path, so nothing is sent to the provider. The row is left ` +
        `pending-revoke and you have to remove ${row.personEmail} in the ` +
        `${tool.vendor || tool.name} console yourself, then mark it revoked.`
      );
  }
}

export function EntitlementsPanel() {
  const [filters, setFilters] = useState<Filters>({ personEmail: "", toolId: "", status: "all" });
  const [personInput, setPersonInput] = useState("");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(
    null,
  );

  const [importEmail, setImportEmail] = useState("");
  const [importName, setImportName] = useState("");
  const [importToolId, setImportToolId] = useState("");
  const [importRole, setImportRole] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importOk, setImportOk] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // `loading` starts true and `load` does not set it, so that the mount effect
  // below triggers no synchronous state update — React flags that as a
  // cascading render, and it is also just wasted work when the initial value is
  // already correct. A manual refresh raises the flag itself, from the handler.
  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filters.personEmail) params.set("personEmail", filters.personEmail);
    if (filters.toolId) params.set("toolId", filters.toolId);
    if (filters.status && filters.status !== "all") params.set("status", filters.status);
    try {
      setFeed(await readJson<Feed>(await fetch(`/api/entitlements?${params.toString()}`)));
      setLoadError(null);
    } catch (error) {
      setFeed(null);
      setLoadError(message(error));
    }
    setLoading(false);
  }, [filters]);

  useEffect(() => {
    // Deferred by a microtask rather than called straight from the effect body.
    // `load` updates state, and doing that synchronously during the effect
    // flush costs a cascading render for no benefit — the first paint already
    // shows the loading state.
    void Promise.resolve().then(load);
  }, [load]);

  /** Kept identity-stable when nothing changed, so a blur is not a refetch. */
  const applyPerson = useCallback(() => {
    const next = personInput.trim().toLowerCase();
    setFilters((current) =>
      current.personEmail === next ? current : { ...current, personEmail: next },
    );
  }, [personInput]);

  const rows = feed?.entitlements ?? [];
  const tools = feed?.tools ?? [];
  const toolOf = (id: string): Tool | undefined => tools.find((tool) => tool.id === id);
  const filtered = Boolean(filters.personEmail || filters.toolId || filters.status !== "all");
  const overdueExpiry = rows.filter(expired);

  function open(kind: Dialog["kind"], row: Row) {
    setDialog({ kind, row });
    setReason("");
    setDialogError(null);
    setOutcome(null);
  }

  async function run(password: string) {
    if (!dialog) return;
    // The API refuses a reasonless revoke, and it is right to: an entitlement
    // that changed state with nothing recorded is unreviewable six months
    // later. Catching it here saves the round trip, and says the same thing.
    if (dialog.kind === "revoke" && !reason.trim()) {
      setDialogError(
        "A reason is required. A revoke with no reason cannot be told apart from a mistake later.",
      );
      return;
    }
    setBusy(true);
    setDialogError(null);
    try {
      if (dialog.kind === "revoke") {
        const data = await readJson<{ ok: boolean; detail: string; entitlement: Entitlement }>(
          await fetch(
            `/api/entitlements?id=${encodeURIComponent(dialog.row.id)}&reason=${encodeURIComponent(reason.trim())}`,
            { method: "DELETE", headers: { [ACTION_PASSWORD_HEADER]: password } },
          ),
        );
        // Three outcomes, and only one of them means the access is gone.
        if (!data.ok) {
          setOutcome({
            tone: "error",
            text:
              `Revoke failed — ${dialog.row.personEmail} may still have ${dialog.row.toolName}. ` +
              `${data.detail} The row is marked pending-revoke, not revoked. Retry, or remove it by ` +
              "hand and then mark it revoked.",
          });
        } else if (data.entitlement.status === "pending-revoke") {
          setOutcome({
            tone: "warn",
            text:
              `Nothing was sent to the provider. ${data.detail} The row stays pending-revoke until ` +
              "somebody does it by hand and marks it revoked.",
          });
        } else {
          setOutcome({
            tone: "ok",
            text: `Revoked. ${data.detail}`,
          });
        }
      } else {
        const data = await readJson<{ entitlement: Entitlement }>(
          await fetch("/api/entitlements", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              [ACTION_PASSWORD_HEADER]: password,
            },
            body: JSON.stringify({ id: dialog.row.id, status: "revoked" }),
          }),
        );
        setOutcome({
          tone: "warn",
          text:
            `The register now says ${data.entitlement.personEmail} no longer has ` +
            `${dialog.row.toolName}. Nothing was sent to the provider — this records what you say ` +
            "you already did by hand, and the audit trail names you as having asserted it.",
        });
      }
      setDialog(null);
      setReason("");
      await load();
    } catch (error) {
      setDialogError(message(error));
    }
    setBusy(false);
  }

  async function importGrant(event: React.FormEvent) {
    event.preventDefault();
    setImportError(null);
    setImportOk(null);
    setImporting(true);
    try {
      const data = await readJson<{ entitlement: Entitlement }>(
        await fetch("/api/entitlements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            personEmail: importEmail,
            personName: importName || undefined,
            toolId: importToolId,
            role: importRole || undefined,
          }),
        }),
      );
      setImportOk(
        `Recorded ${data.entitlement.personEmail} on ${toolOf(importToolId)?.name ?? importToolId}. ` +
          "Nothing was provisioned: this only says the access already exists.",
      );
      setImportEmail("");
      setImportName("");
      setImportRole("");
      await load();
    } catch (error) {
      setImportError(message(error));
    }
    setImporting(false);
  }

  const dialogTool = dialog ? toolOf(dialog.row.toolId) : undefined;

  return (
    <div className="space-y-6">
      <SectionTitle
        right={
          <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => {
              setLoading(true);
              void load();
            }}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        }
      >
        Entitlement register
      </SectionTitle>

      {outcome ? (
        outcome.tone === "error" ? (
          <ErrorNote>{outcome.text}</ErrorNote>
        ) : outcome.tone === "warn" ? (
          <Note>{outcome.text}</Note>
        ) : (
          <OkNote>{outcome.text}</OkNote>
        )
      ) : null}

      {overdueExpiry.length > 0 ? (
        <Card className="space-y-3 border-amber-200 bg-amber-50/60">
          <div>
            <h3 className="font-medium text-amber-900">
              Past the agreed expiry and still active
            </h3>
            <p className="mt-1 text-sm text-amber-800">
              Time-bound access that nobody removed is access nobody agreed to.
              {filtered ? " Counted within the current filter only." : ""}
            </p>
          </div>
          <ul className="space-y-2">
            {overdueExpiry.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {row.personEmail}
                    <span className="text-black/40"> → </span>
                    {row.toolName}
                  </p>
                  <p className="text-xs text-black/50">
                    expired <When at={row.expiresAt} />
                  </p>
                </div>
                <Button
                  variant="danger"
                  className="px-3 py-1.5 text-xs"
                  onClick={() => open("revoke", row)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Person" hint="Exact work email. Leave blank for everyone.">
            <input
              className={inputClass}
              value={personInput}
              onChange={(event) => setPersonInput(event.target.value)}
              onBlur={applyPerson}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyPerson();
                }
              }}
              placeholder="priya@acme.com"
            />
          </Field>
          <Field label="Tool">
            <select
              className={inputClass}
              value={filters.toolId}
              onChange={(event) =>
                setFilters((current) => ({ ...current, toolId: event.target.value }))
              }
            >
              <option value="">Every tool</option>
              {tools.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {tool.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              className={inputClass}
              value={filters.status}
              onChange={(event) =>
                setFilters((current) => ({ ...current, status: event.target.value }))
              }
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={applyPerson}>
            Apply person
          </Button>
          {filtered ? (
            <Button
              variant="ghost"
              className="px-3 py-1.5 text-xs"
              onClick={() => {
                setPersonInput("");
                setFilters({ personEmail: "", toolId: "", status: "all" });
              }}
            >
              Clear filters
            </Button>
          ) : null}
          <span className="tnum text-xs text-black/45">
            {rows.length} {rows.length === 1 ? "row" : "rows"}
          </span>
        </div>
      </Card>

      {loadError ? (
        <ErrorNote>
          The register could not be read: {loadError}. Nothing is shown because the read failed,
          not because nobody has access.
        </ErrorNote>
      ) : loading && !feed ? (
        <Loading label="Reading the register…" />
      ) : rows.length === 0 ? (
        <Empty
          title={filtered ? "No grant matches these filters" : "The register is empty"}
          hint={
            filtered
              ? "Widen the filters, or clear them to see every recorded grant."
              : "Grants appear here once an approved request is provisioned, or once you import access the provider already has."
          }
        />
      ) : (
        <Table
          head={[
            "Person",
            "Tool",
            "Role",
            "Source",
            "Granted",
            "Expires",
            "Last review",
            "Status",
            "",
          ]}
        >
          {rows.map((row) => {
            const tool = toolOf(row.toolId);
            const manual = tool?.provisioning === "manual";
            return (
              <tr key={row.id} className={expired(row) ? "bg-amber-50/40" : undefined}>
                <Td>
                  <span className="font-medium">{row.personName ?? row.personEmail}</span>
                  {row.personName ? (
                    <span className="block text-xs text-black/45">{row.personEmail}</span>
                  ) : null}
                </Td>
                <Td>{row.toolName}</Td>
                <Td className="text-black/60">{row.role ?? "—"}</Td>
                <Td className="text-black/60">
                  {row.source}
                  {row.source === "imported" ? (
                    <span className="block text-xs text-black/45">nobody here granted it</span>
                  ) : null}
                </Td>
                <Td className="text-black/60">
                  <When at={row.grantedAt} />
                  <span className="block text-xs text-black/45">by {row.grantedBy}</span>
                </Td>
                <Td className="text-black/60">
                  {row.expiresAt ? (
                    <>
                      <When at={row.expiresAt} relative={false} />
                      {expired(row) ? (
                        <span className="block text-xs font-medium text-amber-800">
                          expired and still active
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-black/35">no end date</span>
                  )}
                </Td>
                <Td className="text-black/60">
                  {row.lastReviewedAt ? (
                    <>
                      <When at={row.lastReviewedAt} relative={false} />
                      {row.lastReviewDecision ? (
                        <span className="block text-xs text-black/45">
                          decided {row.lastReviewDecision}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-black/35">never reviewed</span>
                  )}
                </Td>
                <Td>
                  <Pill state={row.status} />
                  {row.status === "pending-revoke" ? (
                    <p className="mt-1 max-w-56 text-xs font-medium text-red-700">
                      Revoke failed — access may remain. {row.provisionNote ?? ""}
                    </p>
                  ) : null}
                  {row.status === "active" && manual ? (
                    <p className="mt-1 max-w-56 text-xs text-black/45">
                      manual tool: this app cannot remove it
                    </p>
                  ) : null}
                </Td>
                <Td>
                  <div className="flex flex-wrap justify-end gap-2">
                    {row.status !== "revoked" ? (
                      <Button
                        variant="danger"
                        className="px-3 py-1.5 text-xs"
                        onClick={() => open("revoke", row)}
                      >
                        {row.status === "pending-revoke" ? "Retry revoke" : "Revoke"}
                      </Button>
                    ) : null}
                    {row.status !== "revoked" && (row.status === "pending-revoke" || manual) ? (
                      <Button
                        variant="ghost"
                        className="px-3 py-1.5 text-xs"
                        onClick={() => open("mark", row)}
                      >
                        Mark revoked
                      </Button>
                    ) : null}
                  </div>
                </Td>
              </tr>
            );
          })}
        </Table>
      )}

      <Card className="space-y-4">
        <div>
          <h3 className="font-medium">Import existing access</h3>
          <p className="mt-1 text-sm text-black/55">
            This records access the provider already has — a subscription that predates this app,
            or a seat somebody set up by hand. It provisions nothing, notifies nobody and needs no
            approval, because there is no new access to approve. The row is marked imported, which
            is exactly what makes it worth reviewing later.
          </p>
          <p className="mt-1 text-sm text-black/55">
            To give somebody access they do not have, raise a request instead.
          </p>
        </div>

        <form onSubmit={importGrant} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Person email">
              <input
                className={inputClass}
                type="email"
                required
                value={importEmail}
                onChange={(event) => setImportEmail(event.target.value)}
                placeholder="priya@acme.com"
              />
            </Field>
            <Field label="Name" hint="Optional.">
              <input
                className={inputClass}
                value={importName}
                onChange={(event) => setImportName(event.target.value)}
                placeholder="Priya Nair"
              />
            </Field>
            <Field label="Tool">
              <select
                className={inputClass}
                required
                value={importToolId}
                onChange={(event) => setImportToolId(event.target.value)}
              >
                <option value="">Choose a tool…</option>
                {tools.map((tool) => (
                  <option key={tool.id} value={tool.id}>
                    {tool.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Role" hint="Optional. The plan tier they hold.">
              <input
                className={inputClass}
                value={importRole}
                onChange={(event) => setImportRole(event.target.value)}
                placeholder="member"
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={importing}>
              {importing ? "Recording…" : "Record existing access"}
            </Button>
            {tools.length === 0 ? (
              <span className="text-xs text-black/45">
                The catalogue is empty, so there is nothing to import against.
              </span>
            ) : null}
          </div>
        </form>

        {importError ? <ErrorNote>{importError}</ErrorNote> : null}
        {importOk ? <OkNote>{importOk}</OkNote> : null}
      </Card>

      <Confirm
        open={dialog !== null}
        title={dialog?.kind === "revoke" ? "Revoke this access" : "Mark the record revoked"}
        consequence={
          !dialog
            ? ""
            : dialog.kind === "revoke"
              ? `${revokeEffect(dialogTool, dialog.row)} If the provider refuses, the row is left ` +
                "pending-revoke and the access may remain — the screen will say so rather than " +
                "showing it as gone."
              : `Changes this record only. Nothing is sent to ${dialogTool?.vendor || dialog.row.toolName}: ` +
                `this is you asserting that ${dialog.row.personEmail} has already had the access ` +
                "removed by hand. If they have not, the register will say the access is gone while " +
                "they still hold it."
        }
        confirmLabel={dialog?.kind === "revoke" ? "Revoke access" : "Mark revoked"}
        variant={dialog?.kind === "revoke" ? "danger" : "primary"}
        busy={busy}
        // Both branches: one removes real access, the other can write something
        // untrue into the register, which the next review then skips over.
        requirePassword
        onConfirm={(password) => void run(password)}
        onCancel={() => {
          setDialog(null);
          setDialogError(null);
        }}
      >
        <Field
          label={dialog?.kind === "revoke" ? "Reason (required)" : "What you did (required)"}
          hint={
            dialog?.kind === "revoke"
              ? "Kept in the audit trail. A revoke with no reason cannot be reviewed later."
              : "Kept in the audit trail under your name, as the assertion that the work was done."
          }
        >
          <textarea
            className={`${inputClass} min-h-24`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={
              dialog?.kind === "revoke"
                ? "Left the team on Friday."
                : "Removed the seat in the vendor console this morning."
            }
          />
        </Field>
        {dialogError ? <ErrorNote>{dialogError}</ErrorNote> : null}
      </Confirm>
    </div>
  );
}
