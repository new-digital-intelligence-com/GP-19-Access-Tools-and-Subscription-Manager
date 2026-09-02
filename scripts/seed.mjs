#!/usr/bin/env node
/**
 * Seed a starter catalogue into `.data/catalog.json`.
 *
 * An empty catalogue makes the whole app look broken: there is nothing to
 * request, nothing to review and nothing to cost. These six entries are
 * plausible placeholders covering all three provisioning methods, so every
 * screen has something real to draw on the first run.
 *
 *   node scripts/seed.mjs           # write only if the catalogue is empty
 *   node scripts/seed.mjs --force   # overwrite whatever is there
 *
 * It seeds the catalogue ONLY. Entitlements, requests and the audit trail are
 * left empty on purpose — fabricating an approval history would put entries in
 * the audit trail that never happened, which is the one thing a trail may
 * never contain.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DIR, "catalog.json");
const force = process.argv.includes("--force");
const now = new Date().toISOString();

const id = (slug) => `tool_${slug}`;

const CATALOG = [
  {
    id: id("figma"),
    name: "Figma",
    vendor: "Figma",
    category: "Design",
    ownerEmail: "",
    costPerSeat: 15,
    seatsPurchased: 10,
    provisioning: "google-group",
    groupEmail: "",
    roles: ["viewer", "editor", "admin"],
    reviewCadenceDays: 90,
    sensitive: false,
    notes:
      "Seats are gated by a Google group. Set the group address before approving " +
      "anything, or the grant has nothing behind it.",
    createdAt: now,
  },
  {
    id: id("google-workspace-business"),
    name: "Google Workspace Business Standard",
    vendor: "Google",
    category: "Productivity",
    ownerEmail: "",
    costPerSeat: 12,
    seatsPurchased: 25,
    provisioning: "google-license",
    productId: "Google-Apps",
    skuId: "1010020028",
    roles: [],
    reviewCadenceDays: 180,
    sensitive: false,
    notes:
      "The productId/skuId pair above is Google's published Business Standard SKU. " +
      "Confirm it against your own licensing page before relying on it.",
    createdAt: now,
  },
  {
    id: id("github"),
    name: "GitHub",
    vendor: "GitHub",
    category: "Engineering",
    ownerEmail: "",
    costPerSeat: 21,
    seatsPurchased: 15,
    provisioning: "manual",
    roles: ["read", "write", "maintain", "admin"],
    reviewCadenceDays: 90,
    sensitive: true,
    notes:
      "No API path from this app. An approval here produces a task for the owner, " +
      "not a grant — the entitlement stays unprovisioned until it is marked done.",
    createdAt: now,
  },
  {
    id: id("aws-console"),
    name: "AWS Console",
    vendor: "Amazon",
    category: "Infrastructure",
    ownerEmail: "",
    costPerSeat: 0,
    seatsPurchased: 0,
    provisioning: "manual",
    roles: ["read-only", "developer", "administrator"],
    reviewCadenceDays: 30,
    sensitive: true,
    notes:
      "Sensitive and reviewed monthly. Cost is 0 because access itself is free — " +
      "the spend is usage, which this app does not track.",
    createdAt: now,
  },
  {
    id: id("notion"),
    name: "Notion",
    vendor: "Notion",
    category: "Productivity",
    ownerEmail: "",
    costPerSeat: 10,
    seatsPurchased: 30,
    provisioning: "google-group",
    groupEmail: "",
    roles: ["member", "guest"],
    reviewCadenceDays: 180,
    sensitive: false,
    createdAt: now,
  },
  {
    id: id("slack-leadership"),
    name: "Slack — #leadership",
    vendor: "Slack",
    category: "Communication",
    ownerEmail: "",
    costPerSeat: 0,
    seatsPurchased: 0,
    provisioning: "slack-channel",
    slackChannelId: "",
    roles: ["member"],
    reviewCadenceDays: 90,
    sensitive: true,
    notes:
      "A private channel is an access surface like any other: it holds decisions " +
      "and nobody ever leaves one. Set the channel id before approving anything. " +
      "Cost is 0 because the seat is the Slack licence, tracked separately.",
    createdAt: now,
  },
  {
    id: id("1password"),
    name: "1Password",
    vendor: "AgileBits",
    category: "Security",
    ownerEmail: "",
    costPerSeat: 8,
    seatsPurchased: 30,
    provisioning: "manual",
    roles: ["member", "vault-admin", "owner"],
    reviewCadenceDays: 30,
    sensitive: true,
    notes:
      "Holds every other credential, so a stale grant here is worth more to an " +
      "attacker than the tool it unlocks. Reviewed monthly; never a default approver.",
    createdAt: now,
  },
];

async function main() {
  await mkdir(DIR, { recursive: true });

  if (!force) {
    try {
      const existing = JSON.parse(await readFile(FILE, "utf8"));
      if (Array.isArray(existing) && existing.length) {
        console.log(
          `${FILE} already holds ${existing.length} tools. ` +
            "Re-run with --force to replace them.",
        );
        return;
      }
    } catch {
      /* no catalogue yet, which is the case this script is for */
    }
  }

  await writeFile(FILE, JSON.stringify(CATALOG, null, 2), "utf8");
  console.log(`Wrote ${CATALOG.length} tools to ${FILE}.`);
  console.log(
    "\nBefore approving anything, set each tool's owner (it is who the approval is " +
      "routed to) and fill in the group address for the google-group tools. An " +
      "approval on a tool with a provisioning gap is refused rather than faked.",
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
