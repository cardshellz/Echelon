import { describe, expect, it, vi } from "vitest";
import { recordDropshipOrderIntakeInputSchema } from "../../application/dropship-order-intake-service";
import {
  DropshipEbayOrderIntakePollService,
  type DropshipEbayOrderIntakeProvider,
  type DropshipEbayOrderIntakeRepository,
  type DropshipEbayOrderIntakeStoreConnection,
} from "../../application/dropship-ebay-order-intake-poll-service";
import type { DropshipMarketplaceCredentialRepository, DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";
import {
  buildEbayDropshipOrderIntakeInput,
  parseEbayMoneyCents,
  shouldRecordEbayDropshipOrder,
} from "../../infrastructure/dropship-ebay-order-intake.mapper";
import { EbayDropshipOrderIntakeProvider } from "../../infrastructure/dropship-ebay-order-intake.provider";
import { DropshipError } from "../../domain/errors";
import type { EbayOrder } from "../../../channels/adapters/ebay/ebay-types";

describe("eBay dropship order intake mapper", () => {
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
    })).toEqual({ record: false, reason: "order_not_paid" });
    expect(shouldRecordEbayDropshipOrder({
      order: { ...makeEbayOrder(), cancelStatus: { cancelState: "CANCELED" } },
    })).toEqual({ record: false, reason: "order_cancelled" });
    expect(shouldRecordEbayDropshipOrder({
      order: { ...makeEbayOrder(), orderFulfillmentStatus: "FULFILLED" },
    })).toEqual({ record: false, reason: "order_already_fulfilled" });
  });
});

describe("EbayDropshipOrderIntakeProvider", () => {
  it("fetches connected seller orders with stored credentials and returns normalized intake inputs", async () => {
    const credentials = new FakeCredentialRepository();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("/sell/fulfillment/v1/order?");
      expect(String(url)).toContain("creationdate%3A%5B2026-05-03T14%3A00%3A00.000Z");
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
      connection: { vendorId: 10, storeConnectionId: 22, lastOrderSyncAt: null },
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
});

describe("DropshipEbayOrderIntakePollService", () => {
  it("records fetched orders and advances the store sync cursor only after success", async () => {
    const repository = new FakePollRepository();
    const provider: DropshipEbayOrderIntakeProvider = {
      fetchOrders: vi.fn(async () => ({
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
    expect(repository.lastSuccess).toEqual({
      storeConnectionId: 22,
      syncedThrough: new Date("2026-05-03T15:00:00.000Z"),
      now: new Date("2026-05-03T15:00:00.000Z"),
    });
  });

  it("does not advance the store sync cursor when order recording fails", async () => {
    const repository = new FakePollRepository();
    const service = new DropshipEbayOrderIntakePollService({
      repository,
      provider: {
        fetchOrders: vi.fn(async () => ({
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
    expect(repository.lastSuccess).toBeNull();
  });
});

class FakeCredentialRepository implements DropshipMarketplaceCredentialRepository {
  credential: DropshipMarketplaceStoreCredentials = {
    vendorId: 10,
    storeConnectionId: 22,
    platform: "ebay",
    status: "connected",
    shopDomain: null,
    externalAccountId: "seller-1",
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
}

class FakePollRepository implements DropshipEbayOrderIntakeRepository {
  lastSuccess: Parameters<DropshipEbayOrderIntakeRepository["markStorePollSucceeded"]>[0] | null = null;

  async listPollableStoreConnections(): Promise<DropshipEbayOrderIntakeStoreConnection[]> {
    return [{ vendorId: 10, storeConnectionId: 22, lastOrderSyncAt: null }];
  }

  async markStorePollSucceeded(
    input: Parameters<DropshipEbayOrderIntakeRepository["markStorePollSucceeded"]>[0],
  ): Promise<void> {
    this.lastSuccess = input;
  }
}

function nullLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
