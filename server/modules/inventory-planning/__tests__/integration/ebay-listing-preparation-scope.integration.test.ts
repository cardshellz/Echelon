import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { WALMART_INVENTORY_NOW as now } from "../fixtures/walmart-publication-inventory.fixture";
import { installEbayListingScopeFixture, createEbayListingScopeObservation, ebayListingScopeSource as current,
  ebayListingScopeSku as sku } from "../fixtures/ebay-listing-preparation-scope.fixture";
import { ensureEbayPublicationReady } from "../../infrastructure/ebay-publication-readiness.repository";
import { createAuthorityAwareInventoryPublicationService } from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import { observeEbayQuantityRequest } from "../../application/quantity-provider-request-evidence";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;

dbDescribe.sequential("260PT observed listing scope through real Inventory preparation and publication", () => {
  let database: InventoryCutoverTestDatabase;
  const prepare = (source = current(), commandKey = randomUUID()) => ensureEbayPublicationReady(database.pool, source,
    { commandKey, actor: "scope-test", now });
  const publishProduct = () => createAuthorityAwareInventoryPublicationService(database.pool, { channelId: 67 })
    .publishProduct({ productId: 20, publicationTargetId: 3, dryRun: false }, async () => null);
  const retainedState = async () => (await database.pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(h)) FROM inventory.publication_variant_mapping_heads h WHERE h.publication_target_id=3 AND h.product_variant_id=103) AS mappings,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM inventory.inventory_publication_outbox o WHERE o.publication_target_id=3 AND o.product_variant_id=103) AS publications,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM inventory.quantity_publication_attempts a WHERE a.scope->>'productVariantId'='103') AS attempts,
    (SELECT jsonb_agg(to_jsonb(q) ORDER BY q.id) FROM inventory.quantity_provider_requests q JOIN inventory.quantity_publication_attempts a ON a.id=q.attempt_id WHERE a.scope->>'productVariantId'='103') AS requests`)).rows[0];
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installEbayListingScopeFixture(database.pool);
  }, 30_000);
  afterEach(async () => { await database?.close(); });
  async function observationFixture() {
    const f = await createEbayListingScopeObservation(database.pool);
    return { ...f, run: async (commandKey = randomUUID()) => {
      const observed = await f.observe();
      await ensureEbayPublicationReady(database.pool,
        { ...current(), variants: observed.identity.variants.filter(member => !member.catalogArchived)
          .map(member => ({ productVariantId: member.variantId, sku: member.sku })) },
        { commandKey, actor: "scope-test", now, verifiedListing: { sourceIdentity: f.source, observation: observed.observation } });
      return observed;
    } };
  }

  it.each([false, true])("prepares and publishes only active members without rebuilding an archived mapping (draft=%s)", async hasDraft => {
    if (hasDraft) await database.pool.query(`BEGIN;
      INSERT INTO inventory.publication_variant_mapping_versions(publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,
        definition_hash,change_reason,idempotency_key,request_hash,created_by)
        VALUES(3,103,1,'SHLZ-TOP-260PT-C200','SHLZ-TOP-260PT-C200',repeat('c',64),'Retired draft','retired-draft',repeat('c',64),'fixture');
      INSERT INTO inventory.publication_variant_mapping_heads(publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason)
        SELECT 3,103,id,1,'fixture','Retired draft' FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=3 AND product_variant_id=103;
      COMMIT`);
    const before = await retainedState(), f = await observationFixture(), commandKey = randomUUID();
    const observed = await f.run(commandKey);
    expect(observed.identity.variants.map(member => member.variantId)).toEqual([101, 102]);
    expect(observed.observation.evidence.nonMemberCandidates).toBeUndefined();
    expect(await retainedState()).toEqual(before);
    f.setObservedAt(new Date(now.getTime() + 60_000));
    await f.run(commandKey);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.ebay_publication_readiness_applications WHERE command_key=$1", [commandKey])).rows[0].n).toBe(1);
    expect(await retainedState()).toEqual(before);
    const result = await publishProduct();
    expect(result.authority).toBe("canonical");
    if (result.authority === "canonical") expect(result.publication.rows.map(row => row.productVariantId)).toEqual([101,102]);
    expect(await retainedState()).toEqual(before);
  });

  it.each(["unknown", "published elsewhere", "group related", "missing offer", "missing item"])(
    "keeps active preparation independent of an archived SKU with %s provider evidence", async scenario => {
      const f = await observationFixture();
      if (scenario === "unknown") f.retired.status = 503;
      if (scenario === "published elsewhere") { f.retired.offers[0].status = "PUBLISHED"; f.retired.offers[0].listing = { listingId: "other-listing", listingStatus: "ACTIVE" }; }
      if (scenario === "group related") f.retired.groups = ["SHLZ-TOP-260PT"];
      if (scenario === "missing offer") f.retired.offers = [];
      if (scenario === "missing item") f.retired.itemExists = false;
      const commandKey = randomUUID(), before = await retainedState();
      await expect(f.run(commandKey)).resolves.toBeDefined();
      expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.ebay_publication_readiness_applications WHERE command_key=$1", [commandKey])).rows[0].n).toBe(1);
      expect(await retainedState()).toEqual(before);
      const result = await publishProduct();
      if (result.authority === "canonical") expect(result.publication.rows.map(row => row.productVariantId)).toEqual([101,102]);
    });

  it.each(["PUBLISHED", "UNPUBLISHED"])("preserves archived %s provider topology without including it in inventory preparation", async status => {
    const f = await observationFixture();
    f.groupSkus.push(sku("C200"));
    f.retired.groups = ["SHLZ-TOP-260PT"];
    f.retired.offers[0].status = status;
    if (status === "PUBLISHED") f.retired.offers[0].listing = { listingId: "listing-260", listingStatus: "ACTIVE" };
    const before = await retainedState();
    const observed = await f.run();
    expect(observed.observation.evidence.groupVariantSkus).toContain(sku("C200"));
    expect(await retainedState()).toEqual(before);
    const result = await publishProduct();
    if (result.authority === "canonical") expect(result.publication.rows.map(row => row.productVariantId)).toEqual([101,102]);
  });

  it("preserves an independently queued retired-zero obligation across exact content preparation", async () => {
    // Model an old obligation created before archival. Current publication must
    // leave its request evidence intact without creating another archived write.
    await database.pool.query(`UPDATE catalog.product_variants SET is_active=true WHERE id=103;
      INSERT INTO channels.channel_variant_overrides(channel_id,product_variant_id,is_listed) VALUES(67,103,0)`);
    await prepare({ ...current(), variants: [...current().variants, { productVariantId: 103, sku: sku("C200") }] });
    await publishProduct();
    const scope = { destinationKind: "channel_connection" as const, connectionId: 9, providerKey: "ebay" as const,
      providerScopeType: "account" as const, externalScopeId: "seller-36", externalInventoryItemId: sku("C200"),
      productId: 20, productVariantId: 103 };
    const outboxId = (await database.pool.query<{ id: string }>(
      "SELECT id::text FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 AND product_variant_id=103 ORDER BY desired_revision DESC LIMIT 1")).rows[0].id;
    await expect(new PostgresQuantityPublicationAdmission(database.pool, () => now).runListing(scope,
      async () => ({ outboxId, quantity: 0 }), async quantity => {
        expect(quantity).toBe(0);
        await observeEbayQuantityRequest({ method: "PUT", path: `/sell/inventory/v1/inventory_item/${sku("C200")}`,
          body: { availability: { shipToLocationAvailability: { quantity } } } }, async () => {
          throw new Error("Synthetic lost response for the historical zero");
        });
      })).rejects.toThrow("Synthetic lost response for the historical zero");
    const before = await retainedState();
    expect(before.publications).toEqual([expect.objectContaining({ desired_quantity: 0, state: "queued", external_inventory_item_id_snapshot: sku("C200") })]);
    expect(before.attempts).toEqual([expect.objectContaining({ state: "uncertain" })]);
    expect(before.requests).toHaveLength(1);
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=103");
    await (await observationFixture()).run();
    expect(await retainedState()).toEqual(before);
    const result = await publishProduct();
    expect(result.authority).toBe("canonical");
    if (result.authority === "canonical") expect(result.publication.rows.map(row => row.productVariantId)).toEqual([101,102]);
    expect(await retainedState()).toEqual(before);
  });
});
