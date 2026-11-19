import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POSTGRES_TEST_FILES } from "../../../../../scripts/ci/postgres-test-manifest";
import {
  DISCOVER_FEEDS_BATCH_SIZE,
  createChannelSyncService,
  type FeedDiscoveryIdentityPort,
} from "../../sync.service";
import {
  MAX_SHOPIFY_RETRY_AFTER_MS,
  fetchOrdersFulfillmentStatus,
  fetchUnfulfilledOrders,
  resolveShopifyRetryDelayMs,
} from "../../../integrations/shopify";
import {
  createDefaultShopifyAdminClient,
  shopifyGraphQL,
} from "../../../shopify/admin-gql-client";
import { shopifyGraphQL as subscriptionReExportedGraphQL } from "../../../subscriptions/infrastructure/shopify.adapter";

describe("CHN-1 Sales Channels and Listings Safeguards (COM-03, COM-04, COM-05, COM-06, COM-07)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("COM-03 (C-B2): PostgreSQL CI manifest registration for catalog-export and channels integration suites", () => {
    it("includes catalog-export and channels eBay PostgreSQL integration suites in POSTGRES_TEST_FILES", () => {
      expect(POSTGRES_TEST_FILES).toContain(
        "server/modules/catalog-export/__tests__/integration/postgres-catalog-export.repository.integration.test.ts",
      );
      expect(POSTGRES_TEST_FILES).toContain(
        "server/modules/channels/__tests__/integration/ebay-auth-refresh.integration.test.ts",
      );
      expect(POSTGRES_TEST_FILES).toContain(
        "server/modules/channels/__tests__/integration/ebay-listing-push.integration.test.ts",
      );
    });
  });

  describe("COM-04 (C-B5): Bounded & pre-filtered discoverFeeds and batched getDivergence", () => {
    it("skips listingIdentities completely when all candidate variants already have feeds or are excluded by product lines", async () => {
      const selectResults = [
        [{ id: 10, status: "active", provider: "shopify" }],
        [
          { id: 101, productId: 1, sku: "SKU-101", isActive: true, requiresShipping: true, trackInventory: true, salesEligibility: "sellable" },
          { id: 102, productId: 2, sku: "SKU-102", isActive: true, requiresShipping: true, trackInventory: true, salesEligibility: "sellable" },
        ],
        [{ channelId: 10, productVariantId: 101 }],
        [{ channelId: 10, productLineId: 50, isActive: true }],
        [{ productId: 1, productLineId: 50 }], // product 2 is not in line 50
      ];
      let selectIndex = 0;
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => {
            const rows = selectResults[selectIndex++] ?? [];
            const queryPromise = Promise.resolve(rows) as Promise<any> & {
              where: () => Promise<any>;
            };
            queryPromise.where = vi.fn(() => Promise.resolve(rows));
            return queryPromise;
          }),
        })),
      };

      const identityPort: FeedDiscoveryIdentityPort = {
        listingIdentities: vi.fn(async () => []),
        ensureShopifyFeed: vi.fn(async () => ({}) as any),
      };

      const service = createChannelSyncService(db, {}, () => identityPort);
      const outcome = await service.discoverFeeds();

      expect(outcome).toEqual({ created: 0, channels: 1, blocked: [] });
      expect(identityPort.listingIdentities).not.toHaveBeenCalled();
      expect(identityPort.ensureShopifyFeed).not.toHaveBeenCalled();
    });

    it("batches candidate variant listing lookups by DISCOVER_FEEDS_BATCH_SIZE and creates missing feeds once", async () => {
      const variants = Array.from({ length: DISCOVER_FEEDS_BATCH_SIZE + 5 }, (_, i) => ({
        id: i + 1,
        productId: 1,
        sku: `SKU-${i + 1}`,
        isActive: true,
        requiresShipping: true,
        trackInventory: true,
        salesEligibility: "sellable",
      }));

      const selectResults = [
        [{ id: 20, status: "active", provider: "shopify" }],
        variants,
        [], // no existing feeds
        [], // no channel product line restriction
        [],
      ];
      let selectIndex = 0;
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => {
            const rows = selectResults[selectIndex++] ?? [];
            const queryPromise = Promise.resolve(rows) as Promise<any> & {
              where: () => Promise<any>;
            };
            queryPromise.where = vi.fn(() => Promise.resolve(rows));
            return queryPromise;
          }),
        })),
      };

      const identityPort: FeedDiscoveryIdentityPort = {
        listingIdentities: vi.fn(async (_channelId: number, batchIds: readonly number[]) =>
          batchIds
            .filter((id: number) => id === 1 || id === DISCOVER_FEEDS_BATCH_SIZE + 2)
            .map((id: number) => ({ productVariantId: id, externalVariantId: `ext-${id}` }) as any),
        ),
        ensureShopifyFeed: vi.fn(async () => ({}) as any),
      };

      const service = createChannelSyncService(db, {}, () => identityPort);
      const outcome = await service.discoverFeeds();

      expect(outcome).toEqual({ created: 2, channels: 1, blocked: [] });
      expect(identityPort.listingIdentities).toHaveBeenCalledTimes(2);
      expect(vi.mocked(identityPort.listingIdentities).mock.calls[0][1]).toHaveLength(
        DISCOVER_FEEDS_BATCH_SIZE,
      );
      expect(vi.mocked(identityPort.listingIdentities).mock.calls[1][1]).toHaveLength(5);
      expect(identityPort.ensureShopifyFeed).toHaveBeenCalledTimes(2);
    });

    it("batch-loads productVariants once in getDivergence instead of querying per feed", async () => {
      const selectResults = [
        [
          { productVariantId: 101, channelId: 10, channelType: "shopify", lastSyncedQty: 5, lastSyncedAt: null },
          { productVariantId: 102, channelId: 10, channelType: "shopify", lastSyncedQty: 8, lastSyncedAt: null },
        ],
        [
          { id: 101, productId: 1, requiresShipping: true, trackInventory: true, salesEligibility: "sellable" },
          { id: 102, productId: 1, requiresShipping: true, trackInventory: true, salesEligibility: "sellable" },
        ],
      ];
      let selectCalls = 0;
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve(selectResults[selectCalls++] ?? [])),
          })),
        })),
      };
      const atpService = {
        getAtpPerVariant: vi.fn(async () => [
          { productVariantId: 101, sku: "S1", name: "N1", unitsPerVariant: 1, atpUnits: 5, atpBase: 5 },
          { productVariantId: 102, sku: "S2", name: "N2", unitsPerVariant: 1, atpUnits: 3, atpBase: 3 },
        ]),
      };

      const service = createChannelSyncService(db, atpService);
      const divergent = await service.getDivergence();

      expect(selectCalls).toBe(2); // 1 for channelFeeds + 1 batched query for productVariants
      expect(atpService.getAtpPerVariant).toHaveBeenCalledTimes(1);
      expect(divergent).toEqual([
        {
          productVariantId: 102,
          channelId: 10,
          channelType: "shopify",
          lastSyncedQty: 8,
          currentAtpUnits: 3,
          lastSyncedAt: null,
        },
      ]);
    });
  });

  describe("COM-05 (C-B3): Bounded 429 retry, Retry-After header clamping, and AbortSignal timeout", () => {
    it("parses and clamps Retry-After header values within MAX_SHOPIFY_RETRY_AFTER_MS", () => {
      expect(resolveShopifyRetryDelayMs(null, 2000)).toBe(2000);
      expect(resolveShopifyRetryDelayMs("invalid", 2000)).toBe(2000);
      expect(resolveShopifyRetryDelayMs("1.5", 2000)).toBe(1500);
      expect(resolveShopifyRetryDelayMs("60", 2000)).toBe(MAX_SHOPIFY_RETRY_AFTER_MS);
    });

    it("retries 429 on fetchOrdersFulfillmentStatus and fetchUnfulfilledOrders with bounded retries and timeout signal", async () => {
      process.env.SHOPIFY_SHOP_DOMAIN = "test-store.myshopify.com";
      process.env.SHOPIFY_ACCESS_TOKEN = "shpat_test";

      let calls = 0;
      const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        calls++;
        if (calls === 1) {
          return new Response("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "0.001" },
          });
        }
        return new Response(
          JSON.stringify({
            orders: [{ id: 9001, fulfillment_status: "fulfilled", cancelled_at: null }],
          }),
          { status: 200 },
        );
      });

      const statuses = await fetchOrdersFulfillmentStatus(["9001"], {
        fetchImpl: fetchMock,
        maxRetries: 2,
        retryDelayMs: 1,
      });

      expect(calls).toBe(2);
      expect(statuses).toEqual([
        { shopifyOrderId: "9001", fulfillmentStatus: "fulfilled", cancelledAt: null },
      ]);

      const always429 = vi.fn<typeof fetch>(
        async () => new Response("Rate limited", { status: 429, headers: { "Retry-After": "0.001" } }),
      );
      await expect(
        fetchUnfulfilledOrders({
          fetchImpl: always429,
          maxRetries: 2,
          retryDelayMs: 1,
        }),
      ).rejects.toThrow(/Shopify API rate limit exceeded after 2 retries \(429\)/);
      expect(always429).toHaveBeenCalledTimes(3);
    });
  });

  describe("COM-06 (C-B5): Neutral technical Shopify Admin GraphQL Client without subscriptions coupling", () => {
    it("executes GraphQL in server/modules/shopify/admin-gql-client.ts with zero import of modules/subscriptions", () => {
      const adminClientPath = path.resolve(
        __dirname,
        "../../../shopify/admin-gql-client.ts",
      );
      const source = fs.readFileSync(adminClientPath, "utf8");
      expect(source).not.toContain("subscriptions");
      expect(subscriptionReExportedGraphQL).toBe(shopifyGraphQL);
      expect(typeof createDefaultShopifyAdminClient().request).toBe("function");
    });
  });

  describe("COM-07 (C-B4): Retirement of dead direct-push tail in channels/sync.service.ts", () => {
    it("contains no dead direct-push helpers or raw inventory_levels/set.json fetch calls in sync.service.ts", () => {
      const syncServicePath = path.resolve(__dirname, "../../sync.service.ts");
      const source = fs.readFileSync(syncServicePath, "utf8");
      expect(source).not.toContain("pushWithRetry");
      expect(source).not.toContain("pushToChannel");
      expect(source).not.toContain("pushToShopify");
      expect(source).not.toContain("pushToShopifyLocation");
      expect(source).not.toContain("inventory_levels/set.json");
    });
  });
});
