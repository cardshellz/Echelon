import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requestLocalHttp } from "../helpers/local-http";
import http from "node:http";
import type { AddressInfo } from "node:net";

const idempotencyDbMocks = vi.hoisted(() => {
  const store = new Map<
    string,
    {
      key: string;
      requestHash: string;
      responseBody: any;
      createdAt: Date;
      expiresAt: Date | null;
    }
  >();

  return {
    store,
    lastQueriedKey: null as string | null,
    execute: vi.fn(async () => ({ rows: [] })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            const key = idempotencyDbMocks.lastQueriedKey;
            const row = key ? store.get(key) : undefined;
            return row ? [{ ...row }] : [];
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (val: any) => {
        if (store.has(val.key)) {
          const err: any = new Error("duplicate key value violates unique constraint");
          err.code = "23505";
          throw err;
        }
        store.set(val.key, {
          key: val.key,
          requestHash: val.requestHash,
          responseBody: val.responseBody ?? null,
          createdAt: new Date(),
          expiresAt: val.expiresAt ?? null,
        });
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((updates: any) => ({
        where: vi.fn(async () => {
          const key = idempotencyDbMocks.lastQueriedKey;
          if (key && store.has(key)) {
            const current = store.get(key)!;
            store.set(key, { ...current, ...updates });
          }
        }),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => {
        const key = idempotencyDbMocks.lastQueriedKey;
        if (key) {
          store.delete(key);
        }
      }),
    })),
  };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: vi.fn((col: any, val: any) => {
      if (typeof val === "string") {
        idempotencyDbMocks.lastQueriedKey = val;
      }
      return actual.eq(col, val);
    }),
  };
});

vi.mock("../../db", () => ({
  pool: {},
  db: {
    execute: idempotencyDbMocks.execute,
    select: idempotencyDbMocks.select,
    insert: idempotencyDbMocks.insert,
    update: idempotencyDbMocks.update,
    delete: idempotencyDbMocks.delete,
  },
}));

import {
  isIdempotencyRecordExpired,
  requireIdempotency,
  resetIdempotencyPruneThrottleForTest,
} from "../../middleware/idempotency";
import {
  resetPostgresSslWarningForTest,
  resolvePostgresPoolSslConfig,
} from "../../database-pool-config";
import { PostgresEbayListingPushRepository } from "../../modules/channels/infrastructure/ebay-listing-push.repository";
import { EbayAdapter } from "../../modules/channels/adapters/ebay.adapter";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readSrc(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

async function startTestServer(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

describe("P4.5 Platform Hygiene", () => {
  let server: Awaited<ReturnType<typeof startTestServer>> | null = null;

  beforeEach(() => {
    idempotencyDbMocks.store.clear();
    idempotencyDbMocks.lastQueriedKey = null;
    idempotencyDbMocks.execute.mockClear();
    resetIdempotencyPruneThrottleForTest();
    resetPostgresSslWarningForTest();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await server.close();
      server = null;
    }
  });

  describe("1. Idempotency middleware key expiry enforcement", () => {
    it("evaluates Date, ISO string, and null expiry boundaries accurately", () => {
      const nowMs = Date.parse("2026-11-19T18:00:00.000Z");
      expect(isIdempotencyRecordExpired(new Date("2026-11-19T17:59:59.000Z"), nowMs)).toBe(true);
      expect(isIdempotencyRecordExpired("2026-11-19T18:00:00.000Z", nowMs)).toBe(true);
      expect(isIdempotencyRecordExpired(new Date("2026-11-19T18:00:01.000Z"), nowMs)).toBe(false);
      expect(isIdempotencyRecordExpired(null, nowMs)).toBe(false);
    });

    it("reclaims expired completed keys instead of replaying stale responses or returning 409 on payload change", async () => {
      let executions = 0;
      const app = express();
      app.use(express.json());
      app.post("/api/test-expiry", requireIdempotency(), (req, res) => {
        executions += 1;
        return res.status(201).json({ executions, note: req.body?.note ?? null });
      });

      server = await startTestServer(app);

      // First request completes and stores 24h TTL
      const first = await requestLocalHttp(`${server.url}/api/test-expiry`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-ttl-1" },
        body: JSON.stringify({ note: "initial" }),
      });
      expect(first.status).toBe(201);
      expect(await first.json()).toEqual({ executions: 1, note: "initial" });

      // Non-expired replay returns cached response with Idempotency-Replayed: true
      const activeReplay = await requestLocalHttp(`${server.url}/api/test-expiry`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-ttl-1" },
        body: JSON.stringify({ note: "initial" }),
      });
      expect(activeReplay.status).toBe(201);
      expect(activeReplay.headers.get("idempotency-replayed")).toBe("true");
      expect(await activeReplay.json()).toEqual({ executions: 1, note: "initial" });
      expect(executions).toBe(1);

      // Expire the completed record past its 24h TTL
      const stored = idempotencyDbMocks.store.get("key-ttl-1")!;
      idempotencyDbMocks.store.set("key-ttl-1", {
        ...stored,
        expiresAt: new Date(Date.now() - 1_000),
      });

      // Re-using the expired key (even with a new payload!) reclaims it cleanly instead of 409 / stale replay
      const afterExpiry = await requestLocalHttp(`${server.url}/api/test-expiry`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-ttl-1" },
        body: JSON.stringify({ note: "fresh-after-ttl" }),
      });
      expect(afterExpiry.status).toBe(201);
      expect(afterExpiry.headers.get("idempotency-replayed")).toBeNull();
      expect(await afterExpiry.json()).toEqual({ executions: 2, note: "fresh-after-ttl" });
      expect(idempotencyDbMocks.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("2. PostgreSQL pool TLS configuration across all 4 runtime pools", () => {
    it("disables SSL on loopback and enforces verified TLS 1.2+ with SNI when CA or verify-full is configured", () => {
      expect(
        resolvePostgresPoolSslConfig("postgresql://postgres:postgres@127.0.0.1:5432/echelon_test", {}),
      ).toBeUndefined();

      const verifiedFromCa = resolvePostgresPoolSslConfig(
        "postgresql://user:pass@ec2-10-0-0-1.compute-1.amazonaws.com:5432/dbname",
        { DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\\nTESTCA\\n-----END CERTIFICATE-----" },
      );
      expect(verifiedFromCa).toEqual({
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        servername: "ec2-10-0-0-1.compute-1.amazonaws.com",
        ca: "-----BEGIN CERTIFICATE-----\nTESTCA\n-----END CERTIFICATE-----",
      });

      const verifiedFromRootCert = resolvePostgresPoolSslConfig(
        "postgresql://user:pass@db.example.com:5432/dbname?sslmode=verify-full&sslrootcert=/etc/ssl/certs/ca.crt",
        {},
        { readTextFile: () => "CA-BUNDLE-PEM" },
      );
      expect(verifiedFromRootCert).toEqual({
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        servername: "db.example.com",
        ca: "CA-BUNDLE-PEM",
      });
    });

    it("emits a single structured warning when falling back on managed cloud Postgres without a CA bundle", () => {
      const warn = vi.fn();
      const first = resolvePostgresPoolSslConfig(
        "postgresql://user:pass@ec2-10-0-0-1.compute-1.amazonaws.com:5432/dbname",
        { NODE_ENV: "production" },
        { warn },
      );
      const second = resolvePostgresPoolSslConfig(
        "postgresql://user:pass@ec2-10-0-0-1.compute-1.amazonaws.com:5432/dbname",
        { NODE_ENV: "production" },
        { warn },
      );

      expect(first).toEqual({ rejectUnauthorized: false, minVersion: "TLSv1.2" });
      expect(second).toEqual({ rejectUnauthorized: false, minVersion: "TLSv1.2" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("postgres_ssl_unverified_fallback");
    });

    it("wires all 4 runtime pools through resolvePostgresPoolSslConfig with zero inline rejectUnauthorized: false", () => {
      for (const relPath of [
        "server/db.ts",
        "server/index.ts",
        "server/infrastructure/scheduler-lock.ts",
      ]) {
        const src = readSrc(relPath);
        expect(src).toContain("resolvePostgresPoolSslConfig");
        expect(src).not.toContain("rejectUnauthorized: false");
      }
    });
  });

  describe("3. eBay PoolClient safety & non-stamp-synced-on-failure", () => {
    it("eliminates pinned pool.connect() clients across eBay route HTTP and multi-query loops", () => {
      expect(readSrc("server/routes/ebay/ebay-listings.routes.ts")).not.toContain("pool.connect()");
      expect(readSrc("server/routes/ebay/ebay-config.routes.ts")).not.toContain("pool.connect()");
    });

    it("discards a broken PoolClient when PostgresEbayListingPushRepository.withProductLock fails during lock query", async () => {
      const release = vi.fn();
      const mockPool: any = {
        connect: vi.fn().mockResolvedValue({
          query: vi.fn().mockRejectedValue(new Error("socket hang up during advisory lock")),
          release,
        }),
      };
      const repo = new PostgresEbayListingPushRepository(
        mockPool,
        67,
        () => new Date(),
        () => 20,
      );

      await expect(repo.withProductLock(42, async () => "ok")).rejects.toThrow(
        "socket hang up during advisory lock",
      );
      expect(release).toHaveBeenCalledWith(true);
    });

    it("refuses to report an eBay listing push as created/updated when live offer publication did not complete", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const adapter = new EbayAdapter({} as any, {} as any);
      vi.spyOn(adapter as any, "getApiClient").mockResolvedValue({});
      vi.spyOn(adapter as any, "getConnectionMetadata").mockResolvedValue({
        merchantLocationKey: "card-shellz-hq",
      });
      vi.spyOn(adapter as any, "delay").mockResolvedValue(undefined);
      vi.spyOn(adapter as any, "getChannelOverrides").mockResolvedValue(null);
      vi.spyOn(adapter as any, "getAuthService").mockResolvedValue({
        getEnvironment: () => "production",
        getVerifiedProviderAccount: async () => ({ externalAccountId: "seller-1" }),
      });
      (adapter as any).policies = {
        resolveProductPolicies: vi.fn().mockResolvedValue({
          scope: {
            channelId: 67,
            connectionId: 1,
            accountId: "seller-1",
            environment: "production",
            marketplaceId: "EBAY_US",
          },
          byVariantId: new Map([
            [
              101,
              {
                fulfillmentPolicyId: "fp-1",
                returnPolicyId: "rp-1",
                paymentPolicyId: "pp-1",
              },
            ],
          ]),
          packageRequirementsByVariantId: new Map(),
        }),
      };
      (adapter as any).photos = {
        resolve: vi.fn().mockResolvedValue({
          byVariantId: new Map([[101, ["https://img.example.com/1.jpg"]]]),
          groupImageUrls: ["https://img.example.com/1.jpg"],
        }),
      };
      vi.spyOn((adapter as any).listingBuilder, "buildListingDraft").mockReturnValue({
        inventoryItems: [],
        offers: [],
        itemGroup: null,
      });
      vi.spyOn((adapter as any).listingConnector, "pushListing").mockResolvedValue({
        productId: 42,
        status: "created",
        published: false,
        externalProductId: undefined,
        externalVariantIds: { 101: "offer-101" },
        externalOfferIds: { 101: "offer-101" },
      });

      const results = await adapter.pushListings(67, [
        {
          productId: 42,
          title: "Card Shellz Toploader",
          description: "Desc",
          variants: [
            {
              variantId: 101,
              sku: "TL-101",
              title: "Default",
              priceCents: 999,
              isListed: true,
            },
          ],
        } as any,
      ]);

      expect(results).toEqual([
        expect.objectContaining({
          productId: 42,
          status: "error",
        }),
      ]);
    });
  });

  describe("4. oms_order_events FK & dead legacy script retirement", () => {
    it("declares omsOrderEvents.orderId with onDelete: restrict in Drizzle schema", () => {
      const omsSchemaSrc = readSrc("shared/schema/oms.schema.ts");
      const eventsStart = omsSchemaSrc.indexOf('export const omsOrderEvents = omsSchema.table("oms_order_events"');
      const eventsBlock = omsSchemaSrc.slice(eventsStart, eventsStart + 320);
      expect(eventsBlock).toContain('{ onDelete: "restrict" }');
      expect(eventsBlock).not.toContain('{ onDelete: "cascade" }');
    });

    it("retires server/migrate.ts, server/seed.ts, and obsolete server/scripts/fix_* scripts", () => {
      expect(existsSync(resolve(ROOT, "server/migrate.ts"))).toBe(false);
      expect(existsSync(resolve(ROOT, "server/seed.ts"))).toBe(false);
      const serverScripts = readdirSync(resolve(ROOT, "server/scripts"));
      expect(serverScripts.filter((name) => name.startsWith("fix_"))).toEqual([]);
    });
  });
});
