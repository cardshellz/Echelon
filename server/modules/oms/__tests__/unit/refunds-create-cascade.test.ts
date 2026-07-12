import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuthorityEvent: vi.fn(async () => undefined),
  markShipmentCancelled: vi.fn(async () => ({ wmsOrderId: 204464, changed: true })),
  recomputeOrderStatusFromShipments: vi.fn(async () => undefined),
}));
const {
  recordAuthorityEvent,
  markShipmentCancelled,
  recomputeOrderStatusFromShipments,
} = mocks;

vi.mock("../../oms-line-authority-ledger", () => ({
  recordOmsLineAuthorityEvent: mocks.recordAuthorityEvent,
}));

vi.mock("../../../orders/shipment-rollup", () => ({
  markShipmentCancelled: mocks.markShipmentCancelled,
  recomputeOrderStatusFromShipments: mocks.recomputeOrderStatusFromShipments,
}));

import {
  applyShopifyRefundCascade,
  RefundsCreateBadPayloadError,
} from "../../shopify-refund-cascade.service";

const NOW = new Date("2026-07-10T16:00:00.000Z");

function qtext(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => {
      if (chunk == null) return [];
      if (typeof chunk === "string") return [chunk];
      if (Array.isArray(chunk.value)) return chunk.value;
      if (chunk.value !== undefined) return [String(chunk.value)];
      return [];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeDb(handler: (text: string) => { rows: any[] } | Promise<{ rows: any[] }>) {
  const calls: string[] = [];
  const db: any = {
    execute: vi.fn(async (query: any) => {
      const text = qtext(query);
      calls.push(text);
      return handler(text);
    }),
    transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(db)),
  };
  return { db, calls };
}

function omsLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 110466,
    external_line_item_id: "441680952",
    channel_observed_quantity: 25,
    paid_quantity: 25,
    authority_fulfillable_quantity: 25,
    cancelled_quantity: 0,
    refunded_quantity: 0,
    authorization_status: "authorized",
    authorized_at: NOW,
    authorized_by_event_id: "paid-event",
    requires_shipping: true,
    refund_cancel_quantity: 0,
    refund_other_quantity: 0,
    ...overrides,
  };
}

function refundPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 1036275548319,
    order_id: 12153457410207,
    note: "Out of stock",
    processed_at: "2026-07-10T15:30:00.000Z",
    refund_line_items: [
      {
        line_item_id: 441680952,
        quantity: 25,
        restock_type: "no_restock",
      },
    ],
    ...overrides,
  };
}

function helpers(overrides: Record<string, unknown> = {}) {
  return {
    resolveOmsOrder: vi.fn(async () => ({ id: 242960 })),
    releaseOrderItemReservation: vi.fn(async () => ({ releasedQuantity: 25 })),
    pushShipment: vi.fn(async () => undefined),
    shippingEngine: { cancel: vi.fn(async () => undefined) },
    ...overrides,
  } as any;
}

describe("applyShopifyRefundCascade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    markShipmentCancelled.mockResolvedValue({ wmsOrderId: 204464, changed: true });
  });

  it("repairs #60037 as a no-restock line disposition without inventing a return", async () => {
    const mock = makeDb((text) => {
      if (text.includes("FROM wms.orders") && text.includes("ORDER BY id")) {
        return { rows: [{ id: 204464 }] };
      }
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM oms.oms_order_lines ol") && text.includes("FOR UPDATE OF ol")) {
        return { rows: [omsLine()] };
      }
      if (text.includes("INSERT INTO oms.order_line_adjustments")) return { rows: [{ id: 1026 }] };
      if (text.includes("LEFT JOIN oms.order_line_adjustments")) {
        return { rows: [omsLine({ refund_other_quantity: 25 })] };
      }
      if (text.includes("UPDATE oms.oms_order_lines")) return { rows: [] };
      if (text.includes("FROM wms.order_items wi") && text.includes("FOR UPDATE OF wi")) {
        return {
          rows: [{
            id: 312850,
            oms_order_line_id: 110466,
            external_line_item_id: "441680952",
            quantity: 25,
            picked_quantity: 0,
            fulfilled_quantity: 0,
            status: "short",
            requires_shipping: true,
          }],
        };
      }
      if (text.includes("FROM wms.outbound_shipment_items si") && text.includes("FOR UPDATE OF si, os")) {
        return {
          rows: [
            { shipment_item_id: 11070, shipment_id: 8008, order_item_id: 312850, current_quantity: 25, remaining_demand: 0 },
            { shipment_item_id: 11071, shipment_id: 8008, order_item_id: 312851, current_quantity: 1, remaining_demand: 0 },
          ],
        };
      }
      if (text.includes("DELETE FROM wms.outbound_shipment_items")) return { rows: [] };
      if (text.includes("FROM wms.outbound_shipments os") && text.includes("terminal_provider_sibling")) {
        return {
          rows: [{
            id: 8008,
            status: "queued",
            remaining_quantity: 0,
            terminal_provider_sibling: true,
          }],
        };
      }
      throw new Error(`Unexpected SQL in #60037 test: ${text}`);
    });
    const serviceHelpers = helpers();

    const result = await applyShopifyRefundCascade(
      mock.db,
      refundPayload(),
      serviceHelpers,
      { channelId: 36, sourceInboxId: 75058, now: NOW },
    );

    expect(result).toMatchObject({
      outcome: "line_dispositions_applied",
      omsOrderId: 242960,
      wmsOrderId: 204464,
      returnExpected: false,
      restocked: false,
      adjustedLines: 1,
      releasedReservationQuantity: 25,
      cancelledShipments: 1,
    });
    expect(serviceHelpers.releaseOrderItemReservation).toHaveBeenCalledWith({
      orderId: 204464,
      orderItemId: 312850,
      quantity: 25,
      sourceEventId: "1036275548319",
      reason: "Shopify line refund 1036275548319",
      userId: "system:shopify_refund",
    });
    expect(markShipmentCancelled).toHaveBeenCalledWith(
      mock.db,
      8008,
      "refund_retired_provider_covered_shipment",
      expect.objectContaining({ skipEngineCancel: true }),
    );
    expect(mock.calls.filter((text) => text.includes("DELETE FROM wms.outbound_shipment_items"))).toHaveLength(2);
    expect(mock.calls.some((text) => text.includes("SET qty = 0"))).toBe(false);
    expect(mock.calls.some((text) => text.includes("INSERT INTO wms.returns"))).toBe(false);
    expect(recordAuthorityEvent).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 242960,
      orderLineId: 110466,
      cancelledQuantity: 0,
      refundedQuantity: 25,
      authority: expect.objectContaining({
        authorityFulfillableQuantity: 0,
        authorizationStatus: "refunded",
      }),
    }));
  });

  it("opens an expected return only for fulfilled units carrying a return policy", async () => {
    const originalLine = omsLine({
      id: 12,
      external_line_item_id: "12",
      channel_observed_quantity: 1,
      paid_quantity: 1,
      authority_fulfillable_quantity: 1,
    });
    const mock = makeDb((text) => {
      if (text.includes("FROM wms.orders") && text.includes("ORDER BY id")) return { rows: [{ id: 42 }] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM oms.oms_order_lines ol") && text.includes("FOR UPDATE OF ol")) return { rows: [originalLine] };
      if (text.includes("INSERT INTO oms.order_line_adjustments")) return { rows: [{ id: 1 }] };
      if (text.includes("LEFT JOIN oms.order_line_adjustments")) return { rows: [omsLine({ ...originalLine, refund_other_quantity: 1 })] };
      if (text.includes("UPDATE oms.oms_order_lines")) return { rows: [] };
      if (text.includes("FROM wms.order_items wi") && text.includes("FOR UPDATE OF wi")) {
        return { rows: [{
          id: 501,
          oms_order_line_id: 12,
          external_line_item_id: "12",
          quantity: 1,
          picked_quantity: 1,
          fulfilled_quantity: 1,
          status: "completed",
          requires_shipping: true,
        }] };
      }
      if (text.includes("FROM wms.outbound_shipment_items si") && text.includes("FOR UPDATE OF si, os")) return { rows: [] };
      if (text.includes("FROM wms.outbound_shipments os") && text.includes("terminal_provider_sibling")) return { rows: [] };
      if (text.includes("SELECT COALESCE(SUM(ri.expected_qty)")) return { rows: [{ expected_quantity: 0 }] };
      if (text.includes("JOIN wms.outbound_shipment_items si") && text.includes("ORDER BY COALESCE(os.shipped_at")) return { rows: [{ id: 700 }] };
      if (text.includes("INSERT INTO wms.returns")) return { rows: [{ id: 800 }] };
      if (text.includes("INSERT INTO wms.return_items")) return { rows: [{ id: 900 }] };
      throw new Error(`Unexpected SQL in return test: ${text}`);
    });
    const serviceHelpers = helpers({
      releaseOrderItemReservation: vi.fn(async () => ({ releasedQuantity: 0 })),
    });

    const result = await applyShopifyRefundCascade(
      mock.db,
      refundPayload({
        refund_line_items: [{ line_item_id: 12, quantity: 1, restock_type: "return" }],
      }),
      serviceHelpers,
      { channelId: 36, now: NOW },
    );

    expect(result).toMatchObject({
      outcome: "return_expected",
      returnId: 800,
      returnExpected: true,
      restocked: false,
    });
    expect(mock.calls.some((text) => text.includes("INSERT INTO wms.returns") && text.includes("source_event_key"))).toBe(true);
    expect(mock.calls.some((text) => text.includes("INSERT INTO wms.return_items") && text.includes("expected_qty"))).toBe(true);
  });

  it("is idempotent when the same no-restock refund is replayed", async () => {
    const finalLine = omsLine({
      authority_fulfillable_quantity: 0,
      refunded_quantity: 25,
      authorization_status: "refunded",
      refund_other_quantity: 25,
    });
    const mock = makeDb((text) => {
      if (text.includes("FROM wms.orders") && text.includes("ORDER BY id")) return { rows: [{ id: 204464 }] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM oms.oms_order_lines ol") && text.includes("FOR UPDATE OF ol")) return { rows: [finalLine] };
      if (text.includes("INSERT INTO oms.order_line_adjustments")) return { rows: [] };
      if (text.includes("LEFT JOIN oms.order_line_adjustments")) return { rows: [finalLine] };
      if (text.includes("FROM wms.order_items wi") && text.includes("FOR UPDATE OF wi")) {
        return { rows: [{
          id: 312850,
          oms_order_line_id: 110466,
          external_line_item_id: "441680952",
          quantity: 25,
          picked_quantity: 0,
          fulfilled_quantity: 0,
          status: "short",
          requires_shipping: true,
        }] };
      }
      if (text.includes("FROM wms.outbound_shipment_items si") && text.includes("FOR UPDATE OF si, os")) return { rows: [] };
      if (text.includes("FROM wms.outbound_shipments os") && text.includes("terminal_provider_sibling")) return { rows: [] };
      throw new Error(`Unexpected SQL in replay test: ${text}`);
    });
    const serviceHelpers = helpers({
      releaseOrderItemReservation: vi.fn(async () => ({ releasedQuantity: 0 })),
    });

    const result = await applyShopifyRefundCascade(
      mock.db,
      refundPayload(),
      serviceHelpers,
      { channelId: 36, sourceInboxId: 75058, now: NOW },
    );

    expect(result.outcome).toBe("idempotent_skip");
    expect(result.releasedReservationQuantity).toBe(0);
    expect(markShipmentCancelled).not.toHaveBeenCalled();
  });

  it("does not touch warehouse state for a money-only refund", async () => {
    const mock = makeDb(() => {
      throw new Error("money-only refund must not query WMS state");
    });
    const serviceHelpers = helpers();

    const result = await applyShopifyRefundCascade(
      mock.db,
      refundPayload({ refund_line_items: [] }),
      serviceHelpers,
      { channelId: 36, now: NOW },
    );

    expect(result.outcome).toBe("financial_only");
    expect(mock.db.execute).not.toHaveBeenCalled();
  });

  it("updates OMS line authority even when no WMS order exists", async () => {
    const mock = makeDb((text) => {
      if (text.includes("FROM wms.orders") && text.includes("ORDER BY id")) return { rows: [] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM oms.oms_order_lines ol") && text.includes("FOR UPDATE OF ol")) return { rows: [omsLine()] };
      if (text.includes("INSERT INTO oms.order_line_adjustments")) return { rows: [{ id: 1 }] };
      if (text.includes("LEFT JOIN oms.order_line_adjustments")) return { rows: [omsLine({ refund_other_quantity: 25 })] };
      if (text.includes("UPDATE oms.oms_order_lines")) return { rows: [] };
      throw new Error(`Unexpected SQL in missing WMS test: ${text}`);
    });

    const result = await applyShopifyRefundCascade(
      mock.db,
      refundPayload(),
      helpers(),
      { channelId: 36, now: NOW },
    );

    expect(result.outcome).toBe("wms_order_not_found");
    expect(recordAuthorityEvent).toHaveBeenCalledOnce();
  });

  it("fails closed when a shippable refunded OMS line has no WMS item mapping", async () => {
    const mock = makeDb((text) => {
      if (text.includes("FROM wms.orders") && text.includes("ORDER BY id")) return { rows: [{ id: 42 }] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM oms.oms_order_lines ol") && text.includes("FOR UPDATE OF ol")) return { rows: [omsLine()] };
      if (text.includes("INSERT INTO oms.order_line_adjustments")) return { rows: [{ id: 1 }] };
      if (text.includes("LEFT JOIN oms.order_line_adjustments")) return { rows: [omsLine({ refund_other_quantity: 25 })] };
      if (text.includes("UPDATE oms.oms_order_lines")) return { rows: [] };
      if (text.includes("FROM wms.order_items wi") && text.includes("FOR UPDATE OF wi")) return { rows: [] };
      throw new Error(`Unexpected SQL in missing WMS line test: ${text}`);
    });

    await expect(applyShopifyRefundCascade(
      mock.db,
      refundPayload(),
      helpers(),
      { channelId: 36, now: NOW },
    )).rejects.toThrow("missing shippable refund line(s): 441680952");
  });

  it("returns order_not_tracked without local writes", async () => {
    const mock = makeDb(() => {
      throw new Error("untracked refund must not query local state");
    });
    const result = await applyShopifyRefundCascade(
      mock.db,
      refundPayload(),
      helpers({ resolveOmsOrder: vi.fn(async () => null) }),
      { channelId: 36, now: NOW },
    );
    expect(result.outcome).toBe("order_not_tracked");
    expect(mock.db.execute).not.toHaveBeenCalled();
  });

  it.each([
    [null, "missing or not an object"],
    [{ order_id: 1 }, "missing `id`"],
    [{ id: 1 }, "missing `order_id`"],
    [{ id: 1, order_id: 2, refund_line_items: [{ line_item_id: 3, quantity: 0 }] }, "positive integer"],
  ])("rejects malformed payload %#", async (payload, expectedMessage) => {
    const mock = makeDb(() => ({ rows: [] }));
    await expect(applyShopifyRefundCascade(
      mock.db,
      payload,
      helpers(),
      { channelId: 36, now: NOW },
    )).rejects.toMatchObject<RefundsCreateBadPayloadError>({
      name: "RefundsCreateBadPayloadError",
      message: expect.stringContaining(expectedMessage),
    });
  });
});

const OMS_WEBHOOKS_SRC = readFileSync(resolve(__dirname, "../../oms-webhooks.ts"), "utf8");

describe("refunds/create financial idempotency", () => {
  it("guards the financial increment with a refund-id event marker", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(
      /event_type = 'refunded'[\s\S]{0,120}details->>'refundId' = \$\{String\(refundPayload\.id\)\}/,
    );
    expect(OMS_WEBHOOKS_SRC).toContain("refundAlreadyApplied");
  });

  it("commits the financial increment and marker under one order lock", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(
      /await db\.transaction\(async \(tx: any\) => \{[\s\S]*?pg_advisory_xact_lock\(918411[\s\S]*?refund_amount_cents = COALESCE\(refund_amount_cents, 0\) \+ \$\{thisRefundCents\}[\s\S]*?eventType: "refunded"[\s\S]*?\}\);/,
    );
  });
});
