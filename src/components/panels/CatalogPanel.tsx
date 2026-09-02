"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  Stat,
  Table,
  Td,
  When,
  inputClass,
} from "@/components/ui";
import type { ProvisioningMethod, Tool } from "@/lib/types";

/**
 * The catalogue: what is being paid for, who is accountable for it, and whether
 * this app can carry out a grant for it at all.
 *
 * Two fields here decide what happens on a screen nobody is looking at yet.
 * `ownerEmail` is where an approval is routed, so a tool with no owner is an
 * unroutable request waiting to be raised — it gets its own flagged row rather
 * than a blank cell. `provisioning` decides whether an approval ends in an API
 * call or in a task for a human, so the form makes the identifier that method
 * needs a required field and says plainly when there is no API path at all.
 *
 * Archiving is the only destructive-looking action, and it is not destructive:
 * entitlements and audit entries point at the tool id, so the row is retired
 * rather than removed and nobody's access changes. The confirmation says that
 * in those words.
 */

/** Mirrors `SeatUsage` from the entitlements library, which is server-only. */
type Usage = {
  tool: Tool;
  active: number;
  purchased: number;
  idle: number;
  monthlyWaste: number;
  monthlySpend: number;
};

type SlackChannel = { value: string; label: string };
/** `slackChannels` is best effort — absent or empty means the picker degrades. */
/** Mirrors `Storage` from the Drive provider, which is server-only. */
type Storage = {
  available: boolean;
  detail?: string;
  limit: number | null;
  usage: number | null;
  usageInDrive: number | null;
  usageInTrash: number | null;
};

type Feed = {
  tools: Tool[];
  usage: Usage[];
  slackChannels?: SlackChannel[];
  storage?: Storage;
};

type Draft = {
  id?: string;
  name: string;
  vendor: string;
  category: string;
  ownerEmail: string;
  costPerSeat: string;
  seatsPurchased: string;
  provisioning: ProvisioningMethod;
  groupEmail: string;
  productId: string;
  skuId: string;
  slackChannelId: string;
  roles: string;
  reviewCadenceDays: string;
  sensitive: boolean;
  notes: string;
};

const EMPTY: Draft = {
  name: "",
  vendor: "",
  category: "",
  ownerEmail: "",
  costPerSeat: "",
  seatsPurchased: "",
  provisioning: "google-group",
  groupEmail: "",
  productId: "",
  skuId: "",
  slackChannelId: "",
  roles: "",
  reviewCadenceDays: "",
  sensitive: false,
  notes: "",
};

const METHODS: { id: ProvisioningMethod; label: string }[] = [
  { id: "google-group", label: "Google group membership" },
  { id: "google-license", label: "Google licence (product + SKU)" },
  { id: "slack-channel", label: "Slack channel membership" },
  { id: "manual", label: "Manual — no API path" },
];

/** Binary units, because that is what Google's byte counts actually are. */
function size(value: number | null): string {
  if (value === null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n < 10 && unit > 0 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
}

/**
 * Google Drive storage.
 *
 * The one thing this card must not do is show a price. Google exposes no
 * billing API behind Drive, so a figure here would be invented — on a page
 * whose whole job is being honest about what is known. It shows the pool and
 * what fills it, names where the pool comes from, and points at the catalogue
 * row that actually carries the cost.
 */
function StorageCard({
  storage,
  licence,
  currency,
}: {
  storage?: Storage;
  licence?: Usage;
  currency: string;
}) {
  if (!storage) {
    return (
      <Card>
        <SectionTitle>Google Drive storage</SectionTitle>
        <p className="mt-2 text-sm text-black/45">Not loaded yet.</p>
      </Card>
    );
  }

  if (!storage.available) {
    return (
      <Card>
        <SectionTitle>Google Drive storage</SectionTitle>
        <ErrorNote>
          Drive storage could not be read{storage.detail ? `: ${storage.detail}` : "."} This is not
          a finding that the pool is empty.
        </ErrorNote>
      </Card>
    );
  }

  // Absent `limit` is how Google reports an unlimited pool. Rendering it as
  // zero would read as "no storage at all", which is the opposite.
  const unlimited = storage.limit === null;
  const percent =
    !unlimited && storage.limit && storage.usage !== null
      ? (storage.usage / storage.limit) * 100
      : null;

  return (
    <Card className="space-y-3">
      <SectionTitle>Google Drive storage</SectionTitle>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Pool" value={unlimited ? "Unlimited" : size(storage.limit)} />
        <Stat label="In use" value={size(storage.usage)} />
        <Stat
          label="Used"
          value={percent === null ? "—" : `${percent < 0.1 ? "<0.1" : percent.toFixed(1)}%`}
        />
      </div>

      {percent !== null ? (
        <div
          className="h-2 overflow-hidden rounded-full bg-black/[0.07]"
          role="img"
          aria-label={`${percent.toFixed(1)}% of the storage pool is in use`}
        >
          <div
            className={`h-full rounded-full ${percent > 85 ? "bg-red-500" : percent > 60 ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${Math.max(percent, 0.5)}%` }}
          />
        </div>
      ) : null}

      <p className="text-sm leading-relaxed text-black/55">
        <span className="font-medium text-black/70">Google publishes no price for this.</span>{" "}
        There is no billing API behind Drive, so nothing here can read what you pay — these are
        capacity figures only. The pool is normally bought through Workspace licences rather than
        on its own, at 2&nbsp;TiB per licence pooled across the domain, so the cost usually sits on
        that catalogue row.
        {licence
          ? ` Yours: ${licence.tool.name}, ${licence.purchased} seats at ${money(licence.tool.costPerSeat, currency, 2)}/month — ${money(licence.monthlySpend, currency)}/month.`
          : " Add the Workspace licence to the catalogue and its cost will show here."}{" "}
        Capacity bought as its own SKU is a separate catalogue entry you add.
      </p>
    </Card>
  );
}

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

function money(amount: number, currency: string, digits = 0): string {
  const value = amount.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return currency ? `${currency} ${value}` : value;
}

function toDraft(tool: Tool): Draft {
  return {
    id: tool.id,
    name: tool.name,
    vendor: tool.vendor,
    category: tool.category,
    ownerEmail: tool.ownerEmail,
    costPerSeat: String(tool.costPerSeat),
    seatsPurchased: String(tool.seatsPurchased),
    provisioning: tool.provisioning,
    groupEmail: tool.groupEmail ?? "",
    productId: tool.productId ?? "",
    skuId: tool.skuId ?? "",
    slackChannelId: tool.slackChannelId ?? "",
    roles: tool.roles.join(", "),
    reviewCadenceDays: String(tool.reviewCadenceDays),
    sensitive: tool.sensitive,
    notes: tool.notes ?? "",
  };
}

/**
 * The same check the API makes, made here first.
 *
 * Not a substitute for it — the route still refuses the save — but a group
 * address missing from a form the person is still looking at is a correction,
 * and the same thing found after a round trip is an error message.
 */
function identifierGap(draft: Draft): string | null {
  if (draft.provisioning === "google-group" && !draft.groupEmail.trim()) {
    return (
      "A group address is required. Granting this tool means adding somebody to that group, " +
      "and there is nothing to add them to until it is set."
    );
  }
  if (draft.provisioning === "google-license" && !(draft.productId.trim() && draft.skuId.trim())) {
    return (
      "Both a productId and a skuId are required. Granting this tool means assigning that " +
      "licence, and the call has nothing to act on without them."
    );
  }
  if (draft.provisioning === "slack-channel" && !draft.slackChannelId.trim()) {
    return (
      "A Slack channel is required. Granting this tool means inviting somebody to that channel, " +
      "and there is nothing to invite them to until it is set."
    );
  }
  return null;
}

/** What an approval on this tool will actually end in, in the provider's terms. */
function methodEffect(method: ProvisioningMethod): string {
  switch (method) {
    case "google-group":
      return "An approval adds the person to the Google group below, and a revoke removes them.";
    case "google-license":
      return "An approval assigns this Google licence and uses a paid seat; a revoke frees it.";
    case "slack-channel":
      return (
        "An approval invites the person to the Slack channel below, and a revoke removes them. " +
        "Slack is matched on work email, so somebody with no Slack account cannot be added — the " +
        "grant fails rather than half-succeeding."
      );
    case "manual":
      return (
        "There is no API path. An approval on this tool records the decision and ends in a task " +
        "for a human, who grants it in the vendor's own console — the access is not live until " +
        "they do. A revoke is the same in reverse: the register holds the row at pending-revoke " +
        "until somebody removes the seat by hand and marks it revoked."
      );
  }
}

export function CatalogPanel() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  /** Only for the currency label on the money columns. */
  const [currency, setCurrency] = useState<string>("");

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [formError, setFormError] = useState<string | null>(null);
  const [formOk, setFormOk] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [archiving, setArchiving] = useState<Tool | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [archived, setArchivedNote] = useState<string | null>(null);

  const formRef = useRef<HTMLDivElement>(null);

  // `loading` starts true and `load` does not set it, so that the mount effect
  // below triggers no synchronous state update — React flags that as a
  // cascading render, and it is also just wasted work when the initial value is
  // already correct. A manual refresh raises the flag itself, from the handler.
  const load = useCallback(async () => {
    try {
      const query = showArchived ? "?includeArchived=1" : "";
      setFeed(await readJson<Feed>(await fetch(`/api/catalog${query}`)));
      setLoadError(null);
    } catch (error) {
      setFeed(null);
      setLoadError(message(error));
    }
    setLoading(false);
  }, [showArchived]);

  useEffect(() => {
    // Deferred by a microtask rather than called straight from the effect body.
    // `load` updates state, and doing that synchronously during the effect
    // flush costs a cascading render for no benefit — the first paint already
    // shows the loading state.
    void Promise.resolve().then(load);
  }, [load]);

  // The currency is display-only and lives in Settings, not on the tool. If the
  // read fails the figures are shown unlabelled rather than assuming a currency
  // nobody chose.
  useEffect(() => {
    fetch("/api/status")
      .then(readJson<{ spend: { currency: string } }>)
      .then((data) => setCurrency(data.spend.currency))
      .catch(() => setCurrency(""));
  }, []);

  const tools = feed?.tools ?? [];
  const usage = feed?.usage ?? [];
  const slackChannels = feed?.slackChannels ?? [];
  const usageOf = (id: string): Usage | undefined => usage.find((row) => row.tool.id === id);

  // The Workspace licence row is what the storage pool is normally bought
  // through, so the card can point at a real cost instead of inventing one.
  const licenceRow = usage.find((row) => row.tool.provisioning === "google-license");

  const live = tools.filter((tool) => !tool.archivedAt);
  const ownerless = live.filter((tool) => !tool.ownerEmail);
  const totalSpend = usage.reduce((sum, row) => sum + row.monthlySpend, 0);
  const totalWaste = usage.reduce((sum, row) => sum + row.monthlyWaste, 0);
  const totalSeats = usage.reduce((sum, row) => sum + row.purchased, 0);
  const totalHeld = usage.reduce((sum, row) => sum + row.active, 0);
  const totalIdle = usage.reduce((sum, row) => sum + row.idle, 0);
  const editing = Boolean(draft.id);

  // The form sits below the table, so an Edit click that only changed state
  // would look like nothing happened on a catalogue longer than a screen.
  function edit(tool: Tool) {
    setDraft(toDraft(tool));
    setFormError(null);
    setFormOk(null);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setFormOk(null);

    const gap = identifierGap(draft);
    if (gap) {
      setFormError(gap);
      return;
    }

    setSaving(true);
    try {
      const body = {
        id: draft.id,
        name: draft.name,
        vendor: draft.vendor,
        category: draft.category,
        ownerEmail: draft.ownerEmail,
        costPerSeat: draft.costPerSeat,
        seatsPurchased: draft.seatsPurchased,
        provisioning: draft.provisioning,
        // Sent as empty strings on purpose for the methods that do not use
        // them: the route keeps the stored value when a field is blank, so a
        // tool switched to manual keeps the group address it used to have.
        groupEmail: draft.groupEmail,
        productId: draft.productId,
        skuId: draft.skuId,
        slackChannelId: draft.slackChannelId,
        roles: draft.roles,
        reviewCadenceDays: draft.reviewCadenceDays,
        sensitive: draft.sensitive,
        notes: draft.notes,
      };
      const data = await readJson<{ tool: Tool }>(
        await fetch("/api/catalog", {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      setFormOk(
        draft.id
          ? `Saved ${data.tool.name}. Existing entitlements are untouched — this changes how the next grant is carried out, not the ones already made.`
          : `${data.tool.name} is in the catalogue and can be requested. Nothing is provisioned by adding it.`,
      );
      setDraft(EMPTY);
      await load();
    } catch (error) {
      setFormError(message(error));
    }
    setSaving(false);
  }

  async function archive() {
    if (!archiving) return;
    setBusy(true);
    setArchiveError(null);
    try {
      const data = await readJson<{ tool: Tool }>(
        await fetch(`/api/catalog?id=${encodeURIComponent(archiving.id)}`, { method: "DELETE" }),
      );
      setArchivedNote(
        `${data.tool.name} is archived. It cannot be requested any more, and everyone who holds ` +
          "it still holds it — archiving revokes nothing.",
      );
      setArchiving(null);
      // An archived tool leaves the default view, so a row disappearing here is
      // expected; turn the toggle on to keep it in sight.
      await load();
    } catch (error) {
      setArchiveError(message(error));
    }
    setBusy(false);
  }

  const archiveUsage = archiving ? usageOf(archiving.id) : undefined;
  const stillHeld = archiveUsage?.active ?? 0;

  /**
   * Written out rather than assembled in the JSX because it is the sentence a
   * person reads before doing the thing, and it has to name what archiving is
   * not: it is not a deletion, not a revoke, and not a cancellation.
   */
  const archiveConsequence = !archiving
    ? ""
    : [
        `${archiving.name} is archived, not deleted.`,
        "It leaves the catalogue and nobody can request it again.",
        archiveUsage
          ? stillHeld === 0
            ? "Nobody currently holds it."
            : `The ${stillHeld} ${stillHeld === 1 ? "person who holds" : "people who hold"} it keep their access — archiving revokes nothing.`
          : "Any live grants on it keep working — archiving revokes nothing.",
        "Entitlement rows and audit entries point at this tool id and go on pointing at it, which is why the row is kept rather than removed.",
        `Nothing on this screen brings it back, and the subscription keeps costing whatever it costs until somebody cancels it with ${archiving.vendor || "the vendor"}.`,
      ].join(" ");

  return (
    <div className="space-y-6">
      <SectionTitle
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              className="px-3 py-1.5 text-xs"
              onClick={() => setShowArchived((current) => !current)}
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </Button>
            <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => {
              setLoading(true);
              void load();
            }}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        }
      >
        Tools and subscriptions
      </SectionTitle>

      <StorageCard
        storage={feed?.storage}
        licence={licenceRow}
        currency={currency}
      />

      {archived ? <OkNote>{archived}</OkNote> : null}
      {!archiving && archiveError ? <ErrorNote>{archiveError}</ErrorNote> : null}

      {ownerless.length > 0 ? (
        <Note>
          {ownerless.length === 1
            ? `${ownerless[0].name} has no owner.`
            : `${ownerless.length} tools have no owner.`}{" "}
          Approvals route to the owner, so a request for one of these falls back to the first
          address in Settings approvers — and if that list is empty the request is raised with
          nobody to decide it.
        </Note>
      ) : null}

      {loadError ? (
        <ErrorNote>
          The catalogue could not be read: {loadError}. This is a failed read, not an empty
          catalogue — tools may exist and not be shown, and the spend figures below are missing
          rather than nil.
        </ErrorNote>
      ) : loading && !feed ? (
        <Loading label="Reading the catalogue…" />
      ) : tools.length === 0 ? (
        <Empty
          title="No tool is in the catalogue"
          hint="Add the first subscription below. Nothing can be requested, reviewed or costed until it is here."
        />
      ) : (
        <Table
          head={[
            "Tool",
            "Category",
            "Owner",
            "Cost/seat",
            "Seats",
            "Held",
            "Idle",
            "Waste /mo",
            "Provisioning",
            "",
          ]}
        >
          {tools.map((tool) => {
            const row = usageOf(tool.id);
            const isArchived = Boolean(tool.archivedAt);
            const noOwner = !tool.ownerEmail;
            return (
              <tr
                key={tool.id}
                className={
                  isArchived ? "bg-black/[0.02]" : noOwner ? "bg-red-50/40" : undefined
                }
              >
                <Td>
                  <span className="font-medium">{tool.name}</span>
                  <span className="block text-xs text-black/45">
                    {tool.vendor || "no vendor recorded"}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {tool.sensitive ? <Pill state="overdue" label="sensitive" /> : null}
                    {isArchived ? <Pill state="closed" label="archived" /> : null}
                  </span>
                  {isArchived ? (
                    <span className="block text-xs text-black/45">
                      archived <When at={tool.archivedAt} relative={false} />
                    </span>
                  ) : null}
                </Td>
                <Td className="text-black/60">{tool.category}</Td>
                <Td>
                  {noOwner ? (
                    <>
                      <span className="font-medium text-red-700">No owner</span>
                      <span className="mt-0.5 block max-w-60 text-xs text-red-700">
                        Approvals for this tool have nobody to route to. Set one, or every request
                        for it waits on whoever happens to open this console.
                      </span>
                    </>
                  ) : (
                    <span className="text-black/70">{tool.ownerEmail}</span>
                  )}
                </Td>
                <Td className="tnum text-black/70">{money(tool.costPerSeat, currency, 2)}</Td>
                <Td className="tnum text-black/70">{tool.seatsPurchased}</Td>
                <Td className="tnum text-black/70">
                  {/* No usage row means the seat figures were not part of this
                      read. Showing zero here would read as "nobody holds it". */}
                  {row ? row.active : <span className="text-black/35">not counted</span>}
                </Td>
                <Td className="tnum">
                  {!row ? (
                    <span className="text-black/35">—</span>
                  ) : row.idle > 0 ? (
                    <span className="font-medium text-amber-800">{row.idle}</span>
                  ) : row.idle < 0 ? (
                    <span className="font-medium text-red-700">over by {-row.idle}</span>
                  ) : (
                    <span className="text-black/50">0</span>
                  )}
                </Td>
                <Td className="tnum">
                  {row ? (
                    row.monthlyWaste > 0 ? (
                      <span className="font-medium text-amber-800">
                        {money(row.monthlyWaste, currency)}
                      </span>
                    ) : (
                      <span className="text-black/50">{money(0, currency)}</span>
                    )
                  ) : (
                    <span className="text-black/35">not counted</span>
                  )}
                </Td>
                <Td>
                  <Pill
                    state={tool.provisioning === "manual" ? "due" : "ok"}
                    label={tool.provisioning.replace(/-/g, " ")}
                  />
                  {tool.provisioning === "manual" ? (
                    <span className="mt-1 block max-w-52 text-xs text-black/45">
                      approvals end in a task, not an API call
                    </span>
                  ) : null}
                  {tool.provisioning === "google-group" && !tool.groupEmail ? (
                    <span className="mt-1 block max-w-52 text-xs font-medium text-red-700">
                      no group address — an approval here will be refused
                    </span>
                  ) : null}
                  {tool.provisioning === "google-license" && !(tool.productId && tool.skuId) ? (
                    <span className="mt-1 block max-w-52 text-xs font-medium text-red-700">
                      no productId or skuId — an approval here will be refused
                    </span>
                  ) : null}
                  {tool.provisioning === "slack-channel" && !tool.slackChannelId ? (
                    <span className="mt-1 block max-w-52 text-xs font-medium text-red-700">
                      no Slack channel — an approval here will be refused
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="ghost"
                      className="px-3 py-1.5 text-xs"
                      onClick={() => edit(tool)}
                    >
                      Edit
                    </Button>
                    {!isArchived ? (
                      <Button
                        variant="ghost"
                        className="px-3 py-1.5 text-xs"
                        onClick={() => {
                          setArchiving(tool);
                          setArchiveError(null);
                          setArchivedNote(null);
                        }}
                      >
                        Archive
                      </Button>
                    ) : null}
                  </div>
                </Td>
              </tr>
            );
          })}

          {/* Totals cover the live catalogue only, because that is what
              `usage` covers. An archived subscription may still be billed by
              the vendor; this app stopped counting it, which is not the same
              thing, so the row says which set it is adding up. */}
          <tr className="bg-black/[0.03]">
            <Td className="font-medium">
              Totals
              <span className="block text-xs font-normal text-black/45">
                {live.length} live {live.length === 1 ? "tool" : "tools"}, archived excluded
              </span>
            </Td>
            <Td />
            <Td />
            <Td />
            <Td className="tnum font-medium">{totalSeats}</Td>
            <Td className="tnum font-medium">{totalHeld}</Td>
            <Td className="tnum font-medium">{totalIdle}</Td>
            <Td className="tnum font-semibold text-amber-800">{money(totalWaste, currency)}</Td>
            <Td className="tnum font-semibold whitespace-nowrap">
              <span className="block text-xs font-normal text-black/45">Monthly spend</span>
              {money(totalSpend, currency)}
            </Td>
            <Td />
          </tr>
        </Table>
      )}

      <div ref={formRef} className="scroll-mt-6">
        <Card className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-medium">{editing ? `Edit ${draft.name || "tool"}` : "Add a tool"}</h3>
              <p className="mt-1 text-sm text-black/55">
                {editing
                  ? "Changes apply to the next grant or revoke. Nobody's existing access changes because this entry did."
                  : "Adding a tool provisions nothing and notifies nobody. It makes the tool requestable, reviewable and costed."}
              </p>
            </div>
            {editing ? (
              <Button
                variant="ghost"
                className="px-3 py-1.5 text-xs"
                onClick={() => {
                  setDraft(EMPTY);
                  setFormError(null);
                  setFormOk(null);
                }}
              >
                Cancel edit
              </Button>
            ) : null}
          </div>

          <form onSubmit={save} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Name">
                <input
                  className={inputClass}
                  required
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Figma"
                />
              </Field>
              <Field label="Vendor" hint="Whose console a manual grant happens in.">
                <input
                  className={inputClass}
                  value={draft.vendor}
                  onChange={(event) => setDraft({ ...draft, vendor: event.target.value })}
                  placeholder="Figma Inc."
                />
              </Field>
              <Field label="Category" hint="Left blank it is saved as Uncategorised.">
                <input
                  className={inputClass}
                  value={draft.category}
                  onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                  placeholder="Design"
                />
              </Field>
              <Field
                label="Owner email"
                hint="Where approvals and review notices are sent. Without it they fall back to Settings approvers."
              >
                <input
                  className={inputClass}
                  type="email"
                  value={draft.ownerEmail}
                  onChange={(event) => setDraft({ ...draft, ownerEmail: event.target.value })}
                  placeholder="design-lead@acme.com"
                />
              </Field>
              <Field label={`Cost per seat${currency ? ` (${currency})` : ""}`} hint="Per month.">
                <input
                  className={inputClass}
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.costPerSeat}
                  onChange={(event) => setDraft({ ...draft, costPerSeat: event.target.value })}
                  placeholder="15"
                />
              </Field>
              <Field label="Seats purchased" hint="Compared against live grants to find idle seats.">
                <input
                  className={inputClass}
                  type="number"
                  min="0"
                  step="1"
                  value={draft.seatsPurchased}
                  onChange={(event) => setDraft({ ...draft, seatsPurchased: event.target.value })}
                  placeholder="25"
                />
              </Field>
            </div>

            <Field label="Provisioning" hint={methodEffect(draft.provisioning)}>
              <select
                className={inputClass}
                value={draft.provisioning}
                onChange={(event) =>
                  setDraft({ ...draft, provisioning: event.target.value as ProvisioningMethod })
                }
              >
                {METHODS.map((method) => (
                  <option key={method.id} value={method.id}>
                    {method.label}
                  </option>
                ))}
              </select>
            </Field>

            {/* Only the identifier the chosen method actually uses is shown, and
                it is required: the API refuses a google-group tool with no group
                address, and it is right to — the alternative is an approver
                releasing access that cannot be carried out. */}
            {draft.provisioning === "google-group" ? (
              <Field
                label="Group email (required)"
                hint="The Google group whose membership gates the tool."
              >
                <input
                  className={inputClass}
                  type="email"
                  required
                  value={draft.groupEmail}
                  onChange={(event) => setDraft({ ...draft, groupEmail: event.target.value })}
                  placeholder="figma-users@acme.com"
                />
              </Field>
            ) : null}

            {draft.provisioning === "google-license" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="productId (required)" hint="From the Google licensing API.">
                  <input
                    className={inputClass}
                    required
                    value={draft.productId}
                    onChange={(event) => setDraft({ ...draft, productId: event.target.value })}
                    placeholder="Google-Apps"
                  />
                </Field>
                <Field label="skuId (required)" hint="The SKU a grant assigns and a revoke frees.">
                  <input
                    className={inputClass}
                    required
                    value={draft.skuId}
                    onChange={(event) => setDraft({ ...draft, skuId: event.target.value })}
                    placeholder="1010020020"
                  />
                </Field>
              </div>
            ) : null}

            {draft.provisioning === "slack-channel" ? (
              <Field
                label="Slack channel (required)"
                hint={
                  slackChannels.length > 0
                    ? "An approval invites the person here; a revoke removes them."
                    : "Paste the channel id (C…). The list could not be read, so there is nothing to pick from."
                }
              >
                {slackChannels.length > 0 ? (
                  <select
                    className={inputClass}
                    required
                    value={draft.slackChannelId}
                    onChange={(event) =>
                      setDraft({ ...draft, slackChannelId: event.target.value })
                    }
                  >
                    <option value="">Choose a channel…</option>
                    {/* A channel already saved but no longer visible to the
                        connection would otherwise silently reset to blank on
                        the next save, quietly breaking the tool's grants. */}
                    {draft.slackChannelId &&
                    !slackChannels.some((c) => c.value === draft.slackChannelId) ? (
                      <option value={draft.slackChannelId}>
                        {draft.slackChannelId} — not visible to the connection
                      </option>
                    ) : null}
                    {slackChannels.map((channel) => (
                      <option key={channel.value} value={channel.value}>
                        #{channel.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={inputClass}
                    required
                    value={draft.slackChannelId}
                    onChange={(event) =>
                      setDraft({ ...draft, slackChannelId: event.target.value })
                    }
                    placeholder="C0BEYSR1XMM"
                  />
                )}
              </Field>
            ) : null}

            {draft.provisioning === "manual" ? (
              <Note>
                No identifier is needed, because nothing is sent anywhere. An approval on a manual
                tool is recorded and then ends in a task for a human, who grants it in the
                {draft.vendor ? ` ${draft.vendor}` : " vendor's"} console. Until they do, the
                approval exists and the access does not, and this app will keep saying so rather
                than showing the request as provisioned.
              </Note>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Roles" hint="Comma separated. Offered to requesters as plan tiers.">
                <input
                  className={inputClass}
                  value={draft.roles}
                  onChange={(event) => setDraft({ ...draft, roles: event.target.value })}
                  placeholder="viewer, editor, admin"
                />
              </Field>
              <Field
                label="Review cadence (days)"
                hint="Days between scheduled reviews. Zero disables the schedule for this tool."
              >
                <input
                  className={inputClass}
                  type="number"
                  min="0"
                  step="1"
                  value={draft.reviewCadenceDays}
                  onChange={(event) => setDraft({ ...draft, reviewCadenceDays: event.target.value })}
                  placeholder="90"
                />
              </Field>
            </div>

            <Field label="Notes" hint="Optional. Anything the next person deciding on this needs.">
              <textarea
                className={`${inputClass} min-h-20`}
                value={draft.notes}
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                placeholder="Renews in March. Seats are billed annually."
              />
            </Field>

            <label className="flex items-start gap-3 rounded-xl bg-black/[0.03] px-4 py-3">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-current"
                checked={draft.sensitive}
                onChange={(event) => setDraft({ ...draft, sensitive: event.target.checked })}
              />
              <span className="text-sm">
                <span className="font-medium">Sensitive</span>
                <span className="mt-0.5 block text-black/55">
                  Puts a line in the approval notification and a flag on the request saying this one
                  needs a named approver. It adds no second approver and blocks nothing on its own.
                </span>
              </span>
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : editing ? "Save changes" : "Add to the catalogue"}
              </Button>
              {editing ? (
                <span className="text-xs text-black/45">
                  Editing an existing entry. Archived state is not changed by saving.
                </span>
              ) : null}
            </div>
          </form>

          {formError ? <ErrorNote>{formError}</ErrorNote> : null}
          {formOk ? <OkNote>{formOk}</OkNote> : null}
        </Card>
      </div>

      <Confirm
        open={archiving !== null}
        title="Archive this tool"
        consequence={archiveConsequence}
        confirmLabel="Archive it"
        variant="danger"
        busy={busy}
        onConfirm={() => void archive()}
        onCancel={() => {
          setArchiving(null);
          setArchiveError(null);
        }}
      >
        {stillHeld > 0 ? (
          <Note>
            {stillHeld} {stillHeld === 1 ? "person" : "people"} still hold this tool. Archiving
            does not touch them — revoke the grants in the register if the access is meant to end.
          </Note>
        ) : null}
        {archiveError ? <ErrorNote>{archiveError}</ErrorNote> : null}
      </Confirm>
    </div>
  );
}
