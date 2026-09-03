import { describe, expect, it } from "vitest";

vi.mock("../../../../db", () => ({ pool: {} }));

import {
  DropshipReturnIntakePollService,
  resolveReturnPollSince,
  type DropshipReturnIntakePollRepository,
} from "../../application/dropship-return-intake-poll-service";
import {
  DropshipReturnIntakeService,
  buildReturnIntakeIdempotencyKey,
  buildRmaNumber,
  mapDraftItemsToOrder,
  DROPSHIP_RETURN_INTAKE_UNKNOWN_ORDER_CODE,
  type DropshipReturnIntakeRepository,
  type DropshipReturnIntakeOrderReference,
} from "../../application/dropship-return-intake-service";
import {
  dropshipReturnIntakeDraftSchema,
  type DropshipReturnIntakeDraft,
  type DropshipReturnIntakeProvider,
  type DropshipReturnIntakeStoreConnection,
} from "../../application/dropship-return-intake-provider";
import {
  buildEbayReturnIntakeDraft,
  mapEbayReturnReasonToFaultHint,
  shouldRecordEbayReturnCase,
  type EbayReturnCase,
} from "../../infrastructure/dropship-ebay-return-intake.mapper";
import { EbayDropshipReturnIntakeProvider } from "../../infrastructure/dropship-ebay-return-intake.provider";
import {
  buildShopifyReturnIntakeDraft,
  mapShopifyReturnReasonToFaultHint,
  parseShopifyMoneyCents,
  shouldRecordShopifyReturn,
  type ShopifyReturnNode,
} from "../../infrastructure/dropship-shopify-return-intake.mapper";
import { DropshipChannelReturnTrackingProvider } from "../../infrastructure/dropship-return-tracking.provider";
import { DropshipError } from "../../domain/errors";
import type { DropshipMarketplaceCredentialRepository } from "../../infrastructure/dropship-marketplace-credentials";

// ---------------------------------------------------------------------------
// eBay case → draft fixture mapping
// ---------------------------------------------------------------------------

describe("eBay return case → draft mapper", () => {
  it("maps a full eBay return case into a validated draft with label cost + tracking", () => {
    const draft = buildEbayReturnIntakeDraft({ returnCase: makeEbayReturnCase() });

    expect(dropshipReturnIntakeDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft).toMatchObject({
      channelReturnId: "ret-9001",
      orderRef: "11-11111-11111",
      labelCostCents: 735,
      faultHint: "vendor",
      items: [
        {
          channelLineId: "line-1",
          externalLineItemId: "line-1",
          sku: "SKU-101",
          quantity: 1,
        },
      ],
      returnTracking: {
        carrier: "USPS",
        trackingNumber: "9400111899223399001234",
        expectedDeliveryAt: new Date("2026-08-10T00:00:00.000Z"),
        status: "IN_TRANSIT",
      },
    });
    expect(draft.evidence.channel).toBe("ebay");
    expect(draft.evidence.labelCostCents).toBe(735);
    expect(draft.evidence.raw).toBeTruthy();
  });

  it("maps buyer-remorse reasons to a customer fault hint and null label cost when absent", () => {
    const draft = buildEbayReturnIntakeDraft({
      returnCase: {
        ...makeEbayReturnCase(),
        returnReason: "BUYER_REMORSE",
        comments: undefined,
        returnLabelCost: undefined,
        returnShipment: undefined,
      },
    });
    expect(draft.faultHint).toBe("customer");
    expect(draft.labelCostCents).toBeNull();
    expect(draft.returnTracking).toBeNull();
  });

  it("skips closed-no-refund and rejected cases", () => {
    expect(shouldRecordEbayReturnCase({
      returnCase: { ...makeEbayReturnCase(), state: "CLOSED_NO_REFUND" },
    })).toEqual({ record: false, reason: "ebay_return_state_closed_no_refund" });
    expect(shouldRecordEbayReturnCase({
      returnCase: { ...makeEbayReturnCase(), state: "RETURN_REJECTED" },
    })).toEqual({ record: false, reason: "ebay_return_state_return_rejected" });
    expect(shouldRecordEbayReturnCase({ returnCase: makeEbayReturnCase() })).toEqual({ record: true });
  });

  it("rejects a case with no order reference", () => {
    expect(() => buildEbayReturnIntakeDraft({
      returnCase: { ...makeEbayReturnCase(), orderId: undefined, legacyOrderId: undefined },
    })).toThrowError(/order reference/i);
  });

  it("rejects fractional-cent label costs (exact decimal parsing, no floats)", () => {
    expect(() => buildEbayReturnIntakeDraft({
      returnCase: {
        ...makeEbayReturnCase(),
        returnLabelCost: { value: "7.355", currency: "USD" },
      },
    })).toThrowError(/at most two fractional digits/i);
  });

  it("maps reason texts to fault hints", () => {
    expect(mapEbayReturnReasonToFaultHint("DEFECTIVE")).toBe("vendor");
    expect(mapEbayReturnReasonToFaultHint("ITEM_NOT_AS_DESCRIBED")).toBe("vendor");
    expect(mapEbayReturnReasonToFaultHint("BUYER_REMORSE")).toBe("customer");
    expect(mapEbayReturnReasonToFaultHint("ORDERED_BY_MISTAKE")).toBe("customer");
    expect(mapEbayReturnReasonToFaultHint("PACKAGE_LOST")).toBe("carrier");
    expect(mapEbayReturnReasonToFaultHint("OTHER")).toBeNull();
    expect(mapEbayReturnReasonToFaultHint(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Shopify refund/return → draft fixture mapping
// ---------------------------------------------------------------------------

describe("Shopify return → draft mapper", () => {
  it("maps a Shopify return with a Shopify Shipping label into a validated draft", () => {
    const draft = buildShopifyReturnIntakeDraft({ returnNode: makeShopifyReturnNode() });

    expect(dropshipReturnIntakeDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft).toMatchObject({
      channelReturnId: "gid://shopify/Return/7001",
      orderRef: "gid://shopify/Order/5001",
      labelCostCents: 690,
      faultHint: "vendor",
      items: [
        {
          channelLineId: "gid://shopify/ReturnLineItem/8801",
          externalLineItemId: "gid://shopify/LineItem/7701",
          sku: "SKU-101",
          quantity: 2,
        },
      ],
      returnTracking: {
        carrier: "USPS",
        trackingNumber: "9400111899223399009999",
        expectedDeliveryAt: null,
        status: "OPEN",
      },
    });
    expect(draft.evidence.channel).toBe("shopify");
  });

  it("keeps the return event with null label cost when no Shopify Shipping label exists", () => {
    const draft = buildShopifyReturnIntakeDraft({
      returnNode: {
        ...makeShopifyReturnNode(),
        reverseFulfillmentOrders: { nodes: [] },
      },
    });
    expect(draft.labelCostCents).toBeNull();
    expect(draft.returnTracking).toBeNull();
    expect(draft.channelReturnId).toBe("gid://shopify/Return/7001");
  });

  it("skips declined/cancelled returns", () => {
    expect(shouldRecordShopifyReturn({
      returnNode: { ...makeShopifyReturnNode(), status: "DECLINED" },
    })).toEqual({ record: false, reason: "shopify_return_status_declined" });
    expect(shouldRecordShopifyReturn({
      returnNode: { ...makeShopifyReturnNode(), status: "CANCELED" },
    })).toEqual({ record: false, reason: "shopify_return_status_canceled" });
    expect(shouldRecordShopifyReturn({ returnNode: makeShopifyReturnNode() })).toEqual({ record: true });
  });

  it("parses Shopify money exactly and rejects fractional cents", () => {
    expect(parseShopifyMoneyCents("12.90", "field")).toBe(1290);
    expect(parseShopifyMoneyCents("12.9", "field")).toBe(1290);
    expect(parseShopifyMoneyCents("7", "field")).toBe(700);
    expect(() => parseShopifyMoneyCents("12.999", "field")).toThrowError(/fractional digits/i);
  });

  it("maps Shopify return reasons to fault hints", () => {
    expect(mapShopifyReturnReasonToFaultHint("DEFECTIVE")).toBe("vendor");
    expect(mapShopifyReturnReasonToFaultHint("WRONG_ITEM")).toBe("vendor");
    expect(mapShopifyReturnReasonToFaultHint("UNWANTED")).toBe("customer");
    expect(mapShopifyReturnReasonToFaultHint("SIZE_TOO_SMALL")).toBe("customer");
    expect(mapShopifyReturnReasonToFaultHint("OTHER")).toBeNull();
    expect(mapShopifyReturnReasonToFaultHint(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Intake service: dedupe, unknown-order exception, item mapping
// ---------------------------------------------------------------------------

describe("DropshipReturnIntakeService", () => {
  it("creates an RMA in requested when no tracking is present", async () => {
    const repository = new FakeReturnIntakeRepository();
    repository.order = makeOrderReference();
    const service = makeService(repository);
    const draft = makeDraft({ returnTracking: null });

    const result = await service.recordChannelReturn({
      connection: makeConnection(),
      platform: "ebay",
      draft,
    });

    expect(result.outcome).toBe("created");
    expect(repository.createdRmas).toHaveLength(1);
    expect(repository.createdRmas[0]).toMatchObject({
      status: "requested",
      channelReturnId: draft.channelReturnId,
      intakeId: 4242,
      items: [{ productVariantId: 777, quantity: 1 }],
    });
  });

  it("creates an RMA in in_transit when tracking is present", async () => {
    const repository = new FakeReturnIntakeRepository();
    repository.order = makeOrderReference();
    const service = makeService(repository);

    const result = await service.recordChannelReturn({
      connection: makeConnection(),
      platform: "ebay",
      draft: makeDraft(),
    });

    expect(result.outcome).toBe("created");
    expect(repository.createdRmas[0]?.status).toBe("in_transit");
  });

  it("dedupes by channel return id — a re-polled return replays the existing RMA", async () => {
    const repository = new FakeReturnIntakeRepository();
    repository.order = makeOrderReference();
    repository.existingRma = { rmaId: 9001, rmaNumber: "RMA-CH-5-ABC" };
    const service = makeService(repository);

    const result = await service.recordChannelReturn({
      connection: makeConnection(),
      platform: "ebay",
      draft: makeDraft(),
    });

    expect(result).toEqual({ outcome: "replayed", rmaId: 9001, rmaNumber: "RMA-CH-5-ABC" });
    expect(repository.createdRmas).toHaveLength(0);
  });

  it("treats an insert unique conflict as a replay of the winner", async () => {
    const repository = new FakeReturnIntakeRepository();
    repository.order = makeOrderReference();
    repository.failNextCreateWithConflict = true;
    const service = makeService(repository);
    const draft = makeDraft();

    const first = await service.recordChannelReturn({
      connection: makeConnection(),
      platform: "ebay",
      draft,
    });
    expect(first.outcome).toBe("replayed");
  });

  it("queues an exception for an unknown order and never crashes", async () => {
    const repository = new FakeReturnIntakeRepository();
    repository.order = null;
    const service = makeService(repository);

    const result = await service.recordChannelReturn({
      connection: makeConnection(),
      platform: "shopify",
      draft: makeDraft({ orderRef: "gid://shopify/Order/unknown" }),
    });

    expect(result.outcome).toBe("exception");
    expect(result).toMatchObject({ failureCode: DROPSHIP_RETURN_INTAKE_UNKNOWN_ORDER_CODE });
    expect(repository.exceptions).toHaveLength(1);
    expect(repository.exceptions[0]).toMatchObject({
      platform: "shopify",
      failureCode: DROPSHIP_RETURN_INTAKE_UNKNOWN_ORDER_CODE,
    });
    expect(repository.createdRmas).toHaveLength(0);
  });

  it("queues an exception when no draft items map to the order", async () => {
    const repository = new FakeReturnIntakeRepository();
    repository.order = makeOrderReference();
    const service = makeService(repository);

    const result = await service.recordChannelReturn({
      connection: makeConnection(),
      platform: "ebay",
      draft: makeDraft({
        items: [{ channelLineId: "nope", externalLineItemId: "nope", sku: "NOPE", quantity: 1 }],
      }),
    });

    expect(result.outcome).toBe("exception");
    expect(repository.createdRmas).toHaveLength(0);
  });

  it("maps draft items by external line id first, then sku", () => {
    const order = makeOrderReference();
    const byLineId = mapDraftItemsToOrder({
      draft: makeDraft({
        items: [{ channelLineId: "x", externalLineItemId: "line-1", sku: "WRONG", quantity: 3 }],
      }),
      order,
    });
    expect(byLineId).toEqual([{ productVariantId: 777, quantity: 3 }]);

    const bySku = mapDraftItemsToOrder({
      draft: makeDraft({
        items: [{ channelLineId: "x", externalLineItemId: null, sku: "SKU-101", quantity: 2 }],
      }),
      order,
    });
    expect(bySku).toEqual([{ productVariantId: 777, quantity: 2 }]);
  });

  it("builds deterministic idempotency keys and RMA numbers", () => {
    expect(buildReturnIntakeIdempotencyKey({ storeConnectionId: 5, channelReturnId: "ret-1" }))
      .toBe("dropship:return-intake:5:ret-1");
    const a = buildRmaNumber({ storeConnectionId: 5, channelReturnId: "ret-1" });
    const b = buildRmaNumber({ storeConnectionId: 5, channelReturnId: "ret-1" });
    const c = buildRmaNumber({ storeConnectionId: 5, channelReturnId: "ret-2" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^RMA-CH-5-[0-9A-F]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Poll service: per-return error isolation + watermark advance (poison-pill
// regression, deep review 3.5)
// ---------------------------------------------------------------------------

describe("DropshipReturnIntakePollService", () => {
  it("advances the watermark even when a per-return record throws (poison-pill regression)", async () => {
    const repository = new FakePollRepository();
    repository.connections = [makeConnection()];
    const provider = new FakeProvider([
      makeDraft({ channelReturnId: "ret-bad" }),
      makeDraft({ channelReturnId: "ret-good" }),
    ]);
    const intakeService = new FakeIntakeService({
      "ret-bad": () => {
        throw new DropshipError("DROPSHIP_RETURN_INTAKE_BOOM", "boom.", { retryable: true });
      },
    });
    const service = new DropshipReturnIntakePollService({
      platform: "ebay",
      repository,
      provider,
      intakeService,
      clock: { now: () => new Date("2026-08-05T20:00:00.000Z") },
      logger: makeNullLogger(),
    });

    const result = await service.pollConnectedStores({
      limit: 10,
      initialLookbackMinutes: 60,
      overlapMinutes: 5,
    });

    expect(result.returnsFailed).toBe(1);
    expect(result.returnsCreated).toBe(1);
    expect(result.storesSucceeded).toBe(1);
    expect(result.storesFailed).toBe(0);
    // The watermark MUST have advanced despite the per-return failure.
    expect(repository.watermarks).toEqual([
      { storeConnectionId: 5, syncedThrough: new Date("2026-08-05T20:00:00.000Z") },
    ]);
  });

  it("does not advance the watermark when the provider fetch fails (store-level)", async () => {
    const repository = new FakePollRepository();
    repository.connections = [makeConnection()];
    const provider: DropshipReturnIntakeProvider = {
      fetchReturns: () => Promise.reject(new Error("ebay down")),
    };
    const service = new DropshipReturnIntakePollService({
      platform: "ebay",
      repository,
      provider,
      intakeService: new FakeIntakeService({}),
      clock: { now: () => new Date("2026-08-05T20:00:00.000Z") },
      logger: makeNullLogger(),
    });

    const result = await service.pollConnectedStores({
      limit: 10,
      initialLookbackMinutes: 60,
      overlapMinutes: 5,
    });

    expect(result.storesFailed).toBe(1);
    expect(result.storesSucceeded).toBe(0);
    expect(repository.watermarks).toHaveLength(0);
  });

  it("counts exceptions and replays without failing the store", async () => {
    const repository = new FakePollRepository();
    repository.connections = [makeConnection()];
    const provider = new FakeProvider([
      makeDraft({ channelReturnId: "ret-dup" }),
      makeDraft({ channelReturnId: "ret-exc" }),
    ]);
    const intakeService = new FakeIntakeService({
      "ret-dup": () => ({ outcome: "replayed", rmaId: 1, rmaNumber: "RMA-CH-5-X" }),
      "ret-exc": () => ({ outcome: "exception", exceptionId: 2, failureCode: "X" }),
    });
    const service = new DropshipReturnIntakePollService({
      platform: "shopify",
      repository,
      provider,
      intakeService,
      clock: { now: () => new Date("2026-08-05T20:00:00.000Z") },
      logger: makeNullLogger(),
    });

    const result = await service.pollConnectedStores({
      limit: 10,
      initialLookbackMinutes: 60,
      overlapMinutes: 5,
    });

    expect(result).toMatchObject({
      returnsReplayed: 1,
      returnsExcepted: 1,
      returnsFailed: 0,
      storesSucceeded: 1,
    });
    expect(repository.watermarks).toHaveLength(1);
  });

  it("resolves the poll window from the watermark with overlap, and from lookback when null", () => {
    const now = new Date("2026-08-05T20:00:00.000Z");
    expect(resolveReturnPollSince({
      lastReturnSyncAt: new Date("2026-08-05T19:00:00.000Z"),
      now,
      initialLookbackMinutes: 240,
      overlapMinutes: 15,
    })).toEqual(new Date("2026-08-05T18:45:00.000Z"));
    expect(resolveReturnPollSince({
      lastReturnSyncAt: null,
      now,
      initialLookbackMinutes: 240,
      overlapMinutes: 15,
    })).toEqual(new Date("2026-08-05T16:00:00.000Z"));
  });
});

// ---------------------------------------------------------------------------
// eBay Post-Order return intake provider
// ---------------------------------------------------------------------------

describe("EbayDropshipReturnIntakeProvider", () => {
  it("uses IAF authorization when searching eBay returns", async () => {
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(input)).toContain("/post-order/v2/return/search?");
      expect(new Headers(init?.headers).get("Authorization")).toBe("IAF token");
      return new Response(JSON.stringify({ returns: [], total: 0, limit: 50, offset: 0 }), {
        status: 200,
      });
    });
    const provider = new EbayDropshipReturnIntakeProvider(
      makeNullCredentials(),
      fetchImpl as typeof fetch,
    );

    await expect(provider.fetchReturns({
      connection: makeConnection(),
      since: new Date("2026-08-24T00:00:00.000Z"),
      until: new Date("2026-08-25T00:00:00.000Z"),
    })).resolves.toEqual({ drafts: [], ignored: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tracking provider wiring (PR 3 port)
// ---------------------------------------------------------------------------

describe("DropshipChannelReturnTrackingProvider", () => {
  it("returns null for non-eBay channels (Shopify best-effort)", async () => {
    const provider = new DropshipChannelReturnTrackingProvider({
      credentials: makeNullCredentials(),
      repository: {
        findChannelReturnForTracking: async () => ({ platform: "shopify", channel_return_id: "gid://shopify/Return/1" }),
      },
      fetchImpl: async () => {
        throw new Error("fetch must not be called for shopify");
      },
    });

    const snapshot = await provider.fetchReturnTracking({
      vendorId: 10,
      storeConnectionId: 5,
      trackingNumber: "9400",
    });
    expect(snapshot).toBeNull();
  });

  it("returns null when the store connection is null", async () => {
    const provider = new DropshipChannelReturnTrackingProvider({
      credentials: makeNullCredentials(),
      repository: {
        findChannelReturnForTracking: async () => {
          throw new Error("repository must not be called without a store connection");
        },
      },
    });
    expect(await provider.fetchReturnTracking({
      vendorId: 10,
      storeConnectionId: null,
      trackingNumber: "9400",
    })).toBeNull();
  });

  it("maps an eBay return detail shipment into a tracking snapshot", async () => {
    const fetchImpl = async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toContain("/post-order/v2/return/ret-9001");
      expect(new Headers(init?.headers).get("Authorization")).toBe("IAF token");
      return new Response(JSON.stringify({
        returnId: "ret-9001",
        returnShipment: {
          trackingNumber: "9400111899223399001234",
          carrierEnum: "USPS",
          status: "LOST",
          deliveredDate: null,
          shipmentTrackingEvents: [
            { status: "LABEL_CREATED", eventDate: "2026-08-01T10:00:00.000Z", description: "Label created" },
            { status: "LOST", eventDate: "2026-08-04T10:00:00.000Z", description: "Package lost" },
          ],
        },
      }), { status: 200 });
    };
    const provider = new DropshipChannelReturnTrackingProvider({
      credentials: makeNullCredentials(),
      repository: {
        findChannelReturnForTracking: async () => ({ platform: "ebay", channel_return_id: "ret-9001" }),
      },
      fetchImpl: fetchImpl as typeof fetch,
    });

    const snapshot = await provider.fetchReturnTracking({
      vendorId: 10,
      storeConnectionId: 5,
      trackingNumber: "9400111899223399001234",
    });

    expect(snapshot).toEqual({
      trackingNumber: "9400111899223399001234",
      carrierStatus: "LOST",
      deliveredAt: null,
      events: [
        { status: "LABEL_CREATED", occurredAt: "2026-08-01T10:00:00.000Z", description: "Label created" },
        { status: "LOST", occurredAt: "2026-08-04T10:00:00.000Z", description: "Package lost" },
      ],
    });
  });

  it("returns null when the eBay return detail has no matching shipment", async () => {
    const provider = new DropshipChannelReturnTrackingProvider({
      credentials: makeNullCredentials(),
      repository: {
        findChannelReturnForTracking: async () => ({ platform: "ebay", channel_return_id: "ret-9001" }),
      },
      fetchImpl: (async () => new Response(JSON.stringify({
        returnId: "ret-9001",
        returnShipment: { trackingNumber: "DIFFERENT" },
      }), { status: 200 })) as typeof fetch,
    });

    expect(await provider.fetchReturnTracking({
      vendorId: 10,
      storeConnectionId: 5,
      trackingNumber: "9400111899223399001234",
    })).toBeNull();
  });

  it("refreshes credentials before use and preserves the grant after an access-token 401", async () => {
    const credentials = makeNullCredentials();
    const credential = await credentials.loadForStoreConnection({
      vendorId: 10,
      storeConnectionId: 5,
      platform: "ebay",
    });
    const recordAuthFailure = vi.fn(async (input) => ({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: input.platform,
      previousStatus: "connected",
      status: input.status,
      transitioned: true,
    }));
    credentials.recordAuthFailure = recordAuthFailure;
    const loadFreshForStoreConnection = vi.fn(async () => credential);
    const provider = new DropshipChannelReturnTrackingProvider({
      credentials,
      ebayCredentials: { loadFreshForStoreConnection },
      repository: {
        findChannelReturnForTracking: async () => ({ platform: "ebay", channel_return_id: "ret-9001" }),
      },
      fetchImpl: (async () => new Response(
        JSON.stringify({ errors: [{ message: "Invalid token" }] }),
        { status: 401 },
      )) as typeof fetch,
      clock: { now: () => new Date("2026-09-03T12:00:00.000Z") },
    });

    await expect(provider.fetchReturnTracking({
      vendorId: 10,
      storeConnectionId: 5,
      trackingNumber: "9400111899223399001234",
    })).rejects.toMatchObject({
      code: "DROPSHIP_RETURN_TRACKING_HTTP_ERROR",
      context: { retryable: true, status: 401 },
    });
    expect(loadFreshForStoreConnection).toHaveBeenCalledWith({
      vendorId: 10,
      storeConnectionId: 5,
    });
    expect(recordAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      status: "refresh_failed",
      statusCode: 401,
      retryable: true,
      invalidateAccessToken: true,
    }));
  });
});

// ---------------------------------------------------------------------------
// Fakes + fixtures
// ---------------------------------------------------------------------------

import { vi } from "vitest";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type { DropshipReturnIntakeRecordResult } from "../../application/dropship-return-intake-service";

function makeNullLogger() {
  const events: DropshipLogEvent[] = [];
  return {
    events,
    info: (event: DropshipLogEvent) => { events.push(event); },
    warn: (event: DropshipLogEvent) => { events.push(event); },
    error: (event: DropshipLogEvent) => { events.push(event); },
  };
}

function makeConnection(): DropshipReturnIntakeStoreConnection {
  return { vendorId: 10, storeConnectionId: 5, lastReturnSyncAt: null };
}

function makeDraft(overrides: Partial<DropshipReturnIntakeDraft> = {}): DropshipReturnIntakeDraft {
  return {
    channelReturnId: "ret-9001",
    orderRef: "11-11111-11111",
    items: [{ channelLineId: "line-1", externalLineItemId: "line-1", sku: "SKU-101", quantity: 1 }],
    labelCostCents: 735,
    faultHint: "vendor",
    reasonText: "DEFECTIVE",
    evidence: { channel: "ebay" },
    returnTracking: {
      carrier: "USPS",
      trackingNumber: "9400111899223399001234",
      expectedDeliveryAt: new Date("2026-08-10T00:00:00.000Z"),
      status: "IN_TRANSIT",
    },
    ...overrides,
  };
}

function makeOrderReference(): DropshipReturnIntakeOrderReference {
  return {
    intakeId: 4242,
    storeConnectionId: 5,
    vendorId: 10,
    omsOrderId: 90001,
    lines: [
      { externalLineItemId: "line-1", sku: "SKU-101", productVariantId: 777 },
      { externalLineItemId: "line-2", sku: "SKU-102", productVariantId: 778 },
    ],
  };
}

class FakeReturnIntakeRepository implements DropshipReturnIntakeRepository {
  order: DropshipReturnIntakeOrderReference | null = null;
  existingRma: { rmaId: number; rmaNumber: string } | null = null;
  failNextCreateWithConflict = false;
  createdRmas: Array<Record<string, unknown> & { channelReturnId?: string; status?: string }> = [];
  exceptions: Array<Record<string, unknown>> = [];

  async findIntakeOrderByExternalId() {
    return this.order;
  }

  async findRmaByChannelReturnId() {
    return this.existingRma;
  }

  async createRmaFromChannelDraft(input: {
    draft: DropshipReturnIntakeDraft;
    status: "requested" | "in_transit";
    rmaNumber: string;
    intakeId: number;
    items: { productVariantId: number | null; quantity: number }[];
  }) {
    if (this.failNextCreateWithConflict) {
      this.failNextCreateWithConflict = false;
      this.existingRma = { rmaId: 9002, rmaNumber: input.rmaNumber };
      return { created: false, rmaId: 0, rmaNumber: input.rmaNumber };
    }
    this.createdRmas.push({
      status: input.status,
      channelReturnId: input.draft.channelReturnId,
      intakeId: input.intakeId,
      items: input.items,
    });
    this.existingRma = { rmaId: 9001, rmaNumber: input.rmaNumber };
    return { created: true, rmaId: 9001, rmaNumber: input.rmaNumber };
  }

  async recordException(input: Record<string, unknown> & { channelReturnId: string }) {
    this.exceptions.push(input);
    return { exceptionId: 500 + this.exceptions.length };
  }

  async resolvePolicyForStore() {
    return { policyId: 60, returnWindowDays: 45 };
  }
}

function makeService(repository: FakeReturnIntakeRepository): DropshipReturnIntakeService {
  return new DropshipReturnIntakeService({
    repository,
    clock: { now: () => new Date("2026-08-05T20:00:00.000Z") },
    logger: makeNullLogger(),
  });
}

class FakePollRepository implements DropshipReturnIntakePollRepository {
  connections: DropshipReturnIntakeStoreConnection[] = [];
  watermarks: { storeConnectionId: number; syncedThrough: Date }[] = [];

  async listPollableStoreConnections() {
    return this.connections;
  }

  async markStoreReturnPollSucceeded(input: { storeConnectionId: number; syncedThrough: Date }) {
    this.watermarks.push({
      storeConnectionId: input.storeConnectionId,
      syncedThrough: input.syncedThrough,
    });
  }
}

class FakeProvider implements DropshipReturnIntakeProvider {
  constructor(private readonly drafts: DropshipReturnIntakeDraft[]) {}

  async fetchReturns() {
    return { drafts: this.drafts, ignored: 0 };
  }
}

class FakeIntakeService implements Pick<DropshipReturnIntakeService, "recordChannelReturn"> {
  constructor(
    private readonly handlers: Record<string, () => DropshipReturnIntakeRecordResult>,
  ) {}

  async recordChannelReturn(input: { draft: DropshipReturnIntakeDraft }): Promise<DropshipReturnIntakeRecordResult> {
    const handler = this.handlers[input.draft.channelReturnId];
    if (handler) return handler();
    return { outcome: "created", rmaId: 1, rmaNumber: "RMA-CH-5-X" };
  }
}

function makeNullCredentials(): DropshipMarketplaceCredentialRepository {
  return {
    loadForStoreConnection: async () => ({
      vendorId: 10,
      storeConnectionId: 5,
      platform: "ebay",
      status: "connected",
      shopDomain: null,
      externalAccountId: "acct",
      providerEnvironment: "production",
      externalAccountIdentityScheme: null,
      externalAccountVerifiedAt: null,
      externalDisplayName: null,
      config: {},
      accessToken: "token",
      accessTokenRef: "ref",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      refreshToken: "refresh",
      refreshTokenRef: "refresh-ref",
      refreshTokenExpiresAt: null,
    }),
  } as unknown as DropshipMarketplaceCredentialRepository;
}

function makeEbayReturnCase(): EbayReturnCase {
  return {
    returnId: "ret-9001",
    orderId: "11-11111-11111",
    creationDate: "2026-08-03T14:30:00.000Z",
    state: "RETURN_REQUESTED",
    status: "OPEN",
    returnReason: "DEFECTIVE",
    comments: "Card arrived damaged",
    lineItems: [
      {
        lineItemId: "line-1",
        itemId: "listing-1",
        returnQuantity: 1,
        sku: "SKU-101",
        title: "Toploader",
      },
    ],
    returnLabelCost: { value: "7.35", currency: "USD" },
    returnShipment: {
      trackingNumber: "9400111899223399001234",
      carrierEnum: "USPS",
      status: "IN_TRANSIT",
      expectedDeliveryDate: "2026-08-10T00:00:00.000Z",
    },
  };
}

function makeShopifyReturnNode(): ShopifyReturnNode {
  return {
    id: "gid://shopify/Return/7001",
    name: "#1001-R1",
    status: "OPEN",
    createdAt: "2026-08-03T14:30:00.000Z",
    order: {
      id: "gid://shopify/Order/5001",
      legacyResourceId: "5001",
      name: "#1001",
    },
    returnLineItems: {
      nodes: [
        {
          id: "gid://shopify/ReturnLineItem/8801",
          quantity: 2,
          returnReason: "DEFECTIVE",
          returnReasonNote: "Damaged in transit",
          fulfillmentLineItem: {
            lineItem: {
              id: "gid://shopify/LineItem/7701",
              sku: "SKU-101",
            },
          },
        },
      ],
    },
    reverseFulfillmentOrders: {
      nodes: [
        {
          id: "gid://shopify/ReverseFulfillmentOrder/6601",
          status: "OPEN",
          label: {
            cost: { amount: "6.90", currencyCode: "USD" },
            trackingNumber: "9400111899223399009999",
            trackingUrl: "https://tools.usps.com/track/9400111899223399009999",
          },
          deliverable: {
            tracking: {
              number: "9400111899223399009999",
              carrierName: "USPS",
              url: "https://tools.usps.com/track/9400111899223399009999",
            },
          },
        },
      ],
    },
  };
}
