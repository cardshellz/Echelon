import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

import { PgDropshipOrderProcessingRepository } from "../../infrastructure/dropship-order-processing.repository";
import type { DropshipOrderProcessingIntakeRecord } from "../../application/dropship-order-processing-service";

const now = new Date("2026-05-09T18:00:00.000Z");
const expiredAt = new Date("2026-05-09T17:59:59.000Z");

describe("PgDropshipOrderProcessingRepository", () => {
  it("claims expired payment holds so the service can cancel them through the audited path", async () => {
    const row = makeProcessingIntakeRow({
      status: "payment_hold",
      payment_hold_expires_at: expiredAt,
    });
    const client = makeClaimClient(row);
    const repository = new PgDropshipOrderProcessingRepository(makePool(client));

    const result = await repository.claimIntake({
      intakeId: 91,
      workerId: "worker-1",
      now,
    });

    expect(result).toMatchObject({
      claimed: true,
      skipReason: null,
      intake: {
        intakeId: 91,
        status: "processing",
        paymentHoldExpiresAt: expiredAt,
      },
      config: { defaultWarehouseId: 3, warehouseConfigError: null },
    });

    const claimQuery = client.query.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'processing'"),
    );
    expect(claimQuery?.[1]).toEqual([91, now]);

    const auditQuery = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    );
    expect(auditQuery?.[1]).toEqual([
      10,
      22,
      "91",
      "order_processing_claimed",
      "worker-1",
      "info",
      JSON.stringify({
        status: "processing",
        externalOrderId: "EXT-91",
        previousStatus: "payment_hold",
        stagedShippingQuoteSnapshotId: null,
      }),
      now,
    ]);
    expect(result.stagedShippingQuoteSnapshotId).toBeNull();
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns and audits the quote an acceptance stage froze, read inside the claim transaction", async () => {
    const client = makeClaimClient(makeProcessingIntakeRow({ status: "retrying" }), 3652);
    const repository = new PgDropshipOrderProcessingRepository(makePool(client));

    const result = await repository.claimIntake({ intakeId: 91, workerId: "dropship-admin-process:admin:7", now });

    expect(result).toMatchObject({ claimed: true, stagedShippingQuoteSnapshotId: 3652 });
    const statements = client.query.mock.calls.map((call) => String(call[0]));
    const stageRead = statements.findIndex((sql) => sql.includes("FROM dropship.dropship_order_acceptance_stages"));
    expect(stageRead).toBeGreaterThan(statements.findIndex((sql) => sql.includes("FOR UPDATE OF oi")));
    expect(stageRead).toBeLessThan(statements.indexOf("COMMIT"));
    expect(client.query.mock.calls[stageRead][1]).toEqual([91]);
    const auditQuery = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    );
    expect(JSON.parse(String(auditQuery?.[1][6]))).toMatchObject({ stagedShippingQuoteSnapshotId: 3652 });
  });

  it("quotes a listed variant the dropship catalog offers, with no separate dropship switch", async () => {
    const { repository, query } = makeQuoteRepository({ catalogRules: [catalogRuleRow()] });

    await expect(repository.resolveQuoteItems({ intake: makeQuoteIntake(), now })).resolves.toEqual([
      expect.objectContaining({ productVariantId: 101 }),
    ]);
    const statements = query.mock.calls.map((call) => String(call[0]));
    expect(statements.some((sql) => sql.includes("dropship_eligible"))).toBe(false);
    expect(statements.some((sql) => sql.includes("FROM dropship.dropship_catalog_rules"))).toBe(true);
  });

  it.each([
    {
      label: "a variant the catalog rules exclude",
      catalogRules: [catalogRuleRow(), catalogRuleRow({ id: 2, scope_type: "product", action: "exclude", product_id: 7 })],
      catalogReason: "excluded_by_admin_rule",
    },
    { label: "a variant no catalog rule includes", catalogRules: [], catalogReason: "missing_include_rule" },
  ])("refuses $label, as the catalog would", async ({ catalogRules, catalogReason }) => {
    const { repository } = makeQuoteRepository({ catalogRules });

    await expect(repository.resolveQuoteItems({ intake: makeQuoteIntake(), now })).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_PROCESSING_VARIANT_NOT_ELIGIBLE",
      context: expect.objectContaining({ catalogReason }),
    });
  });

  it("rejects an internal-only listing before generating a shipping quote", async () => {
    const query = vi.fn(async (statement: string) => ({
      rows: String(statement).includes("FROM dropship.dropship_vendor_listings")
        ? [{
          listing_id: 44,
          product_variant_id: 101,
          listing_status: "active",
          external_listing_id: "listing-44",
          external_offer_id: "offer-44",
          product_sku: "PRODUCT-101",
          variant_sku: "INTERNAL-EA",
          product_is_active: true,
          variant_is_active: true,
          sales_eligibility: "internal_only",
        }]
        : [],
    }));
    const repository = new PgDropshipOrderProcessingRepository({ query } as unknown as Pool);
    const source = makeProcessingIntakeRow();
    const intake: DropshipOrderProcessingIntakeRecord = {
      intakeId: source.id,
      vendorId: source.vendor_id,
      storeConnectionId: source.store_connection_id,
      platform: source.platform,
      externalOrderId: source.external_order_id,
      status: "processing",
      paymentHoldExpiresAt: source.payment_hold_expires_at,
      normalizedPayload: source.normalized_payload,
    };

    await expect(repository.resolveQuoteItems({ intake, now })).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_PROCESSING_VARIANT_NOT_ELIGIBLE",
      context: expect.objectContaining({ customerSellable: false, catalogReason: "not_customer_sellable" }),
    });
    expect(String(query.mock.calls[0]?.[0])).toContain("pv.sales_eligibility");
  });
});

function makeQuoteRepository(input: { catalogRules: Array<ReturnType<typeof catalogRuleRow>> }) {
  const query = vi.fn(async (statement: string) => {
    if (String(statement).includes("FROM dropship.dropship_vendor_listings")) {
      return {
        rows: [{
          listing_id: 44,
          product_id: 7,
          product_variant_id: 101,
          product_line_ids: [],
          category: "supplies",
          listing_status: "active",
          external_listing_id: "listing-44",
          external_offer_id: "offer-44",
          product_sku: "PRODUCT-101",
          variant_sku: "SKU-101",
          product_is_active: true,
          variant_is_active: true,
          sales_eligibility: "sellable",
        }],
      };
    }
    if (String(statement).includes("FROM dropship.dropship_catalog_rules")) {
      return { rows: input.catalogRules };
    }
    return { rows: [] };
  });
  return { repository: new PgDropshipOrderProcessingRepository({ query } as unknown as Pool), query };
}

function makeQuoteIntake(): DropshipOrderProcessingIntakeRecord {
  const source = makeProcessingIntakeRow();
  return {
    intakeId: source.id,
    vendorId: source.vendor_id,
    storeConnectionId: source.store_connection_id,
    platform: source.platform,
    externalOrderId: source.external_order_id,
    status: "processing",
    paymentHoldExpiresAt: source.payment_hold_expires_at,
    normalizedPayload: source.normalized_payload,
  };
}

function catalogRuleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    revision_id: 1,
    scope_type: "catalog",
    action: "include",
    product_line_id: null,
    product_id: null,
    product_variant_id: null,
    category: null,
    priority: 0,
    is_active: true,
    starts_at: null,
    ends_at: null,
    notes: null,
    metadata: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makePool(client: PoolClient): Pool {
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

function makeClaimClient(row: ProcessingRow, stagedShippingQuoteSnapshotId: number | null = null): PoolClient & {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(async (query: string) => {
      if (String(query).includes("FOR UPDATE OF oi")) {
        return { rows: [row] };
      }
      if (String(query).includes("SET status = 'processing'")) {
        return { rows: [{ ...row, status: "processing" }] };
      }
      if (String(query).includes("FROM dropship.dropship_order_acceptance_stages")) {
        return {
          rows: stagedShippingQuoteSnapshotId === null
            ? []
            : [{ shipping_quote_snapshot_id: stagedShippingQuoteSnapshotId }],
        };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  } as unknown as PoolClient & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

interface ProcessingRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  platform: "ebay" | "shopify";
  external_order_id: string;
  status: string;
  payment_hold_expires_at: Date | null;
  normalized_payload: {
    lines: Array<{
      productVariantId: number;
      quantity: number;
      unitRetailPriceCents: number;
      externalLineItemId: string;
      title: string;
    }>;
    shipTo: {
      name: string;
      address1: string;
      city: string;
      region: string;
      postalCode: string;
      country: string;
    };
  };
  store_config: Record<string, unknown>;
}

function makeProcessingIntakeRow(overrides: Partial<ProcessingRow> = {}): ProcessingRow {
  return {
    id: 91,
    vendor_id: 10,
    store_connection_id: 22,
    platform: "shopify",
    external_order_id: "EXT-91",
    status: "received",
    payment_hold_expires_at: null,
    normalized_payload: {
      lines: [{
        productVariantId: 101,
        quantity: 1,
        unitRetailPriceCents: 1000,
        externalLineItemId: "line-1",
        title: "Shell",
      }],
      shipTo: {
        name: "Buyer Name",
        address1: "1 Main St",
        city: "New York",
        region: "NY",
        postalCode: "10001",
        country: "US",
      },
    },
    store_config: { orderProcessing: { defaultWarehouseId: 3 } },
    ...overrides,
  };
}
