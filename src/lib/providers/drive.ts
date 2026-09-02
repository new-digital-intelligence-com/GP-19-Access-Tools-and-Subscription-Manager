import "server-only";
import { callTool } from "../zapier";

/**
 * Google Drive storage, for the subscription view.
 *
 * **What Google does not give you: a price.** There is no billing API behind
 * any of these tools. Drive reports how much of the pool exists and how much
 * is used, and nothing more — so this module reports exactly that and leaves
 * the money to the catalogue, where a human typed what they actually pay.
 *
 * Printing an invented dollar figure here would be the worst kind of wrong: it
 * would look authoritative on a page whose entire job is to be honest about
 * what is known.
 *
 * The pool itself is normally bought through Workspace licences rather than on
 * its own — Business Standard is 2 TiB per licence, pooled across the domain —
 * so the cost of storage is usually the cost of a catalogue row that already
 * exists. Extra capacity bought as its own SKU is a separate catalogue entry
 * the operator adds.
 */

export type Storage = {
  available: boolean;
  detail?: string;
  /** Bytes. `null` means unlimited, which Google reports by omitting the field. */
  limit: number | null;
  /** Bytes used across everything that counts against the pool. */
  usage: number | null;
  /** Bytes used by Drive files specifically, for the connected account. */
  usageInDrive: number | null;
  usageInTrash: number | null;
};

function bytes(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function storage(): Promise<Storage> {
  const empty: Storage = {
    available: false,
    limit: null,
    usage: null,
    usageInDrive: null,
    usageInTrash: null,
  };

  const result = await callTool("google_drive_make_api_get_request", {
    url: "https://www.googleapis.com/drive/v3/about",
    // A record, not an encoded string — the string form is rejected outright.
    querystring: { fields: "storageQuota" },
    output_hint:
      "the storage quota limit, usage, usageInDrive and usageInDriveTrash values",
  });

  if (!result.ok) {
    return { ...empty, detail: result.error ?? "Drive storage could not be read." };
  }

  // Zapier flattens the response, and whether it arrives as `results` (an
  // object here, not the usual array) or as the raw body depends on the
  // action's own shaping, so both are accepted.
  const payload = (result.data ?? {}) as Record<string, unknown>;
  const row = (payload.results ?? result.results[0] ?? payload) as Record<string, unknown>;

  return {
    available: true,
    // Google omits `limit` entirely on an unlimited pool. Absent is not zero,
    // and rendering it as 0 would read as "no storage at all".
    limit: bytes(row.limit),
    usage: bytes(row.usage),
    usageInDrive: bytes(row.usageInDrive),
    usageInTrash: bytes(row.usageInDriveTrash),
  };
}
