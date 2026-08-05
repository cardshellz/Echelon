import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import { PgDropshipShippingConfigRepository } from "../../infrastructure/dropship-shipping-config.repository";

describe("PgDropshipShippingConfigRepository policy windows", () => {
  it("rejects overlapping active markup policies before insertion", async () => {
    const client = new PolicyConflictClient();
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    const repository = new PgDropshipShippingConfigRepository(pool);

    const operation = repository.createMarkupPolicy({
      name: "Summer shipping",
      markupBps: 250,
      fixedMarkupCents: 0,
      minMarkupCents: null,
      maxMarkupCents: null,
      isActive: true,
      effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
      effectiveTo: new Date("2026-08-01T00:00:00.000Z"),
      idempotencyKey: "markup-window-conflict-001",
      requestHash: "request-hash",
      actor: { actorType: "admin", actorId: "admin-1" },
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    await expect(operation).rejects.toMatchObject<DropshipError>({
      code: "DROPSHIP_SHIPPING_POLICY_WINDOW_CONFLICT",
      context: {
        policyKind: "markup",
        conflictingPolicyId: 17,
        conflictingPolicyName: "Default shipping",
      },
    });
    expect(client.queries.some((sql) => sql.includes("INSERT INTO dropship.dropship_shipping_markup_config"))).toBe(false);
    expect(client.queries).toContain("ROLLBACK");
    expect(client.released).toBe(true);
  });

  it("stores only dropship channel defaults and reads physical facts from the catalog variant", async () => {
    const client = new PackageProfileClient({ variantExists: true });
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    const repository = new PgDropshipShippingConfigRepository(pool);

    const result = await repository.upsertPackageProfile(makePackageProfileInput());

    expect(result.record).toMatchObject({
      productVariantId: 10,
      // Physical facts are read-only mirrors from catalog.product_variants.
      weightGrams: 321,
      lengthMm: 210,
      widthMm: 140,
      heightMm: 30,
      packageDataComplete: true,
      shipsInOwnContainer: true,
      defaultCarrier: "USPS",
    });
    const insert = client.calls.find((call) => call.sql.includes("INSERT INTO dropship.dropship_package_profiles"));
    // Channel defaults only: variant id, carrier, service, box, active, now.
    expect(insert?.params).toEqual([
      10,
      "USPS",
      "Ground Advantage",
      null,
      true,
      new Date("2026-07-11T12:00:00.000Z"),
    ]);
    expect(insert?.sql).not.toContain("weight_grams");
    expect(insert?.sql).not.toContain("ship_alone");
    expect(insert?.sql).not.toContain("max_units_per_package");
    const load = client.calls.find((call) => call.sql.includes("FROM dropship.dropship_package_profiles pp"));
    expect(load?.sql).toContain("pv.weight_grams");
    expect(load?.sql).toContain("pv.ships_in_own_container");
    expect(load?.sql).not.toContain("pp.weight_grams");
    expect(load?.sql).not.toContain("pp.ship_alone");
  });

  it("allows saving channel defaults when catalog package data is incomplete", async () => {
    const client = new PackageProfileClient({ variantExists: true });
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    const repository = new PgDropshipShippingConfigRepository(pool);

    // Missing dims no longer block saving channel defaults — the quote path
    // degrades to weight-only packages with a warning instead.
    const result = await repository.upsertPackageProfile(makePackageProfileInput());
    expect(result.record.productVariantId).toBe(10);
    expect(client.calls.some((call) => call.sql.includes("INSERT INTO dropship.dropship_package_profiles"))).toBe(true);
  });

  it("rejects channel defaults for a missing catalog variant", async () => {
    const client = new PackageProfileClient({ variantExists: false });
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    const repository = new PgDropshipShippingConfigRepository(pool);

    await expect(repository.upsertPackageProfile(makePackageProfileInput())).rejects.toMatchObject({
      code: "DROPSHIP_PRODUCT_VARIANT_NOT_FOUND",
      context: { productVariantId: 10 },
    });
    expect(client.calls.some((call) => call.sql.includes("INSERT INTO dropship.dropship_package_profiles"))).toBe(false);
    expect(client.queries).toContain("ROLLBACK");
  });
});

function makePackageProfileInput() {
  return {
    productVariantId: 10,
    defaultCarrier: "USPS",
    defaultService: "Ground Advantage",
    defaultBoxId: null,
    isActive: true,
    idempotencyKey: "package-profile-001",
    requestHash: "request-hash",
    actor: { actorType: "admin" as const, actorId: "admin-1" },
    now: new Date("2026-07-11T12:00:00.000Z"),
  };
}

class PackageProfileClient {
  readonly queries: string[] = [];
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  released = false;

  constructor(private readonly options: { variantExists: boolean }) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const normalized = sql.trim();
    this.queries.push(normalized);
    this.calls.push({ sql: normalized, params });
    if (normalized.includes("INSERT INTO dropship.dropship_admin_config_commands")) {
      return result([{ id: 91 } as T]);
    }
    if (normalized === "SELECT id FROM catalog.product_variants WHERE id = $1 LIMIT 1") {
      return result(this.options.variantExists ? [{ id: 10 } as T] : []);
    }
    if (normalized.includes("INSERT INTO dropship.dropship_package_profiles")) {
      return result([{ id: 44 } as T]);
    }
    if (normalized.includes("FROM dropship.dropship_package_profiles pp")) {
      return result([{
        id: 44,
        product_variant_id: 10,
        product_id: 100,
        product_sku: "PRODUCT",
        product_name: "Product",
        variant_sku: "SKU-10",
        variant_name: "Variant",
        weight_grams: 321,
        length_mm: 210,
        width_mm: 140,
        height_mm: 30,
        ships_in_own_container: true,
        default_carrier: "USPS",
        default_service: "Ground Advantage",
        default_box_id: null,
        max_units_per_package: null,
        is_active: true,
        created_at: new Date("2026-07-11T12:00:00.000Z"),
        updated_at: new Date("2026-07-11T12:00:00.000Z"),
      } as T]);
    }
    return result([]);
  }

  release(): void {
    this.released = true;
  }
}

class PolicyConflictClient {
  readonly queries: string[] = [];
  released = false;

  async query<T>(sql: string): Promise<QueryResult<T>> {
    this.queries.push(sql.trim());
    if (sql.includes("INSERT INTO dropship.dropship_admin_config_commands")) {
      return result([{ id: 91 } as T]);
    }
    if (sql.includes("SELECT id, name") && sql.includes("dropship_shipping_markup_config")) {
      return result([{ id: 17, name: "Default shipping" } as T]);
    }
    return result([]);
  }

  release(): void {
    this.released = true;
  }
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
