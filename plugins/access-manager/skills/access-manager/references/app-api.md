# Driving the Access Console app

Some capabilities are not Google Workspace features at all — they are built on
state this app keeps, so no Zapier tool can reach them:

| Capability | Why it is app-only |
|---|---|
| The entitlement register | Workspace knows group membership; it does not know *why* someone has access or who approved it |
| Approval decisions | There is no approval object in Workspace |
| Review campaigns | A frozen snapshot of who held what, with per-row decisions |
| The audit trail | Append-only history of every change and every refusal |
| Seat and cost accounting | Purchased seats against held seats — a commercial fact, not a directory one |
| The tool catalogue | Which Google group or SKU backs which product |

When the app is running (default `http://localhost:3000`), drive these over
HTTP. When it is not, say so plainly rather than pretending the capability is
missing from Workspace.

Set `ACCESS_CONSOLE_URL` if it runs elsewhere. Check it is up before relying on
it: `GET /api/status` returns connector state and every headline count.

## Status

```
GET /api/status
```

Returns `zapier`, `model` (`{configured}` only — which model answers is not
published), `operator`, `counts`, `spend` and `alerts`. Read this
first: `counts.failedRevokes` is the number of entitlements sitting in
`pending-revoke`, meaning a removal was attempted and did not work and those
people may still have the access. `operator.configured: false` means approvals
are refused outright, so nothing can be released until it is set.

Every contributing read is guarded separately, so a figure that could not be
read is reported in `alerts` rather than shown as zero.

## The confirmation password

Five endpoints require an `x-action-password` header carrying the value of the
app's `ACTION_PASSWORD`:

```
POST   /api/requests/decide     (decision: "approve" only)
DELETE /api/entitlements        (revoke)
PATCH  /api/entitlements        (hand-marking a status)
POST   /api/lifecycle           (offboarding)
POST   /api/reviews/apply       (applying a campaign's revokes)
```

| Code | Meaning |
|---|---|
| `401` | No password was sent |
| `403` | The password was wrong |
| `503` | `ACTION_PASSWORD` is not set on the app, so the action is blocked entirely |

**Do not ask the user for this password and do not send one.** It exists so a
human at the keyboard pauses before an irreversible click, and an assistant
supplying it defeats the entire point. If a call comes back 401 or 403, that is
the design working: say which action needs doing in the app, and let a person
do it there.

## Requests and approvals

```
GET  /api/requests?status=pending|approved|denied|provisioned|failed|cancelled|all
POST /api/requests         {requesterEmail, requesterName?, toolId, role?, justification, expiresAt?}
POST /api/requests/decide  {id, decision, approverEmail?, note?}
```

`decision` is `approve` | `deny` | `cancel` | `renotify`. `approverEmail`
defaults to the configured operator.

**This is the only route in the app that can cause a grant**, and it causes one
only through the approval path. The status codes carry the invariant:

| Code | Meaning |
|---|---|
| `403` | The requester tried to approve their own request |
| `409` | Already decided — a request cannot be approved twice |
| `400` | Missing justification, missing denial reason, or a catalogue entry with no group address / SKU behind it |
| `404` | No such request or tool |

**A 200 whose `request.status` is `"failed"` is a successful decision with a
failed provisioning step.** The approval stands and is audited; the provider
refused the grant; the person does **not** have access. Read
`request.provisionResult.detail` and report that, rather than announcing the
approval as if the access were live.

`GET /api/requests` also returns `domain`, the organisation's own Workspace
domain. When a requester's address sits outside it, the approver is warned — in
the notification and in the app — and the audit trail records
`request.external-domain`. It is a **flag, not a refusal**: contractors and
second brands are legitimate, and the address is simply the field nobody
re-reads. Repeat the warning when you present such a request; never suppress it.

`request.notifications` records what was actually delivered. A pending request
with no `approverEmail` was never routed to anybody — use `renotify` after
setting an owner.

## Entitlements

```
GET    /api/entitlements?personEmail=&toolId=&status=
POST   /api/entitlements   {personEmail, personName?, toolId, role?}
PATCH  /api/entitlements   {id, status}
DELETE /api/entitlements?id=&reason=
```

`POST` is **import only** — it records access that already exists in the
provider and provisions nothing, marked `source: "imported"`. Returns `409` if
an active grant already exists. There is no grant endpoint; granting happens
only through an approved request.

`DELETE` is the revoke, and `reason` is required (`400` without it) — a revoke
with no reason cannot be reviewed six months later. It returns **200 with
`ok: false`** when the provider refused: the request succeeded, the answer was
no, and the entitlement is now `pending-revoke`. That is not a transport error
and must not be retried blindly.

`PATCH` sets a status by hand, for after a human finished a `manual` tool in the
vendor's own console. It changes the record, not the provider.

## Catalogue

```
GET    /api/catalog?includeArchived=1     -> {tools, usage, slackChannels, storage}
POST   /api/catalog     ToolDraft
PATCH  /api/catalog     ToolDraft with id
DELETE /api/catalog?id=                   archives, never deletes
```

`usage` carries seats held against seats purchased, idle seats and monthly
waste. A tool is refused with `400` naming the missing field if its provisioning
method has no identifier behind it — a `google-group` tool with no group
address, a `google-license` tool with no `productId`/`skuId`. Fixing that at
catalogue time is the point: an approval on a broken entry would record a grant
with nothing behind it.

`provisioning` is one of four, and it decides what an approval actually does:

| Method | Grant means | Identifier the tool must carry |
|---|---|---|
| `google-group` | Adding them to a Google group | `groupEmail` |
| `google-license` | Assigning a Workspace SKU | `productId` + `skuId` |
| `slack-channel` | Inviting them to a Slack channel | `slackChannelId` (`C…`, not the name) |
| `manual` | A task for a human | none |

A `manual` tool is tracked, reviewed and audited like any other — its approval
just ends in a task rather than an API call, and the app says so instead of
implying the grant happened.

`slackChannels` on the GET is the live channel list, for choosing a
`slackChannelId` without guessing. It is best-effort: an empty list means Slack
could not be read, not that there are no channels.

`storage` is the Google Drive pool — `{available, limit, usage, usageInDrive,
usageInTrash}` in bytes, or `available: false` with a reason. **There is no
price in it and none can be derived:** Drive exposes no billing API, so never
state a storage cost. An absent `limit` means unlimited, not zero. The pool is
normally bought through Workspace licences, so its cost is usually the
`google-license` row already in the catalogue.

## Reviews

```
GET    /api/reviews                 -> {campaigns, due, tools, entitlements}
POST   /api/reviews                 {name, toolIds?, dueInDays?}
PATCH  /api/reviews                 {campaignId, entitlementId, decision, note?}
POST   /api/reviews/apply           {campaignId}
DELETE /api/reviews?id=             closes it
```

A campaign is a **frozen snapshot** of who held what when it opened. `due[]`
carries `dueSince` in days: `>= 0` is overdue, negative is not yet due.

`PATCH` records a decision. `POST /api/reviews/apply` is what actually removes
access, and it is deliberately separate — marking twelve rows "revoke" is an
intent; someone still has to trigger the removal and see what came back. It
returns per-row results including the failures.

## People

```
GET /api/people             -> {available, detail?, people}
GET /api/people?email=x     -> {available, detail?, person, account, entitlements}
```

Sourced from the Google Workspace directory. **`available: false` is an outage,
not an empty company.** A `detail` string on a *successful* read means the scan
stopped at its page cap and the directory is incomplete — different from an
outage, and it must not be presented as a complete list.

`person.lastLoginAt` absent means the account has never been signed into. Google
returns the Unix epoch for that; the app drops it so it cannot render as 1970.

`accountState` is `active` | `suspended` | `archived`, and describes the
**account**, not the person's employment.

## Lifecycle

```
GET  /api/lifecycle
POST /api/lifecycle   {personEmail, suspendAccount, reason?}
```

`GET` compares the directory against the register and returns four signal sets:

| Key | What it is |
|---|---|
| `departures` | Suspended or archived accounts still holding access |
| `dormant` | Active accounts nobody has signed into, still holding access |
| `joiners` | Recently created accounts |
| `orphans` | Register rows whose address has no Workspace account at all |

These are **signals worth reviewing**, not statements about employment. It
returns 200 with `available: false` when the directory could not be read, which
is not a finding that everyone's access is in order.

`POST` runs the offboarding for exactly one person, and returns every step with
its own `ok` flag. `suspendAccount` is required and not defaulted. A partial
result — some revokes through, one failed — comes back as such, and must be
reported that way rather than as "offboarded".

## Audit

```
GET /api/audit?personEmail=&toolId=&requestId=&action=&limit=
```

Read-only; there is deliberately no write endpoint. `action` matches as a
substring, so `revoke` covers `revoke.provisioned`, `revoke.failed` and
`revoke.manual-required` in one filter. A `revoke.failed` entry means the access
remained.

## Settings

```
GET /api/settings   -> {settings, chatRooms}
PUT /api/settings    partial Settings
```

```
GET /api/settings   -> {settings, chatRooms, slackChannels}
```

Approvers, the default review cadence, currency, the offboarding SLA, the
Workspace `domain`, and the notification setup:

- `notify` is `{email, chat, slack}` — any combination, all three on by default.
- `chatRoom` is a Google Chat **space id** (`spaces/AAAA…`). A space *name* is
  refused with an explanation; the id comes from `chatRooms`.
- `slackChannel` is a Slack channel id (`C…`). When it is set, approvals are
  **posted to that channel with the approver @-mentioned**; when it is empty
  they are direct-messaged instead.

`chatRooms` and `slackChannels` are both best-effort — an empty list means the
provider could not be read, or the connected app is not a member of any
space/channel. It never means none exist.

## The register is Postgres now

The app and Claude read and write the **same Supabase tables**
(`rdvaaxtdbppqoxbktvgn`), so there is no copy to keep in step. The routes below
are a convenience over that shared store — they do the provider call and the
record in one step — not a separate source of truth. See SKILL.md for the
tables and the four write functions.

## Publishing the register to a Sheet (legacy)

```
POST /api/sync   {spreadsheetId?}   -> {ok, detail, written, url, tasksUsed}
```

Copies the register into a Google Sheet, one tab per collection. **Superseded
by Supabase** — it was how a Zapier-only session read the register before the
two surfaces shared a database. Still useful for a snapshot somebody wants in a
spreadsheet; not the way Claude should read the register.
Three upstream calls, and it costs metered Zapier tasks, so it is a button a
human presses rather than something that runs on every write.

It is **one-way**. Nothing reads back, hand-edits are ignored, and the next
publish overwrites. A `502` carries the reason: usually a wrong id, or a sheet
the connected Google account cannot open.

## Assist

```
POST /api/chat     {messages}                  -> {reply, trace}
POST /api/assist   {kind, …}                   -> {text}
```

`kind` is `justification` | `decision-note` | `review-summary` |
`offboard-brief`. These draft text; they change nothing.
