import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { APPROVED_RECORDS_CLEANUP_LINE_IDS, canonicalHash, executeRecordsCleanup, RecordsCleanupError,
  type CleanupRequest } from "./inventory-cutover-records-execution-20260925";
import { buildProposal, type ProviderFact } from "./inventory-cutover-records-proposal-20260925";

function fixture() {
  const line = (id: string, orderId: string) => ({ id, order_id: orderId, external_line_item_id: `line-${id}`,
    quantity: 1, paid_quantity: 1, cancelled_quantity: 0, refunded_quantity: 0, authority_fulfillable_quantity: 1,
    wms_materialized_quantity: 1, authorization_status: "authorized", fulfillment_status: "unfulfilled",
    requires_shipping: true, row_hash: "a".repeat(64) });
  const order = (id: string) => ({ id, channel_id: 36, external_order_id: `order-${id}`, external_order_number: id,
    status: "confirmed", fulfillment_status: "unfulfilled", financial_status: "paid", row_hash: "b".repeat(64) });
  const lines = [...APPROVED_RECORDS_CLEANUP_LINE_IDS.map(id => line(id, "1")), line("119866", "2")];
  const context = { checked_at: "2026-09-25T20:00:00.000Z", read_only: "on", productionWrites: false, executable: false,
    approvedClosedLineIds: [...APPROVED_RECORDS_CLEANUP_LINE_IDS] as string[], preservedOpenLineId: "119866",
    orders: [order("1"), order("2")], lines, adjustments: [] };
  const facts: ProviderFact[] = lines.map(row => ({ channelId: 36, orderId: `order-${row.order_id}`,
    lineId: row.external_line_item_id, quantity: 1, outcome: row.order_id === "1" ? "fulfilled" : "open", refunds: [] }));
  const request: CleanupRequest = { context, facts, expectedPlanHash: canonicalHash(buildProposal(context, facts)),
    sourceHashes: { context: "a".repeat(64), shopify: "b".repeat(64), marketplace: "c".repeat(64) },
    actor: "test-operator", reason: "Test records-only contract", occurredAt: "2026-09-25T21:00:00.000Z",
    expectedAuthorityRevision: "1", expectedTriggerHash: "d".repeat(64) };
  return { context, facts, request };
}

function connectionMustNotRun() {
  let calls = 0;
  const pool = { connect: async () => { calls++; throw new Error("Connection forbidden in this contract test"); } } as unknown as Pick<Pool, "connect">;
  return { pool, assertNotCalled: () => assert.equal(calls, 0) };
}
async function reject(request: CleanupRequest, code: string): Promise<void> {
  const guard = connectionMustNotRun();
  await assert.rejects(() => executeRecordsCleanup(guard.pool, request), error => error instanceof RecordsCleanupError && error.code === code);
  guard.assertNotCalled();
}

test("canonical hash is key-order independent but respects array order and field values", () => {
  assert.equal(canonicalHash({ b: [1, 2], a: null }), canonicalHash({ a: null, b: [1, 2] }));
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: "1" }));
});
test("invalid metadata and malformed evidence fail before connecting", async () => {
  const { request } = fixture();
  await reject({ ...request, actor: " " }, "INVALID_CLEANUP_EVIDENCE");
  await reject({ ...request, occurredAt: "yesterday" }, "INVALID_CLEANUP_EVIDENCE");
  await reject({ ...request, context: {} }, "INVALID_CLEANUP_EVIDENCE");
});
test("plan hash disagreement fails before connecting", async () => {
  await reject({ ...fixture().request, expectedPlanHash: "0".repeat(64) }, "PLAN_HASH_MISMATCH");
});
test("a valid-looking forty-two-line proposal with a different target is not approved", async () => {
  const { context, facts, request } = fixture();
  context.lines[0].id = "999999"; context.approvedClosedLineIds[0] = "999999";
  await reject({ ...request, expectedPlanHash: canonicalHash(buildProposal(context, facts)) }, "UNAPPROVED_SCOPE");
});
test("refund treatment that would change remaining authority is a different unapproved operation", async () => {
  const { context, facts, request } = fixture();
  facts[0] = { ...facts[0], outcome: "refunded", refunds: [{ refundId: "refund-fixture", quantity: 1, restockPolicy: "no_restock" }] };
  await reject({ ...request, expectedPlanHash: canonicalHash(buildProposal(context, facts)) }, "WRITE_OUTSIDE_REVIEWED_FIELDS");
});
test("connection errors are classified without exposing connection details", async () => {
  const pool = { connect: async () => { throw new Error("secret connection details"); } } as unknown as Pick<Pool, "connect">;
  await assert.rejects(() => executeRecordsCleanup(pool, fixture().request), error => error instanceof RecordsCleanupError
    && error.code === "CLEANUP_CONNECTION_FAILED" && !error.message.includes("secret"));
});
test("transaction failure is classified, rolled back, and its connection discarded", async () => {
  const statements: string[] = [];
  let discarded = false;
  const client = { query: async (sql: string) => {
    statements.push(sql); if (sql !== "ROLLBACK") throw Object.assign(new Error("private SQL details"), { code: "08006" });
    return { rows: [] };
  }, release: (destroy: boolean) => { discarded = destroy; } } as unknown as PoolClient;
  const pool = { connect: async () => client } as Pick<Pool, "connect">;
  await assert.rejects(() => executeRecordsCleanup(pool, fixture().request), error => error instanceof RecordsCleanupError
    && error.code === "CLEANUP_TRANSACTION_FAILED" && error.databaseCode === "08006" && !error.message.includes("private"));
  assert.deepEqual(statements, ["BEGIN ISOLATION LEVEL SERIALIZABLE", "ROLLBACK"]); assert.equal(discarded, true);
});
test("failed rollback is explicitly uncertain, not reported as completed rollback", async () => {
  let discarded = false;
  const client = { query: async () => { throw new Error("Disconnected"); }, release: (destroy: boolean) => { discarded = destroy; } } as unknown as PoolClient;
  const pool = { connect: async () => client } as Pick<Pool, "connect">;
  await assert.rejects(() => executeRecordsCleanup(pool, fixture().request), error => error instanceof RecordsCleanupError
    && error.code === "ROLLBACK_RESULT_UNCONFIRMED");
  assert.equal(discarded, true);
});
