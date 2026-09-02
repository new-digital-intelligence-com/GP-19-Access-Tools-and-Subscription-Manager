# The Access Console artifact

There is **one** artifact for this toolkit — a single Access Console page — and
this skill is its backend. Never publish one artifact per question: you keep
updating the same page.

In the Claude app and on claude.ai, work through it. In a terminal there is no
artifact viewer, so answer in text.

## The loop

1. **Find the console.** If this conversation already published it, republish to
   the same file path. If not, list the user's artifacts and look for the one
   titled **Access Console**; pass its `url` so the update lands on it.
2. **Only create one when none exists.** Start from
   [`access-console.html`](access-console.html) beside this file.
3. **Run the skill.** Fetch what the user asked for with your connectors and the
   app's HTTP API — that is the backend.
4. **Fill `DATA` and republish.** The template renders entirely from one `DATA`
   object at the bottom of the file. Replace it, keep everything above it, and
   publish to the same URL.

The page is the interface; you are the runtime behind it. A question about
pending approvals updates `data.requests` and republishes — it does not produce
a second artifact.

## The DATA contract

Every key is optional, and **absent means something different from empty**:

- A key you did not fetch → leave it **out**. The section renders "not loaded
  yet".
- A key you fetched that has nothing in it → set `[]`. The section renders
  "nothing here".

Those must never look alike, which is the single most important rule in this
page. Do not fill a section with `[]` just because a fetch failed.

```js
DATA = {
  updated: "ISO timestamp of this refresh",
  connectors: [{ name, does, connected, detail }],   // see below — THREE states
  alerts: [{ level: "warn"|"error", text }],
  data: {
    overview: {
      stats: [{ label, value }],                     // value: null if unfetched
      spend: { monthly, waste, currency },
    },
    requests: [{
      id, requester, tool, role, justification, status, approver,
      createdAt, decidedBy, decisionNote, provision,
    }],
    entitlements: [{
      person, tool, role, status, source, grantedAt, expiresAt,
      lastReviewedAt, note,
    }],
    catalog: [{
      name, vendor, owner, costPerSeat, seatsPurchased, seatsHeld,
      idle, provisioning, sensitive,
    }],
    people: {
      available, detail,
      rows: [{ name, email, jobTitle, department, accountState, lastLoginAt }],
    },
    reviews: {
      due: [{ tool, lastReviewedAt, dueSince }],
      campaigns: [{ name, dueAt, status, decided, total }],
    },
    lifecycle: {
      available, detail, dormantAfterDays,
      departures: [{ name, email, accountState, idleDays, holds, monthlyCost }],
      dormant:    [{ name, email, idleDays, holds, monthlyCost }],
      joiners:    [{ name, email, ageDays, holds }],
      orphans:    [{ email, holds, monthlyCost }],
    },
    audit: [{ at, actor, action, subject, result, detail }],
  },
}
```

### Three states the page must never flatten

These are the reason this page exists rather than a paragraph of prose. Get them
wrong and the console actively misleads.

- **`requests[].status: "failed"`** — the approval **stands and is recorded**,
  the provider refused the grant, and the person does **not** have access. Not a
  pending request, not a denial, not a success. `provision` carries what the
  provider said; always include it on a failed row.
- **`entitlements[].status: "pending-revoke"`** — a revoke was attempted and did
  **not** succeed. The person may still have the access. This must never render
  in a way that could be read as "revoked".
- **`people[].lastLoginAt` absent** — the account has **never** been signed
  into. Google returns the Unix epoch for this; the page prints "Never" and must
  never show a 1970 date.

Other details that matter:

- `dueSince` is days: `>= 0` is overdue, negative is not yet due. Show both, and
  differently.
- `lifecycle.available: false` plus `detail` is the **unreadable** directory —
  an outage, not a clean scan. It is not a finding that everyone's access is in
  order.
- `people.detail` on a page where `available` is `true` means the directory scan
  stopped at its cap and the list is **incomplete**. Different from an outage,
  and it must not be presented as a complete directory.
- `accountState` describes the **account**, not employment. The page says
  "suspended account", never "left the company".
- A stat that could not be fetched is `value: null`, never `0` and never a
  guess.
- `alerts` is where a cross-cutting problem goes — a dead connector, an
  unroutable request, an operator address that is not set.

## Connectors, always visible

The strip at the top is not decoration: not knowing *which* provider is missing
is the commonest confusion, and here it is load-bearing. A page that cannot say
whether the directory was read is a page whose empty tables mean nothing.

Name what each connector powers — Google Workspace Admin for provisioning and
the directory, Gmail and Google Chat for notifying approvers.

**Never put a credential in the page.** Artifacts are shareable HTML; the
console shows connection *state*, never a token.

### Connectors have three states, not two

`connected` is `true`, `false`, or **`null` / omitted meaning "not checked this
refresh"**. Setting `false` for a provider you simply did not query prints "not
connected" over a working connector and sends the user off reconnecting
something that was never broken.

- Queried it and it answered → `connected: true`
- Queried it and it is genuinely not connected → `connected: false`
- **Did not query it this turn → `connected: null`**

`detail` carries the sub-state, because a server can be connected while an app
behind it is not: `detail: "Google Chat is connected but no space is shared with
it, so approval notices have nowhere to go — Gmail is the working channel."`
That is a different problem from the connector being down, and it is fixed
differently.

## What the page may and may not do

The console is a **snapshot with a live interface**: tabs, filters, sorting,
relative times in the viewer's timezone, copy buttons. All of that runs locally.

It does **not** call anything. Its action is "Copy for Claude" — text comes back
to you and you perform it. Never label a control "Approve", "Grant" or "Revoke",
and never let the page imply something reached a provider.

## Turning on live actions

The page can call the viewer's connectors itself. Two things must both be true:

1. **You have observed the tool's real request and response in this session.**
   The runtime contract carries the call envelope, never a tool's argument names
   or result encoding. A guessed shape fails at the user's click — the worst
   place to discover it.
2. **You fill `LIVE` and declare the matching capability at publish time.**

```js
LIVE = {
  enabled: true,
  actions: {
    raiseRequest: {
      server: "zapier",
      tool: "<observed tool name>",
      args: ({ requester, toolId, justification }) => ({ /* the shape you observed */ }),
    },
  },
}
```

**And one rule that overrides both: a live control may never approve or
provision.** Not a grant, not a revoke, not an account suspension, not applying
a campaign's decisions. The page may *raise a request* and it may *copy a
decision for you to carry out*. Anything that changes access goes through a
named human in the app or in this conversation — a button on a shareable HTML
page is not that, and a page that could grant access would defeat the only
guarantee this product makes.

Errors branch on the error **code**, never the message: `needs_reauth` says
reconnect, `server_not_connected` says add the connector, `rate_limited` says
wait. The page still renders and stays useful when the capability resolves
`null`; live controls simply do not appear.

## The Ask tab — running the skill's behaviour in the page

**No capability invokes a Claude skill.** A skill loads into a chat turn, and a
page cannot start one. What the console does instead is run the skill's
*behaviour*: `sample` gives the page Claude, and its `tools` are page functions
that reach the same connectors through `mcp`.

```js
ASSIST = {
  enabled: true,
  rules: "<references/rules.md, inlined here>",
}
```

Claude-in-the-page has **no memory and no skill loaded**, so everything that
governs it goes in `rules` — the same contract the chat-side skill follows, so
both surfaces behave identically. That includes the approval rule: the in-page
assistant reads and drafts, and it does not approve.

The viewer pays for these calls and the first one asks consent, so it only fires
on a click, never on load. `onText` delivers the whole answer so far — assign
it, never append.

## Publishing

Title stays **Access Console**; keep the favicon it was created with. Pass a
`description` saying what this refresh contains. Do not rename it per question —
one console, one identity, updated in place.
