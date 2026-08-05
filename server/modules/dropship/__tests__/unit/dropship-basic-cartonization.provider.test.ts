import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

import { BasicDropshipCartonizationProvider } from "../../infrastructure/dropship-basic-cartonization.provider";

describe("BasicDropshipCartonizationProvider", () => {
  it("uses catalog package data and applies active dropship channel defaults", async () => {
    const client = makeClient({
      packageRows: [{
        product_variant_id: 101,
        sku: "SKU-101",
        weight_grams: 200,
        length_mm: 150,
        width_mm: 100,
        height_mm: 20,
        shipping_group_code: "protection",
        ships_in_own_container: true,
        max_units_per_package: null,
        default_carrier: "USPS",
        default_service: "Ground Advantage",
        default_box_id: 7,
      }],
    });
    const provider = new BasicDropshipCartonizationProvider(makePool(client));

    const result = await provider.cartonize(makeRequest());

    expect(result.engine).toEqual({ name: "cardshellz-cartonizer", version: "3.1.0" });
    expect(result.packages).toEqual([expect.objectContaining({
      productVariantId: 101,
      quantity: 1,
      boxId: 7,
      weightGrams: 220,
      requestedCarrier: "USPS",
      requestedService: "Ground Advantage",
    })]);
    expect(result.packagingWarnings).toEqual([]);
    const packageQuery = client.queries.find((query) => query.sql.includes("FROM catalog.product_variants pv"));
    expect(packageQuery?.sql).toContain("pv.weight_grams");
    expect(packageQuery?.sql).toContain("pv.ships_in_own_container");
    expect(packageQuery?.sql).toContain("catalog.shipping_groups");
    expect(packageQuery?.sql).toContain("LEFT JOIN dropship.dropship_package_profiles pp");
    expect(packageQuery?.sql).not.toContain("pp.weight_grams");
    expect(packageQuery?.sql).not.toContain("pp.ship_alone");
    // Variants with incomplete package data must flow through to the domain —
    // no hard completeness filter in the SQL.
    expect(packageQuery?.sql).not.toContain("pv.length_mm > 0");
  });

  it("degrades to a weight-only package with a warning when dims are missing", async () => {
    const client = makeClient({
      packageRows: [{
        product_variant_id: 101,
        sku: "SKU-101",
        weight_grams: 200,
        length_mm: null,
        width_mm: null,
        height_mm: null,
        shipping_group_code: null,
        ships_in_own_container: false,
        max_units_per_package: null,
        default_carrier: null,
        default_service: null,
        default_box_id: null,
      }],
    });
    const provider = new BasicDropshipCartonizationProvider(makePool(client));

    const result = await provider.cartonize(makeRequest());

    expect(result.packages).toEqual([expect.objectContaining({
      productVariantId: 101,
      quantity: 1,
      boxId: null,
      boxCode: null,
      weightGrams: 200,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    })]);
    expect(result.packagingWarnings).toEqual([expect.objectContaining({
      code: "PACKAGING_DATA_INCOMPLETE",
      reason: "missing_dims",
      productVariantIds: [101],
    })]);
    expect(result.warnings[0]).toContain("PACKAGING_DATA_INCOMPLETE");
  });

  it("still throws when the catalog weight is missing", async () => {
    const client = makeClient({
      packageRows: [{
        product_variant_id: 101,
        sku: "SKU-101",
        weight_grams: null,
        length_mm: 150,
        width_mm: 100,
        height_mm: 20,
        shipping_group_code: null,
        ships_in_own_container: false,
        max_units_per_package: null,
        default_carrier: null,
        default_service: null,
        default_box_id: null,
      }],
    });
    const provider = new BasicDropshipCartonizationProvider(makePool(client));

    await expect(provider.cartonize(makeRequest())).rejects.toMatchObject({
      code: "DROPSHIP_CATALOG_PACKAGE_DATA_REQUIRED",
      context: { productVariantId: 101 },
    });
  });
});

function makeRequest() {
  return {
    vendorId: 10,
    storeConnectionId: 20,
    warehouseId: 30,
    destination: {
      country: "US",
      region: "PA",
      postalCode: "17046",
    },
    items: [{ productVariantId: 101, quantity: 1 }],
    quotedAt: new Date("2026-07-11T12:00:00.000Z"),
  };
}

function makePool(client: PoolClient): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

function makeClient(input: { packageRows: Record<string, unknown>[] }): PoolClient & {
  queries: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("FROM catalog.product_variants pv")) {
        return result(input.packageRows);
      }
      if (sql.includes("FROM dropship.dropship_box_catalog")) {
        return result([{
          id: 7,
          code: "SMALL",
          name: "Small box",
          length_mm: 200,
          width_mm: 150,
          height_mm: 50,
          tare_weight_grams: 20,
          max_weight_grams: 1000,
          is_active: true,
        }]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
    release: vi.fn(),
  } as unknown as PoolClient & {
    queries: Array<{ sql: string; params: unknown[] }>;
  };
}

function result<T>(rows: T[]): QueryResult<T> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}
