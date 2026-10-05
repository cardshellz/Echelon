import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgDropshipMarketplaceTrackingRepository } from "../../infrastructure/dropship-marketplace-tracking.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const now = new Date("2026-05-03T15:00:00.000Z");
const shippedAt = new Date("2026-05-02T10:00:00.000Z");

describe("PgDropshipMarketplaceTrackingRepository", () => {
  it("claims shipment-aware tracking pushes with only the shipment line quantities", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "COMMIT") {
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_order_intake")) {
        return { rows: [makeIntakeRow()] };
      }
      if (sqlText.includes("FROM wms.outbound_shipment_items si")) {
        return {
          rows: [
            { external_line_item_id: "LINE-A", quantity: 1 },
            { external_line_item_id: "LINE-B", quantity: 2 },
          ],
        };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_marketplace_tracking_pushes")) {
        return {
          rows: [
            makeTrackingPushRow({
              request_hash: String(params?.[9]),
              wms_shipment_id: params?.[13] as number,
            }),
          ],
        };
      }
      if (sqlText.includes("UPDATE dropship.dropship_marketplace_tracking_pushes")) {
        return {
          rows: [
            makeTrackingPushRow({
              status: "processing",
              request_hash: "unused-after-claim",
              wms_shipment_id: 55,
              attempt_count: 1,
            }),
          ],
        };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = new PgDropshipMarketplaceTrackingRepository(pool);

    const result = await repository.claimForOmsOrder({
      omsOrderId: 500,
      wmsShipmentId: 55,
      carrier: "USPS",
      trackingNumber: "94001111",
      shippedAt,
      idempotencyKey: "dropship:oms:500:shipment:55:tracking:usps:94001111",
      now,
    });

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") throw new Error("Expected a claimed tracking push.");
    expect(result.push).toMatchObject({
      omsOrderId: 500,
      wmsShipmentId: 55,
      attemptCount: 1,
      status: "processing",
    });
    expect(result.request).toMatchObject({
      omsOrderId: 500,
      wmsShipmentId: 55,
      lineItems: [
        { externalLineItemId: "LINE-A", quantity: 1 },
        { externalLineItemId: "LINE-B", quantity: 2 },
      ],
    });

    const shipmentLineQuery = query.mock.calls.find((call) =>
      String(call[0]).includes("FROM wms.outbound_shipment_items si"),
    );
    expect(String(shipmentLineQuery?.[0])).toContain("WHERE si.shipment_id = $1");
    expect(String(shipmentLineQuery?.[0])).toContain("AND ol.order_id = $2");
    expect(String(shipmentLineQuery?.[0])).toContain(
      "COALESCE(LOWER(NULLIF(BTRIM(ol.fulfillment_provider), '')), 'dropship') = 'dropship'",
    );
    expect(shipmentLineQuery?.[1]).toEqual([55, 500]);
  });

  it("filters order-level tracking reads to dropship-owned or legacy OMS lines", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "COMMIT") {
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_order_intake")) {
        return { rows: [makeIntakeRow()] };
      }
      if (sqlText.includes("FROM oms.oms_order_lines")) {
        return {
          rows: [
            { external_line_item_id: "LINE-A", quantity: 1 },
            { external_line_item_id: "LINE-B", quantity: 2 },
          ],
        };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_marketplace_tracking_pushes")) {
        return {
          rows: [
            makeTrackingPushRow({
              request_hash: String(params?.[9]),
              wms_shipment_id: params?.[13] as number | null,
            }),
          ],
        };
      }
      if (sqlText.includes("UPDATE dropship.dropship_marketplace_tracking_pushes")) {
        return {
          rows: [
            makeTrackingPushRow({
              status: "processing",
              request_hash: "unused-after-claim",
              wms_shipment_id: null,
              attempt_count: 1,
            }),
          ],
        };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = new PgDropshipMarketplaceTrackingRepository(pool);

    const result = await repository.claimForOmsOrder({
      omsOrderId: 500,
      wmsShipmentId: null,
      carrier: "USPS",
      trackingNumber: "94001111",
      shippedAt,
      idempotencyKey: "dropship:oms:500:tracking:usps:94001111",
      now,
    });

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") throw new Error("Expected a claimed tracking push.");
    expect(result.request.lineItems).toEqual([
      { externalLineItemId: "LINE-A", quantity: 1 },
      { externalLineItemId: "LINE-B", quantity: 2 },
    ]);

    const orderLineQuery = query.mock.calls.find((call) =>
      String(call[0]).includes("FROM oms.oms_order_lines"),
    );
    expect(String(orderLineQuery?.[0])).toContain("WHERE order_id = $1");
    expect(String(orderLineQuery?.[0])).toContain(
      "COALESCE(LOWER(NULLIF(BTRIM(fulfillment_provider), '')), 'dropship') = 'dropship'",
    );
    expect(orderLineQuery?.[1]).toEqual([500]);
  });

  it("does not reclaim a non-stale processing push for the same idempotency key", async () => {
    let requestHash = "";
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "COMMIT") {
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_order_intake")) {
        return { rows: [makeIntakeRow()] };
      }
      if (sqlText.includes("FROM wms.outbound_shipment_items si")) {
        return { rows: [{ external_line_item_id: "LINE-A", quantity: 1 }] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_marketplace_tracking_pushes")) {
        requestHash = String(params?.[9]);
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_marketplace_tracking_pushes")) {
        return {
          rows: [
            makeTrackingPushRow({
              status: "processing",
              request_hash: requestHash,
              attempt_count: 1,
              updated_at: now,
            }),
          ],
        };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = new PgDropshipMarketplaceTrackingRepository(pool);

    const result = await repository.claimForOmsOrder({
      omsOrderId: 500,
      wmsShipmentId: 55,
      carrier: "USPS",
      trackingNumber: "94001111",
      shippedAt,
      idempotencyKey: "dropship:oms:500:shipment:55:tracking:usps:94001111",
      now,
    });

    expect(result.status).toBe("already_processing");
    if (result.status !== "already_processing") throw new Error("Expected an already processing tracking push.");
    expect(result.push).toMatchObject({
      pushId: 40,
      omsOrderId: 500,
      wmsShipmentId: 55,
      status: "processing",
      attemptCount: 1,
    });
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_marketplace_tracking_pushes"),
    )).toBe(false);
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    )).toBe(false);
  });

  it("audits and reclaims stale processing pushes for the same idempotency key", async () => {
    let requestHash = "";
    const staleUpdatedAt = new Date("2026-05-03T14:20:00.000Z");
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "COMMIT") {
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_order_intake")) {
        return { rows: [makeIntakeRow()] };
      }
      if (sqlText.includes("FROM wms.outbound_shipment_items si")) {
        return { rows: [{ external_line_item_id: "LINE-A", quantity: 1 }] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_marketplace_tracking_pushes")) {
        requestHash = String(params?.[9]);
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_marketplace_tracking_pushes")) {
        return {
          rows: [
            makeTrackingPushRow({
              status: "processing",
              request_hash: requestHash,
              attempt_count: 1,
              updated_at: staleUpdatedAt,
            }),
          ],
        };
      }
      if (sqlText.includes("UPDATE dropship.dropship_marketplace_tracking_pushes")) {
        return {
          rows: [
            makeTrackingPushRow({
              status: "processing",
              request_hash: requestHash,
              attempt_count: 2,
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
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = new PgDropshipMarketplaceTrackingRepository(pool);

    const result = await repository.claimForOmsOrder({
      omsOrderId: 500,
      wmsShipmentId: 55,
      carrier: "USPS",
      trackingNumber: "94001111",
      shippedAt,
      idempotencyKey: "dropship:oms:500:shipment:55:tracking:usps:94001111",
      now,
    });

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") throw new Error("Expected a reclaimed tracking push.");
    expect(result.push).toMatchObject({
      pushId: 40,
      status: "processing",
      attemptCount: 2,
    });

    const auditCalls = query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    );
    expect(auditCalls).toHaveLength(2);
    expect(auditCalls[0]?.[1]?.[4]).toBe("tracking_push_stale_recovered");
    expect(auditCalls[0]?.[1]?.[5]).toBe("warning");
    expect(JSON.parse(String(auditCalls[0]?.[1]?.[6]))).toMatchObject({
      previousStatus: "processing",
      stalePushUpdatedAt: staleUpdatedAt.toISOString(),
      staleAfterMinutes: 30,
      attemptCount: 1,
    });
    expect(auditCalls[1]?.[1]?.[4]).toBe("tracking_push_claimed");
  });
});

describe("PgDropshipMarketplaceTrackingRepository caller-named lines", () => {
  const RAILS_KEY = "channel-fulfillment-command:9001";

  function railsClaimInput(lineItems: Array<{ externalLineItemId: string; quantity: number }>) {
    return {
      omsOrderId: 500,
      wmsShipmentId: 55,
      carrier: "USPS",
      trackingNumber: "94001111",
      shippedAt,
      idempotencyKey: RAILS_KEY,
      lineItems,
      now,
    };
  }

  function harness(orderedLines: Array<{ external_line_item_id: string; ordered_quantity: number }>) {
    const insertedHashes: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "COMMIT" || sqlText === "ROLLBACK") {
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_order_intake")) {
        return { rows: [makeIntakeRow()] };
      }
      if (sqlText.includes("SUM(COALESCE(quantity, 0))::int AS ordered_quantity")) {
        return { rows: orderedLines };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_marketplace_tracking_pushes")) {
        insertedHashes.push(String(params?.[9]));
        return {
          rows: [makeTrackingPushRow({ idempotency_key: RAILS_KEY, request_hash: String(params?.[9]) })],
        };
      }
      if (sqlText.includes("UPDATE dropship.dropship_marketplace_tracking_pushes")) {
        return {
          rows: [makeTrackingPushRow({
            idempotency_key: RAILS_KEY,
            status: "processing",
            request_hash: "unused-after-claim",
            attempt_count: 1,
          })],
        };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient & { release: ReturnType<typeof vi.fn> };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    return { repository: new PgDropshipMarketplaceTrackingRepository(pool), query, client, insertedHashes };
  }

  it("pushes exactly the named lines after checking them against the order", async () => {
    const { repository, query } = harness([
      { external_line_item_id: "LINE-A", ordered_quantity: 2 },
      { external_line_item_id: "LINE-B", ordered_quantity: 1 },
    ]);
    const lineItems = [
      { externalLineItemId: "LINE-B", quantity: 1 },
      { externalLineItemId: "LINE-A", quantity: 2 },
    ];

    const result = await repository.claimForOmsOrder(railsClaimInput(lineItems));

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") throw new Error("Expected a claimed tracking push.");
    expect(result.request.lineItems).toEqual(lineItems);
    expect(result.request.idempotencyKey).toBe(RAILS_KEY);

    const checkQuery = query.mock.calls.find((call) =>
      String(call[0]).includes("AS ordered_quantity"),
    );
    expect(String(checkQuery?.[0])).toContain("WHERE order_id = $1");
    expect(String(checkQuery?.[0])).toContain("AND external_line_item_id = ANY($2::text[])");
    expect(String(checkQuery?.[0])).toContain(
      "COALESCE(LOWER(NULLIF(BTRIM(fulfillment_provider), '')), 'dropship') = 'dropship'",
    );
    expect(checkQuery?.[1]).toEqual([500, ["LINE-B", "LINE-A"]]);
    // The shipment is not re-read for lines when the caller names them.
    expect(query.mock.calls.some((call) => String(call[0]).includes("FROM wms.outbound_shipment_items"))).toBe(false);
  });

  it("hashes the same named lines to the same request every attempt", async () => {
    const first = harness([{ external_line_item_id: "LINE-A", ordered_quantity: 2 }]);
    const second = harness([{ external_line_item_id: "LINE-A", ordered_quantity: 2 }]);
    const changed = harness([{ external_line_item_id: "LINE-A", ordered_quantity: 2 }]);

    await first.repository.claimForOmsOrder(railsClaimInput([{ externalLineItemId: "LINE-A", quantity: 2 }]));
    await second.repository.claimForOmsOrder(railsClaimInput([{ externalLineItemId: "LINE-A", quantity: 2 }]));
    await changed.repository.claimForOmsOrder(railsClaimInput([{ externalLineItemId: "LINE-A", quantity: 1 }]));

    expect(first.insertedHashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(second.insertedHashes[0]).toBe(first.insertedHashes[0]);
    expect(changed.insertedHashes[0]).not.toBe(first.insertedHashes[0]);
  });

  it("refuses a line that is not a dropship line of the order and writes nothing", async () => {
    const { repository, query, client } = harness([
      { external_line_item_id: "LINE-A", ordered_quantity: 2 },
    ]);

    const error = await repository.claimForOmsOrder(railsClaimInput([
      { externalLineItemId: "LINE-A", quantity: 1 },
      { externalLineItemId: "LINE-OTHER", quantity: 1 },
    ])).catch((caught) => caught);

    expect(error).toMatchObject({
      code: "DROPSHIP_TRACKING_LINE_ITEM_NOT_ON_ORDER",
      context: { omsOrderId: 500, externalLineItemId: "LINE-OTHER", retryable: false },
    });
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO"))).toBe(false);
    expect(query.mock.calls.some((call) => call[0] === "ROLLBACK")).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("refuses a line that claims more units than were ordered", async () => {
    const { repository, query } = harness([
      { external_line_item_id: "LINE-A", ordered_quantity: 2 },
    ]);

    const error = await repository.claimForOmsOrder(railsClaimInput([
      { externalLineItemId: "LINE-A", quantity: 3 },
    ])).catch((caught) => caught);

    expect(error).toMatchObject({
      code: "DROPSHIP_TRACKING_LINE_QUANTITY_EXCEEDS_ORDER",
      context: {
        omsOrderId: 500,
        externalLineItemId: "LINE-A",
        quantity: 3,
        orderedQuantity: 2,
        retryable: false,
      },
    });
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO"))).toBe(false);
  });
});

function makeIntakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    oms_order_id: 500,
    vendor_id: 20,
    store_connection_id: 30,
    platform: "ebay",
    external_order_id: "ORDER-1",
    external_order_number: "1001",
    source_order_id: "SRC-1",
    ...overrides,
  };
}

function makeTrackingPushRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 40,
    intake_id: 10,
    oms_order_id: 500,
    wms_shipment_id: 55,
    vendor_id: 20,
    store_connection_id: 30,
    platform: "ebay",
    external_order_id: "ORDER-1",
    external_order_number: "1001",
    source_order_id: "SRC-1",
    status: "queued",
    idempotency_key: "dropship:oms:500:shipment:55:tracking:usps:94001111",
    request_hash: "request-hash",
    carrier: "USPS",
    tracking_number: "94001111",
    shipped_at: shippedAt,
    external_fulfillment_id: null,
    attempt_count: 0,
    updated_at: now,
    ...overrides,
  };
}
