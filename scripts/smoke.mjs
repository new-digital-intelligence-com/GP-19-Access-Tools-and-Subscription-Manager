#!/usr/bin/env node
/**
 * End-to-end check of the approval path against a running dev server.
 *
 * It walks the one journey the whole product is built around — catalogue entry,
 * request, approval, entitlement, revoke, audit — and asserts the invariants at
 * each step, including the ones that only show up when something is refused:
 *
 *   - a request cannot be approved by the person who raised it
 *   - a decided request cannot be decided twice
 *   - a revoke without a reason is refused
 *   - the confirmation password is required, and a wrong one grants nothing
 *   - every step lands in the audit trail
 *
 * The test tool is created with `manual` provisioning and no owner, so nothing
 * is provisioned in Google Workspace and no mail or chat message is sent. It
 * does write to `.data/` — the rows it leaves are named "ZZ smoke test" and can
 * be deleted from the catalogue afterwards.
 *
 *   npm run dev            # in one terminal
 *   node scripts/smoke.mjs # in another
 */
const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
const PASSWORD = process.env.ACTION_PASSWORD ?? "";
const REQUESTER = "zz-smoke-requester@example.invalid";
const APPROVER = "zz-smoke-approver@example.invalid";

let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** `password` false omits the header entirely, to prove the guard blocks. */
async function call(method, path, body, password = PASSWORD) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (password) headers["x-action-password"] = password;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* some responses have no body */
  }
  return { status: response.status, body: payload ?? {} };
}

async function main() {
  console.log(`Smoke test against ${BASE}\n`);

  const status = await call("GET", "/api/status");
  if (status.status !== 200) {
    console.error(
      `The app is not answering on ${BASE} (HTTP ${status.status}). Start it with ` +
        "`npm run dev` first.",
    );
    process.exit(1);
  }
  console.log("Status");
  check("/api/status answers", status.status === 200);
  check(
    "an operator address is configured",
    status.body.operator?.configured === true,
    "set OPERATOR_EMAIL in .env.local, or approvals are refused",
  );

  console.log("\nCatalogue");
  const tool = await call("POST", "/api/catalog", {
    name: "ZZ smoke test",
    vendor: "None",
    category: "Test",
    ownerEmail: "",
    costPerSeat: 0,
    seatsPurchased: 1,
    provisioning: "manual",
    roles: ["member"],
    reviewCadenceDays: 0,
    sensitive: false,
    notes: "Created by scripts/smoke.mjs. Safe to archive.",
  });
  check("a manual tool can be created", tool.status === 200, JSON.stringify(tool.body));
  const toolId = tool.body.tool?.id;
  if (!toolId) {
    console.error("\nNo tool id came back; the rest of the run depends on it.");
    process.exit(1);
  }

  console.log("\nRequest");
  const blank = await call("POST", "/api/requests", {
    requesterEmail: REQUESTER,
    toolId,
    justification: "",
  });
  check("a request with no justification is refused", blank.status === 400, `got ${blank.status}`);

  const raised = await call("POST", "/api/requests", {
    requesterEmail: REQUESTER,
    toolId,
    role: "member",
    justification: "Smoke test of the approval path.",
  });
  check("a request can be raised", raised.status === 200, JSON.stringify(raised.body));
  const requestId = raised.body.request?.id;
  check("it starts pending, not granted", raised.body.request?.status === "pending");

  console.log("\nApproval invariants");
  const selfApproved = await call("POST", "/api/requests/decide", {
    id: requestId,
    decision: "approve",
    approverEmail: REQUESTER,
  });
  check(
    "the requester cannot approve their own request",
    selfApproved.status === 403,
    `got ${selfApproved.status}: ${selfApproved.body.error ?? ""}`,
  );

  const entitledBefore = await call("GET", `/api/entitlements?toolId=${toolId}`);
  check(
    "no entitlement exists before the approval",
    (entitledBefore.body.entitlements ?? []).length === 0,
  );

  console.log("\nConfirmation password");
  check(
    "ACTION_PASSWORD is set in the environment",
    Boolean(PASSWORD),
    "export it or the guarded checks below cannot run",
  );

  const noPassword = await call(
    "POST",
    "/api/requests/decide",
    { id: requestId, decision: "approve", approverEmail: APPROVER },
    false,
  );
  check(
    "approving with no password is refused",
    noPassword.status === 401 || noPassword.status === 503,
    `got ${noPassword.status}: ${noPassword.body.error ?? ""}`,
  );

  const wrongPassword = await call(
    "POST",
    "/api/requests/decide",
    { id: requestId, decision: "approve", approverEmail: APPROVER },
    "definitely-not-the-password",
  );
  check(
    "approving with the wrong password is refused",
    wrongPassword.status === 403 || wrongPassword.status === 503,
    `got ${wrongPassword.status}: ${wrongPassword.body.error ?? ""}`,
  );

  const stillPending = await call("GET", `/api/requests?status=pending`);
  check(
    "the refused attempts granted nothing",
    (stillPending.body.requests ?? []).some((r) => r.id === requestId),
    "the request should still be pending",
  );

  const approved = await call("POST", "/api/requests/decide", {
    id: requestId,
    decision: "approve",
    approverEmail: APPROVER,
    note: "Approved by the smoke test.",
  });
  check("an approval by someone else succeeds", approved.status === 200, JSON.stringify(approved.body));
  check(
    "a manual tool reports provisioned with a task, not a silent grant",
    approved.body.request?.status === "provisioned",
    `status ${approved.body.request?.status}`,
  );
  check("the decision names its approver", approved.body.request?.decidedBy === APPROVER);

  const twice = await call("POST", "/api/requests/decide", {
    id: requestId,
    decision: "approve",
    approverEmail: APPROVER,
  });
  check("a decided request cannot be approved again", twice.status === 409, `got ${twice.status}`);

  console.log("\nEntitlement");
  const entitled = await call("GET", `/api/entitlements?toolId=${toolId}`);
  const entitlement = (entitled.body.entitlements ?? [])[0];
  check("the approval created exactly one entitlement", (entitled.body.entitlements ?? []).length === 1);
  check("it is linked back to the request", entitlement?.requestId === requestId);
  check("it carries the tool name, not just an id", Boolean(entitlement?.toolName));

  const revokeNoPassword = await call(
    "DELETE",
    `/api/entitlements?id=${entitlement?.id}&reason=${encodeURIComponent("guard check")}`,
    undefined,
    false,
  );
  check(
    "revoking with no password is refused",
    revokeNoPassword.status === 401 || revokeNoPassword.status === 503,
    `got ${revokeNoPassword.status}`,
  );

  const noReason = await call("DELETE", `/api/entitlements?id=${entitlement?.id}`);
  check("a revoke with no reason is refused", noReason.status === 400, `got ${noReason.status}`);

  const revoked = await call(
    "DELETE",
    `/api/entitlements?id=${entitlement?.id}&reason=${encodeURIComponent("Smoke test cleanup.")}`,
  );
  check("a revoke with a reason succeeds", revoked.status === 200, JSON.stringify(revoked.body));

  console.log("\nAudit trail");
  const audit = await call("GET", `/api/audit?requestId=${requestId}`);
  const actions = (audit.body.events ?? []).map((event) => event.action);
  check("the request was recorded", actions.includes("request.created"), actions.join(", "));
  check("the approval was recorded", actions.includes("request.approved"), actions.join(", "));
  check(
    "the grant attempt was recorded",
    actions.some((action) => action.startsWith("grant.")),
    actions.join(", "),
  );

  console.log(
    failures
      ? `\n${failures} check${failures === 1 ? "" : "s"} failed.`
      : "\nAll checks passed. Archive the \"ZZ smoke test\" tool in the catalogue when done.",
  );
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nSmoke test crashed: ${error.message}`);
  process.exit(1);
});
