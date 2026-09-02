import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The register's storage: JSON files under `.data/`.
 *
 * The catalogue, entitlements, requests, reviews, audit trail and settings all
 * live here. Nothing else in the app knows or cares how they are persisted —
 * everything goes through `readStore` / `writeStore` / `mutate` / `append`.
 *
 * The Claude skill keeps its own copy of the register in a Google Sheet, read
 * through the Drive connector. The two are deliberately separate: this app is
 * the system of record, and the sheet is what a Claude session can reach.
 *
 * Swap this file for a database when it serves more than one operator; the
 * shapes above it are narrow enough that nothing else has to change.
 */
const DIR = path.join(process.cwd(), ".data");

async function file(name: string) {
  await mkdir(DIR, { recursive: true });
  return path.join(DIR, `${name}.json`);
}

export async function readStore<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(await file(name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Writes go through a temp file and a rename.
 *
 * An audit trail truncated by a crash mid-write reads afterwards as "nothing
 * happened", which is worse than useless. A rename is atomic on the same
 * filesystem, so a reader sees either the old file or the whole new one.
 */
export async function writeStore<T>(name: string, value: T): Promise<void> {
  const target = await file(name);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, target);
}

/**
 * Add one record to an append-only collection.
 *
 * Separate from `writeStore` so the trail is never replaced wholesale — the
 * only way in is the front.
 */
export async function append<T extends { id: string }>(
  name: string,
  record: T,
  cap = 20000,
): Promise<T> {
  return mutate<T[], T>(name, [], (log) => ({
    next: [record, ...log].slice(0, cap),
    result: record,
  }));
}

/**
 * Serialise read-modify-write on one collection.
 *
 * Two approvals landing at once would otherwise each read the same array and
 * the second write would drop the first grant. A per-name promise chain is
 * enough while this is one process; a database transaction replaces it when it
 * is not.
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
