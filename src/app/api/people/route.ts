import { NextResponse } from "next/server";
import { listTools } from "@/lib/catalog";
import { listEntitlements } from "@/lib/entitlements";
import * as directory from "@/lib/providers/directory";
import * as workspace from "@/lib/providers/workspace";
import type { Entitlement } from "@/lib/types";

export const runtime = "nodejs";

/**
 * A directory read can be several paged calls against Zapier, each one a
 * round trip to Google. The default serverless window is not enough on a real
 * org, and a truncated directory is worse than a slow one: it silently
 * understates who has access.
 */
export const maxDuration = 180;

/**
 * People, as Google Workspace has them.
 *
 * Two shapes: the whole directory, and one account in full. An unreadable
 * directory is reported as `available: false` with the reason, never as an
 * empty list — "nobody works here" and "we could not ask" look identical on a
 * screen that only knows how to draw rows.
 *
 * Note what this endpoint does not claim. Workspace holds accounts, not
 * employment. `accountState` describes the account; nothing here says whether
 * a person still works at the company, because nothing connected to this app
 * knows that.
 */

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function GET(request: Request) {
  const email = new URL(request.url).searchParams.get("email")?.trim().toLowerCase() ?? "";
  return email ? oneAccount(email) : wholeDirectory();
}

async function wholeDirectory() {
  try {
    const result = await directory.directory();
    // `detail` is carried through on a successful read too: it is set when the
    // scan stopped at the page cap, and a partial directory presented as a
    // complete one is the failure mode worth guarding hardest against.
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({
      available: false,
      people: [],
      detail:
        `The Workspace directory could not be read: ${reason(error)}. Nothing was ` +
        "listed, so this is not a finding that nobody has an account.",
    });
  }
}

/**
 * One account, with the two things the detail view needs alongside it: the
 * live account state and what the register says they hold. Both are guarded
 * separately — a Zapier outage must not hide entitlements that are stored
 * locally and are still exactly right.
 */
async function oneAccount(email: string) {
  const [found, account, entitlements, tools] = await Promise.all([
    directory.findPerson(email).catch((error: unknown) => ({
      available: false as const,
      detail: reason(error),
    })),
    workspace.accountState(email).catch(() => ({ found: false })),
    listEntitlements({ personEmail: email }).catch(() => [] as Entitlement[]),
    listTools(true).catch(() => []),
  ]);

  const names = new Map(tools.map((tool) => [tool.id, tool.name]));

  return NextResponse.json({
    available: found.available,
    detail: found.detail,
    person: "person" in found ? found.person : undefined,
    account,
    entitlements: entitlements.map((item) => ({
      ...item,
      toolName: names.get(item.toolId) ?? item.toolId,
    })),
  });
}
