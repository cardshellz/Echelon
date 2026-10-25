import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { activateWalmartPublicationInventoryFixture, installWalmartPublicationInventoryFixture } from "../fixtures/walmart-publication-inventory.fixture";
import { installCutoverAdmissionFixturePrerequisites } from "../fixtures/inventory-cutover-admission.fixture";
import { installPublicationSelectionWorkFixture } from "../fixtures/publication-selection-work.fixture";
import { PostgresQuantityPublicationAdmission, quantityPublicationScopeLockKey, retainCatchupScopes } from "../../infrastructure/quantity-publication-admission.repository";
import { QuantityPublicationCatchupService, type QuantityPublicationCatchup } from "../../application/quantity-publication-admission.port";
import { readPublicationStockSelection } from "../../infrastructure/inventory-publication-selection.reader";
import { PostgresPublicationSelectionWork } from "../../infrastructure/publication-selection-work.repository";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";

// Every repository call uses the real disposable Pool. Prevent unrelated
// module-level application composition from opening the application's database.
vi.mock("../../../../db", () => ({ pool: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;
const NOW = new Date("2026-10-20T12:00:00.000Z");
const providers = {
  shopify: { channelId: 35, connectionId: 7, targetId: 1, providerScopeType: "location", externalScopeId: "test-location" },
  walmart: { channelId: 36, connectionId: 8, targetId: 2, providerScopeType: "location", externalScopeId: "test-location" },
  ebay: { channelId: 67, connectionId: 9, targetId: 3, providerScopeType: "account", externalScopeId: "archive-seller" },
} as const;
type Provider = keyof typeof providers;
type Member = { scope: QuantityPublicationScope; channelId: number; targetId: number; mappingId: string; productId: number; variantId: number };

dbDescribe.sequential("archived catch-up settlement through canonical mapping and selection owners", () => {
  let database: InventoryCutoverTestDatabase;
  let admission: PostgresQuantityPublicationAdmission;
  let sequence = 0;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, cutoverCompositionBaseSql);
    await installWalmartPublicationInventoryFixture(database.pool);
    await activateWalmartPublicationInventoryFixture(database.pool);
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=1");
    await installPublicationSelectionWorkFixture(database.pool);
    await database.pool.query(readFileSync(resolve("migrations/900000016000018560001_quantity_publication_archived_catchup_settlement.sql"), "utf8"));
    await database.pool.query(`
      INSERT INTO channels.channels(id,name,provider,status,sync_enabled,sync_mode)
        VALUES(67,'Archive fixture eBay','ebay','active',true,'live');
      INSERT INTO channels.channel_connections(id,channel_id) VALUES(9,67);
      INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,
        external_scope_id,publication_authority,state,change_reason,created_by)
        VALUES(67,9,1,'account','archive-seller','echelon','disabled','Archive fixture destination','fixture');
      UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,
        activated_by='fixture',activated_at=transaction_timestamp() WHERE id=3;
      UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=3;
    `);
    await installCutoverAdmissionFixturePrerequisites(database.pool);
    await database.pool.query(readFileSync(resolve("migrations/236_inventory_cutover_admission.sql"), "utf8"));
    admission = new PostgresQuantityPublicationAdmission(database.pool, () => new Date(NOW));
  }, 60_000);
  afterAll(async () => { await database?.close(); });

  async function activateMapping(targetId: number, variantId: number, item: string, key: string): Promise<string> {
    const client = await database.pool.connect();
    let mappingId: string;
    try {
      await client.query("BEGIN");
      mappingId = (await client.query<{ id: string }>(`
        INSERT INTO inventory.publication_variant_mapping_versions
          (publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,
           definition_hash,change_reason,idempotency_key,request_hash,created_by)
        VALUES($1,$2,1,$3,$3,repeat('a',64),'Exact archived fixture item',$4,repeat('a',64),'fixture')
        RETURNING id::text`, [targetId, variantId, item, key])).rows[0].id;
      await client.query(`INSERT INTO inventory.publication_variant_mapping_heads
        (publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason)
        VALUES($1,$2,$3,1,'fixture','Exact draft fixture mapping')`, [targetId, variantId, mappingId]);
      await client.query(`UPDATE inventory.publication_variant_mapping_versions
        SET lifecycle_status='sealed',sealed_by='fixture',sealed_at=$2 WHERE id=$1`, [mappingId, NOW]);
      await client.query(`UPDATE inventory.publication_variant_mapping_heads
        SET active_mapping_id=draft_mapping_id,draft_mapping_id=NULL,revision=revision+1
        WHERE publication_target_id=$1 AND product_variant_id=$2`, [targetId, variantId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }

    return mappingId;
  }

  async function member(provider: Provider = "ebay"): Promise<Member> {
    const selected = providers[provider];
    const number = ++sequence;
    const productId = 1_000 + number;
    const variantId = 10_000 + number;
    const item = "ARCHIVE-" + provider + "-" + number;
    await database.pool.query("INSERT INTO catalog.products(id,sku) VALUES($1,$2)", [productId, "PRODUCT-" + item]);
    await database.pool.query("INSERT INTO catalog.product_variants(id,product_id,sku) VALUES($1,$2,$3)", [variantId, productId, item]);
    const mappingId = await activateMapping(selected.targetId, variantId, item, "archive-mapping-" + number);
    await database.pool.query(`INSERT INTO channels.channel_feeds
      (channel_id,product_variant_id,channel_variant_id,channel_inventory_item_id,channel_sku)
      VALUES($1,$2,$3,$3,$3)`, [selected.channelId, variantId, item]);
    await database.pool.query(`INSERT INTO channels.channel_listings
      (channel_id,product_variant_id,external_product_id,external_variant_id,external_sku,sync_status)
      VALUES($1,$2,$3,$4,$5,'synced')`, [selected.channelId, variantId, "listing-" + item, "offer-" + item, item]);
    return { channelId: selected.channelId, targetId: selected.targetId, mappingId, productId, variantId,
      scope: { destinationKind: "channel_connection", connectionId: selected.connectionId, providerKey: provider,
        providerScopeType: selected.providerScopeType, externalScopeId: selected.externalScopeId,
        externalInventoryItemId: item, productId, productVariantId: variantId } };
  }
  async function archive(target: Member, kind: "variant" | "product" = "variant"): Promise<void> {
    // Real Catalog writes retain migration 0743's gate/invalidation triggers.
    if (kind === "variant") await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=$1", [target.variantId]);
    else await database.pool.query("UPDATE catalog.products SET status='archived' WHERE id=$1", [target.productId]);
  }
  async function retain(scope: QuantityPublicationScope): Promise<QuantityPublicationCatchup> {
    await retainCatchupScopes(database.pool, [scope], null, "archive_test_retained_event", NOW);
    const row = (await database.pool.query<{ id: string; revision: string; attempt_boundary_id: string; scope: QuantityPublicationScope }>(
      "SELECT id::text,revision::text,attempt_boundary_id::text,scope FROM inventory.quantity_publication_catchup WHERE scope_key=$1",
      [quantityPublicationScopeLockKey(scope)])).rows[0];
    return { catchupId: row.id, revision: row.revision, attemptBoundaryId: row.attempt_boundary_id, scope: row.scope };
  }
  async function catchup(claim: QuantityPublicationCatchup): Promise<Record<string, unknown>> {
    return (await database.pool.query<{ record: Record<string, unknown> }>(
      "SELECT to_jsonb(c) AS record FROM inventory.quantity_publication_catchup c WHERE id=$1", [claim.catchupId])).rows[0].record;
  }
  async function audit(claim: QuantityPublicationCatchup): Promise<Record<string, unknown>[]> {
    return (await database.pool.query("SELECT * FROM inventory.quantity_publication_catchup_settlements WHERE catchup_id=$1 ORDER BY revision", [claim.catchupId])).rows;
  }
  async function stockSnapshot(): Promise<unknown> {
    return (await database.pool.query(`SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.id),'[]'::jsonb) FROM inventory.inventory_publication_outbox o) AS outboxes,
      (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM inventory.quantity_publication_attempts a) AS attempts,
      (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.publication_target_id,h.product_variant_id),'[]'::jsonb)
        FROM inventory.publication_variant_mapping_heads h) AS mapping_heads,
      (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM inventory.publication_variant_mapping_versions m) AS mappings`)).rows[0];
  }
  async function selection(target: Member) {
    return readPublicationStockSelection(database.pool, { destinationKind: "channel_connection", channelId: target.channelId,
      channelConnectionId: target.scope.connectionId, dropshipStoreConnectionId: null },
    { productId: target.productId, productVariantIds: [target.variantId], now: NOW });
  }
  async function existingOutbox(target: Member): Promise<void> {
    await database.pool.query(`INSERT INTO inventory.inventory_publication_outbox
      (activation_run_id,publication_target_id,product_variant_id,desired_revision,desired_quantity,channel_connection_id_snapshot,
       external_scope_id_snapshot,external_inventory_item_id_snapshot,state,idempotency_key,payload_hash,available_at,
       publication_phase,channel_id_snapshot,provider_key_snapshot,provider_scope_type_snapshot,publication_target_revision_snapshot)
      SELECT a.activation_run_id,t.id,$2,1,9,t.channel_connection_id,t.external_scope_id,$3,'queued',$4,repeat('a',64),$5,
        'full',t.channel_id,$6,t.provider_scope_type,t.revision
      FROM inventory.availability_runtime_authority a CROSS JOIN inventory.inventory_publication_targets t
      WHERE a.singleton_key=true AND t.id=$1`,
    [target.targetId, target.variantId, target.scope.externalInventoryItemId, "archive-existing-outbox-" + target.variantId, NOW, target.scope.providerKey]);
  }
  async function unresolved(target: Member, state: "running" | "uncertain"): Promise<void> {
    const scopeKey = quantityPublicationScopeLockKey(target.scope);
    // Synthetic historical uncertainty through the real immutable attempt
    // schema. Settlement must not turn it into a provider outcome.
    await database.pool.query(`INSERT INTO inventory.quantity_publication_attempts
      (owner_token,owner_kind,gate_epoch,scope_key,scope,affected_scope_keys,affected_scopes,state,started_at)
      SELECT $1,'legacy',epoch,$2,$3::jsonb,ARRAY[$2],jsonb_build_array($3::jsonb),$4,$5
      FROM inventory.quantity_publication_gate WHERE singleton`,
    [randomUUID(), scopeKey, JSON.stringify(target.scope), state, NOW]);
  }
  async function waitForSettlementLock(): Promise<void> {
    await vi.waitFor(async () => {
      const rows = await database.pool.query(`SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE a.datname=current_database() AND l.locktype='advisory' AND l.classid=918419 AND l.objid=0
          AND l.mode='ShareLock' AND l.granted AND a.wait_event_type='Lock'`);
      expect(rows.rowCount).toBeGreaterThan(0);
    }, { timeout: 1_500, interval: 10 });
  }

  it("reactivation creates fresh active quantity work through the real selection worker without changing its archived receipt", async () => {
    // Run before synthetic members are added: product20 is the fixture's fully
    // modeled product, so the default worker calls the actual ATP/runtime owner.
    const scope: QuantityPublicationScope = {
      destinationKind: "channel_connection", connectionId: 8, providerKey: "walmart",
      providerScopeType: "location", externalScopeId: "test-location",
      externalInventoryItemId: "P5", productId: 20, productVariantId: 101,
    };
    const claim = await retain(scope);
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=101");
    expect(await admission.settleArchived(claim)).toBe(true);
    const archivedReceipt = await audit(claim);
    const settledCatchup = await catchup(claim);
    expect(archivedReceipt).toHaveLength(1);
    expect((await database.pool.query("SELECT * FROM inventory.inventory_publication_outbox")).rows).toEqual([]);
    const beforeAttempts = (await database.pool.query("SELECT * FROM inventory.quantity_publication_attempts ORDER BY id")).rows;

    // Catalog's real 0743 trigger retains new selection work independently of
    // the completed archived catch-up; no fabricated catch-up event is needed.
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true WHERE id=101");
    const pendingWork = (await database.pool.query<{ pending: boolean; due_at_ms: string }>(`
      SELECT revision>acknowledged_revision AS pending,
        ceil(extract(epoch FROM next_attempt_at)*1000)::bigint::text AS due_at_ms
      FROM inventory.publication_selection_work WHERE product_id=20`)).rows;
    expect(pendingWork).toHaveLength(1);
    expect(pendingWork[0].pending).toBe(true);
    // The real trigger uses PostgreSQL's transaction clock, not the archived
    // receipt's fixed NOW. Round its microsecond deadline up to a JS millisecond
    // and drive the injected worker clock across that recorded boundary.
    const dueAtMs = Number(pendingWork[0].due_at_ms);
    expect(Number.isSafeInteger(dueAtMs)).toBe(true);
    let workerNowMs = dueAtMs - 1;
    const worker = new PostgresPublicationSelectionWork(database.pool, () => new Date(workerNowMs));
    expect(await worker.processDue(1)).toEqual({ planned: 0, blocked: 0, skipped: 0 });
    expect((await database.pool.query("SELECT * FROM inventory.inventory_publication_outbox")).rows).toEqual([]);
    expect((await database.pool.query(`SELECT revision>acknowledged_revision AS pending
      FROM inventory.publication_selection_work WHERE product_id=20`)).rows).toEqual([{ pending: true }]);
    workerNowMs = dueAtMs;
    expect(await worker.processDue(1)).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect((await database.pool.query(`SELECT desired_quantity::text,state,provider_key_snapshot,
      channel_connection_id_snapshot,external_inventory_item_id_snapshot
      FROM inventory.inventory_publication_outbox WHERE publication_target_id=2 AND product_variant_id=101`)).rows)
      .toEqual([{ desired_quantity: "17", state: "queued", provider_key_snapshot: "walmart",
        channel_connection_id_snapshot: 8, external_inventory_item_id_snapshot: "P5" }]);
    expect((await database.pool.query(`SELECT revision=acknowledged_revision AS acknowledged,last_error_code
      FROM inventory.publication_selection_work WHERE product_id=20`)).rows)
      .toEqual([{ acknowledged: true, last_error_code: null }]);
    expect((await database.pool.query("SELECT * FROM inventory.quantity_publication_attempts ORDER BY id")).rows).toEqual(beforeAttempts);
    expect(await catchup(claim)).toEqual(settledCatchup);
    expect(await audit(claim)).toEqual(archivedReceipt);
    expect(await admission.settleArchived(claim)).toBe(false);
    expect(await worker.processDue(1)).toEqual({ planned: 0, blocked: 0, skipped: 0 });
  });
  it("the real catch-up service settles archived work without entering replanning or a provider callback", async () => {
    const target = await member();
    const claim = await retain(target.scope);
    await archive(target);
    await existingOutbox(target);
    const before = await stockSnapshot();
    const replan = vi.fn(async () => { throw new Error("Archived work must not reach quantity replanning."); });
    expect(await new QuantityPublicationCatchupService(admission, replan).processDue()).toEqual({ completed: 1, failed: 0 });
    expect(replan).not.toHaveBeenCalled();
    expect(await catchup(claim)).toMatchObject({ completed_revision: Number(claim.revision) });
    expect(await audit(claim)).toHaveLength(1);
    expect(await stockSnapshot()).toEqual(before);
  });

  it.each((Object.keys(providers) as Provider[]).flatMap(provider =>
    (["variant", "product"] as const).map(kind => ({ provider, kind }))))
  ("settles $provider $kind archival with exact selection and immutable before/after evidence", async ({ provider, kind }) => {
    const target = await member(provider);
    const claim = await retain(target.scope);
    await archive(target, kind);
    await existingOutbox(target);
    const expectedSelection = await selection(target);
    expect(expectedSelection.variants).toEqual([expect.objectContaining({ productVariantId: target.variantId, action: "none", catalogArchived: true, blockers: [] })]);
    const before = await catchup(claim);
    const stock = await stockSnapshot();
    expect(await admission.settleArchived(claim)).toBe(true);
    const after = await catchup(claim);
    expect(after).toMatchObject({ completed_revision: Number(claim.revision), last_error_code: null, last_error_message: null });
    const rows = await audit(claim);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ catchup_id: claim.catchupId, revision: claim.revision,
      attempt_boundary_id: claim.attemptBoundaryId, scope_key: quantityPublicationScopeLockKey(target.scope), scope: target.scope,
      basis: "catalog_archived", selection_fingerprint: expectedSelection.fingerprint, before_state: before, after_state: after,
      occurred_at: NOW,
      evidence: { member: { product_id: target.productId, product_variant_id: target.variantId, target_id: target.targetId,
        mapping_id: target.mappingId, mapping_revision: "2", destinationKind: "channel_connection", channelId: target.channelId,
        channelConnectionId: target.scope.connectionId, dropshipStoreConnectionId: null }, selection: expectedSelection } });
    expect(rows[0].actor).toEqual(expect.any(String));
    expect(String(rows[0].actor).trim()).not.toBe("");
    expect(await stockSnapshot()).toEqual(stock);
  });


  it.each(["active with zero stock", "channel-only exclusion", "not inventory managed"] as const)
  ("does not settle %s as Catalog archival", async scenario => {
    const target = await member();
    const claim = await retain(target.scope);
    if (scenario === "active with zero stock") {
      await database.pool.query(`INSERT INTO inventory.inventory_levels
        (id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty)
        VALUES($1,100,$2,0,0,0,0)`, [target.variantId, target.variantId]);
      expect((await database.pool.query("SELECT variant_qty FROM inventory.inventory_levels WHERE product_variant_id=$1",
        [target.variantId])).rows).toEqual([{ variant_qty: 0 }]);
    }

    if (scenario === "channel-only exclusion") await database.pool.query(
      "INSERT INTO channels.channel_variant_overrides(channel_id,product_variant_id,is_listed) VALUES($1,$2,0)", [target.channelId, target.variantId]);
    if (scenario === "not inventory managed") await database.pool.query("UPDATE catalog.product_variants SET track_inventory=false WHERE id=$1", [target.variantId]);
    const selected = await selection(target);
    expect(selected.variants[0].catalogArchived).not.toBe(true);
    expect(selected.variants[0].action).toBe(scenario === "active with zero stock" ? "publish" : "zero");
    const before = await catchup(claim);
    expect(await admission.settleArchived(claim)).toBe(false);
    expect(await catchup(claim)).toEqual(before);
    expect(await audit(claim)).toEqual([]);
  });

  it("uses the sealed ATP mapping after the listing owner has cleared its external identities", async () => {
    const target = await member();
    const claim = await retain({ ...target.scope, productId: null, productVariantId: null });
    await archive(target);
    await database.pool.query(`UPDATE channels.channel_listings SET external_sku=NULL,external_product_id=NULL,external_variant_id=NULL,sync_status='ended'
      WHERE channel_id=$1 AND product_variant_id=$2`, [target.channelId, target.variantId]);
    await database.pool.query(`UPDATE channels.channel_feeds SET channel_sku=NULL,channel_inventory_item_id=NULL,channel_variant_id=NULL,is_active=0
      WHERE channel_id=$1 AND product_variant_id=$2`, [target.channelId, target.variantId]);
    expect(await admission.settleArchived(claim)).toBe(true);
    expect((await audit(claim))[0]).toMatchObject({ evidence: { member: { mapping_id: target.mappingId, product_variant_id: target.variantId } } });
  });

  it.each(["revision", "boundary", "product hint", "variant hint", "external scope", "provider", "claim id"] as const)
  ("rejects a stale or tampered %s without acknowledging its saved claim", async field => {
    const target = await member();
    const claim = await retain(target.scope);
    await archive(target);
    const bad: QuantityPublicationCatchup = { ...claim, scope: { ...claim.scope } };
    if (field === "revision") bad.revision = String(BigInt(claim.revision) + BigInt(1));
    if (field === "boundary") bad.attemptBoundaryId = String(BigInt(claim.attemptBoundaryId) + BigInt(1));
    if (field === "product hint") bad.scope.productId = target.productId + 100_000;
    if (field === "variant hint") bad.scope.productVariantId = target.variantId + 100_000;
    if (field === "external scope") bad.scope.externalScopeId += "-other";
    if (field === "provider") bad.scope.providerKey = "shopify";
    if (field === "claim id") bad.catchupId = "9223372036854775807";
    const before = await catchup(claim);
    const stock = await stockSnapshot();
    if (["product hint", "variant hint", "external scope", "provider"].includes(field)) {
      await expect(admission.settleArchived(bad)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_SCOPE_MISMATCH" });
    } else expect(await admission.settleArchived(bad)).toBe(false);
    expect(await catchup(claim)).toEqual(before);
    expect(await audit(claim)).toEqual([]);
    expect(await stockSnapshot()).toEqual(stock);
  });

  it.each(["product hint", "variant hint", "provider", "destination", "connection", "external item"] as const)
  ("fails closed when persisted %s cannot match the canonical member", async field => {
    const target = await member();
    await archive(target);
    const scope = { ...target.scope };
    if (field === "product hint") scope.productId = target.productId + 100_000;
    if (field === "variant hint") scope.productVariantId = target.variantId + 100_000;
    if (field === "provider") scope.providerKey = "shopify";
    if (field === "destination") scope.destinationKind = "dropship_store_connection";
    if (field === "connection") scope.connectionId += 100_000;
    if (field === "external item") scope.externalInventoryItemId += "-unknown";
    const claim = await retain(scope);
    const before = await catchup(claim);
    await expect(admission.settleArchived(claim)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_TARGET_UNMAPPED" });
    expect(await catchup(claim)).toEqual(before);
    expect(await audit(claim)).toEqual([]);
  });

  it("preserves a newer producer revision and settles only the newly captured claim", async () => {
    const target = await member();
    const old = await retain(target.scope);
    await archive(target);
    const current = await retain(target.scope);
    expect(BigInt(current.revision)).toBe(BigInt(old.revision) + BigInt(1));
    expect(await admission.settleArchived(old)).toBe(false);
    expect(await audit(old)).toEqual([]);
    expect(await admission.settleArchived(current)).toBe(true);
    expect(await audit(current)).toHaveLength(1);
  });

  it("rechecks reactivation, does not reuse a completed receipt, and leaves new active work pending", async () => {
    const target = await member();
    const claim = await retain(target.scope);
    await archive(target);
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true WHERE id=$1", [target.variantId]);
    expect(await admission.settleArchived(claim)).toBe(false);
    await archive(target);
    expect(await admission.settleArchived(claim)).toBe(true);
    expect(await admission.settleArchived(claim)).toBe(false);
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true WHERE id=$1", [target.variantId]);
    const fresh = await retain(target.scope);
    expect(await admission.settleArchived(fresh)).toBe(false);
    expect(await catchup(fresh)).toMatchObject({ revision: Number(fresh.revision), completed_revision: Number(claim.revision) });
    expect(await audit(claim)).toHaveLength(1);
    expect((await database.pool.query(`SELECT revision,acknowledged_revision FROM inventory.publication_selection_work
      WHERE product_id=$1`, [target.productId])).rows[0]).toMatchObject({ acknowledged_revision: "0" });
  });

  it.each(["running", "uncertain"] as const)("preserves a %s provider attempt and its pending catch-up exactly", async state => {
    const target = await member();
    const claim = await retain(target.scope);
    await archive(target);
    await unresolved(target, state);
    const before = await catchup(claim);
    const stock = await stockSnapshot();
    expect((await admission.listDue(100)).some(row => row.catchupId === claim.catchupId)).toBe(false);
    await expect(admission.settleArchived(claim)).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_UNRESOLVED" });
    expect(await catchup(claim)).toEqual(before);
    expect(await stockSnapshot()).toEqual(stock);
    expect(await audit(claim)).toEqual([]);
  });

  it("serializes simultaneous workers to one settlement and one audit receipt", async () => {
    const target = await member();
    const claim = await retain(target.scope);
    await archive(target);
    const results = await Promise.allSettled([admission.settleArchived(claim),
      new PostgresQuantityPublicationAdmission(database.pool, () => new Date(NOW)).settleArchived(claim)]);
    expect(results.filter(result => result.status === "fulfilled" && result.value)).toHaveLength(1);
    for (const result of results) {
      if (result.status === "fulfilled") expect(typeof result.value).toBe("boolean");
      else expect(result.reason).toMatchObject({ code: "PUBLICATION_CATCHUP_SETTLEMENT_BUSY" });
    }
    expect(await audit(claim)).toHaveLength(1);
  });

  it("does not settle while an actual Catalog reactivation holds migration 0743's selection gate", async () => {
    const target = await member();
    const claim = await retain(target.scope);
    await archive(target);
    const writer = await database.pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE catalog.product_variants SET is_active=true WHERE id=$1", [target.variantId]);
      await expect(admission.settleArchived(claim)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_SETTLEMENT_BUSY" });
      await writer.query("COMMIT");
      expect(await admission.settleArchived(claim)).toBe(false);
      expect(await audit(claim)).toEqual([]);
    } finally { await writer.query("ROLLBACK"); writer.release(); }
  });

  it("holds the shared selection gate while waiting for the exact mapping head, blocking reactivation", async () => {
    const target = await member();
    const claim = await retain(target.scope);
    await archive(target);
    const blocker = await database.pool.connect();
    let settlement: Promise<boolean> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT 1 FROM inventory.publication_variant_mapping_heads
        WHERE publication_target_id=$1 AND product_variant_id=$2 FOR UPDATE`, [target.targetId, target.variantId]);
      settlement = admission.settleArchived(claim);
      void settlement.catch(() => undefined);
      await waitForSettlementLock();
      const promoter = await database.pool.connect();
      try {
        await promoter.query("BEGIN");
        await promoter.query("SET LOCAL lock_timeout='200ms'");
        // Mapping promotion's real owner must obtain this fence before it may
        // change an active binding. Settlement pins authority until its commit.
        await expect(promoter.query("SELECT * FROM inventory.acquire_cutover_admission_fence('canonical',NULL)"))
          .rejects.toMatchObject({ code: "55P03" });
      } finally { await promoter.query("ROLLBACK"); promoter.release(); }

      await expect(database.pool.query("UPDATE catalog.product_variants SET is_active=true WHERE id=$1", [target.variantId]))
        .rejects.toMatchObject({ code: "55P03", message: "PUBLICATION_SELECTION_BUSY" });
      await blocker.query("COMMIT");
      expect(await settlement).toBe(true);
      expect(await audit(claim)).toHaveLength(1);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      if (settlement) await settlement.catch(() => undefined);
    }
  });

  it("respects the exact remote scope lock without touching another queued quantity", async () => {
    const target = await member();
    const claim = await retain(target.scope);
    await archive(target);
    await existingOutbox(target);
    const before = await stockSnapshot();
    const owner = await database.pool.connect();
    try {
      await owner.query("BEGIN");
      await owner.query("SELECT pg_advisory_xact_lock(hashtextextended($1,918420))", [quantityPublicationScopeLockKey(target.scope)]);
      await expect(admission.settleArchived(claim)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_SETTLEMENT_BUSY" });
      expect(await audit(claim)).toEqual([]);
      expect(await stockSnapshot()).toEqual(before);
    } finally { await owner.query("ROLLBACK"); owner.release(); }
    expect(await admission.settleArchived(claim)).toBe(true);
  });

  it("rolls acknowledgement back atomically if the append-only settlement audit cannot be written", async () => {
    const target = await member();
    const claim = await retain(target.scope);
    await archive(target);
    const before = await catchup(claim);
    const stock = await stockSnapshot();
    await database.pool.query(`CREATE FUNCTION inventory.reject_archive_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='test settlement audit rejection'; END $$;
      CREATE TRIGGER reject_archive_test_audit BEFORE INSERT ON inventory.quantity_publication_catchup_settlements
      FOR EACH ROW EXECUTE FUNCTION inventory.reject_archive_test_audit();`);
    try {
      await expect(admission.settleArchived(claim)).rejects.toMatchObject({ code: "23514", message: "test settlement audit rejection" });
      expect(await catchup(claim)).toEqual(before);
      expect(await audit(claim)).toEqual([]);
      expect(await stockSnapshot()).toEqual(stock);
    } finally {
      await database.pool.query(`DROP TRIGGER reject_archive_test_audit ON inventory.quantity_publication_catchup_settlements;
        DROP FUNCTION inventory.reject_archive_test_audit();`);
    }
    expect(await admission.settleArchived(claim)).toBe(true);
    expect(await audit(claim)).toHaveLength(1);
  });

  it("rejects UPDATE, DELETE and TRUNCATE of the recorded settlement", async () => {
    const target = await member();
    const claim = await retain(target.scope);
    await archive(target);
    expect(await admission.settleArchived(claim)).toBe(true);
    const original = await audit(claim);
    await expect(database.pool.query("UPDATE inventory.quantity_publication_catchup_settlements SET actor='rewritten' WHERE catchup_id=$1", [claim.catchupId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query("DELETE FROM inventory.quantity_publication_catchup_settlements WHERE catchup_id=$1", [claim.catchupId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query("TRUNCATE inventory.quantity_publication_catchup_settlements"))
      .rejects.toMatchObject({ code: "23514" });
    expect(await audit(claim)).toEqual(original);
  });
  it("preserves bigint revision and attempt-boundary audit evidence without JavaScript rounding", async () => {
    const target = await member();
    const original = await retain(target.scope);
    await archive(target);
    const revision = "9007199254740993";
    const boundary = "9007199254740995";
    // Legal bigint history beyond Number.MAX_SAFE_INTEGER. Keep assertions on
    // PostgreSQL text extraction rather than decoding JSON numbers in Node.
    await database.pool.query("UPDATE inventory.quantity_publication_catchup SET revision=$2,attempt_boundary_id=$3 WHERE id=$1",
      [original.catchupId, revision, boundary]);
    const claim = { ...original, revision, attemptBoundaryId: boundary };
    expect(await admission.settleArchived(claim)).toBe(true);
    const proof = (await database.pool.query(`SELECT revision::text,attempt_boundary_id::text,
      before_state->>'revision' AS before_revision,after_state->>'completed_revision' AS after_completed,
      before_state->>'attempt_boundary_id' AS before_boundary,after_state->>'attempt_boundary_id' AS after_boundary
      FROM inventory.quantity_publication_catchup_settlements WHERE catchup_id=$1`, [claim.catchupId])).rows;
    expect(proof).toEqual([{ revision, attempt_boundary_id: boundary, before_revision: revision,
      after_completed: revision, before_boundary: boundary, after_boundary: boundary }]);
  });

  it("rejects an incomplete immutable receipt rather than accepting a NULL-valued CHECK", async () => {
    const target = await member();
    const claim = await retain(target.scope);
    await archive(target);
    await expect(database.pool.query(`INSERT INTO inventory.quantity_publication_catchup_settlements
      (catchup_id,revision,attempt_boundary_id,scope_key,scope,basis,actor,selection_fingerprint,evidence,before_state,after_state,occurred_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'catalog_archived','fixture',repeat('a',64),'{}','{}','{}',$6)`,
    [claim.catchupId, claim.revision, claim.attemptBoundaryId, quantityPublicationScopeLockKey(target.scope), JSON.stringify(target.scope), NOW]))
      .rejects.toMatchObject({ code: "23514" });
    expect(await audit(claim)).toEqual([]);
    expect(await admission.settleArchived(claim)).toBe(true);
  });

  it("cannot settle while the real cutover configuration fence owns runtime authority", async () => {
    const target = await member();
    const claim = await retain(target.scope);
    await archive(target);
    const promoter = await database.pool.connect();
    try {
      await promoter.query("BEGIN");
      await promoter.query("SELECT * FROM inventory.acquire_cutover_admission_fence('canonical',NULL)");
      await expect(admission.settleArchived(claim)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_SETTLEMENT_BUSY" });
      expect(await audit(claim)).toEqual([]);
    } finally { await promoter.query("ROLLBACK"); promoter.release(); }
    expect(await admission.settleArchived(claim)).toBe(true);
  });

  it("settles a Dropship eBay member through its store selection owner, independently of its Shopify policy channel", async () => {
    const target = await member();
    await database.pool.query(`INSERT INTO dropship.dropship_vendors(id,business_name) VALUES(10,'Archive test vendor');
      INSERT INTO dropship.dropship_store_connections(id,vendor_id,platform,status,external_account_id,provider_environment)
        VALUES(22,10,'ebay','connected','dropship-archive-seller','production');
      INSERT INTO dropship.dropship_store_listing_configs(id,store_connection_id,platform,listing_mode,inventory_mode,is_active)
        VALUES(1,22,'ebay','live','managed_quantity_sync',true);
      INSERT INTO dropship.dropship_catalog_rules(id,scope_type,action,is_active,priority)
        VALUES(1,'catalog','include',true,0);
      -- The vendor's picks: every catalog size, as the conversion turns a 'catalog' include (PLAN-B v4.1 §6 step 4).
      INSERT INTO dropship.dropship_vendor_selected_variants(vendor_id,product_variant_id) SELECT 10, id FROM catalog.product_variants;`);
    await database.pool.query(`INSERT INTO dropship.dropship_vendor_listings
      (id,vendor_id,store_connection_id,product_variant_id,platform,status,external_listing_id,external_offer_id,updated_at)
      VALUES(1,10,22,$1,'ebay','active','dropship-archive-listing','dropship-archive-offer',$2)`, [target.variantId, NOW]);
    const targetId = (await database.pool.query<{ id: number }>(`INSERT INTO inventory.inventory_publication_targets
      (destination_kind,channel_id,dropship_store_connection_id,fulfillment_node_id,provider_scope_type,external_scope_id,
        publication_authority,state,change_reason,created_by)
      VALUES('dropship_store_connection',35,22,1,'account','dropship-archive-seller','echelon','disabled','Exact archived store','fixture')
      RETURNING id`)).rows[0].id;
    const item = "DROP-" + target.scope.externalInventoryItemId;
    const mappingId = await activateMapping(targetId, target.variantId, item, "dropship-archive-mapping");
    await database.pool.query(`UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,
      activated_by='fixture',activated_at=transaction_timestamp() WHERE id=$1`, [targetId]);
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=$1", [targetId]);
    const destination = { destinationKind: "dropship_store_connection" as const, channelId: 35,
      channelConnectionId: null, dropshipStoreConnectionId: 22 };
    const input = { productId: target.productId, productVariantIds: [target.variantId], now: NOW };
    expect((await readPublicationStockSelection(database.pool, destination, input)).variants[0].action).toBe("publish");
    await archive(target);
    const expected = await readPublicationStockSelection(database.pool, destination, input);
    expect(expected.variants[0]).toMatchObject({ action: "none", catalogArchived: true, blockers: [] });
    const claim = await retain({ ...target.scope, destinationKind: "dropship_store_connection", connectionId: 22,
      externalScopeId: "dropship-archive-seller", externalInventoryItemId: item });
    const before = await stockSnapshot();
    expect(await admission.settleArchived(claim)).toBe(true);
    expect((await audit(claim))[0]).toMatchObject({ evidence: { member: { target_id: targetId, mapping_id: mappingId, ...destination }, selection: expected } });
    expect(await stockSnapshot()).toEqual(before);
  });

  it("rejects ambiguous external routing even when persisted local hints select only one member", async () => {
    const first = await member();
    const second = await member();
    await archive(first);
    await archive(second);
    await database.pool.query(`INSERT INTO warehouse.warehouses(id,code) VALUES(2,'ARCHIVE-SECOND');
      INSERT INTO warehouse.fulfillment_nodes(code,name,node_type,warehouse_id,inventory_authority,fulfillment_authority,created_by)
        VALUES('ARCHIVE-SECOND','Second archive source','internal_warehouse',2,'echelon','echelon','fixture');
      UPDATE warehouse.fulfillment_nodes SET lifecycle_status='active',activated_by='fixture',activated_at=transaction_timestamp()
        WHERE code='ARCHIVE-SECOND';`);
    const targetId = (await database.pool.query<{ id: number }>(`INSERT INTO inventory.inventory_publication_targets
      (channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,external_scope_id,publication_authority,state,change_reason,created_by)
      SELECT 67,9,id,'account','archive-seller','echelon','disabled','Ambiguous archived external fixture','fixture'
      FROM warehouse.fulfillment_nodes WHERE code='ARCHIVE-SECOND' RETURNING id`)).rows[0].id;
    await activateMapping(targetId, second.variantId, first.scope.externalInventoryItemId, "duplicate-archive-external");
    await database.pool.query(`UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,
      activated_by='fixture',activated_at=transaction_timestamp() WHERE id=$1`, [targetId]);
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=$1", [targetId]);
    const stock = await stockSnapshot();
    for (const scope of [first.scope, { ...first.scope, productId: null, productVariantId: null },
      { ...first.scope, productId: second.productId, productVariantId: second.variantId }]) {
      const claim = await retain(scope);
      const before = await catchup(claim);
      await expect(admission.settleArchived(claim)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_TARGET_UNMAPPED" });
      expect(await catchup(claim)).toEqual(before);
      expect(await audit(claim)).toEqual([]);
    }
    expect(await stockSnapshot()).toEqual(stock);
  });

});
