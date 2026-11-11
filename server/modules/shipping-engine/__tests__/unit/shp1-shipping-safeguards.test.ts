import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) =>
      (_req: unknown, _res: unknown, next: () => void) =>
        next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: requirePermissionMock,
}));

import {
  MAX_CHECKOUT_CALLBACK_ITEMS,
  RESPONSE_DEADLINE_MS,
  buildCheckoutSnapshotMetadata,
  parseShopifyRateRequest,
  registerCarrierCallbackRoutes,
  type CheckoutRateDependencies,
  type PersistCheckoutSnapshotInput,
} from "../../interfaces/http/carrier-callback.routes";
import { registerRateBookAdminRoutes } from "../../interfaces/http/rate-book-admin.routes";
import { computeRateTableDraftRevision } from "../../interfaces/http/rate-table-admin.routes";
import {
  ShipStationV2Error,
  createShipStationV2RatingAdapter,
  type V2RateRequest,
} from "../../infrastructure/shipstation-v2-rating.adapter";
import {
  ShipStationAccountConfigurationError,
  resolveSingleShipStationRuntimeAccount,
} from "../../../shipping/adapters/shipstation.adapter";
import {
  LineItemHoldEligibilityError,
  holdLineItemWithSplit,
} from "../../../wms/line-item-hold";
import { dispatchShipStationShipmentCancelRetry } from "../../../oms/webhook-retry.worker";

const SAMPLE_SHOPIFY_BODY = {
  rate: {
    origin: { postal_code: "89101", country: "US" },
    destination: {
      postal_code: "90210",
      country: "US",
      province_code: "CA",
    },
    items: [
      {
        sku: "SKU-1",
        quantity: 1,
        grams: 454,
        price: 1999,
      },
    ],
  },
};

function makeCheckoutDependencies(
  overrides: Partial<CheckoutRateDependencies> = {},
): CheckoutRateDependencies {
  return {
    originWarehouseId: () => 1,
    rolloutPolicy: () => ({
      mode: "live",
      testSkus: new Set(),
      invalidConfiguredMode: false,
    }),
    loadCatalogWeightsBySku: async () => new Map([["SKU-1", 454]]),
    loadCatalogShippingFactsBySku: async () =>
      new Map([
        [
          "SKU-1",
          {
            sku: "SKU-1",
            productVariantId: 101,
            weightGrams: 454,
            shippingGroupCode: null,
            shipsInOwnContainer: false,
          },
        ],
      ]),
    resolveChannelShipping: async () =>
      ({
        ok: true,
        channel: { id: 1, name: "Shopify", provider: "shopify" },
        decision: {
          mode: "engine_quoted",
          source: "channel_policy",
          policyId: 1,
          routeId: 1,
          rateBookId: 1,
        },
      }) as any,
    quoteShipment: async () =>
      ({
        ok: true,
        parcelPlan: {
          parcels: [{ weightGrams: 454 }],
          totalBillableWeightGrams: 454,
          warnings: [],
        },
        rates: {
          outcome: "quoted",
          rateBook: { id: 1, code: "shopify-retail-default" },
          zone: "Z2",
          quotes: [
            {
              serviceLevelId: 10,
              serviceLevelCode: "standard",
              displayName: "Standard Shipping",
              description: "3-5 business days",
              fulfillmentMode: "parcel",
              pricingBasis: "shipment_weight",
              totalCents: 699,
              currency: "USD",
              promiseMinBusinessDays: 3,
              promiseMaxBusinessDays: 5,
              ratedMeasure: 454,
              maxShipmentWeightGrams: null,
              chargeModel: "fixed_band",
              perStartedPoundCents: null,
              billablePounds: null,
              rateTableId: 50,
              productPolicyApplied: false,
              calculationTrace: [],
            },
          ],
          serviceLevelExclusions: [],
          warnings: [],
        },
      }) as any,
    loadDeliveryEstimates: async () => new Map(),
    persistSnapshot: async () => {},
    ...overrides,
  };
}

function invokeExpressHandler(
  app: express.Express,
  options: {
    method: "POST" | "PUT";
    url: string;
    body?: unknown;
    sessionUser?: Record<string, unknown> | null;
    destroyed?: boolean;
  },
): {
  statusCode: () => number;
  jsonBody: () => unknown;
  done: Promise<{ status: number; body: unknown }>;
  awaitHandler: Promise<void>;
} {
  let status = 200;
  let capturedBody: unknown = undefined;
  let resolveDone!: (value: { status: number; body: unknown }) => void;
  const done = new Promise<{ status: number; body: unknown }>((resolve) => {
    resolveDone = resolve;
  });

  const req: any = {
    method: options.method,
    url: options.url,
    path: options.url,
    params: {},
    body: options.body ?? {},
    headers: {},
    destroyed: Boolean(options.destroyed),
    session: options.sessionUser
      ? { user: options.sessionUser }
      : {},
  };
  const res: any = {
    destroyed: Boolean(options.destroyed),
    writableEnded: false,
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      capturedBody = payload;
      res.writableEnded = true;
      resolveDone({ status, body: payload });
      return res;
    },
  };

  // Match Express router layer directly without binding a TCP socket.
  const router = (app as any)._router;
  const matchLayer = router.stack.find((layer: any) => {
    if (!layer.route) return false;
    if (!layer.route.methods[options.method.toLowerCase()]) return false;
    return layer.match(options.url);
  });
  if (!matchLayer) {
    throw new Error(`No route matched ${options.method} ${options.url}`);
  }
  req.params = { ...matchLayer.params };
  const handlers = matchLayer.route.stack.map((s: any) => s.handle);

  const awaitHandler = (async () => {
    let idx = 0;
    const next = async (): Promise<void> => {
      const fn = handlers[idx++];
      if (!fn) return;
      await new Promise<void>((resolve, reject) => {
        let nextCalled = false;
        const maybePromise = fn(req, res, (err?: unknown) => {
          if (err) {
            reject(err);
            return;
          }
          nextCalled = true;
          void next().then(resolve, reject);
        });
        Promise.resolve(maybePromise)
          .then(() => {
            if (!nextCalled) resolve();
          })
          .catch(reject);
      });
    };
    await next();
  })();

  return {
    statusCode: () => status,
    jsonBody: () => capturedBody,
    done,
    awaitHandler,
  };
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.SHIPPING_CALLBACK_TOKEN;
});

describe("SHP-1 checkout callback deadline & snapshot truthfulness (SHIP-W02 / SP01)", () => {
  it("caps checkout callback line items to MAX_CHECKOUT_CALLBACK_ITEMS", () => {
    const oversized = {
      rate: {
        ...SAMPLE_SHOPIFY_BODY.rate,
        items: Array.from({ length: MAX_CHECKOUT_CALLBACK_ITEMS + 1 }, (_, index) => ({
          sku: `SKU-${index}`,
          quantity: 1,
          grams: 100,
        })),
      },
    };
    const parsed = parseShopifyRateRequest(oversized);
    expect(parsed.ok).toBe(false);
  });

  it("delivers HTTP rates BEFORE slow snapshot persistence and records truthful delivered metadata", async () => {
    process.env.SHIPPING_CALLBACK_TOKEN = "secret-callback-token";
    const events: string[] = [];
    let capturedSnapshot: PersistCheckoutSnapshotInput | null = null;
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });

    const app = express();
    registerCarrierCallbackRoutes(
      app,
      makeCheckoutDependencies({
        persistSnapshot: async (input) => {
          events.push("snapshot:start");
          capturedSnapshot = input;
          await snapshotGate;
          events.push("snapshot:done");
        },
      }),
    );

    const call = invokeExpressHandler(app, {
      method: "POST",
      url: "/api/shipping/rates-callback/secret-callback-token",
      body: SAMPLE_SHOPIFY_BODY,
    });

    const wireResponse = await call.done;
    events.push("wire:done");
    expect(wireResponse.status).toBe(200);
    expect((wireResponse.body as any).rates).toHaveLength(1);
    // Wire response completed BEFORE snapshot persistence finished!
    expect(events).toEqual(["snapshot:start", "wire:done"]);

    releaseSnapshot();
    await call.awaitHandler;
    expect(events).toEqual(["snapshot:start", "wire:done", "snapshot:done"]);

    const metadata = buildCheckoutSnapshotMetadata(capturedSnapshot!);
    expect(metadata).toMatchObject({
      wireDisposition: "delivered",
      timedOut: false,
      ratesReturned: 1,
      computedRatesCount: 1,
    });
  });

  it("returns empty rates at 2000ms deadline while recording ratesReturned=0 and computedRatesCount=1 in snapshot", async () => {
    vi.useFakeTimers();
    process.env.SHIPPING_CALLBACK_TOKEN = "secret-callback-token";
    let capturedSnapshot: PersistCheckoutSnapshotInput | null = null;

    const app = express();
    registerCarrierCallbackRoutes(
      app,
      makeCheckoutDependencies({
        quoteShipment: async () => {
          await new Promise((resolve) => setTimeout(resolve, RESPONSE_DEADLINE_MS + 500));
          return makeCheckoutDependencies().quoteShipment({} as any, {} as any);
        },
        persistSnapshot: async (input) => {
          capturedSnapshot = input;
        },
      }),
    );

    const call = invokeExpressHandler(app, {
      method: "POST",
      url: "/api/shipping/rates-callback/secret-callback-token",
      body: SAMPLE_SHOPIFY_BODY,
    });

    await vi.advanceTimersByTimeAsync(RESPONSE_DEADLINE_MS + 10);
    const wireResponse = await call.done;
    expect(wireResponse.status).toBe(200);
    expect(wireResponse.body).toEqual({ rates: [] });

    // Let background quote complete so snapshot lands.
    await vi.advanceTimersByTimeAsync(600);
    await call.awaitHandler;

    expect(capturedSnapshot).not.toBeNull();
    const metadata = buildCheckoutSnapshotMetadata(capturedSnapshot!);
    expect(metadata).toMatchObject({
      wireDisposition: "deadline_exceeded",
      timedOut: true,
      ratesReturned: 0,
      shopifyRates: [],
      computedRatesCount: 1,
    });
    expect((metadata.computedShopifyRates as unknown[]).length).toBe(1);
  });

  it("records client_disconnected and degrades snapshot DB failure without throwing", async () => {
    process.env.SHIPPING_CALLBACK_TOKEN = "secret-callback-token";
    let capturedSnapshot: PersistCheckoutSnapshotInput | null = null;

    const app = express();
    registerCarrierCallbackRoutes(
      app,
      makeCheckoutDependencies({
        persistSnapshot: async (input) => {
          capturedSnapshot = input;
          throw new Error("simulated DB outage");
        },
      }),
    );

    const call = invokeExpressHandler(app, {
      method: "POST",
      url: "/api/shipping/rates-callback/secret-callback-token",
      body: SAMPLE_SHOPIFY_BODY,
      destroyed: true,
    });

    await expect(call.awaitHandler).resolves.toBeUndefined();
    expect(capturedSnapshot).not.toBeNull();
    const metadata = buildCheckoutSnapshotMetadata(capturedSnapshot!);
    expect(metadata).toMatchObject({
      wireDisposition: "client_disconnected",
      ratesReturned: 0,
      computedRatesCount: 1,
    });
  });
});

describe("SHP-1 rate-book & rate-table concurrency CAS + audit guards (SP03 / SP04)", () => {
  it("rejects stale expectedUpdatedAt (409) and retired rate books under FOR UPDATE, and audits valid updates", async () => {
    const executedSql: string[] = [];
    const auditEvents: unknown[] = [];
    const currentUpdatedAt = new Date("2026-11-10T18:00:00.000Z");
    let bookRow = {
      id: 7,
      code: "shopify-retail",
      name: "Shopify Retail",
      status: "active",
      zoneSetId: 1,
      metadata: {},
      updatedAt: currentUpdatedAt,
    };

    const fakeTx: any = {
      execute: vi.fn(async () => {
        executedSql.push("FOR_UPDATE");
        return { rows: [{ id: 7 }] };
      }),
      select: vi.fn((projection?: unknown) => ({
        from: () => ({
          where: () => {
            if (projection) {
              return {
                orderBy: async () => [],
              };
            }
            return {
              limit: async () => [bookRow],
            };
          },
        }),
      })),
      update: vi.fn(() => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => [
              {
                ...bookRow,
                ...patch,
              },
            ],
          }),
        }),
      })),
      delete: vi.fn(() => ({
        where: async () => {},
      })),
      insert: vi.fn(() => ({
        values: async () => {},
      })),
    };

    const fakeDb: any = {
      transaction: async (fn: (tx: any) => Promise<unknown>) => fn(fakeTx),
    };

    const app = express();
    registerRateBookAdminRoutes(app, {
      database: fakeDb,
      audit: async (_tx, event) => {
        auditEvents.push(event);
      },
    });

    const superAdmin = { id: "op-1", username: "admin", role: "admin" };

    // 1. Stale expectedUpdatedAt -> 409 SHIPPING_ADMIN_RATE_BOOK_STALE
    const staleCall = invokeExpressHandler(app, {
      method: "PUT",
      url: "/api/shipping/admin/rate-books/7",
      body: {
        name: "Updated Name",
        expectedUpdatedAt: "2026-11-09T00:00:00.000Z",
      },
      sessionUser: superAdmin,
    });
    const staleRes = await staleCall.done;
    expect(staleRes.status).toBe(409);
    expect((staleRes.body as any).error.code).toBe("SHIPPING_ADMIN_RATE_BOOK_STALE");
    expect(executedSql).toContain("FOR_UPDATE");

    // 2. Matching expectedUpdatedAt -> 200 + audit event recorded
    const validCall = invokeExpressHandler(app, {
      method: "PUT",
      url: "/api/shipping/admin/rate-books/7",
      body: {
        name: "Updated Name",
        expectedUpdatedAt: currentUpdatedAt.toISOString(),
      },
      sessionUser: superAdmin,
    });
    const validRes = await validCall.done;
    expect(validRes.status).toBe(200);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "shipping.rate_book.updated",
      target: "shipping.rate_books:7",
    });

    // 3. Retired book under FOR UPDATE -> 409 SHIPPING_ADMIN_RATE_BOOK_RETIRED
    bookRow = { ...bookRow, status: "retired" };
    const retiredCall = invokeExpressHandler(app, {
      method: "PUT",
      url: "/api/shipping/admin/rate-books/7",
      body: { name: "Cannot Edit Retired" },
      sessionUser: superAdmin,
    });
    const retiredRes = await retiredCall.done;
    expect(retiredRes.status).toBe(409);
    expect((retiredRes.body as any).error.code).toBe("SHIPPING_ADMIN_RATE_BOOK_RETIRED");
  });

  it("computes deterministic draftRevision across rows, coverages, and product rules", () => {
    const baseInput = {
      rateTable: {
        id: 42,
        rateBookId: 7,
        serviceLevelId: 3,
        pricingBasis: "shipment_weight",
        currency: "USD",
        status: "draft",
      },
      rows: [
        {
          originWarehouseId: null,
          destinationCountry: "US",
          destinationRegion: "CA",
          postalPrefix: null,
          minMeasure: 0,
          maxMeasure: null,
          maxShipmentWeightGrams: null,
          chargeModel: "fixed_band",
          rateCents: 699,
          perStartedPoundCents: null,
        },
      ],
      coverages: [
        {
          destinationGroupId: 11,
          originWarehouseId: null,
          availability: "offered",
          destinationGroupLockVersion: 2,
          sortOrder: 0,
        },
      ],
      productRules: [
        {
          id: 99,
          kind: "restriction",
          action: "block",
          measurementScope: "matched_items",
          rateCents: null,
          perStartedPoundCents: null,
          perAdditionalUnitCents: null,
          thresholdCents: null,
          isActive: true,
          updatedAt: new Date("2026-11-10T12:00:00.000Z"),
        },
      ],
    };

    const rev1 = computeRateTableDraftRevision(baseInput);
    const rev2 = computeRateTableDraftRevision(baseInput);
    expect(rev1).toBe(rev2);
    expect(rev1).toMatch(/^rt-rev-1:[0-9a-f]{32}$/);

    // Changing row price changes revision
    const revRowChanged = computeRateTableDraftRevision({
      ...baseInput,
      rows: [{ ...baseInput.rows[0], rateCents: 799 }],
    });
    expect(revRowChanged).not.toBe(rev1);

    // Changing product rule changes revision
    const revRuleChanged = computeRateTableDraftRevision({
      ...baseInput,
      productRules: [{ ...baseInput.productRules[0], action: "free" }],
    });
    expect(revRuleChanged).not.toBe(rev1);
  });
});

describe("SHP-1 provider HTTP body timeout & single-account safeguards (FW-05)", () => {
  const RATE_REQ: V2RateRequest = {
    carrierIds: ["se-1"],
    from: { postalCode: "89101", countryCode: "US" },
    to: { postalCode: "90210", countryCode: "US" },
    parcels: [{ weightGrams: 500, lengthMm: 200, widthMm: 150, heightMm: 100 }],
  };

  it("aborts stalled response body streams with SHIPSTATION_V2_TIMEOUT", async () => {
    const adapter = createShipStationV2RatingAdapter({
      apiKey: "v2-key",
      baseUrl: "https://shipstation.example/v2",
      timeoutMs: 30,
      fetchFn: async () => {
        const stalledBody = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"rate_response":'));
            // Never closes -> simulates stalled body stream after 200 headers
          },
        });
        return new Response(stalledBody, { status: 200 });
      },
    });

    await expect(adapter.getRates(RATE_REQ)).rejects.toMatchObject({
      name: "ShipStationV2Error",
      code: "SHIPSTATION_V2_TIMEOUT",
    } satisfies Partial<ShipStationV2Error>);
  });

  it("fails closed with SHIPSTATION_V2_RESPONSE_TOO_LARGE on oversized response payloads", async () => {
    const adapter = createShipStationV2RatingAdapter({
      apiKey: "v2-key",
      baseUrl: "https://shipstation.example/v2",
      maxResponseBytes: 64,
      fetchFn: async () =>
        new Response(JSON.stringify({ padding: "x".repeat(256) }), {
          status: 200,
        }),
    });

    await expect(adapter.getRates(RATE_REQ)).rejects.toMatchObject({
      code: "SHIPSTATION_V2_RESPONSE_TOO_LARGE",
    });
  });

  it("enforces single-account ShipStation v1 runtime credentials", () => {
    expect(resolveSingleShipStationRuntimeAccount({})).toEqual({
      configured: false,
      accountFingerprint: null,
    });

    const configured = resolveSingleShipStationRuntimeAccount({
      SHIPSTATION_API_KEY: "primary-key",
      SHIPSTATION_API_SECRET: "primary-secret",
    });
    expect(configured.configured).toBe(true);
    if (configured.configured) {
      expect(configured.accountFingerprint).toMatch(/^ss-v1:[0-9a-f]{12}$/);
    }

    expect(() =>
      resolveSingleShipStationRuntimeAccount({
        SHIPSTATION_API_KEY: "primary-key",
      }),
    ).toThrowError(ShipStationAccountConfigurationError);

    expect(() =>
      resolveSingleShipStationRuntimeAccount({
        SHIPSTATION_API_KEY: "primary-key",
        SHIPSTATION_API_SECRET: "primary-secret",
        SHIPSTATION_SECONDARY_API_KEY: "second-account-key",
      }),
    ).toThrow(/single account per deployment/);
  });
});

describe("SHP-1 line-item hold concurrency & emptied shipment provider stop (FW-03 / FW-04)", () => {
  it("rejects holding a line that concurrently started picking under FOR UPDATE (FW-04)", async () => {
    const fakeDb = {
      transaction: async (fn: (tx: any) => Promise<unknown>) =>
        fn({
          execute: vi.fn(async () => ({
            rows: [
              {
                status: "in_progress",
                picked_quantity: 1,
                fulfilled_quantity: 0,
              },
            ],
          })),
        }),
    };

    await expect(
      holdLineItemWithSplit(fakeDb, {
        wmsOrderId: 100,
        orderItemId: 200,
        reason: "pre_order_hold",
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(LineItemHoldEligibilityError);
  });

  it("quarantines an emptied queued ShipStation shipment and invokes atomic cancel hook (FW-03)", async () => {
    const calls: number[] = [];
    let step = 0;
    const tx = {
      execute: vi.fn(async () => {
        step += 1;
        if (step === 1) {
          return {
            rows: [{ status: "pending", picked_quantity: 0, fulfilled_quantity: 0 }],
          };
        }
        if (step === 2) return { rows: [] }; // UPDATE order_items
        if (step === 3) {
          return {
            rows: [
              {
                id: 501,
                status: "queued",
                channel_id: 1,
                shipstation_order_id: 9001,
                engine_order_ref: "9001",
              },
            ],
          };
        }
        if (step === 4) return { rows: [{ id: 777 }] }; // INSERT held shipment
        if (step === 5) return { rows: [] }; // UPDATE outbound_shipment_items
        if (step === 6) return { rows: [{ n: 0 }] }; // COUNT remaining = 0!
        return { rows: [] }; // UPDATE main held=true
      }),
    };
    const fakeDb = {
      transaction: async (fn: (t: any) => Promise<unknown>) => fn(tx),
    };

    const result = await holdLineItemWithSplit(fakeDb, {
      wmsOrderId: 100,
      orderItemId: 200,
      reason: "customer_requested_hold",
      now: new Date("2026-11-10T20:00:00.000Z"),
      afterSplitInTransaction: async (_tx, split) => {
        if (split.providerSyncStatus === "queued_cancel" && split.mainShipmentId) {
          calls.push(split.mainShipmentId);
        }
      },
    });

    expect(result).toEqual({
      heldShipmentId: 777,
      mainShipmentId: 501,
      mainShipmentPushed: true,
      mainStillHasItems: false,
      providerSyncStatus: "queued_cancel",
    });
    expect(calls).toEqual([501]);
  });

  it("flags an emptied labeled shipment for operator review instead of erasing physical label truth (FW-03)", async () => {
    let step = 0;
    const tx = {
      execute: vi.fn(async () => {
        step += 1;
        if (step === 1) {
          return {
            rows: [{ status: "pending", picked_quantity: 0, fulfilled_quantity: 0 }],
          };
        }
        if (step === 3) {
          return {
            rows: [
              {
                id: 502,
                status: "labeled",
                channel_id: 1,
                shipstation_order_id: 9002,
                engine_order_ref: "9002",
              },
            ],
          };
        }
        if (step === 4) return { rows: [{ id: 778 }] };
        if (step === 6) return { rows: [{ n: 0 }] };
        return { rows: [] };
      }),
    };
    const fakeDb = {
      transaction: async (fn: (t: any) => Promise<unknown>) => fn(tx),
    };

    const result = await holdLineItemWithSplit(fakeDb, {
      wmsOrderId: 100,
      orderItemId: 201,
      reason: "address_hold",
      now: new Date("2026-11-10T20:00:00.000Z"),
    });

    expect(result.providerSyncStatus).toBe("review_required_labeled");
  });

  it("escalates to requires_review when provider reports already_shipped during shipment cancel retry (FW-03)", async () => {
    const cancelSpy = vi.fn(async () => ({ state: "already_shipped" as const }));
    let updatedForReview = false;
    const fakeDb: any = {
      __shippingEngine: {
        cancel: cancelSpy,
      },
      execute: vi.fn(async (query: any) => {
        const text = JSON.stringify(query);
        if (text.includes("remaining_items")) {
          return {
            rows: [
              {
                id: 501,
                status: "queued",
                shipping_engine: "shipstation",
                engine_order_ref: "9001",
                engine_shipment_ref: "echelon-wms-shp-501",
                shipstation_order_id: 9001,
                shipstation_order_key: "echelon-wms-shp-501",
                remaining_items: 0,
              },
            ],
          };
        }
        if (text.includes("provider_already_shipped_held_line")) {
          updatedForReview = true;
        }
        return { rows: [] };
      }),
      update: vi.fn(() => ({
        set: () => ({
          where: async () => {},
        }),
      })),
    };

    const outcome = await dispatchShipStationShipmentCancelRetry(fakeDb, {
      id: 88,
      provider: "internal",
      topic: "shipstation_shipment_cancel",
      payload: { shipmentId: 501 },
      attempts: 0,
    } as any);

    expect(outcome).toBe("success");
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(updatedForReview).toBe(true);
  });
});
