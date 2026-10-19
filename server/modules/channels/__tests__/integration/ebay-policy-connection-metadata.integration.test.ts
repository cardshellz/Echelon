import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import type { InsertChannelConnection } from "@shared/schema";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { createEbayBusinessPolicyService } from "../../ebay-business-policies.service";
import { PgEbayBusinessPolicyRepository } from "../../infrastructure/ebay-business-policies.repository";
import { EbayBusinessPolicyProvider } from "../../infrastructure/ebay-business-policies.provider";
import { ebayBusinessPolicyFixtureSql, ebayBusinessPolicySeedSql, ebayPolicyScope, EbayPolicyCatalogHttp } from "../fixtures/ebay-business-policies.fixture";

const fixture = vi.hoisted(() => ({ database: undefined as ReturnType<typeof drizzle> | undefined }));
vi.mock("../../../../db", () => ({ db: new Proxy({}, { get: (_target, key) => {
  if (!fixture.database) throw new Error("The disposable database must be initialized before storage access");
  const value = Reflect.get(fixture.database, key);
  return typeof value === "function" ? value.bind(fixture.database) : value;
} }) }));
import { channelMethods } from "../../channels.storage";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const rejectedMetadata: InsertChannelConnection["metadata"][] = [
  null, [], "invalid", { fulfillmentPolicyId: null }, { returnPolicyId: "bypass" }, { businessPolicies: {} },
];
(url && disposable ? describe : describe.skip).sequential("generic eBay connection edits preserve canonical policies", () => {
  let database: InventoryCutoverTestDatabase;
  let service: ReturnType<typeof createEbayBusinessPolicyService>;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, ebayBusinessPolicyFixtureSql + `
      ALTER TABLE channels.channel_connections ADD COLUMN shop_domain text, ADD COLUMN access_token text,
        ADD COLUMN refresh_token text, ADD COLUMN webhook_secret text, ADD COLUMN api_version text,
        ADD COLUMN scopes text, ADD COLUMN shopify_location_id text, ADD COLUMN expires_at timestamp,
        ADD COLUMN last_sync_at timestamp, ADD COLUMN sync_status text DEFAULT 'never',
        ADD COLUMN sync_error text, ADD COLUMN created_at timestamp NOT NULL DEFAULT now();`);
    fixture.database = drizzle(database.pool);
    service = createEbayBusinessPolicyService({ repository: new PgEbayBusinessPolicyRepository(database.pool),
      scopeReader: async () => ({ ...ebayPolicyScope }), provider: new EbayBusinessPolicyProvider({
        getAccessToken: async () => "synthetic-token", getEnvironment: () => "production",
        getVerifiedProviderAccount: async () => ({ externalAccountId: ebayPolicyScope.accountId }),
      }, new EbayPolicyCatalogHttp().fetch) });
  }, 60_000);
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await database.pool.query(`TRUNCATE public.audit_events,ebay.ebay_category_mappings,catalog.product_variants,
      catalog.products,ebay.ebay_oauth_tokens,channels.channel_connections,channels.channels RESTART IDENTITY CASCADE;
      ${ebayBusinessPolicySeedSql}`);
  });
  const metadata = async () => (await database.pool.query("SELECT metadata FROM channels.channel_connections WHERE id=9")).rows[0].metadata;

  it("merges a general edit into the current row after a concurrent audited policy save", async () => {
    const originalRead = channelMethods.getChannelConnection.bind(channelMethods);
    vi.spyOn(channelMethods, "getChannelConnection").mockImplementationOnce(async channelId => {
      const staleRead = await originalRead(channelId);
      await service.patchPolicies({ target: { kind: "store" }, patch: { fulfillmentPolicyId: "replacement-shipping" }, actor: "user:policy-owner" });
      return staleRead;
    });
    const saved = await channelMethods.upsertChannelConnection({ channelId: 67, metadata: { merchantLocationKey: "new-location" } });
    expect(saved.metadata).toMatchObject({ fulfillmentPolicyId: "replacement-shipping", returnPolicyId: "store-returns", paymentPolicyId: "store-payment", merchantLocationKey: "new-location", unrelated: { preserve: true } });
    expect(await metadata()).toEqual(saved.metadata);
    expect((await database.pool.query("SELECT actor FROM public.audit_events")).rows).toEqual([{ actor: "user:policy-owner" }]);
  });

  it.each(rejectedMetadata)(
    "rejects policy replacement or metadata clearing through generic connection writes: %j", async incoming => {
      const before = await metadata();
      await expect(channelMethods.upsertChannelConnection({ channelId: 67, metadata: incoming })).rejects.toMatchObject({ code: "EBAY_POLICY_OWNER_REQUIRED" });
      expect(await metadata()).toEqual(before);
      expect((await database.pool.query("SELECT count(*)::int AS count FROM public.audit_events")).rows[0].count).toBe(0);
    });

  it("keeps all policies when metadata is omitted", async () => {
    const before = await metadata();
    await channelMethods.upsertChannelConnection({ channelId: 67, syncStatus: "ok" });
    expect(await metadata()).toEqual(before);
  });
});
