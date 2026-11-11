import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { ShipmentFactRepository } from "../../shipment-fact.repository";
import type { ShipmentFact } from "../../shipment-fact.domain";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";

/** The real migration, whatever prefix it was allocated. */
function migrationPath(): string {
  const directory = resolve("migrations");
  const matches = readdirSync(directory).filter((name) => name.endsWith("_shipping_shipment_facts.sql"));
  if (matches.length !== 1) throw new Error(`Expected one shipment facts migration, found ${matches.length}.`);
  return resolve(directory, matches[0]);
}

const fact = (overrides: Partial<ShipmentFact> = {}): ShipmentFact => ({
  engine: "shipstation", engineShipmentId: "1001", shipDate: "2026-01-15", carrier: "stamps_com",
  serviceCode: "usps_ground_advantage", trackingNumber: "9400100000000000000000", source: "history_import",
  items: [
    { lineNumber: 1, channelLineRef: "36256756891807", omsOrderLineId: 124243, sku: "SHLZ-TOP-35PT-CLR-P25", quantity: 2, purpose: "fulfillment" },
    { lineNumber: 2, channelLineRef: "36256756891808", omsOrderLineId: 124250, sku: "SHLZ-SLV", quantity: 1, purpose: "fulfillment" },
  ],
  ...overrides,
});

describe.skipIf(!url)("shipment fact repository", () => {
  let database: InventoryCutoverTestDatabase;
  let repository: ShipmentFactRepository;
  const count = async (table: string) =>
    Number((await database.pool.query(`SELECT count(*)::int AS n FROM shipping.${table}`)).rows[0].n);

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, "CREATE SCHEMA shipping;");
    await database.pool.query(await readFile(migrationPath(), "utf8"));
    repository = new ShipmentFactRepository(database.pool);
  });
  afterAll(async () => { await database?.close(); });

  it("records a shipment with its items and reports the units shipped per purchased line", async () => {
    const recorded = await repository.record(fact());
    expect(recorded.created).toBe(true);
    expect(await repository.shippedUnits([124243, 124250, 999])).toEqual([
      { omsOrderLineId: 999, shippedQuantity: 0 },
      { omsOrderLineId: 124243, shippedQuantity: 2 },
      { omsOrderLineId: 124250, shippedQuantity: 1 },
    ].sort((left, right) => left.omsOrderLineId - right.omsOrderLineId));
  });

  it("treats the same report as one fact when it arrives again, even from a different source", async () => {
    const first = await repository.record(fact());
    const replay = await repository.record(fact({ source: "engine_event" }));
    expect(replay).toEqual({ shipmentId: first.shipmentId, created: false });
    expect(await count("shipments")).toBe(1);
    expect(await count("shipment_items")).toBe(2);
    expect(await repository.shippedUnits([124243])).toEqual([{ omsOrderLineId: 124243, shippedQuantity: 2 }]);
  });

  it("refuses a different report for an already recorded shipment and changes nothing", async () => {
    await expect(repository.record(fact({ items: [{ ...fact().items[0], quantity: 5 }] })))
      .rejects.toMatchObject({ code: "SHIPMENT_FACT_CONFLICT", classification: "permanent" });
    expect(await repository.shippedUnits([124243])).toEqual([{ omsOrderLineId: 124243, shippedQuantity: 2 }]);
  });

  it("adds units across packages and counts only items that fulfil the line", async () => {
    await repository.record(fact({
      engineShipmentId: "1002", trackingNumber: "9400100000000000000001",
      items: [
        { lineNumber: 1, channelLineRef: "36256756891807", omsOrderLineId: 124243, sku: "SHLZ-TOP-35PT-CLR-P25", quantity: 1, purpose: "fulfillment" },
        { lineNumber: 2, channelLineRef: "36256756891807", omsOrderLineId: 124243, sku: "SHLZ-TOP-35PT-CLR-P25", quantity: 4, purpose: "replacement" },
        { lineNumber: 3, channelLineRef: null, omsOrderLineId: null, sku: "FREEBIE", quantity: 1, purpose: "concession" },
      ],
    }));
    expect(await repository.shippedUnits([124243])).toEqual([{ omsOrderLineId: 124243, shippedQuantity: 3 }]);
  });

  it("stops counting a voided shipment, once, without removing the shipment", async () => {
    const voided = await repository.recordVoid({ engine: "shipstation", engineShipmentId: "1002", voidDate: "2026-01-16" });
    expect(voided.created).toBe(true);
    expect(await repository.recordVoid({ engine: "shipstation", engineShipmentId: "1002", voidDate: null }))
      .toEqual({ shipmentId: voided.shipmentId, created: false });
    expect(await repository.shippedUnits([124243])).toEqual([{ omsOrderLineId: 124243, shippedQuantity: 2 }]);
    expect(await count("shipments")).toBe(2);
    expect(await count("shipment_voids")).toBe(1);
  });

  it("refuses to void a shipment that was never recorded", async () => {
    await expect(repository.recordVoid({ engine: "shipstation", engineShipmentId: "missing", voidDate: null }))
      .rejects.toMatchObject({ code: "SHIPMENT_FACT_NOT_FOUND" });
  });

  it("keeps identifiers separate per engine and records a package with no items", async () => {
    const other = await repository.record(fact({ engine: "own_engine", items: [] }));
    expect(other.created).toBe(true);
    expect(await count("shipments")).toBe(3);
  });

  it("rolls back the shipment when its items cannot be saved", async () => {
    const before = await count("shipments");
    const invalid = fact({ engineShipmentId: "1003" });
    // Bypass application validation to prove the database itself refuses a zero quantity.
    await expect(database.pool.query(
      `WITH shipment AS (
         INSERT INTO shipping.shipments (engine, engine_shipment_id, ship_date, source, content_hash)
         VALUES ($1,$2,$3::date,'history_import',repeat('a',64)) RETURNING id)
       INSERT INTO shipping.shipment_items (shipment_id, line_number, quantity, purpose)
       SELECT id, 1, 0, 'fulfillment' FROM shipment`,
      [invalid.engine, invalid.engineShipmentId, invalid.shipDate],
    )).rejects.toMatchObject({ code: "23514" });
    expect(await count("shipments")).toBe(before);
  });

  it.each([
    ["UPDATE shipping.shipments SET tracking_number='changed'"],
    ["DELETE FROM shipping.shipments"],
    ["UPDATE shipping.shipment_items SET quantity=99"],
    ["DELETE FROM shipping.shipment_items"],
    ["DELETE FROM shipping.shipment_voids"],
    ["TRUNCATE shipping.shipment_voids"],
  ])("rejects %s because shipment facts are add-only", async (statement) => {
    await expect(database.pool.query(statement)).rejects.toMatchObject({ code: "23001" });
  });

  it("rejects a sales-channel style engine name and an unknown source at the database", async () => {
    await expect(database.pool.query(
      `INSERT INTO shipping.shipments (engine, engine_shipment_id, ship_date, source, content_hash)
       VALUES ('Shopify Store','1','2026-01-15','history_import',repeat('a',64))`,
    )).rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query(
      `INSERT INTO shipping.shipments (engine, engine_shipment_id, ship_date, source, content_hash)
       VALUES ('shipstation','77','2026-01-15','sales_channel_status',repeat('a',64))`,
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("records concurrent deliveries of the same shipment exactly once", async () => {
    const same = fact({ engineShipmentId: "2001" });
    const results = await Promise.all(Array.from({ length: 6 }, () => repository.record(same)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.shipmentId)).size).toBe(1);
    expect(Number((await database.pool.query(
      "SELECT count(*)::int AS n FROM shipping.shipment_items item JOIN shipping.shipments s ON s.id=item.shipment_id WHERE s.engine_shipment_id='2001'",
    )).rows[0].n)).toBe(2);
  });
});
