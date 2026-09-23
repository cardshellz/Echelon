import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresCustomerReturnLocalInspectionReader } from "../../infrastructure/customer-return-local-inspection.reader";
import { PostgresCustomerReturnAuthorizationStore } from "../../infrastructure/customer-return-authorization.repository";
import { customerReturnLocalInspectionSnapshotSchema } from "../../application/customer-return-local-inspection.ports";
import { inspectionQueries } from "../../infrastructure/customer-return-local-inspection.queries";
import { resolveReturnsTestDatabase } from "../support/disposable-database";
import { createInspectionTestSchema, seedInspectionTestSchema } from "../support/customer-return-inspection-database";

const connectionString = resolveReturnsTestDatabase(process.env, "inspection");
const integration = connectionString ? describe.sequential : describe.skip;
const NOW = new Date("2026-09-23T12:00:00.000Z");
const options = { approvedShopDomains: ["test-shop.myshopify.com"], clock: () => new Date(NOW), reportFailure: vi.fn() };
const input = { channelId: 36, connectionId: 4, orderReference: "TEST-1" };

integration("private return inspection against migration-defined PostgreSQL", () => {
  let pool: Pool;
  let reader: PostgresCustomerReturnLocalInspectionReader;
  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, max: 5, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
    await createInspectionTestSchema(pool);
    reader = new PostgresCustomerReturnLocalInspectionReader(pool, options);
  });
  beforeEach(async () => { await seedInspectionTestSchema(pool); });
  afterAll(async () => { await pool?.end(); });

  async function legacyReturn() {
    const result = await pool.query(`INSERT INTO wms.returns (order_id,source,status) VALUES (201,'admin','expected') RETURNING id`);
    await pool.query(`INSERT INTO wms.return_items (return_id,order_item_id,oms_order_line_id,external_line_item_id,expected_qty,status)
      VALUES ($1,301,101,'500',1,'expected')`, [result.rows[0].id]);
  }

  it("returns only explicit approved shops without secrets and rechecks configuration on every read", async () => {
    expect(await reader.listShops()).toEqual([{ channelId: 36, connectionId: 4, shopDomain: "test-shop.myshopify.com", displayName: "Approved test shop" }]);
    await pool.query("UPDATE channels.channels SET status='paused' WHERE id=36");
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_INSPECTION_CONFIGURATION_UNRESOLVED" });
  });

  it.each([
    "UPDATE channels.channels SET type='partner' WHERE id=36",
    "UPDATE channels.channels SET provider='ebay' WHERE id=36",
    `UPDATE channels.channels SET shipping_config='{"dropship":{"omsChannel":true}}' WHERE id=36`,
    `UPDATE channels.channel_connections SET metadata='{"features":{"dropship_oms":true}}' WHERE id=4`,
    "UPDATE channels.channel_connections SET access_token=NULL WHERE id=4",
    "UPDATE channels.channel_connections SET shop_domain='changed.myshopify.com' WHERE id=4",
    "INSERT INTO channels.channel_connections(channel_id,shop_domain,access_token) VALUES(36,'extra.myshopify.com','synthetic')",
    "UPDATE channels.channel_connections SET shop_domain='test-shop.myshopify.com' WHERE id=5",
  ])("fails visibly on changed or ambiguous approved scope %#", async sql => {
    await pool.query(sql);
    await expect(reader.listShops()).rejects.toMatchObject({ code: "RETURN_INSPECTION_CONFIGURATION_UNRESOLVED" });
  });

  it("matches exact optional-prefix aliases without cross-store or numeric coercion", async () => {
    for (const reference of ["TEST-1", "#TEST-1", " # TEST-1 "]) {
      const snapshot = await reader.read({ ...input, orderReference: reference });
      expect(snapshot?.order).toMatchObject({ omsOrderId: 100, channelId: 36, externalOrderId: "1000" });
    }
    for (const reference of ["%", "TEST-1' OR 1=1 --", "TEST-01"]) expect(await reader.read({ ...input, orderReference: reference })).toBeNull();
    await expect(reader.read({ ...input, channelId: 37, connectionId: 5 })).rejects.toMatchObject({ code: "RETURN_INSPECTION_SHOP_UNAVAILABLE" });
    await pool.query(`INSERT INTO oms.oms_orders(channel_id,external_order_id,external_order_number,ordered_at) VALUES(36,'1001','TEST-1','2026-09-01')`);
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_INSPECTION_ORDER_AMBIGUOUS" });
  });

  it("rejects a Dropship intake association even when the selected channel is configured", async () => {
    await pool.query(`INSERT INTO dropship.dropship_vendors VALUES(1); INSERT INTO dropship.dropship_store_connections VALUES(1);
      INSERT INTO dropship.dropship_order_intake(channel_id,vendor_id,store_connection_id,platform,external_order_id,oms_order_id)
      VALUES(36,1,1,'shopify','1000',100)`);
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_INSPECTION_ORDER_SCOPE_UNSUPPORTED" });
  });

  it("preserves purchased identities and all partitions without requiring local carrier or WMS projection coverage", async () => {
    const snapshot = await reader.read(input);
    expect(customerReturnLocalInspectionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot?.lines.map(line => [line.omsOrderLineId, line.externalLineItemId, line.requiresShipping])).toEqual([
      [101, "500", true], [102, "501", true], [103, "502", false],
    ]);
    expect(snapshot?.wmsItems.map(item => [item.wmsOrderId, item.wmsOrderItemId, item.omsOrderLineId])).toEqual([
      [201, 301, 101], [202, 302, 101], [202, 303, 102],
    ]);
    expect(snapshot?.issues).toEqual([]);
    await pool.query("DELETE FROM wms.order_items WHERE id=303");
    expect((await reader.read(input))?.issues).toEqual([]);
  });

  it("does not cast GID or oversized WMS references and retains conflicts instead of dropping rows", async () => {
    await pool.query("UPDATE wms.orders SET oms_fulfillment_order_id='gid://shopify/Order/1000' WHERE id=201");
    const snapshot = await reader.read(input);
    expect(snapshot?.wmsItems).toHaveLength(3);
    expect(snapshot?.issues).toContainEqual({ code: "wms_identity_conflict", omsOrderLineId: 101 });
    await pool.query("UPDATE wms.orders SET oms_fulfillment_order_id='999999999999999999999999999999999999' WHERE id=201");
    expect((await reader.read(input))?.issues).toContainEqual({ code: "wms_identity_conflict", omsOrderLineId: 101 });
  });

  it("retains the established numeric legacy OMS fallback even without modern line mappings or source='oms'", async () => {
    await pool.query(`UPDATE wms.orders SET source='shopify',oms_fulfillment_order_id=NULL,source_table_id='100' WHERE id=202;
      UPDATE wms.order_items SET oms_order_line_id=NULL WHERE order_id=202;
      INSERT INTO wms.returns(id,order_id,source,status) OVERRIDING SYSTEM VALUE VALUES(10,202,'admin','expected'),(11,202,'admin','expected');
      INSERT INTO wms.return_items(return_id,order_item_id,expected_qty,status) VALUES(10,303,1,'expected');
      INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,order_id,order_item_id) VALUES('return',1,202,303)`);
    const snapshot = await reader.read(input);
    expect(snapshot?.wmsItems).toHaveLength(3);
    expect(snapshot?.legacyClaims).toHaveLength(1);
    expect(snapshot?.unallocatedReturns).toHaveLength(1);
    expect(snapshot?.inventoryReturnEvidence).toHaveLength(1);
    expect(snapshot?.issues).toContainEqual({ code: "legacy_claim_allocation_unknown", omsOrderLineId: null });
    expect(snapshot?.issues).toContainEqual({ code: "inventory_return_correlation_unknown", omsOrderLineId: null });
  });

  it("retains root claims and legacy expected claims once each, without guessing child correlation", async () => {
    const store = new PostgresCustomerReturnAuthorizationStore(drizzle(pool));
    await store.transaction(async tx => {
      await tx.lockCommand({ channelId: 36, idempotencyKey: "inspection-fixture" });
      await tx.lockSource({ channelId: 36, omsOrderId: 100, omsOrderLineIds: [101] });
      await tx.persist({ channelId: 36, omsOrderId: 100, idempotencyKey: "inspection-fixture",
        semanticHash: "a".repeat(64), eligibilityRevision: "b".repeat(64), actor: "test:inspection", now: NOW,
        policySnapshot: { returnWindowDays: 365, refundAuthority: "manual_shopify" }, warehouseSnapshot: { warehouseId: 1 },
        lines: [{ omsOrderLineId: 101, externalLineItemId: "500", quantity: 1, reasonCode: null,
          allocations: [{ wmsOrderItemId: 301, fulfillmentId: "600", fulfillmentLineItemId: "700",
            quantity: 1, originalQuantity: 2, eligibleQuantity: 2, deliveryEvidence: { source: "shopify" } }] }] });
    });
    await legacyReturn();
    const snapshot = await reader.read(input);
    expect(snapshot?.rootClaims).toHaveLength(1);
    expect(snapshot?.rootClaims[0]).toMatchObject({ omsOrderLineId: 101, wmsOrderItemId: 301, fulfillmentLineItemId: "700", quantity: 1 });
    expect(snapshot?.legacyClaims).toHaveLength(1);
    expect(snapshot?.issues).toContainEqual({ code: "legacy_claim_allocation_unknown", omsOrderLineId: 101 });
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM returns.customer_return_authorizations")).rows[0].count).toBe(1);
  });

  it("exposes unallocated headers and inventory-only returns as unresolved, not zero claims", async () => {
    await pool.query(`INSERT INTO wms.returns(order_id,source,status) VALUES(201,'shopify_webhook','closed');
      INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,order_id,order_item_id)
      VALUES('return',1,202,303),('receipt',1,202,303)`);
    const snapshot = await reader.read(input);
    expect(snapshot?.unallocatedReturns).toHaveLength(1);
    expect(snapshot?.inventoryReturnEvidence).toHaveLength(1);
    expect(snapshot?.issues).toContainEqual({ code: "unallocated_return_evidence", omsOrderLineId: null });
    expect(snapshot?.issues).toContainEqual({ code: "inventory_return_correlation_unknown", omsOrderLineId: 102 });
  });

  it("does not lose a legacy claim with null or contradictory purchased-line ownership", async () => {
    await legacyReturn();
    await pool.query("UPDATE wms.return_items SET order_item_id=NULL, oms_order_line_id=NULL");
    expect((await reader.read(input))?.issues).toContainEqual({ code: "legacy_claim_allocation_unknown", omsOrderLineId: null });
    await pool.query("UPDATE wms.return_items SET order_item_id=303, oms_order_line_id=101");
    const issues = (await reader.read(input))?.issues;
    expect(issues).toContainEqual({ code: "local_claim_identity_conflict", omsOrderLineId: 101 });
    expect(issues).toContainEqual({ code: "local_claim_identity_conflict", omsOrderLineId: 102 });
  });

  async function packages() {
    await pool.query(`INSERT INTO wms.fulfillment_plans(id,oms_order_id,wms_order_id) OVERRIDING SYSTEM VALUE VALUES(1,100,201),(2,100,202);
      INSERT INTO wms.fulfillment_plan_lines(id,fulfillment_plan_id,oms_order_line_id,wms_order_item_id,sku,quantity_planned) OVERRIDING SYSTEM VALUE
      VALUES(1,1,101,301,'SAME',2),(2,2,101,302,'SAME',1);
      INSERT INTO wms.physical_shipments(id,provider,provider_physical_shipment_id,tracking_number,carrier,status) OVERRIDING SYSTEM VALUE
      VALUES(1,'shipstation','PKG1','TRACK1','UPS','shipped'),(2,'shipstation','PKG2','TRACK2','UPS','shipped');
      INSERT INTO wms.physical_shipment_items(id,physical_shipment_id,fulfillment_plan_line_id,wms_order_item_id,sku,quantity_shipped) OVERRIDING SYSTEM VALUE
      VALUES(1,1,1,301,'SAME',2),(2,2,2,302,'SAME',1);
      INSERT INTO oms.channel_fulfillment_pushes(id,oms_order_id,physical_shipment_id,channel_provider,channel_fulfillment_id,push_status) OVERRIDING SYSTEM VALUE
      VALUES(1,100,1,'shopify','gid://shopify/Fulfillment/600','success');
      INSERT INTO oms.channel_fulfillment_push_items(channel_fulfillment_push_id,oms_order_line_id,channel_order_line_id,quantity_pushed,physical_shipment_item_id)
      VALUES(1,101,'500',2,1);
      INSERT INTO oms.channel_fulfillment_receipts(id,receipt_key,request_hash,source_provider,source_channel_id,source_order_id,source_fulfillment_id,event_kind,source,processing_status,oms_order_id,physical_shipment_id) OVERRIDING SYSTEM VALUE
      VALUES(1,'TEST-RECEIPT',repeat('a',64),'shopify',36,'1000','600','created','shopify_webhook','processed',100,1);
      INSERT INTO oms.channel_fulfillment_receipt_items(receipt_id,source_fulfillment_line_id,channel_order_line_id,quantity,oms_order_line_id,wms_order_item_id,physical_shipment_item_id)
      VALUES(1,'500','500',2,101,301,1);
      INSERT INTO wms.shipping_provider_labels(id,provider,provider_label_id,tracking_number,normalized_tracking_number,label_status,carrier,first_observed_at,last_observed_at,source) OVERRIDING SYSTEM VALUE
      VALUES(1,'shipstation','LABEL1','TRACK1','TRACK1','active','UPS','2026-09-01','2026-09-02','provider');
      INSERT INTO wms.shipping_provider_label_links(shipping_provider_label_id,physical_shipment_id,source) VALUES(1,1,'provider');
      INSERT INTO wms.carrier_tracking_events(id,provider,event_hash,payload_hash,tracking_number,normalized_tracking_number,provider_status_code,canonical_status,dispatch_evidence,event_occurred_at,event_time_source,actual_delivery_at,sanitized_payload,received_at) OVERRIDING SYSTEM VALUE
      VALUES(1,'shipstation',repeat('a',64),repeat('b',64),'TRACK1','TRACK1','DE','delivered','confirmed','2026-09-03','carrier_event','2026-09-03','{}','2026-09-03');
      INSERT INTO wms.carrier_tracking_event_matches(id,carrier_tracking_event_id,attempt_hash,match_status,candidate_count,shipping_provider_label_id,reason_code,created_at) OVERRIDING SYSTEM VALUE
      VALUES(1,1,repeat('a',64),'matched',1,1,'exact','2026-09-03');
      INSERT INTO wms.carrier_tracking_reconciliation_state(carrier_tracking_event_id,last_match_attempt_id,last_match_attempt_hash,last_match_status,last_candidate_count,last_reconciled_at,updated_at)
      VALUES(1,1,repeat('a',64),'matched',1,'2026-09-03','2026-09-03');`);
  }

  it("keeps receipt/push provenance separate and preserves corrected effective quantities", async () => {
    await packages();
    await pool.query(`INSERT INTO wms.physical_shipment_item_quantity_adjustments
      (physical_shipment_item_id,quantity_delta,adjustment_kind,repair_run_id,idempotency_key,operator,reason,created_at)
      VALUES(1,-1,'historical_provider_package_repartition','00000000-0000-4000-8000-000000000001','test','test','retained correction','2026-09-04')`);
    const snapshot = await reader.read(input);
    expect(snapshot?.fulfillmentBindings).toHaveLength(2);
    expect(snapshot?.fulfillmentBindings.find(binding => binding.kind === "receipt")?.providerFulfillmentLineId).toBe("500");
    expect(snapshot?.fulfillmentBindings.find(binding => binding.kind === "push")?.providerFulfillmentLineId).toBeNull();
    expect(snapshot?.packageItems.find(item => item.physicalShipmentItemId === 1)).toMatchObject({ originalQuantity: 2, effectiveQuantity: 1 });
    expect(snapshot?.carrierEvents).toHaveLength(1);
    expect(snapshot?.rootClaims).toEqual([]);
  });

  it("returns zero effective quantity and retained inactive/replacement provenance without silently granting entitlement", async () => {
    await packages();
    await pool.query(`INSERT INTO wms.physical_shipment_item_quantity_adjustments
      (physical_shipment_item_id,quantity_delta,adjustment_kind,repair_run_id,idempotency_key,operator,reason,created_at)
      VALUES(1,-2,'historical_provider_package_repartition','00000000-0000-4000-8000-000000000001','test','test','retained correction','2026-09-04');
      UPDATE wms.physical_shipments SET status='voided' WHERE id=1;
      UPDATE wms.physical_shipment_items SET shipment_item_purpose='replacement',replacement_for_order_item_id=301 WHERE id=2;
      UPDATE wms.shipping_provider_labels SET label_status='voided',voided_at='2026-09-04T00:00:00Z',label_direction='return' WHERE id=1`);
    const snapshot = await reader.read(input);
    expect(snapshot?.packageItems[0]).toMatchObject({ status: "voided", effectiveQuantity: 0 });
    expect(snapshot?.packageItems[1]).toMatchObject({ purpose: "replacement", replacementForOrderItemId: 301 });
    expect(snapshot?.packageLabels[0]).toMatchObject({ status: "voided", direction: "return", voidedAt: "2026-09-04T00:00:00.000Z" });
  });

  it("does not reuse an old successful match after the current match becomes ambiguous", async () => {
    await packages();
    await pool.query(`INSERT INTO wms.carrier_tracking_event_matches(id,carrier_tracking_event_id,attempt_hash,match_status,candidate_count,reason_code,created_at) OVERRIDING SYSTEM VALUE
      VALUES(2,1,repeat('b',64),'ambiguous',2,'ambiguous','2026-09-04');
      UPDATE wms.carrier_tracking_reconciliation_state SET last_match_attempt_id=2,last_match_attempt_hash=repeat('b',64),last_match_status='ambiguous',last_candidate_count=2,next_reconcile_at='2026-09-05' WHERE carrier_tracking_event_id=1`);
    expect((await reader.read(input))?.carrierEvents).toEqual([]);
  });

  function hookedReader(hook: (text: string, client: PoolClient) => Promise<void>) {
    const database = { connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client);
      const wrapped = Object.create(client) as PoolClient;
      wrapped.query = (async (text: string, values?: unknown[]) => { await hook(text, client); return query(text, values); }) as PoolClient["query"];
      wrapped.release = client.release.bind(client);
      return wrapped;
    } } as Pick<Pool, "connect">;
    return new PostgresCustomerReturnLocalInspectionReader(database, options);
  }

  it("preserves UTC naive-column and carrier instants independently of database and Node host time zones", async () => {
    await packages();
    await pool.query(`UPDATE oms.oms_orders SET ordered_at='2026-09-17 16:37:49',cancelled_at='2026-09-18 01:02:03' WHERE id=100;
      INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,order_id,order_item_id,created_at)
      VALUES('return',1,202,303,'2026-09-19 04:05:06');
      UPDATE wms.shipping_provider_labels SET voided_at='2026-09-20T07:08:09-04:00' WHERE id=1;
      UPDATE wms.carrier_tracking_events SET event_occurred_at='2026-09-21T10:11:12-04:00',
        actual_delivery_at='2026-09-21T10:11:12-04:00',received_at='2026-09-21T10:12:13-04:00' WHERE id=1`);
    // OID 1184 proves pg receives an instant, even on CI hosts whose local zone
    // is already UTC and would conceal the naive-timestamp parser regression.
    const orderResult = await pool.query(inspectionQueries.order, [36, ["#TEST-1"]]);
    expect(orderResult.fields.filter(field => ["purchasedAt", "cancelledAt"].includes(field.name))
      .map(field => field.dataTypeID)).toEqual([1184, 1184]);
    const inventoryResult = await pool.query(inspectionQueries.inventoryReturns, [[201, 202], [301, 302, 303], "100", 10]);
    expect(inventoryResult.fields.find(field => field.name === "occurredAt")?.dataTypeID).toBe(1184);
    for (const zone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
      const zoned = hookedReader(async (text, client) => {
        if (text === inspectionQueries.order) await client.query("SELECT set_config('TimeZone', $1, true)", [zone]);
      });
      const snapshot = await zoned.read(input);
      expect(snapshot?.order).toMatchObject({ purchasedAt: "2026-09-17T16:37:49.000Z", cancelledAt: "2026-09-18T01:02:03.000Z" });
      expect(snapshot?.inventoryReturnEvidence[0].occurredAt).toBe("2026-09-19T04:05:06.000Z");
      expect(snapshot?.packageLabels[0].voidedAt).toBe("2026-09-20T11:08:09.000Z");
      expect(snapshot?.carrierEvents[0]).toMatchObject({ occurredAt: "2026-09-21T14:11:12.000Z",
        actualDeliveryAt: "2026-09-21T14:11:12.000Z", receivedAt: "2026-09-21T14:12:13.000Z" });
    }
  });

  it("uses one repeatable-read read-only snapshot and sees a concurrent new claim only on the next request", async () => {
    let written = false;
    const isolated = hookedReader(async (text, client) => {
      if (text === inspectionQueries.lines && !written) {
        expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
        expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
        await legacyReturn(); written = true;
      }
    });
    expect((await isolated.read(input))?.legacyClaims).toEqual([]);
    expect((await reader.read(input))?.legacyClaims).toHaveLength(1);
  });

  it("PostgreSQL itself rejects writes on the inspection connection", async () => {
    const isolated = hookedReader(async (text, client) => {
      if (text === inspectionQueries.lines) {
        await expect(client.query("UPDATE oms.oms_orders SET external_order_number='CHANGED' WHERE id=100")).rejects.toMatchObject({ code: "25006" });
      }
    });
    await expect(isolated.read(input)).rejects.toMatchObject({ code: "RETURN_INSPECTION_UNAVAILABLE" });
    expect((await pool.query("SELECT external_order_number FROM oms.oms_orders WHERE id=100")).rows[0].external_order_number).toBe("#TEST-1");
    expect((await reader.read(input))?.order.omsOrderId).toBe(100);
  });

  it("fails instead of truncating purchased lines and never treats a query error as an empty claim ledger", async () => {
    await pool.query(`INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,quantity) OVERRIDING SYSTEM VALUE
      SELECT 10000+n,100,('bulk-' || n),1 FROM generate_series(1,198) n`);
    await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_INSPECTION_EVIDENCE_LIMIT" });
    await pool.query("DELETE FROM oms.oms_order_lines WHERE external_line_item_id LIKE 'bulk-%'");
    await pool.query("ALTER TABLE wms.return_items RENAME TO unavailable_return_items");
    try { await expect(reader.read(input)).rejects.toMatchObject({ code: "RETURN_INSPECTION_UNAVAILABLE" }); }
    finally { await pool.query("ALTER TABLE wms.unavailable_return_items RENAME TO return_items"); }
  });
});
