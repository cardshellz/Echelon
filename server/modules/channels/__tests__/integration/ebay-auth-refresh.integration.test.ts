import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { EbayAuthService } from "../../adapters/ebay/ebay-auth.service";

vi.mock("../../../../db", () => ({ pool: {} }));
const configured = process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const now = new Date("2026-10-10T00:00:00Z");
const config = { clientId: "fixture-client", clientSecret: "fixture-secret", ruName: "fixture-return", environment: "production" as const };
const tokenResponse = (accessToken: string) => new Response(JSON.stringify({ access_token: accessToken, expires_in: 7200 }), { status: 200 });

// Reduced named-schema fixture exercises actual Drizzle SQL and PostgreSQL
// conditional updates. It is not migration/schema installation proof.
const fixture = `CREATE SCHEMA ebay;
CREATE TABLE ebay.ebay_oauth_tokens (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, channel_id integer NOT NULL, environment varchar(20) NOT NULL,
 access_token text NOT NULL, access_token_expires_at timestamp NOT NULL, refresh_token text NOT NULL, refresh_token_expires_at timestamp,
 scopes text, external_account_id varchar(255), external_account_display_name varchar(255), external_account_identity_scheme varchar(50), external_account_verified_at timestamptz,
 last_refreshed_at timestamp, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 UNIQUE(channel_id, environment)
);`;

(configured ? describe : describe.skip).sequential("eBay authorization persistence through real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL, true, fixture); });
  beforeEach(async () => {
    await database.pool.query(`DROP TRIGGER IF EXISTS reject_refresh ON ebay.ebay_oauth_tokens;
      TRUNCATE ebay.ebay_oauth_tokens;
      INSERT INTO ebay.ebay_oauth_tokens (channel_id,environment,access_token,access_token_expires_at,refresh_token,refresh_token_expires_at)
      VALUES (67,'production','old-67','2026-10-09','refresh-67','2027-10-10'),
      (68,'production','old-68','2026-10-09','refresh-68','2027-10-10'),
      (67,'sandbox','sandbox-67','2026-10-09','sandbox-refresh-67','2027-10-10');`);
  });
  afterAll(async () => { await database?.close(); });

  it("refreshes exact channel/environment rows concurrently and preserves refresh expiry", async () => {
    const service = new EbayAuthService(drizzle(database.pool), config, { now: () => now,
      fetch: vi.fn<typeof fetch>(async (_url, init) => tokenResponse(`access-for-${new URLSearchParams(String(init?.body)).get("refresh_token")}`)),
    });
    await expect(Promise.all([service.getAccessToken(67), service.getAccessToken(68)])).resolves.toEqual(["access-for-refresh-67", "access-for-refresh-68"]);
    const rows = (await database.pool.query("SELECT channel_id,environment,access_token,refresh_token_expires_at::date::text AS expires FROM ebay.ebay_oauth_tokens ORDER BY channel_id,environment")).rows;
    expect(rows).toEqual([
      { channel_id: 67, environment: "production", access_token: "access-for-refresh-67", expires: "2027-10-10" },
      { channel_id: 67, environment: "sandbox", access_token: "sandbox-67", expires: "2027-10-10" },
      { channel_id: 68, environment: "production", access_token: "access-for-refresh-68", expires: "2027-10-10" },
    ]);
  });

  it("rejects a stale refresh after another connection commits new credentials", async () => {
    let release!: (value: Response) => void;
    const provider = vi.fn<typeof fetch>(() => new Promise((resolve) => { release = resolve; }));
    const service = new EbayAuthService(drizzle(database.pool), config, { fetch: provider, now: () => now });
    const request = service.getAccessToken(67);
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    await database.pool.query("UPDATE ebay.ebay_oauth_tokens SET access_token='reconnected',refresh_token='reconnected-refresh' WHERE channel_id=67 AND environment='production'");
    release(tokenResponse("obsolete"));
    await expect(request).rejects.toMatchObject({ code: "EBAY_AUTH_REFRESH_SUPERSEDED" });
    expect((await database.pool.query("SELECT access_token,refresh_token FROM ebay.ebay_oauth_tokens WHERE channel_id=67 AND environment='production'")).rows).toEqual([{ access_token: "reconnected", refresh_token: "reconnected-refresh" }]);
  });

  it("leaves every credential field unchanged when persistence fails", async () => {
    await database.pool.query(`CREATE OR REPLACE FUNCTION ebay.reject_refresh() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected persistence failure'; END$$;
      CREATE TRIGGER reject_refresh BEFORE UPDATE ON ebay.ebay_oauth_tokens FOR EACH ROW EXECUTE FUNCTION ebay.reject_refresh();`);
    const before = (await database.pool.query("SELECT * FROM ebay.ebay_oauth_tokens ORDER BY id")).rows;
    const service = new EbayAuthService(drizzle(database.pool), config, { fetch: vi.fn<typeof fetch>().mockResolvedValue(tokenResponse("unsaved")), now: () => now });
    await expect(service.getAccessToken(67)).rejects.toThrow();
    expect((await database.pool.query("SELECT * FROM ebay.ebay_oauth_tokens ORDER BY id")).rows).toEqual(before);
  });
});
