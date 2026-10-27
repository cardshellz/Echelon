import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { createDrizzleCarrierTrackingRepository } from "../../carrier-tracking.repository";
import { normalizeShipStationLabelObservation } from "../../carrier-tracking.domain";
import { ShippingPackageDimensionsReader } from "../../package-dimensions.reader";
import { resolveReturnsTestDatabase } from "../../../returns/__tests__/support/disposable-database";
import { addLiveOriginalBox, LIVE_NOW, liveGid, liveLocalFixture, liveShop, liveShopifyFixture } from "../../../returns/__tests__/support/live-inspection-fixtures";
import { CustomerReturnLiveService } from "../../../returns/application/customer-return-live.service";
import { labelActivePolicy } from "../../../returns/__tests__/support/label-fixtures";

const url = resolveReturnsTestDatabase(process.env, "inspection");
const integration = url ? describe.sequential : describe.skip;
const now = new Date("2026-09-22T12:00:00.000Z");
const dimensions = { units: "inches", length: 10, width: 8, height: 4 };
const expected = { lengthMm: 254, widthMm: 203.2, heightMm: 101.6 };
const identity = { provider: "shipstation" as const, providerPhysicalShipmentId: "601", trackingNumber: "TRACK601" };
const raw = (size: unknown = dimensions) => ({ shipmentId: 601, orderId: 99, trackingNumber: "TRACK601",
  isReturnLabel: false, dimensions: size });
function ddl(relation: string): string {
  const source = readFileSync("migrations/154_carrier_tracking_event_authority.sql", "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(`CREATE TABLE IF NOT EXISTS wms.${relation} (`);
  const end = source.indexOf("\n);", start);
  if (start < 0 || end < 0) throw new Error("Missing retained label owner DDL");
  return source.slice(start, end + 3);
}

integration("shipping observations persist original package dimensions for returns", () => {
  let pool: Pool;
  let repository: ReturnType<typeof createDrizzleCarrierTrackingRepository>;
  let reader: ShippingPackageDimensionsReader;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url!, max: 4, statement_timeout: 10000 });
    await pool.query("DROP SCHEMA IF EXISTS wms CASCADE; CREATE SCHEMA wms");
    await pool.query(ddl("shipping_provider_labels"));
    await pool.query("ALTER TABLE wms.shipping_provider_labels ADD COLUMN label_direction varchar(20) NOT NULL DEFAULT 'unknown'");
    await pool.query(ddl("shipping_provider_label_events"));
    await pool.query(`CREATE UNIQUE INDEX dimension_label_identity ON wms.shipping_provider_labels(provider,provider_label_id);
      CREATE UNIQUE INDEX dimension_event_identity ON wms.shipping_provider_label_events(shipping_provider_label_id,event_hash)`);
    repository = createDrizzleCarrierTrackingRepository(drizzle(pool, { schema }));
    reader = new ShippingPackageDimensionsReader(pool);
  });
  beforeEach(async () => { await pool.query("TRUNCATE wms.shipping_provider_label_events,wms.shipping_provider_labels RESTART IDENTITY CASCADE"); });
  afterAll(async () => { await pool?.end(); });
  const observe = (size: unknown = dimensions, at = now) => repository.observeProviderLabel(normalizeShipStationLabelObservation(raw(size), at));

  it("saves a normal shipping observation and reuses it in canonical return inspection without a provider call", async () => {
    await observe();
    expect(await reader.read(identity)).toEqual({ status: "verified", dimensions: expected });
    const local = liveLocalFixture(); addLiveOriginalBox(local);
    const provider = liveShopifyFixture();
    local.order.externalCustomerId = "901";
    provider.order.customerId = liveGid("Customer", "901");
    const remoteDimensions = { read: vi.fn(async () => { throw new Error("Provider must not be called"); }) };
    const service = new CustomerReturnLiveService({
      local: { listShops: async () => [liveShop], read: async () => structuredClone(local) },
      shopify: { read: async () => structuredClone(provider) }, dimensions: remoteDimensions,
      storedDimensions: { read: input => reader.read({ provider: "shipstation", ...input }) },
      policies: { read: async () => [labelActivePolicy()] }, now: () => new Date(LIVE_NOW),
    });
    const order = await service.lookupCanonical({ channelId: 36, omsOrderId: 100, externalOrderId: "1001", externalCustomerId: "901" });
    expect(order.boxOptions).toHaveLength(1);
    expect(order.boxOptions[0].dimensions).toEqual(expected);
    expect(order.boxOptions[0].items).toHaveLength(2);
    expect(order.boxOptions[0].items).toEqual(expect.arrayContaining([
      { lineId: order.lines[0].id, quantity: 2 }, { lineId: order.lines[1].id, quantity: 1 },
    ]));
    expect(remoteDimensions.read).not.toHaveBeenCalled();
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const readonly = new ShippingPackageDimensionsReader({ query: client.query.bind(client) } as Pick<Pool,"query">);
      expect(await readonly.read(identity)).toEqual({ status: "verified", dimensions: expected });
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
  it("makes concurrent delivery and repeated ingestion idempotent", async () => {
    const results = await Promise.all([observe(), observe(), observe()]);
    expect(results.filter(result => result.eventInserted)).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM wms.shipping_provider_label_events")).rows[0].count).toBe(1);
    expect(await reader.read(identity)).toEqual({ status: "verified", dimensions: expected });
  });
  it("preserves measured size when a later poll omits it, and ignores older observations", async () => {
    await observe();
    await observe(null, new Date(now.getTime() + 1000));
    await observe({ ...dimensions, length: 12 }, new Date(now.getTime() - 1000));
    expect(await reader.read(identity)).toEqual({ status: "verified", dimensions: expected });
  });
  it("blocks invalid dimensions, then recovers with a verified replay without rewriting immutable evidence", async () => {
    await observe();
    await observe({ ...dimensions, length: 0 }, new Date(now.getTime() + 1000));
    expect(await reader.read(identity)).toEqual({ status: "unusable" });
    const replay = await observe(dimensions, new Date(now.getTime() + 2000));
    expect(replay.eventInserted).toBe(false);
    expect(await reader.read(identity)).toEqual({ status: "verified", dimensions: expected });
    expect((await pool.query("SELECT count(*)::int AS count FROM wms.shipping_provider_label_events")).rows[0].count).toBe(2);
  });
  it("quarantines equal-time disagreement and accepts a later correction", async () => {
    await observe(); await observe({ ...dimensions, length: 12 });
    expect(await reader.read(identity)).toEqual({ status: "unusable" });
    await observe(dimensions, new Date(now.getTime() + 1000));
    expect(await reader.read(identity)).toEqual({ status: "verified", dimensions: expected });
  });
  it("rejects wrong package/tracking, voids, return direction and a broken evidence link", async () => {
    await observe();
    expect(await reader.read({ ...identity, trackingNumber: "OTHER" })).toEqual({ status: "unusable" });
    expect(await reader.read({ ...identity, providerPhysicalShipmentId: "602" })).toEqual({ status: "not_recorded" });
    await expect(repository.observeProviderLabel(normalizeShipStationLabelObservation({ ...raw(), orderId: 100 }, now))).rejects.toBeDefined();
    expect(await reader.read(identity)).toEqual({ status: "verified", dimensions: expected });
    await pool.query("UPDATE wms.shipping_provider_labels SET label_direction='return'");
    expect(await reader.read(identity)).toEqual({ status: "unusable" });
    await pool.query("UPDATE wms.shipping_provider_labels SET label_direction='outbound'");
    await repository.observeProviderLabel(normalizeShipStationLabelObservation({ ...raw(), voidDate: "2026-09-22T13:00:00.000Z" }, new Date(now.getTime() + 3_600_000)));
    expect(await reader.read(identity)).toEqual({ status: "unusable" });
    await pool.query("UPDATE wms.shipping_provider_labels SET label_status='active',voided_at=NULL,metadata=jsonb_set(metadata,'{packageDimensions,eventHash}',to_jsonb(repeat('b',64)))");
    expect(await reader.read(identity)).toEqual({ status: "unusable" });
  });
  it("distinguishes unrecorded legacy size from a malformed retained record", async () => {
    await observe(null);
    expect(await reader.read(identity)).toEqual({ status: "not_recorded" });
    await pool.query("UPDATE wms.shipping_provider_labels SET metadata=jsonb_set(metadata,'{packageDimensions}','null'::jsonb)");
    expect(await reader.read(identity)).toEqual({ status: "unusable" });
  });
  it("rolls the label's latest size back if event persistence fails", async () => {
    await observe();
    await pool.query(`CREATE FUNCTION wms.reject_dimension_test_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic event failure'; END $$;
      CREATE TRIGGER reject_dimension_test_event BEFORE INSERT ON wms.shipping_provider_label_events FOR EACH ROW EXECUTE FUNCTION wms.reject_dimension_test_event()`);
    try {
      await expect(observe({ ...dimensions, length: 12 }, new Date(now.getTime() + 1000))).rejects.toBeDefined();
      expect(await reader.read(identity)).toEqual({ status: "verified", dimensions: expected });
    } finally { await pool.query("DROP TRIGGER reject_dimension_test_event ON wms.shipping_provider_label_events; DROP FUNCTION wms.reject_dimension_test_event()"); }
  });
});
