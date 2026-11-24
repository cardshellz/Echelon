import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createShipStationEngine } from "../../adapters/shipstation.adapter";
import { serializeShipmentPushPayloadToShipStationOrder } from "../../adapters/shipstation/shipstation-push-serializer";
import { mapShipStationShipmentToCanonicalEvent } from "../../adapters/shipstation/shipstation-webhook-normalizer";
import { createShipStationService } from "../../../oms/application/shipstation.service";
import {
  assembleShipmentPushPayload,
  canonicalShipmentEventToRollupEvent,
} from "../../../orders/shipment-rollup-and-context.api";
import type { ShipmentPushPayload } from "../../domain/types";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8").replace(/\r\n/g, "\n");
}

function makeHydratedPayload(
  overrides: Partial<ShipmentPushPayload> = {},
): ShipmentPushPayload {
  return {
    shipmentId: 42,
    orderId: 500,
    orderNumber: "61234",
    channelId: 67,
    warehouseId: 1,
    customer: {
      name: "Ada Lovelace",
      email: "ada@example.com",
    },
    shippingAddress: {
      name: "Ada Lovelace",
      company: "Analytical Engines",
      street1: "123 Analytical Way",
      street2: "Suite 2",
      city: "Nashville",
      state: "TN",
      postalCode: "37201",
      country: "US",
    },
    financials: {
      amountPaidCents: 2599,
      taxCents: 200,
      shippingCents: 399,
      discountCents: 0,
      totalCents: 2599,
      nonShippingTotalCents: 2200,
      currency: "USD",
    },
    items: [
      {
        itemId: 101,
        shipmentItemId: 11,
        sku: "TL-100",
        name: "35pt Toploader",
        quantity: 2,
        unitPriceCents: 1000,
      },
    ],
    orderPlacedAt: "2026-07-15T12:00:00.000Z",
    externalOrderId: "22-11111-22222",
    sortRank: "0100",
    isPartialShipment: false,
    fulfillmentOrderId: "777",
    onHold: true,
    ...overrides,
  };
}

describe("Batch R-3: Real Shipping Engine Port Completion (P3.3)", () => {
  it("routes hydrated ShipmentPushPayload through upsertShipmentFromPayload instead of pushShipment(shipmentId)", async () => {
    const pushShipment = vi.fn();
    const upsertShipmentFromPayload = vi.fn().mockResolvedValue({
      shipstationOrderId: 9001,
      orderKey: "echelon-wms-shp-42",
      alreadyExisted: false,
    });

    const engine = createShipStationEngine({
      isConfigured: () => true,
      pushShipment,
      upsertShipmentFromPayload,
      appendShipmentItems: vi.fn(),
      setShipmentItemQuantity: vi.fn(),
      cancelOrder: vi.fn(),
      putOrderOnHold: vi.fn(),
      releaseOrderFromHold: vi.fn(),
      markAsShipped: vi.fn(),
      updateSortRank: vi.fn(),
      updateSortRankSingle: vi.fn(),
      getOrderById: vi.fn(),
      getShipments: vi.fn(),
      observeProviderLabels: vi.fn(),
      processShipNotify: vi.fn(),
      registerWebhook: vi.fn(),
    });

    const payload = makeHydratedPayload();
    const result = await engine.upsertShipment(payload);

    expect(upsertShipmentFromPayload).toHaveBeenCalledTimes(1);
    expect(upsertShipmentFromPayload).toHaveBeenCalledWith(payload);
    expect(pushShipment).not.toHaveBeenCalled();
    expect(result).toEqual({
      engineRef: {
        engine: "shipstation",
        engineOrderRef: "9001",
        engineShipmentRef: "echelon-wms-shp-42",
      },
      alreadyExisted: false,
    });
  });

  it("serializes ShipmentPushPayload directly into ShipStation /orders/createorder wire format without DB reads", () => {
    const payload = makeHydratedPayload();
    const serialized = serializeShipmentPushPayloadToShipStationOrder(payload, {
      routing: { storeId: 319989, warehouseId: 996884 },
      packInstruction: "BOX: B-2",
    });

    expect(serialized.orderKey).toBe("echelon-wms-shp-42");
    expect(serialized.orderNumber).toBe("EB-61234");
    expect(serialized.body).toMatchObject({
      orderNumber: "EB-61234",
      orderKey: "echelon-wms-shp-42",
      orderStatus: "on_hold",
      customerEmail: "ada@example.com",
      amountPaid: 25.99,
      taxAmount: 2,
      shippingAmount: 3.99,
      items: [
        {
          lineItemKey: "wms-item-11",
          sku: "TL-100",
          name: "35pt Toploader",
          quantity: 2,
          unitPrice: 10,
        },
      ],
      advancedOptions: {
        storeId: 319989,
        warehouseId: 996884,
        source: "echelon-wms",
        customField1: "0100",
        customField2: "wms_order_id:500|shipment_id:42",
        customField3: "oms_order_id:777",
      },
    });
  });

  it("executes upsertShipmentFromPayload against ShipStation HTTP API without re-selecting wms.orders or wms.outbound_shipment_items", async () => {
    const prevKey = process.env.SHIPSTATION_API_KEY;
    const prevSecret = process.env.SHIPSTATION_API_SECRET;
    const prevFetch = globalThis.fetch;
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";

    const executedSql: string[] = [];
    const selectMock = vi.fn(() => {
      throw new Error("Unexpected Drizzle db.select() during payload-driven upsertShipmentFromPayload");
    });
    const mockDb = {
      select: selectMock,
      execute: vi.fn(async (query: any) => {
        const sqlText = JSON.stringify(query);
        executedSql.push(sqlText);
        if (sqlText.includes("oms.oms_orders")) {
          return { rows: [{ status: "processing", fulfillment_status: "unfulfilled", financial_status: "paid" }] };
        }
        return { rows: [] };
      }),
      transaction: vi.fn(async (fn: any) => {
        const tx = {
          execute: vi.fn(async (q: any) => {
            const txt = JSON.stringify(q);
            if (txt.includes("wms.outbound_shipments") && txt.includes("RETURNING")) {
              return { rows: [{ id: 42 }] };
            }
            return { rows: [] };
          }),
        };
        return fn(tx);
      }),
    };

    const postedBodies: any[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/orders?orderNumber=")) {
        return new Response(JSON.stringify({ orders: [], page: 1, pages: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/orders/createorder")) {
        postedBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ orderId: 98765, orderKey: "echelon-wms-shp-42" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as any;

    try {
      const ss = createShipStationService(mockDb, undefined, {
        sessionLock: async (_spec, fn) => fn(),
      });
      const res = await ss.upsertShipmentFromPayload(makeHydratedPayload());

      expect(res).toEqual({
        shipstationOrderId: 98765,
        orderKey: "echelon-wms-shp-42",
        alreadyExisted: false,
      });
      expect(selectMock).not.toHaveBeenCalled();
      expect(postedBodies).toHaveLength(1);
      expect(postedBodies[0]).toMatchObject({
        orderNumber: "EB-61234",
        orderKey: "echelon-wms-shp-42",
        items: [{ lineItemKey: "wms-item-11", sku: "TL-100", quantity: 2, unitPrice: 10 }],
      });
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.SHIPSTATION_API_KEY;
      else process.env.SHIPSTATION_API_KEY = prevKey;
      if (prevSecret === undefined) delete process.env.SHIPSTATION_API_SECRET;
      else process.env.SHIPSTATION_API_SECRET = prevSecret;
    }
  });

  it("enforces WMS-owned pre-push guards for edit holds, cancelled orders, empty items, and voided re-pushes", async () => {
    const editHoldDb = {
      execute: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            shipment_id: 42,
            order_id: 500,
            wms_order_id: 500,
            shipment_status: "planned",
            held: false,
            requires_review: false,
            order_edit_operation_id: "op-123",
          },
        ],
      }),
    };
    await expect(assembleShipmentPushPayload(editHoldDb, 42)).rejects.toMatchObject({
      code: "ORDER_EDIT_PROVIDER_HELD",
    });

    const cancelledOrderDb = {
      execute: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            shipment_id: 42,
            order_id: 500,
            wms_order_id: 500,
            shipment_status: "planned",
            held: false,
            requires_review: false,
            warehouse_status: "cancelled",
          },
        ],
      }),
    };
    await expect(assembleShipmentPushPayload(cancelledOrderDb, 42)).rejects.toMatchObject({
      guardCode: "SHIPMENT_ORDER_CANCELLED",
    });

    const emptyItemsDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              shipment_id: 42,
              order_id: 500,
              wms_order_id: 500,
              shipment_status: "voided",
              held: false,
              requires_review: false,
              warehouse_status: "ready",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };
    await expect(assembleShipmentPushPayload(emptyItemsDb, 42)).rejects.toMatchObject({
      guardCode: "SHIPMENT_EMPTY_ITEMS",
    });
  });

  it("preserves voided trackingNumber through CanonicalShipmentEvent normalization and rollup conversion", () => {
    const voidedEvent = mapShipStationShipmentToCanonicalEvent(
      {
        shipmentId: 777,
        orderId: 9001,
        orderKey: "echelon-wms-shp-42",
        trackingNumber: "9400111899223456789012",
        voidDate: "2026-07-16T01:02:03.000Z",
      },
      { resolveWmsShipmentIdFromOrderKey: true },
    );

    expect(voidedEvent).toEqual({
      kind: "voided",
      shipmentId: 42,
      engineRef: {
        engine: "shipstation",
        engineOrderRef: "9001",
        engineShipmentRef: "echelon-wms-shp-42",
      },
      reason: "voided in ShipStation",
      trackingNumber: "9400111899223456789012",
    });

    const rollup = canonicalShipmentEventToRollupEvent(voidedEvent!);
    expect(rollup).toEqual({
      kind: "voided",
      reason: "voided in ShipStation",
      trackingNumber: "9400111899223456789012",
    });
  });

  it("places vendor HTTP client, push serializer, and webhook normalizer under shipping/adapters/shipstation and wires neutral topics", () => {
    for (const rel of [
      "server/modules/shipping/adapters/shipstation/shipstation-http.client.ts",
      "server/modules/shipping/adapters/shipstation/shipstation-push-serializer.ts",
      "server/modules/shipping/adapters/shipstation/shipstation-webhook-normalizer.ts",
      "server/modules/shipping/shipstation-http-client.api.ts",
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), rel).toBe(true);
    }

    const omsRoutesSrc = readRepoFile("server/routes/oms.routes.ts");
    expect(omsRoutesSrc).toContain("pushShipmentThroughEngine(db, engine, shipmentId)");
    expect(omsRoutesSrc).toContain(
      "pushShipmentThroughEngine(db, engine, shipmentId, { overrideReview })",
    );

    const retryWorkerSrc = readRepoFile("server/modules/oms/application/webhook-retry.worker.ts");
    expect(retryWorkerSrc).toContain("shipping_engine_shipment_push");
    expect(retryWorkerSrc).toContain("shipping_engine_hold_sync");
    expect(retryWorkerSrc).toContain("shipping_engine_sort_rank_sync");
    expect(retryWorkerSrc).toContain("shipping_engine_push_retry_exhausted");
  });
});
