import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuthorityEvent: vi.fn(async () => undefined),
  recordCleanupAudit: vi.fn(async () => undefined),
  markShipmentCancelled: vi.fn(async () => ({ wmsOrderId: 204464, changed: true })),
  recomputeOrderStatusFromShipments: vi.fn(async () => undefined),
}));
const {
  recordAuthorityEvent,
  recordCleanupAudit,
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

vi.mock("../../../wms/oms-wms-authority-cleanup-audit.repository", () => ({
  recordOmsWmsAuthorityCleanupAudit: mocks.recordCleanupAudit,
}));

import {
  applyShopifyRefundCascade,
  reconcilePersistedShopifyRefundAuthority,
  RefundsCreateBadPayloadError,
  __test__ as refundCascadeTest,
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
    reconcileRefundOrderDemand: vi.fn(async () => ({ releasedReservationQuantity: 25 })),
    pushShipment: vi.fn(async () => undefined),
    shippingEngine: { cancel: vi.fn(async () => undefined) },
    ...overrides,
  } as any;
}

describe("refund-event reservation release calculation", () => {
  it("does not release outbound reservation for fulfilled units being returned", () => {
    const quantity = refundCascadeTest.deriveRefundEventReservationReleaseQuantity({
      line: omsLine({
        paid_quantity: 1,
        refund_other_quantity: 1,
      }),
      adjustment: {
        externalLineItemId: "441680952",
        quantity: 1,
        restockPolicy: "return",
        raw: {},
      },
      pickedQuantity: 1,
      fulfilledQuantity: 1,
    });

    expect(quantity).toBe(0);
  });

  it("does not double-release a quantity already removed by cancellation authority", () => {
    const quantity = refundCascadeTest.deriveRefundEventReservationReleaseQuantity({
      line: omsLine({
        paid_quantity: 1,
        cancelled_quantity: 1,
        refund_cancel_quantity: 1,
      }),
      adjustment: {
        externalLineItemId: "441680952",
        quantity: 1,
        restockPolicy: "cancel",
        raw: {},
      },
      pickedQuantity: 0,
      fulfilledQuantity: 0,
    });

    expect(quantity).toBe(0);
  });

  it("caps release at paid quantity not already consumed by physical progress", () => {
    const quantity = refundCascadeTest.deriveRefundEventReservationReleaseQuantity({
      line: omsLine({
        paid_quantity: 5,
        refund_other_quantity: 5,
      }),
      adjustment: {
        externalLineItemId: "441680952",
        quantity: 5,
        restockPolicy: "no_restock",
        raw: {},
      },
      pickedQuantity: 2,
      fulfilledQuantity: 0,
    });

    expect(quantity).toBe(3);
  });
});

describe("applyShopifyRefundCascade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    markShipmentCancelled.mockResolvedValue({ wmsOrderId: 204464, changed: true });
  });

  it("does not invoke inventory reservation release for a non-catalog line", async () => {
    const originalLine = omsLine({
      channel_observed_quantity: 1,
      paid_quantity: 1,
      authority_fulfillable_quantity: 1,
    });
    const finalLine = omsLine({
      channel_observed_quantity: 1,
      paid_quantity: 1,
      authority_fulfillable_quantity: 0,
      refunded_quantity: 1,
      authorization_status: "refunded",
      refund_other_quantity: 1,
    });
    const mock = makeDb((text) => {
      if (text.includes("FROM wms.orders") && text.includes("ORDER BY id")) return { rows: [{ id: 42 }] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM oms.oms_order_lines ol") && text.includes("FOR UPDATE OF ol")) return { rows: [originalLine] };
      if (text.includes("INSERT INTO oms.order_line_adjustments")) return { rows: [{ id: 1 }] };
      if (text.includes("LEFT JOIN oms.order_line_adjustments")) return { rows: [finalLine] };
      if (text.includes("UPDATE oms.oms_order_lines")) return { rows: [] };
      if (text.includes("FROM wms.order_items wi") && text.includes("FOR UPDATE OF wi")) {
        return { rows: [{
          id: 700,
          oms_order_line_id: 110466,
          product_id: null,
          external_line_item_id: "441680952",
          quantity: 1,
          picked_quantity: 0,
          fulfilled_quantity: 0,
          status: "pending",
          requires_shipping: true,
        }] };
      }
      if (text.includes("UPDATE wms.order_items")) return { rows: [] };
      if (text.includes("UPDATE wms.orders o")) return { rows: [] };
      if (text.includes("wms_materialized_quantity = COALESCE(materialized.quantity, 0)")) return { rows: [] };
      if (text.includes("FROM wms.outbound_shipment_items si") && text.includes("FOR UPDATE OF si, os")) return { rows: [] };
      if (text.includes("FROM wms.outbound_shipments os") && text.includes("terminal_provider_sibling")) return { rows: [] };
      throw new Error(`Unexpected SQL in non-catalog refund test: ${text}`);
    });
    const serviceHelpers = helpers();

    const result = await applyShopifyRefundCascade(
      mock.db,
      refundPayload({
        refund_line_items: [{ line_item_id: 441680952, quantity: 1, restock_type: "no_restock" }],
      }),
      serviceHelpers,
      { channelId: 36, sourceInboxId: 94646, now: NOW },
    );

    expect(result).toMatchObject({
      outcome: "line_dispositions_applied",
      releasedReservationQuantity: 0,
    });
    expect(serviceHelpers.reconcileRefundOrderDemand).not.toHaveBeenCalled();
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
            product_id: 9,
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
    expect(serviceHelpers.reconcileRefundOrderDemand).toHaveBeenCalledTimes(1);
    expect(serviceHelpers.reconcileRefundOrderDemand).toHaveBeenCalledWith({
      orderId: 204464,
      sourceEventId: "1036275548319",
      releaseTargets: [{ orderItemId: 312850, quantity: 25 }],
      reason: "Shopify refund 1036275548319 demand reconciliation",
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
    const counterRefreshIndex = mock.calls.findIndex(
      (text) => text.includes("wms_materialized_quantity = COALESCE(materialized.quantity, 0)"),
    );
    const shipmentReconciliationIndex = mock.calls.findIndex(
      (text) => text.includes("FROM wms.outbound_shipment_items si"),
    );
    expect(counterRefreshIndex).toBeGreaterThanOrEqual(0);
    expect(shipmentReconciliationIndex).toBeGreaterThan(counterRefreshIndex);
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

  it("submits every line from one refund through one grouped demand reconciliation", async () => {
    const secondOriginalLine = omsLine({
      id: 110467,
      external_line_item_id: "441680953",
      channel_observed_quantity: 10,
      paid_quantity: 10,
      authority_fulfillable_quantity: 10,
    });
    const mock = makeDb((text) => {
      if (text.includes("FROM wms.orders") && text.includes("ORDER BY id")) {
        return { rows: [{ id: 204464 }] };
      }
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM oms.oms_order_lines ol") && text.includes("FOR UPDATE OF ol")) {
        return { rows: [omsLine(), secondOriginalLine] };
      }
      if (text.includes("INSERT INTO oms.order_line_adjustments")) {
        return { rows: [{ id: 1026 }, { id: 1027 }] };
      }
      if (text.includes("LEFT JOIN oms.order_line_adjustments")) {
        return { rows: [
          omsLine({ refund_other_quantity: 5 }),
          omsLine({
            ...secondOriginalLine,
            refund_other_quantity: 7,
          }),
        ] };
      }
      if (text.includes("UPDATE oms.oms_order_lines")) return { rows: [] };
      if (text.includes("FROM wms.order_items wi") && text.includes("FOR UPDATE OF wi")) {
        return { rows: [
          {
            id: 312850,
            oms_order_line_id: 110466,
            external_line_item_id: "441680952",
            quantity: 25,
            product_id: 9,
            picked_quantity: 0,
            fulfilled_quantity: 0,
            status: "pending",
            requires_shipping: true,
          },
          {
            id: 312851,
            oms_order_line_id: 110467,
            external_line_item_id: "441680953",
            quantity: 10,
            product_id: 10,
            picked_quantity: 0,
            fulfilled_quantity: 0,
            status: "pending",
            requires_shipping: true,
          },
        ] };
      }
      if (text.includes("UPDATE wms.order_items")) return { rows: [] };
      if (text.includes("UPDATE wms.orders o")) return { rows: [] };
      if (text.includes("wms_materialized_quantity = COALESCE(materialized.quantity, 0)")) {
        return { rows: [] };
      }
      if (text.includes("FROM wms.outbound_shipment_items si") && text.includes("FOR UPDATE OF si, os")) {
        return { rows: [] };
      }
      if (text.includes("FROM wms.outbound_shipments os") && text.includes("terminal_provider_sibling")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in grouped refund test: ${text}`);
    });
    const serviceHelpers = helpers({
      reconcileRefundOrderDemand: vi.fn(async () => ({ releasedReservationQuantity: 12 })),
    });

    const result = await applyShopifyRefundCascade(
      mock.db,
      refundPayload({
        refund_line_items: [
          { line_item_id: 441680952, quantity: 5, restock_type: "no_restock" },
          { line_item_id: 441680953, quantity: 7, restock_type: "no_restock" },
        ],
      }),
      serviceHelpers,
      { channelId: 36, sourceInboxId: 75059, now: NOW },
    );

    expect(result.releasedReservationQuantity).toBe(12);
    expect(serviceHelpers.reconcileRefundOrderDemand).toHaveBeenCalledTimes(1);
    expect(serviceHelpers.reconcileRefundOrderDemand).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 204464,
      sourceEventId: "1036275548319",
      releaseTargets: [
        { orderItemId: 312850, quantity: 5 },
        { orderItemId: 312851, quantity: 7 },
      ],
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
          product_id: 9,
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
      reconcileRefundOrderDemand: vi.fn(async () => ({ releasedReservationQuantity: 0 })),
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
    expect(serviceHelpers.reconcileRefundOrderDemand).not.toHaveBeenCalled();
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
          product_id: 9,
          quantity: 25,
          picked_quantity: 0,
          fulfilled_quantity: 0,
          status: "short",
          requires_shipping: true,
        }] };
      }
      if (text.includes("wms_materialized_quantity = COALESCE(materialized.quantity, 0)")) {
        return { rows: [{ id: 110466 }] };
      }
      if (text.includes("FROM wms.outbound_shipment_items si") && text.includes("FOR UPDATE OF si, os")) return { rows: [] };
      if (text.includes("FROM wms.outbound_shipments os") && text.includes("terminal_provider_sibling")) return { rows: [] };
      throw new Error(`Unexpected SQL in replay test: ${text}`);
    });
    const serviceHelpers = helpers({
      reconcileRefundOrderDemand: vi.fn(async () => ({ releasedReservationQuantity: 0 })),
    });

    const result = await applyShopifyRefundCascade(
      mock.db,
      refundPayload(),
      serviceHelpers,
      { channelId: 36, sourceInboxId: 75058, now: NOW },
    );

    expect(result.outcome).toBe("idempotent_skip");
    expect(result.releasedReservationQuantity).toBe(0);
    expect(serviceHelpers.reconcileRefundOrderDemand).toHaveBeenCalledTimes(1);
    expect(serviceHelpers.reconcileRefundOrderDemand).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 204464,
      sourceEventId: "1036275548319",
      releaseTargets: [{ orderItemId: 312850, quantity: 25 }],
    }));
    expect(markShipmentCancelled).not.toHaveBeenCalled();
    expect(mock.calls.some(
      (text) => text.includes("wms_materialized_quantity = COALESCE(materialized.quantity, 0)"),
    )).toBe(true);
  });

  it("fails closed before shipment reconciliation when the counter refresh fails", async () => {
    const mock = makeDb((text) => {
      if (text.includes("FROM wms.orders") && text.includes("ORDER BY id")) return { rows: [{ id: 42 }] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM oms.oms_order_lines ol") && text.includes("FOR UPDATE OF ol")) {
        return { rows: [omsLine()] };
      }
      if (text.includes("INSERT INTO oms.order_line_adjustments")) return { rows: [{ id: 1 }] };
      if (text.includes("LEFT JOIN oms.order_line_adjustments")) {
        return { rows: [omsLine({ refund_other_quantity: 25 })] };
      }
      if (
        text.includes("UPDATE oms.oms_order_lines") &&
        !text.includes("wms_materialized_quantity = COALESCE(materialized.quantity, 0)")
      ) {
        return { rows: [] };
      }
      if (text.includes("FROM wms.order_items wi") && text.includes("FOR UPDATE OF wi")) {
        return { rows: [{
          id: 501,
          oms_order_line_id: 110466,
          external_line_item_id: "441680952",
          product_id: 9,
          quantity: 25,
          picked_quantity: 0,
          fulfilled_quantity: 0,
          status: "pending",
          requires_shipping: true,
        }] };
      }
      if (text.includes("UPDATE wms.order_items")) return { rows: [] };
      if (text.includes("UPDATE wms.orders o")) return { rows: [] };
      if (text.includes("wms_materialized_quantity = COALESCE(materialized.quantity, 0)")) {
        throw new Error("counter refresh failed");
      }
      throw new Error(`Unexpected SQL in counter failure test: ${text}`);
    });

    await expect(applyShopifyRefundCascade(
      mock.db,
      refundPayload(),
      helpers(),
      { channelId: 36, now: NOW },
    )).rejects.toThrow("counter refresh failed");

    expect(mock.calls.some(
      (text) => text.includes("FROM wms.outbound_shipment_items si"),
    )).toBe(false);
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

describe("reconcilePersistedShopifyRefundAuthority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("audits and applies a persisted refund fact without replaying operational side effects", async () => {
    const mutationOrder: string[] = [];
    recordCleanupAudit.mockImplementationOnce(async () => {
      mutationOrder.push("audit");
    });
    const mock = makeDb((text) => {
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM oms.order_line_adjustments") && text.includes("source_event_id")) {
        return {
          rows: [{
            external_line_item_id: "441680952",
            quantity: 5,
            restock_policy: "no_restock",
          }],
        };
      }
      if (text.includes("FROM oms.oms_order_lines ol") && text.includes("FOR UPDATE OF ol")) {
        return {
          rows: [omsLine({
            channel_observed_quantity: 5,
            paid_quantity: 5,
            authority_fulfillable_quantity: 5,
          })],
        };
      }
      if (text.includes("LEFT JOIN oms.order_line_adjustments")) {
        return {
          rows: [omsLine({
            channel_observed_quantity: 5,
            paid_quantity: 5,
            authority_fulfillable_quantity: 5,
            refund_other_quantity: 5,
          })],
        };
      }
      if (text.includes("UPDATE oms.oms_order_lines")) {
        mutationOrder.push("authority-update");
        return { rows: [] };
      }
      if (text.includes("FROM wms.order_items item") && text.includes("FOR UPDATE OF item")) {
        return {
          rows: [{
            id: 312850,
            oms_order_line_id: 110466,
            external_line_item_id: "441680952",
            product_id: 9,
            quantity: 5,
            picked_quantity: 0,
            fulfilled_quantity: 0,
            status: "cancelled",
            requires_shipping: true,
          }],
        };
      }
      if (text.includes("wms_materialized_quantity = COALESCE(materialized.quantity, 0)")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in persisted refund repair test: ${text}`);
    });

    const result = await reconcilePersistedShopifyRefundAuthority(mock.db, {
      omsOrderId: 242960,
      wmsOrderId: 204464,
      refundExternalId: "1036275548319",
      sourceInboxId: null,
      now: NOW,
      adjustments: [{
        externalLineItemId: "441680952",
        quantity: 5,
        restockPolicy: "no_restock",
        raw: { repair: true },
      }],
      audit: {
        runId: "11111111-1111-4111-8111-111111111111",
        operator: "owner@cardshellz.com",
        reason: "historical persisted refund authority repair",
      },
    });

    expect(result).toEqual({
      authorityChanges: 1,
      wmsLineChanges: 0,
      warnings: [],
    });
    expect(recordCleanupAudit).toHaveBeenCalledWith(
      mock.db,
      expect.objectContaining({
        runId: "11111111-1111-4111-8111-111111111111",
        operation: "historical-refund-authority-repair",
        sourceTable: "oms.oms_order_lines",
        sourceId: 110466,
        action: "update",
        operator: "owner@cardshellz.com",
        createdAt: NOW,
      }),
    );
    expect(mutationOrder[0]).toBe("audit");
    expect(mutationOrder.slice(1)).toEqual([
      "authority-update",
      "authority-update",
    ]);
    expect(mock.calls.some((text) => text.includes("reconcileActiveShipmentItems"))).toBe(false);
    expect(mock.calls.some((text) => text.includes("INSERT INTO wms.returns"))).toBe(false);
    expect(recordAuthorityEvent).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 242960,
      orderLineId: 110466,
      refundedQuantity: 5,
      authority: expect.objectContaining({
        authorityFulfillableQuantity: 0,
        authorizationStatus: "refunded",
      }),
    }));
  });

  it("accepts a canonically restored shipped line without rewriting historical WMS quantities", async () => {
    const mock = makeDb((text) => {
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM oms.order_line_adjustments") && text.includes("source_event_id")) {
        return {
          rows: [{
            external_line_item_id: "441680952",
            quantity: 5,
            restock_policy: "no_restock",
          }],
        };
      }
      if (text.includes("FROM oms.oms_order_lines ol") && text.includes("FOR UPDATE OF ol")) {
        return {
          rows: [omsLine({
            channel_observed_quantity: 5,
            paid_quantity: 5,
            authority_fulfillable_quantity: 5,
          })],
        };
      }
      if (text.includes("LEFT JOIN oms.order_line_adjustments")) {
        return {
          rows: [omsLine({
            channel_observed_quantity: 5,
            paid_quantity: 5,
            authority_fulfillable_quantity: 5,
            refund_other_quantity: 5,
          })],
        };
      }
      if (text.includes("FROM wms.order_items item") && text.includes("FOR UPDATE OF item")) {
        return {
          rows: [{
            id: 312850,
            oms_order_line_id: 110466,
            quantity: 5,
            picked_quantity: 5,
            fulfilled_quantity: 5,
            status: "completed",
          }],
        };
      }
      if (text.includes("UPDATE oms.oms_order_lines")) return { rows: [] };
      if (text.includes("wms_materialized_quantity = COALESCE(materialized.quantity, 0)")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in shipped persisted refund repair test: ${text}`);
    });

    const result = await reconcilePersistedShopifyRefundAuthority(mock.db, {
      omsOrderId: 242960,
      wmsOrderId: 204464,
      refundExternalId: "1036275548319",
      sourceInboxId: null,
      now: NOW,
      adjustments: [{
        externalLineItemId: "441680952",
        quantity: 5,
        restockPolicy: "no_restock",
        raw: { repair: true },
      }],
      audit: {
        runId: "11111111-1111-4111-8111-111111111111",
        operator: "owner@cardshellz.com",
        reason: "historical persisted refund authority repair",
      },
    });

    expect(result).toEqual({
      authorityChanges: 1,
      wmsLineChanges: 0,
      warnings: [],
    });
    expect(mock.calls.some((text) => text.includes("UPDATE wms.order_items"))).toBe(false);
    expect(recordAuthorityEvent).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 242960,
      orderLineId: 110466,
      refundedQuantity: 5,
      authority: expect.objectContaining({
        authorityFulfillableQuantity: 0,
        authorizationStatus: "refunded",
      }),
    }));
  });

  it("fails before mutation when the persisted refund fact differs from repair input", async () => {
    const mock = makeDb((text) => {
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM oms.order_line_adjustments")) {
        return {
          rows: [{
            external_line_item_id: "441680952",
            quantity: 4,
            restock_policy: "no_restock",
          }],
        };
      }
      throw new Error(`Unexpected SQL after persisted mismatch: ${text}`);
    });

    await expect(reconcilePersistedShopifyRefundAuthority(mock.db, {
      omsOrderId: 242960,
      wmsOrderId: 204464,
      refundExternalId: "1036275548319",
      now: NOW,
      adjustments: [{
        externalLineItemId: "441680952",
        quantity: 5,
        restockPolicy: "no_restock",
        raw: {},
      }],
      audit: {
        runId: "11111111-1111-4111-8111-111111111111",
        operator: "owner@cardshellz.com",
        reason: "historical persisted refund authority repair",
      },
    })).rejects.toThrow(/does not match repair input/);

    expect(mock.calls.some((text) => text.includes("UPDATE oms.oms_order_lines"))).toBe(false);
    expect(recordCleanupAudit).not.toHaveBeenCalled();
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
