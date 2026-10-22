import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { expect, it } from "vitest";
import type * as schema from "@shared/schema";
import type { COGSService } from "../../../inventory/cogs.service";
import { lotCostsForIntervals } from "../../../inventory/domain/lot-cost";
import type { CostQuantityInterval } from "../../../inventory/domain/cost-quantity-intervals";
import {
  ensureLotCostQuantityBasis,
  readUnallocatedLotCosts,
} from "../../../inventory/infrastructure/cost-quantity.repository";
import type { CostEvidenceTransaction } from "../../../inventory/infrastructure/cost-evidence.repository";

const SOURCE_LOT_ID = 7801;
const OUTPUT_LOT_ID_START = 7810;
const DATABASE_TIMEZONES = ["UTC", "America/New_York"] as const;
type DatabaseTimezone = typeof DATABASE_TIMEZONES[number];
type TimestampRow = { id: number; at: string };
type OperationTimestampRow = TimestampRow & { groupId?: number };
type History = { sales: readonly TimestampRow[]; operations: readonly OperationTimestampRow[] };
type BasisSource = { key: string; timestampMicros: string; timestamp?: unknown };

/** These cases use the existing suite's real cost migrations and COGS writer.
 * Node TZ is varied by separate test processes; transaction-local PostgreSQL TZ
 * is varied here without changing shared process state or stored timestamps. */
export function registerHistoricalCostTimestampCases(fixture: {
  pool: () => pg.Pool;
  database: () => Pick<NodePgDatabase<typeof schema>, "transaction">;
  cogs: () => COGSService;
  actorId: string;
  at: Date;
}): void {
  const operationKey = (id: number) => `timestamp-operation-${id}`;
  const allocationKey = (id: number) => `operation:${SOURCE_LOT_ID}:${operationKey(id)}`;

  async function seed(history: History): Promise<number> {
    const operationGroups = new Set(history.operations.map(row => row.groupId ?? row.id));
    const basis = history.sales.length + operationGroups.size + 1;
    await fixture.pool().query(`INSERT INTO inventory.inventory_lots
      (id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,
       received_at,cost_precision_version,unit_cost_mills,po_unit_cost_mills,
       packaging_cost_mills,landed_cost_mills,total_unit_cost_mills)
      VALUES ($1,'TIMESTAMP-SOURCE',200,99,$2,1,'2026-10-01',1,0,0,0,0,0)`, [SOURCE_LOT_ID, basis]);
    for (const [index, operation] of history.operations.entries()) {
      const outputLotId = OUTPUT_LOT_ID_START + index;
      const groupId = operation.groupId ?? operation.id;
      const outputQuantity = history.operations.filter(row => (row.groupId ?? row.id) === groupId).length;
      const outputStartQuantity = history.operations.slice(0, index).filter(row => (row.groupId ?? row.id) === groupId).length;
      await fixture.pool().query(`INSERT INTO inventory.inventory_lots
        (id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,received_at)
        VALUES ($1,$2,200,99,1,1,'2026-10-01')`, [outputLotId, `TIMESTAMP-OUTPUT-${index}`]);
      // Historical source fixtures intentionally have no quantity allocation yet.
      // Raw SQL timestamps preserve microseconds that a JavaScript Date loses.
      await fixture.pool().query(`INSERT INTO inventory.lot_cost_contributions
        (id,source_lot_id,output_lot_id,operation_kind,operation_key,source_qty,output_qty,
         output_start_qty,recorded_by,recorded_at) OVERRIDING SYSTEM VALUE
        VALUES ($1,$2,$3,'conversion',$4,1,$5,$6,$7,$8::timestamptz)`,
      [operation.id, SOURCE_LOT_ID, outputLotId, operationKey(groupId), outputQuantity, outputStartQuantity, fixture.actorId, operation.at]);
    }
    for (const sale of history.sales) {
      await fixture.pool().query(`INSERT INTO oms.order_item_costs
        (id,order_id,order_item_id,inventory_lot_id,product_variant_id,qty,
         unit_cost_cents,total_cost_cents,unit_cost_mills,total_cost_mills,cost_precision_version,created_at)
        VALUES ($1,1,1,$2,200,1,0,0,0,0,1,$3::timestamp)`, [sale.id, SOURCE_LOT_ID, sale.at]);
    }
    return basis;
  }

  async function setTimezone(tx: CostEvidenceTransaction, timezone: DatabaseTimezone): Promise<void> {
    await tx.execute(sql`SELECT set_config('TimeZone',${timezone},true)`);
  }

  async function importBasis(tx: CostEvidenceTransaction, at = fixture.at): Promise<number> {
    const lot = (await tx.execute(sql`SELECT * FROM inventory.inventory_lots WHERE id=${SOURCE_LOT_ID} FOR UPDATE`)).rows[0];
    return ensureLotCostQuantityBasis(tx, { ...lot, id: SOURCE_LOT_ID }, fixture.actorId, at, { verifyOnHand: true });
  }

  async function snapshot(): Promise<unknown> {
    // to_jsonb retains original database timestamp text/precision. Snapshot all
    // possible owner-write tables, not only the expected successful allocation.
    const names = ["inventory.inventory_lots", "oms.order_item_costs", "inventory.lot_cost_quantity_bases",
      "inventory.lot_cost_quantity_allocations", "inventory.lot_cost_contribution_allocations",
      "inventory.cost_adjustment_log", "inventory.lot_cost_contributions"] as const;
    return Promise.all(names.map(async name => ({
      table: name,
      rows: (await fixture.pool().query(`SELECT to_jsonb(row) AS value FROM ${name} row ORDER BY to_jsonb(row)::text`)).rows,
    })));
  }

  async function readSources(): Promise<BasisSource[]> {
    const row = (await fixture.pool().query(`SELECT source_evidence FROM inventory.lot_cost_quantity_bases
      WHERE inventory_lot_id=$1`, [SOURCE_LOT_ID])).rows[0];
    expect(row.source_evidence.policy).toBe("stable_recorded_evidence_order_v2");
    const sources = row.source_evidence.sources as BasisSource[];
    for (const source of sources) {
      expect(source.timestampMicros).toMatch(/^-?\d+$/);
      expect(source).not.toHaveProperty("timestamp");
    }
    return sources;
  }

  async function readIntervals(): Promise<Array<{ allocation_key: string; intervals: Array<{ start: number; quantity: number }> }>> {
    return (await fixture.pool().query(`SELECT allocation_key,intervals FROM inventory.lot_cost_quantity_allocations
      WHERE inventory_lot_id=$1 ORDER BY id`, [SOURCE_LOT_ID])).rows;
  }

  it.each(DATABASE_TIMEZONES)("historical timestamp ordering preserves exact five-mill custody with database timezone %s", async timezone => {
    const basis = await seed({ sales: [{ id: 2, at: "2026-10-05 14:54:13.394" }],
      operations: [{ id: 3, at: "2026-10-05 17:56:51.155+00" }] });
    await fixture.database().transaction(async tx => {
      await setTimezone(tx, timezone);
      expect(await importBasis(tx)).toBe(basis);
      await fixture.cogs().revalueExactComponent(SOURCE_LOT_ID, "product", 5, basis,
        "Historical timestamp regression", fixture.actorId, tx, fixture.at);
      const lot = (await tx.execute(sql`SELECT * FROM inventory.inventory_lots WHERE id=${SOURCE_LOT_ID}`)).rows[0];
      const remaining = await readUnallocatedLotCosts(tx, [{ ...lot, id: SOURCE_LOT_ID }]);
      const operation = (await tx.execute<{ intervals: CostQuantityInterval[] }>(sql`SELECT intervals FROM inventory.lot_cost_quantity_allocations
        WHERE allocation_key=${allocationKey(3)}`)).rows[0];
      const transferred = lotCostsForIntervals(lot, operation.intervals).poMills;
      const sold = (await tx.execute<{ amount: string }>(sql`SELECT product_total_cost_mills::text AS amount
        FROM oms.order_item_costs WHERE id=2`)).rows[0];
      expect(BigInt(sold.amount)).toBe(BigInt(1));
      expect(transferred).toBe(BigInt(2));
      expect(remaining.get(SOURCE_LOT_ID)?.costs.poMills).toBe(BigInt(2));
      expect(BigInt(sold.amount) + transferred + remaining.get(SOURCE_LOT_ID)!.costs.poMills).toBe(BigInt(5));
    });
    expect((await readSources()).map(source => source.key)).toEqual(["historical_cogs:2", allocationKey(3)]);
    expect(await readIntervals()).toEqual([
      { allocation_key: "historical_cogs:2", intervals: [{ start: 0, quantity: 1 }] },
      { allocation_key: allocationKey(3), intervals: [{ start: 1, quantity: 1 }] },
    ]);
    const committed = await snapshot();
    await fixture.database().transaction(async tx => {
      await setTimezone(tx, timezone === "UTC" ? "America/New_York" : "UTC");
      expect(await importBasis(tx, new Date("2026-10-23T13:30:00Z"))).toBe(basis);
    });
    expect(await snapshot()).toEqual(committed);
  });

  it.each(DATABASE_TIMEZONES)("historical timestamp ordering preserves microseconds before kind ties with database timezone %s", async timezone => {
    await seed({ sales: [{ id: 2, at: "2026-10-05 12:00:00.000002" }],
      operations: [{ id: 3, at: "2026-10-05 08:00:00.000001-04" }] });
    await fixture.database().transaction(async tx => { await setTimezone(tx, timezone); await importBasis(tx); });
    const sources = await readSources();
    expect(sources.map(source => source.key)).toEqual([allocationKey(3), "historical_cogs:2"]);
    expect(BigInt(sources[1].timestampMicros) - BigInt(sources[0].timestampMicros)).toBe(BigInt(1));
    expect(await readIntervals()).toEqual([
      { allocation_key: allocationKey(3), intervals: [{ start: 0, quantity: 1 }] },
      { allocation_key: "historical_cogs:2", intervals: [{ start: 1, quantity: 1 }] },
    ]);
  });

  it.each(DATABASE_TIMEZONES)("historical timestamp ordering breaks equal instants by kind then numeric id with database timezone %s", async timezone => {
    // Reverse insertion order and use 2/10 to distinguish numeric from lexical IDs.
    await seed({ sales: [{ id: 10, at: "2026-10-05 12:00:00.000001" }, { id: 2, at: "2026-10-05 12:00:00.000001" }],
      operations: [{ id: 10, at: "2026-10-05 08:00:00.000001-04" }, { id: 2, at: "2026-10-05 12:00:00.000001+00" }] });
    await fixture.database().transaction(async tx => { await setTimezone(tx, timezone); await importBasis(tx); });
    const sources = await readSources();
    const expected = ["historical_cogs:2", "historical_cogs:10", allocationKey(2), allocationKey(10)];
    expect(sources.map(source => source.key)).toEqual(expected);
    expect(new Set(sources.map(source => source.timestampMicros)).size).toBe(1);
    expect(await readIntervals()).toEqual(expected.map((key, start) => ({ allocation_key: key, intervals: [{ start, quantity: 1 }] })));
  });

  it.each(["infinity", "-infinity"])("historical timestamp ordering rejects nonfinite COGS time %s before writes", async timestamp => {
    await seed({ sales: [{ id: 2, at: timestamp }], operations: [{ id: 3, at: "2026-10-05 12:00:00+00" }] });
    const before = await snapshot();
    for (const timezone of DATABASE_TIMEZONES) await fixture.database().transaction(async tx => {
      await setTimezone(tx, timezone);
      await expect(importBasis(tx)).rejects.toMatchObject({ code: "COST_HISTORICAL_TIMESTAMP_INVALID" });
      // Commit the caught rejection: rollback must not be hiding partial writes.
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM inventory.lot_cost_quantity_allocations`)).rows[0].count).toBe(0);
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM inventory.lot_cost_quantity_bases`)).rows[0].count).toBe(0);
    });
    expect(await snapshot()).toEqual(before);
  });

  it.each(["infinity", "-infinity"])("historical timestamp ordering rejects nonfinite conversion time %s before writes", async timestamp => {
    await seed({ sales: [{ id: 2, at: "2026-10-05 12:00:00" }], operations: [{ id: 3, at: timestamp }] });
    const before = await snapshot();
    for (const timezone of DATABASE_TIMEZONES) await fixture.database().transaction(async tx => {
      await setTimezone(tx, timezone);
      await expect(importBasis(tx)).rejects.toMatchObject({ code: "COST_HISTORICAL_TIMESTAMP_INVALID" });
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM inventory.lot_cost_quantity_allocations`)).rows[0].count).toBe(0);
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM inventory.lot_cost_quantity_bases`)).rows[0].count).toBe(0);
    });
    expect(await snapshot()).toEqual(before);
  });

  it("historical timestamp ordering rejects an invalid sibling hidden by a finite operation minimum", async () => {
    await seed({ sales: [{ id: 2, at: "2026-10-05 12:00:00" }], operations: [
      { id: 3, at: "2026-10-05 12:00:01+00", groupId: 3 },
      { id: 4, at: "infinity", groupId: 3 },
    ] });
    const before = await snapshot();
    for (const timezone of DATABASE_TIMEZONES) await fixture.database().transaction(async tx => {
      await setTimezone(tx, timezone);
      await expect(importBasis(tx)).rejects.toMatchObject({ code: "COST_HISTORICAL_TIMESTAMP_INVALID" });
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM inventory.lot_cost_quantity_allocations`)).rows[0].count).toBe(0);
    });
    expect(await snapshot()).toEqual(before);
  });

  it.each(DATABASE_TIMEZONES)("historical timestamp ordering records new legacy-owner COGS as UTC with database timezone %s", async timezone => {
    await seed({ sales: [], operations: [] });
    await fixture.pool().query(`UPDATE inventory.inventory_lots SET cost_basis_qty=1,
      product_total_cost_mills=5,packaging_total_cost_mills=0,landed_total_cost_mills=0,
      unit_cost_mills=5,po_unit_cost_mills=5,total_unit_cost_mills=5 WHERE id=$1`, [SOURCE_LOT_ID]);
    const { InventoryLotService } = await import("../../../inventory/lots.service");
    const occurredAt = new Date("2026-10-05T14:54:13.394Z");
    let clockCalls = 0;
    await fixture.database().transaction(async tx => {
      await setTimezone(tx, timezone);
      const owner = new InventoryLotService(tx, () => { clockCalls++; return occurredAt; });
      await owner.pickFromLots({ productVariantId: 200, warehouseLocationId: 99, qty: 1, orderId: 1, orderItemId: 1 });
      const row = (await tx.execute(sql`SELECT cost.created_at::text AS created_at,
        trunc(EXTRACT(EPOCH FROM allocation.recorded_at)*1000)::text AS allocation_epoch_millis,
        cost.total_cost_mills::text AS total_mills
        FROM oms.order_item_costs cost JOIN inventory.lot_cost_quantity_allocations allocation
        ON allocation.id=cost.cost_quantity_allocation_id WHERE cost.inventory_lot_id=${SOURCE_LOT_ID}`)).rows[0];
      expect(row).toEqual({ created_at: "2026-10-05 14:54:13.394", allocation_epoch_millis: String(occurredAt.getTime()), total_mills: "5" });
    });
    expect(clockCalls).toBe(1);
    // The canonical claim owner's raw-pg path passes this ISO string. Exercise
    // the driver/server boundary separately; this is not a canonical-pick test.
    const client = await fixture.pool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('TimeZone',$1,true)", [timezone]);
      expect((await client.query("SELECT $1::timestamp::text AS created_at", [occurredAt.toISOString()])).rows)
        .toEqual([{ created_at: "2026-10-05 14:54:13.394" }]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  it("historical timestamp ordering preserves an existing v1 basis and its original financial intervals", async () => {
    await seed({ sales: [{ id: 2, at: "2026-10-05 14:54:13.394" }], operations: [{ id: 3, at: "2026-10-05 17:56:51.155+00" }] });
    // This is the original v1 New York ordering, intentionally different from a
    // fresh v2 import. Established financial custody must never be reordered.
    const evidence = { policy: "stable_recorded_evidence_order_v1", unallocatedQuantity: 1, sources: [
      { kind: "operation", key: allocationKey(3), quantity: 1, timestamp: 1791223011155, id: 3, operationKey: operationKey(3) },
      { kind: "cogs", key: "historical_cogs:2", quantity: 1, timestamp: 1791226453394, id: 2, operationKey: null },
    ] };
    await fixture.pool().query(`INSERT INTO inventory.lot_cost_quantity_allocations
      (id,inventory_lot_id,allocation_key,direction,quantity,intervals,source_evidence,recorded_by,recorded_at)
      OVERRIDING SYSTEM VALUE VALUES
      (8801,$1,$2,1,1,'[{"start":0,"quantity":1}]','{"policy":"stable_recorded_evidence_order_v1","sourceKind":"operation","sourceId":3}',$3,$4),
      (8802,$1,'historical_cogs:2',1,1,'[{"start":1,"quantity":1}]','{"policy":"stable_recorded_evidence_order_v1","sourceKind":"cogs","sourceId":2}',$3,$4)`,
    [SOURCE_LOT_ID, allocationKey(3), fixture.actorId, fixture.at]);
    await fixture.pool().query(`INSERT INTO inventory.lot_cost_quantity_bases
      (inventory_lot_id,quantity,source_evidence,recorded_by,recorded_at) VALUES($1,3,$2::jsonb,$3,$4)`,
    [SOURCE_LOT_ID, JSON.stringify(evidence), fixture.actorId, fixture.at]);
    await fixture.pool().query(`INSERT INTO inventory.lot_cost_contribution_allocations
      (contribution_id,allocation_id,recorded_by,recorded_at) VALUES(3,8801,$1,$2)`, [fixture.actorId, fixture.at]);
    await fixture.pool().query("UPDATE oms.order_item_costs SET cost_quantity_allocation_id=8802 WHERE id=2");
    const before = await snapshot();
    for (const timezone of DATABASE_TIMEZONES) await fixture.database().transaction(async tx => {
      await setTimezone(tx, timezone);
      expect(await importBasis(tx)).toBe(3);
    });
    expect(await snapshot()).toEqual(before);
  });

  it("historical timestamp ordering rolls back imported custody and exact COGS when its caller fails", async () => {
    await seed({ sales: [{ id: 2, at: "2026-10-05 14:54:13.394" }], operations: [{ id: 3, at: "2026-10-05 17:56:51.155+00" }] });
    const before = await snapshot();
    await expect(fixture.database().transaction(async tx => {
      await setTimezone(tx, "America/New_York");
      await importBasis(tx);
      await fixture.cogs().revalueExactComponent(SOURCE_LOT_ID, "product", 5, 3,
        "Historical timestamp rollback regression", fixture.actorId, tx, fixture.at);
      expect((await tx.execute(sql`SELECT count(*)::int AS count FROM inventory.lot_cost_quantity_allocations`)).rows[0].count).toBe(2);
      throw new Error("Injected historical timestamp caller failure");
    })).rejects.toThrow("Injected historical timestamp caller failure");
    expect(await snapshot()).toEqual(before);
  });
}
