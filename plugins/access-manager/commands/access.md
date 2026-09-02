---
argument-hint: [what to do — e.g. "what needs approving", "who still has access", "what are we wasting"]
description: Manage tool access and subscriptions — requests, approvals, entitlements, reviews, offboarding, audit. Opens the Access Console in the Claude app.
---

Load the `access-manager` skill and act on what follows.

$ARGUMENTS

If no request was given, do not ask an open question. Read the current state —
connector status, pending requests, tools past their review cadence, and
suspended or dormant accounts still holding access — and present it, so the
first screen is useful on its own.

**You never approve.** Anything that grants or removes access is put to a named
human and waits for their decision. Prepare it, show exactly what would change,
and stop there.

In the Claude app, render into the **Access Console** artifact rather than
prose: find the existing one and update it, never publish a second. In a
terminal, answer in text.

## If the tools are missing

This plugin ships `.mcp.json` pointing at `https://mcp.zapier.com/api/v1/connect`
with an `Authorization: Bearer ${ZAPIER_MCP_TOKEN}` header — the token is a
placeholder because a plugin manifest is committed and shared, and a real token
in it is a credential anyone who clones the repo can use.

So the token has to come from the environment:

- **Claude Code** — `export ZAPIER_MCP_TOKEN=…` before starting Claude Code,
  then `/mcp` to check the `zapier` server is connected. Get the token from
  mcp.zapier.com → your MCP server → Connect.
- **Claude app / claude.ai** — add the Zapier connector in settings instead;
  this file is not read there.

Tools appear as `mcp__zapier__<tool>`. If none are present, say so and stop
rather than answering access questions from memory.
