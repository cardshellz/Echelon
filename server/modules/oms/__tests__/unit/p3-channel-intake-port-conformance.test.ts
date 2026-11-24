import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueOmsWmsSyncRetryMock } = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://stub:stub@localhost:5432/stub";
  return {
    enqueueOmsWmsSyncRetryMock: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../application/webhook-retry.worker", () => ({
  enqueueOmsWmsSyncRetry: enqueueOmsWmsSyncRetryMock,
  enqueueShipStationShipmentPushRetry: vi.fn().mockResolvedValue(undefined),
}));

import {
  ChannelOrderAdapterRegistry,
  ChannelOrderBoundaryValidationError,
  parseValidatedChannelCancel,
  parseValidatedChannelOrder,
  parseValidatedChannelRefund,
  type ChannelOrderAdapter,
} from "../../../channels/domain/channel-adapter.interface";
import {
  createDefaultChannelOrderAdapterRegistry,
  ingestAndRoute,
} from "../../channel-order-intake.api";

interface AdapterConformanceFixture {
  providerKey: string;
  channelId: number;
  validSignedWebhook: {
    rawBody: Buffer;
    parsedBody: unknown;
    headers: Record<string, string>;
  };
  invalidSignedWebhook: {
    rawBody: Buffer;
    parsedBody: unknown;
    headers: Record<string, string>;
  };
  liveOrderRaw: unknown;
  cancelledOrderRaw: unknown;
  refundEventRaw: unknown;
  malformedOrderRaw: unknown;
}

const TEST_SHOPIFY_SECRET = "shpss_conformance_test_secret";

function signShopify(body: string): string {
  return crypto
    .createHmac("sha256", TEST_SHOPIFY_SECRET)
    .update(Buffer.from(body, "utf8"))
    .digest("base64");
}

function createSyntheticTikTokAdapter(): ChannelOrderAdapter {
  return {
    adapterName: "TikTok Shop",
    providerKey: "tiktok",
    verifyWebhook(input) {
      if (input.headers["x-tiktok-signature"] !== "valid-tiktok-sig") {
        return {
          ok: false,
          statusCode: 401,
          code: "TIKTOK_SIG_INVALID",
          message: "Invalid TikTok signature",
        };
      }
      return { ok: true };
    },
    normalizeOrder(raw, ctx) {
      const p = (raw ?? {}) as any;
      return parseValidatedChannelOrder("tiktok", {
        externalOrderId: String(p.order_id ?? ""),
        externalOrderNumber: String(p.order_id ?? ""),
        channelId: ctx.channelId,
        source: "tiktok",
        status: p.cancelled ? "cancelled" : "confirmed",
        financialStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        customerEmail: p.buyer_email ?? null,
        customerName: p.buyer_name ?? null,
        shippingAddress: {
          name: p.buyer_name ?? null,
          address1: "100 Main St",
          address2: null,
          city: "Austin",
          province: "TX",
          zip: "78701",
          country: "US",
          phone: null,
        },
        subtotalCents: Number(p.subtotal_cents ?? 0),
        shippingCents: 0,
        taxCents: 0,
        discountCents: 0,
        totalCents: Number(p.subtotal_cents ?? 0),
        currency: "usd",
        notes: null,
        tags: null,
        orderDate: new Date("2026-11-19T12:00:00Z"),
        lineItems: Array.isArray(p.items)
          ? p.items.map((it: any) => ({
              externalLineItemId: String(it.id ?? ""),
              sku: it.sku ?? null,
              title: it.title ?? "Item",
              quantity: Number(it.qty ?? 0),
              paidPriceCents: Number(it.price_cents ?? 0),
              discountCents: 0,
              taxCents: 0,
              totalCents: Number(it.price_cents ?? 0) * Number(it.qty ?? 0),
            }))
          : [],
      });
    },
    normalizeCancel(raw, ctx) {
      const p = (raw ?? {}) as any;
      if (!p.cancelled) return null;
      return parseValidatedChannelCancel("tiktok", {
        externalOrderId: String(p.order_id ?? ""),
        channelId: ctx.channelId,
        source: "tiktok",
        reason: "buyer_cancelled",
        cancelledAt: new Date("2026-11-19T13:00:00Z"),
        lineItems: null,
      });
    },
    normalizeRefund(raw, ctx) {
      const p = (raw ?? {}) as any;
      if (!p.refund_cents) return null;
      return parseValidatedChannelRefund("tiktok", {
        externalOrderId: String(p.order_id ?? ""),
        externalRefundId: "tt-ref-1",
        channelId: ctx.channelId,
        source: "tiktok",
        financialStatus: "refunded",
        refundAmountCents: Number(p.refund_cents),
        refundedAt: new Date("2026-11-19T14:00:00Z"),
        lineItems: [],
      });
    },
  };
}

describe("P3.1 — Channel Intake Port, Adapter Conformance Suite, & ingestAndRoute()", () => {
  const registry = createDefaultChannelOrderAdapterRegistry({
    shopify: { secrets: [TEST_SHOPIFY_SECRET] },
    ebay: {
      signatureVerifier: async (req) =>
        req.headers["x-ebay-signature"] === "valid-ebay-sig"
          ? { ok: true }
          : { ok: false, statusCode: 401, code: "EBAY_SIG_BAD", message: "bad sig" },
    },
  });
  registry.register(createSyntheticTikTokAdapter());

  const shopifyLiveBody = JSON.stringify({
    id: 987654321,
    admin_graphql_api_id: "gid://shopify/Order/987654321",
    name: "#55001",
    order_number: 55001,
    email: "collector@cardshellz.com",
    financial_status: "paid",
    fulfillment_status: null,
    subtotal_price: "29.99",
    total_tax: "2.40",
    total_discounts: "0.00",
    total_price: "37.38",
    currency: "usd",
    created_at: "2026-11-19T12:00:00Z",
    customer: { id: 444555, first_name: "Casey", last_name: "Collector" },
    shipping_address: {
      name: "Casey Collector",
      address1: "742 Evergreen Terrace",
      city: "Springfield",
      province_code: "IL",
      zip: "62704",
      country_code: "US",
    },
    shipping_lines: [{ title: "Ground", code: "GND", price: "4.99" }],
    line_items: [
      {
        id: 111222,
        sku: "CS-TOPLOADER-35PT",
        title: "35pt Rigid Toploader",
        quantity: 2,
        price: "14.99",
        total_discount: "0.00",
        fulfillable_quantity: 2,
        requires_shipping: true,
      },
    ],
  });

  const fixtures: Record<string, AdapterConformanceFixture> = {
    shopify: {
      providerKey: "shopify",
      channelId: 36,
      validSignedWebhook: {
        rawBody: Buffer.from(shopifyLiveBody, "utf8"),
        parsedBody: JSON.parse(shopifyLiveBody),
        headers: { "x-shopify-hmac-sha256": signShopify(shopifyLiveBody) },
      },
      invalidSignedWebhook: {
        rawBody: Buffer.from(shopifyLiveBody, "utf8"),
        parsedBody: JSON.parse(shopifyLiveBody),
        headers: { "x-shopify-hmac-sha256": "tampered_hmac==" },
      },
      liveOrderRaw: JSON.parse(shopifyLiveBody),
      cancelledOrderRaw: {
        ...JSON.parse(shopifyLiveBody),
        cancelled_at: "2026-11-19T13:00:00Z",
        cancel_reason: "customer",
      },
      refundEventRaw: {
        id: 77701,
        order_id: 987654321,
        created_at: "2026-11-19T14:00:00Z",
        transactions: [{ status: "success", amount: "14.99" }],
        order_total_cents: 3738,
        refund_line_items: [
          {
            line_item_id: 111222,
            quantity: 1,
            restock_type: "cancel",
          },
        ],
      },
      malformedOrderRaw: {
        id: 987654321,
        name: "#BAD",
        currency: "INVALID_CURRENCY",
        line_items: [
          {
            id: 111222,
            sku: "CS-TOPLOADER-35PT",
            title: "Bad Qty",
            quantity: 0,
            price: "14.99",
          },
        ],
      },
    },
    ebay: {
      providerKey: "ebay",
      channelId: 67,
      validSignedWebhook: {
        rawBody: Buffer.from('{"metadata":{"topic":"MARKETPLACE_ORDER"}}'),
        parsedBody: { metadata: { topic: "MARKETPLACE_ORDER" } },
        headers: { "x-ebay-signature": "valid-ebay-sig" },
      },
      invalidSignedWebhook: {
        rawBody: Buffer.from('{"metadata":{"topic":"MARKETPLACE_ORDER"}}'),
        parsedBody: { metadata: { topic: "MARKETPLACE_ORDER" } },
        headers: {},
      },
      liveOrderRaw: {
        orderId: "21-14508-76944",
        creationDate: "2026-11-19T12:00:00.000Z",
        orderPaymentStatus: "PAID",
        orderFulfillmentStatus: "NOT_STARTED",
        buyer: { username: "card_buyer_99" },
        pricingSummary: {
          priceSubtotal: { value: "25.00", currency: "USD" },
          deliveryCost: { value: "5.00", currency: "USD" },
          priceDiscount: { value: "-2.00", currency: "USD" },
          total: { value: "28.00", currency: "USD" },
        },
        fulfillmentStartInstructions: [
          {
            maxEstimatedDeliveryDate: "2026-11-24T00:00:00.000Z",
            shippingStep: {
              shipTo: {
                fullName: "Alex Buyer",
                email: "alex@example.com",
                contactAddress: {
                  addressLine1: "500 Market St",
                  city: "San Francisco",
                  stateOrProvince: "CA",
                  postalCode: "94105",
                  countryCode: "US",
                },
              },
            },
          },
        ],
        lineItems: [
          {
            lineItemId: "100499887711",
            legacyItemId: "334455667788",
            sku: "CS-SLEEVE-100",
            title: "Easy Glide Soft Sleeves (100ct)",
            quantity: 2,
            lineItemCost: { value: "25.00", currency: "USD" },
          },
        ],
      },
      cancelledOrderRaw: {
        orderId: "21-14508-76944",
        creationDate: "2026-11-19T12:00:00.000Z",
        orderPaymentStatus: "PAID",
        orderFulfillmentStatus: "NOT_STARTED",
        cancelStatus: {
          cancelState: "CANCELED",
          cancelRequests: [
            {
              cancelReason: "BUYER_ASKED_CANCEL",
              cancelCompletedDate: "2026-11-19T13:15:00.000Z",
            },
          ],
        },
        pricingSummary: {
          priceSubtotal: { value: "25.00", currency: "USD" },
          deliveryCost: { value: "5.00", currency: "USD" },
          total: { value: "30.00", currency: "USD" },
        },
        lineItems: [
          {
            lineItemId: "100499887711",
            sku: "CS-SLEEVE-100",
            title: "Easy Glide Soft Sleeves (100ct)",
            quantity: 2,
            lineItemCost: { value: "25.00", currency: "USD" },
          },
        ],
      },
      refundEventRaw: {
        orderId: "21-14508-76944",
        creationDate: "2026-11-19T12:00:00.000Z",
        orderPaymentStatus: "FULLY_REFUNDED",
        orderFulfillmentStatus: "NOT_STARTED",
        pricingSummary: {
          priceSubtotal: { value: "25.00", currency: "USD" },
          deliveryCost: { value: "5.00", currency: "USD" },
          total: { value: "30.00", currency: "USD" },
        },
        lineItems: [
          {
            lineItemId: "100499887711",
            sku: "CS-SLEEVE-100",
            title: "Easy Glide Soft Sleeves (100ct)",
            quantity: 2,
            lineItemCost: { value: "25.00", currency: "USD" },
          },
        ],
      },
      malformedOrderRaw: {
        orderId: "",
        creationDate: "2026-11-19T12:00:00.000Z",
        lineItems: [],
      },
    },
    tiktok: {
      providerKey: "tiktok",
      channelId: 91,
      validSignedWebhook: {
        rawBody: Buffer.from("{}"),
        parsedBody: {},
        headers: { "x-tiktok-signature": "valid-tiktok-sig" },
      },
      invalidSignedWebhook: {
        rawBody: Buffer.from("{}"),
        parsedBody: {},
        headers: { "x-tiktok-signature": "wrong" },
      },
      liveOrderRaw: {
        order_id: "TT-9001",
        buyer_email: "tt@example.com",
        buyer_name: "Taylor Shop",
        subtotal_cents: 1999,
        items: [{ id: "tt-li-1", sku: "CS-MAG-35", title: "35pt Magnetic", qty: 1, price_cents: 1999 }],
      },
      cancelledOrderRaw: {
        order_id: "TT-9001",
        cancelled: true,
        subtotal_cents: 1999,
        items: [{ id: "tt-li-1", sku: "CS-MAG-35", title: "35pt Magnetic", qty: 1, price_cents: 1999 }],
      },
      refundEventRaw: {
        order_id: "TT-9001",
        refund_cents: 1999,
      },
      malformedOrderRaw: {
        order_id: "TT-BAD",
        items: [{ id: "tt-li-1", sku: "CS-MAG-35", title: "Bad Qty", qty: 0, price_cents: 1999 }],
      },
    },
  };

  describe("Parameterized ChannelOrderAdapter conformance across every registered provider", () => {
    it("registers all expected providers and rejects duplicate provider keys", () => {
      expect(registry.getRegisteredProviders()).toEqual(["shopify", "ebay", "tiktok"]);
      const dupRegistry = new ChannelOrderAdapterRegistry();
      dupRegistry.register(createSyntheticTikTokAdapter());
      expect(() => dupRegistry.register(createSyntheticTikTokAdapter())).toThrow(
        /already registered/,
      );
    });

    for (const adapter of registry.getAll()) {
      describe(`Adapter conformance :: ${adapter.adapterName} (${adapter.providerKey})`, () => {
        const fx = fixtures[adapter.providerKey];

        it("verifies authentic webhooks and rejects missing/invalid signatures", async () => {
          const valid = await adapter.verifyWebhook(fx.validSignedWebhook);
          expect(valid.ok).toBe(true);

          const invalid = await adapter.verifyWebhook(fx.invalidSignedWebhook);
          expect(invalid.ok).toBe(false);
          if (!invalid.ok) {
            expect(invalid.statusCode).toBe(401);
          }
        });

        it("normalizes live orders into Zod-validated canonical integer-cents ChannelOrders", () => {
          const order = adapter.normalizeOrder(fx.liveOrderRaw, {
            channelId: fx.channelId,
            sourceInboxId: 42,
          });
          expect(order.source).toBe(adapter.providerKey);
          expect(order.channelId).toBe(fx.channelId);
          expect(order.externalOrderId.length).toBeGreaterThan(0);
          expect(order.currency).toBe("USD");
          expect(Number.isInteger(order.subtotalCents)).toBe(true);
          expect(Number.isInteger(order.totalCents)).toBe(true);
          expect(order.orderDate).toBeInstanceOf(Date);
          expect(order.lineItems.length).toBeGreaterThanOrEqual(1);
          for (const line of order.lineItems) {
            expect(line.quantity).toBeGreaterThan(0);
            expect(Number.isInteger(line.paidPriceCents)).toBe(true);
            expect(Number.isInteger(line.totalCents)).toBe(true);
          }
        });

        it("rejects malformed order payloads at the boundary with ChannelOrderBoundaryValidationError", () => {
          expect(() =>
            adapter.normalizeOrder(fx.malformedOrderRaw, {
              channelId: fx.channelId,
            }),
          ).toThrow(ChannelOrderBoundaryValidationError);
        });

        it("normalizes cancel events only when cancelled", () => {
          expect(
            adapter.normalizeCancel(fx.liveOrderRaw, { channelId: fx.channelId }),
          ).toBeNull();

          const cancel = adapter.normalizeCancel(fx.cancelledOrderRaw, {
            channelId: fx.channelId,
          });
          expect(cancel).not.toBeNull();
          expect(cancel?.source).toBe(adapter.providerKey);
          expect(cancel?.channelId).toBe(fx.channelId);
          expect(cancel?.cancelledAt).toBeInstanceOf(Date);
        });

        it("normalizes refund events with non-negative integer cents", () => {
          expect(
            adapter.normalizeRefund(fx.liveOrderRaw, { channelId: fx.channelId }),
          ).toBeNull();

          const refund = adapter.normalizeRefund(fx.refundEventRaw, {
            channelId: fx.channelId,
          });
          expect(refund).not.toBeNull();
          expect(refund?.source).toBe(adapter.providerKey);
          expect(["refunded", "partially_refunded"]).toContain(refund?.financialStatus);
          expect(Number.isInteger(refund?.refundAmountCents)).toBe(true);
          expect((refund?.refundAmountCents ?? -1) >= 0).toBe(true);
        });
      });
    }
  });

  describe("ingestAndRoute() post-ingest choreography", () => {
    beforeEach(() => {
      enqueueOmsWmsSyncRetryMock.mockClear();
    });

    it("executes full ingest -> pre-sync -> reserve -> assignWarehouse -> post-sync -> afterRouted choreography for new orders", async () => {
      const callOrder: string[] = [];
      const omsService = {
        ingestOrder: vi.fn(async () => {
          callOrder.push("ingestOrder");
          return {
            id: 501,
            warehouseId: null,
            createdAt: new Date(),
            customerEmail: "collector@cardshellz.com",
          } as any;
        }),
        reserveInventory: vi.fn(async () => {
          callOrder.push("reserveInventory");
        }),
        assignWarehouse: vi.fn(async () => {
          callOrder.push("assignWarehouse");
        }),
      };
      const wmsSyncService = {
        syncOmsOrderToWms: vi.fn(async () => {
          callOrder.push("syncOmsOrderToWms");
          return 9001;
        }),
      };

      const shopifyOrder = registry
        .getOrThrow("shopify")
        .normalizeOrder(fixtures.shopify.liveOrderRaw, { channelId: 36 });

      const outcome = await ingestAndRoute({
        db: {},
        omsService,
        wmsSyncService,
        order: shopifyOrder,
        afterRouted: async () => {
          callOrder.push("afterRouted");
        },
      });

      expect(outcome.omsOrderId).toBe(501);
      expect(outcome.isNew).toBe(true);
      expect(outcome.routed).toBe(true);
      expect(callOrder).toEqual([
        "ingestOrder",
        "syncOmsOrderToWms",
        "reserveInventory",
        "assignWarehouse",
        "syncOmsOrderToWms",
        "afterRouted",
      ]);
      expect(enqueueOmsWmsSyncRetryMock).not.toHaveBeenCalled();
    });

    it("completes warehouse routing for older unrouted orders (!warehouseId) and skips retry on intentional null WMS skip", async () => {
      const omsService = {
        ingestOrder: vi.fn(async () => ({
          id: 502,
          warehouseId: null,
          createdAt: new Date(Date.now() - 60_000),
        })) as any,
        reserveInventory: vi.fn().mockResolvedValue(undefined),
        assignWarehouse: vi.fn().mockResolvedValue(undefined),
      };
      const wmsSyncService = {
        syncOmsOrderToWms: vi.fn().mockResolvedValue(null),
      };

      const ebayOrder = registry
        .getOrThrow("ebay")
        .normalizeOrder(fixtures.ebay.liveOrderRaw, { channelId: 67 });

      const outcome = await ingestAndRoute({
        db: {},
        omsService,
        wmsSyncService,
        order: ebayOrder,
      });

      expect(outcome.isNew).toBe(false);
      expect(outcome.routed).toBe(true);
      expect(omsService.reserveInventory).toHaveBeenCalledWith(502);
      expect(omsService.assignWarehouse).toHaveBeenCalledWith(502);
      expect(wmsSyncService.syncOmsOrderToWms).toHaveBeenCalledTimes(2);
      expect(enqueueOmsWmsSyncRetryMock).not.toHaveBeenCalled();
    });

    it("enqueues durable oms_wms_sync retry when syncOmsOrderToWms throws, and honors afterIngested skipRouting guards", async () => {
      const omsService = {
        ingestOrder: vi.fn(async () => ({
          id: 503,
          warehouseId: 1,
          createdAt: new Date(),
        })) as any,
        reserveInventory: vi.fn(),
        assignWarehouse: vi.fn(),
      };
      const wmsSyncService = {
        syncOmsOrderToWms: vi.fn().mockRejectedValue(new Error("transient DB timeout")),
      };

      const tiktokOrder = registry
        .getOrThrow("tiktok")
        .normalizeOrder(fixtures.tiktok.liveOrderRaw, { channelId: 91 });

      await ingestAndRoute({
        db: { tag: "db" },
        omsService,
        wmsSyncService,
        order: tiktokOrder,
      });

      expect(omsService.reserveInventory).not.toHaveBeenCalled();
      expect(enqueueOmsWmsSyncRetryMock).toHaveBeenCalledTimes(2);

      // Verify skipRouting short-circuit (e.g. order-edit ingress guard)
      wmsSyncService.syncOmsOrderToWms.mockClear();
      const skipped = await ingestAndRoute({
        db: {},
        omsService,
        wmsSyncService,
        order: tiktokOrder,
        afterIngested: async () => ({ skipRouting: true }),
      });
      expect(skipped.skippedByGuard).toBe(true);
      expect(skipped.routed).toBe(false);
      expect(wmsSyncService.syncOmsOrderToWms).not.toHaveBeenCalled();
    });
  });
});
