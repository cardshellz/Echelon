import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { installEbayPublicationInventoryFixture } from "../fixtures/ebay-publication-inventory.fixture";
import { ensureEbayPublicationReady } from "../../infrastructure/ebay-publication-readiness.repository";
import { PostgresQuantityPublicationAdmission, quantityPublicationScopeLockKey } from "../../infrastructure/quantity-publication-admission.repository";
import { PostgresEbayAutomaticPublicationRecoveryRepository } from "../../infrastructure/ebay-automatic-publication-recovery.repository";
import { PostgresEbayPublicationReconciliationRepository } from "../../infrastructure/ebay-publication-reconciliation.repository";
import { EbayAutomaticPublicationRecoveryService } from "../../application/ebay-automatic-publication-recovery.service";
import { EbayPublicationContentRefreshRejectedError, EbayPublicationReconciliationService } from "../../application/ebay-publication-reconciliation.service";
import { observeEbayQuantityRequest } from "../../application/quantity-provider-request-evidence";
import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const scope: QuantityPublicationScope = { destinationKind: "channel_connection", connectionId: 9, providerKey: "ebay", providerScopeType: "account",
  externalScopeId: "seller-36", externalInventoryItemId: "P5", productId: 20, productVariantId: 101 };
const GROUP: QuantityPublicationScope = { ...scope, externalInventoryItemId: "group:PACK", productVariantId: null };
const MIGRATION = "900000008000018120001_ebay_automatic_sync_recovery.sql";

dbDescribe.sequential("automatic eBay recovery and continuing reconciliation on disposable PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let now: Date;
  const clock = () => new Date(now);
  const advance = () => { now = new Date(now.getTime() + 60 * 60_000); };
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installEbayPublicationInventoryFixture(database.pool, { includeQuantityRecoveryMigrations: true, seedPublicationJob: false });
    for (const file of ["0731_ebay_listing_sync_verification_checkpoint.sql", "0732_ebay_listing_sync_identity_admission.sql",
      "0736_ebay_listing_mapping_repairs.sql", "0737_ebay_publication_completion.sql", MIGRATION])
      await database.pool.query(readFileSync(resolve("migrations", file), "utf8"));
    await database.pool.query("UPDATE channels.channel_listings SET external_sku='P5',external_product_id='listing-20'");
    now = (await database.pool.query<{ now: Date }>("SELECT transaction_timestamp() AS now")).rows[0]!.now;
    await ensureEbayPublicationReady(database.pool, { channelId: 67, connectionId: 9, accountId: "seller-36", environment: "production", productId: 20,
      purpose: "sync", variants: [{ productVariantId: 101, sku: "P5" }] }, { commandKey: randomUUID(), actor: "fixture", now });
    now = new Date(now.getTime() + 1_000);
  }, 60_000);
  afterEach(async () => { await database?.close(); });

  function fixture() {
    const admission = new PostgresQuantityPublicationAdmission(database.pool, clock);
    const recovery = new EbayAutomaticPublicationRecoveryService(new PostgresEbayAutomaticPublicationRecoveryRepository(database.pool), clock);
    const repository = new PostgresEbayPublicationReconciliationRepository(database.pool);
    const adapter = { supportedScopeTypes: ["account"] as const,
      publishAbsolute: vi.fn(async (request: { desiredQuantity: number }) => ({ publishedQuantity: request.desiredQuantity, providerResponse: { quantity: request.desiredQuantity } })),
      readAbsolute: vi.fn(async () => ({ observedQuantity: 17, quantityConsistent: true, providerResponse: { quantity: 17 } })) };
    const adapters = { get: () => adapter as never };
    const content = vi.fn(async (_input: { commandKey: string }) => ({ jobId: randomUUID() }));
    return { admission, recovery, repository, adapter, content,
      watch: new EbayPublicationReconciliationService(repository, adapters, content, clock),
      outbox: new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(database.pool), adapters, { now: clock }, randomUUID, admission) };
  }
  async function uncertain(f: ReturnType<typeof fixture>, options: { path?: string; method?: string; group?: boolean; noRequest?: boolean } = {}) {
    const target = options.group ? GROUP : scope;
    await expect(f.admission.runQuantityReducingLifecycle(target, async () => {
      if (options.noRequest) throw new Error("synthetic process loss");
      return observeEbayQuantityRequest({ method: options.method ?? "PUT", path: options.path ?? "/sell/inventory/v1/inventory_item/P5", body: {} },
        async () => { throw new Error("synthetic process loss"); });
    }, options.group ? [scope] : [])).rejects.toThrow("synthetic process loss");
    return (await database.pool.query<{ id: string; record: Record<string, unknown> }>(`SELECT id::text,to_jsonb(a) AS record
      FROM inventory.quantity_publication_attempts a WHERE scope_key=$1 ORDER BY id DESC LIMIT 1`, [quantityPublicationScopeLockKey(target)])).rows[0]!;
  }
  function command(scopes = [scope]) { return { syncJobId: randomUUID(), syncRevision: "1", scopes }; }
  async function start(f: ReturnType<typeof fixture>) {
    const old = await uncertain(f); const input = command();
    const result = await f.recovery.recover(input);
    expect(result).toMatchObject({ superseded: [old.id], unresolved: [], busy: false });
    return { old, input, watchId: result.watchId! };
  }
  async function addVerifiedMember(): Promise<QuantityPublicationScope[]> {
    await database.pool.query(`INSERT INTO channels.channel_listings
      (id,channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,sync_status)
      VALUES(2,67,102,'NEW','offer-NEW','listing-20','synced')`);
    await ensureEbayPublicationReady(database.pool, { channelId: 67, connectionId: 9, accountId: "seller-36", environment: "production", productId: 20,
      purpose: "sync", variants: [{ productVariantId: 101, sku: "P5" }, { productVariantId: 102, sku: "NEW" }] },
    { commandKey: randomUUID(), actor: "fixture", now });
    return [scope, { ...scope, externalInventoryItemId: "NEW", productVariantId: 102 }];
  }
  async function savedWatch(watchId: string) {
    return (await database.pool.query("SELECT to_jsonb(watch) AS record FROM inventory.ebay_publication_reconciliation_watches watch WHERE id=$1", [watchId])).rows[0]!.record;
  }
  async function checkCurrentStock(f: ReturnType<typeof fixture>, claim: Awaited<ReturnType<typeof f.repository.claimDue>>[number]) {
    const targets = await f.repository.plan(claim, clock());
    return f.repository.recordStock(claim, targets.map(target => ({ target, observedQuantity: Number(target.desiredQuantity),
      quantityConsistent: true, providerResponseHash: "a".repeat(64), observedAt: clock() })), clock());
  }

  it("preserves unknown request history, atomically saves the recurring obligation, and replays without another receipt", async () => {
    const f = fixture(); const { old, input, watchId } = await start(f);
    const row = (await database.pool.query("SELECT to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a WHERE id=$1", [old.id])).rows[0];
    expect(row.record).toEqual({ ...old.record, state: "superseded_unknown" });
    expect(await f.recovery.recover(input)).toEqual({ superseded: [old.id], unresolved: [], busy: false, watchId });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.ebay_automatic_publication_recoveries")).rows[0].count).toBe(1);
    expect((await database.pool.query("SELECT revision::text,cycle::text,state FROM inventory.ebay_publication_reconciliation_watches")).rows)
      .toEqual([{ revision: "1", cycle: "1", state: "pending" }]);
    await expect(database.pool.query("UPDATE inventory.ebay_automatic_publication_recoveries SET sync_revision=2")).rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query("DELETE FROM inventory.ebay_publication_reconciliation_watches")).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    { label: "missing legacy request", noRequest: true },
    { label: "asynchronous publish", method: "POST", path: "/sell/inventory/v1/offer/offer-P5/publish" },
    { label: "delete", method: "DELETE", path: "/sell/inventory/v1/inventory_item/P5" },
  ])("leaves $label blocked without manufacturing a replacement receipt", async options => {
    const f = fixture(); const old = await uncertain(f, options);
    expect(await f.recovery.recover(command())).toMatchObject({ superseded: [], unresolved: [old.id], watchId: null });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.ebay_publication_reconciliation_watches")).rows[0].count).toBe(0);
  });
  it("locks the parent and every retained member, and refuses a partial group scope", async () => {
    const f = fixture(); const old = await uncertain(f, { group: true, path: "/sell/inventory/v1/inventory_item_group/PACK" });
    expect(await f.recovery.recover(command())).toMatchObject({ unresolved: [old.id], superseded: [] });
    const blocker = await database.pool.connect();
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,918420))", [quantityPublicationScopeLockKey(GROUP)]);
      expect(await f.recovery.recover(command([GROUP, scope]))).toMatchObject({ busy: true, superseded: [] });
    } finally { await blocker.query("SELECT pg_advisory_unlock_all()"); blocker.release(); }
    expect(await f.recovery.recover(command([GROUP, scope]))).toMatchObject({ busy: false, superseded: [old.id] });
  });
  it("serializes concurrent recoveries into one immutable receipt and watch", async () => {
    const f = fixture(); const old = await uncertain(f);
    const outcomes = await Promise.all([f.recovery.recover(command()), f.recovery.recover(command())]);
    expect(outcomes.flatMap(row => row.superseded)).toEqual([old.id]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.ebay_automatic_publication_recoveries")).rows[0].count).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.ebay_publication_reconciliation_watches")).rows[0].count).toBe(1);
  });
  it("allows a verified member addition with no uncertainty while retaining the old readiness obligation byte-for-byte", async () => {
    const f = fixture(); const { watchId } = await start(f);
    const scopes = await addVerifiedMember();
    const before = await savedWatch(watchId);
    const receipts = (await database.pool.query("SELECT to_jsonb(receipt) AS record FROM inventory.ebay_automatic_publication_recoveries receipt")).rows;
    expect(await f.recovery.recover(command(scopes))).toEqual({ superseded: [], unresolved: [], busy: false, watchId });
    expect(await savedWatch(watchId)).toEqual(before);
    expect((await database.pool.query("SELECT to_jsonb(receipt) AS record FROM inventory.ebay_automatic_publication_recoveries receipt")).rows).toEqual(receipts);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.ebay_publication_reconciliation_watches")).rows[0].count).toBe(1);
  });
  it("creates an independent exact watch for a subsequent unknown request after membership expands", async () => {
    const f = fixture(); const first = await start(f);
    const scopes = await addVerifiedMember();
    const before = await savedWatch(first.watchId);
    const firstReceipt = (await database.pool.query("SELECT to_jsonb(receipt) AS record FROM inventory.ebay_automatic_publication_recoveries receipt WHERE attempt_id=$1", [first.old.id])).rows[0]!.record;
    const second = await uncertain(f);
    const input = { ...first.input, syncRevision: "2", scopes };
    const recovered = await f.recovery.recover(input);
    expect(recovered).toMatchObject({ superseded: [second.id], unresolved: [], busy: false });
    expect(recovered.watchId).not.toBe(first.watchId);
    expect(await savedWatch(first.watchId)).toEqual(before);
    expect((await database.pool.query("SELECT to_jsonb(receipt) AS record FROM inventory.ebay_automatic_publication_recoveries receipt WHERE attempt_id=$1", [first.old.id])).rows[0]!.record).toEqual(firstReceipt);
    expect((await database.pool.query("SELECT to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a WHERE id=$1", [second.id])).rows[0]!.record)
      .toEqual({ ...second.record, state: "superseded_unknown" });
    const secondWatch = await savedWatch(recovered.watchId!);
    expect(secondWatch.scopes).toEqual(expect.arrayContaining(scopes));
    expect(secondWatch.scopes).toHaveLength(2);
    expect(await f.recovery.recover(input)).toEqual(recovered);
    expect(await savedWatch(recovered.watchId!)).toEqual(secondWatch);
  });
  it("projects every watch associated with a job conservatively instead of hiding older pending or blocked work", async () => {
    const f = fixture(); const first = await start(f);
    const scopes = await addVerifiedMember();
    await uncertain(f);
    const second = await f.recovery.recover({ ...first.input, syncRevision: "2", scopes });
    const claims = await f.repository.claimDue(2, clock(), randomUUID());
    const oldClaim = claims.find(claim => claim.watchId === first.watchId)!;
    const newClaim = claims.find(claim => claim.watchId === second.watchId)!;
    const firstCheckAt = clock().toISOString();
    await f.repository.finish(newClaim, await checkCurrentStock(f, newClaim), first.input.syncJobId, clock());
    expect((await f.repository.readStatuses([first.input.syncJobId]))[first.input.syncJobId]).toMatchObject({ state: "pending", checkedAt: null, nextCheckAt: firstCheckAt });
    await f.repository.fail(oldClaim, { code: "PUBLICATION_RECONCILIATION_SCOPE_CHANGED", message: "Review the retained exact mapping.", commandConsumed: false }, clock());
    expect((await f.repository.readStatuses([first.input.syncJobId]))[first.input.syncJobId]).toMatchObject({ state: "needs_attention", code: "PUBLICATION_RECONCILIATION_SCOPE_CHANGED" });
    advance();
    const [retry] = await f.repository.claimDue(1, clock(), randomUUID());
    expect(retry!.watchId).toBe(first.watchId);
    await f.repository.finish(retry!, await checkCurrentStock(f, retry!), first.input.syncJobId, clock());
    expect((await f.repository.readStatuses([first.input.syncJobId]))[first.input.syncJobId]).toEqual({ state: "verified", checkedAt: firstCheckAt,
      nextCheckAt: new Date(Date.parse(firstCheckAt) + 15 * 60_000).toISOString(), code: null, message: null });
  });
  it("refuses an old watch's changed SKU mapping before reading or handing off work to the replacement identity", async () => {
    const f = fixture(); const { watchId, input } = await start(f);
    await database.pool.query(`INSERT INTO inventory.publication_variant_mapping_versions
      (publication_target_id,product_variant_id,version,supersedes_mapping_id,external_inventory_item_id,external_sku,definition_hash,change_reason,idempotency_key,request_hash,created_by)
      SELECT 3,101,2,id,'RENAMED','RENAMED',repeat('b',64),'Fixture reviewed mapping replacement','fixture-renamed-mapping',repeat('b',64),'fixture'
        FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=3 AND product_variant_id=101 AND version=1;
      UPDATE inventory.publication_variant_mapping_heads SET draft_mapping_id=(SELECT id FROM inventory.publication_variant_mapping_versions
        WHERE publication_target_id=3 AND product_variant_id=101 AND version=2),revision=revision+1 WHERE publication_target_id=3 AND product_variant_id=101;
      UPDATE inventory.publication_variant_mapping_versions SET lifecycle_status='sealed',sealed_by='fixture',sealed_at=transaction_timestamp()
        WHERE publication_target_id=3 AND product_variant_id=101 AND version=2;
      UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=draft_mapping_id,draft_mapping_id=NULL,
        revision=revision+1 WHERE publication_target_id=3 AND product_variant_id=101`);
    const before = (await database.pool.query("SELECT to_jsonb(o) AS record FROM inventory.inventory_publication_outbox o WHERE publication_target_id=3 ORDER BY id")).rows;
    expect(await f.watch.processDue()).toEqual({ checked: 0, repaired: 0, blocked: 1 });
    expect(f.adapter.readAbsolute).not.toHaveBeenCalled();
    expect(f.content).not.toHaveBeenCalled();
    expect((await savedWatch(watchId)).scopes).toEqual([scope]);
    expect((await database.pool.query("SELECT to_jsonb(o) AS record FROM inventory.inventory_publication_outbox o WHERE publication_target_id=3 ORDER BY id")).rows).toEqual(before);
    expect((await f.repository.readStatuses([input.syncJobId]))[input.syncJobId]).toMatchObject({ state: "needs_attention", code: "PUBLICATION_RECONCILIATION_SCOPE_CHANGED" });
  });
  it.each([true, false])("requires an exact immutable outbox identity to replace a no-request crash (identity matches: %s)", async matches => {
    const f = fixture();
    const oldScope = { ...scope, productId: null, externalInventoryItemId: matches ? "P5" : "OTHER-SKU" };
    const key = quantityPublicationScopeLockKey(oldScope);
    // Historical process-loss fixture: only an unresolved owner snapshot is
    // supplied. No request/response or terminal evidence is fabricated.
    const old = (await database.pool.query<{ id: string }>(`INSERT INTO inventory.quantity_publication_attempts
      (owner_token,owner_kind,gate_epoch,scope_key,scope,outbox_id,affected_scope_keys,affected_scopes,state,started_at)
      SELECT $1,'outbox',0,$2,$3::jsonb,id,ARRAY[$2],$4::jsonb,'running',$5
      FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 AND product_variant_id=101
      ORDER BY desired_revision DESC LIMIT 1 RETURNING id::text`,
    [randomUUID(), key, JSON.stringify(oldScope), JSON.stringify([oldScope]), now])).rows[0]!;
    const result = await f.recovery.recover(command([{ ...scope, externalInventoryItemId: oldScope.externalInventoryItemId }]));
    expect(result).toMatchObject(matches ? { superseded: [old.id], unresolved: [] } : { superseded: [], unresolved: [old.id] });
  });
  it("restricts stock replanning to the watched eBay channel and links fresh read evidence to source and content jobs", async () => {
    const f = fixture(); const { input } = await start(f);
    const before = (await database.pool.query("SELECT id::text FROM inventory.inventory_publication_outbox WHERE channel_id_snapshot<>67 ORDER BY id")).rows;
    expect(await f.watch.processDue()).toEqual({ checked: 1, repaired: 0, blocked: 0 });
    const contentJob = (await f.content.mock.results[0]!.value).jobId;
    expect(await f.repository.readStatuses([input.syncJobId, contentJob])).toEqual({
      [input.syncJobId]: expect.objectContaining({ state: "verified", checkedAt: now.toISOString() }),
      [contentJob]: expect.objectContaining({ state: "verified" }),
    });
    expect((await database.pool.query("SELECT id::text FROM inventory.inventory_publication_outbox WHERE channel_id_snapshot<>67 ORDER BY id")).rows).toEqual(before);
    await expect(database.pool.query("DELETE FROM inventory.ebay_publication_reconciliation_observations")).rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query("UPDATE inventory.ebay_publication_reconciliation_cycles SET stock_state='blocked'")).rejects.toMatchObject({ code: "23514" });
  });
  it.each(["mapping", "target"])("never reports verified after the exact %s is retired or missing", async change => {
    const f = fixture(); const { input } = await start(f);
    await f.watch.processDue();
    if (change === "mapping") await database.pool.query("UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=NULL,revision=revision+1 WHERE publication_target_id=3");
    if (change === "target") await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='disabled',revision=revision+1,activated_by=NULL,activated_at=NULL WHERE id=3");
    expect((await f.repository.readStatuses([input.syncJobId]))[input.syncJobId]).toMatchObject({ state: "pending", code: "PUBLICATION_RECONCILIATION_PLAN_CHANGED" });
  });
  it("coalesces drift into an already pending canonical row without duplicating its desired revision", async () => {
    const f = fixture(); await start(f);
    const before = (await database.pool.query("SELECT id::text,desired_revision::text,state FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 ORDER BY id")).rows;
    expect(before.at(-1)?.state).toBe("queued");
    f.adapter.readAbsolute.mockResolvedValue({ observedQuantity: 0, quantityConsistent: true, providerResponse: { quantity: 0 } });
    expect(await f.watch.processDue()).toEqual({ checked: 1, repaired: 1, blocked: 0 });
    expect((await database.pool.query("SELECT id::text,desired_revision::text,state FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 ORDER BY id")).rows).toEqual(before);
  });
  it.each([9, 99])("uses the current numeric stock revision after revision %s and completes recovery", async priorRevision => {
    const f = fixture(); const { input } = await start(f);
    // Retained history must remain present: deleting old revisions would hide
    // the production bug where the text alias sorted 9 ahead of 10.
    await database.pool.query(`INSERT INTO inventory.inventory_publication_outbox (
      activation_run_id,publication_target_id,product_variant_id,desired_revision,desired_quantity,
      destination_kind_snapshot,channel_connection_id_snapshot,dropship_store_connection_id_snapshot,
      external_scope_id_snapshot,external_inventory_item_id_snapshot,publication_phase,channel_id_snapshot,
      provider_key_snapshot,provider_scope_type_snapshot,external_sku_snapshot,publication_target_revision_snapshot,
      state,idempotency_key,payload_hash,available_at)
      SELECT activation_run_id,publication_target_id,product_variant_id,$1,desired_quantity,
      destination_kind_snapshot,channel_connection_id_snapshot,dropship_store_connection_id_snapshot,
      external_scope_id_snapshot,external_inventory_item_id_snapshot,publication_phase,channel_id_snapshot,
      provider_key_snapshot,provider_scope_type_snapshot,external_sku_snapshot,publication_target_revision_snapshot,
      'queued',$2,repeat('c',64),transaction_timestamp()
      FROM inventory.inventory_publication_outbox o WHERE publication_target_id=3 AND product_variant_id=101
      ORDER BY o.desired_revision DESC LIMIT 1`, [priorRevision, `numeric-recovery-fixture:${priorRevision}`]);
    await database.pool.query(`UPDATE inventory.inventory_levels SET variant_qty=10 WHERE product_variant_id=101;
      UPDATE inventory.inventory_lots SET qty_on_hand=10 WHERE product_variant_id=101`);
    // Three units are already claimed in this fixture: the canonical quantity
    // is seven, not the ten units physically present.
    f.adapter.readAbsolute.mockResolvedValue({ observedQuantity: 7, quantityConsistent: true, providerResponse: { quantity: 7 } });
    expect(await f.watch.processDue()).toEqual({ checked: 1, repaired: 0, blocked: 0 });
    expect((await f.repository.readStatuses([input.syncJobId]))[input.syncJobId]).toMatchObject({ state: "verified", code: null });
    const evidence = (await database.pool.query(`SELECT o.desired_revision::text,o.desired_quantity::text,observation.matches_desired
      FROM inventory.ebay_publication_reconciliation_observations observation
      JOIN inventory.inventory_publication_outbox o ON o.id=observation.outbox_id ORDER BY observation.id DESC LIMIT 1`)).rows[0];
    expect(evidence).toEqual({ desired_revision: String(priorRevision + 1), desired_quantity: "7", matches_desired: true });
  });
  it("rejects stale read evidence when the canonical quantity changes during the provider read", async () => {
    const f = fixture(); const { input } = await start(f);
    f.adapter.readAbsolute.mockImplementationOnce(async () => {
      await database.pool.query(`UPDATE inventory.inventory_levels SET variant_qty=10 WHERE product_variant_id=101;
        UPDATE inventory.inventory_lots SET qty_on_hand=10 WHERE product_variant_id=101`);
      return { observedQuantity: 17, quantityConsistent: true, providerResponse: { quantity: 17 } };
    });
    expect(await f.watch.processDue()).toEqual({ checked: 0, repaired: 0, blocked: 1 });
    expect(f.content).toHaveBeenCalledOnce();
    expect((await f.repository.readStatuses([input.syncJobId]))[input.syncJobId]).toMatchObject({ state: "pending", code: "PUBLICATION_RECONCILIATION_PLAN_CHANGED" });
    advance();
    f.adapter.readAbsolute.mockResolvedValue({ observedQuantity: 7, quantityConsistent: true, providerResponse: { quantity: 7 } });
    expect(await f.watch.processDue()).toEqual({ checked: 1, repaired: 0, blocked: 0 });
    expect((await f.repository.readStatuses([input.syncJobId]))[input.syncJobId]).toMatchObject({ state: "verified", code: null });
    expect((await database.pool.query("SELECT desired_quantity::text FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 ORDER BY desired_revision DESC LIMIT 1")).rows[0].desired_quantity).toBe("7");
    expect((await database.pool.query("SELECT current_revision FROM inventory.ebay_publication_reconciliation_observations ORDER BY id")).rows)
      .toEqual([{ current_revision: false }, { current_revision: true }]);
  });
  it("continues indefinitely and advances rejected content commands after correction while replaying uncertain ones", async () => {
    const f = fixture(); await start(f);
    f.content.mockRejectedValueOnce(new Error("private transport diagnostic"));
    expect((await f.watch.processDue()).blocked).toBe(1);
    const firstKey = f.content.mock.calls[0]![0].commandKey;
    advance();
    f.content.mockRejectedValueOnce(new EbayPublicationContentRefreshRejectedError("EBAY_MAPPING_NOT_READY", "Review mapping."));
    expect((await f.watch.processDue()).blocked).toBe(1);
    expect(f.content.mock.calls[1]![0].commandKey).toBe(firstKey);
    advance();
    expect((await f.watch.processDue()).checked).toBe(1);
    expect(f.content.mock.calls[2]![0].commandKey).not.toBe(firstKey);
    now = new Date(now.getTime() + 365 * 24 * 60 * 60_000);
    expect((await f.watch.processDue()).checked).toBe(1);
  });
  it("keeps correction pending until independent consistent readback, including a later inconsistency", async () => {
    const f = fixture(); const { input } = await start(f);
    await f.outbox.processDue();
    f.adapter.readAbsolute.mockResolvedValue({ observedQuantity: 17, quantityConsistent: false, providerResponse: { quantity: 17 } });
    expect(await f.watch.processDue()).toEqual({ checked: 1, repaired: 1, blocked: 0 });
    expect((await f.repository.readStatuses([input.syncJobId]))[input.syncJobId]).toMatchObject({ state: "pending" });
    expect((await f.outbox.processDue()).verified).toBe(0);
    expect((await database.pool.query("SELECT matches_desired FROM inventory.inventory_publication_readbacks ORDER BY id DESC LIMIT 1")).rows[0].matches_desired).toBe(false);
    f.adapter.readAbsolute.mockResolvedValue({ observedQuantity: 17, quantityConsistent: true, providerResponse: { quantity: 17 } });
    await f.outbox.processDue(); advance(); await f.watch.processDue();
    expect((await f.repository.readStatuses([input.syncJobId]))[input.syncJobId]).toMatchObject({ state: "verified" });
  });
  it("rejects an expired lease after a replacement worker claims the same durable cycle", async () => {
    const f = fixture(); await start(f);
    const [old] = await f.repository.claimDue(1, clock(), randomUUID());
    advance();
    const [current] = await f.repository.claimDue(1, clock(), randomUUID());
    expect(current!.cycle).toBe(old!.cycle);
    await expect(f.repository.plan(old!, clock())).rejects.toMatchObject({ code: "PUBLICATION_RECONCILIATION_LEASE_LOST" });
    await f.repository.fail(old!, { code: "OLD", message: "Stale", commandConsumed: false }, clock());
    expect((await database.pool.query("SELECT lease_token FROM inventory.ebay_publication_reconciliation_watches")).rows[0].lease_token).toBe(current!.leaseToken);
  });
});
