# Zapier MCP tool inventory

Verified live against this project's own Zapier MCP server
(`615406fa-f734-45ef-a7e6-42f4b0b7a5cb`) on **2026-09-02**: **118 tools**.

Another server on the same account will expose a different set. Check the id
before trusting anything below — see SKILL.md §2.

Tool names appear in your client as `mcp__zapier__<name>`. Discover at runtime
with the client's own tool listing; this file is for orientation, not a
substitute for the live schema.

| App | Tools | Used here |
|---|---|---|
| **Slack** | **33** | **yes — channel access and approval DMs** |
| Google Sheets | 30 | no |
| **Google Drive** | **22** | **yes — storage capacity only** |
| **Google Workspace Admin** | **15** | **yes — provisioning and the directory** |
| **Gmail** | **14** | **yes — approval notifications** |
| Helpers | 3 | yes |
| **Google Chat** | **1** | **yes — approval notifications** |

Everything on the server is reachable; this skill deliberately touches only the
five marked. Sheets is not part of the access model.

## There is no HR source

BambooHR was on an earlier server and its connection returned
`Error during execution: Not found. Error code 401.` It has since been removed
from the server entirely, so there is no HR feed at all — nothing here can tell
you whether somebody still works at the company.

The web app also denies every `bamboohr_*` tool to its agent **by prefix**, so
re-adding it to the server cannot silently make it reachable. That is
deliberate: a half-working HR source is worse than none, because a 401 arrives
as an ordinary tool result and a caller that does not read the payload sees an
empty employee list and concludes nobody has left.

## Google Workspace Admin

| Slug | Key arguments | Notes |
|---|---|---|
| `google_workspace_admin_find_user_by_email` | `email_to_search_for` | Primary email or alias. Empty `results` means no such account. |
| `google_workspace_admin_find_group_by_email` | `email_to_search_for` | Case-sensitive. |
| `google_workspace_admin_create_user` | `email`, `password`, `first_name`, `last_name`, `job_title`, `department`, `managers_email`, `organizational_unit`, `change_password_at_next_login` | `organizational_unit` is a dynamic enum — resolve it. |
| `google_workspace_admin_update_user` | `userKey`, `primaryEmail`, `name__givenName`, `name__familyName`, `title`, `department`, `orgUnitPath` | `userKey` takes an id, a primary email or an alias. |
| `google_workspace_admin_suspend_user` | `user_id` | Reversible. The offboarding default. |
| `google_workspace_admin_delete_user` | `user_id` | **Irreversible**, and takes the mailbox with it. |
| `google_workspace_admin_add_user_to_group` | `email`, `group_id`, `role` | `group_id` is the group's address. Dynamic enum. |
| `google_workspace_admin_remove_user_from_group` | `email`, `group_id` | |
| `google_workspace_admin_assign_license` | `userId`, `productId`, `skuId` | Note the camelCase — unlike the group tools. |
| `google_workspace_admin_revoke_license` | `userId`, `productId`, `skuId` | |
| `google_workspace_admin_assign_role_to_user` | `userId`, role id | Admin roles. Sensitive. |
| `google_workspace_admin_remove_role_from_user` | `userId`, role id | |
| `google_workspace_admin_create_group` | `email`, `name`, `description` | |
| `google_workspace_admin_make_api_get_request` | `url`, `querystring`, `headers`, `output_hint` | Read-only; the method is fixed to GET. |
| `google_workspace_admin_make_api_mutating_request` | as above plus `method`, `body` | Everything the typed tools do not cover. |

### The directory-list recipe

The whole people view depends on this one call, and it has two traps:

```
google_workspace_admin_make_api_get_request
  url:         https://admin.googleapis.com/admin/directory/v1/users
  querystring: { customer: "my_customer", maxResults: "500", projection: "full" }
  output_hint: "for every user: id, primaryEmail, name, suspended, archived,
                creationTime, lastLoginTime, orgUnitPath, isAdmin,
                organizations and relations"
```

- **`querystring` is a record, not an encoded string.** Passing
  `"customer=my_customer&maxResults=500"` returns
  `Invalid input: expected record, received string` and no rows.
- **`projection=full` is what carries job title, department and the manager
  relation.** The default projection omits all three, and a directory with no
  departments cannot answer "who owns this".

Paginate with `pageToken` from `nextPageToken`. Stopping at page one silently
understates the directory — say so if you stop early.

`lastLoginTime` comes back as the **Unix epoch** for an account that has never
signed in. Render that as "never", never as a 1970 date.

## Gmail

| Slug | Key arguments | Notes |
|---|---|---|
| `gmail_send_email` | `to`, `cc`, `bcc`, `subject`, `body`, `body_type` | `body_type` is `plain` or `html`. |
| `gmail_create_draft` | same shape | Inert: lands in the sender's own mailbox. |
| `gmail_create_draft_reply` | thread plus body | |
| `gmail_reply_to_email` / `gmail_forward_email` | | |
| `gmail_find_email` | **`query`** | A Gmail search string (`from:`, `subject:`, `newer_than:`). The argument is `query` — **not** `search_string`. |
| `gmail_get_conversation` | thread id | |
| `gmail_add_label_to_email`, `gmail_remove_label_from_email`, `gmail_remove_label_from_conversation`, `gmail_create_label` | | |
| `gmail_archive_email`, `gmail_delete_email`, `gmail_get_attachment_by_filename` | | |

## Slack

Two unrelated roles: a **notification channel**, and a **thing people have
access to**. A private channel holds decisions and customer detail and nobody
ever leaves one, so channel membership is a provisioning method — requested,
approved, reviewed and revoked like a Figma seat.

| Slug | Key arguments | Notes |
|---|---|---|
| `slack_find_user_by_email` | `email` | Resolves an email to a `U…` id. Every write below needs the id, and the register only holds emails, so this runs first. Empty `results` means no Slack account. |
| `slack_send_direct_message` | `channel`, `text`, `as_bot` | `channel` is the **user id**, despite the name. Prefer a DM over a channel post for an approval. |
| `slack_send_channel_message` | `channel`, `text`, `add_app_to_channel` | Set `add_app_to_channel: "yes"` or the send fails on any channel the connection was never added to, and reads as a permissions mystery. |
| `slack_invite_user_to_channel` | `users`, `channel` | Grant. |
| `slack_remove_user_from_channel` | `userId`, `channelId` | Revoke. **Note the asymmetry** with invite above — `users`/`channel` versus `userId`/`channelId`. Passing one shape to the other fails with a schema error. |
| `slack_get_conversation_members` | `channel` | Who is actually in a channel, for reconciling the register against Slack. |
| `slack_find_public_channel` | `channelId` or `channelName` | |

Channel ids look like `C0BEYSR1XMM`. Resolve them with
`list_dynamic_enum_values` on `slack_send_channel_message` / `channel` — the
enum **pages**, so a single call returns only the first nine or so and a
truncated list silently hides the channel someone is looking for.

**Somebody with no Slack account cannot be added to a channel.** The grant fails
rather than half-succeeding; say so instead of reporting it as done. On the
revoke side the opposite holds: no account means nothing to remove, and the
desired end state is already true, so that is reported as done.

## Google Chat

| Slug | Key arguments | Notes |
|---|---|---|
| `google_chat_create_message` | `room`, `text`, `title`, `subtitle`, `imageUrl`, `buttonText`, `buttonUrl` | `room` is a dynamic enum. A button needs both `buttonText` and `buttonUrl` or neither. |

**Observed 2026-09-01: the room enum came back empty.** No Chat space is shared
with the connection, so there is nowhere to post. Until a space is shared,
Gmail is the working notification channel — say that rather than reporting a
silent success.

## Google Drive — storage capacity

One read, and one thing it cannot tell you.

```
google_drive_make_api_get_request
  url:         https://www.googleapis.com/drive/v3/about
  querystring: { fields: "storageQuota" }
  output_hint: "the storage quota limit, usage, usageInDrive and usageInDriveTrash"
```

Returns `limit`, `usage`, `usageInDrive`, `usageInDriveTrash`, all in **bytes as
strings**. `limit` is the whole domain's pooled quota, not the connected
account's share.

**There is no billing API.** Drive reports capacity and nothing about money, so
never state a storage cost from these figures. The pool is normally bought
through Workspace licences — 2 TiB per licence, pooled across the domain — so
the cost of storage is usually a catalogue row that already exists. Extra
capacity bought as its own SKU is a separate entry a human adds.

**An absent `limit` means unlimited**, which Google signals by omitting the
field. It does not mean zero, and reporting "no storage" for an unlimited pool
is the exact inversion of the truth.

Observed 2026-09-01: pool 171,523,813,933,056 bytes (~156 TiB), 533,686,553,273
bytes (~497 GiB) in use — 0.3%.

## Helpers

| Slug | Purpose |
|---|---|
| `list_dynamic_enum_values` | Resolve a dynamic enum. Takes `tool_name`, `property_name`, optional `tool_arguments` to scope it, and `search`. |
| `get_dynamic_properties_schema` | Resolve a tool's `dynamic_properties` shape. Takes `tool_name` and the partial `tool_arguments`. |
| `get_configuration_url` | Where the user edits which actions this server exposes. |

## Result shapes

Two, and telling them apart is the whole game.

**Success**

```json
{ "results": [ { … } ], "billingTasksUsed": 2 }
```

`results: []` with no error is a genuine empty result — no such user, no
matching message.

**Failure**

```json
{ "isError": true, "error": "Error during execution: Not found. Error code 401.", "billingTasksUsed": 0 }
```

This arrives as an ordinary HTTP 200 tool result. Read the payload, not just the
transport. Every call also consumes Zapier tasks, so a loop over a directory is
not free.

## What was observed on 2026-09-01

Run `npm run probe` in the web app to reproduce this.

| Check | Result |
|---|---|
| Handshake and token | ok |
| Workspace Admin — user lookup | ok |
| Workspace Admin — directory list | ok |
| Gmail — mailbox search | ok |
| Google Chat — list spaces | ok, but **0 spaces**; nothing can be posted |
| Slack — user lookup and channel list | ok |
