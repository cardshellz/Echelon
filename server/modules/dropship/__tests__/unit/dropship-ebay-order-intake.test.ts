import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../db", () => ({ pool: {} }));

import {
  recordDropshipOrderIntakeInputSchema,
  type DropshipOrderIntakeRepositoryResult,
} from "../../application/dropship-order-intake-service";
import {
  DropshipEbayOrderIntakePollService,
  type DropshipEbayOrderIntakeProvider,
  type DropshipEbayOrderIntakeRepository,
  type DropshipEbayMarketplaceOrderEffects,
  type DropshipEbayOrderIntakeStoreConnection,
  type DropshipParkedOrderLine,
} from "../../application/dropship-ebay-order-intake-poll-service";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreAuthFailureInput,
  DropshipMarketplaceStoreAuthFailureRecord,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";
import {
  buildEbayDropshipOrderIntakeInput,
  parseEbayDiscountCents,
  parseEbayMoneyCents,
  readEbayOrderPollFacts,
  selectEbayDropshipLineItems,
  shouldRecordEbayDropshipOrder,
  type EbayStoreItemIndex,
} from "../../infrastructure/dropship-ebay-order-intake.mapper";
import { EbayDropshipOrderIntakeProvider } from "../../infrastructure/dropship-ebay-order-intake.provider";
import { PgDropshipEbayOrderIntakeRepository } from "../../infrastructure/dropship-ebay-order-intake.repository";
import { DropshipError } from "../../domain/errors";
import type { EbayOrder } from "../../../channels/adapters/ebay/ebay-types";

describe("eBay dropship order intake mapper", () => {
  it("keeps the buyer-selected shipping service code on the normalized payload", () => {
    const withService = buildEbayDropshipOrderIntakeInput({
      store: { vendorId: 10, storeConnectionId: 22 },
      order: makeEbayOrder(),
    });
    expect(withService.normalizedPayload.buyerShippingServiceCode).toBe("USPS_FIRST_CLASS");
    expect(recordDropshipOrderIntakeInputSchema.safeParse(withService).success).toBe(true);

    const order = makeEbayOrder();
    delete order.fulfillmentStartInstructions![0].shippingStep!.shippingServiceCode;
    const withoutService = buildEbayDropshipOrderIntakeInput({ store: { vendorId: 10, storeConnectionId: 22 }, order });
    expect(withoutService.normalizedPayload.buyerShippingServiceCode).toBeUndefined();
    expect(recordDropshipOrderIntakeInputSchema.safeParse(withoutService).success).toBe(true);
  });

  it("maps a paid eBay fulfillment order into validated dropship intake input", () => {
    const input = buildEbayDropshipOrderIntakeInput({
      store: { vendorId: 10, storeConnectionId: 22 },
      order: makeEbayOrder(),
    });

    expect(recordDropshipOrderIntakeInputSchema.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      externalOrderId: "11-11111-11111",
      externalOrderNumber: "5001",
      sourceOrderId: "legacy-11",
      idempotencyKey: "dropship:ebay:intake:22:11-11111-11111",
      normalizedPayload: {
        marketplaceStatus: "PAID:NOT_STARTED",
        orderedAt: "2026-05-03T14:30:00.000Z",
        lines: [
          {
            externalLineItemId: "line-1",
            externalListingId: "listing-1",
            externalOfferId: "variation-1",
            // Review ARCH-10: the mapper says what eBay's variation id means; nothing past it reads eBay's ids for that.
            marketplaceVariation: true,
            sku: "SKU-101",
            quantity: 2,
            unitRetailPriceCents: 1299,
            title: "Toploader",
          },
        ],
        shipTo: {
          name: "Card Buyer",
          address1: "1 Main St",
          city: "New York",
          region: "NY",
          postalCode: "10001",
          country: "US",
          email: "buyer@example.com",
        },
        totals: {
          retailSubtotalCents: 2598,
          shippingPaidCents: 500,
          taxCents: 216,
          discountCents: 100,
          grandTotalCents: 3214,
          currency: "USD",
        },
      },
    });
  });

  it("uses exact decimal parsing and rejects unsupported fractional cents", () => {
    expect(parseEbayMoneyCents({ value: "12.90", currency: "USD" }, "price")).toBe(1290);
    expect(parseEbayMoneyCents("12.9", "price")).toBe(1290);
    expect(parseEbayMoneyCents(12, "price")).toBe(1200);

    try {
      parseEbayMoneyCents("12.999", "price");
      throw new Error("expected parseEbayMoneyCents to reject fractional cents");
    } catch (error) {
      expect(error).toMatchObject({
        code: "DROPSHIP_EBAY_ORDER_MONEY_INVALID",
      } satisfies Partial<DropshipError>);
    }
  });

  it("ignores unpaid, cancelled, and already fulfilled orders before intake recording", () => {
    expect(shouldRecordEbayDropshipOrder({
      order: { ...makeEbayOrder(), orderPaymentStatus: "PENDING" },
      dropshipListingIds: DROPSHIP_LISTING_IDS,
    })).toEqual({ record: false, reason: "order_not_paid" });
    expect(shouldRecordEbayDropshipOrder({
      order: { ...makeEbayOrder(), cancelStatus: { cancelState: "CANCELED" } },
      dropshipListingIds: DROPSHIP_LISTING_IDS,
    })).toEqual({ record: false, reason: "order_cancelled" });
    expect(shouldRecordEbayDropshipOrder({
      order: { ...makeEbayOrder(), orderFulfillmentStatus: "FULFILLED" },
      dropshipListingIds: DROPSHIP_LISTING_IDS,
    })).toEqual({ record: false, reason: "order_already_fulfilled" });
  });

  it("ignores an order with no line sold through the store's dropship listings", () => {
    // The vendor's own sale on the same eBay store: same SKU, a different item.
    const ownSale = makeEbayOrder();
    ownSale.lineItems![0].legacyItemId = "vendor-own-item";

    expect(shouldRecordEbayDropshipOrder({
      order: ownSale,
      dropshipListingIds: DROPSHIP_LISTING_IDS,
    })).toEqual({ record: false, reason: "no_dropship_listing" });
    expect(shouldRecordEbayDropshipOrder({
      order: makeEbayOrder(),
      dropshipListingIds: new Set(),
    })).toEqual({ record: false, reason: "no_dropship_listing" });
  });

  it("checks for a dropship line before anything else, so the vendor's own orders are never judged", () => {
    const ownCancelledSale = {
      ...makeEbayOrder(),
      cancelStatus: { cancelState: "CANCELED" },
    };
    ownCancelledSale.lineItems = [{ ...ownCancelledSale.lineItems![0], legacyItemId: "vendor-own-item" }];

    expect(shouldRecordEbayDropshipOrder({
      order: ownCancelledSale,
      dropshipListingIds: DROPSHIP_LISTING_IDS,
    })).toEqual({ record: false, reason: "no_dropship_listing" });
  });

  it("keeps only the dropship lines of an order that also sells the vendor's own items", () => {
    const mixed = makeEbayOrder();
    mixed.lineItems = [
      mixed.lineItems![0],
      {
        ...mixed.lineItems![0],
        lineItemId: "line-own",
        legacyItemId: "vendor-own-item",
        sku: "SKU-101",
        title: "Vendor's own toploader",
      },
    ];

    const decision = shouldRecordEbayDropshipOrder({
      order: mixed,
      dropshipListingIds: DROPSHIP_LISTING_IDS,
    });
    expect(decision.record).toBe(true);
    if (!decision.record) throw new Error("expected the mixed order to be recorded");
    expect(decision.lineItems.map((item) => item.lineItemId)).toEqual(["line-1"]);

    const input = buildEbayDropshipOrderIntakeInput({
      store: { vendorId: 10, storeConnectionId: 22 },
      order: mixed,
      lineItems: decision.lineItems,
    });
    expect(input.normalizedPayload.lines.map((line) => line.externalLineItemId)).toEqual(["line-1"]);
    // The audit copy of the order stays whole.
    expect((input.rawPayload.lineItems as unknown[])).toHaveLength(2);
    expect(recordDropshipOrderIntakeInputSchema.safeParse(input).success).toBe(true);
  });

  it("does not count a line without an eBay item number as a dropship line", () => {
    const order = makeEbayOrder();
    delete order.lineItems![0].legacyItemId;

    expect(selectEbayDropshipLineItems(order, DROPSHIP_LISTING_IDS)).toEqual([]);
    expect(selectEbayDropshipLineItems({ ...order, lineItems: undefined }, DROPSHIP_LISTING_IDS)).toEqual([]);
  });

  it("reads a discount eBay reports as a negative amount", () => {
    expect(parseEbayDiscountCents({ value: "-1.50", currency: "USD" }, "discount")).toBe(150);
    expect(parseEbayDiscountCents({ value: "1.50", currency: "USD" }, "discount")).toBe(150);
    expect(parseEbayDiscountCents("-0.00", "discount")).toBe(0);
    expect(parseEbayDiscountCents(undefined, "discount")).toBe(0);
    for (const invalid of ["-", "--1.00", "-1.999", "- "]) {
      expect(() => parseEbayDiscountCents(invalid, "discount")).toThrowError(
        expect.objectContaining({ code: "DROPSHIP_EBAY_ORDER_MONEY_INVALID" }),
      );
    }

    const order = makeEbayOrder();
    order.pricingSummary!.priceDiscount = { value: "-1.00", currency: "USD" };
    const input = buildEbayDropshipOrderIntakeInput({ store: { vendorId: 10, storeConnectionId: 22 }, order });
    expect(input.normalizedPayload.totals?.discountCents).toBe(100);
  });

  it("keeps every other money field strict: a negative price is still refused", () => {
    expect(() => parseEbayMoneyCents("-1.00", "pricingSummary.total")).toThrowError(
      expect.objectContaining({ code: "DROPSHIP_EBAY_ORDER_MONEY_INVALID" }),
    );
  });
});

describe("EbayDropshipOrderIntakeProvider", () => {
  it("fetches connected seller orders with stored credentials and returns normalized intake inputs", async () => {
    const credentials = new FakeCredentialRepository();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("/sell/fulfillment/v1/order?");
      expect(String(url)).toContain("lastmodifieddate%3A%5B2026-05-03T14%3A00%3A00.000Z");
      return new Response(JSON.stringify({
        href: "https://api.ebay.com/sell/fulfillment/v1/order",
        total: 2,
        limit: 50,
        offset: 0,
        orders: [
          makeEbayOrder(),
          { ...makeEbayOrder(), orderId: "ignored-unpaid", orderPaymentStatus: "PENDING" },
        ],
      }), { status: 200 });
    });
    const provider = new EbayDropshipOrderIntakeProvider(credentials, fetchImpl as any, {
      now: () => new Date("2026-05-03T15:00:00.000Z"),
    });

    const result = await provider.fetchOrders({
      connection: makeProviderConnection(),
      since: new Date("2026-05-03T14:00:00.000Z"),
      until: new Date("2026-05-03T15:00:00.000Z"),
    });

    expect(result.ignored).toBe(1);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].input.externalOrderId).toBe("11-11111-11111");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    });
  });

  it("uses the modified-date cursor so newly paid existing orders are fetched", async () => {
    const credentials = new FakeCredentialRepository();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const urlText = String(url);
      expect(urlText).toContain("lastmodifieddate%3A%5B2026-05-03T15%3A15%3A00.000Z..2026-05-03T15%3A30%3A00.000Z%5D");
      expect(urlText).not.toContain("creationdate");
      return new Response(JSON.stringify({
        href: "https://api.ebay.com/sell/fulfillment/v1/order",
        total: 1,
        limit: 50,
        offset: 0,
        orders: [
          {
            ...makeEbayOrder(),
            creationDate: "2026-05-02T10:00:00.000Z",
            lastModifiedDate: "2026-05-03T15:20:00.000Z",
            orderPaymentStatus: "PAID",
          },
        ],
      }), { status: 200 });
    });
    const provider = new EbayDropshipOrderIntakeProvider(credentials, fetchImpl as any, {
      now: () => new Date("2026-05-03T15:30:00.000Z"),
    });

    const result = await provider.fetchOrders({
      connection: makeProviderConnection({ lastOrderSyncAt: new Date("2026-05-03T15:30:00.000Z") }),
      since: new Date("2026-05-03T15:15:00.000Z"),
      until: new Date("2026-05-03T15:30:00.000Z"),
    });

    expect(result.ignored).toBe(0);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].input.externalOrderId).toBe("11-11111-11111");
  });

  it("does not invalidate store credentials for an ordinary eBay order API 400", async () => {
    const credentials = new FakeCredentialRepository();
    const fetchImpl = vi.fn(async () => new Response("invalid filter", { status: 400 }));
    const provider = new EbayDropshipOrderIntakeProvider(credentials, fetchImpl as any, {
      now: () => new Date("2026-05-03T15:30:00.000Z"),
    });

    await expect(provider.fetchOrders({
      connection: makeProviderConnection(),
      since: new Date("2026-05-03T15:15:00.000Z"),
      until: new Date("2026-05-03T15:30:00.000Z"),
    })).rejects.toMatchObject({ code: "DROPSHIP_EBAY_ORDER_INTAKE_HTTP_ERROR" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(credentials.authFailures).toHaveLength(0);
  });

  it("does not call eBay or load credentials for a store with no dropship listing", async () => {
    const credentials = new FakeCredentialRepository();
    const loadForStoreConnection = vi.spyOn(credentials, "loadForStoreConnection");
    const fetchImpl = vi.fn();
    const provider = new EbayDropshipOrderIntakeProvider(credentials, fetchImpl as any, {
      now: () => new Date("2026-05-03T15:30:00.000Z"),
    });

    const result = await provider.fetchOrders({
      connection: makeProviderConnection({ dropshipListingIds: [] }),
      since: new Date("2026-05-03T15:15:00.000Z"),
      until: new Date("2026-05-03T15:30:00.000Z"),
    });

    expect(result).toEqual({ orders: [], ignored: 0, saleLines: [], cancelledOrders: [], unmatchedLines: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadForStoreConnection).not.toHaveBeenCalled();
  });

  it("skips the vendor's own orders, even ones intake could not read, and records the dropship order", async () => {
    // The incident: a non-dropship order on the vendor's store carried a money
    // value intake cannot parse, and failing on it stopped every later poll.
    const unreadableOwnSale = {
      ...makeEbayOrder(),
      orderId: "vendor-own-order",
      pricingSummary: { ...makeEbayOrder().pricingSummary, total: { value: "not-money", currency: "USD" } },
      lineItems: [{ ...makeEbayOrder().lineItems![0], legacyItemId: "vendor-own-item" }],
    };
    const credentials = new FakeCredentialRepository();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      href: "https://api.ebay.com/sell/fulfillment/v1/order",
      total: 2,
      limit: 50,
      offset: 0,
      orders: [unreadableOwnSale, makeEbayOrder()],
    }), { status: 200 }));
    const provider = new EbayDropshipOrderIntakeProvider(credentials, fetchImpl as any, {
      now: () => new Date("2026-05-03T15:30:00.000Z"),
    });

    const result = await provider.fetchOrders({
      connection: makeProviderConnection(),
      since: new Date("2026-05-03T15:15:00.000Z"),
      until: new Date("2026-05-03T15:30:00.000Z"),
    });

    expect(result.ignored).toBe(1);
    expect(result.orders.map((order) => order.externalOrderId)).toEqual(["11-11111-11111"]);
  });

  it("names the eBay order and the field when a dropship order cannot be read", async () => {
    const unreadable = {
      ...makeEbayOrder(),
      pricingSummary: { ...makeEbayOrder().pricingSummary, total: { value: "not-money", currency: "USD" } },
    };
    const credentials = new FakeCredentialRepository();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      href: "https://api.ebay.com/sell/fulfillment/v1/order",
      total: 1,
      limit: 50,
      offset: 0,
      orders: [unreadable],
    }), { status: 200 }));
    const provider = new EbayDropshipOrderIntakeProvider(credentials, fetchImpl as any, {
      now: () => new Date("2026-05-03T15:30:00.000Z"),
    });

    const failure = await provider.fetchOrders({
      connection: makeProviderConnection(),
      since: new Date("2026-05-03T15:15:00.000Z"),
      until: new Date("2026-05-03T15:30:00.000Z"),
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(DropshipError);
    expect(failure).toMatchObject({
      code: "DROPSHIP_EBAY_ORDER_MONEY_INVALID",
      context: expect.objectContaining({
        externalOrderId: "11-11111-11111",
        field: "pricingSummary.total",
        retryable: false,
      }),
    });
    expect((failure as DropshipError).message).toContain("(eBay order 11-11111-11111, field pricingSummary.total)");
  });
});

describe("DropshipEbayOrderIntakePollService", () => {
  it("records fetched orders and advances the store sync cursor only after success", async () => {
    const repository = new FakePollRepository();
    const healthService = new FakeOrderIntakeHealthService();
    const provider: DropshipEbayOrderIntakeProvider = {
      fetchOrder: vi.fn(async () => ({ kind: "not_found" as const })),
      fetchOrders: vi.fn(async () => ({ saleLines: [], cancelledOrders: [], unmatchedLines: [],
        ignored: 1,
        orders: [
          {
            externalOrderId: "11-11111-11111",
            input: buildEbayDropshipOrderIntakeInput({
              store: { vendorId: 10, storeConnectionId: 22 },
              order: makeEbayOrder(),
            }),
          },
        ],
      })),
    };
    const service = new DropshipEbayOrderIntakePollService({
      repository,
      healthService,
      provider,
      orderIntakeService: {
        recordMarketplaceOrder: vi.fn(async () => ({
          action: "created",
          intake: {
            intakeId: 1,
            channelId: 50,
            vendorId: 10,
            storeConnectionId: 22,
            platform: "ebay",
            externalOrderId: "11-11111-11111",
            externalOrderNumber: "5001",
            sourceOrderId: "legacy-11",
            status: "received",
            paymentHoldExpiresAt: null,
            rejectionReason: null,
            cancellationStatus: null,
            rawPayload: {},
            normalizedPayload: { lines: [{ quantity: 1 }] },
            payloadHash: "hash",
            omsOrderId: null,
            receivedAt: new Date("2026-05-03T15:00:00.000Z"),
            acceptedAt: null,
            updatedAt: new Date("2026-05-03T15:00:00.000Z"),
          },
        })),
      },
      marketplaceOrders: new FakeMarketplaceOrders(),
      clock: { now: () => new Date("2026-05-03T15:00:00.000Z") },
      logger: nullLogger(),
    });

    const result = await service.pollConnectedStores({
      limit: 10,
      initialLookbackMinutes: 240,
      overlapMinutes: 15,
    });

    expect(result).toMatchObject({
      storesScanned: 1,
      storesSucceeded: 1,
      storesFailed: 0,
      ordersCreated: 1,
      ordersIgnored: 1,
    });
    expect(healthService.successes).toEqual([{
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      syncedThrough: new Date("2026-05-03T15:00:00.000Z"),
    }]);
  });

  it("puts stores held only by their intake health back to ready before it lists stores to poll", async () => {
    // An order recorded while its store is not ready is rejected, so the store
    // must be ready before any of its orders are fetched.
    const events: string[] = [];
    const repository = new FakePollRepository(events);
    const healthService = new FakeOrderIntakeHealthService(events);
    const service = new DropshipEbayOrderIntakePollService({
      repository,
      healthService,
      provider: { fetchOrder: vi.fn(async () => ({ kind: "not_found" as const })),
      fetchOrders: vi.fn(async () => ({ saleLines: [], cancelledOrders: [], unmatchedLines: [], ignored: 0, orders: [] })) },
      orderIntakeService: { recordMarketplaceOrder: vi.fn() },
      marketplaceOrders: new FakeMarketplaceOrders(),
      clock: { now: () => new Date("2026-05-03T15:00:00.000Z") },
      logger: nullLogger(),
    });

    await service.pollConnectedStores({ limit: 10, initialLookbackMinutes: 240, overlapMinutes: 15 });

    expect(events).toEqual(["restore stores", "list stores"]);
    expect(healthService.restores).toEqual([{ platform: "ebay", limit: 10 }]);
  });

  it("still polls when putting stores back to ready fails, and logs it for a person", async () => {
    const repository = new FakePollRepository();
    const healthService = new FakeOrderIntakeHealthService();
    healthService.restoreError = new Error("database unavailable");
    const logger = nullLogger();
    const service = new DropshipEbayOrderIntakePollService({
      repository,
      healthService,
      provider: { fetchOrder: vi.fn(async () => ({ kind: "not_found" as const })),
      fetchOrders: vi.fn(async () => ({ saleLines: [], cancelledOrders: [], unmatchedLines: [], ignored: 0, orders: [] })) },
      orderIntakeService: { recordMarketplaceOrder: vi.fn() },
      marketplaceOrders: new FakeMarketplaceOrders(),
      clock: { now: () => new Date("2026-05-03T15:00:00.000Z") },
      logger,
    });

    const result = await service.pollConnectedStores({ limit: 10, initialLookbackMinutes: 240, overlapMinutes: 15 });

    expect(result).toMatchObject({ storesScanned: 1, storesSucceeded: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      code: "DROPSHIP_STORE_SETUP_STATUS_RESTORE_FAILED",
      context: { error: "database unavailable" },
    }));
  });

  it("does not advance the store sync cursor when order recording fails", async () => {
    const repository = new FakePollRepository();
    const healthService = new FakeOrderIntakeHealthService();
    const service = new DropshipEbayOrderIntakePollService({
      repository,
      healthService,
      provider: {
        fetchOrder: vi.fn(async () => ({ kind: "not_found" as const })),
      fetchOrders: vi.fn(async () => ({ saleLines: [], cancelledOrders: [], unmatchedLines: [],
          ignored: 0,
          orders: [
            {
              externalOrderId: "11-11111-11111",
              input: buildEbayDropshipOrderIntakeInput({
                store: { vendorId: 10, storeConnectionId: 22 },
                order: makeEbayOrder(),
              }),
            },
          ],
        })),
      },
      orderIntakeService: {
        recordMarketplaceOrder: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      },
      marketplaceOrders: new FakeMarketplaceOrders(),
      clock: { now: () => new Date("2026-05-03T15:00:00.000Z") },
      logger: nullLogger(),
    });

    const result = await service.pollConnectedStores({
      limit: 10,
      initialLookbackMinutes: 240,
      overlapMinutes: 15,
    });

    expect(result).toMatchObject({
      storesScanned: 1,
      storesSucceeded: 0,
      storesFailed: 1,
      ordersCreated: 0,
    });
    expect(healthService.successes).toHaveLength(0);
    expect(healthService.failures).toHaveLength(1);
  });

  it("isolates an immutable order conflict, records the other orders, and advances the cursor", async () => {
    const repository = new FakePollRepository();
    const healthService = new FakeOrderIntakeHealthService();
    const orders = ["ORDER-1", "ORDER-2", "ORDER-3"].map(makePollOrder);
    const recordMarketplaceOrder = vi.fn(async (input) => {
      if (input.externalOrderId === "ORDER-2") {
        throw new DropshipError(
          "DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE",
          "Immutable intake payload changed.",
          {
            intakeId: 202,
            externalOrderId: "ORDER-2",
            storeConnectionId: 22,
          },
        );
      }
      return makeRecordedIntakeResult(input.externalOrderId, input.externalOrderId === "ORDER-1" ? 201 : 203);
    });
    const logger = nullLogger();
    const service = new DropshipEbayOrderIntakePollService({
      repository,
      healthService,
      provider: {
        fetchOrder: vi.fn(async () => ({ kind: "not_found" as const })),
      fetchOrders: vi.fn(async () => ({ saleLines: [], cancelledOrders: [], unmatchedLines: [], ignored: 0, orders })),
      },
      orderIntakeService: { recordMarketplaceOrder },
      marketplaceOrders: new FakeMarketplaceOrders(),
      clock: { now: () => new Date("2026-05-03T15:00:00.000Z") },
      logger,
    });

    const result = await service.pollConnectedStores({
      limit: 10,
      initialLookbackMinutes: 240,
      overlapMinutes: 15,
    });

    expect(result).toMatchObject({
      storesSucceeded: 1,
      storesFailed: 0,
      ordersCreated: 2,
      ordersConflicted: 1,
    });
    expect(recordMarketplaceOrder).toHaveBeenCalledTimes(3);
    expect(repository.immutableConflicts).toEqual([
      expect.objectContaining({
        vendorId: 10,
        storeConnectionId: 22,
        intakeId: 202,
        externalOrderId: "ORDER-2",
        failureCode: "DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE",
      }),
    ]);
    expect(healthService.successes).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does not isolate malformed immutable-conflict errors", async () => {
    const repository = new FakePollRepository();
    const healthService = new FakeOrderIntakeHealthService();
    const service = new DropshipEbayOrderIntakePollService({
      repository,
      healthService,
      provider: {
        fetchOrder: vi.fn(async () => ({ kind: "not_found" as const })),
      fetchOrders: vi.fn(async () => ({ saleLines: [], cancelledOrders: [], unmatchedLines: [], ignored: 0, orders: [makePollOrder("ORDER-1")] })),
      },
      orderIntakeService: {
        recordMarketplaceOrder: vi.fn(async () => {
          throw new DropshipError(
            "DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE",
            "Malformed immutable conflict.",
            { intakeId: 201, externalOrderId: "DIFFERENT-ORDER", storeConnectionId: 22 },
          );
        }),
      },
      marketplaceOrders: new FakeMarketplaceOrders(),
      clock: { now: () => new Date("2026-05-03T15:00:00.000Z") },
      logger: nullLogger(),
    });

    const result = await service.pollConnectedStores({
      limit: 10,
      initialLookbackMinutes: 240,
      overlapMinutes: 15,
    });

    expect(result).toMatchObject({ storesSucceeded: 0, storesFailed: 1, ordersConflicted: 0 });
    expect(repository.immutableConflicts).toHaveLength(0);
    expect(healthService.successes).toHaveLength(0);
    expect(healthService.failures).toHaveLength(1);
  });
});

describe("eBay order poll facts (sync-back plan v4 §6.4, §7.2, §7.3)", () => {
  const index: EbayStoreItemIndex = {
    listingIdByItemNumber: new Map([["listing-1", 1], ["listing-old", 1]]),
    listingIdsBySku: new Map([["SKU-101", [1]], ["SKU-SHARED", [2, 3]]]),
  };
  const order = (overrides: Partial<EbayOrder> & { lines?: Array<Record<string, unknown>> } = {}): EbayOrder => {
    const { lines, ...rest } = overrides;
    return { ...makeEbayOrder(), ...rest, lineItems: (lines ?? [{}]).map((line) => ({ ...makeEbayOrder().lineItems![0], ...line })) } as EbayOrder;
  };

  it("counts every line on a known item number as a sale, paid or not, the old number of a relist included", () => {
    const facts = readEbayOrderPollFacts(order({ orderPaymentStatus: "PENDING", lines: [{}, { lineItemId: "line-2", legacyItemId: "listing-old", quantity: 3 }] }), index);
    expect(facts).toEqual({
      saleLines: [
        { listingId: 1, externalOrderId: "11-11111-11111", externalLineItemId: "line-1", quantity: 2, orderedAt: new Date("2026-05-03T14:30:00.000Z") },
        { listingId: 1, externalOrderId: "11-11111-11111", externalLineItemId: "line-2", quantity: 3, orderedAt: new Date("2026-05-03T14:30:00.000Z") },
      ],
      unmatchedLines: [], undatedSaleLines: 0, cancelled: false, hasDropshipLine: true,
    });
  });

  it("parks a line on an unknown item number whose custom label is exactly one listing's (FF-4)", () => {
    const facts = readEbayOrderPollFacts(order({ lines: [{ legacyItemId: "999000", sku: "sku-101" }] }), index);
    expect(facts.saleLines).toEqual([]);
    expect(facts.hasDropshipLine).toBe(false);
    expect(facts.unmatchedLines).toEqual([{ externalOrderId: "11-11111-11111", externalLineItemId: "line-1", externalListingId: "999000",
      sku: "sku-101", candidateListingId: 1, orderedAt: new Date("2026-05-03T14:30:00.000Z") }]);
  });

  it("leaves the vendor's own sale alone: no label, a label no listing has, or one two listings share", () => {
    for (const sku of [undefined, "VENDOR-OWN", "SKU-SHARED"]) {
      expect(readEbayOrderPollFacts(order({ lines: [{ legacyItemId: "999000", sku }] }), index).unmatchedLines, String(sku)).toEqual([]);
    }
  });

  it("reports a cancelled order that sold through the store's listings, and parks nothing of it (FF-7)", () => {
    const cancelled = { cancelStatus: { cancelState: "CANCELED" } } as Partial<EbayOrder>;
    expect(readEbayOrderPollFacts(order({ ...cancelled, lines: [{}, { lineItemId: "line-2", legacyItemId: "999000" }] }), index)).toMatchObject({
      cancelled: true, hasDropshipLine: true, unmatchedLines: [], saleLines: [expect.objectContaining({ externalLineItemId: "line-1" })] });
    // A cancel request eBay is still deciding is not a cancel.
    expect(readEbayOrderPollFacts(order({ cancelStatus: { cancelState: "CANCEL_REQUESTED" } } as Partial<EbayOrder>), index).cancelled).toBe(false);
  });

  it("leaves out of the ledger a line with no order time or no whole quantity", () => {
    expect(readEbayOrderPollFacts(order({ creationDate: "not-a-date" }), index)).toMatchObject({ saleLines: [], undatedSaleLines: 1, hasDropshipLine: true });
    expect(readEbayOrderPollFacts(order({ lines: [{ quantity: 0 }, { lineItemId: "line-2", quantity: 1.5 }] }), index).saleLines).toEqual([]);
  });
});

describe("EbayDropshipOrderIntakeProvider.fetchOrder (sync-back plan v2 §7.2 hourly check)", () => {
  const provider = (fetchImpl: ReturnType<typeof vi.fn>) =>
    new EbayDropshipOrderIntakeProvider(new FakeCredentialRepository(), fetchImpl as any, { now: () => new Date("2026-05-03T15:30:00.000Z") });

  it("reads one order by id with a GET and says whether eBay cancelled it, and what intake would record", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/sell/fulfillment/v1/order/11-11111-11111");
      expect(init?.method ?? "GET").toBe("GET");
      return new Response(JSON.stringify({ ...makeEbayOrder(), cancelStatus: { cancelState: "CANCELED" } }), { status: 200 });
    });
    expect(await provider(fetchImpl).fetchOrder({ connection: makeProviderConnection(), externalOrderId: "11-11111-11111" }))
      .toEqual({ kind: "order", cancelled: true, fulfilled: false, recordable: null });

    const open = vi.fn(async () => new Response(JSON.stringify(makeEbayOrder()), { status: 200 }));
    const read = await provider(open).fetchOrder({ connection: makeProviderConnection(), externalOrderId: "11-11111-11111" });
    expect(read).toMatchObject({ kind: "order", cancelled: false, fulfilled: false, recordable: { externalOrderId: "11-11111-11111" } });
  });

  it("answers not_found for an order eBay does not have, and throws any other failure for the next poll", async () => {
    expect(await provider(vi.fn(async () => new Response("{}", { status: 404 })))
      .fetchOrder({ connection: makeProviderConnection(), externalOrderId: "gone" })).toEqual({ kind: "not_found" });
    await expect(provider(vi.fn(async () => new Response("busy", { status: 503 })))
      .fetchOrder({ connection: makeProviderConnection(), externalOrderId: "11-1" })).rejects.toBeInstanceOf(DropshipError);
  });

  it("refuses a blank order id without calling eBay", async () => {
    const fetchImpl = vi.fn();
    await expect(provider(fetchImpl).fetchOrder({ connection: makeProviderConnection(), externalOrderId: "  " }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_ORDER_ID_REQUIRED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("DropshipEbayOrderIntakePollService order-side effects (sync-back plan v4 §7.2, §7.3)", () => {
  const NOW = new Date("2026-05-03T15:00:00.000Z");
  const fetched = (overrides: Partial<Awaited<ReturnType<DropshipEbayOrderIntakeProvider["fetchOrders"]>>> = {}) => ({
    ignored: 0, orders: [], saleLines: [], cancelledOrders: [], unmatchedLines: [], ...overrides });

  function poll(input: {
    effects: FakeMarketplaceOrders;
    fetchOrders?: DropshipEbayOrderIntakeProvider["fetchOrders"];
    fetchOrder?: DropshipEbayOrderIntakeProvider["fetchOrder"];
    recordMarketplaceOrder?: ReturnType<typeof vi.fn>;
    events?: string[];
  }) {
    const healthService = new FakeOrderIntakeHealthService();
    const events = input.events ?? input.effects.events;
    healthService.recordPollSucceeded = async (success) => {
      events.push("poll succeeded");
      healthService.successes.push(success);
    };
    const logger = { ...nullLogger(), debug: vi.fn() };
    const recordMarketplaceOrder = input.recordMarketplaceOrder ?? vi.fn(async (order: { externalOrderId: string }) =>
      makeRecordedIntakeResult(order.externalOrderId, 301));
    const service = new DropshipEbayOrderIntakePollService({
      repository: new FakePollRepository(),
      healthService,
      provider: {
        fetchOrders: input.fetchOrders ?? vi.fn(async () => fetched()),
        fetchOrder: input.fetchOrder ?? vi.fn(async () => ({ kind: "not_found" as const })),
      },
      orderIntakeService: { recordMarketplaceOrder },
      marketplaceOrders: input.effects,
      clock: { now: () => NOW },
      logger,
    });
    return { service, healthService, logger, recordMarketplaceOrder };
  }
  const run = (service: DropshipEbayOrderIntakePollService) =>
    service.pollConnectedStores({ limit: 10, initialLookbackMinutes: 240, overlapMinutes: 15 });

  it("writes the ledger and parked lines first, applies eBay cancels before the sync point moves, then starts the ledger", async () => {
    const effects = new FakeMarketplaceOrders();
    effects.linesParked = 1;
    const saleLine = { listingId: 1, externalOrderId: "A", externalLineItemId: "l1", quantity: 1, orderedAt: NOW };
    const unmatched = { externalOrderId: "B", externalLineItemId: "l2", externalListingId: "999", sku: "SKU-101", candidateListingId: 1, orderedAt: NOW };
    const { service, logger } = poll({ effects,
      fetchOrders: vi.fn(async () => fetched({ saleLines: [saleLine], unmatchedLines: [unmatched], cancelledOrders: [{ externalOrderId: "C" }] })) });

    const result = await run(service);

    expect(effects.events).toEqual(["record poll facts", "cancel C", "poll succeeded", "start sales ledger"]);
    expect(effects.pollFacts).toEqual([{ storeConnectionId: 22, saleLines: [saleLine], unmatchedLines: [unmatched], seenAt: NOW }]);
    expect(effects.ledgerStarts).toEqual([{ storeConnectionId: 22, since: new Date(NOW.getTime() + 60 * 60_000) }]);
    expect(result).toMatchObject({ storesSucceeded: 1, linesParked: 1, cancellationsApplied: 1, cancellationsDeadLettered: 0 });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_ORDER_UNMATCHED_LISTING" }));
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_EBAY_ORDER_CANCEL_APPLIED",
      context: expect.objectContaining({ externalOrderId: "C", intakeId: 1, action: "cancel_intake" }) }));
  });

  it("logs a cancel that needed nothing new at DEBUG and does not count it", async () => {
    const effects = new FakeMarketplaceOrders();
    effects.cancellationAnswer = async () => ({ action: "already_applied", intakeId: 1 });
    const { service, logger } = poll({ effects, fetchOrders: vi.fn(async () => fetched({ cancelledOrders: [{ externalOrderId: "C" }] })) });
    expect(await run(service)).toMatchObject({ storesSucceeded: 1, cancellationsApplied: 0 });
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_EBAY_ORDER_CANCEL_SEEN" }));
    expect(logger.info).not.toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_EBAY_ORDER_CANCEL_APPLIED" }));
  });

  it("fails the store's pass on a cancel that failed in passing, so the sync point stays and the cancel comes again", async () => {
    const effects = new FakeMarketplaceOrders();
    effects.cancellationAnswer = async () => { throw Object.assign(new Error("deadlock detected"), { code: "40P01" }); };
    const { service, healthService } = poll({ effects, fetchOrders: vi.fn(async () => fetched({ cancelledOrders: [{ externalOrderId: "C" }] })) });

    expect(await run(service)).toMatchObject({ storesSucceeded: 0, storesFailed: 1, cancellationsDeadLettered: 0 });
    expect(healthService.successes).toEqual([]);
    expect(healthService.failures).toHaveLength(1);
    expect(effects.deadLetters).toEqual([]);
    expect(effects.ledgerStarts).toEqual([]);
  });

  it("dead-letters a cancel no retry fixes once for a person and goes on with the pass", async () => {
    for (const failure of [
      new DropshipError("DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE", "uncovered status", { classification: "permanent", retryable: false }),
      Object.assign(new Error("check violation"), { code: "23514" }),
    ]) {
      const effects = new FakeMarketplaceOrders();
      effects.cancellationAnswer = async (externalOrderId) => {
        if (externalOrderId === "C") throw failure;
        return { action: "cancel_intake", intakeId: 2 };
      };
      const { service, healthService, logger } = poll({ effects,
        fetchOrders: vi.fn(async () => fetched({ cancelledOrders: [{ externalOrderId: "C" }, { externalOrderId: "D" }] })) });

      expect(await run(service)).toMatchObject({ storesSucceeded: 1, cancellationsApplied: 1, cancellationsDeadLettered: 1 });
      expect(effects.deadLetters).toEqual([expect.objectContaining({ vendorId: 10, storeConnectionId: 22, externalOrderId: "C", at: NOW,
        failureCode: failure instanceof DropshipError ? "DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE" : expect.any(String) })]);
      expect(healthService.successes).toHaveLength(1);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE" }));
    }
  });

  it("ARCH-2: counts a dead-lettered cancel only the first time; a replay of one already dead-lettered logs and counts nothing", async () => {
    const effects = new FakeMarketplaceOrders();
    effects.deadLetterCreated = false;
    effects.cancellationAnswer = async () => {
      throw new DropshipError("DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE", "uncovered status", { classification: "permanent", retryable: false });
    };
    const { service, logger } = poll({ effects, fetchOrders: vi.fn(async () => fetched({ cancelledOrders: [{ externalOrderId: "C" }] })) });
    expect(await run(service)).toMatchObject({ storesSucceeded: 1, cancellationsDeadLettered: 0 });
    expect(effects.deadLetters).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE" }));
  });

  it("ARCH-5: the production logger has a debug level, through the platform logger", async () => {
    const platform = await import("../../../../platform/observability/logger");
    const debug = vi.spyOn(platform.logger, "debug").mockImplementation(() => undefined);
    try {
      const { makeDropshipEbayOrderIntakeLogger } = await import("../../application/dropship-ebay-order-intake-poll-service");
      makeDropshipEbayOrderIntakeLogger().debug?.({ code: "DROPSHIP_EBAY_ORDER_CANCEL_SEEN", message: "seen" });
      expect(debug).toHaveBeenCalledWith("DROPSHIP_EBAY_ORDER_CANCEL_SEEN", expect.objectContaining({ message: "seen" }));
    } finally {
      debug.mockRestore();
    }
  });

  it("asks eBay about accepted orders by id: applies a cancel it finds, marks the rest checked, and stops at a failed read", async () => {
    const effects = new FakeMarketplaceOrders();
    effects.acceptedToCheck = [{ intakeId: 1, externalOrderId: "A" }, { intakeId: 2, externalOrderId: "B" },
      { intakeId: 3, externalOrderId: "C" }, { intakeId: 4, externalOrderId: "D" }];
    const fetchOrder = vi.fn(async ({ externalOrderId }: { externalOrderId: string }) => {
      if (externalOrderId === "A") return { kind: "order" as const, cancelled: true, fulfilled: false, recordable: null };
      if (externalOrderId === "B") return { kind: "order" as const, cancelled: false, fulfilled: false, recordable: null };
      throw new Error("eBay unavailable");
    });
    const { service, logger } = poll({ effects, fetchOrder });

    expect(await run(service)).toMatchObject({ storesSucceeded: 1, cancellationsApplied: 1 });
    expect(effects.cancellations.map((entry) => entry.externalOrderId)).toEqual(["A"]);
    // D is never asked: a failed read leaves the rest (their check time unchanged) for the next poll.
    expect(fetchOrder).toHaveBeenCalledTimes(3);
    expect(effects.checked).toEqual([{ intakeIds: [2], at: NOW }]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_EBAY_ACCEPTED_ORDER_CHECK_SKIPPED" }));
  });

  it("takes in the order of a parked line once its item number is proven, asks the vendor about an unproven one, and waits otherwise", async () => {
    const effects = new FakeMarketplaceOrders();
    const seen = new Date("2026-05-03T10:00:00.000Z");
    const parked = (id: number, externalOrderId: string, overrides: Partial<DropshipParkedOrderLine>): DropshipParkedOrderLine => ({
      id, externalOrderId, externalListingId: "999", sku: "SKU-101", candidateListingId: 1, firstSeenAt: seen,
      candidateExternalListingId: "listing-1", candidateHadItemNumber: false, candidateReadAt: null, ...overrides });
    effects.parkedLines = [
      parked(1, "R", { candidateExternalListingId: "999" }),
      parked(2, "R", { candidateHadItemNumber: true }),
      parked(3, "X", { candidateHadItemNumber: true }),
      parked(4, "Q", { externalListingId: "888", candidateReadAt: new Date(seen.getTime() + 60_000) }),
      parked(5, "W", {}),
    ];
    const recordable = makePollOrder("R");
    const fetchOrder = vi.fn(async ({ externalOrderId }: { externalOrderId: string }) => externalOrderId === "R"
      ? { kind: "order" as const, cancelled: false, fulfilled: false, recordable }
      : { kind: "order" as const, cancelled: true, fulfilled: false, recordable: null });
    const { service, recordMarketplaceOrder } = poll({ effects, fetchOrder });

    const result = await run(service);

    expect(recordMarketplaceOrder).toHaveBeenCalledWith(recordable.input);
    expect(effects.resolved).toEqual([{ ids: [1, 2], resolution: "relinked", at: NOW }, { ids: [3], resolution: "cancelled", at: NOW }]);
    expect(effects.asked).toEqual([{ vendorId: 10, storeConnectionId: 22, externalListingId: "888", sku: "SKU-101", at: NOW }]);
    expect(fetchOrder.mock.calls.map(([call]) => call.externalOrderId)).toEqual(["R", "X"]);
    expect(result).toMatchObject({ storesSucceeded: 1, ordersCreated: 1, parkedLinesResolved: 3 });
  });

  it("defers the sales ledger start to the next poll when it cannot be written, without failing the pass", async () => {
    const effects = new FakeMarketplaceOrders();
    effects.startLedgerError = new Error("database unavailable");
    const { service, healthService, logger } = poll({ effects });
    expect(await run(service)).toMatchObject({ storesSucceeded: 1, storesFailed: 0 });
    expect(healthService.successes).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_EBAY_SALES_LEDGER_START_DEFERRED" }));
  });

  it("does not record the poll's facts, apply cancels or start the ledger when eBay could not be read", async () => {
    const effects = new FakeMarketplaceOrders();
    const { service, healthService } = poll({ effects, fetchOrders: vi.fn(async () => { throw new Error("eBay unavailable"); }) });
    expect(await run(service)).toMatchObject({ storesFailed: 1 });
    expect(effects.events).toEqual([]);
    expect(healthService.failures).toHaveLength(1);
  });
});

describe("PgDropshipEbayOrderIntakeRepository", () => {
  it("polls only launch-ready connected eBay store connections", async () => {
    const dbPool = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const repository = new PgDropshipEbayOrderIntakeRepository(dbPool as any);

    await repository.listPollableStoreConnections({ limit: 25 });

    const [sql, params] = dbPool.query.mock.calls[0] ?? [];
    expect(sql).toContain("sc.platform = 'ebay'");
    expect(sql).toContain("sc.status = 'connected'");
    expect(sql).toContain("sc.setup_status = 'ready'");
    expect(sql).not.toContain("attention_required");
    expect(sql).toContain("sc.access_token_ref IS NOT NULL");
    expect(sql).toContain("sc.refresh_token_ref IS NOT NULL");
    expect(params).toEqual([25]);
  });

  it("returns each store's dropship listing item numbers from its own listings", async () => {
    const dbPool = {
      query: vi.fn(async () => ({
        rows: [{
          id: 22,
          vendor_id: 10,
          platform: "ebay",
          last_order_sync_at: null,
          dropship_listing_ids: ["168741367796"],
          item_numbers: [{ listingId: 5, externalListingId: "168741367796" }],
          listing_skus: [{ listingId: 5, sku: "SKU-101" }],
        }],
      })),
    };
    const repository = new PgDropshipEbayOrderIntakeRepository(dbPool as any);

    const connections = await repository.listPollableStoreConnections({ limit: 25 });

    expect(connections).toEqual([{
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      lastOrderSyncAt: null,
      dropshipListingIds: ["168741367796"],
      itemNumbers: [{ listingId: 5, externalListingId: "168741367796" }],
      listingSkus: [{ listingId: 5, sku: "SKU-101" }],
    }]);
    const sql = String(dbPool.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM dropship.dropship_vendor_listings dl");
    expect(sql).toContain("dl.store_connection_id = sc.id");
    expect(sql).toContain("dl.vendor_id = sc.vendor_id");
    expect(sql).toContain("dl.external_listing_id IS NOT NULL");
    // Every listing counts whatever its status: an ended one can still have a paid order.
    expect(sql).not.toContain("dl.status");
  });

  it("refuses listing ids that are not a list of strings", async () => {
    const dbPool = {
      query: vi.fn(async () => ({
        rows: [{ id: 22, vendor_id: 10, platform: "ebay", last_order_sync_at: null, dropship_listing_ids: null }],
      })),
    };
    const repository = new PgDropshipEbayOrderIntakeRepository(dbPool as any);

    await expect(repository.listPollableStoreConnections({ limit: 25 })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_ORDER_INTAKE_LISTING_IDS_INVALID",
      context: { storeConnectionId: 22, retryable: false },
    });
  });

  it("records an immutable conflict once under a transaction-scoped advisory lock", async () => {
    const client = {
      query: vi.fn(async (sql: string) => ({
        rows: [],
        rowCount: sql.includes("INSERT INTO dropship.dropship_audit_events") ? 1 : null,
      })),
      release: vi.fn(),
    };
    const dbPool = {
      connect: vi.fn(async () => client),
    };
    const repository = new PgDropshipEbayOrderIntakeRepository(dbPool as any);

    const result = await repository.recordImmutableOrderConflict({
      vendorId: 10,
      storeConnectionId: 22,
      intakeId: 202,
      externalOrderId: "ORDER-2",
      failureCode: "DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE",
      message: "Immutable intake payload changed.",
      now: new Date("2026-05-03T15:00:00.000Z"),
    });

    expect(result).toEqual({ created: true });
    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("INSERT INTO dropship.dropship_audit_events"),
      "COMMIT",
    ]);
    const insertSql = String(client.query.mock.calls[2]?.[0]);
    expect(insertSql).toContain("WHERE NOT EXISTS");
    expect(insertSql).toContain("event_type = $4");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

class FakeCredentialRepository implements DropshipMarketplaceCredentialRepository {
  authFailures: DropshipMarketplaceStoreAuthFailureInput[] = [];
  credential: DropshipMarketplaceStoreCredentials = {
    vendorId: 10,
    storeConnectionId: 22,
    platform: "ebay",
    status: "connected",
    shopDomain: null,
    externalAccountId: "seller-1",
    providerEnvironment: "production",
    externalAccountIdentityScheme: "provider_user_id",
    externalAccountVerifiedAt: new Date("2026-05-01T00:00:00.000Z"),
    externalDisplayName: "seller-1",
    config: { environment: "production", marketplaceId: "EBAY_US" },
    accessToken: "access-token",
    accessTokenRef: "access-ref",
    accessTokenExpiresAt: new Date("2026-05-03T16:00:00.000Z"),
    refreshToken: "refresh-token",
    refreshTokenRef: "refresh-ref",
    refreshTokenExpiresAt: null,
  };

  async loadForStoreConnection(): Promise<DropshipMarketplaceStoreCredentials> {
    return this.credential;
  }

  async replaceTokens(): Promise<DropshipMarketplaceStoreCredentials> {
    throw new Error("replaceTokens should not be called with a fresh token");
  }

  async recordAuthFailure(
    input: DropshipMarketplaceStoreAuthFailureInput,
  ): Promise<DropshipMarketplaceStoreAuthFailureRecord> {
    this.authFailures.push(input);
    return {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: input.platform,
      previousStatus: "connected",
      status: input.status,
      transitioned: true,
    };
  }
}

class FakePollRepository implements DropshipEbayOrderIntakeRepository {
  immutableConflicts: Array<Parameters<DropshipEbayOrderIntakeRepository["recordImmutableOrderConflict"]>[0]> = [];

  constructor(private readonly events: string[] = []) {}

  async listPollableStoreConnections(): Promise<DropshipEbayOrderIntakeStoreConnection[]> {
    this.events.push("list stores");
    return [makeProviderConnection()];
  }

  async recordImmutableOrderConflict(
    input: Parameters<DropshipEbayOrderIntakeRepository["recordImmutableOrderConflict"]>[0],
  ): Promise<{ created: boolean }> {
    this.immutableConflicts.push(input);
    return { created: true };
  }
}

/** Records the poll's order-side writes (plan v4 §6.4, §7.2, §7.3); each answer can be set per test. */
class FakeMarketplaceOrders implements DropshipEbayMarketplaceOrderEffects {
  events: string[];
  pollFacts: Array<Parameters<DropshipEbayMarketplaceOrderEffects["recordPollFacts"]>[0]> = [];
  cancellations: Array<Parameters<DropshipEbayMarketplaceOrderEffects["applyCancellation"]>[0]> = [];
  deadLetters: Array<Parameters<DropshipEbayMarketplaceOrderEffects["recordCancellationDeadLetter"]>[0]> = [];
  checked: Array<Parameters<DropshipEbayMarketplaceOrderEffects["markMarketplaceStatusChecked"]>[0]> = [];
  resolved: Array<Parameters<DropshipEbayMarketplaceOrderEffects["resolveParkedLines"]>[0]> = [];
  asked: Array<Parameters<DropshipEbayMarketplaceOrderEffects["askAboutUnknownItem"]>[0]> = [];
  ledgerStarts: Array<Parameters<DropshipEbayMarketplaceOrderEffects["startSalesLedger"]>[0]> = [];
  linesParked = 0;
  cancellationAnswer: (externalOrderId: string) => Promise<{ action: string; intakeId: number | null }> =
    async () => ({ action: "cancel_intake", intakeId: 1 });
  acceptedToCheck: Array<{ intakeId: number; externalOrderId: string }> = [];
  parkedLines: DropshipParkedOrderLine[] = [];
  startLedgerError: Error | null = null;
  deadLetterCreated = true;

  constructor(events: string[] = []) {
    this.events = events;
  }

  async recordPollFacts(input: Parameters<DropshipEbayMarketplaceOrderEffects["recordPollFacts"]>[0]) {
    this.events.push("record poll facts");
    this.pollFacts.push(input);
    return { saleLinesRecorded: input.saleLines.length, linesParked: this.linesParked };
  }

  async applyCancellation(input: Parameters<DropshipEbayMarketplaceOrderEffects["applyCancellation"]>[0]) {
    this.events.push(`cancel ${input.externalOrderId}`);
    this.cancellations.push(input);
    return this.cancellationAnswer(input.externalOrderId);
  }

  async recordCancellationDeadLetter(input: Parameters<DropshipEbayMarketplaceOrderEffects["recordCancellationDeadLetter"]>[0]) {
    this.events.push(`dead-letter ${input.externalOrderId}`);
    this.deadLetters.push(input);
    return this.deadLetterCreated;
  }

  async listAcceptedOrdersToCheck() {
    return this.acceptedToCheck;
  }

  async markMarketplaceStatusChecked(input: Parameters<DropshipEbayMarketplaceOrderEffects["markMarketplaceStatusChecked"]>[0]) {
    this.checked.push(input);
  }

  async listOpenParkedLines() {
    return this.parkedLines;
  }

  async resolveParkedLines(input: Parameters<DropshipEbayMarketplaceOrderEffects["resolveParkedLines"]>[0]) {
    this.resolved.push(input);
    return input.ids.length;
  }

  async askAboutUnknownItem(input: Parameters<DropshipEbayMarketplaceOrderEffects["askAboutUnknownItem"]>[0]) {
    this.asked.push(input);
    return true;
  }

  async expireParkedLines() {
    return 0;
  }

  async startSalesLedger(input: Parameters<DropshipEbayMarketplaceOrderEffects["startSalesLedger"]>[0]) {
    this.events.push("start sales ledger");
    if (this.startLedgerError) throw this.startLedgerError;
    this.ledgerStarts.push(input);
    return true;
  }
}

class FakeOrderIntakeHealthService {
  restores: Array<{ platform: string; limit: number }> = [];
  restoreError: Error | null = null;

  constructor(private readonly events: string[] = []) {}

  async restoreStoresHeldOnlyByOrderIntakeHealth(input: { platform: string; limit: number }): Promise<[]> {
    this.events.push("restore stores");
    this.restores.push(input);
    if (this.restoreError) throw this.restoreError;
    return [];
  }

  successes: Array<{
    vendorId: number;
    storeConnectionId: number;
    platform: "ebay";
    syncedThrough: Date;
  }> = [];
  failures: Array<{
    vendorId: number;
    storeConnectionId: number;
    platform: "ebay";
    failureCode: string;
    failureMessage: string;
  }> = [];

  async recordPollSucceeded(input: (typeof this.successes)[number]): Promise<void> {
    this.successes.push(input);
  }

  async recordPollFailed(input: (typeof this.failures)[number]): Promise<void> {
    this.failures.push(input);
  }
}

const DROPSHIP_LISTING_IDS: ReadonlySet<string> = new Set(["listing-1"]);

function makeProviderConnection(
  overrides: Partial<DropshipEbayOrderIntakeStoreConnection> = {},
): DropshipEbayOrderIntakeStoreConnection {
  return {
    vendorId: 10,
    storeConnectionId: 22,
    platform: "ebay",
    lastOrderSyncAt: null,
    dropshipListingIds: ["listing-1"],
    itemNumbers: [{ listingId: 1, externalListingId: "listing-1" }],
    listingSkus: [{ listingId: 1, sku: "SKU-101" }],
    ...overrides,
  };
}

function nullLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makePollOrder(externalOrderId: string) {
  const order = {
    ...makeEbayOrder(),
    orderId: externalOrderId,
    legacyOrderId: `legacy-${externalOrderId}`,
  };
  return {
    externalOrderId,
    input: buildEbayDropshipOrderIntakeInput({
      store: { vendorId: 10, storeConnectionId: 22 },
      order,
    }),
  };
}

function makeRecordedIntakeResult(
  externalOrderId: string,
  intakeId: number,
): DropshipOrderIntakeRepositoryResult {
  const recordedAt = new Date("2026-05-03T15:00:00.000Z");
  return {
    action: "created",
    intake: {
      intakeId,
      channelId: 50,
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      externalOrderId,
      externalOrderNumber: null,
      sourceOrderId: `legacy-${externalOrderId}`,
      status: "received",
      paymentHoldExpiresAt: null,
      rejectionReason: null,
      cancellationStatus: null,
      rawPayload: {},
      normalizedPayload: { lines: [{ quantity: 1 }] },
      payloadHash: `hash-${externalOrderId}`,
      omsOrderId: null,
      receivedAt: recordedAt,
      acceptedAt: null,
      updatedAt: recordedAt,
    },
  };
}

function makeEbayOrder(): EbayOrder {
  return {
    orderId: "11-11111-11111",
    legacyOrderId: "legacy-11",
    creationDate: "2026-05-03T14:30:00.000Z",
    lastModifiedDate: "2026-05-03T14:35:00.000Z",
    orderFulfillmentStatus: "NOT_STARTED",
    orderPaymentStatus: "PAID",
    sellerId: "seller-1",
    salesRecordReference: "5001",
    buyer: { username: "buyer-1" },
    pricingSummary: {
      priceSubtotal: { value: "25.98", currency: "USD" },
      deliveryCost: { value: "5.00", currency: "USD" },
      tax: { value: "2.16", currency: "USD" },
      priceDiscount: { value: "1.00", currency: "USD" },
      total: { value: "32.14", currency: "USD" },
    },
    fulfillmentStartInstructions: [
      {
        fulfillmentInstructionsType: "SHIP_TO",
        shippingStep: {
          shippingServiceCode: "USPS_FIRST_CLASS",
          shipTo: {
            fullName: "Card Buyer",
            contactAddress: {
              addressLine1: "1 Main St",
              city: "New York",
              stateOrProvince: "NY",
              postalCode: "10001",
              countryCode: "US",
            },
            email: "buyer@example.com",
          },
        },
      },
    ],
    lineItems: [
      {
        lineItemId: "line-1",
        legacyItemId: "listing-1",
        legacyVariationId: "variation-1",
        sku: "SKU-101",
        title: "Toploader",
        quantity: 2,
        lineItemCost: { value: "25.98", currency: "USD" },
        total: { value: "25.98", currency: "USD" },
        lineItemFulfillmentStatus: "NOT_STARTED",
      },
    ],
  };
}
