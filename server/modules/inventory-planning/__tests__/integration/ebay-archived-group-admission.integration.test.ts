import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { createEbayListingScopeObservation, ebayListingScopeGroupKey as groupKey, ebayListingScopeSku as sku,
  ebayListingScopeSource, installEbayListingScopeFixture } from "../fixtures/ebay-listing-preparation-scope.fixture";
import { installPublicationSelectionWorkFixture } from "../fixtures/publication-selection-work.fixture";
import { createChannelEbayQuantityRequestAdmission } from "../../infrastructure/quantity-publication-runtime";
import { ensureEbayPublicationReady } from "../../infrastructure/ebay-publication-readiness.repository";
import { EbayApiClient } from "../../../channels/adapters/ebay/ebay-api.client";
import type { EbayInventoryItemGroup } from "../../../channels/adapters/ebay/ebay-types";

const runtime = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable database is not initialized.");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";

(url && disposable ? describe : describe.skip).sequential("archived topology through real eBay API and canonical admission", () => {
  let database: InventoryCutoverTestDatabase;
  let group: EbayInventoryItemGroup;
  let writes: Array<{ path: string; body: Record<string, unknown> }>;
  let reads: string[];
  let afterQuantityWrite: (() => void) | undefined;
  let beforeGroupWrite: (() => Promise<void>) | undefined;
  const groupBody = () => ({ title: "Current photos", description: "Current content", imageUrls: ["https://example.test/current.jpg"],
    aspects: {}, variantSKUs: [sku("P10"), sku("C500"), sku("C200")], variesBy: { specifications: [] } });
  const client = (environment: "production" | "sandbox" = "production") => new EbayApiClient(
    { getAccessToken: async () => "synthetic-test-token" }, 67, environment,
    { quantityAdmission: () => createChannelEbayQuantityRequestAdmission({ channelId: 67, expectedConnectionId: 9,
      externalAccountId: "seller-36", environment }) });
  const saved = async () => (await database.pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM inventory.publication_variant_mapping_versions m WHERE product_variant_id=103) AS mappings,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM inventory.inventory_publication_outbox o) AS publications`)).rows[0];
  const update = () => client().createOrReplaceInventoryItemGroup(groupKey, groupBody());
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    await installEbayListingScopeFixture(database.pool);
    await installPublicationSelectionWorkFixture(database.pool);
    // Complete only the named read-model columns the actual lifecycle migration
    // consumes; all Inventory and lifecycle behavior comes from real owners.
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
    group = groupBody(); writes = []; reads = []; afterQuantityWrite = undefined; beforeGroupWrite = undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input));
      const path = requestUrl.pathname + requestUrl.search;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (method === "GET") {
        reads.push(path);
        if (path.includes("/inventory_item_group/")) return Response.json(group);
        const memberSku = path.includes("/inventory_item/") ? decodeURIComponent(requestUrl.pathname.split("/").at(-1)!) : requestUrl.searchParams.get("sku");
        if (memberSku === sku("C200")) throw new Error("Archived member provider reads are not part of active maintenance.");
        if (path.includes("/inventory_item/")) return Response.json({ sku: memberSku, availability: { shipToLocationAvailability: { quantity: 999 } } });
        if (requestUrl.pathname.endsWith("/offer")) return Response.json({ offers: [{ sku: memberSku, offerId: `offer-${memberSku}`,
          marketplaceId: "EBAY_US", status: "PUBLISHED", listing: { listingId: "listing-260" } }], total: 1 });
      }
      if (method === "POST" && path.endsWith("bulk_update_price_quantity")) {
        writes.push({ path, body });
        const requests = body.requests as Array<{ sku: string; offers: Array<{ offerId: string }> }>;
        afterQuantityWrite?.();
        return Response.json({ responses: requests.flatMap(request => request.offers.map(offer => ({ sku: request.sku, offerId: offer.offerId, statusCode: 200 }))) });
      }
      if (method === "PUT" && path.endsWith(`/inventory_item_group/${groupKey}`)) {
        await beforeGroupWrite?.();
        writes.push({ path, body }); group = body as unknown as EbayInventoryItemGroup;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected provider request ${method} ${path}`);
    }));
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; vi.unstubAllGlobals(); });

  it.each(["unreadable", "missing inventory item", "published"])("maintains active content while an archived group member is %s, with no archived mapping or quantity work", async scenario => {
    const observed = await createEbayListingScopeObservation(database.pool);
    observed.groupSkus.push(sku("C200")); observed.retired.groups = [groupKey];
    if (scenario === "unreadable") observed.retired.status = 503;
    if (scenario === "missing inventory item") observed.retired.itemExists = false;
    if (scenario === "published") {
      observed.retired.offers[0].status = "PUBLISHED";
      observed.retired.offers[0].listing = { listingId: "listing-260", listingStatus: "ACTIVE" };
    }
    const bound = await observed.observe();
    expect(bound.identity.variants.map(member => member.variantId)).toEqual([101,102]);
    expect(bound.identity.retainedGroupSkus).toEqual([sku("C200")]);
    await ensureEbayPublicationReady(database.pool, ebayListingScopeSource(), { commandKey: randomUUID(), actor: "archived-group-test",
      now: new Date(), verifiedListing: { sourceIdentity: observed.source, observation: bound.observation } });
    const before = await saved();
    await update();
    expect(await saved()).toEqual(before);
    expect(writes.map(write => write.path)).toEqual(["/sell/inventory/v1/bulk_update_price_quantity",
      "/sell/inventory/v1/bulk_update_price_quantity", `/sell/inventory/v1/inventory_item_group/${groupKey}`]);
    expect(writes.slice(0,2).map(write => (write.body.requests as Array<{ sku: string }>)[0].sku).sort()).toEqual([sku("C500"),sku("P10")]);
    expect(group.variantSKUs).toEqual(groupBody().variantSKUs);
    expect(reads.filter(path => path.includes("/inventory_item_group/"))).toHaveLength(2);
    const attempt = (await database.pool.query("SELECT state,planned_outbox_ids,affected_scopes FROM inventory.quantity_publication_attempts ORDER BY id DESC LIMIT 1")).rows[0];
    expect(attempt.state).toBe("succeeded"); expect(attempt.planned_outbox_ids).toHaveLength(2);
    expect(attempt.affected_scopes).toHaveLength(4);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_provider_requests")).rows[0].n).toBe(3);
  });

  it("refuses to reintroduce an archived SKU no longer in the live group", async () => {
    group.variantSKUs = [sku("P10"), sku("C500")];
    await expect(update()).rejects.toThrow("Provider group membership changed");
    expect(writes).toEqual([]);
    expect((await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts")).rows).toEqual([{ state: "not_sent" }]);
  });

  it("admits one active member while preserving its archived group siblings and historical stock records", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=102");
    const observed = await createEbayListingScopeObservation(database.pool);
    observed.groupSkus.push(sku("C200"));
    const bound = await observed.observe();
    expect(bound.identity.variants.map(member => member.variantId)).toEqual([101]);
    expect(bound.identity.retainedGroupSkus).toEqual([sku("C200"),sku("C500")]);
    const source = { ...ebayListingScopeSource(), variants: [{ productVariantId: 101, sku: sku("P10") }] };
    const historical = async () => (await database.pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM inventory.publication_variant_mapping_versions m WHERE product_variant_id IN (102,103)) AS mappings,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM inventory.inventory_publication_outbox o WHERE product_variant_id IN (102,103)) AS publications`)).rows[0];
    const before = await historical();
    await ensureEbayPublicationReady(database.pool, source, { commandKey: randomUUID(), actor: "single-active-group-test",
      now: new Date(), verifiedListing: { sourceIdentity: observed.source, observation: bound.observation } });
    await update();
    expect(writes.map(write => write.path)).toEqual(["/sell/inventory/v1/bulk_update_price_quantity",
      `/sell/inventory/v1/inventory_item_group/${groupKey}`]);
    expect(writes[0].body).toMatchObject({ requests: [{ sku: sku("P10") }] });
    expect(group.variantSKUs).toEqual(groupBody().variantSKUs);
    expect(await historical()).toEqual(before);
    expect(reads.some(path => path.includes(encodeURIComponent(sku("C500"))) || path.includes(encodeURIComponent(sku("C200"))))).toBe(false);
    expect((await database.pool.query("SELECT state,cardinality(planned_outbox_ids) AS planned FROM inventory.quantity_publication_attempts")).rows)
      .toEqual([{ state: "succeeded", planned: 1 }]);
  });

  it("rechecks topology after active quantity refresh before replacing the group", async () => {
    afterQuantityWrite = () => { group.variantSKUs = [sku("P10"),sku("C500")]; };
    await expect(update()).rejects.toThrow("Provider group membership changed");
    expect(writes).toHaveLength(2);
    expect(writes.every(write => write.path.endsWith("bulk_update_price_quantity"))).toBe(true);
    expect((await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts")).rows).toEqual([{ state: "uncertain" }]);
  });

  it("keeps new group publication behind complete canonical quantity admission", async () => {
    await expect(client().publishOfferByInventoryItemGroup(groupKey)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_TARGET_UNMAPPED" });
    expect(writes).toEqual([]);
  });

  it("does not borrow an archived source from a different provider environment", async () => {
    await expect(client("sandbox").createOrReplaceInventoryItemGroup(groupKey, groupBody()))
      .rejects.toMatchObject({ code: "PUBLICATION_LISTING_TARGET_UNMAPPED" });
    expect(writes).toEqual([]);
  });

  it("preserves the global stop before any source or provider work", async () => {
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=false");
    await expect(update()).rejects.toMatchObject({ code: "PUBLICATION_GLOBAL_STOP_ACTIVE" });
    expect(reads).toEqual([]); expect(writes).toEqual([]);
  });

  it("holds the archived source and Catalog fence through the physical group PUT", async () => {
    const competing = await database.pool.connect();
    beforeGroupWrite = async () => {
      for (const sql of [
        "UPDATE channels.channel_listings SET external_variant_id='reassigned-offer' WHERE product_variant_id=103",
        "UPDATE catalog.product_variants SET is_active=true WHERE id=103",
      ]) {
        await competing.query("BEGIN");
        await competing.query("SET LOCAL lock_timeout='100ms'");
        try { await expect(competing.query(sql)).rejects.toMatchObject({ code: "55P03" }); }
        finally { await competing.query("ROLLBACK"); }
      }
    };
    try { await update(); } finally { competing.release(); }
    expect(writes).toHaveLength(3);
    expect((await database.pool.query(`SELECT v.is_active,l.external_variant_id FROM catalog.product_variants v
      JOIN channels.channel_listings l ON l.product_variant_id=v.id WHERE v.id=103`)).rows)
      .toEqual([{ is_active: false, external_variant_id: "offer-C200" }]);
  });

  it("does not wait behind a lifecycle Catalog lock while holding the group scope", async () => {
    const lifecycle = await database.pool.connect();
    await lifecycle.query("BEGIN");
    await lifecycle.query("SELECT id FROM catalog.product_variants WHERE id=103 FOR UPDATE");
    try { await expect(update()).rejects.toMatchObject({ code: "55P03" }); }
    finally { await lifecycle.query("ROLLBACK"); lifecycle.release(); }
    expect(reads).toEqual([]); expect(writes).toEqual([]);
    expect((await database.pool.query("SELECT id FROM inventory.quantity_publication_attempts")).rows).toEqual([]);
  });

  it("rejects an active local member that claims the archived provider SKU", async () => {
    await database.pool.query("UPDATE channels.channel_listings SET external_sku=$1 WHERE product_variant_id=101", [sku("C200")]);
    await expect(update()).rejects.toMatchObject({ code: "LISTING_MEMBER_IDENTITY_CONFLICT" });
    expect(reads).toEqual([]); expect(writes).toEqual([]);
  });

  it("does not treat active ATP zero as archived or omit its exact quantity write", async () => {
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=0,reserved_qty=0,picked_qty=0,packed_qty=0");
    await update();
    expect(writes).toHaveLength(3);
    for (const write of writes.slice(0,2)) expect(write.body).toMatchObject({ requests: [{ offers: [{ availableQuantity: 0 }] }] });
    expect((await database.pool.query("SELECT product_variant_id FROM inventory.inventory_publication_outbox WHERE product_variant_id=103")).rows).toEqual([]);
  });
});
