import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgDropshipOrderOpsRepository } from "../../infrastructure/dropship-order-ops.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const now = new Date("2026-05-03T12:00:00.000Z");

describe("PgDropshipOrderOpsRepository", () => {
  it("filters and searches order intake cancellation states for ops review", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText.includes("COUNT(*) OVER()")) {
        expect(sqlText).toContain("oi.status = ANY($1::text[])");
        expect(sqlText).toContain("oi.cancellation_status = ANY($2::text[])");
        expect(sqlText).toContain("oi.rejection_reason ILIKE $3");
        expect(sqlText).toContain("oi.cancellation_status ILIKE $3");
        expect(params).toEqual([
          ["exception"],
          ["marketplace_cancellation_failed"],
          "%cancel failed%",
          25,
          0,
        ]);
        return { rows: [makeListRow()] };
      }
      if (sqlText.includes("SELECT oi.status, COUNT(*) AS count")) {
        expect(sqlText).not.toContain("oi.status = ANY");
        expect(sqlText).toContain("oi.cancellation_status = ANY($1::text[])");
        expect(params).toEqual([
          ["marketplace_cancellation_failed"],
          "%cancel failed%",
        ]);
        return { rows: [{ status: "exception", count: "1" }] };
      }
      if (sqlText.includes("SELECT oi.cancellation_status, COUNT(*) AS count")) {
        expect(sqlText).not.toContain("oi.status = ANY");
        expect(sqlText).not.toContain("oi.cancellation_status = ANY");
        expect(sqlText).toContain("oi.cancellation_status IS NOT NULL");
        expect(params).toEqual(["%cancel failed%"]);
        return { rows: [{ cancellation_status: "marketplace_cancellation_failed", count: "1" }] };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipOrderOpsRepository(makePool(makeClient(query)));

    const result = await repository.listIntakes({
      statuses: ["exception"],
      cancellationStatuses: ["marketplace_cancellation_failed"],
      search: "cancel failed",
      page: 1,
      limit: 25,
    });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      intakeId: 42,
      status: "exception",
      cancellationStatus: "marketplace_cancellation_failed",
    });
    expect(result.cancellationSummary).toEqual([
      { cancellationStatus: "marketplace_cancellation_failed", count: 1 },
    ]);
  });

  it("loads shipment line items with marketplace tracking pushes for order detail", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText.includes("LEFT JOIN dropship.dropship_order_economics_snapshots econ")) {
        expect(sqlText).toContain("WHERE oi.id = $1");
        expect(params).toEqual([42]);
        return { rows: [makeDetailRow()] };
      }
      if (sqlText.includes("FROM dropship.dropship_audit_events") && sqlText.includes("LIMIT 20")) {
        expect(params).toEqual(["42"]);
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_marketplace_tracking_pushes tp")) {
        expect(sqlText).toContain("wms.outbound_shipment_items");
        expect(sqlText).toContain("oms.oms_order_lines");
        expect(params).toEqual([42, 10, 22]);
        return {
          rows: [
            makeTrackingPushRow({
              line_items: [
                {
                  externalLineItemId: "line-a",
                  sku: "SKU-A",
                  title: "Product A",
                  productVariantId: 101,
                  quantity: 1,
                },
                {
                  externalLineItemId: "line-b",
                  sku: "SKU-B",
                  title: "Product B",
                  productVariantId: null,
                  quantity: "2",
                },
              ],
            }),
            makeTrackingPushRow({
              id: 302,
              wms_shipment_id: 889,
              tracking_number: "1Z999",
              line_items: JSON.stringify([
                {
                  external_line_item_id: "line-c",
                  sku: "SKU-C",
                  title: "Product C",
                  product_variant_id: "202",
                  quantity: "1",
                },
              ]),
            }),
          ],
        };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipOrderOpsRepository(makePool(makeClient(query)));

    const detail = await repository.getIntakeDetail({ intakeId: 42 });

    expect(detail?.trackingPushes).toHaveLength(2);
    expect(detail?.trackingPushes[0]).toMatchObject({
      pushId: 301,
      wmsShipmentId: 888,
      platform: "ebay",
      trackingNumber: "1Z123",
      lineItems: [
        {
          externalLineItemId: "line-a",
          sku: "SKU-A",
          title: "Product A",
          productVariantId: 101,
          quantity: 1,
        },
        {
          externalLineItemId: "line-b",
          sku: "SKU-B",
          title: "Product B",
          productVariantId: null,
          quantity: 2,
        },
      ],
    });
    expect(detail?.trackingPushes[1].lineItems).toEqual([
      {
        externalLineItemId: "line-c",
        sku: "SKU-C",
        title: "Product C",
        productVariantId: 202,
        quantity: 1,
      },
    ]);
  });

  it("rejects non-stale processing intake retries without updating the row", async () => {
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "ROLLBACK") {
        return { rows: [] };
      }
      if (sqlText.trim().startsWith("SELECT") && sqlText.includes("FOR UPDATE")) {
        return {
          rows: [
            makeActionRow({
              status: "processing",
              updated_at: now,
            }),
          ],
        };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipOrderOpsRepository(makePool(makeClient(query)));

    await expect(repository.retryIntake(makeRetryInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_OPS_STATUS_NOT_RETRYABLE",
      context: {
        intakeId: 42,
        status: "processing",
        updatedAt: now.toISOString(),
        staleAfterMinutes: 30,
      },
    });
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_order_intake"),
    )).toBe(false);
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    )).toBe(false);
  });

  it("moves stale processing intakes to retrying with audit context", async () => {
    const staleUpdatedAt = new Date("2026-05-03T11:20:00.000Z");
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "COMMIT") {
        return { rows: [] };
      }
      if (sqlText.trim().startsWith("SELECT") && sqlText.includes("FOR UPDATE")) {
        return {
          rows: [
            makeActionRow({
              status: "processing",
              updated_at: staleUpdatedAt,
            }),
          ],
        };
      }
      if (sqlText.includes("UPDATE dropship.dropship_order_intake")) {
        return {
          rows: [
            makeActionRow({
              status: "retrying",
              updated_at: now,
            }),
          ],
        };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipOrderOpsRepository(makePool(makeClient(query)));

    const result = await repository.retryIntake(makeRetryInput());

    expect(result).toMatchObject({
      intakeId: 42,
      previousStatus: "processing",
      status: "retrying",
      idempotentReplay: false,
      updatedAt: now,
    });

    const updateCall = query.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_order_intake"),
    );
    expect(updateCall?.[1]).toEqual([42, now]);

    const auditCall = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    );
    expect(auditCall?.[1]?.[0]).toBe(10);
    expect(auditCall?.[1]?.[1]).toBe(22);
    expect(auditCall?.[1]?.[2]).toBe("42");
    expect(auditCall?.[1]?.[3]).toBe("order_ops_retry_requested");
    expect(auditCall?.[1]?.[4]).toBe("admin");
    expect(auditCall?.[1]?.[5]).toBe("ops-user");
    expect(auditCall?.[1]?.[6]).toBe("info");
    expect(JSON.parse(String(auditCall?.[1]?.[7]))).toMatchObject({
      externalOrderId: "ORDER-42",
      idempotencyKey: "admin-retry-42",
      previousStatus: "processing",
      staleProcessingUpdatedAt: staleUpdatedAt.toISOString(),
      staleAfterMinutes: 30,
      reason: "recover stale processing intake",
    });
  });

  it("moves failed marketplace cancellations to retrying without clearing cancellation context", async () => {
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "COMMIT") {
        return { rows: [] };
      }
      if (sqlText.trim().startsWith("SELECT") && sqlText.includes("FOR UPDATE")) {
        return {
          rows: [
            makeActionRow({
              status: "exception",
              cancellation_status: "marketplace_cancellation_failed",
              rejection_reason: "Marketplace cancellation failed: DROPSHIP_EBAY_LISTING_CONFIG_REQUIRED - missing cancel reason",
            }),
          ],
        };
      }
      if (sqlText.includes("FROM dropship.dropship_audit_events")) {
        return {
          rows: [{
            payload: {
              previousCancellationStatus: "order_intake_rejected",
              errorCode: "DROPSHIP_EBAY_LISTING_CONFIG_REQUIRED",
            },
          }],
        };
      }
      if (sqlText.includes("UPDATE dropship.dropship_order_intake")) {
        return {
          rows: [
            makeActionRow({
              status: "cancelled",
              cancellation_status: "marketplace_cancellation_retrying",
              rejection_reason: "Order intake was rejected before marketplace cancellation completed.",
              updated_at: now,
            }),
          ],
        };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipOrderOpsRepository(makePool(makeClient(query)));

    const result = await repository.retryMarketplaceCancellation(makeCancellationRetryInput());

    expect(result).toMatchObject({
      intakeId: 42,
      previousStatus: "exception",
      status: "cancelled",
      previousCancellationStatus: "marketplace_cancellation_failed",
      cancellationStatus: "marketplace_cancellation_retrying",
      idempotentReplay: false,
      updatedAt: now,
    });

    const updateCall = query.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_order_intake"),
    );
    expect(updateCall?.[1]).toEqual([
      42,
      "marketplace_cancellation_retrying",
      "Order intake was rejected before marketplace cancellation completed.",
      now,
    ]);

    const auditCall = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    );
    expect(auditCall?.[1]?.[3]).toBe("order_marketplace_cancellation_retry_requested");
    expect(auditCall?.[1]?.[6]).toBe("warning");
    expect(JSON.parse(String(auditCall?.[1]?.[7]))).toMatchObject({
      idempotencyKey: "admin-retry-cancel-42",
      previousStatus: "exception",
      previousCancellationStatus: "marketplace_cancellation_failed",
      restoredRejectionReason: "Order intake was rejected before marketplace cancellation completed.",
      reason: "cancel reason config repaired",
    });
  });

  it("rejects cancellation retry when cancellation status is not failed", async () => {
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "ROLLBACK") {
        return { rows: [] };
      }
      if (sqlText.trim().startsWith("SELECT") && sqlText.includes("FOR UPDATE")) {
        return {
          rows: [
            makeActionRow({
              status: "cancelled",
              cancellation_status: "marketplace_cancelled",
            }),
          ],
        };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipOrderOpsRepository(makePool(makeClient(query)));

    await expect(repository.retryMarketplaceCancellation(makeCancellationRetryInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_OPS_CANCELLATION_STATUS_NOT_RETRYABLE",
      context: {
        intakeId: 42,
        status: "cancelled",
        cancellationStatus: "marketplace_cancelled",
      },
    });
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_order_intake"),
    )).toBe(false);
  });
});

function makeRetryInput() {
  return {
    intakeId: 42,
    idempotencyKey: "admin-retry-42",
    reason: "recover stale processing intake",
    actor: { actorType: "admin" as const, actorId: "ops-user" },
    now,
  };
}

function makeCancellationRetryInput() {
  return {
    intakeId: 42,
    idempotencyKey: "admin-retry-cancel-42",
    reason: "cancel reason config repaired",
    actor: { actorType: "admin" as const, actorId: "ops-user" },
    now,
  };
}

function makeActionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    vendor_id: 10,
    store_connection_id: 22,
    external_order_id: "ORDER-42",
    status: "failed",
    payment_hold_expires_at: null,
    rejection_reason: "previous failure",
    cancellation_status: null,
    updated_at: now,
    ...overrides,
  };
}

function makeListRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    vendor_id: 10,
    store_connection_id: 22,
    platform: "ebay",
    external_order_id: "ORDER-42",
    external_order_number: "1001",
    status: "exception",
    payment_hold_expires_at: null,
    rejection_reason: "Marketplace cancellation failed: config missing",
    cancellation_status: "marketplace_cancellation_failed",
    normalized_payload: {
      lines: [{ quantity: 2 }],
      shipTo: { country: "US", postalCode: "10001" },
    },
    oms_order_id: null,
    received_at: now,
    accepted_at: null,
    updated_at: now,
    member_id: "member-1",
    business_name: "Vendor Co",
    email: "vendor@example.com",
    vendor_status: "active",
    entitlement_status: "active",
    store_platform: "ebay",
    store_status: "connected",
    setup_status: "ready",
    access_token_ref: "token-ref",
    refresh_token_ref: "refresh-ref",
    external_display_name: "Vendor eBay",
    shop_domain: null,
    latest_event_type: "order_marketplace_cancellation_failed",
    latest_event_severity: "error",
    latest_event_created_at: now,
    latest_event_payload: { errorCode: "CONFIG_MISSING" },
    total_count: "1",
    ...overrides,
  };
}

function makeDetailRow(overrides: Record<string, unknown> = {}) {
  return {
    ...makeListRow({
      oms_order_id: 9001,
      normalized_payload: {
        orderedAt: "2026-05-03T10:00:00.000Z",
        marketplaceStatus: "paid",
        lines: [
          {
            externalLineItemId: "line-a",
            sku: "SKU-A",
            productVariantId: 101,
            quantity: 3,
            unitRetailPriceCents: 1200,
            title: "Product A",
          },
        ],
        shipTo: { country: "US", postalCode: "10001" },
        totals: {
          retailSubtotalCents: 3600,
          shippingPaidCents: 500,
          taxCents: 0,
          discountCents: 0,
          grandTotalCents: 4100,
          currency: "USD",
        },
      },
    }),
    source_order_id: "source-42",
    economics_snapshot_id: null,
    economics_shipping_quote_snapshot_id: null,
    economics_warehouse_id: null,
    economics_currency: null,
    retail_subtotal_cents: null,
    wholesale_subtotal_cents: null,
    shipping_cents: null,
    economics_insurance_pool_cents: null,
    fees_cents: null,
    total_debit_cents: null,
    pricing_snapshot: null,
    economics_created_at: null,
    quote_snapshot_id: null,
    quote_warehouse_id: null,
    quote_currency: null,
    quote_destination_country: null,
    quote_destination_postal_code: null,
    quote_package_count: null,
    base_rate_cents: null,
    markup_cents: null,
    quote_insurance_pool_cents: null,
    dunnage_cents: null,
    total_shipping_cents: null,
    quote_payload: null,
    quote_created_at: null,
    wallet_ledger_entry_id: null,
    wallet_ledger_type: null,
    wallet_ledger_status: null,
    wallet_ledger_amount_cents: null,
    wallet_ledger_currency: null,
    available_balance_after_cents: null,
    pending_balance_after_cents: null,
    wallet_ledger_created_at: null,
    wallet_ledger_settled_at: null,
    ...overrides,
  };
}

function makeTrackingPushRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 301,
    wms_shipment_id: 888,
    platform: "ebay",
    status: "succeeded",
    carrier: "UPS",
    tracking_number: "1Z123",
    shipped_at: now,
    external_fulfillment_id: "fulfillment-1",
    attempt_count: "1",
    retryable: true,
    last_error_code: null,
    last_error_message: null,
    line_items: [],
    created_at: now,
    updated_at: now,
    completed_at: now,
    ...overrides,
  };
}

function makeClient(query: ReturnType<typeof vi.fn>): PoolClient {
  return { query, release: vi.fn() } as unknown as PoolClient;
}

function makePool(client: PoolClient): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}
