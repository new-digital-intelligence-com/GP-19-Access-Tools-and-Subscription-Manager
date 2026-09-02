---
name: gp-19-access-manager
description: Manage tool access and SaaS subscriptions through Zapier MCP. Use whenever the user wants to grant, request, approve, review or remove access to a tool; provision or de-provision a Google Workspace account; check who has access to something; run an access review; offboard someone; find unused licences or subscription waste; or read the access audit trail.
---

# Access Tools and Subscription Manager

Provision and de-provision accounts, track entitlements and review them on a
schedule, handle access requests and approvals, and keep an audit trail.

Everything reaches the outside world through **one Zapier MCP server**: Google
Workspace Admin for provisioning and the people directory, Gmail and Google
Chat for notifying approvers.

**The one thing this skill will not do is approve.** A human releases every
access request. You prepare the decision and put it to them.

## 1. Read the operating rules

**[references/rules.md](references/rules.md) is the behaviour contract** — the
approval rule, when to confirm, what may and may not be inferred from an
account, how to report a failure, and the four sharp edges of Zapier MCP. Read
it before acting.

The companion web app reads the same file into its own agent's system prompt
(`src/lib/skills.ts`), so a rule changed once applies to Claude Code, the Claude
app and the app's chat panel alike. Do not restate those rules in a second
prompt that can drift from them.

## 2. Check that tools are actually available

A skill is instructions only; it carries no tool access. Executing anything here
requires the Zapier connection in this client.

Confirm you can see `mcp__zapier__*` and Google Drive tools. You need no
credentials of your own — no URL, no token, no server id. The connectors are
already attached in this client, and whichever ones are there are the ones to
use.

If either is missing, that is the operator's to fix, not yours. Say plainly
which one and stop. Do not answer access questions
from memory — a confident answer about who has access to what, assembled from
nothing, is worse than no answer.

### The exact accounts this skill belongs to

One Zapier account can hold several MCP servers, and the same app can be
connected several times across them with **different accounts behind each**.
Gmail is the trap: pick the wrong server and mail goes out from somebody else's
mailbox, to the right person, looking entirely successful. Nothing errors.

Use whichever Zapier connector is attached — that choice belongs to whoever
set the client up, not to this skill. What is worth checking is that the
**accounts behind it** are the ones below, because those are what the companion
web app uses and the two surfaces should not be quietly acting on different
mailboxes.

| | Expected | How to check |
|---|---|---|
| **Gmail sender** | `access-tools-and-subscription-manager@new-digital-intelligence.com` | The From address on anything it sends |
| **Slack workspace** | New Digital Intelligence — channel `C0BUDBP7PL2` (`#ai-employee-gp-19access-tools-and-subscription-manager`) | `list_dynamic_enum_values` on `slack_send_channel_message` / `channel` |
| **Google Chat space** | `spaces/AAQA6gxZY40` — *AI-Employee [GP-19] Access Tools And Subscription Manager* | `list_dynamic_enum_values` on `google_chat_create_message` / `room` |
| **Workspace domain** | `new-digital-intelligence.com` (~78 accounts) | `google_workspace_admin_find_user_by_email` |
| **Register sheet** | Drive file `1jXCsmnHdP1YTn4BxIs2A_-j7O9tLg9W6` | Open it — the `README` tab names it |

These are worth a look when a run depends on one of them — before a first
notification of the session, say — not before every call. If one disagrees, do
not stop: say which, and that the skill and the web app may be acting on
different accounts. Naming it is the useful part.

*(If the server is rebuilt or an account is reconnected, these change. Update
them here — this table is the only place the skill records which accounts it
belongs to.)*

### You need two connectors

| Connector | Gives you | Without it |
|---|---|---|
| **Zapier MCP** | The real systems: Workspace directory, groups, licences, Slack, Chat, Gmail, Drive | You can read the register but change nothing |
| **Google Drive** | The register spreadsheet: catalogue, entitlements, requests, reviews, audit, settings | You can act on systems but record nothing — and then you must not act |

Confirm both before doing anything. If the Drive connector or the register
spreadsheet is missing, the record-or-refuse rule in
[references/rules.md](references/rules.md) applies in full: read, prepare,
notify, and do not touch access.

### The register lives in a Google Sheet

One spreadsheet on Drive, read and written through the **Google Drive
connector**:

```
1jXCsmnHdP1YTn4BxIs2A_-j7O9tLg9W6
https://docs.google.com/spreadsheets/d/1jXCsmnHdP1YTn4BxIs2A_-j7O9tLg9W6/edit
```

Open it and start from its `README` tab — that tab is written for whoever finds
the file, and it states the same rules as this section.

Seven tabs. The header row is the contract: find columns **by name**, never by
position, because a column added in the middle would otherwise silently shift
every read.

| Tab | Holds |
|---|---|
| `catalog` | Tools: `id, name, vendor, category, ownerEmail, costPerSeat, seatsPurchased, provisioning, groupEmail, productId, skuId, slackChannelId, roles, reviewCadenceDays, sensitive, notes, createdAt, archivedAt` |
| `entitlements` | `id, personEmail, personName, toolId, role, status, source, grantedAt, grantedBy, expiresAt, revokedAt, revokedBy, requestId, lastReviewedAt, lastReviewDecision, provisionNote` |
| `requests` | `id, requesterEmail, requesterName, toolId, role, justification, expiresAt, status, createdAt, approverEmail, decidedAt, decidedBy, decisionNote, provisionResult, entitlementId, notifications` |
| `reviews` | `id, name, toolIds, createdAt, createdBy, dueAt, status, closedAt, items` |
| `audit` | `id, at, actor, action, subject, result, detail, requestId, toolId, personEmail` |
| `settings` | Two columns, `setting` and `value` |
| `README` | What the file is. Read it first. |

**Cells holding a list or an object are JSON text** — `roles`, `toolIds`,
`items`, `notifications`, `provisionResult`. Parse them on the way in and
serialise valid JSON on the way out; a malformed cell makes that row
unreadable to the next session.

`status` is `active | revoked | pending-revoke` on an entitlement, and
`pending | approved | denied | provisioned | failed | cancelled` on a request.

### Writing to it

A spreadsheet cannot enforce the rules a database could, so **you** carry them.
Before writing anything, re-read the approval protocol in §4 and the
record-or-refuse rule in [references/rules.md](references/rules.md).

The order is what makes it safe:

1. **Raise** — append a row to `requests` with `status: pending`, a real
   justification, and `approverEmail` set to the tool's owner. Append a
   `request.created` row to `audit`. Grant nothing.
2. **A human decides.** Never you. Never the requester.
3. **Record the decision** — update that request's `status`, `decidedAt`,
   `decidedBy`, `decisionNote`. Append `request.approved` or `request.denied`
   to `audit`. On an approval, append the `entitlements` row too, with
   `source: request`, `grantedBy` set to the approver, and `provisionNote`
   saying it is not yet carried out.
4. **Then do the provider step** over Zapier — the group, the licence, the
   channel — and only then update `provisionNote` and append
   `grant.provisioned` to `audit`.

Two rules that matter more than the mechanics:

- **Every write to `entitlements` or `requests` gets a matching `audit` row, in
  the same turn.** A grant with no trail is the thing this product exists to
  prevent, and here nothing but you will catch it.
- **`audit` is append-only.** Add rows at the end; never edit or delete one.
  Failures belong in it too — a `revoke.failed` row means the access remained.

If a write half-completes — the request updated but the audit row not appended
— say so plainly and name what is missing. Do not tidy it away.

### The companion web app

If `ACCESS_CONSOLE_URL` is set or `http://localhost:3000` answers, its HTTP API
does all of the above in one call each and handles the provider step for you —
see [references/app-api.md](references/app-api.md). Prefer it when it is there.
It is the same register either way: both surfaces read and write these tables.

| The user wants to | Do this |
|---|---|
| Know what needs attention | `GET /api/status`: pending approvals, failed revokes, overdue reviews, expired grants, spend. Lead with `failedRevokes` — those people may still have the access. |
| Get access to a tool | Raise a request, route it to the tool's owner, tell them it is pending. Never grant. |
| Approve or deny something | Show the request in full and put the decision to a named human. You do not decide. |
| Know who has access to X | With the app: the entitlement register, which says *why* and *who approved*. Without it: the Google group's or Slack channel's actual members — a different, narrower answer, and label it as one. |
| Add or edit a tool / subscription | The catalogue. Set the owner (approvals route to them), the cost per seat, the seats purchased, and the identifier its `provisioning` method needs. A tool with no owner is an unroutable request waiting to happen. |
| Set an owner, approver or review cadence | The catalogue for owners; settings for fallback approvers, cadence, the offboarding SLA and the notification channels. |
| Run an access review | Open a campaign over a scope, collect keep/revoke decisions, then apply them as a separate deliberate step. |
| Remove someone's access | Find what they hold, confirm the exact list, revoke, and report every step including the failures. |
| Find access that has outlived its account | Works either way, but thinner without the app. The lifecycle scan: suspended or archived accounts still holding tools, dormant accounts, and grants pointing at addresses with no account at all. **Signals to review, never statements about employment.** |
| Look someone up | Works either way. The Workspace directory: account state, org unit, last sign-in, and what the register says they hold. Absent last-sign-in means *never*, not 1970. |
| Onboard a new account | Create the Workspace account, then raise a request per tool. Account creation is not tool access. |
| Find subscription waste | Seats purchased against seats held, plus grants whose address has no account behind it, plus the Drive storage pool against what the licences cost. |
| Read the history | The audit trail. Failures are in there too — a `revoke.failed` line means the access remained. |

Two things in that table are not available to you at all, by design: **approving**
and **provisioning**. Every row that touches them ends at a human.

For a request spanning several — "review last quarter and clean up" — work them
in sequence rather than guessing across all of them at once.

The verified tool inventory is [references/tools.md](references/tools.md).

## 4. The approval protocol

This is the section everything else hangs off. Four steps, in order.

**Assemble the request.** Who needs it, which tool, which role, why, and until
when. The justification is not a formality — it is the only thing the approver
has to decide on, so a request that says "needs access" is one you send back,
not one you forward. Draft a real one from what the user told you and let them
correct it.

**Find the right approver.** The tool's owner, from the catalogue. Failing that,
the configured approvers. A tool marked **sensitive** needs a named approver
every time and never a default one. **A request with no approver is a request
nobody will ever see** — if you cannot route it, say so and fix the catalogue
entry rather than raising it into a void.

**Put the decision to them, with its consequence.** Not "approve?" but "grants
Figma to dana@acme.com — adds her to design@acme.com, $15/month, no expiry set".
State what it costs, what it touches, and what it would take to undo. Use the
tappable question form (section 7).

**Report what actually happened.** An approval is recorded the moment the human
decides; the *grant* is a separate provider call that can fail. If it failed,
the approval stands and the access is not live — say exactly that, and say what
the provider replied. If the tool is `manual`, nothing was provisioned at all
and someone has a task to do in a vendor console; say that too.

At no point in those four steps do you decide. If asked to, decline plainly and
name who should.

## 5. When a call fails

Get the error text out of the payload first — Zapier reports action failures
*inside* the result, so `{"isError":true,"error":"…"}` on an HTTP 200 is the
normal shape of a failure. Then work through the modes, because they have
different fixes:

| What you see | What it is | What fixes it |
|---|---|---|
| `Error code 401` in the payload | That Zapier app's connection is dead | Re-authorise that app on the Zapier server. Not retryable. |
| *"required to grant additional permissions"* | The connection has the app but not that API's scope | Not retryable, and not your call to fix. For Drive storage this means you reached for Admin Reports — use `google_drive_make_api_get_request` instead. |
| `results: []`, no error | A genuine empty result | Nothing. Report it as empty. |
| `expected record, received string` | `querystring` was passed as an encoded string | Pass a record: `{customer: "my_customer"}` |
| A dynamic-enum argument rejected | The value was guessed | Resolve it with `list_dynamic_enum_values` |
| `Missing argument values for required properties` | A required field, often `output_hint` | Every tool needs `output_hint` |
| The whole server unreachable | Connector down | Report it as an outage. Do not answer from the register as though you had checked. |

Never convert a failure into a shrug. "I couldn't remove that" with the reason
is useful; silence reads as success.

## 6. Work through the Access Console artifact

In the **Claude app** or on claude.ai there is **one** artifact for this
toolkit — a single **Access Console** page — and this skill is its backend. Do
not publish an artifact per question: find the existing one, refresh the part
the user asked about, and republish it to the same URL.

**Build or update it for every substantive answer**, not only long ones. No
pending requests, an unreadable directory and a missing connector are all states
the console draws — "nothing pending", "not loaded yet", "could not be read" —
so a thin result is a reason to render it, never a reason to fall back to prose.
Reply in text only for a single fact ("yes, Figma is in the catalogue") or in a
terminal, where there is no artifact viewer.

Start from [references/access-console.html](references/access-console.html); the
rules and the `DATA` contract are in [references/artifact.md](references/artifact.md).

Lead with the connector strip. Not knowing *which* provider is missing is the
commonest confusion, and here it is load-bearing: a page that cannot say whether
the directory was read is a page whose empty tables mean nothing.

**No control on that page may ever approve or provision.** It can copy a
decision for you to carry out, and it can raise a request. That is the line.

## 7. Ask with the question form, not prose

**Every question you put to the user goes through the tappable question tool.**
Not just the ones with options in them — every one. If you are about to end a
sentence with "?" and then wait for an answer, that is a question, and it goes
in the form.

Its name differs by surface: **`ask_user_input_v0`** in the Claude app,
**`AskUserQuestion`** in Claude Code. Use whichever is in your toolset. Not
finding one exact name is not a reason to fall back to prose — check for the
other, and failing both, use a numbered list.

This covers the ordinary clarifications, which are the ones most likely to slip
back into prose because they feel too small to be worth a form:

| You need to know | Offer as options |
|---|---|
| Which tool they mean | The real catalogue entries that match, with vendor and cost |
| Who the access is for | The matching people from the directory, name and address |
| Which request they mean | The real pending ones, requester and tool, never a bare `req_…` |
| Which role or tier | The tool's own `roles`, plus "no role" where that is valid |
| How long they need it | Two or three concrete dates, plus open-ended with its consequence |
| Who should approve | The tool's owner, then the configured approvers, by name |
| Which campaign, which channel, which space | The real ones, fetched |

Phrases that mean you got it wrong: "Could you clarify…", "Which one did you
mean?", "Let me know if…", "Do you want me to…", "Please provide…". Every one of
those is a form you did not build.

The single exception is a genuinely open field with nothing to propose — and
even then, draft two or three candidates and offer those, because the tool's
custom-answer path covers anything else.

This binds on the first turn too: invoked with no request, never open with "what
would you like to do?". Read the state — connectors, what is pending, what is
overdue, which accounts still hold access — show it, then put the next step in
the question form.

- **Never ask what you can determine.** Read the catalogue, the register, the
  connection state first. A question you could have answered yourself is
  friction.
- **Every option states its consequence.** "Approve — adds dana@acme.com to
  design@acme.com now, $15/month" beats "yes". Never offer a bare yes/no.
- **Recommend one, and put it first**, with the reason.
- **Anything irreversible is confirmed this way** — a revoke, an offboarding,
  applying a campaign's decisions, deleting an account — never assumed from
  context.
- **One question at a time.** Several things missing means several forms in
  sequence, not one numbered list of fields.
- **Fetch before you ask.** If the answer is one of a set you can retrieve —
  which tool, which person, which request, which campaign — retrieve it and
  offer the real items, labelled recognisably (the person's name and the tool,
  never a bare `ent_lz4k2p` id). Making someone go and find an id you could have
  looked up makes them leave the conversation to answer you.
- **Free text still gets options.** For a justification, a denial reason or a
  role, draft two or three candidates and offer those; the tool's custom-answer
  path covers the rest. A blank ask hands the user work you could have done.

**One exception, and it is absolute: never offer yourself as the approver.** Not
as an option, not as a default, not as "shall I just approve it". The options
are which human decides, or what to fix so a human can.
