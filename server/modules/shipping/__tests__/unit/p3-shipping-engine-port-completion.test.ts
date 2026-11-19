import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createShipStationEngine,
  engineRefFromRow,
  getEngineRefResolutionMetrics,
  normalizeShipStationWebhookPayload,
  resetEngineRefResolutionMetricsForTest,
  type ShipStationServiceHandle,
} from "../../adapters/shipstation.adapter";
import {
  applyCanonicalShipmentEvent,
  assembleShipmentPushPayload,
  canonicalShipmentEventToRollupEvent,
  pushShipmentThroughEngine,
  ShipmentPushGuardError,
} from "../../../orders/shipment-rollup-and-context.api";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

function readSrc(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

function collectRuntimeTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectRuntimeTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

function makeMockSsService(
  overrides: Partial<ShipStationServiceHandle> = {},
): ShipStationServiceHandle {
  return {
    isConfigured: vi.fn().mockReturnValue(true),
    pushShipment: vi.fn().mockResolvedValue({
      shipstationOrderId: 9001,
      orderKey: "echelon-wms-shp-42",
    }),
    appendShipmentItems: vi.fn().mockResolvedValue({
      state: "applied",
      providerStatus: "awaiting_shipment",
    }),
    setShipmentItemQuantity: vi.fn().mockResolvedValue({
      state: "applied",
      providerStatus: "awaiting_shipment",
    }),
    cancelOrder: vi.fn().mockResolvedValue({
      alreadyInState: false,
      state: "cancelled",
    }),
    putOrderOnHold: vi.fn().mockResolvedValue(undefined),
    releaseOrderFromHold: vi.fn().mockResolvedValue(undefined),
    markAsShipped: vi.fn().mockResolvedValue({ alreadyInState: false }),
    updateSortRank: vi.fn().mockResolvedValue({ touched: 1 }),
    updateSortRankSingle: vi.fn().mockResolvedValue(undefined),
    getOrderById: vi.fn().mockResolvedValue(null),
    getShipments: vi.fn().mockResolvedValue([]),
    observeProviderLabels: vi.fn().mockResolvedValue(undefined),
    processShipNotify: vi.fn().mockResolvedValue(1),
    registerWebhook: vi.fn().mockResolvedValue(undefined),
    synchronizeOrderEditShipment: vi.fn().mockResolvedValue(undefined),
    syncWmsOrderShipStationShipToAddress: vi
      .fn()
      .mockResolvedValue({ updated: 1, skipped: 0 }),
    ...overrides,
  };
}

describe("P3.3 ShippingEngine Port Completion", () => {
  beforeEach(() => {
    resetEngineRefResolutionMetricsForTest();
  });

  describe("1. ShipStationEngine.normalizeWebhook", () => {
    it("normalizes shipped, voided, and label_created ShipStation shipment payloads with WMS shipmentId resolution", async () => {
      const engine = createShipStationEngine(makeMockSsService());

      const events = await engine.normalizeWebhook({
        shipments: [
          {
            shipmentId: 777001,
            orderId: 9001,
            orderKey: "echelon-wms-shp-42",
            trackingNumber: "9400111899223456789012",
            carrierCode: "stamps_com",
            serviceCode: "usps_ground_advantage",
            shipDate: "2026-07-15",
            voidDate: null,
            shipmentCost: "6.45",
            shipmentItems: [{ sku: "TL-100", quantity: 2, name: "Toploader" }],
          },
          {
            shipmentId: 777002,
            orderId: 9002,
            orderKey: "echelon-wms-shp-43",
            trackingNumber: "1Z999AA10123456784",
            carrierCode: "ups",
            shipDate: null,
            voided: true,
          },
          {
            shipmentId: 777003,
            orderId: 9003,
            orderKey: "echelon-wms-shp-44",
            trackingNumber: "794644790132",
            carrierCode: "fedex",
            shipDate: null,
            voidDate: null,
          },
        ],
      });

      expect(events).toHaveLength(3);

      expect(events[0]).toMatchObject({
        kind: "shipped",
        shipmentId: 42,
        engineRef: {
          engine: "shipstation",
          engineOrderRef: "9001",
          engineShipmentRef: "echelon-wms-shp-42",
        },
        trackingNumber: "9400111899223456789012",
        carrier: "USPS",
        carrierRaw: "stamps_com",
        shipDate: null,
        shipCalendarDate: "2026-07-15",
        serviceCode: "usps_ground_advantage",
        carrierCostCents: 645,
        carrierCostSource: "shipstation_shipments_api",
        items: [{ sku: "TL-100", quantity: 2, name: "Toploader" }],
      });

      expect(events[1]).toMatchObject({
        kind: "voided",
        shipmentId: 43,
        engineRef: {
          engine: "shipstation",
          engineOrderRef: "9002",
          engineShipmentRef: "echelon-wms-shp-43",
        },
      });

      expect(events[2]).toMatchObject({
        kind: "label_created",
        shipmentId: 44,
        trackingNumber: "794644790132",
        carrier: "FEDEX",
      });
    });

    it("returns an empty array for bare resource_url notification envelopes", () => {
      expect(
        normalizeShipStationWebhookPayload({
          resource_type: "SHIP_NOTIFY",
          resource_url: "https://ssapi.shipstation.com/shipments?batchId=123",
        }),
      ).toEqual([]);
    });

    it("delegates synchronizeOrderEditShipment and syncOrderShipToAddress through ShippingEngine", async () => {
      const ss = makeMockSsService();
      const engine = createShipStationEngine(ss);

      await engine.synchronizeOrderEditShipment!({
        shipmentId: 42,
        operationId: "11111111-1111-4111-8111-111111111111",
        mode: "hold",
      });
      expect(ss.synchronizeOrderEditShipment).toHaveBeenCalledWith({
        shipmentId: 42,
        operationId: "11111111-1111-4111-8111-111111111111",
        mode: "hold",
      });

      const syncRes = await engine.syncOrderShipToAddress!(501);
      expect(ss.syncWmsOrderShipStationShipToAddress).toHaveBeenCalledWith(501);
      expect(syncRes).toEqual({ updated: 1, skipped: 0 });
    });
  });

  describe("2. D4 engineRefFromRow soak telemetry", () => {
    it("counts canonical hits, legacy fallback hits, and unresolved rows accurately", () => {
      expect(getEngineRefResolutionMetrics()).toEqual({
        canonicalHits: 0,
        legacyFallbackHits: 0,
        unresolvedHits: 0,
        lastLegacyFallbackAt: null,
      });

      engineRefFromRow({
        shipping_engine: "shipstation",
        engine_order_ref: "9001",
        engine_shipment_ref: "echelon-wms-shp-42",
      });
      engineRefFromRow({
        shipstation_order_id: 9002,
        shipstation_order_key: "echelon-wms-shp-43",
      });
      engineRefFromRow({});

      const metrics = getEngineRefResolutionMetrics();
      expect(metrics.canonicalHits).toBe(1);
      expect(metrics.legacyFallbackHits).toBe(1);
      expect(metrics.unresolvedHits).toBe(1);
      expect(metrics.lastLegacyFallbackAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("exposes engineRefResolution on GET /api/sync/status", () => {
      const syncControlSrc = readSrc(
        "server/modules/channels/sync-control.routes.ts",
      );
      expect(syncControlSrc).toContain("getEngineRefResolutionMetrics");
      expect(syncControlSrc).toContain(
        "engineRefResolution: getEngineRefResolutionMetrics()",
      );
    });
  });

  describe("3. Unified CanonicalShipmentEvent & applyCanonicalShipmentEvent", () => {
    it("maps calendar-date shipped events and ignores observational label_created events", () => {
      const labelMapped = canonicalShipmentEventToRollupEvent({
        kind: "label_created",
        shipmentId: 44,
        engineRef: { engine: "shipstation", engineOrderRef: "9003" },
        trackingNumber: "794644790132",
        carrier: "FEDEX",
      });
      expect(labelMapped).toBeNull();

      const shippedMapped = canonicalShipmentEventToRollupEvent({
        kind: "shipped",
        shipmentId: 42,
        engineRef: { engine: "shipstation", engineOrderRef: "9001" },
        trackingNumber: "9400111899223456789012",
        carrier: "USPS",
        carrierRaw: "stamps_com",
        shipDate: null,
        shipCalendarDate: "2026-07-15",
        carrierCostCents: 645,
        carrierCostSource: "shipstation_shipments_api",
      });
      expect(shippedMapped).toMatchObject({
        kind: "shipped",
        trackingNumber: "9400111899223456789012",
        carrier: "USPS",
        carrierCostCents: 645,
        carrierCostSource: "shipstation_shipments_api",
      });
      if (shippedMapped?.kind === "shipped") {
        expect(shippedMapped.shipDate.toISOString()).toBe(
          "2026-07-15T00:00:00.000Z",
        );
      }
    });

    it("treats label_created as an idempotent no-op in applyCanonicalShipmentEvent after verifying shipment existence", async () => {
      const mockDb = {
        execute: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              id: 44,
              order_id: 500,
              status: "queued",
              tracking_number: null,
              carrier: null,
            },
          ],
        }),
      };

      const res = await applyCanonicalShipmentEvent(mockDb, {
        kind: "label_created",
        shipmentId: 44,
        engineRef: { engine: "shipstation", engineOrderRef: "9003" },
        trackingNumber: "794644790132",
        carrier: "FEDEX",
      });

      expect(res).toEqual({
        wmsOrderId: 500,
        changed: false,
        warehouseStatus: null,
      });
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("4. WMS-Owned ShipmentPushPayload Assembler & Pre-Push Guards", () => {
    it("rejects held, requires_review, terminal, and missing shipments before crossing the engine boundary", async () => {
      const missingDb = { execute: vi.fn().mockResolvedValueOnce({ rows: [] }) };
      await expect(assembleShipmentPushPayload(missingDb, 42)).rejects.toMatchObject({
        name: "ShipmentPushGuardError",
        guardCode: "SHIPMENT_NOT_FOUND",
        context: { code: "SS_PUSH_INVALID_SHIPMENT", shipmentId: 42 },
      });

      const heldDb = {
        execute: vi.fn().mockResolvedValueOnce({
          rows: [{ shipment_id: 42, order_id: 500, wms_order_id: 500, shipment_status: "planned", held: true, requires_review: false }],
        }),
      };
      await expect(assembleShipmentPushPayload(heldDb, 42)).rejects.toMatchObject({
        guardCode: "SHIPMENT_HELD",
        context: { code: "SS_PUSH_INVALID_SHIPMENT" },
      });

      const reviewDb = {
        execute: vi.fn().mockResolvedValueOnce({
          rows: [{ shipment_id: 42, order_id: 500, wms_order_id: 500, shipment_status: "planned", held: false, requires_review: true, review_reason: "address_mismatch" }],
        }),
      };
      await expect(assembleShipmentPushPayload(reviewDb, 42)).rejects.toMatchObject({
        guardCode: "SHIPMENT_REQUIRES_REVIEW",
      });

      const terminalDb = {
        execute: vi.fn().mockResolvedValueOnce({
          rows: [{ shipment_id: 42, order_id: 500, wms_order_id: 500, shipment_status: "shipped", held: false, requires_review: false }],
        }),
      };
      await expect(assembleShipmentPushPayload(terminalDb, 42)).rejects.toMatchObject({
        guardCode: "SHIPMENT_TERMINAL",
      });
    });

    it("hydrates a complete ShipmentPushPayload and passes it to ShippingEngine.upsertShipment", async () => {
      const db = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            rows: [
              {
                shipment_id: 42,
                order_id: 500,
                wms_order_id: 500,
                shipment_status: "queued",
                held: false,
                requires_review: false,
                shipping_engine: "shipstation",
                engine_order_ref: "9001",
                engine_shipment_ref: "echelon-wms-shp-42",
                order_number: "#61234",
                channel_id: 36,
                warehouse_id: 1,
                oms_fulfillment_order_id: "777",
                sort_rank: "100",
                external_order_id: "gid://shopify/Order/1",
                customer_name: "Ada Lovelace",
                customer_email: "ada@example.com",
                shipping_name: "Ada Lovelace",
                shipping_company: null,
                shipping_address: "123 Analytical Way",
                shipping_address2: "Suite 2",
                shipping_city: "Nashville",
                shipping_state: "TN",
                shipping_postal_code: "37201",
                shipping_country: "US",
                amount_paid_cents: 2599,
                tax_cents: 200,
                shipping_cents: 399,
                discount_cents: 0,
                total_cents: 2599,
                currency: "USD",
                order_placed_at: "2026-07-15T12:00:00.000Z",
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              {
                shipment_item_id: 11,
                order_item_id: 101,
                qty: 2,
                sku: "TL-100",
                name: "35pt Toploader",
                unit_price_cents: 1000,
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [{ cnt: 2 }],
          }),
      };

      const upsertShipment = vi.fn().mockResolvedValue({
        engineRef: {
          engine: "shipstation",
          engineOrderRef: "9001",
          engineShipmentRef: "echelon-wms-shp-42",
        },
        alreadyExisted: true,
      });

      const result = await pushShipmentThroughEngine(
        db,
        { upsertShipment },
        42,
      );

      expect(result.alreadyExisted).toBe(true);
      expect(upsertShipment).toHaveBeenCalledTimes(1);
      const passedPayload = upsertShipment.mock.calls[0]![0];
      expect(passedPayload).toMatchObject({
        shipmentId: 42,
        orderId: 500,
        orderNumber: "#61234",
        channelId: 36,
        warehouseId: 1,
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
            sku: "TL-100",
            name: "35pt Toploader",
            quantity: 2,
            unitPriceCents: 1000,
          },
        ],
        isPartialShipment: true,
        fulfillmentOrderId: "777",
        existingEngineRef: {
          engine: "shipstation",
          engineOrderRef: "9001",
          engineShipmentRef: "echelon-wms-shp-42",
        },
      });
    });
  });

  describe("5. Structural Port-Bypass & Sweeper Transport Guards", () => {
    it("eliminates all { shipmentId } as any casts on upsertShipment across server runtime files", () => {
      const files = collectRuntimeTsFiles(resolve(ROOT, "server"));
      const offenders: string[] = [];
      for (const file of files) {
        const src = readFileSync(file, "utf8");
        if (/upsertShipment\(\s*\{\s*shipmentId[^}]*\}\s*as\s+any\s*\)/.test(src)) {
          offenders.push(file);
        }
      }
      expect(offenders).toEqual([]);
    });

    it("removes dead setShipStationService from server/index.ts and routes dropship cancel stop through shippingEngine", () => {
      const indexSrc = readSrc("server/index.ts");
      expect(indexSrc).not.toContain("setShipStationService");
      expect(indexSrc).toContain(
        "services.shippingEngine.cancel(toEngineRef(engineOrderRef))",
      );
      expect(indexSrc).not.toContain(
        "services.shipStation.cancelOrder(engineOrderRef)",
      );
    });

    it("routes OrderEditWarehouseGateway through services.shippingEngine.synchronizeOrderEditShipment", () => {
      const compositionSrc = readSrc(
        "server/modules/order-edits/order-edit.composition.ts",
      );
      expect(compositionSrc).toContain(
        "services.shippingEngine?.synchronizeOrderEditShipment",
      );
    });

    it("guards SyncRecoveryService WMS->ShipStation backfill against held, review, and legacy-linked shipments", () => {
      const recoverySrc = readSrc(
        "server/modules/sync/sync-recovery.service.ts",
      );
      expect(recoverySrc).toContain("pushShipmentThroughEngine");
      expect(recoverySrc).toContain("AND shipstation_order_id IS NULL");
      expect(recoverySrc).toContain("AND COALESCE(held, false) = false");
      expect(recoverySrc).toContain(
        "AND COALESCE(requires_review, false) = false",
      );
    });

    it("routes shipstation-sweeper.ts through createShipStationApiRequester with zero raw fetch() calls", () => {
      const sweeperSrc = readSrc("server/modules/oms/shipstation-sweeper.ts");
      expect(sweeperSrc).toContain("createShipStationApiRequester");
      expect(sweeperSrc).not.toMatch(/\bfetch\s*\(/);
    });
  });
});
