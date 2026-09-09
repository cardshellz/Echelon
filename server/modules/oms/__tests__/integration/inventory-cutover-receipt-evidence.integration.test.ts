import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverReceiptSchemaFixtureSql } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-receipt-schema.fixture";
import { reconstructionEvidence } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-reconstruction.fixture";
import { planCutoverReconstruction } from "../../../inventory-planning/domain/inventory-cutover-reconstruction";
import { readOmsCutoverReconstruction } from "../../inventory-cutover-reconstruction.reader";
import { CUTOVER_RECEIPT_EVIDENCE_FORMAT } from "../../domain/inventory-cutover-receipt-evidence";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const fixtureSql = `
  CREATE SCHEMA oms;
  CREATE TABLE oms.oms_orders (id bigint PRIMARY KEY, status text NOT NULL);
  CREATE TABLE oms.oms_order_lines (
    id bigint PRIMARY KEY, order_id bigint, product_variant_id integer, sku text,
    authority_fulfillable_quantity integer, wms_materialized_quantity integer,
    authorization_status text, requires_shipping boolean, quantity integer
  );
  ${cutoverReceiptSchemaFixtureSql}
`;

type ReceiptSeed = {
  id: string;
  status?: string;
  provider?: string;
  channelId?: number | null;
  sourceOrderId?: string | null;
  fulfillmentId?: string | null;
  omsOrderId?: string | null;
  physicalShipmentId?: string | null;
  attemptCount?: number;
  errorCode?: string | null;
  attemptNumber?: number;
  attemptOutcome?: string;
  attemptErrorCode?: string | null;
  attemptMetadata?: Record<string, unknown>;
  withoutAttempt?: boolean;
};

describeDatabase.sequential("cutover receipt acknowledgment PostgreSQL query guarantees", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
    pool = database.pool;
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE oms.channel_fulfillment_receipt_attempts,
      oms.channel_fulfillment_receipts, oms.oms_order_lines, oms.oms_orders RESTART IDENTITY`);
  });
  afterAll(async () => { await database?.close(); });

  async function seedReceipt(seed: ReceiptSeed): Promise<void> {
    const row = { status: "ignored", provider: "shopify", channelId: 36,
      sourceOrderId: "shopify-order", fulfillmentId: "shopify-fulfillment", omsOrderId: "500",
      physicalShipmentId: "700", attemptCount: 1, errorCode: null, attemptNumber: 1,
      attemptOutcome: "ignored", attemptErrorCode: null, attemptMetadata: { sourceEcho: true },
      ...seed };
    await pool.query(`INSERT INTO oms.channel_fulfillment_receipts (
      id,processing_status,source_provider,source_channel_id,source_order_id,source_fulfillment_id,
      oms_order_id,physical_shipment_id,attempt_count,error_code,raw_payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`, [
      row.id, row.status, row.provider, row.channelId, row.sourceOrderId, row.fulfillmentId,
      row.omsOrderId, row.physicalShipmentId, row.attemptCount, row.errorCode,
      JSON.stringify({ receiptIdentity: row.id, contents: [{ lineId: "line-1", quantity: 2 }] }),
    ]);
    if (!row.withoutAttempt) {
      await pool.query(`INSERT INTO oms.channel_fulfillment_receipt_attempts
        (receipt_id,attempt_number,outcome,error_code,metadata) VALUES ($1,$2,$3,$4,$5::jsonb)`, [
        row.id, row.attemptNumber, row.attemptOutcome, row.attemptErrorCode, JSON.stringify(row.attemptMetadata),
      ]);
    }
  }

  async function capture(observeReceipts?: (rows: Record<string, unknown>[]) => void) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect((await client.query("SHOW transaction_read_only")).rows).toEqual([{ transaction_read_only: "on" }]);
      const observedClient = { query: async (text: string, values?: unknown[]) => {
        const result = await client.query(text, values);
        if (text.includes("FROM oms.channel_fulfillment_receipts receipt")) observeReceipts?.(result.rows);
        return result;
      } } as unknown as PoolClient;
      return await readOmsCutoverReconstruction(observedClient);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("groups repeated recorded acknowledgments without removing their inventory reconciliation blocker or writing", async () => {
    await seedReceipt({ id: "1" });
    await seedReceipt({ id: "2" });
    const beforeReceipts = (await pool.query("SELECT * FROM oms.channel_fulfillment_receipts ORDER BY id")).rows;
    const beforeAttempts = (await pool.query("SELECT * FROM oms.channel_fulfillment_receipt_attempts ORDER BY id")).rows;
    const captured = await capture();
    expect(captured.acceptedOmsDemand).toEqual([]);
    expect(captured.shipmentReviewEvidence).toEqual([{
      id: expect.stringMatching(/^package:700:scope:[0-9a-f]{64}$/),
      kind: "channel_fulfillment_acknowledgment", status: "ignored", evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }]);
    const plan = planCutoverReconstruction({ ...reconstructionEvidence(), ...captured });
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContainEqual({
      code: "SHIPMENT_ACKNOWLEDGMENT_REQUIRES_INVENTORY_RECONCILIATION",
      subject: `channel_fulfillment_acknowledgment:${captured.shipmentReviewEvidence[0].id}`,
      message: expect.any(String),
    });
    expect((await pool.query("SELECT * FROM oms.channel_fulfillment_receipts ORDER BY id")).rows).toEqual(beforeReceipts);
    expect((await pool.query("SELECT * FROM oms.channel_fulfillment_receipt_attempts ORDER BY id")).rows).toEqual(beforeAttempts);
  });

  it.each([
    ["pending", { status: "pending", withoutAttempt: true, attemptCount: 0 }],
    ["processing", { status: "processing", attemptCount: 2 }],
    ["review", { status: "review", attemptOutcome: "review", errorCode: "PACKAGE_ITEM_CONFLICT" }],
    ["receipt error", { errorCode: "INVENTORY_RECORD_FAILED" }],
    ["latest attempt error", { attemptErrorCode: "INVENTORY_RECORD_FAILED" }],
    ["expired attempt", { attemptOutcome: "lease_expired" }],
    ["advanced attempt counter", { attemptCount: 2 }],
    ["missing attempt", { withoutAttempt: true }],
    ["false echo", { attemptMetadata: { sourceEcho: false } }],
    ["string echo", { attemptMetadata: { sourceEcho: "true" } }],
    ["null echo", { attemptMetadata: { sourceEcho: null } }],
    ["missing echo", { attemptMetadata: {} }],
    ["missing channel", { channelId: null }],
    ["missing OMS order", { omsOrderId: null }],
    ["missing physical package", { physicalShipmentId: null }],
  ] satisfies Array<[string, Partial<ReceiptSeed>]>) (
    "keeps %s evidence individual even next to a matching recorded package", async (_label, change) => {
      await seedReceipt({ id: "1" });
      await seedReceipt({ id: "2", ...change });
      const captured = await capture();
      expect(captured.shipmentReviewEvidence).toHaveLength(2);
      expect(captured.shipmentReviewEvidence).toContainEqual({ id: "2", status: change.status ?? "ignored",
        kind: "channel_fulfillment_receipt", evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    },
  );

  it("selects the highest attempt number rather than an old clean echo or maximum attempt ID", async () => {
    await seedReceipt({ id: "1", attemptCount: 2, withoutAttempt: true });
    await pool.query(`INSERT INTO oms.channel_fulfillment_receipt_attempts
      (id,receipt_id,attempt_number,outcome,error_code,metadata) VALUES
      (900,1,1,'ignored',NULL,'{"sourceEcho":true}'),
      (100,1,2,'lease_expired','RECEIPT_LEASE_EXPIRED','{"sourceEcho":true}')`);
    expect((await capture()).shipmentReviewEvidence).toEqual([{
      id: "1", kind: "channel_fulfillment_receipt", status: "ignored", evidenceHash: expect.any(String),
    }]);
  });

  it("uses a later successful attempt and includes the latest immutable record in the digest", async () => {
    await seedReceipt({ id: "1", attemptCount: 2, attemptNumber: 1, attemptOutcome: "review",
      attemptErrorCode: "INVENTORY_RECORD_FAILED", attemptMetadata: { sourceEcho: false } });
    await pool.query(`INSERT INTO oms.channel_fulfillment_receipt_attempts
      (receipt_id,attempt_number,outcome,metadata) VALUES (1,2,'ignored','{"sourceEcho":true}')`);
    const first = await capture();
    expect(first.shipmentReviewEvidence[0].kind).toBe("channel_fulfillment_acknowledgment");
    // The reduced query fixture deliberately has no append-only trigger. A
    // changed persisted snapshot must invalidate prior review; this is not an
    // application path for editing an immutable production attempt.
    await pool.query(`UPDATE oms.channel_fulfillment_receipt_attempts
      SET metadata='{"sourceEcho":true,"inventoryEvidence":{"quantity":2}}' WHERE receipt_id=1 AND attempt_number=2`);
    const second = await capture();
    expect(second.shipmentReviewEvidence[0].id).toBe(first.shipmentReviewEvidence[0].id);
    expect(second.shipmentReviewEvidence[0].evidenceHash).not.toBe(first.shipmentReviewEvidence[0].evidenceHash);
    expect(await capture()).toEqual(second);
  });

  it("changes the digest when full receipt payload or group membership changes", async () => {
    await seedReceipt({ id: "1" });
    const original = (await capture()).shipmentReviewEvidence[0];
    await pool.query(`UPDATE oms.channel_fulfillment_receipts
      SET raw_payload='{"contents":[{"lineId":"line-1","quantity":3}]}' WHERE id=1`);
    const payloadChanged = (await capture()).shipmentReviewEvidence[0];
    expect(payloadChanged.evidenceHash).not.toBe(original.evidenceHash);
    await seedReceipt({ id: "2" });
    const membershipChanged = (await capture()).shipmentReviewEvidence[0];
    expect(membershipChanged.id).toBe(original.id);
    expect(membershipChanged.evidenceHash).not.toBe(payloadChanged.evidenceHash);
  });

  it.each([
    ["provider", { provider: "ebay" }], ["channel", { channelId: 37 }],
    ["source order", { sourceOrderId: "other-order" }], ["fulfillment", { fulfillmentId: "other-fulfillment" }],
    ["OMS order", { omsOrderId: "501" }], ["physical package", { physicalShipmentId: "701" }],
  ] satisfies Array<[string, Partial<ReceiptSeed>]>) (
    "separates otherwise duplicate packages across %s", async (_label, change) => {
      await seedReceipt({ id: "1" });
      await seedReceipt({ id: "2", ...change });
      const result = (await capture()).shipmentReviewEvidence;
      expect(result).toHaveLength(2);
      expect(result.every((row) => row.kind === "channel_fulfillment_acknowledgment")).toBe(true);
      expect(new Set(result.map((row) => row.id)).size).toBe(2);
    },
  );

  it("excludes processed receipts even when their attempt metadata is not a clean echo", async () => {
    await seedReceipt({ id: "1", status: "processed", attemptOutcome: "processed", attemptMetadata: {} });
    await seedReceipt({ id: "2", status: "review", attemptOutcome: "review" });
    expect((await capture()).shipmentReviewEvidence.map((row) => row.id)).toEqual(["2"]);
  });

  it("preserves bigint receipt and package identifiers without coercing them through JavaScript numbers", async () => {
    await seedReceipt({ id: "9007199254740993", omsOrderId: "9007199254740993", physicalShipmentId: "9007199254740995" });
    await seedReceipt({ id: "9007199254740992", omsOrderId: "9007199254740993", physicalShipmentId: "9007199254740995" });
    const result = await capture();
    expect(result.shipmentReviewEvidence).toHaveLength(1);
    expect(result.shipmentReviewEvidence[0].id)
      .toMatch(/^package:9007199254740995:scope:[0-9a-f]{64}$/);
    expect(await capture()).toEqual(result);
  });

  it("retains exact bigint attempt identity in the full evidence digest", async () => {
    await seedReceipt({ id: "1" });
    // Adjacent PostgreSQL bigint values above 2^53 must not become the same
    // evidence through a JavaScript JSON number parse. Query-fixture mutation
    // models two different persisted snapshots, not a production write path.
    await pool.query("UPDATE oms.channel_fulfillment_receipt_attempts SET id=9007199254740992 WHERE receipt_id=1");
    const first = (await capture()).shipmentReviewEvidence[0];
    await pool.query("UPDATE oms.channel_fulfillment_receipt_attempts SET id=9007199254740993 WHERE receipt_id=1");
    const second = (await capture()).shipmentReviewEvidence[0];
    expect(second.id).toBe(first.id);
    expect(second.evidenceHash).not.toBe(first.evidenceHash);
  });

  it("retains exact large numeric provider payload evidence in the digest", async () => {
    await seedReceipt({ id: "1" });
    await pool.query(`UPDATE oms.channel_fulfillment_receipts
      SET raw_payload='{"providerLineId":9007199254740992}' WHERE id=1`);
    const first = (await capture()).shipmentReviewEvidence[0];
    await pool.query(`UPDATE oms.channel_fulfillment_receipts
      SET raw_payload='{"providerLineId":9007199254740993}' WHERE id=1`);
    const second = (await capture()).shipmentReviewEvidence[0];
    expect(second.id).toBe(first.id);
    expect(second.evidenceHash).not.toBe(first.evidenceHash);
  });

  it("retains accepted-demand filters and string identities alongside the receipt census", async () => {
    await pool.query(`INSERT INTO oms.oms_orders VALUES (500,'open'),(501,'shipped');
      INSERT INTO oms.oms_order_lines VALUES
        (9007199254740993,500,101,'P5',2,2,'authorized',true,2),
        (12,501,101,'P5',2,2,'authorized',true,2),
        (13,500,101,'P5',2,2,'authorized',false,2),
        (14,500,101,'P5',0,0,'pending',true,0)`);
    expect(await capture()).toEqual({ shipmentReviewEvidence: [], acceptedOmsDemand: [{
      lineId: "9007199254740993", orderId: "500", productVariantId: 101, sku: "P5",
      authorizedQty: "2", materializedQty: "2", authorizationStatus: "authorized",
    }] });
  });

  it("enforces unique attempt numbers per receipt in the query fixture", async () => {
    await seedReceipt({ id: "1" });
    await expect(pool.query(`INSERT INTO oms.channel_fulfillment_receipt_attempts
      (receipt_id,attempt_number,outcome) VALUES (1,1,'ignored')`)).rejects.toMatchObject({ code: "23505" });
  });

  it.each([false, true])("hashes every database receipt and latest-attempt field before transport (missing attempt: %s)", async (withoutAttempt) => {
    await seedReceipt({ id: "9007199254740993", withoutAttempt });
    await pool.query(`UPDATE oms.channel_fulfillment_receipts SET
      raw_payload='{"providerLineId":9007199254740993,"text":"snowman: ☃"}',
      error_message='audit-only field',lease_token='leased-before-snapshot' WHERE id=9007199254740993`);
    const full = (await pool.query(`SELECT jsonb_build_object('receipt',to_jsonb(receipt),
      'latestAttempt',to_jsonb(attempt))::text AS envelope
      FROM oms.channel_fulfillment_receipts receipt
      LEFT JOIN LATERAL (SELECT * FROM oms.channel_fulfillment_receipt_attempts
        WHERE receipt_id=receipt.id ORDER BY attempt_number DESC LIMIT 1) attempt ON true`)).rows[0];
    let transportRows: Record<string, unknown>[] = [];
    await capture((rows) => { transportRows = rows; });
    expect(transportRows).toHaveLength(1);
    expect(transportRows[0].evidence).toEqual({ format: CUTOVER_RECEIPT_EVIDENCE_FORMAT,
      databaseRowHash: createHash("sha256").update(full.envelope).digest("hex") });
    expect(JSON.stringify(transportRows)).not.toContain("leased-before-snapshot");
    expect(JSON.stringify(transportRows)).not.toContain("providerLineId");
    const baseline = (await capture()).shipmentReviewEvidence[0];
    await pool.query(`UPDATE oms.channel_fulfillment_receipts SET lease_token='changed-audit-only-field' WHERE id=9007199254740993`);
    expect((await capture()).shipmentReviewEvidence[0].evidenceHash).not.toBe(baseline.evidenceHash);
  });

  it("keeps transferred evidence compact when complete provider payloads grow", async () => {
    await seedReceipt({ id: "1" });
    let smallBytes = 0;
    const before = await capture((rows) => { smallBytes = Buffer.byteLength(JSON.stringify(rows)); });
    await pool.query(`UPDATE oms.channel_fulfillment_receipts
      SET raw_payload=jsonb_build_object('rawProviderData',repeat('complete payload ',20000)) WHERE id=1`);
    let largeBytes = 0;
    const after = await capture((rows) => { largeBytes = Buffer.byteLength(JSON.stringify(rows)); });
    expect(largeBytes).toBe(smallBytes);
    expect(largeBytes).toBeLessThan(1000);
    expect(after.shipmentReviewEvidence[0].evidenceHash).not.toBe(before.shipmentReviewEvidence[0].evidenceHash);
  });

  it("includes newly added owner columns in the digest without changing the reader projection", async () => {
    await seedReceipt({ id: "1" });
    const before = (await capture()).shipmentReviewEvidence[0];
    try {
      await pool.query("ALTER TABLE oms.channel_fulfillment_receipt_attempts ADD COLUMN future_audit_evidence text");
      await pool.query("UPDATE oms.channel_fulfillment_receipt_attempts SET future_audit_evidence='new evidence'");
      expect((await capture()).shipmentReviewEvidence[0].evidenceHash).not.toBe(before.evidenceHash);
    } finally {
      await pool.query("ALTER TABLE oms.channel_fulfillment_receipt_attempts DROP COLUMN IF EXISTS future_audit_evidence");
    }
  });

  it("keeps malformed large sourceEcho metadata individual and compact without omitting it from the hash", async () => {
    await seedReceipt({ id: "1", attemptMetadata: { sourceEcho: { invalid: "small" } } });
    let smallBytes = 0;
    const before = await capture((rows) => { smallBytes = Buffer.byteLength(JSON.stringify(rows)); });
    await pool.query(`UPDATE oms.channel_fulfillment_receipt_attempts
      SET metadata=jsonb_build_object('sourceEcho',jsonb_build_object('invalid',repeat('not a boolean ',20000)))`);
    let largeBytes = 0;
    const after = await capture((rows) => { largeBytes = Buffer.byteLength(JSON.stringify(rows)); });
    expect(largeBytes).toBe(smallBytes);
    expect(after.shipmentReviewEvidence[0].kind).toBe("channel_fulfillment_receipt");
    expect(after.shipmentReviewEvidence[0].evidenceHash).not.toBe(before.shipmentReviewEvidence[0].evidenceHash);
  });

  it("rejects the real 100001-row census instead of returning a truncated receipt review", async () => {
    await pool.query(`INSERT INTO oms.channel_fulfillment_receipts (id,processing_status)
      SELECT n,'review' FROM generate_series(1,100001) AS n`);
    await expect(capture()).rejects.toMatchObject({ code: "OMS_CUTOVER_CENSUS_LIMIT_EXCEEDED" });
    expect((await pool.query("SELECT count(*)::text AS count FROM oms.channel_fulfillment_receipts")).rows)
      .toEqual([{ count: "100001" }]);
  }, 30_000);
});
