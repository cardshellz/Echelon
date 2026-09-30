import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql, seedCompositionReviewedDryRun } from "../fixtures/inventory-cutover-composition-database.fixture";
import { installInitialScopeFixture, seedInitialScopeDropship } from "../fixtures/inventory-publication-initial-scope.fixture";
import { InventoryPublicationInitialScopeService } from "../../application/inventory-publication-initial-scope.service";
import { PostgresInitialPublicationScopeStore } from "../../infrastructure/inventory-publication-initial-scope.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "../../infrastructure/inventory-cutover-admission-fence.repository";
import { PostgresInventoryPublicationReadbackRepository } from "../../infrastructure/inventory-publication-readback.repository";
import { loadDeferredDropshipQuantityVariants } from "../../infrastructure/inventory-channel-exposure-runtime.repository";
import { createAuthorityAwareInventoryPublicationService, createInventoryChannelQuantityRuntimeService } from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { activateWalmartPublicationInventoryFixture } from "../fixtures/walmart-publication-inventory.fixture";
import { PostgresInventoryChannelExposureAdminStore } from "../../infrastructure/inventory-channel-exposure-admin.repository";
import { PostgresInventoryAvailabilityShadowRepository } from "../../infrastructure/inventory-availability-shadow.repository";
import { InventoryAvailabilityShadowService } from "../../application/inventory-availability-shadow.service";
import { assertDryRunSelectionsCurrent } from "../../infrastructure/inventory-availability-activation.repository";
import { PostgresInventoryAvailabilityActivationDryRunRepository } from "../../infrastructure/inventory-availability-activation-dry-run.repository";
import { isComparisonOnlyPublicationEvidence } from "../../domain/inventory-publication-coverage";
import { InventoryPublicationPrecutoverExclusionService } from "../../application/inventory-publication-precutover-exclusion.service";
import { PostgresPrecutoverExclusionStore } from "../../infrastructure/inventory-publication-precutover-exclusion.repository";
import type { ReviewPrecutoverExclusion } from "../../domain/inventory-publication-precutover-exclusion";
import { quantityPublicationScopeLockKey } from "../../infrastructure/quantity-publication-admission.repository";
import { PUBLICATION_TARGET_SCOPE_LOCK_SEED } from "../../infrastructure/inventory-publication-target-stop.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const NOW = new Date("2026-09-28T15:00:00.000Z");
const selection = { publicationTargetId: 1, expectedTargetRevision: "2" };

dbDescribe.sequential("pre-cutover explicit-scope non-live exclusion", () => {
  let database: InventoryCutoverTestDatabase;
  let service: InventoryPublicationPrecutoverExclusionService;
  let request: ReviewPrecutoverExclusion;
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installInitialScopeFixture(database.pool);
    const initial = new InventoryPublicationInitialScopeService(new PostgresInitialPublicationScopeStore(database.pool), { now: () => NOW });
    const review = await initial.review(selection);
    await initial.prepare({ ...selection, expectedReviewHash: review.reviewHash, idempotencyKey: "before-exclusion" }, "operator");
    service = new InventoryPublicationPrecutoverExclusionService(new PostgresPrecutoverExclusionStore(database.pool), { now: () => NOW });
    const target = (await database.pool.query("SELECT * FROM inventory.inventory_publication_targets WHERE id=1")).rows[0];
    const mapping = (await database.pool.query(`SELECT m.* FROM inventory.publication_variant_mapping_heads h
      JOIN inventory.publication_variant_mapping_versions m ON m.id=COALESCE(h.draft_mapping_id,h.active_mapping_id)
      WHERE h.publication_target_id=1 AND h.product_variant_id=101`)).rows[0];
    request = { reason: "Owner approved exclusion of this nonexistent provider item.", exclusions: [{
      publicationTargetId: 1, expectedTargetRevision: String(target.revision), channelId: target.channel_id,
      channelConnectionId: target.channel_connection_id, providerScopeType: target.provider_scope_type,
      externalScopeId: target.external_scope_id, productVariantId: 101,
      externalInventoryItemId: mapping.external_inventory_item_id, externalSku: mapping.external_sku,
      evidence: { provider: "shopify", observedAt: NOW.toISOString(), inventoryItemHttpStatus: 404 },
    }] };
  }, 30_000);
  afterEach(async () => { await database?.close(); });
  const command = async () => ({ ...request, expectedReviewHash: (await service.review(request)).reviewHash, idempotencyKey: "exclude-one" });
  async function protectedRows() {
    const result: Record<string, unknown> = {};
    for (const table of ["catalog.products", "catalog.product_variants", "inventory.inventory_levels", "inventory.inventory_lots",
      "inventory.inventory_transactions", "inventory.availability_claims", "inventory.availability_runtime_authority",
      "inventory.availability_activation_freezes", "inventory.quantity_publication_gate", "inventory.inventory_publication_outbox",
      "channels.channel_feeds", "inventory.publication_variant_mapping_heads", "inventory.publication_variant_mapping_versions",
      "inventory.publication_initial_scope_receipts", "wms.orders", "wms.order_items"]) {
      result[table] = (await database.pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
    }
    result.otherTargets = (await database.pool.query("SELECT * FROM inventory.inventory_publication_targets WHERE id<>1 ORDER BY id")).rows;
    return result;
  }
  it("appends an exclusion, preserves original history and all protected records, and retries exactly once", async () => {
    const before = await protectedRows(); const input = await command();
    expect((await service.review(request)).ready).toBe(true);
    const receipt = await service.apply(input, "operator");
    expect(receipt).toMatchObject({ runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false,
      targets: [{ changedProductVariantIds: [101], revision: "4", publicationRows: 0, alreadyApplied: false }] });
    expect(await service.apply(input, "operator")).toMatchObject({ targets: [{ alreadyApplied: true }] });
    expect((await database.pool.query("SELECT included,version::text FROM inventory.publication_membership_versions ORDER BY id")).rows)
      .toEqual([{ included: true, version: "1" }, { included: false, version: "2" }]);
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_applications")).rows).toHaveLength(1);
    expect(await protectedRows()).toEqual(before);
    const shadows = new PostgresInventoryAvailabilityShadowRepository(database.pool);
    await new InventoryAvailabilityShadowService(shadows).runProductShadow(20, { idempotencyKey: "exclusion-shadow" }, "operator");
    const preview = new PostgresInventoryChannelExposureAdminStore(drizzle(database.pool, { schema }), shadows);
    expect((await preview.preview(1, 20)).membership).toEqual({ mode: "explicit", includedVariantIds: [], excludedVariantIds: [101] });
  });
  it("rejects a stale revision without appending any version", async () => {
    const input = await command();
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET revision=revision+1 WHERE id=1");
    await expect(service.apply(input, "operator")).rejects.toMatchObject({ code: "PRECUTOVER_EXCLUSION_BLOCKED" });
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_versions")).rows).toHaveLength(1);
  });
  it.each([false,true])("excludes a positive-quantity unpublished eBay offer, retaining listing proof when present (%s)", async retained => {
    await database.pool.query("UPDATE channels.channels SET provider='ebay' WHERE id=$1", [request.exclusions[0]!.channelId]);
    request.exclusions[0]!.evidence = { provider: "ebay", observedAt: NOW.toISOString(), offerHttpStatus: 200,
      offerId: "unpublished-offer", status: "UNPUBLISHED", availableQuantity: 100, listingId: retained ? "old-listing" : null,
      ...(retained ? { retainedListingEvidence: { requestedItemId: "old-listing", observedAt: NOW.toISOString(), httpStatus: 200 as const,
        responseHash: "b".repeat(64), outcome: "inaccessible_to_seller" as const, errorCode: "17" as const } } : {}) };
    const before = await protectedRows(); const input = await command();
    expect((await service.review(request)).ready).toBe(true);
    expect(await service.apply(input, "operator")).toMatchObject({ providerWriteAttempted: false, outboxEnqueued: false,
      targets: [{ changedProductVariantIds: [101], revision: "4" }] });
    expect(await protectedRows()).toEqual(before);
    expect((await database.pool.query("SELECT review->'input'->'exclusions'->0->'evidence' AS evidence FROM inventory.publication_membership_applications")).rows)
      .toEqual([{ evidence: request.exclusions[0]!.evidence }]);
    expect(await service.apply(input, "operator")).toMatchObject({ targets: [{ alreadyApplied: true }] });
  });
  it("rolls every membership and revision write back when the audit fails", async () => {
    const input = await command();
    await database.pool.query(`CREATE FUNCTION public.reject_exclusion_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='inventory_availability.publication_scope.pre_cutover_excluded' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_exclusion_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_exclusion_audit()`);
    await expect(service.apply(input, "operator")).rejects.toThrow("injected audit failure");
    expect((await database.pool.query("SELECT revision::text FROM inventory.inventory_publication_targets WHERE id=1")).rows[0].revision).toBe("3");
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_versions")).rows).toHaveLength(1);
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_applications")).rows).toEqual([]);
  });
  it("serializes concurrent retries and rejects reusing the key with another reason or actor", async () => {
    const input = await command();
    const results = await Promise.all([service.apply(input, "operator"), service.apply(input, "operator")]);
    expect(results.map(result => result.targets[0]!.alreadyApplied).sort()).toEqual([false, true]);
    await expect(service.apply({ ...input, reason: "different reason" }, "operator")).rejects.toMatchObject({ code: "PRECUTOVER_EXCLUSION_REPLAY_CONFLICT" });
    await expect(service.apply(input, "other-operator")).rejects.toMatchObject({ code: "PRECUTOVER_EXCLUSION_REPLAY_CONFLICT" });
  });
  it("refuses a live provider lock without changing membership", async () => {
    const input = await command(); const row = request.exclusions[0]!;
    const provider = await database.pool.connect();
    const key = quantityPublicationScopeLockKey({ destinationKind: "channel_connection", connectionId: row.channelConnectionId,
      providerKey: "shopify", providerScopeType: row.providerScopeType, externalScopeId: row.externalScopeId,
      externalInventoryItemId: row.externalInventoryItemId, productId: null, productVariantId: null });
    try {
      await provider.query("SELECT pg_advisory_lock(hashtextextended($1,$2))", [key, PUBLICATION_TARGET_SCOPE_LOCK_SEED]);
      await expect(service.apply(input, "operator")).rejects.toMatchObject({ code: "PRECUTOVER_EXCLUSION_PROVIDER_BUSY" });
      expect((await database.pool.query("SELECT * FROM inventory.publication_membership_versions")).rows).toHaveLength(1);
    } finally {
      await provider.query("SELECT pg_advisory_unlock(hashtextextended($1,$2))", [key, PUBLICATION_TARGET_SCOPE_LOCK_SEED]);
      provider.release();
    }
  });
  it("does not make canonical authority available to this maintenance command", async () => {
    const input = await command();
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "legacy", expectedConfigurationRunId: null });
      await activateWalmartPublicationInventoryFixture(client);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    expect((await service.review(request)).ready).toBe(false);
    await expect(service.apply(input, "operator")).rejects.toThrow();
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_versions")).rows).toHaveLength(1);
  });
  it("rolls back the whole batch when a later destination fails, then commits both together", async () => {
    await database.pool.query(`INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,fulfillment_node_id,
      provider_scope_type,external_scope_id,publication_authority,state,change_reason,created_by)
      VALUES(36,8,1,'location','second-location','echelon','disabled','Fixture second target','operator');
      UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,
        activated_by='operator',activated_at=transaction_timestamp() WHERE id=3`);
    const initial = new InventoryPublicationInitialScopeService(new PostgresInitialPublicationScopeStore(database.pool), { now: () => NOW });
    const second = { publicationTargetId: 3, expectedTargetRevision: "2" };
    await initial.prepare({ ...second, expectedReviewHash: (await initial.review(second)).reviewHash,
      idempotencyKey: "second-initial" }, "operator");
    request.exclusions.push({ ...request.exclusions[0]!, publicationTargetId: 3, channelConnectionId: 8, externalScopeId: "second-location" });
    const input = await command();
    await database.pool.query(`CREATE FUNCTION public.reject_second_exclusion_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='inventory_availability.publication_scope.pre_cutover_excluded'
      AND NEW.target='inventory.inventory_publication_target:3' THEN RAISE EXCEPTION 'injected second-target failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_second_exclusion_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_second_exclusion_audit()`);
    await expect(service.apply(input, "operator")).rejects.toThrow("injected second-target failure");
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_applications")).rows).toEqual([]);
    expect((await database.pool.query("SELECT included FROM inventory.publication_membership_versions ORDER BY id")).rows)
      .toEqual([{ included: true }, { included: true }]);
    await database.pool.query("DROP TRIGGER reject_second_exclusion_audit ON public.audit_events");
    expect((await service.apply(input, "operator")).targets.map(row => row.publicationTargetId)).toEqual([1, 3]);
    await expect(service.apply({ ...input, exclusions: [input.exclusions[0]!] }, "operator"))
      .rejects.toMatchObject({ code: "PRECUTOVER_EXCLUSION_REPLAY_CONFLICT" });
  });
});

dbDescribe.sequential("audited preview-only initial publication scope", () => {
  let database: InventoryCutoverTestDatabase;
  let service: InventoryPublicationInitialScopeService;
  const makeService = () => new InventoryPublicationInitialScopeService(new PostgresInitialPublicationScopeStore(database.pool), { now: () => NOW });
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installInitialScopeFixture(database.pool);
    service = makeService();
  }, 30_000);
  afterEach(async () => { await database?.close(); });
  const review = () => service.review(selection);
  const command = async () => ({ ...selection, expectedReviewHash: (await review()).reviewHash, idempotencyKey: "initial-one" });
  async function protectedRows() {
    const result: Record<string, unknown> = {};
    for (const table of ["inventory.inventory_levels", "inventory.inventory_lots", "inventory.inventory_transactions",
      "inventory.availability_runtime_authority", "inventory.availability_claims", "inventory.availability_activation_freezes",
      "inventory.inventory_publication_outbox", "channels.channel_feeds", "inventory.publication_variant_mapping_versions"]) {
      result[table] = (await database.pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
    }
    return result;
  }
  async function assertPristine() {
    expect((await database.pool.query("SELECT membership_mode,revision::text,state FROM inventory.inventory_publication_targets WHERE id=1")).rows)
      .toEqual([{ membership_mode: "whole_product", revision: "2", state: "preview" }]);
    expect((await database.pool.query("SELECT * FROM inventory.publication_initial_scope_receipts")).rows).toEqual([]);
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_heads")).rows).toEqual([]);
  }
  it("distinguishes inactive and unconfigured comparison evidence without changing stock, feeds or publication", async () => {
    // Complete this reduced feed fixture for the real repeatable-read capture.
    await database.pool.query(`ALTER TABLE channels.channel_feeds ADD COLUMN last_synced_qty integer;
      ALTER TABLE channels.channel_feeds ADD COLUMN last_synced_at timestamptz;
      UPDATE channels.channel_feeds SET is_active=0,last_synced_qty=5,last_synced_at='2026-09-27T12:00:00Z';
      INSERT INTO channels.channels(id,name,provider) VALUES(104,'Unconfigured Walmart','walmart');`);
    // Target 2 is already explicit under its Walmart setup contract. Prepare
    // target 1 through the normal initial-scope owner, with no active feeds.
    const reviewed = await service.review(selection);
    expect(reviewed).toMatchObject({ ready: true, includedVariantIds: [], mappingImports: [], blockers: [] });
    await service.prepare({ ...selection, expectedReviewHash: reviewed.reviewHash,
      idempotencyKey: "comparison-scope-1" }, "operator");
    const shadows = new PostgresInventoryAvailabilityShadowRepository(database.pool);
    await new InventoryAvailabilityShadowService(shadows)
      .runProductShadow(20, { idempotencyKey: "comparison-shadow" }, "operator");
    const before = await protectedRows();
    const store = new PostgresInventoryChannelExposureAdminStore(drizzle(database.pool, { schema }), shadows);
    const scopes = await Promise.all([store.preview(1, 20), store.preview(2, 20)]);
    expect(scopes.map(scope => scope.membership)).toEqual([
      { mode: "explicit", includedVariantIds: [] },
      { mode: "explicit", includedVariantIds: [] },
    ]);
    const registeredTargets = (await database.pool.query<{ channelId: number }>(
      'SELECT channel_id AS "channelId" FROM inventory.inventory_publication_targets ORDER BY id',
    )).rows;
    const evidence = await new PostgresInventoryAvailabilityActivationDryRunRepository(database.pool)
      .captureCurrentPublicationEvidence([{ channelId: 36, productVariantId: 101 }, { channelId: 104, productVariantId: 101 }]);
    expect(evidence[0]).toMatchObject({ mappingState: "inactive", channelInventoryItemId: "test-item", lastAcknowledgedUnits: "5" });
    expect(evidence[0]!.configuredTargets).toHaveLength(2);
    expect(evidence[1]).toMatchObject({ mappingState: "missing", feedId: null, configuredTargets: [] });
    expect(evidence.map(row => isComparisonOnlyPublicationEvidence(row, scopes, registeredTargets))).toEqual([true, true]);
    expect(await protectedRows()).toEqual(before);
  });
  it("keeps a failed listing unchanged, persists its deferral, and reads canonical ATP without provider work", async () => {
    await database.pool.query(`INSERT INTO dropship.dropship_vendors(id,business_name) VALUES(1,'Test vendor');
      INSERT INTO dropship.dropship_store_connections(id,vendor_id,platform,status,external_account_id)
        VALUES(1,1,'ebay','connected','account-one');
      INSERT INTO inventory.inventory_publication_targets(destination_kind,channel_id,dropship_store_connection_id,fulfillment_node_id,
        provider_scope_type,external_scope_id,publication_authority,state,change_reason,created_by)
        VALUES('dropship_store_connection',36,1,1,'account','account-one','echelon','disabled','Fixture Dropship','operator');
      UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,activated_by='operator',activated_at=transaction_timestamp() WHERE id=3;
      INSERT INTO dropship.dropship_vendor_listings VALUES(1,1,101,'failed','unfinished-listing','unfinished-offer');
      INSERT INTO inventory.publication_source_binding_versions(publication_target_id,version,definition_hash,change_reason,idempotency_key,request_hash,created_by)
        VALUES(3,1,repeat('f',64),'Dropship warehouse','dropship-binding',repeat('f',64),'operator');
      INSERT INTO inventory.publication_source_binding_heads(publication_target_id,draft_binding_id,revision,updated_by,update_reason)
        SELECT 3,id,1,'operator','Dropship warehouse' FROM inventory.publication_source_binding_versions WHERE publication_target_id=3;
      INSERT INTO inventory.publication_source_binding_members(binding_id,publication_target_id,fulfillment_node_id,priority)
        SELECT id,3,1,1 FROM inventory.publication_source_binding_versions WHERE publication_target_id=3;`);
    const before = await protectedRows();
    const listingBefore = (await database.pool.query("SELECT * FROM dropship.dropship_vendor_listings")).rows;
    const input = { publicationTargetId: 3, expectedTargetRevision: "2" };
    const reviewed = await service.review(input);
    expect(reviewed).toMatchObject({ ready: true, includedVariantIds: [], deferredUnpublishedVariantIds: [101], mappingImports: [] });
    const command = { ...input, expectedReviewHash: reviewed.reviewHash, idempotencyKey: "defer-failed-dropship" };
    const prepared = await service.prepare(command, "operator");
    expect(prepared).toMatchObject({ deferredUnpublishedVariantIds: [101], includedVariantIds: [], alreadyApplied: false });
    expect(await service.prepare(command, "operator")).toMatchObject({ ...prepared, alreadyApplied: true });
    expect(await protectedRows()).toEqual(before);
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_heads WHERE publication_target_id=3")).rows).toEqual([]);
    const client = await database.pool.connect();
    try { expect([...await loadDeferredDropshipQuantityVariants(client, [3], [101, 102])]).toEqual([[3, [101]]]); }
    finally { client.release(); }

    const shadows = new PostgresInventoryAvailabilityShadowRepository(database.pool);
    await new InventoryAvailabilityShadowService(shadows).runProductShadow(20, { idempotencyKey: "deferred-atp-shadow" }, "operator");
    const preview = await new PostgresInventoryChannelExposureAdminStore(drizzle(database.pool, { schema }), shadows).preview(3, 20);
    expect(preview).toMatchObject({ deferredDropshipQuantityVariantIds: [101], rows: [], blockers: [], sourceBindingAuthority: "draft" });
    const reviewedRun = await seedCompositionReviewedDryRun(database.pool);
    reviewedRun.products[0]!.publicationTargetSelections = [{ publicationTargetId: 3, revision: "3",
      membership: { mode: "explicit", includedVariantIds: [], excludedVariantIds: [] },
      targetIdentity: { channelId: 36, destinationKind: "dropship_store_connection", channelConnectionId: null, dropshipStoreConnectionId: 1,
        providerScopeType: "account", externalScopeId: "account-one", publicationAuthority: "echelon", state: "preview" },
      quantityReadConfiguration: { productVariantIds: [101], sourceBindingId: preview.sourceBindingId!,
        sourceBindingVersion: preview.sourceBindingVersion!, sourceBindingDefinitionHash: preview.sourceBindingDefinitionHash!,
        policySelections: preview.selectedPolicies } }];
    const reviewClient = await database.pool.connect();
    try {
      await reviewClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await assertDryRunSelectionsCurrent(reviewClient, reviewedRun, false);
      const changed = structuredClone(reviewedRun);
      changed.products[0]!.publicationTargetSelections![0]!.quantityReadConfiguration!.sourceBindingDefinitionHash = "a".repeat(64);
      await expect(assertDryRunSelectionsCurrent(reviewClient, changed, false)).rejects.toMatchObject({ code: "ACTIVATION_SOURCE_BINDING_CHANGED" });
      await reviewClient.query("ROLLBACK");
    } finally { reviewClient.release(); }

    // Synthetic active lineage in this disposable fixture: exercise the actual
    // runtime DB reader/authority lock, not a mocked ATP number or provider.
    await database.pool.query(`UPDATE inventory.publication_source_binding_versions SET lifecycle_status='sealed',sealed_by='operator',sealed_at=transaction_timestamp()
      WHERE publication_target_id=3;
      UPDATE inventory.publication_source_binding_heads SET active_binding_id=draft_binding_id,draft_binding_id=NULL,
        revision=revision+1,updated_by='operator',update_reason='Fixture activation' WHERE publication_target_id=3;
      UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=3;`);
    const activationClient = await database.pool.connect();
    try {
      await activationClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await acquireInventoryCutoverFenceInsideTransaction(activationClient, { expectedAuthority: "legacy", expectedConfigurationRunId: null });
      await activateWalmartPublicationInventoryFixture(activationClient);
      await activationClient.query("COMMIT");
    } catch (error) { await activationClient.query("ROLLBACK"); throw error; }
    finally { activationClient.release(); }
    const legacy = vi.fn(async () => [{ productVariantId: 101, quantity: 999 }]);
    const quantities = await createInventoryChannelQuantityRuntimeService(database.pool).readProduct({ productId: 20,
      channelId: 36, target: { destinationKind: "dropship_store_connection", connectionId: 1, providerKey: "ebay" }, triggeredBy: "test" }, legacy);
    expect(quantities.authority).toBe("canonical");
    expect(quantities.rows).toHaveLength(1);
    expect(quantities.rows[0]).toMatchObject({ productVariantId: 101, publicationTargetIds: [3] });
    expect(quantities.rows[0]!.quantity).toBeGreaterThan(0);
    expect(quantities.rows[0]!.quantity).not.toBe(999);
    expect(legacy).not.toHaveBeenCalled();
    const publication = await createAuthorityAwareInventoryPublicationService(database.pool, { channelId: 36 })
      .publishProduct({ productId: 20, publicationTargetId: 3, dryRun: false }, legacy);
    expect(publication).toMatchObject({ authority: "canonical", publication: { rows: [], enqueuedRows: 0 } });
    expect((await database.pool.query("SELECT * FROM inventory.inventory_publication_outbox")).rows).toEqual([]);
    expect((await database.pool.query("SELECT * FROM dropship.dropship_vendor_listings")).rows).toEqual(listingBefore);
  });
  it("reviews without writes, then changes only target scope, membership and immutable audit evidence", async () => {
    const before = await protectedRows();
    expect(await review()).toMatchObject({ ready: true, includedVariantIds: [101], blockers: [] });
    await assertPristine();
    expect(await service.prepare(await command(), "operator")).toMatchObject({ publicationTargetId: 1, previousRevision: "2", revision: "3",
      includedVariantIds: [101], alreadyApplied: false, runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false });
    expect(await protectedRows()).toEqual(before);
    expect((await database.pool.query("SELECT membership_mode,state,revision::text FROM inventory.inventory_publication_targets WHERE id=1")).rows)
      .toEqual([{ membership_mode: "explicit", state: "preview", revision: "3" }]);
    expect((await database.pool.query("SELECT product_variant_id FROM inventory.publication_membership_heads")).rows).toEqual([{ product_variant_id: 101 }]);
    expect((await database.pool.query("SELECT actor,action FROM public.audit_events")).rows)
      .toEqual([{ actor: "operator", action: "inventory_availability.publication_scope.initialized" }]);
    for (const sql of ["UPDATE inventory.publication_initial_scope_receipts SET actor='rewrite'", "DELETE FROM inventory.publication_initial_scope_receipts",
      "TRUNCATE inventory.publication_initial_scope_receipts", "UPDATE inventory.publication_membership_versions SET included=false"]) {
      await expect(database.pool.query(sql)).rejects.toThrow();
    }
  });
  it("retries concurrently with one receipt and rejects a reused key with a different actor", async () => {
    const input = await command();
    const results = await Promise.all([service.prepare(input, "operator"), service.prepare(input, "operator")]);
    expect(results.map(row => row.alreadyApplied).sort()).toEqual([false, true]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.publication_initial_scope_receipts")).rows[0].count).toBe(1);
    await expect(service.prepare(input, "different-operator")).rejects.toMatchObject({ code: "INITIAL_SCOPE_COMMAND_CONFLICT" });
  });
  it("atomically records a bundle exclusion and never changes the listing or stock", async () => {
    const before = await protectedRows();
    const excludedVariants = [{ productVariantId: 101, reason: "unsupported_bundle" as const }];
    const input = { ...selection, excludedVariants };
    const reviewed = await service.review(input);
    expect(reviewed).toMatchObject({ ready: true, includedVariantIds: [], excludedVariants });
    const command = { ...input, expectedReviewHash: reviewed.reviewHash, idempotencyKey: "exclude-bundle" };
    const receipt = await service.prepare(command, "operator");
    expect(receipt).toMatchObject({ includedVariantIds: [], excludedVariants, alreadyApplied: false });
    expect(await service.prepare(command, "operator")).toEqual({ ...receipt, alreadyApplied: true });
    expect(await protectedRows()).toEqual(before);
    expect((await database.pool.query(`SELECT head.product_variant_id, version.included FROM inventory.publication_membership_heads head
      JOIN inventory.publication_membership_versions version ON version.id=head.active_version_id`)).rows)
      .toEqual([{ product_variant_id: 101, included: false }]);
    expect((await database.pool.query("SELECT evidence->'review'->'excludedVariants' AS exclusions FROM inventory.publication_initial_scope_receipts")).rows)
      .toEqual([{ exclusions: excludedVariants }]);
  });
  it("rejects adding or removing a bundle exclusion after review", async () => {
    const before = await command();
    const excludedVariants = [{ productVariantId: 101, reason: "unsupported_bundle" as const }];
    await expect(service.prepare({ ...before, excludedVariants }, "operator")).rejects.toMatchObject({ code: "INITIAL_SCOPE_REVIEW_STALE" });
    const excludedReview = await service.review({ ...selection, excludedVariants });
    await expect(service.prepare({ ...before, expectedReviewHash: excludedReview.reviewHash }, "operator"))
      .rejects.toMatchObject({ code: "INITIAL_SCOPE_REVIEW_STALE" });
    await assertPristine();
  });
  it.each([false, true])("selects provider reads from the actual membership decision (bundle excluded=%s)", async excluded => {
    const input = { ...selection, excludedVariants: excluded
      ? [{ productVariantId: 101, reason: "unsupported_bundle" as const }] : [] };
    const reviewed = await service.review(input);
    await service.prepare({ ...input, expectedReviewHash: reviewed.reviewHash, idempotencyKey: "readback-membership" }, "operator");
    const result = await new PostgresInventoryPublicationReadbackRepository(database.pool).begin({
      idempotencyKey: "readback-scope-test", requestHash: "a".repeat(64), requestedBy: "operator",
      reason: "Test included target/SKU selection without calling a provider", startedAt: NOW,
    });
    expect(result.kind).toBe("started");
    if (result.kind !== "started") throw new Error("Expected a new readback review");
    expect(result.targets.map(row => ({ target: row.publicationTargetId, variant: row.productVariantId })))
      .toEqual(excluded ? [] : [{ target: 1, variant: 101 }]);
    expect((await database.pool.query("SELECT * FROM inventory.inventory_publication_outbox")).rows).toEqual([]);
  });
  it("rolls back an omitted excluded membership decision", async () => {
    const input = { ...selection, excludedVariants: [{ productVariantId: 101, reason: "unsupported_bundle" as const }] };
    const reviewed = await service.review(input);
    await database.pool.query(`CREATE FUNCTION public.omit_exclusion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER omit_exclusion BEFORE INSERT ON inventory.publication_membership_heads FOR EACH ROW EXECUTE FUNCTION public.omit_exclusion()`);
    await expect(service.prepare({ ...input, expectedReviewHash: reviewed.reviewHash, idempotencyKey: "omitted-exclusion" }, "operator"))
      .rejects.toThrow("INITIAL_SCOPE_INCOMPLETE");
    await assertPristine();
  });
  it("allows only one of two different commands for the same destination", async () => {
    const input = await command();
    const results = await Promise.allSettled([service.prepare(input, "operator"), service.prepare({ ...input, idempotencyKey: "second" }, "operator")]);
    expect(results.map(row => row.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.publication_initial_scope_receipts")).rows[0].count).toBe(1);
  });
  it.each(["mapping", "feed", "tracking"])("rejects changed %s evidence instead of applying an old review", async kind => {
    const input = await command();
    if (kind === "mapping") await database.pool.query(`WITH mapping AS (
      INSERT INTO inventory.publication_variant_mapping_versions(publication_target_id,product_variant_id,version,external_inventory_item_id,
        external_sku,definition_hash,change_reason,idempotency_key,request_hash,created_by,supersedes_mapping_id)
      VALUES(1,101,2,'test-item','P5',repeat('c',64),'New reviewed version','stale-map',repeat('d',64),'operator',1) RETURNING id)
      UPDATE inventory.publication_variant_mapping_heads SET revision=revision+1,draft_mapping_id=mapping.id FROM mapping WHERE publication_target_id=1`);
    if (kind === "feed") await database.pool.query("UPDATE channels.channel_feeds SET is_active=0");
    if (kind === "tracking") await database.pool.query("UPDATE catalog.products SET inventory_tracking_default=false WHERE id=20");
    await expect(service.prepare(input, "operator")).rejects.toThrow();
    await assertPristine();
  });
  it("excludes non-stock products using catalog policy, not the legacy track_inventory counter", async () => {
    await database.pool.query("UPDATE catalog.products SET inventory_tracking_default=false WHERE id=20");
    expect(await review()).toMatchObject({ ready: true, includedVariantIds: [], excludedNonStockVariantIds: [101] });
    await service.prepare(await command(), "operator");
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_heads")).rows).toEqual([]);
  });
  it.each(["quarantined", "missing mapping"])("retains the existing publisher's %s skip without a provider write", async kind => {
    if (kind === "quarantined") await database.pool.query("UPDATE channels.channel_feeds SET quarantined_at=transaction_timestamp()");
    else await database.pool.query("UPDATE channels.channel_feeds SET channel_inventory_item_id=NULL");
    const before = await protectedRows();
    const reason = kind === "quarantined" ? "legacy_quarantined" : "legacy_missing_inventory_identity";
    expect(await review()).toMatchObject({ ready: true, includedVariantIds: [], excludedVariants: [{ productVariantId: 101, reason }] });
    await service.prepare(await command(), "operator");
    expect(await protectedRows()).toEqual(before);
    expect((await database.pool.query(`SELECT head.product_variant_id,version.included FROM inventory.publication_membership_heads head
      JOIN inventory.publication_membership_versions version ON version.id=head.active_version_id`)).rows)
      .toEqual([{ product_variant_id: 101, included: false }]);
  });
  it("imports a missing snapshot from the existing Shopify listing in the same transaction, with retry-safe audit", async () => {
    await database.pool.query("INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id) VALUES(36,102,'NEW','existing-item-102')");
    const before = await protectedRows();
    expect(await review()).toMatchObject({ ready: true, includedVariantIds: [101,102],
      mappingImports: [{ productVariantId: 102, externalInventoryItemId: "existing-item-102", externalSku: "NEW" }] });
    expect(await protectedRows()).toEqual(before);
    const input = await command();
    const results = await Promise.all([service.prepare(input,"operator"),service.prepare(input,"operator")]);
    expect(results.map(row => row.alreadyApplied).sort()).toEqual([false,true]);
    expect(results[0]).toMatchObject({ importedVariantIds: [102], runtimeAuthorityChanged: false, providerWriteAttempted: false });
    const after = await protectedRows();
    const mappings = after["inventory.publication_variant_mapping_versions"];
    expect({ ...after, "inventory.publication_variant_mapping_versions": before["inventory.publication_variant_mapping_versions"] }).toEqual(before);
    expect(mappings).toEqual(expect.arrayContaining(before["inventory.publication_variant_mapping_versions"] as unknown[]));
    expect((await database.pool.query(`SELECT mapping.product_variant_id,mapping.external_inventory_item_id,mapping.external_sku,
      mapping.lifecycle_status,head.active_mapping_id,head.revision::text FROM inventory.publication_variant_mapping_versions mapping
      JOIN inventory.publication_variant_mapping_heads head ON head.draft_mapping_id=mapping.id
      WHERE mapping.publication_target_id=1 AND mapping.product_variant_id=102`)).rows)
      .toEqual([{ product_variant_id:102,external_inventory_item_id:"existing-item-102",external_sku:"NEW",lifecycle_status:"draft",active_mapping_id:null,revision:"1" }]);
    expect((await database.pool.query("SELECT receipt->'importedVariantIds' AS imported FROM inventory.publication_initial_scope_receipts")).rows)
      .toEqual([{ imported:[102] }]);
    const readbacks = await new PostgresInventoryPublicationReadbackRepository(database.pool).begin({
      idempotencyKey:"import-readback",requestHash:"a".repeat(64),requestedBy:"operator",reason:"Verify the actual publication reader sees imported identities",startedAt:NOW });
    expect(readbacks.kind).toBe("started");
    if (readbacks.kind !== "started") throw new Error("Expected a new readback run");
    expect(readbacks.targets.map(row => row.productVariantId).sort((a,b)=>a-b)).toEqual([101,102]);
  });
  it("uses the eBay seller SKU when its Shopify inventory-ID column is null, without a duplicate mapping", async () => {
    await database.pool.query(`INSERT INTO channels.channels(id,name,provider) VALUES(67,'Existing eBay','ebay');
      INSERT INTO channels.channel_connections(id,channel_id) VALUES(10,67);
      INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,
      external_scope_id,publication_authority,state,change_reason,created_by) VALUES(67,10,1,'account','ebay-account','echelon','disabled','Existing eBay','operator');
      UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,activated_by='operator',activated_at=transaction_timestamp() WHERE id=3;
      INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id) VALUES(67,102,'NEW',NULL);`);
    const target = { publicationTargetId:3,expectedTargetRevision:"2" };
    const checked = await service.review(target);
    expect(checked).toMatchObject({ ready:true,includedVariantIds:[102],mappingImports:[{ productVariantId:102,externalInventoryItemId:"NEW",externalSku:"NEW" }] });
    await service.prepare({ ...target,expectedReviewHash:checked.reviewHash,idempotencyKey:"existing-ebay" },"operator");
    expect((await database.pool.query("SELECT channel_inventory_item_id FROM channels.channel_feeds WHERE channel_id=67")).rows)
      .toEqual([{ channel_inventory_item_id:null }]);
  });
  it("uses existing eBay listing SKU precedence and includes listing-only identities", async () => {
    await database.pool.query(`UPDATE channels.channels SET provider='ebay' WHERE id=36;
      INSERT INTO channels.channel_listings VALUES(1,36,101,'test-item','offer-existing'),(2,36,102,'LISTING-ONLY','offer-only');
      UPDATE channels.channel_feeds SET channel_inventory_item_id=NULL,channel_sku='stale-feed-sku';`);
    // The fixture's sealed mapping has another externalSku: a real conflict is
    // visible, never overwritten just because the automatic import is available.
    expect((await review()).blockers).toEqual(expect.arrayContaining([{ code:"INITIAL_SCOPE_MAPPING_UNVERIFIED",
      message:"The listed identity does not match the selected exact inventory mapping.",productVariantId:101 }]));
    expect((await review()).mappingImports).toEqual([{ productVariantId:102,externalInventoryItemId:"LISTING-ONLY",externalSku:"LISTING-ONLY",sourceKeys:["channel-listing:2"] }]);
  });
  it("rejects a stale automatic import when the existing listing changes", async () => {
    await database.pool.query("INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id) VALUES(36,102,'NEW','old-id')");
    const input = await command();
    await database.pool.query("UPDATE channels.channel_feeds SET channel_inventory_item_id='new-id' WHERE product_variant_id=102");
    await expect(service.prepare(input,"operator")).rejects.toMatchObject({ code:"INITIAL_SCOPE_REVIEW_STALE" });
    await assertPristine();
    expect((await database.pool.query("SELECT * FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=1 AND product_variant_id=102")).rows).toEqual([]);
  });
  it.each(["version insert","head insert","audit insert","head omitted"])("rolls back imported mappings, membership and receipt on %s failure", async failure => {
    await database.pool.query("INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id) VALUES(36,102,'NEW','new-id')");
    const input = await command(); const before = await protectedRows();
    const table = failure.startsWith("version") ? "inventory.publication_variant_mapping_versions"
      : failure.startsWith("head") ? "inventory.publication_variant_mapping_heads" : "public.audit_events";
    const body = failure.endsWith("omitted") ? "RETURN NULL;" : "RAISE EXCEPTION 'injected import failure';";
    await database.pool.query(`CREATE FUNCTION public.fail_mapping_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$;
      CREATE TRIGGER fail_mapping_import BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.fail_mapping_import()`);
    await expect(service.prepare(input,"operator")).rejects.toThrow();
    await assertPristine(); expect(await protectedRows()).toEqual(before);
  });
  it("rejects a silently changed imported identity at the deferred database receipt guard", async () => {
    await database.pool.query("INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id) VALUES(36,102,'NEW','reviewed-id')");
    const input=await command(); const before=await protectedRows();
    await database.pool.query(`CREATE FUNCTION public.change_import_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.external_inventory_item_id:='different-id'; RETURN NEW; END $$;
      CREATE TRIGGER change_import_identity BEFORE INSERT ON inventory.publication_variant_mapping_versions
      FOR EACH ROW EXECUTE FUNCTION public.change_import_identity()`);
    await expect(service.prepare(input,"operator")).rejects.toThrow("INITIAL_SCOPE_MAPPING_IMPORT_INCOMPLETE");
    await assertPristine(); expect(await protectedRows()).toEqual(before);
  });
  it.each(["membership insert", "membership omitted", "audit insert", "audit omitted"])("rolls back the complete transaction on %s failure", async failure => {
    const input = await command();
    const table = failure.startsWith("membership") ? "inventory.publication_membership_heads" : "public.audit_events";
    const omitted = failure.endsWith("omitted");
    const body = omitted ? "RETURN NULL;" : "RAISE EXCEPTION 'injected scope failure';";
    await database.pool.query(`CREATE FUNCTION public.fail_scope_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$;
      CREATE TRIGGER fail_scope_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.fail_scope_write()`);
    await expect(service.prepare(input, "operator")).rejects.toThrow(omitted ? "INITIAL_SCOPE_INCOMPLETE" : "injected scope failure");
    await assertPristine();
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_versions")).rows).toEqual([]);
  });
  it("retains the direct-update guard and unchanged new-Walmart default", async () => {
    await expect(database.pool.query("UPDATE inventory.inventory_publication_targets SET membership_mode='explicit',revision=revision+1 WHERE id=1")).rejects.toThrow();
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "legacy", expectedConfigurationRunId: null });
      await expect(client.query("UPDATE inventory.inventory_publication_targets SET membership_mode='explicit',revision=revision+1 WHERE id=1"))
        .rejects.toThrow("current audited initial-scope command");
    } finally { await client.query("ROLLBACK"); client.release(); }
    await database.pool.query(`INSERT INTO channels.channels(id,name,provider) VALUES(44,'New Walmart','walmart');
      INSERT INTO channels.channel_connections(id,channel_id) VALUES(9,44);
      INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,
      external_scope_id,publication_authority,state,change_reason,created_by) VALUES(44,9,1,'location','new-location','echelon','disabled','Fixture default','operator')`);
    expect((await database.pool.query("SELECT membership_mode FROM inventory.inventory_publication_targets WHERE external_scope_id='new-location'")).rows[0].membership_mode).toBe("explicit");
    await assertPristine();
  });
  it.each(["external_provider", "manual"])("does not commission a %s target", async authority => {
    await database.pool.query(`INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,
      external_scope_id,publication_authority,state,change_reason,created_by) VALUES(36,7,1,'location','outside',$1,'disabled','Fixture outside','operator');
      `, [authority]);
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,activated_by='operator',activated_at=transaction_timestamp() WHERE external_scope_id='outside'");
    const target = { publicationTargetId: 3, expectedTargetRevision: "2" };
    const checked = await service.review(target);
    expect(checked.ready).toBe(false);
    await expect(service.prepare({ ...target, expectedReviewHash: checked.reviewHash, idempotencyKey: "external" }, "operator"))
      .rejects.toMatchObject({ code: "INITIAL_SCOPE_REVIEW_BLOCKED" });
    await assertPristine();
  });
  it("rejects canonical authority without changing any authority or quantity evidence", async () => {
    await database.close();
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installInitialScopeFixture(database.pool, true);
    service = makeService();
    const before = await protectedRows();
    expect((await review()).blockers.map(row => row.code)).toContain("INITIAL_SCOPE_AUTHORITY_UNAVAILABLE");
    await expect(service.prepare(await command(), "operator")).rejects.toThrow("CUTOVER_AUTHORITY_CHANGED");
    expect(await protectedRows()).toEqual(before); await assertPristine();
  });
  it.each(["walmart", "future_provider"])("does not infer an empty legacy listing census for %s", async provider => {
    await database.pool.query("UPDATE channels.channels SET provider=$1 WHERE id=36", [provider]);
    await database.pool.query("DELETE FROM channels.channel_feeds");
    expect((await review()).blockers.map(row => row.code)).toContain("INITIAL_SCOPE_PROVIDER_UNSUPPORTED");
    await expect(service.prepare(await command(), "operator")).rejects.toMatchObject({ code: "INITIAL_SCOPE_REVIEW_BLOCKED" });
    await assertPristine();
  });
  it("rejects an open freeze at the actual database fence", async () => {
    const input = await command();
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "legacy", expectedConfigurationRunId: null });
      const run = (await client.query(`INSERT INTO inventory.availability_activation_runs(mode,state,request_hash,result_hash,
        expected_catalog_input_hash,expected_catalog_result_hash,captured_catalog_input_hash,captured_catalog_result_hash,
        evidence_payload,blocker_codes,idempotency_key,reason,requested_by,started_at,completed_at)
        VALUES('dry_run','ready_for_publication',repeat('a',64),repeat('a',64),repeat('a',64),repeat('a',64),repeat('a',64),repeat('a',64),
        '{}','[]','freeze-fixture','Unreleased fixture freeze','operator',$1,$1) RETURNING id`, [NOW])).rows[0];
      // Any open freeze must block initialization, even malformed legacy lineage.
      await client.query(`INSERT INTO inventory.availability_activation_freezes(activation_run_id,source_dry_run_id,evidence_hash,acquired_by,acquired_at)
        VALUES($1,$1,repeat('a',64),'operator',$2)`, [run.id, NOW]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    expect((await review()).ready).toBe(false);
    await expect(service.prepare(input, "operator")).rejects.toThrow("CUTOVER_CONFIGURATION_FREEZE_CHANGED");
    await assertPristine();
  });
  it("uses latest registered Dropship membership, not an empty compatibility table or old publication members", async () => {
    await seedInitialScopeDropship(database.pool);
    const target = { publicationTargetId: 3, expectedTargetRevision: "2" };
    const checked = await service.review(target);
    expect(checked).toMatchObject({ ready: true, includedVariantIds: [102] });
    await service.prepare({ ...target, expectedReviewHash: checked.reviewHash, idempotencyKey: "dropship" }, "operator");
    expect((await database.pool.query("SELECT product_variant_id FROM inventory.publication_membership_heads WHERE publication_target_id=3")).rows)
      .toEqual([{ product_variant_id: 102 }]);
  });
  it.each(["wrong account", "unresolved publication", "legacy only"])("blocks Dropship %s evidence instead of claiming an empty destination", async condition => {
    await seedInitialScopeDropship(database.pool);
    if (condition === "wrong account") await database.pool.query("UPDATE marketplace.provider_accounts SET external_account_id='other-account'");
    if (condition === "unresolved publication") await database.pool.query("INSERT INTO marketplace.listing_publications VALUES(21,10,'staged',NULL)");
    if (condition === "legacy only") await database.pool.query(`INSERT INTO dropship.dropship_vendor_listings VALUES(1,1,101,'active','unknown-listing','unknown-offer')`);
    expect((await service.review({ publicationTargetId: 3, expectedTargetRevision: "2" })).ready).toBe(false);
    await assertPristine();
  });
  it("keeps an unresolved planned eBay publication blocked even when no active listing exists", async () => {
    await database.pool.query(`UPDATE channels.channels SET provider='ebay' WHERE id=36;
      INSERT INTO marketplace.listing_scopes VALUES(10,'channel','ebay');
      INSERT INTO marketplace.channel_listing_scopes VALUES(10,36);
      INSERT INTO marketplace.listing_publications VALUES(11,10,'planned',NULL);`);
    const before = await protectedRows();
    const checked = await review();
    expect(checked).toMatchObject({ ready: false, blockers: expect.arrayContaining([
      expect.objectContaining({ code: "INITIAL_SCOPE_LISTING_OWNER_UNRESOLVED", message: expect.stringContaining("PENDING_PUBLICATION:10") }),
    ]) });
    await expect(service.prepare(await command(), "operator")).rejects.toMatchObject({ code: "INITIAL_SCOPE_REVIEW_BLOCKED" });
    await assertPristine(); expect(await protectedRows()).toEqual(before);
  });
  it.each(["failed", "queued"])("distinguishes a terminal failed Dropship push from pending work (%s)", async status => {
    await seedInitialScopeDropship(database.pool);
    await database.pool.query("INSERT INTO dropship.dropship_vendor_listings VALUES(1,1,101,$1,NULL,NULL)", [status]);
    const target = { publicationTargetId: 3, expectedTargetRevision: "2" };
    const before = await protectedRows();
    const checked = await service.review(target);
    if (status === "failed") {
      expect(checked).toMatchObject({ ready: true, includedVariantIds: [102], deferredUnpublishedVariantIds: [101], excludedVariants: [] });
      expect(await protectedRows()).toEqual(before);
      expect(await service.prepare({ ...target, expectedReviewHash: checked.reviewHash, idempotencyKey: "failed-dropship" }, "operator"))
        .toMatchObject({ deferredUnpublishedVariantIds: [101], includedVariantIds: [102], providerWriteAttempted: false });
      return;
    }
    expect(checked.ready).toBe(false);
    expect(checked.blockers.map(row => row.code)).toEqual(expect.arrayContaining([
      "INITIAL_SCOPE_LISTING_UNCERTAIN", "INITIAL_SCOPE_MAPPING_UNVERIFIED",
    ]));
    expect(checked.excludedVariants).toEqual([]);
    await expect(service.prepare({ ...target, expectedReviewHash: checked.reviewHash, idempotencyKey: "failed-dropship" }, "operator"))
      .rejects.toMatchObject({ code: "INITIAL_SCOPE_REVIEW_BLOCKED" });
    await assertPristine(); expect(await protectedRows()).toEqual(before);
  });
  it("invalidates a review when verification provenance changes even if the included SKUs do not", async () => {
    await seedInitialScopeDropship(database.pool);
    const target = { publicationTargetId: 3, expectedTargetRevision: "2" };
    const checked = await service.review(target);
    expect(checked.ready).toBe(true);
    await database.pool.query(`INSERT INTO marketplace.listing_verification_snapshots VALUES(15,10,11,'listing-one','2026-09-28T16:00:00Z');
      INSERT INTO marketplace.listing_verification_members VALUES(15,101,'P5','excluded',NULL,'offer-one'),(15,102,'NEW','included',NULL,'offer-two')`);
    await expect(service.prepare({ ...target, expectedReviewHash: checked.reviewHash, idempotencyKey: "new-verification" }, "operator"))
      .rejects.toMatchObject({ code: "INITIAL_SCOPE_REVIEW_STALE" });
    await assertPristine();
  });
  it("holds listing predicates through commit so a concurrent new feed cannot escape the reviewed census", async () => {
    const input = await command();
    let notifyPaused!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { notifyPaused = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    const store = new PostgresInitialPublicationScopeStore({ connect: async () => {
      const client = await database.pool.connect();
      return new Proxy(client, { get(target, property) {
        if (property === "query") return async (statement: string, values?: unknown[]) => {
          if (statement.startsWith("INSERT INTO inventory.publication_initial_scope_receipts")) { notifyPaused(); await resumed; }
          return target.query(statement, values);
        };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } }) as PoolClient;
    } });
    const pending = new InventoryPublicationInitialScopeService(store, { now: () => NOW }).prepare(input, "operator");
    // A failed preparation must also release the barrier wait, not hang the suite.
    await Promise.race([paused, pending.then(() => { throw new Error("Preparation did not reach the test barrier"); })]);
    const writer = await database.pool.connect();
    try {
      await writer.query("BEGIN"); await writer.query("SET LOCAL lock_timeout='200ms'");
      await expect(writer.query("INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id) VALUES(36,102,'NEW','new-item')"))
        .rejects.toMatchObject({ code: "55P03" });
    } finally { await writer.query("ROLLBACK"); writer.release(); resume(); }
    expect(await pending).toMatchObject({ includedVariantIds: [101] });
  });
});
