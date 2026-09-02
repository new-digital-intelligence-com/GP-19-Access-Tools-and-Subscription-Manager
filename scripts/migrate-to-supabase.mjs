#!/usr/bin/env node
/**
 * Move the register from `.data/*.json` into Supabase, once.
 *
 * Run it on the machine that holds the real data — the register lives in files
 * beside the app, so a copy of the repo elsewhere has a different one.
 *
 *   node scripts/migrate-to-supabase.mjs            # show what would move
 *   node scripts/migrate-to-supabase.mjs --write    # actually move it
 *
 * Order of operations is deliberate: write, read back, compare, and only then
 * put the local files aside. Nothing is deleted — `.data` is renamed to
 * `.data.migrated-<timestamp>`, so a mistake costs a rename to undo.
 *
 * Refuses to overwrite a table that already has rows unless you pass --force,
 * because running this twice against a live register would replace whatever
 * had happened in between.
 */
import { readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";

const DIR = path.join(process.cwd(), ".data");
const WRITE = process.argv.includes("--write");
const FORCE = process.argv.includes("--force");

const COLLECTIONS = ["catalog", "entitlements", "requests", "reviews", "audit", "settings"];

function env() {
  const out = {};
  try {
    for (const line of require("node:fs").readFileSync(".env.local", "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* fall back to the environment */
  }
  return {
    url: (process.env.SUPABASE_URL || out.SUPABASE_URL || "").replace(/\/+$/, ""),
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || out.SUPABASE_SERVICE_ROLE_KEY || "",
  };
}

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const { url, key } = env();

if (!url || !key) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set in .env.local.");
  process.exit(1);
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

async function localRecords(name) {
  try {
    const parsed = JSON.parse(await readFile(path.join(DIR, `${name}.json`), "utf8"));
    if (name === "settings") {
      return Object.keys(parsed || {}).length ? [{ id: "singleton", ...parsed }] : [];
    }
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function remoteCount(name) {
  const response = await fetch(`${url}/rest/v1/${name}?select=id`, { headers });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status} reading`);
  return (await response.json()).length;
}

async function push(name, records) {
  // The trail keeps its own order; everything else round-trips by `seq`, and
  // inserting in array order is what preserves it.
  const rows = records.map((r) => ({ id: r.id ?? "singleton", data: r }));
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const response = await fetch(`${url}/rest/v1/${name}`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal,resolution=merge-duplicates" },
      body: JSON.stringify(rows.slice(i, i + CHUNK)),
    });
    if (!response.ok) {
      throw new Error(`${name}: HTTP ${response.status} — ${(await response.text()).slice(0, 300)}`);
    }
  }
}

async function main() {
  try {
    await readdir(DIR);
  } catch {
    console.error(`No .data directory here (${DIR}). Run this where the app runs.`);
    process.exit(1);
  }

  console.log(`Register at ${DIR}`);
  console.log(`Supabase   ${url}\n`);

  const plan = [];
  let total = 0;
  for (const name of COLLECTIONS) {
    const records = await localRecords(name);
    const already = await remoteCount(name);
    plan.push({ name, records, already });
    total += records.length;
    console.log(
      `  ${name.padEnd(14)} ${String(records.length).padStart(5)} local  ` +
        `${String(already).padStart(5)} already in Supabase` +
        (already && !FORCE ? "   <-- would be left alone" : ""),
    );
  }

  const blocked = plan.filter((p) => p.already > 0 && p.records.length > 0);
  if (blocked.length && !FORCE) {
    console.log(
      `\n${blocked.map((b) => b.name).join(", ")} already hold rows. Re-running would ` +
        "duplicate or overwrite them.\nPass --force only if you are sure the remote copy is stale.",
    );
  }

  if (!total) {
    console.log("\nNothing to move.");
    return;
  }
  if (!WRITE) {
    console.log("\nDry run. Re-run with --write to move it.");
    return;
  }

  console.log("\nWriting…");
  for (const { name, records, already } of plan) {
    if (!records.length) continue;
    if (already > 0 && !FORCE) {
      console.log(`  skip  ${name} (already populated)`);
      continue;
    }
    await push(name, records);
    console.log(`  ok    ${name} — ${records.length}`);
  }

  // Verify before touching anything local. A migration that reports success on
  // a write it never checked is how data goes missing quietly.
  console.log("\nVerifying…");
  let good = true;
  for (const { name, records } of plan) {
    if (!records.length) continue;
    const now = await remoteCount(name);
    const ok = now >= records.length;
    good &&= ok;
    console.log(`  ${ok ? "ok   " : "FAIL "} ${name} — ${now} rows in Supabase`);
  }

  if (!good) {
    console.error("\nVerification failed. The local files have been left exactly where they are.");
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const parked = `${DIR}.migrated-${stamp}`;
  await rename(DIR, parked);
  console.log(`\nDone. Local register moved aside to:\n  ${parked}`);
  console.log("Delete it once you are happy. The app now reads Supabase.");
}

main().catch((error) => {
  console.error(`\nMigration failed: ${error.message}`);
  console.error("Nothing local was moved.");
  process.exit(1);
});
