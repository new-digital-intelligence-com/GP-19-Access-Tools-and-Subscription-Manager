-- GP-19 — the write path, enforced by the database.
--
-- Run after schema.sql. Idempotent.
--
-- WHY THIS EXISTS
--
-- The app used to be the only writer, so the rules that make this an access
-- manager — an approval by a named human, never the requester, always audited
-- — lived in TypeScript. The moment a second writer appears (a Claude session
-- on the Supabase connector) those rules are one raw INSERT away from being
-- bypassed, and an entitlement with no approval behind it is exactly what this
-- product exists to prevent.
--
-- So the rules move here. Two halves:
--
--   1. CONSTRAINTS that make an invalid row impossible, whoever writes it.
--   2. FUNCTIONS that are the only sane way to change access, and which write
--      the audit entry in the same transaction as the change.
--
-- Claude may call the functions freely. It cannot produce an unapproved grant,
-- because the database will not accept one.

-- ═══ 1. constraints ════════════════════════════════════════════════════════

-- A decided request must name who decided it, and it may never be the person
-- who asked. This is the rule the whole product turns on.
alter table requests drop constraint if exists requests_decided_by_a_third_party;
alter table requests add constraint requests_decided_by_a_third_party check (
  (data->>'status') not in ('approved','denied','provisioned','failed')
  or (
    nullif(trim(data->>'decidedBy'), '') is not null
    and lower(data->>'decidedBy') is distinct from lower(data->>'requesterEmail')
  )
);

-- Access always names who granted it. "unattributed" is the app's placeholder
-- for an unset operator, and it is not an answer to "who authorised this".
alter table entitlements drop constraint if exists entitlements_have_an_author;
alter table entitlements add constraint entitlements_have_an_author check (
  nullif(trim(data->>'grantedBy'), '') is not null
  and lower(data->>'grantedBy') <> 'unattributed@localhost'
);

-- The trail is append-only in the strong sense: the database refuses.
create or replace function gp19_reject_mutation() returns trigger
  language plpgsql as $$
begin
  raise exception
    'The audit trail is append-only. % on audit is refused — history that can be edited answers nothing.',
    tg_op;
end $$;

drop trigger if exists audit_is_append_only on audit;
create trigger audit_is_append_only
  before update or delete on audit
  for each row execute function gp19_reject_mutation();

-- ═══ 2. the write path ═════════════════════════════════════════════════════

create or replace function gp19_audit(
  actor text, action text, subject text, result text, detail text,
  request_id text default null, tool_id text default null, person_email text default null
) returns void language plpgsql as $$
begin
  insert into audit (id, data) values (
    'evt_' || replace(gen_random_uuid()::text, '-', ''),
    jsonb_strip_nulls(jsonb_build_object(
      'id', 'evt_' || replace(gen_random_uuid()::text, '-', ''),
      'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'actor', actor, 'action', action, 'subject', subject,
      'result', result, 'detail', detail,
      'requestId', request_id, 'toolId', tool_id, 'personEmail', person_email
    ))
  );
end $$;

-- ── raise a request ────────────────────────────────────────────────────────
-- Creates a PENDING request. Grants nothing. This is the only thing an
-- assistant should ever need to do unprompted.
create or replace function gp19_raise_request(
  requester_email text,
  tool_id text,
  justification text,
  role text default null,
  expires_at text default null,
  requester_name text default null
) returns text language plpgsql as $$
declare
  new_id text;
  tool jsonb;
  approver text;
begin
  if nullif(trim(justification), '') is null then
    raise exception 'A justification is required: an approver cannot decide on a request that does not say what the access is for.';
  end if;

  select data into tool from catalog where id = tool_id;
  if tool is null then
    raise exception 'No tool % in the catalogue.', tool_id;
  end if;

  if exists (
    select 1 from entitlements
    where lower(data->>'personEmail') = lower(requester_email)
      and data->>'toolId' = tool_id
      and data->>'status' = 'active'
  ) then
    raise exception '% already holds active access to %.', requester_email, tool->>'name';
  end if;

  approver := nullif(trim(tool->>'ownerEmail'), '');
  new_id := 'req_' || replace(gen_random_uuid()::text, '-', '');

  insert into requests (id, data) values (new_id, jsonb_strip_nulls(jsonb_build_object(
    'id', new_id,
    'requesterEmail', lower(requester_email),
    'requesterName', requester_name,
    'toolId', tool_id,
    'role', role,
    'justification', justification,
    'expiresAt', expires_at,
    'status', 'pending',
    'createdAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'approverEmail', approver
  )));

  perform gp19_audit(lower(requester_email), 'request.created',
    lower(requester_email) || ' → ' || (tool->>'name'), 'info', justification,
    new_id, tool_id, lower(requester_email));

  if approver is null then
    perform gp19_audit('system', 'request.unrouted', new_id, 'error',
      (tool->>'name') || ' has no owner, so nobody was notified.', new_id, tool_id, null);
  end if;

  return new_id;
end $$;

-- ── decide it ──────────────────────────────────────────────────────────────
-- The ONLY way an entitlement is created from a request. Every check that
-- makes an approval an approval lives in here, so there is no path around it.
create or replace function gp19_decide_request(
  request_id text,
  approver_email text,
  decision text,          -- 'approve' | 'deny'
  note text default null
) returns jsonb language plpgsql as $$
declare
  req jsonb;
  tool jsonb;
  ent_id text;
  now_iso text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if decision not in ('approve','deny') then
    raise exception 'decision must be approve or deny, not %.', decision;
  end if;
  if nullif(trim(approver_email), '') is null then
    raise exception 'An approval attributed to nobody is not an approval.';
  end if;

  select data into req from requests where id = request_id for update;
  if req is null then raise exception 'No request %.', request_id; end if;

  if req->>'status' <> 'pending' then
    raise exception 'Request % is already %; it cannot be decided again.', request_id, req->>'status';
  end if;
  if lower(approver_email) = lower(req->>'requesterEmail') then
    raise exception 'A request cannot be approved by the person who raised it.';
  end if;
  if decision = 'deny' and nullif(trim(note), '') is null then
    raise exception 'A denial needs a reason: the requester has to know what would change the answer.';
  end if;

  select data into tool from catalog where id = req->>'toolId';

  if decision = 'deny' then
    update requests set data = data || jsonb_build_object(
      'status','denied','decidedAt',now_iso,'decidedBy',lower(approver_email),'decisionNote',note
    ) where id = request_id;
    perform gp19_audit(lower(approver_email), 'request.denied',
      (req->>'requesterEmail') || ' → ' || coalesce(tool->>'name', req->>'toolId'),
      'info', note, request_id, req->>'toolId', req->>'requesterEmail');
    return jsonb_build_object('status','denied');
  end if;

  -- approve
  ent_id := 'ent_' || replace(gen_random_uuid()::text, '-', '');

  insert into entitlements (id, data) values (ent_id, jsonb_strip_nulls(jsonb_build_object(
    'id', ent_id,
    'personEmail', lower(req->>'requesterEmail'),
    'personName', req->>'requesterName',
    'toolId', req->>'toolId',
    'role', req->>'role',
    'status', 'active',
    'source', 'request',
    'grantedAt', now_iso,
    'grantedBy', lower(approver_email),
    'expiresAt', req->>'expiresAt',
    'requestId', request_id,
    -- The database records the decision; it cannot call Google or Slack. The
    -- provider step is separate and must be marked when it is actually done.
    'provisionNote', 'Approved. Not yet carried out with the provider.'
  )));

  update requests set data = data || jsonb_build_object(
    'status','approved','decidedAt',now_iso,'decidedBy',lower(approver_email),
    'decisionNote',note,'entitlementId',ent_id
  ) where id = request_id;

  perform gp19_audit(lower(approver_email), 'request.approved',
    (req->>'requesterEmail') || ' → ' || coalesce(tool->>'name', req->>'toolId'),
    'ok', coalesce(note, 'Approved with no note.'), request_id, req->>'toolId', req->>'requesterEmail');

  return jsonb_build_object(
    'status','approved','entitlementId',ent_id,
    'provisioning', coalesce(tool->>'provisioning','unknown'),
    'stillToDo','The access is recorded but NOT yet live. Carry out the provider step, then call gp19_mark_provisioned.'
  );
end $$;

-- ── record that the provider step actually happened ────────────────────────
create or replace function gp19_mark_provisioned(
  entitlement_id text, actor text, detail text
) returns void language plpgsql as $$
declare ent jsonb;
begin
  select data into ent from entitlements where id = entitlement_id for update;
  if ent is null then raise exception 'No entitlement %.', entitlement_id; end if;

  update entitlements set data = data || jsonb_build_object('provisionNote', detail)
    where id = entitlement_id;
  perform gp19_audit(actor, 'grant.provisioned',
    (ent->>'personEmail') || ' → ' || (ent->>'toolId'), 'ok', detail,
    ent->>'requestId', ent->>'toolId', ent->>'personEmail');
end $$;

-- ── revoke ─────────────────────────────────────────────────────────────────
-- `succeeded` is the caller stating whether the provider actually removed it.
-- False leaves the row at pending-revoke, because a failed revoke is not a
-- revoke and must never read as one.
create or replace function gp19_revoke_entitlement(
  entitlement_id text, actor text, reason text, succeeded boolean default true
) returns jsonb language plpgsql as $$
declare
  ent jsonb;
  now_iso text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if nullif(trim(reason), '') is null then
    raise exception 'A revoke needs a reason, or it cannot be reviewed later.';
  end if;

  select data into ent from entitlements where id = entitlement_id for update;
  if ent is null then raise exception 'No entitlement %.', entitlement_id; end if;

  update entitlements set data = data || jsonb_strip_nulls(jsonb_build_object(
    'status', case when succeeded then 'revoked' else 'pending-revoke' end,
    'revokedAt', case when succeeded then now_iso else null end,
    'revokedBy', actor,
    'provisionNote', reason
  )) where id = entitlement_id;

  perform gp19_audit(actor,
    case when succeeded then 'revoke.provisioned' else 'revoke.failed' end,
    (ent->>'personEmail') || ' → ' || (ent->>'toolId'),
    case when succeeded then 'ok' else 'error' end,
    reason, ent->>'requestId', ent->>'toolId', ent->>'personEmail');

  return jsonb_build_object('status', case when succeeded then 'revoked' else 'pending-revoke' end);
end $$;
