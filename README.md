# GP-19 — Access Tools and Subscription Manager

Provision and de-provision accounts, track entitlements and review them on a
schedule, handle access requests and approvals, and keep an audit trail of the
lot.

Everything reaches the outside world through **one Zapier MCP server**: Google
Workspace Admin for provisioning and the people directory, Slack for channel
access and approval DMs, and Gmail and Google Chat for notifying approvers.

**A human releases every access request.** Nothing in this repo provisions
access without an approval decision recorded against a named person — not the
UI, not the HTTP API, and not the AI. That is enforced in code, not in a prompt,
and the section on [the approval path](#the-approval-path) traces exactly where.

There are two surfaces and they share one behaviour contract:

| Surface | What runs it | Needs |
|---|---|---|
| `/access` Claude Code command, or the Claude app | Claude itself | The Zapier connector |
| The Next.js console at `localhost:3000` | Claude Haiku 4.5 via the Anthropic API | `.env.local` |

---

## Setup — pick your path

### Path A · Claude — no credentials, no `.env`, no Node

The plugin is instructions only. Claude is the model, and the connectors are
already in your client — **nothing here asks you for a URL, a token or a
server id.**

1. Add this repo as a plugin marketplace and install the plugin:

   ```
   /plugin marketplace add new-digital-intelligence-com/GP-19-Access-Tools-and-Subscription-Manager
   /plugin install gp-19-access-manager@ndi-access
   ```

2. Make sure two connectors are enabled in your client — **Zapier** and
   **Supabase**. If you already use them, there is nothing to do.

   The plugin ships no `.mcp.json` on purpose: a Zapier server is addressed by
   a bearer token, and this repo is shared, so a real token in it would be a
   credential for anyone who clones it. Connectors are attached per person,
   in their own client.

3. Trigger it by name — there is no slash command:

   ```
   use the gp-19-access-manager skill
   gp-19-access-manager: who still has access after being suspended
   gp-19-access-manager: what are we paying for that nobody uses
   ```

   It checks the two connectors are present and stops if one is missing.

### Path B · The web app

```bash
cp .env.example .env.local     # fill it in, see below
npm install
npm run probe                  # check the Zapier connection before anything else
npm run seed                   # a starter catalogue, so the screens aren't empty
npm run dev
```

Then open `http://localhost:3000`.

#### Every environment variable

| Variable | What it is for | Where it comes from |
|---|---|---|
| `ZAPIER_MCP_URL` | The MCP endpoint. Only change it if Zapier moves. | Defaults to `https://mcp.zapier.com/api/v1/connect` |
| `ZAPIER_MCP_TOKEN` | Bearer token for that server. Without it nothing can be provisioned, the directory cannot be read, and no approver can be notified. | mcp.zapier.com → your server → Connect |
| `ANTHROPIC_API_KEY` | Powers the app's own agent (the **Ask AI** tab and the drafting buttons). Everything else in the app works without it. | console.anthropic.com → API keys |
| `ANTHROPIC_MODEL` | Defaults to `claude-haiku-4-5`. | — |
| `WORKSPACE_DOMAIN` | Your Google Workspace primary domain, used to sanity-check addresses before provisioning against them. | Your Workspace admin console |
| `ACTION_PASSWORD` | Typed into a dialog before anything that changes access. **Blank blocks those actions outright** rather than disabling the guard. | Pick one; it is typed by hand every time |
| `OPERATOR_EMAIL` | **Who this app acts as.** Every audit entry and every approval is attributed to it. There is no sign-in yet, so if this is unset, approvals are **refused outright** rather than attributed to a placeholder. | Your own address, for now |

#### The three scripts

| Command | What it proves |
|---|---|
| `npm run probe` | The token works, which apps the server exposes, and — one live read per app — whether each one actually answers. Run this first when something looks broken. |
| `npm run seed` | Writes six placeholder tools into `.data/catalog.json` so every screen has something real to draw. Catalogue only; it never fabricates approvals or audit entries. |
| `npm run smoke` | Walks the whole approval path against a running dev server and asserts the invariants, including the refusals: self-approval is rejected, a decided request cannot be decided twice, a revoke with no reason is refused, and every step reaches the audit trail. |

---

## The Zapier MCP server

One remote MCP server is the entire integration layer. It speaks Streamable
HTTP, and `src/lib/zapier.ts` is a ~290-line client for it — session handshake,
SSE parsing, re-handshake on an expired session, tool listing and tool calls.
There is no SDK dependency because the whole client is that one file, and an
extra dependency would hide the session handling that most needs to be visible.

This project uses three of the apps on it:

| App | Used for |
|---|---|
| **Google Workspace Admin** | Group membership, licence assignment, account suspension, and the people directory |
| **Slack** | Channel membership as a provisioning method, plus approval DMs |
| **Gmail** | Approval requests, decisions, and review reminders |
| **Google Chat** | The same notices, posted to a space |
| **Google Drive** | Storage-pool capacity for the catalogue — read only |

Google Sheets is on the same server and reachable, but nothing here calls it. The console's connector strip shows them dashed and dimmed so
"reachable" never reads as "wired up".

### Verified on 2026-09-01

Probed live against this project's own server. Reproduce with `npm run probe`.

**118 tools exposed:** Slack 33, Google Sheets 30,
Google Drive 22, Google Workspace Admin 15, Gmail 14, helpers 3, Google Chat 1.

| Check | Result |
|---|---|
| Handshake and token | ok |
| Workspace Admin — user lookup | ok |
| Workspace Admin — directory list | ok |
| Gmail — mailbox search | ok |
| Google Chat — list spaces | ok, but **zero spaces** |
| Slack — user lookup | ok |
| Slack — list channels | ok, real channels returned |

Two of those need action, and neither is a bug in this code:

- **Google Chat has no space shared with the connection**, so there is nowhere
  to post. Approval notices go out by **Gmail and Slack** until a space is shared.
  The app reports this rather than silently succeeding.
- **There is no HR source.** BambooHR was removed from the server. See the next section.

Along the way the probe found one real API trap worth knowing: Zapier's raw-API
tools take **`querystring` as a record, not an encoded string**. Passing
`"customer=my_customer&maxResults=500"` returns `expected record, received
string` and zero rows — a failure that looks exactly like an empty directory.

---

## Why there is no HR integration

BambooHR was in the first design as the employment source of truth: joiners,
movers and leavers would come from it, and offboarding would trigger off a
termination date. Its Zapier connection returned a 401, so it was dropped from
the app — and later from the MCP server altogether.

**A half-working HR source is worse than none.** The 401 arrives as an ordinary
tool result on an HTTP 200 — a caller that does not read the payload sees an
empty employee list and concludes that nobody has left. So rather than ship a
feature that fails silently in the most dangerous possible direction, the
lifecycle view was **re-sourced onto the Google Workspace directory**, which
does work.

That changes what the product is allowed to claim, and the code says so
everywhere. Workspace knows about **accounts**, not employment. It cannot tell
you someone left the company. What it can tell you is four things, all of them
signals worth reviewing and none of them proof about a person:

| Signal | What it is |
|---|---|
| `departures` | Suspended or archived accounts that still hold access |
| `dormant` | Active accounts nobody has signed into, still holding access |
| `joiners` | Recently created accounts |
| `orphans` | Register rows whose address has **no Workspace account at all** |

That last one is arguably a better access-management signal than anything an HR
feed gives you: it is money going out for seats no account can even use.

The words "leaver", "terminated" and "departed employee" appear nowhere in the
codebase except in the rules telling the model not to use them. An account is
suspended for a security hold, a long leave, a name change or an administrator's
mistake as readily as for a departure, and acting on the wrong inference removes
a working person's access.

**If you connect an HR system later**, `src/lib/providers/directory.ts` is the
seam. Give it the same `Directory` shape, add the employment fields to `Person`,
and `lifecycle.ts` can start distinguishing a real leaver from a suspended
account. Until then it does not pretend to.

---

## The domain model

Google Workspace holds accounts and group memberships. It does **not** hold why
someone has access, who approved it, what it costs, or when it was last
reviewed. That register is this app's reason to exist, so it lives here.

| Type | What it is | File |
|---|---|---|
| `Tool` | A managed tool or subscription: owner, cost per seat, seats purchased, and **how it is provisioned** | `.data/catalog.json` |
| `Person` | An account from the Workspace directory. No employment fields — see above | not persisted; read live |
| `Entitlement` | One person's grant of one tool: when, by whom, on what authority, until when | `.data/entitlements.json` |
| `AccessRequest` | A request and its decision | `.data/requests.json` |
| `ReviewCampaign` | A **frozen snapshot** of who held what, with per-row keep/revoke decisions | `.data/reviews.json` |
| `AuditEvent` | Append-only history of every change and every refusal | `.data/audit.json` |
| `Settings` | Approvers, cadence, notification channels, currency, SLA | `.data/settings.json` |

`Tool.provisioning` is the field that decides whether an approval can be carried
out at all:

- `google-group` — grant means adding the person to a Google group
- `google-license` — grant means assigning a Workspace SKU
- `slack-channel` — grant means inviting them to a Slack channel
- `manual` — there is no API path; the approval produces a **task**, and the app
  says so rather than implying the grant happened

`src/lib/provisioning.ts` is the single dispatcher. Adding a provider is: write
the module, add a `ProvisioningMethod`, add a case there — and the compiler finds
every other place that needs updating, because every switch on the method is
exhaustive.

A catalogue entry whose method has no identifier behind it (a `google-group`
tool with no group address) is **refused at save time** with a 400 naming the
missing field. Better one correction now than an approver being told access is
live when nothing backed it.

### The store

`.data/*.json`, one file per collection. Writes go through a temp file and an
atomic rename — an audit trail truncated mid-write reads afterwards as "nothing
happened", which is worse than useless. Read-modify-write is serialised per
collection so two approvals landing at once cannot drop one another's grant.

It is single-tenant and deliberately narrow. `src/lib/store.ts` is the one file
to change when this needs a real database.

---

## The approval path

Traced end to end, because this is the part worth auditing.

```
RequestsPanel  →  POST /api/requests           createRequest()
                                                 ├ refuses a blank justification
                                                 ├ refuses a duplicate active grant
                                                 ├ routes to the tool's owner
                                                 ├ notifies (Gmail / Chat)
                                                 └ audits: request.created
                                               … status: PENDING. Nothing granted.

RequestsPanel  →  POST /api/requests/decide    approve()
                                                 ├ 409 if already decided
                                                 ├ 403 if approver == requester
                                                 ├ 400 if the approver is unset
                                                 ├ 400 if the tool has a provisioning gap
                                                 ├ audits: request.approved
                                                 ├ grantAccess() → the provider
                                                 │    └ audits: grant.provisioned | grant.failed
                                                 └ status: provisioned | failed
```

`grantAccess()` **provisions first and records second**. If the provider refuses,
no entitlement row is written — so the register can never show access that does
not exist. The reverse order would be one failed call away from an untrue answer
to "who has access to this".

A `failed` request is **a successful decision with a failed provisioning step**:
the approval stands and is audited, and the person does not have access. It
comes back as a 200 whose body says so, not as a 5xx, because the UI has to be
able to tell the two apart.

Revoke has the mirror-image rule. If the provider refuses, the entitlement goes
to `pending-revoke`, **never** to `revoked` — marking it revoked would remove it
from every "who has access" answer while the person still has the access, which
is precisely the failure an access review exists to catch.

### Where the invariant is enforced

Two places, and neither of them is a prompt.

**1. `src/lib/requests.ts` — `approve()` is the only path from a request to a
grant.** There is no auto-approve flag and no way to pass one. `/api/entitlements`
POST is import-only and carries a comment saying so, because the obvious "helpful"
change is to wire `grantAccess` into it.

**2. `src/lib/native-tools.ts` and `src/lib/agent.ts` — the AI has no such
tool.** The agent gets eleven native tools that read the register plus exactly
one that writes: `raise_request`, which creates a *pending* request. There is no
`approve_request`, no `grant_access`, no `revoke_access`, no `offboard`.

On the Zapier side, every mutating tool is denied: account creation, update,
suspension and deletion; group add and remove; licence assign and revoke; role
assignment; the mutating raw-API endpoint; `gmail_send_email`; and
`google_chat_create_message` (posting to a shared space is an outward action
with no audit entry behind it — `raise_request` notifies the approver through
the app's own path, which records who was told and when). Every `bamboohr_*`
tool is denied by prefix, so one added to the server later cannot silently
become reachable.

**The agent's entire reachable surface is seven read-only tools:**

```
get_dynamic_properties_schema           list_dynamic_enum_values
gmail_create_draft                      gmail_find_email
google_workspace_admin_find_user_by_email
google_workspace_admin_find_group_by_email
google_workspace_admin_make_api_get_request
```

`gmail_create_draft` is the only one that writes anything, and a draft is inert:
it lands in the operator's own mailbox and sends when a person clicks send.

This is enforced **by absence rather than by instruction**, because an
instruction is a request and a missing tool is a fact. `dispatch()` also fails
closed on a hallucinated tool name, so a model that invents `revoke_license` gets
a refusal rather than a call. The system prompt restates the limits anyway — the
toolset stops the model *doing* the thing, and the prompt stops it *claiming* to
have done it, and a reader who believes "I've approved that for you" is exactly
as badly served as one whose access was really granted by a bot.

---

## The app's own agent

`claude-haiku-4-5`, chosen because it is cheap, has a 200K context window, and
this is a tool-dispatch job rather than a reasoning one. Two model-specific
facts shape the code: Haiku 4.5 predates adaptive thinking and
`output_config.effort`, and **both are rejected on it**, so neither appears
anywhere in this app.

`src/lib/agent.ts` runs a plain tool loop — up to twelve rounds, 30 messages of
replayed history, tool results truncated at 16K characters rather than dropped so
the model still sees the shape of what it got and can say what it truncated.

The Zapier catalogue is filtered before the model ever sees it. 127 tool schemas
on a small model costs accuracy as well as tokens, and picking the wrong
provisioning tool is not a cosmetic error here.

`POST /api/assist` is a separate, tool-free completion for drafting: a
justification, a decision note, a review summary, an offboarding brief. Each
prompt forbids inventing facts not in the request body — a drafted justification
that states a made-up business reason is worse than a blank field.

---

## The plugin

`plugins/gp-19-access-manager/` — one plugin, **one skill**.

```
plugins/gp-19-access-manager/
  .claude-plugin/plugin.json
  skills/gp-19-access-manager/
    SKILL.md                         the whole contract (not a router — there are no sub-skills)
    references/rules.md              the behaviour contract
    references/tools.md              the verified Zapier inventory
    references/app-api.md            driving the running web app over HTTP
    references/artifact.md           the Access Console DATA contract
    references/access-console.html   the artifact template
```

`references/rules.md` is the single source of truth for behaviour, and
`src/lib/skills.ts` reads **that same file** into the web app's agent prompt. A
rule changed once applies to Claude Code, the Claude app and the app's own chat
panel. The app still runs if the `plugins/` directory is absent — the fallback
in `skills.ts` carries the approval rule verbatim, because that is the one thing
this app cannot be wrong about.

### The Access Console artifact

In the Claude app there is one artifact for the whole toolkit, and the skill is
its backend: fetch, fill `DATA`, republish to the same URL. It renders correctly
from an empty `DATA` object, and it keeps three things apart that a prose answer
tends to flatten — a key never fetched ("not loaded yet") versus one fetched and
empty ("nothing here"); an approval that stands over a grant that failed; and a
revoke that was attempted and did not work.

No control on that page can approve or provision. It copies a section back to
Claude; that is the line.

---

## The confirmation password

Five actions ask for a password before they run: **approving** a request,
**revoking** an entitlement, **offboarding** someone, **applying** a review
campaign's revokes, and **hand-marking** a row revoked. Those are the ones that
change real access, plus the one that can write something untrue into the
register.

It is checked **server-side**, sent in an `x-action-password` header — never a
query parameter, because URLs end up in server logs and browser history — and
compared with a timing-safe comparison. A check in the browser would ship the
secret to every visitor and stop nobody.

Deny, cancel, re-notify, archiving a tool and editing settings are **not**
gated. Putting a password in front of "deny" would make the safe option the slow
one, which is how people learn to approve by reflex.

**It fails closed.** With `ACTION_PASSWORD` unset, those five actions return
`503` and the status screen says so. A guard that silently switches itself off
is worse than no guard: the dialog still shows the password box, so everyone
believes the pause is there when it is not.

**Be clear about what it is.** A seatbelt against a misclick — not
authentication. One shared secret cannot tell two people apart, cannot be
revoked for one of them, and never reaches the audit trail; every action is
still attributed to `OPERATOR_EMAIL`. Anyone who can read `.env.local` can do
everything in the app. Put real authentication in front of this before it leaves
your machine.

## Constraints worth knowing

- **There is no scheduler process.** Reviews are *due-detected on read* —
  `reviewsDue()` compares each tool's cadence against the last closed campaign
  that covered it. Nothing fires on a timer, and nothing revokes on its own.
  Applying a campaign's revoke decisions is a separate, deliberate button, because
  marking twelve rows "revoke" is an intent and someone still has to remove twelve
  people's access and see what came back.
- **Zapier bills per call.** The directory scan is one call per 500 accounts;
  a per-person Workspace probe over a whole directory would be both slow and
  expensive, which is why `/api/people` does not do one.
- **The directory scan has a page cap** (four pages, 2000 accounts). Past that it
  returns a `detail` string saying it stopped early. A partial directory presented
  as a complete one is the worst failure that screen has, so both the API and the
  panel surface it distinctly from an outage.
- **Failure hides inside the payload.** `{"isError":true,"error":"…"}` on an HTTP
  200 is Zapier's normal failure shape. `callTool()` normalises it so callers
  cannot mistake a dead connection for an empty result.
- **Dynamic enums must be resolved, not guessed.** `organizational_unit`, `room`
  and `group_id` take opaque values that only `list_dynamic_enum_values` knows.
- **`manual` tools end in a task, not an API call.** The approval is real and
  audited; the grant is a human's job in a vendor console, and the entitlement
  says so until someone marks it done.
- **No authentication on the web app.** `OPERATOR_EMAIL` stands in for a signed-in
  user. Approvals are refused outright when it is unset, because an approval
  attributed to nobody is not an approval. Put this behind auth before it leaves
  your machine.
