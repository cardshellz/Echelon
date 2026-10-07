import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { closeTestDb, describeWithDisposableDb, getTestDb, getTestPool, runMigrations, truncateTestData } from "../../../../../test/setup-integration";
import { createPackageAllocationLabelCommercialWorkflow } from "../../../../services/package-allocation-label-commercial-workflow";
import { deriveOmsLineAuthority } from "../../../oms/oms-line-authority";
import { createChannelFulfillmentAuthorityRepository, type MaterializePhysicalPackageInput } from "../../../oms/channel-fulfillment-authority.repository";
import { createChannelFulfillmentAuthorityService, createCompatibilityChannelFulfillmentProviderExecutor } from "../../../oms/channel-fulfillment-authority.service";
import { createChannelFulfillmentProjector } from "../../../oms/channel-fulfillment-projection.repository";
import { createFulfillmentPushService } from "../../../oms/fulfillment-push.service";
import type { ShopifyAdminGraphQLClient } from "../../../shopify/admin-gql-client";
import { CarrierTrackingService } from "../../carrier-tracking.service";
import { createDrizzleCarrierTrackingRepository } from "../../carrier-tracking.repository";
import { PackageAllocationLabelCommercialFulfillmentService } from "../../package-allocation-label-commercial-fulfillment.service";
import { createPackageAllocationLabelCommercialReviewRepository } from "../../package-allocation-label-commercial-review.repository";
import { readPackageAllocationSourceFacts } from "../../package-allocation-source-facts.repository";
import { installLabelCommercialIntegrationFixtures, seedCommercialFulfillmentAuthoritySource, seedCanonicalRequestForSource } from "../fixtures/label-commercial-integration.fixture";

const SKU = "QUAD-PACK-SPLIT-TEST";
const ORDERED_QUANTITY = 3;
const NOW = new Date("2026-10-06T16:00:00Z");
interface OrderSource {
  sourceId: number; shipment_id: number; order_id: number; order_item_id: number;
  oms_order_id: string; oms_line_id: string; channel_id: number; product_variant_id: number;
}
interface CreatedFulfillment { id: string; trackingNumber: string; quantity: number }

async function seedOrder(pool: Pool): Promise<OrderSource> {
  const sourceId = await seedCommercialFulfillmentAuthoritySource(pool, SKU, ORDERED_QUANTITY);
  const row = (await pool.query<Omit<OrderSource, "sourceId">>(`
    SELECT item.shipment_id, item.order_item_id, item.product_variant_id, orders.id AS order_id,
      line.id::text AS oms_line_id, line.order_id::text AS oms_order_id, oms_order.channel_id
    FROM wms.outbound_shipment_items item JOIN wms.order_items order_item ON order_item.id = item.order_item_id
    JOIN wms.orders orders ON orders.id = order_item.order_id
    JOIN oms.oms_order_lines line ON line.id = order_item.oms_order_line_id
    JOIN oms.oms_orders oms_order ON oms_order.id = line.order_id WHERE item.id = $1`, [sourceId])).rows[0];
  const warehouse = (await pool.query<{ id: number }>(`INSERT INTO warehouse.warehouses (code, name, shopify_location_id)
    VALUES ('SPLIT-TEST', 'Split parcel test', '640010') RETURNING id`)).rows[0];
  await pool.query(`UPDATE wms.orders SET channel_id = $2, warehouse_id = $3,
    external_order_id = 'gid://shopify/Order/640001', warehouse_status = 'ready' WHERE id = $1`,
    [row.order_id, row.channel_id, warehouse.id]);
  await pool.query(`UPDATE wms.outbound_shipments SET channel_id = $2, status = 'queued',
    external_fulfillment_id = NULL, tracking_number = NULL WHERE id = $1`, [row.shipment_id, row.channel_id]);
  await seedCanonicalRequestForSource(pool, sourceId);
  return { sourceId, ...row };
}

function runtime(pool: Pool, source: OrderSource, created: CreatedFulfillment[] = []) {
  let now = NOW;
  const clock = { now: () => now };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const providerRequest = vi.fn(async (query: string, variables?: Record<string, unknown>): Promise<unknown> => {
    if (query.includes("exactFulfillmentPackageForOrder")) return { order: { fulfillmentsCount: { count: created.length },
      fulfillments: created.map(pkg => ({ id: pkg.id, status: "SUCCESS", trackingInfo: [{ number: pkg.trackingNumber }],
        fulfillmentLineItems: { nodes: [{ quantity: pkg.quantity, lineItem: { id: "gid://shopify/LineItem/640002" } }],
          pageInfo: { hasNextPage: false } } })) } };
    if (query.includes("fulfillmentOrders(first:")) return { order: { fulfillmentOrders: { edges: [{ node: {
      id: "gid://shopify/FulfillmentOrder/640020", status: "OPEN",
      assignedLocation: { location: { id: "gid://shopify/Location/640010" } },
      lineItems: { edges: [{ node: { id: "gid://shopify/FulfillmentOrderLineItem/640021", sku: SKU,
        lineItem: { id: "gid://shopify/LineItem/640002" },
        remainingQuantity: ORDERED_QUANTITY - created.reduce((sum, item) => sum + item.quantity, 0) } }] },
    } }] } } };
    if (query.includes("fulfillmentCreateV2")) {
      const fulfillment = variables?.fulfillment as { trackingInfo: { number: string }; lineItemsByFulfillmentOrder:
        Array<{ fulfillmentOrderId: string; fulfillmentOrderLineItems: Array<{ id: string; quantity: number }> }> };
      expect(fulfillment.lineItemsByFulfillmentOrder).toHaveLength(1);
      const line = fulfillment.lineItemsByFulfillmentOrder[0];
      expect(line.fulfillmentOrderId).toBe("gid://shopify/FulfillmentOrder/640020");
      expect(line.fulfillmentOrderLineItems).toHaveLength(1);
      expect(line.fulfillmentOrderLineItems[0].id).toBe("gid://shopify/FulfillmentOrderLineItem/640021");
      const quantity = line.fulfillmentOrderLineItems[0].quantity;
      expect(quantity).toBeGreaterThan(0);
      expect(created.reduce((sum, item) => sum + item.quantity, 0) + quantity).toBeLessThanOrEqual(ORDERED_QUANTITY);
      const pkg = { id: `gid://shopify/Fulfillment/${640030 + created.length}`,
        trackingNumber: fulfillment.trackingInfo.number, quantity };
      created.push(pkg);
      return { fulfillmentCreateV2: { fulfillment: { id: pkg.id }, userErrors: [] } };
    }
    throw new Error(`Unexpected mocked Shopify query: ${query.slice(0, 120)}`);
  });
  const client: ShopifyAdminGraphQLClient = {
    request: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => providerRequest(query, variables) as Promise<T>,
  };
  const providerExecutor = createCompatibilityChannelFulfillmentProviderExecutor(createFulfillmentPushService(getTestDb(), null, {
    providerClients: { shopify: async channelId => {
      expect(channelId).toBe(source.channel_id);
      return { channelId, connectionId: 640040, externalAccountId: "split-test.myshopify.com", client };
    }, ebay: async () => { throw new Error("Unexpected eBay connection"); } },
  }));
  const observer = new CarrierTrackingService({ repository: createDrizzleCarrierTrackingRepository(getTestDb()), clock, logger });
  const authority = createChannelFulfillmentAuthorityService({ repository: createChannelFulfillmentAuthorityRepository(getTestDb()),
    projector: createChannelFulfillmentProjector(getTestDb()), providerExecutor, clock, logger });
  const workflow = createPackageAllocationLabelCommercialWorkflow({ pool, clock, logger });
  const reviewRepository = createPackageAllocationLabelCommercialReviewRepository(getTestDb());
  const handler = new PackageAllocationLabelCommercialFulfillmentService({ enabled: true, labelLinker: observer,
    workflow, reviewRepository, logger });

  async function receive(packageId: number, quantity: number) {
    const snapshot = { shipmentId: packageId, orderId: 99001 + packageId, orderKey: `wms-${source.shipment_id}`,
      trackingNumber: `SPLIT-TRACK-${packageId}`, carrierCode: "ups", serviceCode: "ups_ground", isReturnLabel: false,
      createDate: "2026-10-06T12:00:00.000", shipDate: "2026-10-06",
      shipmentItems: [{ lineItemKey: `wms-item-${source.sourceId}`, quantity }] };
    const observation = await observer.observeShipStationLabel(snapshot);
    return handler.process(snapshot, observation);
  }
  async function dispatch(expected: number, alreadySatisfied = 0) {
    const due = (await pool.query<{ due_at: Date | null }>(
      "SELECT MAX(next_attempt_at) + INTERVAL '1 millisecond' AS due_at FROM oms.channel_fulfillment_pushes")).rows[0].due_at;
    if (due && due > now) now = due;
    const batch = await authority.runDueBatch({ limit: 10 });
    expect(batch, JSON.stringify(logger.error.mock.calls)).toMatchObject({ claimed: expected, succeeded: expected - alreadySatisfied, ignored: alreadySatisfied });
  }
  return { receive, dispatch, authority, created, providerRequest, workflow, logger };
}

async function applyShopifyProgress(pool: Pool, source: OrderSource, remainingQuantity: number, previousAuthority?: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = (await client.query<{ paid_quantity: number; authority_fulfillable_quantity: number }>(
      "SELECT paid_quantity, authority_fulfillable_quantity FROM oms.oms_order_lines WHERE id = $1 FOR UPDATE", [source.oms_line_id])).rows[0];
    const state = deriveOmsLineAuthority({ sourceTopic: "orders/updated", financialStatus: "paid", quantity: ORDERED_QUANTITY,
      currentQuantity: ORDERED_QUANTITY, fulfillableQuantity: remainingQuantity, now: NOW,
      previous: { paidQuantity: previous.paid_quantity, authorityFulfillableQuantity: previousAuthority ?? previous.authority_fulfillable_quantity,
        authorizationStatus: "authorized", cancelledQuantity: 0, refundedQuantity: 0 } });
    await client.query("UPDATE oms.oms_order_lines SET authority_fulfillable_quantity = $2 WHERE id = $1",
      [source.oms_line_id, state.authorityFulfillableQuantity]);
    await client.query("COMMIT");
    return state;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

/** Test-owned compatibility partition, matching resolveShipmentByOrderKey's
 * conserving child + remainder transition. No physical item/pick is invented. */
async function splitCompatibilityRows(pool: Pool, source: OrderSource, packageId: number, quantity: number): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shipment = (await client.query<{ id: number }>(`INSERT INTO wms.outbound_shipments
      (order_id, channel_id, status, source, shipment_purpose, shipping_engine, shipstation_order_id,
       shipstation_order_key, engine_order_ref, external_fulfillment_id, tracking_number, carrier)
      VALUES ($1, $2, 'shipped', 'shipstation_split', 'customer_fulfillment', 'shipstation', $3::integer, $4, ($3::integer)::text, $5, $6, 'ups') RETURNING id`,
      [source.order_id, source.channel_id, 99001 + packageId, `wms-${source.shipment_id}`,
        `shipstation_shipment:${packageId}`, `SPLIT-TRACK-${packageId}`])).rows[0];
    const child = (await client.query<{ id: number }>(`INSERT INTO wms.outbound_shipment_items
      (shipment_id, order_item_id, split_root_shipment_item_id, shipment_item_purpose, product_variant_id, qty, tracking_id)
      VALUES ($1, $2, $3, 'customer_fulfillment', $4, $5, $6) RETURNING id`,
      [shipment.id, source.order_item_id, source.sourceId, source.product_variant_id, quantity, String(packageId)])).rows[0];
    const retained = await client.query(`UPDATE wms.outbound_shipment_items SET qty = qty - $2 WHERE id = $1 AND qty > $2 RETURNING id`,
      [source.sourceId, quantity]);
    expect(retained.rowCount).toBe(1);
    await client.query("COMMIT");
    return shipment.id;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

function carrierReplayInput(source: OrderSource, legacyShipmentId: number, packageId: number): MaterializePhysicalPackageInput {
  return { legacyWmsShipmentIds: [legacyShipmentId], shippingProvider: "shipstation", providerPhysicalShipmentId: String(packageId),
    providerOrderId: String(99001 + packageId), providerOrderKey: `wms-${source.shipment_id}`,
    trackingNumber: `SPLIT-TRACK-${packageId}`, carrier: "UPS", serviceCode: "ups_ground", shippedAt: NOW,
    source: "shipstation_ship_notify", legacyHeaderPolicy: "strict" };
}

describeWithDisposableDb("ordinary split parcels under the production authority constraint", () => {
  let pool: Pool;
  beforeAll(async () => {
    await runMigrations(); pool = getTestPool();
    await installLabelCommercialIntegrationFixtures(pool);
    await pool.query(`ALTER TABLE wms.orders ADD COLUMN IF NOT EXISTS source_table_id VARCHAR(100),
      ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP, ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
      ALTER TABLE wms.shipping_provider_label_links ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();`);
    // Run the actual migration, including its enabled status-update constraint
    // trigger. A permissive test fixture must not hide the production rejection.
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/108_oms_wms_authority_constraints.sql"), "utf8"));
  });
  beforeEach(async () => { await truncateTestData(); vi.stubEnv("SHOPIFY_FULFILLMENT_PUSH_ENABLED", "true"); });
  afterAll(async () => { vi.unstubAllEnvs(); await closeTestDb(); });

  it.each([[2, 1], [1, 2]])("fulfills %i+%i after Shopify progress arrives between parcels", async (first, last) => {
    const source = await seedOrder(pool); const app = runtime(pool, source);
    expect(await app.receive(44010, first)).toMatchObject({ outcome: "activated" });
    await app.dispatch(1);
    expect(await applyShopifyProgress(pool, source, last)).toMatchObject({ paidQuantity: 3, authorityFulfillableQuantity: 3 });
    expect(await app.receive(44011, last)).toMatchObject({ outcome: "activated" });
    await app.dispatch(1);
    expect(app.created.map(item => item.quantity)).toEqual([first, last]);
    expect((await pool.query("SELECT quantity, picked_quantity, fulfilled_quantity FROM wms.order_items WHERE id = $1", [source.order_item_id])).rows)
      .toEqual([{ quantity: 3, picked_quantity: 0, fulfilled_quantity: 3 }]);
    expect((await pool.query("SELECT id FROM inventory.inventory_transactions")).rowCount).toBe(0);
    await app.receive(44010, first); await app.receive(44011, last); await app.dispatch(0);
    expect(app.created).toHaveLength(2);
  });

  it("keeps original capacity after carrier compatibility splits, then reuses the recorded two-unit parcel", async () => {
    const source = await seedOrder(pool); const app = runtime(pool, source);
    expect(await app.receive(44010, 2)).toMatchObject({ outcome: "activated" }); await app.dispatch(1);
    const originalItems = (await pool.query("SELECT * FROM wms.physical_shipment_items ORDER BY id")).rows;
    const legacyShipmentId = await splitCompatibilityRows(pool, source, 44010, 2);
    expect((await readPackageAllocationSourceFacts(getTestDb(), [source.sourceId]))[0].sourceQuantity).toBe(3);
    const replay = await app.authority.recordPhysicalPackage(carrierReplayInput(source, legacyShipmentId, 44010));
    expect(replay.materialized.physicalShipmentId).toBe(Number(originalItems[0].physical_shipment_id));
    expect((await pool.query("SELECT * FROM wms.physical_shipment_items ORDER BY id")).rows).toEqual(originalItems);
    await applyShopifyProgress(pool, source, 1, 1);
    expect(await app.receive(44011, 1)).toMatchObject({ outcome: "activated" }); await app.dispatch(1);
    await app.authority.recordPhysicalPackage(carrierReplayInput(source, legacyShipmentId, 44010));
    expect((await pool.query("SELECT SUM(quantity_shipped)::int AS quantity FROM wms.physical_shipment_items")).rows).toEqual([{ quantity: 3 }]);
    await app.dispatch(0); expect(app.created).toHaveLength(2);
  });

  it("reviews a compatibility child with a different variant instead of admitting borrowed units", async () => {
    const source = await seedOrder(pool); const app = runtime(pool, source);
    expect(await app.receive(44010, 2)).toMatchObject({ outcome: "activated" }); await app.dispatch(1);
    const splitShipmentId = await splitCompatibilityRows(pool, source, 44010, 2);
    await pool.query("UPDATE wms.outbound_shipment_items SET product_variant_id = NULL WHERE shipment_id = $1", [splitShipmentId]);
    await expect(readPackageAllocationSourceFacts(getTestDb(), [source.sourceId]))
      .rejects.toMatchObject({ code: "SOURCE_LINEAGE_INVALID" });
    expect(await app.receive(44011, 1)).toEqual({ outcome: "review", reason: "SOURCE_LINEAGE_INVALID" });
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.physical_shipments")).rows).toEqual([{ count: 1 }]);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM oms.channel_fulfillment_pushes")).rows).toEqual([{ count: 1 }]);
    expect(app.created.map(item => item.quantity)).toEqual([2]);
  });

  it("serializes simultaneous sibling labels and duplicate arrivals without double fulfillment", async () => {
    const source = await seedOrder(pool); const app = runtime(pool, source);
    const results = await Promise.allSettled([app.receive(44010, 2), app.receive(44011, 1)]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(results.map(result => result.status === "fulfilled" ? result.value.outcome : String(result.reason)))
      .toEqual(["activated", "activated"]);
    await app.dispatch(2);
    await Promise.all([app.receive(44010, 2), app.receive(44011, 1)]); await app.dispatch(0);
    expect(app.created.reduce((sum, item) => sum + item.quantity, 0)).toBe(3);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM oms.channel_fulfillment_pushes")).rows).toEqual([{ count: 2 }]);
  });

  it("rolls back a failure after activation writes and retries the same observed label", async () => {
    const source = await seedOrder(pool); const app = runtime(pool, source);
    const originalRun = app.workflow.run.bind(app.workflow);
    vi.spyOn(app.workflow, "run").mockImplementationOnce(work => originalRun(async context => {
      await work(context);
      throw new Error("Injected failure before commercial transaction commit");
    }));
    await expect(app.receive(44010, 2)).rejects.toThrow("Injected failure before commercial transaction commit");
    for (const table of ["wms.package_allocation_groups", "wms.physical_shipments", "oms.channel_fulfillment_pushes"]) {
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows).toEqual([{ count: 0 }]);
    }
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.shipping_provider_labels")).rows).toEqual([{ count: 1 }]);
    expect(app.created).toEqual([]);
    expect(await app.receive(44010, 2)).toMatchObject({ outcome: "activated" }); await app.dispatch(1);
    await applyShopifyProgress(pool, source, 1);
    expect(await app.receive(44011, 1)).toMatchObject({ outcome: "activated" }); await app.dispatch(1);
    expect(app.created.map(item => item.quantity)).toEqual([2, 1]);
  });

  it("leaves the real over-materialization guard enabled and rolls label activation back at its rejection", async () => {
    const source = await seedOrder(pool); const app = runtime(pool, source);
    // Simulate persisted historical authority corruption, not a legitimate edit.
    await pool.query("UPDATE oms.oms_order_lines SET authority_fulfillable_quantity = 1 WHERE id = $1", [source.oms_line_id]);
    await expect(app.receive(44010, 2)).rejects.toThrow(/active WMS quantity 3 exceeds authority 1/);
    for (const table of ["wms.package_allocation_groups", "wms.physical_shipments", "oms.channel_fulfillment_pushes"]) {
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows).toEqual([{ count: 0 }]);
    }
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.shipping_provider_labels")).rows).toEqual([{ count: 1 }]);
    expect((await applyShopifyProgress(pool, source, 1)).authorityFulfillableQuantity).toBe(3);
    expect(await app.receive(44010, 2)).toMatchObject({ outcome: "activated" }); await app.dispatch(1);
  });

  it("resumes committed commands after a worker restart and reconciles an already accepted provider fulfillment", async () => {
    const source = await seedOrder(pool); const initial = runtime(pool, source);
    expect(await initial.receive(44010, 2)).toMatchObject({ outcome: "activated" });
    expect(initial.created).toEqual([]);
    // Provider accepted the exact committed package before its receipt was
    // recorded. A restarted real adapter must find it rather than send again.
    const accepted = [{ id: "gid://shopify/Fulfillment/640030", trackingNumber: "SPLIT-TRACK-44010", quantity: 2 }];
    const restarted = runtime(pool, source, accepted);
    await restarted.dispatch(1, 1);
    expect(restarted.providerRequest.mock.calls.some(([query]) => query.includes("fulfillmentCreateV2"))).toBe(false);
    expect((await pool.query("SELECT push_status FROM oms.channel_fulfillment_pushes")).rows).toEqual([{ push_status: "ignored" }]);
    await applyShopifyProgress(pool, source, 1);
    expect(await restarted.receive(44011, 1)).toMatchObject({ outcome: "activated" }); await restarted.dispatch(1);
    expect(accepted.map(item => item.quantity)).toEqual([2, 1]);
  });
});
