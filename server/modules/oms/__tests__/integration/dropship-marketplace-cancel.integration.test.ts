import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { stopOrderForMarketplaceCancel, type DropshipMarketplaceCancelStopDeps } from "../../dropship-marketplace-cancel";

/**
 * OMS's stop for an accepted dropship order eBay cancelled (eBay sync-back
 * plan v4 §7.2, v2 §11 PG 9), against a real PostgreSQL with OMS's and the
 * orders module's own cancel steps: a planned shipment is stopped; a bought
 * label is not (its tracking number survives the cancel); a shipped order is
 * left untouched; a missing OMS order is not_found; a failed release throws
 * and a retry gives the same answer with the OMS event written once.
 * Reduced named-schema shapes of the columns these steps read and write.
 */
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const NOW = new Date("2026-10-22T12:00:00.000Z");

const fixtureSql = `
  CREATE SCHEMA oms; CREATE SCHEMA wms;
  CREATE TABLE oms.oms_orders (id bigint PRIMARY KEY, status varchar(30) NOT NULL, cancelled_at timestamp, updated_at timestamp);
  CREATE TABLE oms.oms_order_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id bigint NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE, event_type varchar(50) NOT NULL, details jsonb,
    created_at timestamp NOT NULL DEFAULT now());
  CREATE TABLE wms.orders (id integer PRIMARY KEY, source varchar(30), oms_fulfillment_order_id varchar(64), source_table_id varchar(64),
    warehouse_status varchar(30) NOT NULL, assigned_picker_id varchar(64), cancelled_at timestamptz, completed_at timestamptz, updated_at timestamptz);
  CREATE TABLE wms.outbound_shipments (id integer PRIMARY KEY, order_id integer NOT NULL REFERENCES wms.orders(id), status varchar(30) NOT NULL,
    tracking_number text, carrier text, service_code text, tracking_url text, carrier_cost_cents integer, carrier_cost_source text,
    carrier_cost_recorded_at timestamptz, shopify_fulfillment_id text, shipped_at timestamptz, shipping_engine text, engine_order_ref text,
    engine_shipment_ref text, shipstation_order_id integer, shipstation_order_key text, cancelled_at timestamptz, voided_reason text,
    updated_at timestamptz);
`;

describeDatabase.sequential("OMS stop of a dropship order eBay cancelled (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  let release: ReturnType<typeof vi.fn<DropshipMarketplaceCancelStopDeps["reservation"]["releaseOrderReservation"]>>;
  let cancelOrder: ReturnType<typeof vi.fn<NonNullable<DropshipMarketplaceCancelStopDeps["engine"]>["cancelOrder"]>>;
  let deps: DropshipMarketplaceCancelStopDeps;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
    pool = database.pool;
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE wms.outbound_shipments, wms.orders, oms.oms_order_events, oms.oms_orders RESTART IDENTITY CASCADE`);
    release = vi.fn<DropshipMarketplaceCancelStopDeps["reservation"]["releaseOrderReservation"]>(async () => ({ released: 1, failed: [] }));
    cancelOrder = vi.fn<NonNullable<DropshipMarketplaceCancelStopDeps["engine"]>["cancelOrder"]>(async () => ({ state: "cancelled" as const }));
    deps = { db: drizzle(pool), reservation: { releaseOrderReservation: release }, engine: { cancelOrder }, clock: () => NOW };
  });

  async function seed(input: { omsOrderId: number; wmsStatus?: string; shipment?: { status: string; tracking?: string; shippedAt?: Date;
    shipstationOrderId?: number } }): Promise<void> {
    await pool.query(`INSERT INTO oms.oms_orders (id, status) VALUES ($1, 'confirmed')`, [input.omsOrderId]);
    if (!input.wmsStatus) return;
    await pool.query(`INSERT INTO wms.orders (id, source, oms_fulfillment_order_id, warehouse_status) VALUES ($1, 'oms', $2, $3)`,
      [input.omsOrderId + 1000, String(input.omsOrderId), input.wmsStatus]);
    if (!input.shipment) return;
    await pool.query(`INSERT INTO wms.outbound_shipments (id, order_id, status, tracking_number, shipped_at, shipstation_order_id)
      VALUES ($1, $2, $3, $4, $5, $6)`, [input.omsOrderId + 2000, input.omsOrderId + 1000, input.shipment.status, input.shipment.tracking ?? null,
      input.shipment.shippedAt ?? null, input.shipment.shipstationOrderId ?? null]);
  }

  const state = async (omsOrderId: number) => ({
    oms: (await pool.query(`SELECT status FROM oms.oms_orders WHERE id = $1`, [omsOrderId])).rows[0]?.status,
    wms: (await pool.query(`SELECT warehouse_status FROM wms.orders WHERE id = $1`, [omsOrderId + 1000])).rows[0]?.warehouse_status,
    shipment: (await pool.query(`SELECT status, tracking_number FROM wms.outbound_shipments WHERE id = $1`, [omsOrderId + 2000])).rows[0],
    events: (await pool.query(`SELECT event_type, details->>'source' AS source, details->>'verdict' AS verdict,
      details->'before'->>'status' AS before FROM oms.oms_order_events WHERE order_id = $1 ORDER BY id`, [omsOrderId])).rows,
  });

  it("stops an order whose shipment is only planned, releases its stock and writes the OMS event once", async () => {
    await seed({ omsOrderId: 1, wmsStatus: "ready", shipment: { status: "planned" } });

    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 1 }, deps)).toMatchObject({ kind: "stopped",
      shipments: [{ id: 2001, status: "cancelled", hadTracking: false, mode: "cancelled" }] });
    expect(await state(1)).toEqual({ oms: "cancelled", wms: "cancelled", shipment: { status: "cancelled", tracking_number: null },
      events: [{ event_type: "cancelled", source: "dropship_marketplace_cancel", verdict: null, before: "confirmed" },
        { event_type: "marketplace_cancel_verdict", source: "dropship_marketplace_cancel", verdict: "stopped", before: null }] });
    expect(release).toHaveBeenCalledWith(1001, "dropship_marketplace_cancel", undefined, { disposition: "cancel" });

    // A retry gives the same answer, releases again (idempotent), and writes no second event.
    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 1 }, deps)).toMatchObject({ kind: "stopped" });
    expect((await state(1)).events).toHaveLength(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("does not call an order with a bought label stopped: the tracking number survives the cancel", async () => {
    await seed({ omsOrderId: 2, wmsStatus: "ready", shipment: { status: "labeled", tracking: "1Z999", shipstationOrderId: 77 } });

    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 2 }, deps)).toMatchObject({ kind: "not_stopped",
      shipments: [{ id: 2002, status: "cancelled", hadTracking: true }] });
    expect(await state(2)).toMatchObject({ shipment: { status: "cancelled", tracking_number: "1Z999" },
      events: [{ event_type: "cancelled" }, { verdict: "not_stopped" }] });
    expect(cancelOrder).toHaveBeenCalledWith(77);
  });

  it("leaves an order that already shipped untouched", async () => {
    await seed({ omsOrderId: 3, wmsStatus: "shipped", shipment: { status: "shipped", tracking: "1Z111", shippedAt: NOW } });

    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 3 }, deps)).toMatchObject({ kind: "already_shipped" });
    expect(await state(3)).toEqual({ oms: "confirmed", wms: "shipped", shipment: { status: "shipped", tracking_number: "1Z111" }, events: [] });
    expect(release).not.toHaveBeenCalled();
  });

  it("answers not_found for an OMS order that does not exist, and stops one with no WMS order", async () => {
    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 404 }, deps)).toEqual({ kind: "not_found", shipments: [] });
    await seed({ omsOrderId: 5 });
    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 5 }, deps)).toEqual({ kind: "stopped", shipments: [] });
    expect((await state(5)).oms).toBe("cancelled");
  });

  it("throws when stock cannot all be released, and a later retry gives the same answer with one event", async () => {
    await seed({ omsOrderId: 6, wmsStatus: "ready", shipment: { status: "planned" } });
    release.mockResolvedValueOnce({ released: 0, failed: [{ sku: "SKU-1", orderItemId: 1, reason: "lock" }] });

    await expect(stopOrderForMarketplaceCancel({ omsOrderId: 6 }, deps)).rejects.toMatchObject({
      code: "OMS_DROPSHIP_MARKETPLACE_CANCEL_RELEASE_FAILED", classification: "transient" });
    // ARCH-4: the status flip and its OMS event commit together, so a failure after it leaves the trail complete.
    expect(await state(6)).toMatchObject({ oms: "cancelled",
      events: [{ event_type: "cancelled", source: "dropship_marketplace_cancel", before: "confirmed" }] });

    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 6 }, deps)).toMatchObject({ kind: "stopped" });
    expect((await state(6)).events.map((event) => event.event_type)).toEqual(["cancelled", "marketplace_cancel_verdict"]);
  });

  it("MS1: asks the shipping engine first and changes nothing when the engine says the order shipped", async () => {
    await seed({ omsOrderId: 7, wmsStatus: "ready", shipment: { status: "queued", shipstationOrderId: 70 } });
    cancelOrder.mockResolvedValueOnce({ state: "already_shipped" });

    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 7 }, deps)).toMatchObject({ kind: "already_shipped" });
    expect(cancelOrder).toHaveBeenCalledWith(70);
    expect(await state(7)).toEqual({ oms: "confirmed", wms: "ready", shipment: { status: "queued", tracking_number: null }, events: [] });
    expect(release).not.toHaveBeenCalled();
  });

  it("MS1: never calls an order stopped that the engine could not prove cancelled (not found, or no engine): nothing changes", async () => {
    await seed({ omsOrderId: 8, wmsStatus: "ready", shipment: { status: "queued", shipstationOrderId: 80 } });
    cancelOrder.mockResolvedValueOnce({ state: "not_found" });
    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 8 }, deps)).toMatchObject({ kind: "not_stopped" });
    expect(await state(8)).toEqual({ oms: "confirmed", wms: "ready", shipment: { status: "queued", tracking_number: null }, events: [] });

    const { engine: _engine, ...withoutEngine } = deps;
    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 8 }, withoutEngine)).toMatchObject({ kind: "not_stopped" });
    expect((await state(8)).oms).toBe("confirmed");
  });

  it("MS1: a failed engine cancel is a passing failure with nothing changed, and a later answer stops the order", async () => {
    await seed({ omsOrderId: 9, wmsStatus: "ready", shipment: { status: "queued", shipstationOrderId: 90 } });
    cancelOrder.mockRejectedValueOnce(new Error("ShipStation timeout"));
    await expect(stopOrderForMarketplaceCancel({ omsOrderId: 9 }, deps)).rejects.toMatchObject({
      code: "OMS_DROPSHIP_MARKETPLACE_CANCEL_ENGINE_FAILED", classification: "transient" });
    expect(await state(9)).toEqual({ oms: "confirmed", wms: "ready", shipment: { status: "queued", tracking_number: null }, events: [] });

    expect(await stopOrderForMarketplaceCancel({ omsOrderId: 9 }, deps)).toMatchObject({ kind: "stopped",
      shipments: [{ id: 2009, status: "cancelled", mode: "cancelled" }] });
    expect(cancelOrder).toHaveBeenCalledTimes(2);
  });
});
