import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { vi } from "vitest";
import { installEbayPublicationInventoryFixture } from "./ebay-publication-inventory.fixture";
import { WALMART_INVENTORY_NOW } from "./walmart-publication-inventory.fixture";
import { captureEbayListingSourceIdentity, resolveExistingEbayListingIdentity } from "../../../channels/ebay-existing-listing-identity";
import { EbayMarketplaceRegistrationObserver } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import type { EbayRegistrationReadTransport } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import { ensureEbayPublicationReady } from "../../infrastructure/ebay-publication-readiness.repository";

export const ebayListingScopeGroupKey = "SHLZ-TOP-260PT";
export const ebayListingScopeSku = (suffix: string): string => `${ebayListingScopeGroupKey}-${suffix}`;
export const ebayListingScopeAccount = { channelId: 67, connectionId: 9, accountId: "seller-36", marketplaceId: "EBAY_US" };
export const ebayListingScopeSource = () => ({ channelId: ebayListingScopeAccount.channelId,
  connectionId: ebayListingScopeAccount.connectionId, accountId: ebayListingScopeAccount.accountId, environment: "production" as const,
  productId: 20, purpose: "sync" as const,
  variants: [{ productVariantId: 101, sku: ebayListingScopeSku("P10") }, { productVariantId: 102, sku: ebayListingScopeSku("C500") }],
});

/** Synthetic 260PT topology, installed through real Inventory migrations and
 * mapping preparation. No provider transport is used by this setup. */
export async function installEbayListingScopeFixture(pool: Pool): Promise<void> {
  await installEbayPublicationInventoryFixture(pool, { includePreflightRecoveryMigrations: true, seedPublicationJob: false });
  for (const file of ["0731_ebay_listing_sync_verification_checkpoint.sql", "0732_ebay_listing_sync_identity_admission.sql",
    "0736_ebay_listing_mapping_repairs.sql", "0737_ebay_publication_completion.sql"]) {
    await pool.query(readFileSync(resolve("migrations", file), "utf8"));
  }
  // The minimal stock fixture omits owner-row IDs that the real listing source
  // fence locks. Keep the production fence intact in this composed fixture.
  await pool.query(`ALTER TABLE channels.channel_product_overrides ADD COLUMN id integer GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE channels.channel_variant_overrides ADD COLUMN id integer GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE ebay.ebay_category_mappings ADD COLUMN id integer GENERATED ALWAYS AS IDENTITY`);
  await pool.query(`UPDATE catalog.product_variants SET sku=CASE id WHEN 101 THEN $1 WHEN 102 THEN $2 ELSE $3 END
    WHERE id IN (101,102,103)`, [ebayListingScopeSku("P10"), ebayListingScopeSku("C500"), ebayListingScopeSku("C200")]);
  await pool.query(`UPDATE channels.channel_listings SET external_sku=$1,external_product_id='listing-260',external_variant_id='offer-P10' WHERE id=1`, [ebayListingScopeSku("P10")]);
  await pool.query(`INSERT INTO channels.channel_listings(id,channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,sync_status)
    VALUES(2,67,102,$1,'offer-C500','listing-260','synced')`, [ebayListingScopeSku("C500")]);
  await ensureEbayPublicationReady(pool, ebayListingScopeSource(), { commandKey: randomUUID(), actor: "scope-fixture", now: WALMART_INVENTORY_NOW });
  await pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=103");
  await pool.query(`INSERT INTO channels.channel_listings(id,channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,sync_status)
    VALUES(3,67,103,$1,'offer-C200',NULL,'synced')`, [ebayListingScopeSku("C200")]);
}

/** Real registration observer and Channels binder over deterministic GET-only
 * provider responses. Tests may vary the retired evidence and observation time. */
export async function createEbayListingScopeObservation(pool: Pool) {
  const rows = (await pool.query(`SELECT v.product_id,v.id AS variant_id,v.sku AS variant_sku,
    l.external_sku,l.external_variant_id,l.external_product_id,p.is_active AS product_is_active,p.status AS product_status,
    v.is_active AS variant_is_active,v.sales_eligibility AS variant_sales_eligibility,
    p.ebay_listing_excluded AS product_excluded,v.ebay_listing_excluded AS variant_excluded
    FROM catalog.product_variants v JOIN catalog.products p ON p.id=v.product_id
    JOIN channels.channel_listings l ON l.product_variant_id=v.id AND l.channel_id=67
    WHERE v.product_id=20 ORDER BY v.id`)).rows;
  const source = captureEbayListingSourceIdentity(rows, ebayListingScopeAccount);
  const retired = { groups: [] as string[], status: 200, itemExists: true,
    offers: [{ sku: ebayListingScopeSku("C200"), offerId: "offer-C200", marketplaceId: "EBAY_US", status: "UNPUBLISHED" } as Record<string, unknown>],
  };
  let observedAt = new Date(WALMART_INVENTORY_NOW);
  const groupSkus = [ebayListingScopeSku("P10"), ebayListingScopeSku("C500")];
  const get: EbayRegistrationReadTransport["get"] = vi.fn(async request => {
    const path = new URL(request.path, "https://example.test");
    if (path.pathname === "/commerce/identity/v1/user/") return { status: 200, body: { userId: ebayListingScopeAccount.accountId, username: "fixture" } };
    if (path.pathname.includes("/inventory_item_group/")) return { status: 200, body: { variantSKUs: [...groupSkus] } };
    if (path.pathname.includes("/inventory_item/")) {
      const requestedSku = decodeURIComponent(path.pathname.split("/").at(-1)!);
      return { status: requestedSku === ebayListingScopeSku("C200") && !retired.itemExists ? 404 : 200,
        body: { sku: requestedSku, groupIds: requestedSku === ebayListingScopeSku("C200") ? retired.groups : [ebayListingScopeGroupKey] } };
    }
    if (path.pathname.endsWith("/offer")) {
      const requestedSku = path.searchParams.get("sku")!;
      if (requestedSku === ebayListingScopeSku("C200")) return { status: retired.status, body: { offers: retired.offers, total: retired.offers.length } };
      const member = source.variants.find(candidate => candidate.sku === requestedSku);
      if (!member) throw new Error(`Unexpected provider offer SKU ${requestedSku}`);
      return { status: 200, body: { offers: [{ sku: requestedSku, offerId: member.offerId, marketplaceId: "EBAY_US", status: "PUBLISHED",
        listing: { listingId: "listing-260", listingStatus: "ACTIVE" } }], total: 1 } };
    }
    throw new Error(`Unexpected provider GET ${request.path}`);
  });
  const observer = new EbayMarketplaceRegistrationObserver(
    { loadFreshCredential: async () => ({ accessToken: "test-only", environment: "production" }) },
    { get }, { now: () => new Date(observedAt) });
  const observe = () => resolveExistingEbayListingIdentity(source, observer, source.variants.map(member => ({
    productVariantId: member.variantId, sku: member.sku, isActive: member.contentSyncEnabled !== false, availableQuantity: 0,
  })));
  return { source, retired, groupSkus, observe, setObservedAt: (value: Date): void => { observedAt = new Date(value); } };
}
