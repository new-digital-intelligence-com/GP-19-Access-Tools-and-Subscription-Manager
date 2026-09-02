import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  insertRow,
  replaceCollection,
  selectAll,
  supabaseConfigured,
} from "./supabase";

/**
 * The register's storage, with two backends behind one interface.
 *
 * **Supabase, when it is configured.** Postgres is the shared store: this app
 * writes it and a Claude session with the Supabase connector reads the same
 * rows, so neither surface has a private copy to fall out of step. That is the
 * whole reason it exists — not scale.
 *
 * **JSON files, otherwise.** `.data/*.json`, so the app runs with nothing
 * configured. The two are never used together: mixing them would give two
 * registers that silently disagree, which is worse than either alone.
 *
 * Everything above this file — catalogue, entitlements, requests, reviews,
 * audit, settings — is written against `readStore` / `writeStore` / `mutate`
 * and does not know or care which backend answered.
 */

const DIR = path.join(process.cwd(), ".data");

/** Collections that live as one row per record. `settings` is a lone object. */
const COLLECTIONS = new Set([
  "catalog",
  "entitlements",
  "requests",
  "reviews",
  "audit",
  "settings",
]);

async function file(name: string) {
  await mkdir(DIR, { recursive: true });
  return path.join(DIR, `${name}.json`);
}

async function readFileStore<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(await file(name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * File writes go through a temp file and a rename.
 *
 * An audit trail truncated by a crash mid-write reads afterwards as "nothing
 * happened". A rename is atomic on the same filesystem, so a reader sees
 * either the old file or the whole new one.
 */
async function writeFileStore<T>(name: string, value: T): Promise<void> {
  const target = await file(name);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, target);
}

export async function readStore<T>(name: string, fallback: T): Promise<T> {
  if (!supabaseConfigured() || !COLLECTIONS.has(name)) {
    return readFileStore(name, fallback);
  }

  // The trail is stored newest-first in memory; read it back the same way or
  // every audit view silently inverts.
  const rows = await selectAll<unknown>(name, name === "audit");

  // `settings` is a single object stored as one row; everything else is a list.
  if (name === "settings") {
    return (rows[0] ?? fallback) as T;
  }
  return rows as unknown as T;
}

export async function writeStore<T>(name: string, value: T): Promise<void> {
  if (!supabaseConfigured() || !COLLECTIONS.has(name)) {
    return writeFileStore(name, value);
  }

  if (name === "audit") {
    // Never rewritten wholesale: the table is append-only, and re-inserting
    // twenty thousand rows to record one event would be absurd as well as
    // wrong. `append` below is the only way in.
    throw new Error("The audit trail is append-only; use append() rather than writeStore().");
  }

  const rows =
    name === "settings"
      ? [{ id: "singleton", ...(value as Record<string, unknown>) }]
      : (value as unknown as Record<string, unknown>[]);

  await replaceCollection(name, rows);
}

/**
 * Add one record to an append-only collection.
 *
 * Separate from `writeStore` because the trail must never be replaced — on
 * Postgres that is enforced by this being the only insert path, and on files
 * it keeps the same shape so the two backends behave alike.
 */
export async function append<T extends { id: string }>(
  name: string,
  record: T,
  cap = 20000,
): Promise<T> {
  if (!supabaseConfigured() || !COLLECTIONS.has(name)) {
    return mutate<T[], T>(name, [], (log) => ({
      next: [record, ...log].slice(0, cap),
      result: record,
    }));
  }
  await insertRow(name, record.id, record);
  return record;
}

/**
 * Serialise read-modify-write on one collection.
 *
 * Two approvals landing at once would otherwise each read the same array and
 * the second write would drop the first grant. A per-name promise chain covers
 * this process; on Postgres the replace itself is one transaction, so a reader
 * never sees a half-written collection.
 *
 * What it does **not** cover is a second writer — another instance of the app,
 * or a Claude session writing through the Supabase connector. Postgres would
 * take both writes and the later one would win wholesale. Keep writes on one
 * surface, or move these to row-level updates before running two.
 */
const chains = new Map<string, Promise<unknown>>();

export function mutate<T, R>(
  name: string,
  fallback: T,
  change: (current: T) => Promise<{ next: T; result: R }> | { next: T; result: R },
): Promise<R> {
  const run = (chains.get(name) ?? Promise.resolve()).then(async () => {
    const current = await readStore<T>(name, fallback);
    const { next, result } = await change(current);
    await writeStore(name, next);
    return result;
  });
  // Keep the chain alive even when this link rejects, or one failed write
  // would deadlock every later write to the same collection.
  chains.set(
    name,
    run.catch(() => undefined),
  );
  return run as Promise<R>;
}

/** Sortable, readable, and unique enough for a single-tenant register. */
export function newId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}${noise}`;
}

/** Which backend is actually answering, for the status screen. */
export function storeBackend(): "supabase" | "files" {
  return supabaseConfigured() ? "supabase" : "files";
}
