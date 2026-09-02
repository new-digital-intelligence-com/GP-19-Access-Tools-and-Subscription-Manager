-- Run this one statement in the Supabase SQL editor.
--
-- Supabase enables pg_safeupdate, which rejects a DELETE with no WHERE clause
-- even inside a function — so the original `replace_collection` failed with
-- "DELETE requires a WHERE clause" and nothing could be written. `where true`
-- satisfies it without changing what the statement does.
--
-- Already included in schema.sql; this file is only for a database that ran
-- the earlier version.

create or replace function replace_collection(collection text, rows jsonb)
  returns void language plpgsql as $$
begin
  if collection not in ('catalog','entitlements','requests','reviews','settings') then
    raise exception 'replace_collection refuses %, which is append-only or unknown', collection;
  end if;
  execute format('delete from %I where true', collection);
  execute format(
    'insert into %I (id, data) select coalesce(r->>''id'', ''singleton''), r
       from jsonb_array_elements($1) as r', collection)
    using rows;
end $$;
