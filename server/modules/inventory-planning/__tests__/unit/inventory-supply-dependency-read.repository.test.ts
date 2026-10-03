import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { InventoryAvailabilityRuntimeAtpContext, InventoryAvailabilityRuntimeAtpExecutor } from "../../application/inventory-availability-runtime-atp.service";
import type { PostgresInventoryAvailabilityRuntimeTransaction } from "../../infrastructure/inventory-availability-runtime-atp.repository";
import { PostgresInventorySupplyDependencyReader } from "../../infrastructure/inventory-supply-dependency-read.repository";

function fixture(authority: "legacy" | "canonical" = "canonical", rows: unknown[] = [{ product_id: 10 }, { product_id: 20 }]) {
  const execute = vi.fn(async (_statement: SQL) => ({ rows }));
  const getProductIdsByVariantIds = vi.fn(async () => new Map([[101, 10]]));
  const runtime: InventoryAvailabilityRuntimeAtpExecutor<PostgresInventoryAvailabilityRuntimeTransaction> = {
    execute: work => work({ authority, getProductIdsByVariantIds } as unknown as InventoryAvailabilityRuntimeAtpContext,
      { execute } as unknown as PostgresInventoryAvailabilityRuntimeTransaction),
  };
  return { reader: new PostgresInventorySupplyDependencyReader(runtime), execute, getProductIdsByVariantIds };
}

describe("inventory-change dependency authority", () => {
  it("reads sealed bindings for canonical refresh, never the retired Catalog strategy", async () => {
    const test = fixture();
    await expect(test.reader.getAffectedProductIds(101)).resolves.toEqual([10, 20]);
    const statement = new PgDialect().sqlToQuery(test.execute.mock.calls[0]![0]);
    expect(statement.sql).toContain("head.active_model_id");
    expect(statement.sql).toContain("model.lifecycle_status = 'sealed'");
    expect(statement.sql).toContain("model.inventory_behavior = 'build_managed'");
    expect(statement.sql).not.toContain("build_recipes");
    expect(statement.sql).not.toContain("inventory_strategy");
    expect(statement.params).toEqual([10, 1001]);
  });
  it("retains the legacy recipe resolver only while legacy authority is selected", async () => {
    const test = fixture("legacy");
    await expect(test.reader.getAffectedProductIds(101)).resolves.toEqual([10, 20]);
    const statement = new PgDialect().sqlToQuery(test.execute.mock.calls[0]![0]);
    expect(statement.sql).toContain("build_recipes");
    expect(statement.sql).not.toContain("transformation_model_heads");
  });
  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])("rejects invalid variant %s before reading", async variantId => {
    const test = fixture();
    await expect(test.reader.getAffectedProductIds(variantId)).rejects.toThrow();
    expect(test.getProductIdsByVariantIds).not.toHaveBeenCalled();
  });
  it("returns no scope for a missing variant", async () => {
    const test = fixture();
    test.getProductIdsByVariantIds.mockResolvedValue(new Map());
    await expect(test.reader.getAffectedProductIds(101)).resolves.toEqual([]);
    expect(test.execute).not.toHaveBeenCalled();
  });
  it("rejects malformed database identities and oversized scopes instead of publishing a partial set", async () => {
    await expect(fixture("canonical", [{ product_id: null }]).reader.getAffectedProductIds(101)).rejects.toThrow();
    await expect(fixture("canonical", Array.from({ length: 1001 }, (_, index) => ({ product_id: index + 1 })))
      .reader.getAffectedProductIds(101)).rejects.toMatchObject({ code: "INVENTORY_SUPPLY_DEPENDENCY_LIMIT" });
  });
});
