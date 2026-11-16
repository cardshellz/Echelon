import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { ebayListingScopeGroupKey as groupKey, ebayListingScopeSku as sku,
  installEbayListingScopeFixture } from "../fixtures/ebay-listing-preparation-scope.fixture";
import { installPublicationSelectionWorkFixture } from "../fixtures/publication-selection-work.fixture";
import { createChannelEbayQuantityRequestAdmission, quantityProviderResponseRecovery } from "../../infrastructure/quantity-publication-runtime";
import { EbayApiClient } from "../../../channels/adapters/ebay/ebay-api.client";
import { EbayMarketplaceListingConnector, type EbayListingConnectorDraft,
  type EbayListingLifecycleClient } from "../../../channels/listing-connectors/ebay-listing.connector";

const runtime = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable database is not initialized.");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";

const LISTING_ID = "listing-260";
const P10 = sku("P10");
const C500 = sku("C500");
const C200 = sku("C200");
const PHOTO = "https://example.test/current.jpg";
const GROUP_PATH = `/sell/inventory/v1/inventory_item_group/${groupKey}`;
const BULK_PATH = "/sell/inventory/v1/bulk_update_price_quantity";
const PUBLISH_PATH = "/sell/inventory/v1/offer/publish_by_inventory_item_group";
const VARIANT_IDS: Record<string, number> = { [P10]: 101, [C500]: 102, [C200]: 103 };

interface FakeOffer { offerId: string; sku: string; availableQuantity: number; soldQuantity: number }

/**
 * The owner takes one size off a live eBay variation listing. The connector runs the in-place update through the
 * real eBay client, the real quantity admission and Postgres; only eBay's HTTP answers are faked. The fake
 * reproduces one eBay rule: a group write that deletes a size eBay will not delete is refused.
 *
 * ASSUMPTION (not observed: no sandbox buyer exists, so no sale could be made): eBay's refusal is HTTP 400 with
 * error 25013 "Invalid data in the Inventory Item Group". Its error category was never captured, so the refusal
 * cases run with both REQUEST and APPLICATION: the conclusion must not depend on which one eBay sends.
 */
(url && disposable ? describe : describe.skip).sequential("taking an eBay size off a live listing through the real quantity admission", () => {
  let database: InventoryCutoverTestDatabase;
  let writes: Array<{ method: string; path: string; status: number; body: Record<string, unknown> }>;
  let groupSkus: string[];
  let quantities: Map<string, number>;
  let offers: Map<string, FakeOffer>;
  /** Sizes eBay refuses to delete from the group, whatever the offer reports. */
  let undeletable: Set<string>;
  let refusalCategory: string;

  const groupPayload = (members: readonly string[]) => ({ title: "Current photos", description: "Current content",
    aspects: {}, imageUrls: [PHOTO], variantSKUs: [...members], variesBy: { specifications: [{ name: "Size", values: [...members] }] } });
  const itemPayload = (member: string, quantity: number) => ({ condition: "NEW" as const,
    product: { title: "Current photos", aspects: { Size: [member] }, imageUrls: [PHOTO] },
    availability: { shipToLocationAvailability: { quantity } } });
  // A positive draft quantity is replaced by the admission's canonical quantity; zero would be sent as a real zero.
  const offerPayload = (member: string) => ({ sku: member, marketplaceId: "EBAY_US" as const, format: "FIXED_PRICE" as const,
    availableQuantity: 1, categoryId: "123", merchantLocationKey: "main",
    listingPolicies: { fulfillmentPolicyId: "f", returnPolicyId: "r", paymentPolicyId: "p" },
    pricingSummary: { price: { value: "9.99", currency: "USD" } } });
  const offerBody = (member: string) => {
    const offer = offers.get(member)!;
    return { ...offerPayload(member), offerId: offer.offerId, availableQuantity: offer.availableQuantity, status: "PUBLISHED",
      listing: { listingId: LISTING_ID, listingStatus: offer.availableQuantity === 0 ? "OUT_OF_STOCK" : "ACTIVE",
        soldQuantity: offer.soldQuantity } };
  };
  const draftFor = (kept: readonly string[]): EbayListingConnectorDraft => ({
    productId: 20, marketplaceId: "EBAY_US", publishMode: "publish", hasExistingExternalIds: true,
    existingExternalProductId: LISTING_ID,
    inventoryItems: kept.map(member => ({ sku: member, payload: itemPayload(member, 1) })),
    offers: kept.map(member => ({ sku: member, variantId: VARIANT_IDS[member], payload: offerPayload(member) })),
    itemGroup: { groupKey, payload: groupPayload(kept) },
  });
  const apiClient = () => new EbayApiClient({ getAccessToken: async () => "synthetic-test-token" }, 67, "production",
    { quantityAdmission: () => createChannelEbayQuantityRequestAdmission({ channelId: 67, expectedConnectionId: 9,
      externalAccountId: "seller-36", environment: "production" }) });
  const lifecycleClient = (): EbayListingLifecycleClient => {
    const api = apiClient();
    return {
      getInventoryItem: member => api.getInventoryItem(member),
      createOrReplaceInventoryItem: (member, item) => api.createOrReplaceInventoryItem(member, item),
      getOffers: (member, marketplaceId) => api.getOffers(member, marketplaceId) as ReturnType<EbayListingLifecycleClient["getOffers"]>,
      createOffer: offer => api.createOffer(offer),
      updateOffer: (offerId, offer) => api.updateOffer(offerId, offer),
      publishOffer: offerId => api.publishOffer(offerId),
      getInventoryItemGroup: key => api.getInventoryItemGroup(key),
      createOrReplaceInventoryItemGroup: (key, group) => api.createOrReplaceInventoryItemGroup(key, group),
      publishOfferByInventoryItemGroup: (key, marketplaceId) => api.publishOfferByInventoryItemGroup(key, marketplaceId),
      withdrawOfferByInventoryItemGroup: (key, marketplaceId) => api.withdrawOfferByInventoryItemGroup(key, marketplaceId),
      deleteInventoryItemGroup: async () => { throw new Error("An in-place update never deletes the group."); },
      bulkUpdatePriceQuantity: request => api.bulkUpdatePriceQuantity(request),
      // The buyer-facing listing is read through eBay's Trading API in production; here it mirrors the fake's group.
      getPublishedListingContent: async listingId => ({ listingId, skus: [...groupSkus],
        policies: { shipping: "f", return: "r", payment: "p" }, firstPhotoSource: PHOTO,
        photos: [{ url: PHOTO, width: 640, height: 640 }] }),
    };
  };
  const update = async (kept: readonly string[], removed: string) => {
    const connector = new EbayMarketplaceListingConnector();
    const client = lifecycleClient();
    const preview = await connector.previewListingRebuild({ client, draft: draftFor(kept), currentExternalListingId: LISTING_ID });
    expect(preview.removedSkus).toEqual([removed]);
    return connector.updateExistingListing({ client, draft: draftFor(kept), preview });
  };
  const groupWrites = () => writes.filter(write => write.method === "PUT" && write.path === GROUP_PATH);
  const refusedWrites = () => writes.filter(write => write.status >= 400);
  const attempts = async () => (await database.pool.query(`SELECT state,error_code,scope->>'externalInventoryItemId' AS item
    FROM inventory.quantity_publication_attempts ORDER BY id`)).rows as Array<{ state: string; error_code: string | null; item: string }>;
  const cooledItems = async () => (await database.pool.query(`SELECT external_inventory_item_id AS item
    FROM inventory.quantity_publication_cooldowns WHERE retry_not_before>now()`)).rows.map(row => row.item as string).sort();

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    await installEbayListingScopeFixture(database.pool);
    await installPublicationSelectionWorkFixture(database.pool);
    // Complete only the named read-model columns the lifecycle migration consumes (as the archived-group suite does).
    await database.pool.query(`ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
      ALTER TABLE catalog.product_variants ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
      ALTER TABLE channels.channel_connections ADD COLUMN IF NOT EXISTS shop_domain text;
      ALTER TABLE channels.channel_connections ADD COLUMN IF NOT EXISTS metadata jsonb;
      ALTER TABLE channels.walmart_connections ADD COLUMN IF NOT EXISTS market text;
      UPDATE catalog.products SET updated_at=transaction_timestamp();
      UPDATE catalog.product_variants SET updated_at=transaction_timestamp();
      UPDATE channels.channel_connections SET metadata='{"marketplaceId":"EBAY_US"}' WHERE id=9;`);
    for (const file of ["0707_channel_listing_publication.sql", "900000013000018480001_shared_listing_member_lifecycle.sql"])
      await database.pool.query(readFileSync(resolve("migrations", file), "utf8"));
    writes = []; groupSkus = [P10, C500]; undeletable = new Set(); refusalCategory = "REQUEST";
    quantities = new Map([P10, C500, C200].map(member => [member, 5]));
    offers = new Map([P10, C500, C200].map(member => [member,
      { offerId: `offer-${member.split("-").at(-1)}`, sku: member, availableQuantity: 5, soldQuantity: 0 }]));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input));
      const path = requestUrl.pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      const answer = (status: number, payload?: unknown) => {
        if (method !== "GET") writes.push({ method, path, status, body });
        return payload === undefined ? new Response(null, { status }) : Response.json(payload, { status });
      };
      const last = decodeURIComponent(path.split("/").at(-1)!);
      const offerById = () => [...offers.values()].find(offer => offer.offerId === last)!;
      if (method === "GET" && path === GROUP_PATH) return answer(200, { ...groupPayload(groupSkus), inventoryItemGroupKey: groupKey });
      if (method === "GET" && path.includes("/inventory_item/")) return answer(200, { sku: last, ...itemPayload(last, quantities.get(last)!) });
      if (method === "GET" && path.endsWith("/offer")) return answer(200, { offers: [offerBody(requestUrl.searchParams.get("sku")!)], total: 1 });
      if (method === "GET" && path.includes("/offer/")) return answer(200, offerBody(offerById().sku));
      if (method === "PUT" && path === GROUP_PATH) {
        const requested = body.variantSKUs as string[];
        // The eBay rule under test: these sizes cannot be deleted from their listing.
        if (groupSkus.some(member => undeletable.has(member) && !requested.includes(member))) {
          return answer(400, { errors: [{ errorId: 25013, domain: "API_INVENTORY", category: refusalCategory,
            message: "Invalid data in the Inventory Item Group." }] });
        }
        groupSkus = [...requested];
        return answer(204);
      }
      if (method === "PUT" && path.includes("/inventory_item/")) {
        quantities.set(last, (body.availability as { shipToLocationAvailability: { quantity: number } }).shipToLocationAvailability.quantity);
        return answer(204);
      }
      if (method === "PUT" && path.includes("/offer/")) {
        offerById().availableQuantity = body.availableQuantity as number;
        return answer(204);
      }
      if (method === "POST" && path === BULK_PATH) {
        const requests = body.requests as Array<{ sku: string; shipToLocationAvailability: { quantity: number };
          offers: Array<{ offerId: string; availableQuantity: number }> }>;
        for (const request of requests) {
          quantities.set(request.sku, request.shipToLocationAvailability.quantity);
          for (const offer of request.offers) offers.get(request.sku)!.availableQuantity = offer.availableQuantity;
        }
        return answer(200, { responses: requests.flatMap(request => request.offers.map(offer =>
          ({ sku: request.sku, offerId: offer.offerId, statusCode: 200 }))) });
      }
      if (method === "POST" && path === PUBLISH_PATH) return answer(200, { listingId: LISTING_ID });
      throw new Error(`Unexpected provider request ${method} ${path}`);
    }));
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; vi.unstubAllGlobals(); });

  /** C500 stays an active catalog size with its stock mapping; the owner only stops listing it on eBay. */
  const stopListingC500 = () => database.pool.query("UPDATE catalog.product_variants SET ebay_listing_excluded=true WHERE id=102");

  it("keeps a removed size that has sales in the group at zero, with no write eBay refuses", async () => {
    await stopListingC500();
    // The retained size still has stock in Echelon. Without the eBay exclusion the admission plans 40 for it; every
    // group write and the final publish refresh each member's quantity, so the exclusion must keep it at zero.
    await database.pool.query(`INSERT INTO inventory.inventory_levels
      (id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty) VALUES(11,100,102,40,0,0,0)`);
    undeletable.add(C500); offers.get(C500)!.soldQuantity = 2;

    await expect(update([P10], C500)).resolves.toMatchObject({ status: "updated", externalProductId: LISTING_ID, removedSkus: [] });

    expect(refusedWrites()).toEqual([]);
    expect(groupWrites().map(write => write.body.variantSKUs)).toEqual([[C500, P10]]);
    expect(groupSkus).toEqual([C500, P10]);
    // The retained size cannot be bought; the kept size carries Echelon's own quantity, not the draft's placeholder.
    expect(offers.get(C500)!.availableQuantity).toBe(0); expect(quantities.get(C500)).toBe(0);
    expect(offers.get(P10)!.availableQuantity).toBe(17); expect(quantities.get(P10)).toBe(17);
    expect((await attempts()).map(attempt => attempt.state)).not.toContain("rejected");
    expect(await cooledItems()).toEqual([]);
  }, 60_000);

  // Why the size is kept BEFORE the write instead of after a refusal. eBay refuses although the offer shows no
  // sales, so the connector sends the deleting write. A corrected write sent straight after it never reaches eBay.
  it.each([
    { category: "REQUEST", attemptState: "rejected", firstError: "EBAY_QUANTITY_REJECTED", nextWrite: "PUBLICATION_PROVIDER_COOLDOWN" },
    { category: "APPLICATION", attemptState: "uncertain", firstError: "EBAY_QUANTITY_RESPONSE_UNCERTAIN", nextWrite: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED" },
  ])("after eBay refuses the deleting write ($category), the corrected group write is refused locally with $nextWrite", async scenario => {
    await stopListingC500();
    undeletable.add(C500); refusalCategory = scenario.category;

    await expect(update([P10], C500)).rejects.toMatchObject({ code: scenario.firstError, message: expect.stringContaining("25013") });

    expect(groupWrites().map(write => [write.status, write.body.variantSKUs])).toEqual([[400, [P10]]]);
    expect((await attempts()).at(-1)).toMatchObject({ state: scenario.attemptState, item: `group:${groupKey}` });
    // A REQUEST refusal cools the group and every member the refused write named; an uncertain outcome cools nothing.
    expect(await cooledItems()).toEqual(scenario.category === "REQUEST" ? [P10, `group:${groupKey}`].sort() : []);
    const writesBefore = writes.length;

    // The write the removed fallback used to send next: the same group with the refused size kept.
    await expect(apiClient().createOrReplaceInventoryItemGroup(groupKey, groupPayload([C500, P10])))
      .rejects.toMatchObject({ code: scenario.nextWrite });

    expect(writes).toHaveLength(writesBefore);
    expect(groupSkus).toEqual([P10, C500]);
    // The size eBay refused to delete is still for sale: nothing after the refusal reached eBay.
    expect(offers.get(C500)!.availableQuantity).toBeGreaterThan(0);

    // What ends each block. The scheduled response recovery (the catch-up worker runs it every 15 seconds) releases
    // an uncertain attempt whose request has a complete eBay error response; it does not shorten a cooldown.
    const recovery = await quantityProviderResponseRecovery.reconcile();
    const retry = apiClient().createOrReplaceInventoryItemGroup(groupKey, groupPayload([C500, P10]));
    if (scenario.category === "REQUEST") {
      expect(recovery.resolved).toEqual([]);
      await expect(retry).rejects.toMatchObject({ code: "PUBLICATION_PROVIDER_COOLDOWN" });
      expect(writes).toHaveLength(writesBefore);
    } else {
      expect(recovery.resolved).toHaveLength(1);
      await expect(retry).resolves.toBeUndefined();
      expect(groupWrites().at(-1)).toMatchObject({ status: 204, body: { variantSKUs: [C500, P10] } });
    }
  }, 60_000);

  // OPEN GAP, pinned so a change to it is deliberate. An archived size has no stock mapping. The group write keeps
  // it (archived members are preserved there) and it is zeroed, but publish_by_inventory_item_group plans a quantity
  // for every group member and refuses the archived one. eBay is left in the wanted state (size kept at zero, not
  // buyable); the update still reports failure, every time.
  it("leaves eBay in the wanted state but reports failure when the removed size with sales is archived", async () => {
    groupSkus = [P10, C500, C200]; undeletable.add(C200); offers.get(C200)!.soldQuantity = 3;

    await expect(update([P10, C500], C200)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_TARGET_UNMAPPED" });

    expect(refusedWrites()).toEqual([]);
    expect(writes.some(write => write.path === PUBLISH_PATH)).toBe(false);
    expect(groupSkus).toEqual([C200, C500, P10]);
    expect(offers.get(C200)!.availableQuantity).toBe(0); expect(quantities.get(C200)).toBe(0);
  }, 60_000);
});
