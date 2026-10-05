import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { installWalmartPublicationInventoryFixture, activateWalmartPublicationInventoryFixture, WALMART_INVENTORY_NOW } from "../fixtures/walmart-publication-inventory.fixture";
import { InventoryPublicationTargetEnableService } from "../../application/inventory-publication-target-enable.service";
import { InventoryPublicationTargetStopService } from "../../application/inventory-publication-target-stop.service";
import { PostgresInventoryPublicationTargetEnableStore } from "../../infrastructure/inventory-publication-target-enable.repository";
import { PostgresInventoryPublicationTargetStopStore } from "../../infrastructure/inventory-publication-target-stop.repository";
import { quantityPublicationScopeLockKey, PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";

import { installCutoverAdmissionFixturePrerequisites } from "../fixtures/inventory-cutover-admission.fixture";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;

dbDescribe("direct account stock-update toggle with real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let service: InventoryPublicationTargetEnableService;
  const clock = { now: () => WALMART_INVENTORY_NOW };
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, cutoverCompositionBaseSql);
    await installWalmartPublicationInventoryFixture(database.pool, { targetState: "preview" });
    await activateWalmartPublicationInventoryFixture(database.pool);
    await installCutoverAdmissionFixturePrerequisites(database.pool);
    await database.pool.query(readFileSync(resolve("migrations/236_inventory_cutover_admission.sql"), "utf8"));
    await database.pool.query(readFileSync(resolve("migrations/0721_inventory_publication_direct_enable.sql"), "utf8"));
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='disabled',activated_at=NULL,activated_by=NULL,revision=revision+1 WHERE id=2");
    service = new InventoryPublicationTargetEnableService(new PostgresInventoryPublicationTargetEnableStore(database.pool), clock);
  }, 30000);
  afterEach(async () => { await database?.close(); });
  const input = (key = "enable-account") => ({ publicationTargetId: 2, expectedRevision: "3", idempotencyKey: key });
  const readTarget = async (id = 2) => (await database.pool.query(
    "SELECT state,revision::text,held_at,hold_reason FROM inventory.inventory_publication_targets WHERE id=$1", [id])).rows[0];
  const enable = () => service.enable(input(), "operator-1");

  it("enables a new empty Walmart account without pause history and unlocks initial listing setup", async () => {
    expect((await database.pool.query("SELECT * FROM public.audit_events WHERE action LIKE '%stopped'")).rows).toEqual([]);
    const result = await enable();
    expect(result).toMatchObject({ state: "live", revision: "4", publicationRows: 0, initialDefinitionsApplied: 0, providerWriteAttempted: false });
    const admission = new PostgresQuantityPublicationAdmission(database.pool, () => WALMART_INVENTORY_NOW);
    const readiness = await admission.inspectListingSetupZero({ channelId: 36, channelConnectionId: 8, partnerId: "partner-36",
      environment: "production", shipNodeId: "test-location", items: [{ productVariantId: 102, sku: "NEW", quantity: 0 }] });
    expect(readiness).toMatchObject({ ready: true, targetRevision: "4" });
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_heads")).rows).toEqual([]);
    expect((await database.pool.query("SELECT * FROM inventory.inventory_publication_outbox")).rows).toEqual([]);
    expect((await database.pool.query("SELECT actor,changes,context FROM public.audit_events WHERE action='inventory_availability.publication_target.enabled'")).rows)
      .toMatchObject([{ actor: "operator-1", changes: { before: { state: "disabled", revision: "3" }, after: { state: "live", revision: "4" } },
        context: { publicationRows: 0, initialDefinitions: [] } }]);
  });

  async function draftAccount() {
    await database.pool.query(`
      INSERT INTO channels.channels(id,name,provider,status) VALUES(37,'Second Walmart','walmart','active');
      INSERT INTO channels.channel_connections(id,channel_id) VALUES(9,37);
      INSERT INTO channels.walmart_connections VALUES(37,9,'partner-37','production','second-location',1);
      INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,
        external_scope_id,publication_authority,state,change_reason,created_by)
        VALUES(37,9,1,'location','second-location','echelon','disabled','Account setup','operator');
      INSERT INTO inventory.publication_source_binding_versions(publication_target_id,version,definition_hash,change_reason,idempotency_key,request_hash,created_by)
        VALUES(3,1,repeat('b',64),'Source','second-binding',repeat('b',64),'operator');
      INSERT INTO inventory.publication_source_binding_heads(publication_target_id,draft_binding_id,revision,updated_by,update_reason)
        SELECT 3,id,1,'operator','Source' FROM inventory.publication_source_binding_versions WHERE publication_target_id=3;
      INSERT INTO inventory.publication_source_binding_members(binding_id,publication_target_id,fulfillment_node_id,priority)
        SELECT id,3,1,1 FROM inventory.publication_source_binding_versions WHERE publication_target_id=3;
      INSERT INTO inventory.channel_exposure_policy_versions(scope_key,channel_id,scope_type,version,allocation_semantics,
        eligible,share_bps,holdback_sellable_units,max_publish_mode,min_publish_sellable_units,definition_hash,change_reason,idempotency_key,request_hash,created_by)
        VALUES('channel:37',37,'channel',1,'exposure',true,10000,0,'unlimited',0,repeat('c',64),'Default','second-policy',repeat('c',64),'operator');
      INSERT INTO inventory.channel_exposure_policy_heads(scope_key,channel_id,draft_policy_id,revision,updated_by,update_reason)
        SELECT 'channel:37',37,id,1,'operator','Default' FROM inventory.channel_exposure_policy_versions WHERE channel_id=37;
    `);
    return { publicationTargetId: 3, expectedRevision: "1", idempotencyKey: "initial-saved-setup" };
  }

  it("applies only missing initial warehouses and channel default, leaving other accounts unchanged", async () => {
    const other = await readTarget(2);
    const request = await draftAccount();
    const result = await service.enable(request, "operator-1");
    expect(result).toMatchObject({ initialDefinitionsApplied: 2, revision: "2", publicationRows: 0 });
    expect(await readTarget(2)).toEqual(other);
    expect((await database.pool.query("SELECT active_binding_id,draft_binding_id FROM inventory.publication_source_binding_heads WHERE publication_target_id=3")).rows[0])
      .toMatchObject({ active_binding_id: expect.any(Number), draft_binding_id: null });
    expect((await database.pool.query("SELECT sealed_by,lifecycle_status FROM inventory.channel_exposure_policy_versions WHERE channel_id=37")).rows[0])
      .toEqual({ sealed_by: "operator-1", lifecycle_status: "sealed" });
    expect(await service.enable(request, "operator-1")).toMatchObject({ alreadyApplied: true, revision: "2" });
  });

  it("rolls back initial setup and permission if the audit cannot be written", async () => {
    const request = await draftAccount();
    await database.pool.query(`CREATE FUNCTION public.fail_enable_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='inventory_availability.publication_target.enabled' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_enable_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_enable_audit();`);
    await expect(service.enable(request, "operator-1")).rejects.toThrow("audit unavailable");
    expect(await readTarget(3)).toMatchObject({ state: "disabled", revision: "1" });
    expect((await database.pool.query("SELECT active_binding_id FROM inventory.publication_source_binding_heads WHERE publication_target_id=3")).rows[0].active_binding_id).toBeNull();
    expect((await database.pool.query("SELECT lifecycle_status FROM inventory.channel_exposure_policy_versions WHERE channel_id=37")).rows[0].lifecycle_status).toBe("draft");
    expect((await database.pool.query("SELECT * FROM public.idempotency_keys WHERE key LIKE 'inventory-publication-enable:%'")).rows).toEqual([]);
  });

  it("rejects incomplete stock rules without changing permission or sealing drafts", async () => {
    const request = await draftAccount();
    await database.pool.query("UPDATE inventory.channel_exposure_policy_versions SET share_bps=NULL WHERE channel_id=37");
    await expect(service.enable(request, "operator-1")).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_STOCK_RULES_REQUIRED" });
    expect(await readTarget(3)).toMatchObject({ state: "disabled", revision: "1" });
  });

  it("rejects missing warehouses with an actionable error", async () => {
    const request = await draftAccount();
    await database.pool.query("UPDATE inventory.publication_source_binding_heads SET draft_binding_id=NULL,revision=revision+1 WHERE publication_target_id=3");
    await expect(service.enable(request, "operator-1")).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_WAREHOUSES_REQUIRED" });
    expect(await readTarget(3)).toMatchObject({ state: "disabled" });
  });

  it("serializes duplicate enables, replays a lost response, and rejects changed payloads or actors", async () => {
    const results = await Promise.all([enable(), enable()]);
    expect(results.map(result => result.alreadyApplied).sort()).toEqual([false, true]);
    expect(await readTarget()).toMatchObject({ revision: "4", state: "live" });
    expect(await enable()).toMatchObject({ alreadyApplied: true });
    await expect(service.enable(input(), "other-operator")).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_IDEMPOTENCY_CONFLICT" });
    await expect(service.enable({ ...input(), expectedRevision: "4" }, "operator-1")).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_IDEMPOTENCY_CONFLICT" });
    await expect(service.enable(input("stale-request"), "operator-1")).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_STALE" });
    expect((await database.pool.query("SELECT * FROM public.audit_events WHERE action='inventory_availability.publication_target.enabled'")).rows).toHaveLength(1);
  });

  async function includeMappedItem() {
    await database.pool.query(`INSERT INTO inventory.publication_membership_versions(publication_target_id,product_variant_id,version,included,definition_hash,review_hash,created_by,created_at)
      VALUES(2,101,1,true,repeat('d',64),repeat('d',64),'operator',$1)`, [WALMART_INVENTORY_NOW]);
    await database.pool.query(`INSERT INTO inventory.publication_membership_heads SELECT publication_target_id,product_variant_id,id
      FROM inventory.publication_membership_versions WHERE publication_target_id=2`);
  }

  it("pause then on queues current quantities for included items only, with no reason or readback step", async () => {
    await includeMappedItem();
    const first = await enable();
    expect(first.publicationRows).toBe(1);
    const stop = new InventoryPublicationTargetStopService(new PostgresInventoryPublicationTargetStopStore(database.pool), clock);
    const paused = await stop.stop({ publicationTargetId: 2, expectedRevision: "4", idempotencyKey: "pause" }, "operator-1");
    expect(paused).toMatchObject({ state: "disabled", revision: "5" });
    const restarted = await service.enable({ ...input("restart"), expectedRevision: "5" }, "operator-1");
    expect(restarted).toMatchObject({ state: "live", revision: "6", publicationRows: 1 });
    expect((await database.pool.query("SELECT publication_target_id,product_variant_id,state FROM inventory.inventory_publication_outbox ORDER BY id")).rows)
      .toEqual([{ publication_target_id: 2, product_variant_id: 101, state: "superseded" }, { publication_target_id: 2, product_variant_id: 101, state: "queued" }]);
    expect((await database.pool.query("SELECT * FROM inventory.inventory_publication_readbacks")).rows).toEqual([]);
  });

  it("keeps global pause and account holds intact", async () => {
    await includeMappedItem();
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=false");
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET held_at=$1,held_by='operator',hold_reason='Keep zero',revision=revision+1 WHERE id=2", [WALMART_INVENTORY_NOW]);
    const result = await service.enable({ ...input(), expectedRevision: "4" }, "operator-1");
    expect(result).toMatchObject({ state: "live", publicationRows: 1 });
    expect((await database.pool.query("SELECT desired_quantity FROM inventory.inventory_publication_outbox WHERE publication_target_id=2")).rows).toEqual([{ desired_quantity: "0" }]);
    expect(await readTarget()).toMatchObject({ hold_reason: "Keep zero", state: "live" });
    expect((await database.pool.query("SELECT global_enabled FROM channels.sync_settings")).rows[0].global_enabled).toBe(false);
  });

  it("blocks an included item lacking its listing link and rolls back activation", async () => {
    await includeMappedItem();
    await database.pool.query("UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=NULL,revision=revision+1 WHERE publication_target_id=2");
    await expect(enable()).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_STOCK_NOT_READY" });
    expect(await readTarget()).toMatchObject({ state: "disabled", revision: "3" });
    expect((await database.pool.query("SELECT * FROM inventory.inventory_publication_outbox")).rows).toEqual([]);
  });

  it("does not activate while an exact provider request is in flight", async () => {
    const provider = await database.pool.connect();
    const key = quantityPublicationScopeLockKey({ destinationKind: "channel_connection", connectionId: 8, providerKey: "walmart",
      providerScopeType: "location", externalScopeId: "test-location", externalInventoryItemId: "P5", productId: null, productVariantId: null });
    try {
      await provider.query("SELECT pg_advisory_lock(hashtextextended($1,918420))", [key]);
      await expect(enable()).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_BUSY" });
      expect(await readTarget()).toMatchObject({ state: "disabled", revision: "3" });
    } finally {
      await provider.query("SELECT pg_advisory_unlock(hashtextextended($1,918420))", [key]); provider.release();
    }
    expect(await enable()).toMatchObject({ state: "live" });
  });

  it("rolls back queued quantities too if the enable audit fails", async () => {
    await includeMappedItem();
    await database.pool.query("CREATE FUNCTION public.reject_enable() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''audit unavailable''; END'; CREATE TRIGGER reject_enable BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_enable();");
    await expect(enable()).rejects.toThrow("audit unavailable");
    expect(await readTarget()).toMatchObject({ state: "disabled", revision: "3" });
    expect((await database.pool.query("SELECT * FROM inventory.inventory_publication_outbox")).rows).toEqual([]);
    expect((await database.pool.query("SELECT * FROM public.idempotency_keys WHERE key LIKE 'inventory-publication-enable:%'")).rows).toEqual([]);
  });

  it("does not apply a pending replacement for an already active stock rule", async () => {
    await database.pool.query("INSERT INTO inventory.channel_exposure_policy_versions(scope_key,channel_id,scope_type,version,supersedes_policy_id,allocation_semantics,eligible,share_bps,holdback_sellable_units,max_publish_mode,min_publish_sellable_units,definition_hash,change_reason,idempotency_key,request_hash,created_by) VALUES('channel:36',36,'channel',2,1,'exposure',true,1000,0,'unlimited',0,repeat('b',64),'Pending','pending-policy',repeat('b',64),'operator'); UPDATE inventory.channel_exposure_policy_heads SET draft_policy_id=(SELECT id FROM inventory.channel_exposure_policy_versions WHERE channel_id=36 AND version=2),revision=revision+1 WHERE channel_id=36;");
    const before = (await database.pool.query("SELECT active_policy_id,draft_policy_id,revision::text FROM inventory.channel_exposure_policy_heads WHERE channel_id=36")).rows;
    expect(await enable()).toMatchObject({ initialDefinitionsApplied: 0 });
    expect((await database.pool.query("SELECT active_policy_id,draft_policy_id,revision::text FROM inventory.channel_exposure_policy_heads WHERE channel_id=36")).rows).toEqual(before);
  });

  it("refuses a disconnected or changed Walmart destination", async () => {
    await database.pool.query("UPDATE channels.walmart_connections SET ship_node_id='different' WHERE channel_id=36");
    await expect(enable()).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_CONNECTION_CHANGED" });
    expect(await readTarget()).toMatchObject({ state: "disabled", revision: "3" });
  });

  it("disallows direct SQL activation without the exclusive inventory fence", async () => {
    await expect(database.pool.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=2")).rejects.toThrow();
    expect(await readTarget()).toMatchObject({ state: "disabled", revision: "3" });
  });
});
