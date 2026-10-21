import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PgDropshipMarketplaceCredentialRepository } from "../../infrastructure/dropship-marketplace-credentials";
import { PostgresDropshipEbayPushPublicationReader } from "../../infrastructure/dropship-ebay-push-publication.reader";
import { AesGcmDropshipStoreTokenCipher } from "../../infrastructure/dropship-token-cipher";
import type { DropshipMarketplaceListingPushRequest } from "../../application/dropship-marketplace-listing-push-provider";
import type { EbayDiscoveredPublishedListing } from "../../../channels/listing-connectors/ebay-listing.connector";
import type { MarketplaceListingRegistrationObserver } from "../../../marketplace-listings/application/registration-ports";
import type { MarketplaceObservedListingPublication } from "../../../marketplace-listings/domain/listing-registration-plan";
import { buildEbayRegistrationIdentityNamespace } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";

// The repository module's default pool is never used here; every query goes to the disposable database.
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";

// Owner tables only (the same reduced DDL the registration PG proof uses). The identity
// columns, the CHECK dropship_store_connections_stable_identity_chk and the identity
// drift trigger below come from the real migrations, not test replicas.
const ownerFixture = readFileSync(
  resolve("server/modules/marketplace-listings/__tests__/integration/marketplace-listing-registration.pg.sql"),
  "utf8",
)
  .split("\\ir ")[0]
  .split("\n")
  .filter((line) => !line.startsWith("\\"))
  .join("\n");

const VERIFIED_AT = new Date("2026-10-01T00:00:00.000Z");
const NOW = new Date("2026-10-20T12:00:00.000Z");
const VERIFIED_STORE = 22;
const LEGACY_STORE = 23;
// external_account_id predates 0609, which added only the scheme, environment and
// verified_at columns (0609:24-27), and the CHECK admits a NULL scheme with any id.
const PRE_0609_STORE = 24;
const SCHEME_ONLY_STORE = 25;

/**
 * Production failure (vendor store marz_cards, SKU ARM-ENV-SGL-P50): adoption of a SKU
 * already live on eBay refused every store, because the reader required a scheme the
 * database cannot hold. This suite loads real rows through the real credential loader
 * and hands them to the real reader, so the loader, the reader and the CHECK must agree.
 */
(url && disposable ? describe : describe.skip).sequential("Dropship eBay adoption account identity against the real store CHECK", () => {
  let database: InventoryCutoverTestDatabase;
  let credentials: PgDropshipMarketplaceCredentialRepository;
  let reader: PostgresDropshipEbayPushPublicationReader;
  const cipher = new AesGcmDropshipStoreTokenCipher(Buffer.alloc(32, 7), "integration-test-key");
  const observe = vi.fn(async (input: Parameters<MarketplaceListingRegistrationObserver["observeExistingPublication"]>[0]) =>
    observation(input.locator.externalListingId!, input.memberCandidates.map((member) => member.sku)));

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, ownerFixture);
    for (const migration of [
      "0607_marketplace_listing_replacement_foundation.sql",
      "0609_marketplace_listing_registration.sql",
    ]) {
      await database.pool.query(readFileSync(resolve("migrations", migration), "utf8"));
    }
    // Remaining columns the credential loader and the reader select. Their production
    // definitions predate 0609 and are not what this suite is about.
    await database.pool.query(`
      ALTER TABLE dropship.dropship_store_connections
        ADD COLUMN external_display_name text, ADD COLUMN shop_domain text,
        ADD COLUMN access_token_ref text, ADD COLUMN refresh_token_ref text,
        ADD COLUMN token_expires_at timestamptz, ADD COLUMN status text NOT NULL DEFAULT 'connected',
        ADD COLUMN config jsonb;
      CREATE TABLE dropship.dropship_store_connection_tokens (
        store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id),
        token_kind text NOT NULL, token_ref text PRIMARY KEY, key_id text NOT NULL,
        ciphertext text NOT NULL, iv text NOT NULL, auth_tag text NOT NULL, expires_at timestamptz,
        UNIQUE (store_connection_id, token_kind)
      );
      ALTER TABLE catalog.product_variants ADD COLUMN is_active boolean NOT NULL DEFAULT true;
      CREATE TABLE dropship.dropship_vendor_listings (
        id integer PRIMARY KEY, vendor_id integer NOT NULL,
        store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id),
        product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id)
      );
      INSERT INTO catalog.products (id, name) OVERRIDING SYSTEM VALUE VALUES (20, 'Envelopes');
      INSERT INTO catalog.product_variants (id, product_id, sku, name) OVERRIDING SYSTEM VALUE VALUES (101, 20, 'SKU-101', 'Pack');
      INSERT INTO dropship.dropship_vendors (id, name) OVERRIDING SYSTEM VALUE VALUES (10, 'Vendor');
    `);
    // A verified connection exactly as the OAuth callback persists it
    // (dropship-store-connection-service.ts resolveOAuthGrantIdentityForPersistence).
    await insertConnection(VERIFIED_STORE, {
      externalAccountId: "seller-1", identityScheme: "provider_user_id", verifiedAt: VERIFIED_AT,
    });
    // A legacy username-only connection: no stable identity evidence yet.
    await insertConnection(LEGACY_STORE, { externalAccountId: null, identityScheme: null, verifiedAt: null });
    // A seller id with no scheme, as a row created before 0609 holds it.
    await insertConnection(PRE_0609_STORE, { externalAccountId: "seller-legacy", identityScheme: null, verifiedAt: null });
    // A seller id and a verified time but no scheme: the CHECK admits it, and the scheme
    // comparison is the only reader check this row fails.
    await insertConnection(SCHEME_ONLY_STORE, { externalAccountId: "seller-legacy", identityScheme: null, verifiedAt: VERIFIED_AT });
    await database.pool.query(`INSERT INTO dropship.dropship_vendor_listings VALUES (50, 10, ${VERIFIED_STORE}, 101),
      (51, 10, ${LEGACY_STORE}, 101), (52, 10, ${PRE_0609_STORE}, 101), (53, 10, ${SCHEME_ONLY_STORE}, 101)`);
    credentials = new PgDropshipMarketplaceCredentialRepository(database.pool, {
      tokenCipher: cipher,
      notificationSender: { send: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    reader = new PostgresDropshipEbayPushPublicationReader(database.pool, { observeExistingPublication: observe });
  }, 120_000);
  beforeEach(() => { observe.mockClear(); });
  afterAll(async () => { await database?.close(); });

  async function insertConnection(id: number, identity: {
    externalAccountId: string | null; identityScheme: string | null; verifiedAt: Date | null;
  }): Promise<void> {
    const access = cipher.seal({ tokenKind: "access", token: `access-${id}`, vendorId: 10, platform: "ebay", expiresAt: null });
    await database.pool.query(
      `INSERT INTO dropship.dropship_store_connections
         (id, vendor_id, platform, external_account_id, provider_environment, external_account_identity_scheme,
          external_account_verified_at, external_display_name, access_token_ref, status, config)
       OVERRIDING SYSTEM VALUE VALUES ($1, 10, 'ebay', $2, 'production', $3, $4, 'seller', $5, 'connected', '{}'::jsonb)`,
      [id, identity.externalAccountId, identity.identityScheme, identity.verifiedAt, access.tokenRef],
    );
    await database.pool.query(
      `INSERT INTO dropship.dropship_store_connection_tokens
         (store_connection_id, token_kind, token_ref, key_id, ciphertext, iv, auth_tag, expires_at)
       VALUES ($1, 'access', $2, $3, $4, $5, $6, NULL)`,
      [id, access.tokenRef, access.keyId, access.ciphertext, access.iv, access.authTag],
    );
  }

  it("is the migration's CHECK: the scheme the old reader required cannot be stored", async () => {
    await expect(database.pool.query(
      `INSERT INTO dropship.dropship_store_connections
         (id, vendor_id, platform, external_account_id, provider_environment, external_account_identity_scheme, external_account_verified_at)
       OVERRIDING SYSTEM VALUE VALUES (90, 10, 'ebay', 'seller-9', 'production', 'ebay_user_id', $1)`,
      [VERIFIED_AT],
    )).rejects.toMatchObject({ code: "23514", constraint: "dropship_store_connections_stable_identity_chk" });
  });

  it("adopts with a verified row loaded through the real credential loader", async () => {
    const credential = await credentials.loadForStoreConnection({ vendorId: 10, storeConnectionId: VERIFIED_STORE, platform: "ebay" });
    expect(credential).toMatchObject({
      externalAccountId: "seller-1",
      providerEnvironment: "production",
      externalAccountIdentityScheme: "provider_user_id",
      externalAccountVerifiedAt: VERIFIED_AT,
      accessToken: `access-${VERIFIED_STORE}`,
    });
    await expect(reader.resolve(pushRequest(50, VERIFIED_STORE), credential, discovered()))
      .resolves.toMatchObject({ providerAccount: { externalAccountId: "seller-1" }, listingIdentity: { externalId: "listing-20" } });
    expect(observe).toHaveBeenCalledExactlyOnceWith({
      owner: { kind: "dropship", storeConnectionId: VERIFIED_STORE, productId: 20, provider: "ebay", marketplaceId: "EBAY_US" },
      locator: { providerPublicationKey: null, externalListingId: "listing-20" },
      memberCandidates: [{ productVariantId: 101, sku: "SKU-101", isActive: true, availableQuantity: 4 }],
    });
  });

  it("refuses a legacy row with no verified identity before the provider is observed", async () => {
    const credential = await credentials.loadForStoreConnection({ vendorId: 10, storeConnectionId: LEGACY_STORE, platform: "ebay" });
    expect(credential.externalAccountIdentityScheme).toBeNull();
    await expect(reader.resolve(pushRequest(51, LEGACY_STORE), credential, discovered()))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_PUBLICATION_ACCOUNT_UNVERIFIED", context: { retryable: false } });
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a pre-0609 row with a seller id and no scheme", listingId: 52, storeConnectionId: PRE_0609_STORE, verifiedAt: null },
    { name: "a row the scheme alone blocks (seller id and verified time, no scheme)", listingId: 53,
      storeConnectionId: SCHEME_ONLY_STORE, verifiedAt: VERIFIED_AT },
  ])("refuses $name before the provider is observed", async ({ listingId, storeConnectionId, verifiedAt }) => {
    const credential = await credentials.loadForStoreConnection({ vendorId: 10, storeConnectionId, platform: "ebay" });
    expect(credential).toMatchObject({
      externalAccountId: "seller-legacy", externalAccountIdentityScheme: null, externalAccountVerifiedAt: verifiedAt,
    });
    await expect(reader.resolve(pushRequest(listingId, storeConnectionId), credential, discovered()))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_PUBLICATION_ACCOUNT_UNVERIFIED", context: { retryable: false } });
    expect(observe).not.toHaveBeenCalled();
  });

  // Runs last: it removes the CHECK in this disposable database to prove the loader
  // refuses a value the constraint would have kept out, rather than passing it on.
  it("refuses a stored scheme outside the CHECK as a permanent loader error", async () => {
    await database.pool.query(`
      ALTER TABLE dropship.dropship_store_connections DROP CONSTRAINT dropship_store_connections_stable_identity_chk;
      UPDATE dropship.dropship_store_connections SET external_account_identity_scheme = 'ebay_user_id' WHERE id = ${LEGACY_STORE};
    `);
    await expect(credentials.loadForStoreConnection({ vendorId: 10, storeConnectionId: LEGACY_STORE, platform: "ebay" }))
      .rejects.toMatchObject({
        code: "DROPSHIP_STORE_IDENTITY_SCHEME_UNSUPPORTED",
        context: { vendorId: 10, storeConnectionId: LEGACY_STORE, identityScheme: "ebay_user_id", retryable: false },
      });
  });
});

function observation(listingId: string, skus: readonly string[]): MarketplaceObservedListingPublication {
  const namespace = (role: "listing" | "offer" | "inventory_item") =>
    buildEbayRegistrationIdentityNamespace({ environment: "production", marketplaceId: "EBAY_US", role });
  return {
    providerAccount: { provider: "ebay", accountNamespace: "production", externalAccountId: "seller-1",
      identityScheme: "provider_user_id", externalDisplayNameSnapshot: null, evidenceHash: "a".repeat(64) },
    marketplaceId: "EBAY_US", publicationKeyIdentity: null,
    listingIdentity: { externalId: listingId, identityNamespace: namespace("listing") },
    externalUrl: null, isPublished: true, observedAt: NOW, evidence: {},
    members: skus.map((sku) => ({ sku, variantIdentity: null,
      offerIdentity: { externalId: "offer-101", identityNamespace: namespace("offer") },
      inventoryItemIdentity: { externalId: sku, identityNamespace: namespace("inventory_item") } })),
  };
}

function pushRequest(listingId: number, storeConnectionId: number): DropshipMarketplaceListingPushRequest {
  return { vendorId: 10, storeConnectionId, jobId: 30, jobItemId: 40, listingId, productVariantId: 101, platform: "ebay",
    existingExternalListingId: null, existingExternalOfferId: null, idempotencyKey: `test-push-${listingId}`,
    listingIntent: { platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync", priceMode: "vendor_defined",
      productVariantId: 101, sku: "SKU-101", title: "Pack", description: null, category: null, marketplaceCategoryId: "123",
      marketplaceCategoryName: null, storeCategoryNames: [], brand: null, gtin: null, mpn: null, condition: "new",
      itemSpecifics: null, imageUrls: [], weightGrams: 100, priceCents: 999, quantity: 4,
      marketplaceConfig: { marketplaceId: "EBAY_US" } } };
}

function discovered(): EbayDiscoveredPublishedListing {
  return { listingId: "listing-20", members: [{ variantId: 101, sku: "SKU-101", offerId: "offer-101" }] };
}
