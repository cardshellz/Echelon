import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  applyReturnRestock,
  ReturnRestockError,
  type ApplyReturnRestockInput,
} from "../../application/return-restock.use-case";

const NOW = new Date("2026-08-23T16:00:00.000Z");
const dialect = new PgDialect();

function render(query: unknown): { sql: string; params: unknown[] } {
  const rendered = dialect.sqlToQuery(query as any);
  return { sql: rendered.sql.replace(/\s+/g, " ").trim(), params: rendered.params };
}

function input(override: Partial<ApplyReturnRestockInput> = {}): ApplyReturnRestockInput {
  return {
    dispositionItemId: 91,
    returnCaseId: 42,
    caseNumber: "RET-0000000042",
    productVariantId: 301,
    warehouseLocationId: 17,
    quantity: 2,
    omsOrderId: 51,
    wmsOrderId: 61,
    wmsOrderItemId: 71,
    actor: "user:7",
    notes: "sellable return",
    now: NOW,
    ...override,
  };
}

function harness(options: {
  existing?: Record<string, unknown> | null;
  location?: Record<string, unknown> | null;
  variant?: Record<string, unknown> | null;
  level?: Record<string, unknown> | null;
  costCents?: number;
} = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const execute = vi.fn(async (query: unknown) => {
    const statement = render(query);
    queries.push(statement);
    const text = statement.sql;
    if (text.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM inventory.inventory_transactions") && text.includes("FOR UPDATE")) {
      return { rows: options.existing ? [options.existing] : [] };
    }
    if (text.includes("FROM warehouse.warehouse_locations")) {
      const row = options.location === undefined
        ? { id: 17, warehouse_id: 3, is_active: 1, is_pickable: 1, cycle_count_freeze_id: null }
        : options.location;
      return { rows: row ? [row] : [] };
    }
    if (text.includes("FROM catalog.product_variants") && text.includes("FOR UPDATE")) {
      const row = options.variant === undefined ? { id: 301, is_active: true } : options.variant;
      return { rows: row ? [row] : [] };
    }
    if (text.startsWith("INSERT INTO inventory.inventory_levels")) return { rows: [] };
    if (text.includes("FROM inventory.inventory_levels") && text.includes("FOR UPDATE")) {
      const row = options.level === undefined ? { id: 401, variant_qty: 8 } : options.level;
      return { rows: row ? [row] : [] };
    }
    if (text.includes("FROM oms.order_item_costs")) {
      return { rows: [{ unit_cost_cents: options.costCents ?? 275 }] };
    }
    if (text.startsWith("INSERT INTO inventory.inventory_lots")) return { rows: [{ id: 501 }] };
    if (text.startsWith("UPDATE inventory.inventory_levels")) return { rows: [] };
    if (text.startsWith("INSERT INTO inventory.inventory_transactions")) return { rows: [{ id: 601 }] };
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const select = vi.fn(() => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  }));
  return { executor: { execute, select }, execute, queries };
}

describe("applyReturnRestock", () => {
  it("creates one sellable lot, increments the level, and writes an attributable positive ledger row", async () => {
    const { executor, queries } = harness();

    const result = await applyReturnRestock(executor, input());

    expect(result).toEqual({
      productVariantId: 301,
      warehouseLocationId: 17,
      quantity: 2,
      inventoryTransactionId: 601,
      inventoryLotId: 501,
      replayed: false,
    });
    const lot = queries.find((query) => query.sql.startsWith("INSERT INTO inventory.inventory_lots"));
    expect(lot?.params).toEqual(expect.arrayContaining(["RET-0000000042-D91", 301, 17, 275, 27500, 2, NOW, "order_cogs", "sellable return"]));
    const levelUpdate = queries.find((query) => query.sql.startsWith("UPDATE inventory.inventory_levels"));
    expect(levelUpdate?.params).toEqual([10, NOW, 401]);
    const ledger = queries.find((query) => query.sql.startsWith("INSERT INTO inventory.inventory_transactions"));
    expect(ledger?.params).toEqual([
      301, 17, 2, 8, 10, 275, 501, 61, 71,
      "return_inventory_treatment", "91", "sellable return", "user:7", NOW,
    ]);
    expect(queries.find((query) => query.sql.includes("FROM catalog.product_variants"))?.sql)
      .toContain("FOR UPDATE");
  });

  it("replays matching durable ledger evidence before validating mutable location or variant state", async () => {
    const { executor, queries } = harness({
      existing: {
        id: 601,
        product_variant_id: 301,
        to_location_id: 17,
        variant_qty_delta: 2,
        inventory_lot_id: 501,
      },
    });

    await expect(applyReturnRestock(executor, input())).resolves.toMatchObject({ replayed: true });
    expect(queries).toHaveLength(2);
    expect(queries.some((query) => query.sql.startsWith("INSERT INTO inventory.inventory_lots"))).toBe(false);
    expect(queries.some((query) => query.sql.startsWith("UPDATE inventory.inventory_levels"))).toBe(false);
  });

  it("rejects conflicting replay evidence instead of applying a second inventory delta", async () => {
    const { executor, queries } = harness({
      existing: {
        id: 601,
        product_variant_id: 301,
        to_location_id: 17,
        variant_qty_delta: 1,
        inventory_lot_id: 501,
      },
    });

    await expect(applyReturnRestock(executor, input())).rejects.toMatchObject({
      code: "RETURN_RESTOCK_REPLAY_CONFLICT",
    });
    expect(queries).toHaveLength(2);
  });

  it.each([
    ["missing", null, "RETURN_RESTOCK_LOCATION_NOT_FOUND"],
    ["inactive", { id: 17, warehouse_id: 3, is_active: 0, is_pickable: 1, cycle_count_freeze_id: null }, "RETURN_RESTOCK_LOCATION_NOT_PICKABLE"],
    ["not pickable", { id: 17, warehouse_id: 3, is_active: 1, is_pickable: 0, cycle_count_freeze_id: null }, "RETURN_RESTOCK_LOCATION_NOT_PICKABLE"],
    ["not warehouse-bound", { id: 17, warehouse_id: null, is_active: 1, is_pickable: 1, cycle_count_freeze_id: null }, "RETURN_RESTOCK_LOCATION_NOT_PICKABLE"],
    ["cycle-count frozen", { id: 17, warehouse_id: 3, is_active: 1, is_pickable: 1, cycle_count_freeze_id: 9 }, "RETURN_RESTOCK_LOCATION_FROZEN"],
  ] as const)("rejects a %s location before inventory mutation", async (_name, location, code) => {
    const { executor, queries } = harness({ location });

    await expect(applyReturnRestock(executor, input())).rejects.toMatchObject({ code });
    expect(queries.some((query) => query.sql.startsWith("INSERT INTO inventory.inventory_levels"))).toBe(false);
  });

  it("rejects inactive or missing catalog variants before inventory mutation", async () => {
    const { executor, queries } = harness({ variant: { id: 301, is_active: false } });

    await expect(applyReturnRestock(executor, input())).rejects.toMatchObject({
      code: "RETURN_RESTOCK_VARIANT_INACTIVE",
    });
    expect(queries.some((query) => query.sql.startsWith("INSERT INTO inventory.inventory_levels"))).toBe(false);
  });

  it("fails closed when the persisted return cost is not an integer cent amount", async () => {
    const { executor, queries } = harness({ costCents: 275.5 });

    await expect(applyReturnRestock(executor, input())).rejects.toMatchObject({
      code: "RETURN_RESTOCK_DATA_INVALID",
    });
    expect(queries.some((query) => query.sql.startsWith("INSERT INTO inventory.inventory_lots"))).toBe(false);
  });

  it("rejects invalid input before acquiring locks", async () => {
    const { executor, execute } = harness();

    await expect(applyReturnRestock(executor, input({ quantity: 0 }))).rejects.toBeInstanceOf(ReturnRestockError);
    expect(execute).not.toHaveBeenCalled();
  });
});
