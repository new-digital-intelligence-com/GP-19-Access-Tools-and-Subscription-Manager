-- Let Claude reach the register with the ANON key, from anywhere, no invites.
--
-- Run after schema.sql and write-api.sql. Idempotent.
--
-- The anon key is meant to be public — it is what RLS exists to make safe. So
-- it can go in the skill file and the repo. The service_role key must NOT:
-- it bypasses everything below, and the skill is committed to git.
--
-- What anon gets: read everything, and call the four write functions, which
-- carry every rule with them. What it does not get: a direct INSERT, UPDATE or
-- DELETE on any table. The only way it can change access is the enforced path.

-- ── read ───────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['catalog','entitlements','requests','reviews','audit','settings'] loop
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('create policy %I_read on %I for select to anon, authenticated using (true)', t, t);
    execute format('grant select on %I to anon, authenticated', t);
  end loop;
end $$;

-- ── no direct writes ───────────────────────────────────────────────────────
-- Deliberately no INSERT/UPDATE/DELETE policy and no grant. With RLS on, the
-- absence of a policy is a denial, so a raw write from the anon key fails even
-- before the check constraints are consulted.
do $$
declare t text;
begin
  foreach t in array array['catalog','entitlements','requests','reviews','audit','settings'] loop
    execute format('revoke insert, update, delete on %I from anon, authenticated', t);
  end loop;
end $$;

-- ── writes, only through the enforced functions ────────────────────────────
-- SECURITY DEFINER so the inserts inside run as the owner and are not blocked
-- by the policies above. The rules are inside the functions, so running with
-- more privilege changes nothing about what is allowed — only who may ask.
--
-- `search_path` is pinned: a SECURITY DEFINER function that resolves names
-- through the caller's search_path is the classic way to hijack one.
alter function gp19_audit(text,text,text,text,text,text,text,text)
  security definer set search_path = public, pg_temp;
alter function gp19_raise_request(text,text,text,text,text,text)
  security definer set search_path = public, pg_temp;
alter function gp19_decide_request(text,text,text,text)
  security definer set search_path = public, pg_temp;
alter function gp19_mark_provisioned(text,text,text)
  security definer set search_path = public, pg_temp;
alter function gp19_revoke_entitlement(text,text,text,boolean)
  security definer set search_path = public, pg_temp;

-- gp19_audit is a building block of the others, not something a caller should
-- reach directly — otherwise anyone could write an arbitrary line of history.
revoke execute on function gp19_audit(text,text,text,text,text,text,text,text) from public, anon, authenticated;

grant execute on function gp19_raise_request(text,text,text,text,text,text)       to anon, authenticated;
grant execute on function gp19_decide_request(text,text,text,text)                to anon, authenticated;
grant execute on function gp19_mark_provisioned(text,text,text)                   to anon, authenticated;
grant execute on function gp19_revoke_entitlement(text,text,text,boolean)         to anon, authenticated;

-- replace_collection replaces a whole table in one shot. That is the app's
-- bulk path, never something a chat session should be able to call.
revoke execute on function replace_collection(text,jsonb) from public, anon, authenticated;
