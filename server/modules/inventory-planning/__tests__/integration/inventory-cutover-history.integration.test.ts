import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpeningSource, OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql, cutoverCompositionSeedSql, installCutoverCompositionMigrations } from "../fixtures/inventory-cutover-composition-database.fixture";
import { installCutoverAdmissionFixturePrerequisites } from "../fixtures/inventory-cutover-admission.fixture";
import { InventoryCutoverHistoryService } from "../../application/inventory-cutover-history.service";
import { PostgresInventoryCutoverHistoryRepository } from "../../infrastructure/inventory-cutover-history.repository";
import { PostgresInventoryCutoverOpeningRepository } from "../../infrastructure/inventory-cutover-opening.repository";
import { readHistoryAuditRows, readRetiredCutoverHistory, validateHistoryAudit, type HistoryAuditRow } from "../../infrastructure/inventory-cutover-history-audit.reader";
import { assertReceiptNotRetired, assertShipmentNotRetiredPg } from "../../infrastructure/inventory-cutover-retired-work";
import { planCutoverReconstruction } from "../../domain/inventory-cutover-reconstruction";
import { createChannelFulfillmentIngressRepository } from "../../../oms/channel-fulfillment-ingress.repository";
import { normalizeChannelFulfillmentIngress } from "../../../oms/channel-fulfillment-ingress";

vi.mock("../../../../db", () => ({ pool: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;

// Real admission + production history audit DDL, connected to the real census,
// classifier and opening evaluator. Foreign-owner schemas remain reduced.
const historySeed = `
ALTER TABLE oms.channel_fulfillment_receipts ALTER COLUMN created_at SET DEFAULT '2026-01-01T00:00:00Z';
-- SQL-only lease column from migration 0593; the other queried columns are
-- supplied from Drizzle by installCutoverAdmissionFixturePrerequisites.
ALTER TABLE oms.channel_fulfillment_receipts ADD COLUMN last_attempt_at timestamptz;
CREATE TABLE oms.channel_fulfillment_receipt_items(id bigint PRIMARY KEY,receipt_id bigint REFERENCES oms.channel_fulfillment_receipts(id),quantity integer);
CREATE TABLE wms.shipment_requests(id bigint PRIMARY KEY,legacy_wms_shipment_id integer REFERENCES wms.outbound_shipments(id));
CREATE TABLE wms.shipping_provider_labels(id bigint PRIMARY KEY,label_status text);
CREATE TABLE wms.shipping_provider_label_links(id bigint PRIMARY KEY,shipping_provider_label_id bigint REFERENCES wms.shipping_provider_labels(id),legacy_wms_shipment_id integer REFERENCES wms.outbound_shipments(id));
CREATE TABLE wms.pick_corrections(id integer PRIMARY KEY,order_item_id integer REFERENCES wms.order_items(id),state text);
INSERT INTO oms.oms_orders(id,channel_id,external_order_id,status) VALUES(50,36,'history-2','shipped');
INSERT INTO oms.oms_order_lines(id,order_id,sku,product_variant_id,quantity,requires_shipping,authority_fulfillable_quantity,wms_materialized_quantity,authorization_status,fulfillment_status)
 VALUES(51,50,'P5',101,1,true,1,1,'authorized','fulfilled');
INSERT INTO wms.orders(id,warehouse_id,warehouse_status,on_hold,channel_id,source,external_order_id,oms_fulfillment_order_id,fulfillment_partition_key)
 VALUES(2,1,'shipped',0,36,'shopify','history-2','fo-2','default');
INSERT INTO wms.order_items(id,order_id,oms_order_line_id,source_item_id,sku,product_id,quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping)
 VALUES(21,2,51,'source-21','P5',101,1,1,1,'completed',false,1);
INSERT INTO wms.outbound_shipments(id,order_id,status,requires_review,shipment_purpose,held)
 VALUES(90,2,'cancelled',true,'customer_fulfillment',false);
INSERT INTO wms.outbound_shipment_items(id,shipment_id,order_item_id,product_variant_id,qty,shipment_item_purpose)
 VALUES(91,90,21,101,1,'customer_fulfillment');
INSERT INTO oms.channel_fulfillment_receipts(id,processing_status,source_provider,source_channel_id,source_order_id,source_fulfillment_id,oms_order_id,attempt_count)
 VALUES(20,'review','shopify',36,'history-2','fulfillment-2',50,1);
INSERT INTO oms.channel_fulfillment_receipt_attempts(receipt_id,attempt_number,outcome,metadata) VALUES(20,1,'review','{"original":true}');
INSERT INTO oms.channel_fulfillment_receipt_items VALUES(1,20,1);
INSERT INTO wms.shipping_provider_labels VALUES(1,'active');
INSERT INTO wms.shipping_provider_label_links VALUES(1,1,90);
`;

function verification(source: OpeningSource): OpeningVerification {
  return { contractVersion: "inventory_cutover_opening_v1", expectedEvidenceHash: source.evidenceHash,
    expectedAuthorityRevision: source.authorityRevision, expectedConfigurationRunId: source.configurationRunId,
    verificationReference: "Test: independent opening", verificationEvidenceHash: "c".repeat(64),
    verifiedAt: source.capturedAt, historicalDisposition: "preserve_unresolved", levels: source.evidence.levels,
    lots: source.evidence.lots, owners: [{ orderId: 1, orderItemId: 11, remainingQty: "6", reservedQty: "3", pickedQty: "2",
      allocations: [{ inventoryLevelId: 10, lots: [{ inventoryLotId: 4, reservedQty: "3", pickedQty: "2", originalCostIds: [9] }] }] }] };
}

dbDescribe.sequential("narrow audited historical-work retirement in real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  let service: InventoryCutoverHistoryService;
  let opening: PostgresInventoryCutoverOpeningRepository;
  beforeEach(async () => {
    await database?.close();
    database = await createInventoryCutoverTestDatabase(url,disposable,cutoverCompositionBaseSql);
    pool = database.pool;
    await installCutoverCompositionMigrations(pool);
    await pool.query(cutoverCompositionSeedSql);
    await installCutoverAdmissionFixturePrerequisites(pool);
    for (const name of ["236_inventory_cutover_admission.sql","240_inventory_cutover_verified_opening.sql"]) {
      await pool.query(readFileSync(`migrations/${name}`,"utf8"));
    }
    await pool.query(historySeed);
    service = new InventoryCutoverHistoryService(new PostgresInventoryCutoverHistoryRepository(pool));
    opening = new PostgresInventoryCutoverOpeningRepository(pool);
  },30_000);
  afterAll(async () => { await database?.close(); });
  async function request(key = "history-1") {
    const review = await service.review("operator");
    expect(review.readyForRetirement).toBe(true);
    return { expectedReviewHash: review.reviewHash, expectedAuthorityRevision: review.authorityRevision,
      expectedConfigurationRunId: review.configurationRunId, acceptUnresolvedOrigin: false,
      reason: "Retire exact old processing; preserve all stock and history", idempotencyKey: key };
  }
  async function businessState() {
    const state: Record<string,unknown> = {};
    for (const table of ["inventory.inventory_levels","inventory.inventory_lots","inventory.inventory_transactions",
      "inventory.availability_claims","inventory.availability_runtime_authority","oms.order_item_costs",
      "oms.oms_orders","oms.oms_order_lines","oms.channel_fulfillment_receipts","oms.channel_fulfillment_receipt_items",
      "oms.channel_fulfillment_receipt_attempts","wms.orders","wms.order_items","wms.outbound_shipments",
      "wms.outbound_shipment_items","wms.physical_shipments","wms.physical_shipment_items",
      "wms.shipping_provider_labels","wms.shipping_provider_label_links"]) {
      state[table] = (await pool.query(`SELECT jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text) AS data FROM ${table} row`)).rows[0].data;
    }
    return state;
  }
  async function auditCount() { return (await pool.query("SELECT count(*) FROM inventory.cutover_history_batches")).rows[0].count; }

  it("retires only processing, preserves every owner row, and unblocks the verified opening while retaining historical findings", async () => {
    const before = await businessState();
    const original = await opening.capture(new Date());
    expect((await opening.preview(verification(original),new Date())).ready).toBe(false);
    const input = await request();
    const saved = await service.retire(input,"operator");
    expect(saved).toMatchObject({ retiredReceipts: 1, retiredShipments: 1, inventoryChanged: false, authorityChanged: false, alreadyApplied: false });
    expect(await businessState()).toEqual(before);
    const source = await opening.capture(new Date());
    expect(source.evidence.sourceItems).toEqual(original.evidence.sourceItems);
    expect(source.evidence.shipmentReviewEvidence).toEqual(original.evidence.shipmentReviewEvidence);
    expect(source.evidence.retiredHistory).toHaveLength(2);
    expect(planCutoverReconstruction(source.evidence).blockers.some(row => row.code === "SHIPMENT_RECEIPT_REQUIRES_REVIEW")).toBe(true);
    const assessed = await opening.preview(verification(source),new Date());
    expect(assessed.blockers).toEqual([]);
    expect(assessed.ready).toBe(true);
    expect(assessed.historicalExceptions.some(row => row.code === "SHIPMENT_SOURCE_REQUIRES_REVIEW")).toBe(true);
    expect(assessed.plan.orders.map(order => order.orderId)).toEqual([1]);
  });

  it("serializes concurrent identical retries and rejects changed intent or actor", async () => {
    const input = await request();
    const results = await Promise.all([service.retire(input,"operator"),service.retire(input,"operator")]);
    expect(results.map(row => row.alreadyApplied).sort()).toEqual([false,true]);
    expect(new Set(results.map(row => row.batchId)).size).toBe(1);
    expect(await auditCount()).toBe("1");
    for (const [command,actor] of [[{ ...input, reason: "different" },"operator"],[input,"other"]] as const) {
      await expect(service.retire(command,actor)).rejects.toMatchObject({ code: "HISTORY_IDEMPOTENCY_CONFLICT" });
    }
  });

  it.each(["stock","attempt","source","package-label","current-order"])("rejects a stale %s review without partial retirement", async change => {
    const input = await request();
    const statements: Record<string,string> = {
      stock: "UPDATE inventory.inventory_levels SET variant_qty=21 WHERE id=10",
      attempt: "UPDATE oms.channel_fulfillment_receipt_attempts SET metadata='{}' WHERE receipt_id=20",
      source: "UPDATE wms.outbound_shipment_items SET qty=2 WHERE id=91",
      "package-label": "UPDATE wms.shipping_provider_labels SET label_status='voided' WHERE id=1",
      "current-order": "UPDATE wms.orders SET warehouse_status='ready' WHERE id=2",
    };
    await pool.query(statements[change]);
    const before = await businessState();
    await expect(service.retire(input,"operator")).rejects.toMatchObject({ status: 409 });
    expect(await auditCount()).toBe("0"); expect(await businessState()).toEqual(before);
  });

  it("requires explicit acceptance of unknown origins and never invents a channel/order", async () => {
    await pool.query("UPDATE oms.channel_fulfillment_receipts SET source_channel_id=NULL,oms_order_id=NULL WHERE id=20");
    const input = await request(); const before = await businessState();
    await expect(service.retire(input,"operator")).rejects.toMatchObject({ code: "HISTORY_UNKNOWN_ORIGIN_NOT_ACCEPTED" });
    expect(await service.retire({ ...input, acceptUnresolvedOrigin: true },"operator")).toMatchObject({ quarantinedReceipts: 1 });
    expect(await businessState()).toEqual(before);
  });

  it("rejects live leases and current corrective work even if an operator accepts the review hash", async () => {
    await pool.query("UPDATE oms.channel_fulfillment_receipts SET processing_status='processing',lease_token='worker',lease_expires_at=now()+interval '1 hour' WHERE id=20");
    let review = await service.review("operator");
    expect(review.blockers).toContainEqual({ code: "HISTORY_RECEIPT_LEASE_UNSAFE", subject: "receipt:20" });
    await pool.query("UPDATE oms.channel_fulfillment_receipts SET processing_status='review',lease_token=NULL,lease_expires_at=NULL WHERE id=20");
    await pool.query("INSERT INTO wms.pick_corrections VALUES(1,21,'picking_required')");
    review = await service.review("operator");
    expect(review.blockers).toContainEqual({ code: "HISTORY_SHIPMENT_CURRENT_OR_UNKNOWN_OWNER", subject: "shipment:90" });
    await expect(service.retire({ expectedReviewHash: review.reviewHash,expectedAuthorityRevision: review.authorityRevision,
      expectedConfigurationRunId: null,acceptUnresolvedOrigin: true,reason: "cannot waive",idempotencyKey: "blocked" },"operator"))
      .rejects.toMatchObject({ code: "HISTORY_RETIREMENT_BLOCKED" });
    expect(await auditCount()).toBe("0");
  });

  it("rolls the entire audit back on a mid-batch failure", async () => {
    const input = await request(); const before = await businessState();
    await pool.query(`CREATE FUNCTION inventory.test_history_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind='shipment' THEN RAISE EXCEPTION 'injected retirement failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER zz_test_history_failure BEFORE INSERT ON inventory.cutover_history_retirements
        FOR EACH ROW EXECUTE FUNCTION inventory.test_history_failure()`);
    await expect(service.retire(input,"operator")).rejects.toThrow("injected retirement failure");
    expect(await auditCount()).toBe("0");
    expect((await pool.query("SELECT count(*) FROM inventory.cutover_history_retirements")).rows[0].count).toBe("0");
    expect(await businessState()).toEqual(before);
  });

  it("blocks exact retired receipt and shipment work but permits unrelated identities", async () => {
    await service.retire(await request(),"operator");
    await expect(assertReceiptNotRetired(drizzle(pool),20)).rejects.toMatchObject({ code: "CUTOVER_HISTORY_RETIRED" });
    await expect(assertReceiptNotRetired(drizzle(pool),21)).resolves.toBeUndefined();
    await expect(assertShipmentNotRetiredPg(pool,90,91)).rejects.toMatchObject({ code: "CUTOVER_HISTORY_RETIRED" });
    await expect(assertShipmentNotRetiredPg(pool,999,91)).rejects.toMatchObject({ code: "CUTOVER_HISTORY_RETIRED" });
    await expect(assertShipmentNotRetiredPg(pool,999,999)).resolves.toBeUndefined();
  });

  it("the real ingress owner returns a terminal replay without reclaiming an expired retired lease", async () => {
    await pool.query("UPDATE oms.channel_fulfillment_receipts SET processing_status='processing',lease_token='expired-worker',lease_expires_at='2026-01-02' WHERE id=20");
    await service.retire(await request(),"operator");
    const before = await businessState();
    const now = new Date();
    const input = normalizeChannelFulfillmentIngress({ sourceProvider:"shopify",sourceChannelId:36,
      sourceOrderId:"history-2",sourceFulfillmentId:"fulfillment-2",eventKind:"created",source:"test:history",
      shippedAt:now,trackingNumber:"old-tracking",lineItems:[{ channelOrderLineId:"line-51",quantity:1 }] });
    const result = await createChannelFulfillmentIngressRepository(drizzle(pool)).claimReceipt({ receiptId:20,input,now,
      leaseToken:"new-worker",leaseDurationMs:60_000,maxFailures:5 });
    expect(result).toMatchObject({ terminalReplay:true,terminalReason:"cutover_history_retired",leaseToken:null,attemptNumber:1 });
    expect(await businessState()).toEqual(before);
  });

  it("refuses a partially populated audit batch at commit and keeps original history writable", async () => {
    const input = await request();
    await pool.query(`CREATE FUNCTION inventory.test_skip_history_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind='shipment' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER zz_test_skip_history_entry BEFORE INSERT ON inventory.cutover_history_retirements
        FOR EACH ROW EXECUTE FUNCTION inventory.test_skip_history_entry()`);
    await expect(service.retire(input,"operator")).rejects.toMatchObject({ code:"HISTORY_AUDIT_INCOMPLETE" });
    expect(await auditCount()).toBe("0");
  });

  it("protects only its own audit tables and allows original history corrections, which invalidate cutover evidence", async () => {
    await service.retire(await request(),"operator");
    for (const statement of ["UPDATE inventory.cutover_history_batches SET reason='changed'",
      "DELETE FROM inventory.cutover_history_retirements","TRUNCATE inventory.cutover_history_retirements"]) {
      await expect(pool.query(statement)).rejects.toThrow("CUTOVER_HISTORY_AUDIT_IMMUTABLE");
    }
    expect(await readRetiredCutoverHistory(pool)).toHaveLength(2);
    await pool.query("UPDATE wms.outbound_shipment_items SET qty=2 WHERE id=91");
    const changed = await opening.capture(new Date());
    await expect(opening.preview(verification(changed),new Date())).rejects.toMatchObject({ code: "HISTORY_RETIREMENT_MEMBERSHIP_CHANGED" });
    const triggers = (await pool.query(`SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE t.tgfoid='inventory.guard_cutover_history_audit()'::regprocedure ORDER BY c.relname`)).rows;
    expect(new Set(triggers.map(row => row.relname))).toEqual(new Set(["cutover_history_batches","cutover_history_retirements"]));
  });

  it("rejects incomplete or altered persisted audit evidence before any filtering or idempotent success", async () => {
    await service.retire(await request(),"operator");
    const original = (await readHistoryAuditRows(pool))[0];
    expect(validateHistoryAudit(original).retired).toHaveLength(2);
    const changes: Array<Partial<HistoryAuditRow>> = [
      { actor:"different-operator" }, { reason:"different intent" }, { authority_revision:"2" },
      { configuration_run_id:"99" }, { idempotency_key:"different-key" },
      { request_hash:"0".repeat(64) }, { result_hash:"0".repeat(64) },
      { source_payload:{} }, { facts_payload:{} }, { review_payload:{} }, { result_payload:{} },
      { entries:[] }, { entries:[...(original.entries as unknown[]).slice(0,1), ...(original.entries as unknown[]).slice(0,1)] },
    ];
    for (const change of changes) {
      expect(() => validateHistoryAudit({ ...original,...change })).toThrow("audit failed integrity validation");
    }
    expect(validateHistoryAudit(original).retired).toHaveLength(2);
  });
});
