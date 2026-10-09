import express from "express";
import type { AddressInfo } from "node:net";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { channels, ebayCategoryMappings, ebayOauthTokens } from "@shared/schema";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../../modules/inventory/__tests__/fixtures/inventory-cutover-database";
import { router } from "../../ebay-config.routes";

const mocks = vi.hoisted(() => ({
  select: vi.fn(), connect: vi.fn(), hasPermission: vi.fn(), getAuthService: vi.fn(),
  getChannelConnection: vi.fn(), readEbayConnectionHealth: vi.fn(),
}));
vi.mock("../../../../db", () => ({ db: { select: mocks.select }, pool: { connect: mocks.connect } }));
vi.mock("../../../../modules/identity", () => ({ hasPermission: mocks.hasPermission }));
vi.mock("../../../../modules/channels/ebay-connection-health", () => ({ readEbayConnectionHealth: mocks.readEbayConnectionHealth }));
vi.mock("../../../../modules/channels/ebay-listing-sync", () => ({ syncActiveListings: vi.fn(), triggerPricingRuleSync: vi.fn() }));
vi.mock("../../ebay-utils", () => ({ EBAY_CHANNEL_ID: 67, getAuthService: mocks.getAuthService, getChannelConnection: mocks.getChannelConnection }));
vi.mock("../../ebay-listing-state", () => ({ markEbayVariantListingPendingForRelist: vi.fn(), setEbayVariantListingIntent: vi.fn(), zeroEbayVariantListing: vi.fn() }));

// Token selection uses real named-schema PostgreSQL and actual Drizzle SQL.
// Unrelated configuration reads and external provider health are isolated here.
const fixture = `CREATE SCHEMA ebay;
CREATE TABLE ebay.ebay_oauth_tokens (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, channel_id integer NOT NULL, environment varchar(20) NOT NULL,
 access_token text NOT NULL, access_token_expires_at timestamp NOT NULL, refresh_token text NOT NULL, refresh_token_expires_at timestamp,
 scopes text, external_account_id varchar(255), external_account_display_name varchar(255), external_account_identity_scheme varchar(50), external_account_verified_at timestamptz,
 last_refreshed_at timestamp, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 UNIQUE(channel_id,environment)
);
INSERT INTO ebay.ebay_oauth_tokens(channel_id,environment,access_token,access_token_expires_at,refresh_token)
VALUES (67,'sandbox','sandbox-secret','2027-01-01','sandbox-refresh'),
 (67,'production','production-secret','2028-01-01','production-refresh'),
 (68,'production','other-channel-secret','2029-01-01','other-refresh');`;

const configured = process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(configured ? describe : describe.skip).sequential("eBay channel config access and active credential environment", () => {
  let database: InventoryCutoverTestDatabase;
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let session: { user?: { id: string } };
  let url: string;
  let tokenReads: number;
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL, true, fixture); });
  beforeEach(async () => {
    vi.clearAllMocks();
    session = { user: { id: "operator" } };
    tokenReads = 0;
    mocks.hasPermission.mockResolvedValue(true);
    mocks.getAuthService.mockReturnValue({ getEnvironment: () => "production" });
    mocks.getChannelConnection.mockResolvedValue(null);
    mocks.readEbayConnectionHealth.mockResolvedValue({ connectionHealth: "verified", connectionIssue: null, ebayUsername: "fixture-seller" });
    mocks.connect.mockResolvedValue({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() });
    const tokenDb = drizzle(database.pool);
    mocks.select.mockImplementation(() => ({ from(table: unknown) {
      if (table === ebayOauthTokens) { tokenReads++; return tokenDb.select().from(ebayOauthTokens); }
      if (table === channels) return { where: () => ({ limit: async () => [] }) };
      if (table === ebayCategoryMappings) return { where: async () => [] };
      throw new Error("Unexpected config table");
    } }));
    const app = express();
    app.use((req, _res, next) => { (req as unknown as { session: typeof session }).session = session; next(); });
    app.use(router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ebay/channel-config`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  afterAll(async () => { await database?.close(); });

  it("rejects an authenticated user without channels:view before database or live auth work", async () => {
    mocks.hasPermission.mockResolvedValue(false);
    const response = await fetch(url);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Permission denied: channels:view" });
    expect(mocks.hasPermission).toHaveBeenCalledExactlyOnceWith("operator", "channels", "view");
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.getChannelConnection).not.toHaveBeenCalled();
    expect(mocks.getAuthService).not.toHaveBeenCalled();
    expect(mocks.readEbayConnectionHealth).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request before even checking permissions", async () => {
    session = {};
    expect((await fetch(url)).status).toBe(401);
    expect(mocks.hasPermission).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.getAuthService).not.toHaveBeenCalled();
  });

  it.each([
    ["production", "2028-01-01T00:00:00.000Z"],
    ["sandbox", "2027-01-01T00:00:00.000Z"],
  ])("reads only the exact channel's %s token when both environments exist", async (environment, expiresAt) => {
    const auth = { getEnvironment: () => environment };
    mocks.getAuthService.mockReturnValue(auth);
    const response = await fetch(url);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ connected: true, connectionHealth: "verified", tokenInfo: { environment, accessTokenExpiresAt: expiresAt } });
    expect(tokenReads).toBe(1);
    expect(mocks.readEbayConnectionHealth).toHaveBeenCalledExactlyOnceWith(auth, 67);
    expect(JSON.stringify(body)).not.toMatch(/secret|refreshToken"|accessToken"/);
  });

  it("does not choose either stored environment when OAuth is unconfigured", async () => {
    mocks.getAuthService.mockReturnValue(null);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: false, connectionHealth: "not_connected", tokenInfo: null });
    expect(tokenReads).toBe(0);
    expect(mocks.readEbayConnectionHealth).not.toHaveBeenCalled();
  });

  it("does not borrow a sandbox or another channel's token when the active token is absent", async () => {
    await database.pool.query("DELETE FROM ebay.ebay_oauth_tokens WHERE channel_id=67 AND environment='production'");
    try {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ connected: false, connectionHealth: "not_connected", tokenInfo: null });
      expect(tokenReads).toBe(1);
      expect(mocks.readEbayConnectionHealth).not.toHaveBeenCalled();
    } finally {
      await database.pool.query(`INSERT INTO ebay.ebay_oauth_tokens(channel_id,environment,access_token,access_token_expires_at,refresh_token)
        VALUES(67,'production','production-secret','2028-01-01','production-refresh')`);
    }
  });
});
