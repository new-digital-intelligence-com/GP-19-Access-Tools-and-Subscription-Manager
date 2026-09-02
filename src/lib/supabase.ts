import "server-only";

/**
 * A very small PostgREST client for the register.
 *
 * No SDK: the store needs select, upsert, insert and one RPC, and `fetch` does
 * all four in fewer lines than the wiring an extra dependency would add. It
 * also keeps this file the single place that knows the transport, the same way
 * `zapier.ts` is for the MCP side.
 *
 * The **service role** key is required and must stay server-side. It bypasses
 * row level security, which is exactly what a trusted backend wants and
 * exactly what a browser must never hold. Nothing in `src/components` may
 * import this file — the `server-only` guard above turns that into a build
 * error rather than a leak.
 */

export type SupabaseConfig = { url: string; key: string };

export function supabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

export function supabaseConfigured(): boolean {
  return supabaseConfig() !== null;
}

export class SupabaseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SupabaseError";
    this.status = status;
  }
}

function headers(config: SupabaseConfig, extra: Record<string, string> = {}) {
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function fail(response: Response, what: string): Promise<never> {
  const body = await response.text().catch(() => "");
  // PostgREST puts the useful part in `message`/`hint`; the raw body is noise.
  let detail = body.slice(0, 400);
  try {
    const parsed = JSON.parse(body) as { message?: string; hint?: string; code?: string };
    detail = [parsed.message, parsed.hint, parsed.code && `(${parsed.code})`]
      .filter(Boolean)
      .join(" ");
  } catch {
    /* keep the raw text */
  }
  throw new SupabaseError(
    `${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    response.status,
  );
}

/**
 * Every row of a table, as the stored records.
 *
 * `seq` preserves the order the app wrote them in, so a collection round-trips
 * unchanged. `newestFirst` is for the append-only trail, whose in-memory shape
 * has always been newest at index 0 — reading it ascending would silently
 * reverse every audit view.
 */
export async function selectAll<T>(table: string, newestFirst = false): Promise<T[]> {
  const config = supabaseConfig();
  if (!config) throw new SupabaseError("Supabase is not configured.", 503);

  const order = newestFirst ? "seq.desc" : "seq.asc";
  const response = await fetch(
    `${config.url}/rest/v1/${table}?select=data&order=${order}&limit=20000`,
    { headers: headers(config), cache: "no-store" },
  );
  if (!response.ok) await fail(response, `Reading ${table}`);

  const rows = (await response.json()) as { data: T }[];
  return rows.map((row) => row.data);
}

/** Insert one row. Used for the append-only trail, which never rewrites. */
export async function insertRow(table: string, id: string, data: unknown): Promise<void> {
  const config = supabaseConfig();
  if (!config) throw new SupabaseError("Supabase is not configured.", 503);

  const response = await fetch(`${config.url}/rest/v1/${table}`, {
    method: "POST",
    headers: headers(config, { Prefer: "return=minimal" }),
    body: JSON.stringify({ id, data }),
  });
  if (!response.ok) await fail(response, `Appending to ${table}`);
}

/**
 * Replace a whole collection in one transaction.
 *
 * Goes through the `replace_collection` function rather than a client-side
 * delete-then-insert, because that pair leaves a window in which the table is
 * empty — and a reader landing in it sees "nobody has access to anything",
 * which is both false and alarming.
 */
export async function replaceCollection(table: string, rows: unknown[]): Promise<void> {
  const config = supabaseConfig();
  if (!config) throw new SupabaseError("Supabase is not configured.", 503);

  const response = await fetch(`${config.url}/rest/v1/rpc/replace_collection`, {
    method: "POST",
    headers: headers(config, { Prefer: "return=minimal" }),
    body: JSON.stringify({ collection: table, rows }),
  });
  if (!response.ok) await fail(response, `Replacing ${table}`);
}

/** Cheap round trip, for the status screen. */
export async function supabaseHealth(): Promise<{
  state: "ready" | "unconfigured" | "unavailable";
  detail?: string;
}> {
  const config = supabaseConfig();
  if (!config) {
    return { state: "unconfigured", detail: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set." };
  }
  try {
    // `limit=1` on the smallest table: proves the key works and the schema is
    // there, without pulling the register down.
    const response = await fetch(`${config.url}/rest/v1/settings?select=id&limit=1`, {
      headers: headers(config),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // A 404 here means the tables are missing, which is a different fix from
      // a bad key — say which.
      const missing = response.status === 404;
      return {
        state: "unavailable",
        detail: missing
          ? "Connected, but the tables do not exist. Run supabase/schema.sql in the SQL editor."
          : `The project rejected the key (HTTP ${response.status}).`,
      };
    }
    return { state: "ready" };
  } catch (error) {
    return {
      state: "unavailable",
      detail: error instanceof Error ? error.message : "Unreachable.",
    };
  }
}
