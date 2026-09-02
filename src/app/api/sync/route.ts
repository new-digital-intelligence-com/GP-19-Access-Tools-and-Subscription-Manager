import { NextResponse } from "next/server";
import { record } from "@/lib/audit";
import { ActionPasswordError } from "@/lib/guard";
import { syncRegister } from "@/lib/sheets";
import { getSettings, operator } from "@/lib/settings";

export const runtime = "nodejs";
/** Three upstream calls, one of them writing every row. */
export const maxDuration = 180;

/**
 * Publish the register to the shared Google Sheet.
 *
 * Deliberately a POST a human triggers, not something that runs on a timer or
 * on every write: each call costs a metered Zapier task, and a mirror that
 * fired on every approval would bill continuously for a copy nobody reads
 * between demos.
 *
 * Not password-gated. It changes no access anywhere — it copies the register
 * out to a sheet the same people already read. The confirmation password
 * guards things that alter who can get into what, and putting it here would
 * blunt it by attaching it to something harmless.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { spreadsheetId?: string };
    const settings = await getSettings();
    const spreadsheetId = body.spreadsheetId?.trim() || settings.registerSheetId || "";

    if (!spreadsheetId) {
      return NextResponse.json(
        {
          error:
            "No spreadsheet is configured. Create an empty Google Sheet, share it with the " +
            "Google account connected to Zapier, and paste its id into Settings.",
        },
        { status: 400 },
      );
    }

    const result = await syncRegister(spreadsheetId);

    // Recorded either way: a publish that failed is worth knowing about, since
    // whoever reads the sheet afterwards will be reading stale rows.
    await record({
      actor: operator(),
      action: result.ok ? "register.published" : "register.publish-failed",
      subject: spreadsheetId,
      result: result.ok ? "ok" : "error",
      detail: result.ok
        ? `${result.detail}${
            result.written
              ? ` Rows: ${Object.entries(result.written)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(", ")}.`
              : ""
          }`
        : result.detail,
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (error) {
    if (error instanceof ActionPasswordError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The publish failed." },
      { status: 500 },
    );
  }
}
