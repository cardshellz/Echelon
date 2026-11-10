import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  handleCustomerCancelOnShipment,
  markShipmentCancelled,
} from "../../../orders/shipment-rollup";
import { createChannelFulfillmentIngressService } from "../../channel-fulfillment-ingress.service";
import { cancelOrderCascade } from "../../oms-webhooks";
import { createOmsService, recordOmsReconcileReviewEvent } from "../../oms.service";
import { createShipStationService } from "../../shipstation.service";
import { buildShopifyWebhookInboxInput } from "../../webhook-inbox.service";

const REPO_ROOT = resolve(__dirname, "../../../../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function makeReq(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

describe("OMS-1: cancellation terminal-truth guards, intake idempotency, and lookup safeguards", () => {
  describe("FW-01 / FW-B1a & WH-04: shipment cancellation terminal-truth & verdict propagation", () => {
    it("refuses local cancel when provider returns already_shipped and surfaces noop in handleCustomerCancelOnShipment", async () => {
      const queuedRow = {
        id: 701,
        order_id: 88,
        status: "queued",
        tracking_number: null,
        carrier: null,
        service_code: null,
        tracking_url: null,
        carrier_cost_cents: 0,
        carrier_cost_source: null,
        carrier_cost_recorded_at: null,
        shopify_fulfillment_id: null,
        shipped_at: null,
        shipping_engine: "shipstation",
        engine_order_ref: "9001",
        engine_shipment_ref: null,
        shipstation_order_id: 9001,
        shipstation_order_key: "echelon-oms-88",
      };

      const execute = vi
        .fn()
        .mockResolvedValueOnce({ rows: [queuedRow] })
        .mockResolvedValueOnce({ rows: [queuedRow] });

      const removeFromList = vi.fn(async () => ({
        state: "already_shipped" as const,
      }));

      const outcome = await handleCustomerCancelOnShipment(
        { execute },
        701,
        {
          now: new Date("2026-11-10T12:00:00Z"),
          shipstation: { removeFromList },
        },
      );

      expect(outcome).toEqual({ mode: "noop", reason: "already_shipped" });
      expect(removeFromList).toHaveBeenCalledWith(9001);
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("refuses at final conditional UPDATE when shipment transitions to returned/lost during provider I/O", async () => {
      const labeledRow = {
        id: 702,
        order_id: 89,
        status: "labeled",
        tracking_number: "1Z999",
        carrier: "ups",
        service_code: null,
        tracking_url: null,
        carrier_cost_cents: 0,
        carrier_cost_source: null,
        carrier_cost_recorded_at: null,
        shopify_fulfillment_id: null,
        shipped_at: null,
        shipping_engine: "shipstation",
        engine_order_ref: "9002",
        engine_shipment_ref: null,
        shipstation_order_id: 9002,
        shipstation_order_key: "echelon-oms-89",
      };

      const returnedRow = {
        ...labeledRow,
        status: "returned",
        shipped_at: "2026-11-10T11:59:00Z",
      };

      const execute = vi
        .fn()
        .mockResolvedValueOnce({ rows: [labeledRow] })
        .mockResolvedValueOnce({ rows: [] }) // Conditional UPDATE matched 0 rows
        .mockResolvedValueOnce({ rows: [returnedRow] });

      const cancelResult = await markShipmentCancelled(
        { execute },
        702,
        "customer_cancel",
        {
          now: new Date("2026-11-10T12:00:00Z"),
          engineCancel: async () => ({ state: "cancelled" }),
        },
      );

      expect(cancelResult).toEqual({
        wmsOrderId: 89,
        changed: false,
        localOutcome: "refused_already_shipped",
        providerOutcome: "cancelled",
      });
    });

    it("records cancel_cascade_incomplete instead of cancelled when a shipment cancellation throws (WH-04)", async () => {
      const insertedEvents: any[] = [];
      const db = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ id: 500 }] }) // wms.orders lookup
          .mockResolvedValueOnce({ rows: [{ id: 701 }] }) // wms.outbound_shipments lookup
          .mockResolvedValueOnce({ rows: [] }) // loadShipment inside handleCustomerCancelOnShipment -> throws SHIPMENT_NOT_FOUND
          .mockResolvedValueOnce({ rows: [] }), // recomputeOrderStatusFromShipments
        insert: vi.fn(() => ({
          values: vi.fn(async (val: any) => {
            insertedEvents.push(val);
          }),
        })),
      };

      await cancelOrderCascade(db, 999, {
        wmsServices: null,
        shipStationService: null,
        source: "shopify_cancel_webhook",
        reason: "customer",
      });

      expect(insertedEvents).toHaveLength(1);
      expect(insertedEvents[0]).toMatchObject({
        orderId: 999,
        eventType: "cancel_cascade_incomplete",
      });
    });

    it("routes superseded engine shipment cancellation to review when provider reports already_shipped", async () => {
      const now = new Date("2026-11-10T12:00:00Z");
      const completeReceipt = vi.fn().mockResolvedValue(undefined);
      const recordReviewException = vi.fn().mockResolvedValue(undefined);
      const preparedReceipt: any = {
        receiptId: 91,
        omsOrderId: 101,
        terminalReplay: false,
        sourceEcho: false,
        physicalShipmentId: null,
        materializationIdentity: {
          shippingProvider: "shipstation",
          providerPhysicalShipmentId: "442326748",
          providerOrderId: "755417850",
          providerOrderKey: "echelon-wms-shp-501",
          trackingNumber: "1Z999",
          carrier: "UPS",
          trackingUrl: "https://example.test/track/1Z999",
          serviceCode: null,
          shippedAt: now,
        },
        legacyWmsShipmentIds: [501],
        inventoryItems: [],
        cancellationCandidates: [
          {
            wmsShipmentId: 701,
            engine: "shipstation",
            engineOrderRef: "9001",
            engineShipmentRef: null,
          },
        ],
        partialOverlapShipmentIds: [],
      };
      const repository: any = {
        stageReceipt: vi.fn().mockResolvedValue({
          receiptId: 91,
          processingStatus: "pending",
          physicalShipmentId: null,
        }),
        claimReceipt: vi.fn().mockResolvedValue({
          receiptId: 91,
          terminalReplay: false,
          terminalProcessingStatus: null,
          terminalReason: null,
          sourceEcho: false,
          physicalShipmentId: null,
          leaseToken: "lease-1",
          attemptNumber: 1,
        }),
        prepareReceipt: vi.fn().mockResolvedValue(preparedReceipt),
        renewReceiptLease: vi.fn().mockResolvedValue(undefined),
        attachPhysicalShipment: vi.fn().mockResolvedValue(undefined),
        recordTrackingAmendment: vi.fn().mockResolvedValue(undefined),
        completeReceipt,
        failReceiptAttempt: vi.fn().mockResolvedValue({
          processingStatus: "pending",
          retryFailureCount: 1,
          nextRetryAt: new Date("2026-11-10T12:02:00Z"),
        }),
        recordReviewException,
      };

      const authority: any = {
        recordPhysicalPackage: vi.fn().mockResolvedValue({
          shipmentId: 600,
          created: true,
        }),
        projectPhysicalPackage: vi.fn().mockResolvedValue(undefined),
      };

      const service = createChannelFulfillmentIngressService({
        repository,
        authority,
        inventory: { recordShipment: vi.fn() },
        cancelEngineShipment: vi.fn().mockResolvedValue({
          state: "already_shipped",
        }),
        clock: { now: () => now },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const result = await service.process({
        sourceProvider: "shopify",
        sourceChannelId: 36,
        sourceOrderId: "12140180865183",
        sourceFulfillmentId: "6312306376863",
        sourceEventId: "evt-1",
        sourceInboxId: 70825,
        eventKind: "created",
        source: "shopify_fulfillments_create",
        trackingNumber: "1Z999",
        carrier: "UPS",
        trackingUrl: "https://example.test/track/1Z999",
        shippedAt: now,
        correlationId: "corr-1",
        causationId: "evt-1",
        rawPayload: { id: 6312306376863 },
        lineItems: [{ channelOrderLineId: "gid://shopify/LineItem/1", quantity: 1 }],
      });

      expect(result.processingStatus).toBe("review");
      expect(result.cancellationFailures).toBe(1);
      expect(recordReviewException).toHaveBeenCalledTimes(1);
    });
  });

  describe("FUL-03: ShipStation getOrderByKey validated complete absence and pagination", () => {
    it("paginates through multiple ShipStation pages to find an exact orderKey match", async () => {
      const fetchCalls: string[] = [];
      const originalFetch = globalThis.fetch;
      const prevKey = process.env.SHIPSTATION_API_KEY;
      const prevSecret = process.env.SHIPSTATION_API_SECRET;
      process.env.SHIPSTATION_API_KEY = "test-key";
      process.env.SHIPSTATION_API_SECRET = "test-secret";

      globalThis.fetch = vi.fn(async (url: any) => {
        const urlStr = String(url);
        fetchCalls.push(urlStr);
        if (urlStr.includes("page=2")) {
          const payload = {
            orders: [{ orderId: 222, orderKey: "echelon-wms-shipment-502" }],
            page: 2,
            pages: 2,
          };
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => payload,
            text: async () => JSON.stringify(payload),
          } as any;
        }
        const payload = {
          orders: [{ orderId: 111, orderKey: "echelon-wms-shipment-501" }],
          page: 1,
          pages: 2,
        };
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => payload,
          text: async () => JSON.stringify(payload),
        } as any;
      });

      try {
        const svc = createShipStationService({} as any);
        const match = await svc.getOrderByKey("echelon-wms-shipment-502", "#1002");
        expect(match).toEqual({
          orderId: 222,
          orderKey: "echelon-wms-shipment-502",
        });
        expect(fetchCalls).toHaveLength(2);
      } finally {
        globalThis.fetch = originalFetch;
        process.env.SHIPSTATION_API_KEY = prevKey;
        process.env.SHIPSTATION_API_SECRET = prevSecret;
      }
    });

    it("throws ShipStationPushError instead of returning null when orders array is malformed", async () => {
      const originalFetch = globalThis.fetch;
      const prevKey = process.env.SHIPSTATION_API_KEY;
      const prevSecret = process.env.SHIPSTATION_API_SECRET;
      process.env.SHIPSTATION_API_KEY = "test-key";
      process.env.SHIPSTATION_API_SECRET = "test-secret";

      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ malformed: true }),
        text: async () => JSON.stringify({ malformed: true }),
      })) as any;

      try {
        const svc = createShipStationService({} as any);
        await expect(
          svc.getOrderByKey("echelon-wms-shipment-502", "#1002"),
        ).rejects.toThrow(/malformed orders response/);
      } finally {
        globalThis.fetch = originalFetch;
        process.env.SHIPSTATION_API_KEY = prevKey;
        process.env.SHIPSTATION_API_SECRET = prevSecret;
      }
    });
  });

  describe("WH-03: Shopify webhook inbox fallback identity on mutable topics", () => {
    it("produces distinct fallback eventIds for distinct orders/updated payloads on the same order when x-shopify-webhook-id is absent", () => {
      const first = buildShopifyWebhookInboxInput(
        makeReq({ "x-shopify-shop-domain": "shellz.myshopify.com" }),
        "orders/updated",
        { id: 55501, financial_status: "paid", updated_at: "2026-11-10T10:00:00Z" },
      );
      const second = buildShopifyWebhookInboxInput(
        makeReq({ "x-shopify-shop-domain": "shellz.myshopify.com" }),
        "orders/updated",
        { id: 55501, financial_status: "partially_refunded", updated_at: "2026-11-10T10:05:00Z" },
      );
      const duplicateFirst = buildShopifyWebhookInboxInput(
        makeReq({ "x-shopify-shop-domain": "shellz.myshopify.com" }),
        "orders/updated",
        { updated_at: "2026-11-10T10:00:00Z", financial_status: "paid", id: 55501 },
      );

      expect(first.eventId).toMatch(/^55501:payload:[0-9a-f]{64}$/);
      expect(second.eventId).toMatch(/^55501:payload:[0-9a-f]{64}$/);
      expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
      expect(duplicateFirst.idempotencyKey).toBe(first.idempotencyKey);
    });
  });

  describe("OMS status guards and oms.oms_order_events writer ratchet shrink", () => {
    it("prevents assignWarehouse from overwriting terminal OMS statuses and skips event insertion when no row updated", async () => {
      const insert = vi.fn();
      const db = {
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn(async () => []),
            })),
          })),
        })),
        insert,
      };

      const svc = createOmsService(db);
      await svc.assignWarehouse(101, 1);
      expect(insert).not.toHaveBeenCalled();
    });

    it("delegates reconcile review event writes to recordOmsReconcileReviewEvent and removes server/index.ts from oms.oms_order_events baseline", async () => {
      const execute = vi.fn().mockResolvedValue({ rows: [] });
      await recordOmsReconcileReviewEvent(
        { execute },
        321,
        "engine_order_not_found",
        { wmsShipmentId: 99, engineOrderRef: "SS-99" },
      );
      expect(execute).toHaveBeenCalledTimes(1);

      const serverIndexSrc = readRepoFile("server/index.ts");
      expect(serverIndexSrc).not.toContain("INSERT INTO oms.oms_order_events");

      const baseline = JSON.parse(readRepoFile("scripts/writer-ratchet/baseline.json"));
      expect(baseline["oms.oms_order_events"]).toEqual(["modules/oms"]);
    });
  });
});
