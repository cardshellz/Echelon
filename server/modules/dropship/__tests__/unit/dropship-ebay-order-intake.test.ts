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
  type DropshipEbayOrderIntakeStoreConnection,
} from "../../application/dropship-ebay-order-intake-poll-service";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreAuthFailureInput,
  DropshipMarketplaceStoreAuthFailureRecord,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";
import {
  buildEbayDropshipOrderIntakeInput,
  parseEbayMoneyCents,
  shouldRecordEbayDropshipOrder,
} from "../../infrastructure/dropship-ebay-order-intake.mapper";
import { EbayDropshipOrderIntakeProvider } from "../../infrastructure/dropship-ebay-order-intake.provider";
import { PgDropshipEbayOrderIntakeRepository } from "../../infrastructure/dropship-ebay-order-intake.repository";
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
      connection: { vendorId: 10, storeConnectionId: 22, lastOrderSyncAt: new Date("2026-05-03T15:30:00.000Z") },
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
      connection: { vendorId: 10, storeConnectionId: 22, lastOrderSyncAt: null },
      since: new Date("2026-05-03T15:15:00.000Z"),
      until: new Date("2026-05-03T15:30:00.000Z"),
    })).rejects.toMatchObject({ code: "DROPSHIP_EBAY_ORDER_INTAKE_HTTP_ERROR" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(credentials.authFailures).toHaveLength(0);
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

  it("isolates an immutable order conflict, records the other orders, and advances the cursor", async () => {
    const repository = new FakePollRepository();
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
      provider: {
        fetchOrders: vi.fn(async () => ({ ignored: 0, orders })),
      },
      orderIntakeService: { recordMarketplaceOrder },
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
    expect(repository.lastSuccess).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does not isolate malformed immutable-conflict errors", async () => {
    const repository = new FakePollRepository();
    const service = new DropshipEbayOrderIntakePollService({
      repository,
      provider: {
        fetchOrders: vi.fn(async () => ({ ignored: 0, orders: [makePollOrder("ORDER-1")] })),
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
    expect(repository.lastSuccess).toBeNull();
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
    expect(sql).toContain("platform = 'ebay'");
    expect(sql).toContain("status = 'connected'");
    expect(sql).toContain("setup_status = 'ready'");
    expect(sql).toContain("access_token_ref IS NOT NULL");
    expect(sql).toContain("refresh_token_ref IS NOT NULL");
    expect(params).toEqual([25]);
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
  lastSuccess: Parameters<DropshipEbayOrderIntakeRepository["markStorePollSucceeded"]>[0] | null = null;
  immutableConflicts: Array<Parameters<DropshipEbayOrderIntakeRepository["recordImmutableOrderConflict"]>[0]> = [];

  async listPollableStoreConnections(): Promise<DropshipEbayOrderIntakeStoreConnection[]> {
    return [{ vendorId: 10, storeConnectionId: 22, lastOrderSyncAt: null }];
  }

  async markStorePollSucceeded(
    input: Parameters<DropshipEbayOrderIntakeRepository["markStorePollSucceeded"]>[0],
  ): Promise<void> {
    this.lastSuccess = input;
  }

  async recordImmutableOrderConflict(
    input: Parameters<DropshipEbayOrderIntakeRepository["recordImmutableOrderConflict"]>[0],
  ): Promise<{ created: boolean }> {
    this.immutableConflicts.push(input);
    return { created: true };
  }
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
