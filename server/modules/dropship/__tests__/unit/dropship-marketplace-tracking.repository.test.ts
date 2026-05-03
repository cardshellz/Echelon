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
    expect(shipmentLineQuery?.[1]).toEqual([55, 500]);
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
    ...overrides,
  };
}
