-- GP-19 register schema.
--
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New
-- query -> paste -> Run). It is idempotent: running it again changes nothing.
--
-- Shape: one table per collection, one row per record. Every record is kept
-- whole in `data jsonb`, and the columns beside it are GENERATED from that
-- json — so the app writes one field and never has to keep a mirror in sync,
-- while Claude gets real columns to query:
--
--     select person_email, tool_id, status from entitlements where status = 'active';
--
-- `seq` preserves array order so a collection round-trips exactly as the app
-- wrote it. `updated_at` is maintained by a trigger, not by the client, so a
-- row edited by hand in the dashboard still shows when it changed.

create extension if not exists pgcrypto;

-- ── shared plumbing ────────────────────────────────────────────────────────
create or replace function set_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── catalog ────────────────────────────────────────────────────────────────
create table if not exists catalog (
  id           text primary key,
  data         jsonb not null,
  seq          bigserial,
  name         text generated always as (data->>'name') stored,
  vendor       text generated always as (data->>'vendor') stored,
  owner_email  text generated always as (data->>'ownerEmail') stored,
  provisioning text generated always as (data->>'provisioning') stored,
  sensitive    boolean generated always as ((data->>'sensitive')::boolean) stored,
  archived_at  text generated always as (data->>'archivedAt') stored,
  updated_at   timestamptz not null default now()
);

-- ── entitlements ───────────────────────────────────────────────────────────
create table if not exists entitlements (
  id            text primary key,
  data          jsonb not null,
  seq           bigserial,
  person_email  text generated always as (data->>'personEmail') stored,
  tool_id       text generated always as (data->>'toolId') stored,
  status        text generated always as (data->>'status') stored,
  source        text generated always as (data->>'source') stored,
  granted_at    text generated always as (data->>'grantedAt') stored,
  expires_at    text generated always as (data->>'expiresAt') stored,
  updated_at    timestamptz not null default now()
);
create index if not exists entitlements_person on entitlements (person_email);
create index if not exists entitlements_tool   on entitlements (tool_id);
create index if not exists entitlements_status on entitlements (status);

-- ── requests ───────────────────────────────────────────────────────────────
create table if not exists requests (
  id              text primary key,
  data            jsonb not null,
  seq             bigserial,
  requester_email text generated always as (data->>'requesterEmail') stored,
  tool_id         text generated always as (data->>'toolId') stored,
  status          text generated always as (data->>'status') stored,
  approver_email  text generated always as (data->>'approverEmail') stored,
  decided_by      text generated always as (data->>'decidedBy') stored,
  created_at      text generated always as (data->>'createdAt') stored,
  updated_at      timestamptz not null default now()
);
create index if not exists requests_status on requests (status);

-- ── reviews ────────────────────────────────────────────────────────────────
create table if not exists reviews (
  id         text primary key,
  data       jsonb not null,
  seq        bigserial,
  name       text generated always as (data->>'name') stored,
  status     text generated always as (data->>'status') stored,
  due_at     text generated always as (data->>'dueAt') stored,
  updated_at timestamptz not null default now()
);

-- ── audit ──────────────────────────────────────────────────────────────────
-- Append-only by grant, not merely by convention: the app's role may insert
-- and select, and nothing else. A trail that can be edited answers no question
-- worth asking, so the database refuses rather than trusting the caller.
create table if not exists audit (
  id           text primary key,
  data         jsonb not null,
  seq          bigserial,
  at           text generated always as (data->>'at') stored,
  actor        text generated always as (data->>'actor') stored,
  action       text generated always as (data->>'action') stored,
  result       text generated always as (data->>'result') stored,
  person_email text generated always as (data->>'personEmail') stored,
  tool_id      text generated always as (data->>'toolId') stored,
  request_id   text generated always as (data->>'requestId') stored,
  updated_at   timestamptz not null default now()
);
create index if not exists audit_seq on audit (seq desc);

-- ── settings ───────────────────────────────────────────────────────────────
-- One row, always id 'singleton'.
create table if not exists settings (
  id         text primary key,
  data       jsonb not null,
  seq        bigserial,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['catalog','entitlements','requests','reviews','audit','settings'] loop
    execute format('drop trigger if exists %I_touch on %I', t, t);
    execute format(
      'create trigger %I_touch before update on %I for each row execute function set_updated_at()',
      t, t);
  end loop;
end $$;

-- ── atomic whole-collection replace ────────────────────────────────────────
-- The app hands back a whole collection after changing one record. Doing that
-- as a delete-then-insert from the client leaves a window where the table is
-- empty, and a reader in that window sees "nobody has access to anything".
-- Inside one function it is a single transaction: readers see the old set or
-- the new one, never neither.
create or replace function replace_collection(collection text, rows jsonb)
  returns void language plpgsql as $$
begin
  if collection not in ('catalog','entitlements','requests','reviews','settings') then
    raise exception 'replace_collection refuses %, which is append-only or unknown', collection;
  end if;
  -- `where true` is not decoration: Supabase runs pg_safeupdate, which rejects
  -- an unqualified DELETE even inside a function. Without it this fails with
  -- "DELETE requires a WHERE clause" and no collection can ever be written.
  execute format('delete from %I where true', collection);
  execute format(
    'insert into %I (id, data) select coalesce(r->>''id'', ''singleton''), r
       from jsonb_array_elements($1) as r', collection)
    using rows;
end $$;

-- ── row level security ─────────────────────────────────────────────────────
-- The app connects with the service role, which bypasses RLS. These policies
-- exist so that a key which is NOT the service role — an anon key pasted into
-- a browser, say — cannot read the register.
alter table catalog       enable row level security;
alter table entitlements  enable row level security;
alter table requests      enable row level security;
alter table reviews       enable row level security;
alter table audit         enable row level security;
alter table settings      enable row level security;
