import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelConnections, channelFeeds } from "@shared/schema";
import {
  ARCHIVABLE_REPLEN_TASK_STATUSES,
  archiveProductReplenishmentInTx,
  cancelProductReplenishmentTasksInTx,
} from "../../../inventory/infrastructure/replenishment-archive.repository";
import {
  assertShopifyImportStoreMatchesDefaultChannel,
  filterConnectionOwnedShopifyProducts,
  normalizeImportShopDomain,
} from "../../shopify-import-connection-guard";
import {
  fetchOrdersFulfillmentStatus,
  fetchShopifyCatalogProducts,
  fetchShopifyWithRetry,
  MAX_SHOPIFY_PAGINATION_PAGES,
  MAX_SHOPIFY_RATE_LIMIT_RETRIES,
  SHOPIFY_REQUEST_TIMEOUT_MS,
} from "../../../integrations/shopify";

describe("Catalog Archive Replenishment Participant & Shopify Transport Bounds (CAT-2)", () => {
  describe("Replenishment Archive Transaction Participant (CWF-F03 / CI-01)", () => {
    it("locks archivable tasks (including blocked), validates transitions, bumps revision, and deactivates rules inside the caller transaction", async () => {
      const now = new Date("2026-11-08T18:00:00.000Z");
      const updateSets: Array<Record<string, unknown>> = [];
      const forUpdateSpy = vi.fn(async () => [
        { id: 11, status: "pending" },
        { id: 12, status: "in_progress" },
        { id: 15, status: "blocked" },
      ]);

      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                for: forUpdateSpy,
              })),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn((values: Record<string, unknown>) => {
            updateSets.push(values);
            return {
              where: vi.fn(() => ({
                returning: vi.fn(async () =>
                  values.status === "cancelled"
                    ? [{ id: 11 }, { id: 12 }, { id: 15 }]
                    : [{ id: 1 }, { id: 2 }],
                ),
              })),
            };
          }),
        })),
      };

      const result = await archiveProductReplenishmentInTx(tx as any, 42, now);

      expect(ARCHIVABLE_REPLEN_TASK_STATUSES).toEqual([
        "pending",
        "assigned",
        "in_progress",
        "blocked",
      ]);
      expect(forUpdateSpy).toHaveBeenCalledWith("update");
      expect(result).toEqual({
        replenDeactivated: 2,
        replenTasksCancelled: 3,
      });
      expect(updateSets).toHaveLength(2);
      expect(updateSets[0]).toEqual({ isActive: 0, updatedAt: now });
      expect(updateSets[1]).toMatchObject({
        status: "cancelled",
        completedAt: now,
      });
      expect(updateSets[1]).toHaveProperty("revision");
    });

    it("rejects an illegal task status transition before issuing an UPDATE on replen_tasks", async () => {
      const updateSpy = vi.fn();
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                for: vi.fn(async () => [{ id: 99, status: "completed" }]),
              })),
            })),
          })),
        })),
        update: updateSpy,
      };

      await expect(
        cancelProductReplenishmentTasksInTx(tx as any, 42, new Date()),
      ).rejects.toThrow(/Cannot transition replenishment task from completed to cancelled/);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("keeps direct replenRules and replenTasks writes out of catalog.storage.ts and catalog-inventory-command.repository.ts", () => {
      const cmdRepo = readFileSync(
        resolve(
          process.cwd(),
          "server/modules/catalog/infrastructure/catalog-inventory-command.repository.ts",
        ),
        "utf8",
      );
      const catalogStorage = readFileSync(
        resolve(process.cwd(), "server/modules/catalog/catalog.storage.ts"),
        "utf8",
      );
      expect(cmdRepo).toContain("archiveProductReplenishmentInTx(tx, command.sourceId, now)");
      expect(cmdRepo).not.toContain("tx.update(replenRules)");
      expect(cmdRepo).not.toContain("tx.update(replenTasks)");
      expect(catalogStorage).not.toContain("db.update(replenRules)");
      expect(catalogStorage).not.toContain("db.update(replenTasks)");
    });
  });

  describe("Shopify Store / Channel Identity Guard (PI-F03)", () => {
    it("normalizes bare store names, URLs, and case into canonical myshopify domains", () => {
      expect(normalizeImportShopDomain("Card-Shellz")).toBe("card-shellz.myshopify.com");
      expect(normalizeImportShopDomain("https://CARD-SHELLZ.myshopify.com/admin")).toBe(
        "card-shellz.myshopify.com",
      );
    });

    it("allows import when SHOPIFY_SHOP_DOMAIN matches the default Shopify channel shop_domain", async () => {
      const database = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ shop_domain: "card-shellz.myshopify.com" }] })
          .mockResolvedValueOnce({ rows: [] }),
      };

      const rows = [{ shopifyProductId: 101, tags: [] }];
      const filtered = await filterConnectionOwnedShopifyProducts(rows, database as any, {
        expectedShopDomain: "card-shellz",
      });

      expect(filtered).toEqual(rows);
      expect(database.execute).toHaveBeenCalledTimes(2);
    });

    it("rejects import with SHOPIFY_IMPORT_STORE_MISMATCH when SHOPIFY_SHOP_DOMAIN differs from the default Shopify channel", async () => {
      const database = {
        execute: vi.fn().mockResolvedValueOnce({
          rows: [{ shop_domain: "card-shellz.myshopify.com" }],
        }),
      };

      await expect(
        assertShopifyImportStoreMatchesDefaultChannel(
          "wrong-staging-store.myshopify.com",
          database as any,
        ),
      ).rejects.toMatchObject({
        code: "SHOPIFY_IMPORT_STORE_MISMATCH",
        expectedShopDomain: "wrong-staging-store.myshopify.com",
        channelShopDomain: "card-shellz.myshopify.com",
      });
    });
  });

  describe("Shopify Transport Timeout, 429 Retry Cap & Pagination Guards (PI-F01 / EA-W02)", () => {
    const originalDomain = process.env.SHOPIFY_SHOP_DOMAIN;
    const originalToken = process.env.SHOPIFY_ACCESS_TOKEN;

    beforeEach(() => {
      process.env.SHOPIFY_SHOP_DOMAIN = "card-shellz.myshopify.com";
      process.env.SHOPIFY_ACCESS_TOKEN = "shpat_test_token";
    });

    afterEach(() => {
      if (originalDomain === undefined) delete process.env.SHOPIFY_SHOP_DOMAIN;
      else process.env.SHOPIFY_SHOP_DOMAIN = originalDomain;
      if (originalToken === undefined) delete process.env.SHOPIFY_ACCESS_TOKEN;
      else process.env.SHOPIFY_ACCESS_TOKEN = originalToken;
    });

    it("exports deterministic transport timeout, 429 retry, and pagination page constants", () => {
      expect(SHOPIFY_REQUEST_TIMEOUT_MS).toBe(30_000);
      expect(MAX_SHOPIFY_RATE_LIMIT_RETRIES).toBe(5);
      expect(MAX_SHOPIFY_PAGINATION_PAGES).toBe(200);
    });

    it("attaches AbortSignal.timeout and caps 429 retries in fetchShopifyWithRetry", async () => {
      let seenSignal: AbortSignal | null | undefined;
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        seenSignal = init?.signal;
        return new Response("Too Many Requests", { status: 429 });
      });

      await expect(
        fetchShopifyWithRetry("https://card-shellz.myshopify.com/admin/api/2024-01/products.json", "token", {
          maxRetries: 2,
          retryDelayMs: 1,
          timeoutMs: 5000,
          fetchImpl: fetchImpl as any,
        }),
      ).rejects.toThrow("Shopify API rate limit exceeded after 2 retries (429)");

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(seenSignal).toBeDefined();
    });

    it("detects pagination cursor cycles in fetchShopifyCatalogProducts", async () => {
      const fetchImpl = vi.fn(async () => {
        return new Response(JSON.stringify({ products: [] }), {
          status: 200,
          headers: {
            Link: '<https://card-shellz.myshopify.com/admin/api/2024-01/products.json?limit=250&page_info=CURSOR_LOOP>; rel="next"',
          },
        });
      });

      await expect(
        fetchShopifyCatalogProducts({
          fetchImpl: fetchImpl as any,
          retryDelayMs: 1,
        }),
      ).rejects.toThrow("Shopify catalog pagination cursor cycle detected: CURSOR_LOOP");

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("caps 429 retries in fetchOrdersFulfillmentStatus instead of looping forever", async () => {
      const fetchImpl = vi.fn(async () => new Response("Rate limited", { status: 429 }));

      await expect(
        fetchOrdersFulfillmentStatus(["1001", "1002"], {
          fetchImpl: fetchImpl as any,
          maxRetries: 2,
          retryDelayMs: 1,
        }),
      ).rejects.toThrow("Shopify API rate limit exceeded after 2 retries (429)");

      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
  });

  describe("Catalog Export PostgreSQL Integration Fixture (COM-03 / EA-W04)", () => {
    it("aligns channels.channel_connections and channels.channel_feeds DDL with Drizzle schema columns", () => {
      const testSource = readFileSync(
        resolve(
          process.cwd(),
          "server/modules/catalog-export/__tests__/integration/postgres-catalog-export.repository.integration.test.ts",
        ),
        "utf8",
      );

      for (const table of [channelConnections, channelFeeds]) {
        const config = getTableConfig(table);
        const tablePattern = new RegExp(
          `CREATE TABLE IF NOT EXISTS ${config.schema}\\.${config.name} \\(([\\s\\S]*?)\\n  \\);`,
        );
        const tableBody = testSource.match(tablePattern)?.[1];
        expect(tableBody, `missing DDL for ${config.schema}.${config.name}`).toBeDefined();

        for (const column of config.columns) {
          expect(
            tableBody,
            `missing column ${config.schema}.${config.name}.${column.name}`,
          ).toMatch(new RegExp(`^    ${column.name}\\s`, "m"));
        }
      }
    });
  });
});
