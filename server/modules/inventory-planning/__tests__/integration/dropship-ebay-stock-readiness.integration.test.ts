import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { installWalmartPublicationInventoryFixture } from "../fixtures/walmart-publication-inventory.fixture";
import { installCutoverAdmissionFixturePrerequisites } from "../fixtures/inventory-cutover-admission.fixture";
import {
  DROPSHIP_EBAY_STOCK as F, addDropshipLivePush, addSecondFulfillmentNode, countDropshipStockRows, createDropshipEbayTarget,
  draftDropshipMapping, installDropshipEbayStockFixture, retireDropshipMapping, sealDropshipMapping,
} from "../fixtures/dropship-ebay-stock.fixture";
import {
  ensureDropshipEbayStockReady, readDropshipEbayStockAuthority, readDropshipEbayStockDestination, reviewDropshipEbayStockReadiness,
} from "../../quantity-publication";
import { dropshipEbayStockCommandKey } from "../../domain/dropship-ebay-stock-readiness";
import { quantityPublicationScopeLockKey } from "../../infrastructure/quantity-publication-admission.repository";
import { PUBLICATION_TARGET_SCOPE_LOCK_SEED } from "../../infrastructure/inventory-publication-target-stop.repository";
import { publishOperationalShipmentInsideTransaction } from "../../infrastructure/inventory-availability-dispatch-publication";

// P2 (PLAN-F2-v2 section 9.2): the Dropship eBay stock link writer over real
// PostgreSQL, real inventory migrations, the real planner, mapping preparation,
// outbox and cutover fence. Only the process pool import is redirected.
const runtime = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable database is not initialized.");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const ACTOR = "system:dropship-listing-push";
const NOW = new Date("2026-10-21T12:00:00.000Z");
const VARIANT_B = 102;
const pushOrigin = (jobItemId = 1) => ({ kind: "listing_push" as const, jobId: 1, jobItemId, listingId: 1 });
const linkInput = (overrides: Record<string, unknown> = {}) => ({ vendorId: F.vendorId, storeConnectionId: F.storeConnectionId,
  accountId: F.accountId, environment: F.environment, productId: F.productId, purpose: "publish",
  variants: [{ productVariantId: F.variantId, sku: F.sku }], origin: pushOrigin(), ...overrides });
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function signal() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

dbDescribe.sequential("Dropship eBay stock link writer, real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  type LogLine = (event: Readonly<Record<string, unknown>>) => void;
  let logger: { debug: Mock<LogLine>; info: Mock<LogLine>; warn: Mock<LogLine> };
  const ensure = (input: Record<string, unknown> = linkInput(), pool: Pool = database.pool) =>
    ensureDropshipEbayStockReady(pool, input, { actor: ACTOR, now: NOW, requestedBy: "vendor-user-7", logger });
  const counts = (targetId: number | null) => countDropshipStockRows(database.pool, targetId);
  const epoch = async () => (await database.pool.query<{ epoch: string }>("SELECT epoch::text FROM inventory.cutover_admission_fence")).rows[0]!.epoch;
  const outbox = async (targetId: number, variantId: number = F.variantId) => (await database.pool.query<{ desired_quantity: number; state: string }>(
    `SELECT desired_quantity::int,state FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1 AND product_variant_id=$2
     ORDER BY desired_revision`, [targetId, variantId])).rows;
  const auditActions = async (targetId: number) => (await database.pool.query<{ action: string }>(
    "SELECT action FROM public.audit_events WHERE target=$1 ORDER BY id", [`inventory.inventory_publication_target:${targetId}`])).rows.map(row => row.action);
  /** A new SKU whose live/managed push is processing: selected by the listing owner, no provider identity yet. */
  const newSkuPush = (listingId = 1, productVariantId: number = F.variantId, sku: string = F.sku, jobItemId = listingId) =>
    addDropshipLivePush(database.pool, { listingId, productVariantId, sku, jobId: 1, jobItemId, status: "processing" });
  const zeroWrites = async (targetId: number | null, epochBefore: string) => {
    expect(await counts(targetId)).toEqual({ mappings: 0, drafts: 0, outbox: 0, preparations: 0, audits: 0 });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.publication_mapping_preparations")).rows[0].n).toBe(0);
    expect(await epoch()).toBe(epochBefore);
  };
  /** Scheduling barrier only: SQL and results are never altered. */
  function pausingPool(fragment: string, when: "before" | "after") {
    const reached = signal(), resume = signal();
    let paused = false;
    const pool = new Proxy(database.pool, { get(target, key) {
      if (key === "connect") return async () => {
        const connected = await target.connect();
        return new Proxy(connected, { get(connection, field) {
          if (field === "query") return async (...args: unknown[]) => {
            const matches = !paused && String(args[0]).includes(fragment);
            if (matches && when === "before") { paused = true; reached.release(); await resume.promise; }
            const result = await Reflect.apply(connection.query, connection, args);
            if (matches && when === "after") { paused = true; reached.release(); await resume.promise; }
            return result;
          };
          const value = Reflect.get(connection, field);
          return typeof value === "function" ? value.bind(connection) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return { pool, reached: reached.promise, resume: resume.release };
  }
  /** Authority and freeze rows are cutover control rows: their guard requires the
   * exclusive admission fence (migrations/236_inventory_cutover_admission.sql). */
  const underFence = async (sql: string) => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SELECT * FROM inventory.acquire_cutover_admission_fence('canonical', NULL)");
      await client.query(sql);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  };
  const waitForLockWaiter = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = (await database.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'`)).rows[0]!.n;
      if (waiting > 0) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("No session waited on a lock.");
  };

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    logger = { debug: vi.fn<LogLine>(), info: vi.fn<LogLine>(), warn: vi.fn<LogLine>() };
    await installDropshipEbayStockFixture(database.pool);
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; });

  it("links a new SKU in one commit with its canonical quantity, preparation and audit trail (P2-1)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    expect(await readDropshipEbayStockAuthority(database.pool)).toBe("canonical");
    const epochBefore = await epoch();
    const result = await ensure();
    expect(result).toMatchObject({ status: "ready", commandKey: dropshipEbayStockCommandKey(F.storeConnectionId, pushOrigin()),
      publicationTargetId: targetId, linkedProductVariantIds: [F.variantId], alreadyLinked: false,
      mappingActions: [{ productVariantId: F.variantId, mappingAction: "create" }],
      preparation: { publicationTargetId: targetId, changedProductVariantIds: [F.variantId], publicationRows: 1, appliedBy: ACTOR, alreadyApplied: false } });
    if (result.status !== "ready") throw new Error("Expected a stock link.");
    expect(result.fenceHoldMs).toEqual(expect.any(Number));
    expect(await counts(targetId)).toEqual({ mappings: 1, drafts: 0, outbox: 1, preparations: 1, audits: 2 });
    expect(await outbox(targetId)).toEqual([{ desired_quantity: 17, state: "queued" }]);
    expect(await auditActions(targetId)).toEqual(["inventory_availability.listing_mapping.prepared",
      "inventory_availability.dropship_ebay_stock.linked"]);
    expect((await database.pool.query(`SELECT external_inventory_item_id,external_sku FROM inventory.publication_variant_mapping_versions
      WHERE publication_target_id=$1`, [targetId])).rows).toEqual([{ external_inventory_item_id: F.sku, external_sku: F.sku }]);
    // Mapping, outbox, preparation and audit rows were all written by one transaction.
    const writers = (await database.pool.query<{ xid: string }>(`SELECT DISTINCT xid FROM (
      SELECT xmin::text AS xid FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=$1
      UNION ALL SELECT xmin::text FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1
      UNION ALL SELECT xmin::text FROM inventory.publication_mapping_preparations WHERE publication_target_id=$1
      UNION ALL SELECT xmin::text FROM public.audit_events WHERE target='inventory.inventory_publication_target:'||$1::text) w`, [targetId])).rows;
    expect(writers).toHaveLength(1);
    const audit = (await database.pool.query(`SELECT actor,changes,context FROM public.audit_events
      WHERE action='inventory_availability.dropship_ebay_stock.linked'`)).rows;
    expect(audit).toEqual([{ actor: ACTOR, changes: expect.objectContaining({ before: expect.objectContaining({ publicationTargetId: targetId,
      variants: [{ productVariantId: F.variantId, sku: F.sku, mappingAction: "create" }] }), after: expect.objectContaining({ publicationRows: 1 }) }),
    context: expect.objectContaining({ commandKey: result.commandKey, vendorId: F.vendorId, storeConnectionId: F.storeConnectionId,
      productId: F.productId, origin: pushOrigin(), requestedBy: "vendor-user-7" }) }]);
    expect(await epoch()).not.toBe(epochBefore);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: "inventory_availability.dropship_ebay_stock.ensure",
      outcome: "linked", fence_hold_ms: result.fenceHoldMs, plans_in_fence: 3, command_key: result.commandKey, job_id: 1, job_item_id: 1,
      listing_id: 1, vendor_id: F.vendorId, store_connection_id: F.storeConnectionId, product_id: F.productId, publication_target_id: targetId }));
    expect(await readDropshipEbayStockDestination(database.pool, { storeConnectionId: F.storeConnectionId, accountId: F.accountId }))
      .toMatchObject({ status: "live", liveTargetCount: 1, publicationTargetId: targetId });
  });

  it("replays the same command and serves another command from the fast path without planner work (P2-2, P2-14)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    await ensure();
    const before = await counts(targetId), epochBefore = await epoch();
    for (const input of [linkInput(), linkInput({ origin: pushOrigin(2) })]) {
      expect(await ensure(input)).toMatchObject({ status: "ready", alreadyLinked: true, preparation: null, fenceHoldMs: null,
        mappingActions: [{ productVariantId: F.variantId, mappingAction: "none" }] });
    }
    expect(await counts(targetId)).toEqual(before);
    expect(await epoch()).toBe(epochBefore);
  });

  it("refuses the same command for a different SKU and writes nothing (P2-3)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    await ensure();
    const before = await counts(targetId);
    expect(await ensure(linkInput({ variants: [{ productVariantId: F.variantId, sku: "P5-RENAMED" }] }))).toMatchObject({
      status: "blocked", blockers: [{ code: "STOCK_MAPPING_COMMAND_CONFLICT", productVariantId: null }] });
    expect(await counts(targetId)).toEqual(before);
  });

  it("serializes two commands for the same variant into one mapping version (P2-4)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    const first = pausingPool("acquire_cutover_admission_fence", "after");
    const firstLink = ensure(linkInput(), first.pool);
    await first.reached;
    const secondLink = ensure(linkInput({ origin: pushOrigin(2) }));
    await waitForLockWaiter();
    first.resume();
    const [one, two] = await Promise.all([firstLink, secondLink]);
    expect(one).toMatchObject({ status: "ready", alreadyLinked: false });
    expect(two).toMatchObject({ status: "ready", alreadyLinked: true });
    expect(await counts(targetId)).toMatchObject({ mappings: 1, drafts: 0, outbox: 1, preparations: 1 });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=$1",
      [targetId])).rows[0].n).toBe(1);
  });

  it("throws a busy provider scope without writing, then links once the scope is free (P2-5)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    const holder = await database.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1,$2))", [quantityPublicationScopeLockKey({
        destinationKind: "dropship_store_connection", connectionId: F.storeConnectionId, providerKey: "ebay", providerScopeType: "account",
        externalScopeId: F.accountId, externalInventoryItemId: F.sku, productId: null, productVariantId: null }), PUBLICATION_TARGET_SCOPE_LOCK_SEED]);
      await expect(ensure()).rejects.toMatchObject({ code: "STOCK_MAPPING_PROVIDER_BUSY" });
      expect(await counts(targetId)).toEqual({ mappings: 0, drafts: 0, outbox: 0, preparations: 0, audits: 0 });
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
    expect(await ensure()).toMatchObject({ status: "ready", alreadyLinked: false });
    expect(await counts(targetId)).toMatchObject({ mappings: 1, outbox: 1, preparations: 1 });
  });

  it.each([
    { label: "no destination", setup: async () => null, code: "STOCK_LISTING_TARGET_MISMATCH", targetCount: 0, item: false, destination: "missing" },
    { label: "two live destinations", setup: async (pool: Pool) => {
      await createDropshipEbayTarget(pool);
      await createDropshipEbayTarget(pool, { fulfillmentNodeId: await addSecondFulfillmentNode(pool) });
      return null;
    }, code: "STOCK_LISTING_TARGET_MISMATCH", targetCount: 2, item: false, destination: "duplicated" },
    { label: "a disabled destination", setup: (pool: Pool) => createDropshipEbayTarget(pool, { state: "disabled" }),
      code: "PUBLICATION_DESTINATION_NOT_LIVE", targetCount: 0, item: false, destination: "not_live" },
    { label: "an unsealed supply binding", setup: (pool: Pool) => createDropshipEbayTarget(pool, { binding: "draft" }),
      code: "PUBLICATION_SOURCE_NOT_READY", targetCount: 1, item: false, destination: "source_not_ready" },
    { label: "a held destination", setup: async (pool: Pool) => {
      const id = await createDropshipEbayTarget(pool);
      await pool.query(`UPDATE inventory.inventory_publication_targets SET held_at=transaction_timestamp(),hold_reason='Count review',
        held_by='operator',revision=revision+1 WHERE id=$1`, [id]);
      return id;
    }, code: "STOCK_LISTING_HELD", targetCount: 1, item: false, destination: "held" },
    { label: "a held variant", setup: async (pool: Pool) => {
      const id = await createDropshipEbayTarget(pool);
      await pool.query(`INSERT INTO inventory.inventory_publication_target_variant_holds(publication_target_id,product_variant_id,hold_reason,held_at,held_by)
        VALUES($1,$2,'Count review',transaction_timestamp(),'operator')`, [id, F.variantId]);
      return id;
    }, code: "STOCK_LISTING_HELD", targetCount: 1, item: true, destination: "live" },
    { label: "a store that needs reauthorization", setup: async (pool: Pool) => {
      const id = await createDropshipEbayTarget(pool);
      await pool.query("UPDATE dropship.dropship_store_connections SET status='needs_reauth' WHERE id=22");
      return id;
    }, code: "STOCK_LISTING_ACCOUNT_CHANGED", targetCount: 1, item: false, destination: "live" },
    { label: "an unverified store account", setup: async (pool: Pool) => {
      const id = await createDropshipEbayTarget(pool);
      await pool.query("UPDATE dropship.dropship_store_connections SET external_account_identity_scheme=NULL,external_account_verified_at=NULL WHERE id=22");
      return id;
    }, code: "STOCK_LISTING_ACCOUNT_CHANGED", targetCount: 1, item: false, destination: "live" },
    { label: "the global stock stop", setup: async (pool: Pool) => {
      const id = await createDropshipEbayTarget(pool);
      await pool.query("UPDATE channels.sync_settings SET global_enabled=false");
      return id;
    }, code: "STOCK_LISTING_GLOBAL_STOP", targetCount: 1, item: false, destination: "live" },
  ])("refuses $label before the fence and writes nothing (P2-6)", async ({ setup, code, targetCount, item, destination }) => {
    const targetId = await setup(database.pool);
    await newSkuPush();
    const epochBefore = await epoch();
    const result = await ensure();
    expect(result).toMatchObject({ status: "blocked", targetCount, publicationTargetId: targetId });
    if (result.status !== "blocked") throw new Error("Expected a refusal.");
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code, productVariantId: item ? F.variantId : null })]));
    await zeroWrites(targetId, epochBefore);
    expect(logger.info).not.toHaveBeenCalled();
    expect((await readDropshipEbayStockDestination(database.pool, { storeConnectionId: F.storeConnectionId, accountId: F.accountId })).status)
      .toBe(destination);
  });

  it("never overwrites an existing different identity and promotes a matching saved draft (P2-7)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    // a) An active mapping with another SKU is a reviewed decision; it is not replaced.
    await sealDropshipMapping(database.pool, targetId, F.variantId, "P5-ACTIVE");
    expect(await ensure()).toMatchObject({ status: "blocked",
      blockers: expect.arrayContaining([expect.objectContaining({ code: "STOCK_LISTING_MAPPING_REVIEW_REQUIRED", productVariantId: F.variantId })]) });
    expect(await counts(targetId)).toMatchObject({ mappings: 1, outbox: 0, preparations: 0 });
  });

  it("promotes a saved same-SKU draft and leaves a different-SKU draft untouched (P2-7)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    await newSkuPush(2, VARIANT_B, "NEW", 2);
    const draftId = await draftDropshipMapping(database.pool, targetId, F.variantId, F.sku);
    const otherDraft = await draftDropshipMapping(database.pool, targetId, VARIANT_B, "NEW-OTHER");
    expect(await ensure()).toMatchObject({ status: "ready", alreadyLinked: false,
      mappingActions: [{ productVariantId: F.variantId, mappingAction: "promote_draft" }] });
    expect((await database.pool.query("SELECT lifecycle_status FROM inventory.publication_variant_mapping_versions WHERE id=$1", [draftId])).rows[0])
      .toEqual({ lifecycle_status: "sealed" });
    expect(await ensure(linkInput({ origin: pushOrigin(2), variants: [{ productVariantId: VARIANT_B, sku: "NEW" }] }))).toMatchObject({
      status: "blocked", blockers: expect.arrayContaining([expect.objectContaining({ code: "STOCK_LISTING_MAPPING_REVIEW_REQUIRED", productVariantId: VARIANT_B })]) });
    expect((await database.pool.query("SELECT lifecycle_status,external_sku FROM inventory.publication_variant_mapping_versions WHERE id=$1", [otherDraft])).rows[0])
      .toEqual({ lifecycle_status: "draft", external_sku: "NEW-OTHER" });
  });

  it("refuses a SKU already linked to a sibling variant (P2-7)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    await sealDropshipMapping(database.pool, targetId, VARIANT_B, F.sku);
    expect(await ensure()).toMatchObject({ status: "blocked",
      blockers: expect.arrayContaining([expect.objectContaining({ code: "STOCK_LISTING_MAPPING_CONFLICT", productVariantId: F.variantId })]) });
    expect(await counts(targetId)).toMatchObject({ mappings: 1, outbox: 0, preparations: 0 });
  });

  it("links one listing of a multi-variant product while a selected sibling is still unlinked (P2-8, D6)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    await newSkuPush(2, VARIANT_B, "NEW", 2);
    expect(await ensure()).toMatchObject({ status: "ready", alreadyLinked: false, preparation: { publicationRows: 1 } });
    expect(await outbox(targetId)).toEqual([{ desired_quantity: 17, state: "queued" }]);
    expect(await outbox(targetId, VARIANT_B)).toEqual([]);
  });

  it("links a deselected retained listing for enrollment at quantity zero (P2-9)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await addDropshipLivePush(database.pool, { listingId: 1, productVariantId: F.variantId, sku: F.sku, jobId: 1, jobItemId: 1,
      status: "completed", externalListingId: "listing-P5", externalOfferId: "offer-P5", listingStatus: "active" });
    await database.pool.query("INSERT INTO dropship.dropship_vendor_variant_overrides(vendor_id,product_variant_id,enabled_override) VALUES(10,101,false)");
    const enrollment = linkInput({ purpose: "sync", origin: { kind: "live_listing_enrollment", listingId: 1, evidenceHash: "e".repeat(64) } });
    expect(await ensureDropshipEbayStockReady(database.pool, enrollment, { actor: "system:dropship-stock-enrollment", now: NOW, logger: quiet }))
      .toMatchObject({ status: "ready", alreadyLinked: false });
    expect(await outbox(targetId)).toEqual([{ desired_quantity: 0, state: "queued" }]);
  });

  it("links a variant whose inventory tracking is unset, as the planner and selection treat it (P2-10)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    await database.pool.query("UPDATE catalog.product_variants SET track_inventory=NULL WHERE id=101");
    expect(await ensure()).toMatchObject({ status: "ready", alreadyLinked: false });
    expect(await outbox(targetId)).toEqual([{ desired_quantity: 17, state: "queued" }]);
  });

  it("is a no-op under legacy authority (P2-11)", async () => {
    // A canonical cutover cannot return to legacy (database guard), so this case
    // uses its own never-activated database with the same inventory migrations.
    const legacy = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    try {
      await installWalmartPublicationInventoryFixture(legacy.pool, { includeWalmartMapping: false, targetState: "preview",
        includeQuantityRecoveryMigrations: true });
      await installCutoverAdmissionFixturePrerequisites(legacy.pool);
      await legacy.pool.query(readFileSync(resolve("migrations", "236_inventory_cutover_admission.sql"), "utf8"));
      const state = async () => (await legacy.pool.query(`SELECT
        (SELECT epoch::text FROM inventory.cutover_admission_fence) AS epoch,
        (SELECT count(*)::int FROM inventory.publication_variant_mapping_versions) AS mappings,
        (SELECT count(*)::int FROM inventory.inventory_publication_outbox) AS outbox,
        (SELECT count(*)::int FROM inventory.publication_mapping_preparations) AS preparations,
        (SELECT count(*)::int FROM public.audit_events) AS audits`)).rows[0];
      expect(await readDropshipEbayStockAuthority(legacy.pool)).toBe("legacy");
      const before = await state();
      expect(await ensure(linkInput(), legacy.pool)).toEqual({ status: "not_applicable", reason: "legacy_authority" });
      expect(await state()).toEqual(before);
      expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not_applicable", reason: "legacy_authority",
        command_key: dropshipEbayStockCommandKey(F.storeConnectionId, pushOrigin()) }));
    } finally { await legacy.close(); }
  }, 60_000);

  it("throws while an activation configuration freeze is open and writes nothing (P2-12)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    await underFence(`INSERT INTO inventory.availability_activation_freezes(activation_run_id,source_dry_run_id,evidence_hash,acquired_by,acquired_at)
      SELECT run.id,run.source_dry_run_id,repeat('c',64),'operator',transaction_timestamp()
      FROM inventory.availability_activation_runs run JOIN inventory.availability_runtime_authority a ON a.activation_run_id=run.id`);
    const epochBefore = await epoch();
    await expect(ensure()).rejects.toMatchObject({ code: "55000", message: "CUTOVER_CONFIGURATION_FREEZE_CHANGED" });
    await zeroWrites(targetId, epochBefore);
  });

  it("rolls everything back when its audit row cannot be written, then succeeds (P2-13)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    await database.pool.query(`CREATE FUNCTION public.fail_dropship_stock_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='inventory_availability.dropship_ebay_stock.linked' THEN RAISE EXCEPTION 'audit store unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_dropship_stock_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_dropship_stock_audit()`);
    await expect(ensure()).rejects.toThrow("audit store unavailable");
    expect(await counts(targetId)).toEqual({ mappings: 0, drafts: 0, outbox: 0, preparations: 0, audits: 0 });
    await database.pool.query("DROP TRIGGER fail_dropship_stock_audit ON public.audit_events");
    expect(await ensure()).toMatchObject({ status: "ready", alreadyLinked: false });
    expect(await counts(targetId)).toEqual({ mappings: 1, drafts: 0, outbox: 1, preparations: 1, audits: 2 });
  });

  it("applies the stock the locked capture sees when ATP changes before the fence (P2-15)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    const paused = pausingPool("acquire_cutover_admission_fence", "before");
    const link = ensure(linkInput(), paused.pool);
    await paused.reached;
    // A concurrent stock receipt commits after the read-only pre-check.
    await database.pool.query(`UPDATE inventory.inventory_levels SET variant_qty=variant_qty+2 WHERE product_variant_id=101;
      UPDATE inventory.inventory_lots SET qty_on_hand=qty_on_hand+2 WHERE product_variant_id=101`);
    paused.resume();
    expect(await link).toMatchObject({ status: "ready", alreadyLinked: false });
    expect(await outbox(targetId)).toEqual([{ desired_quantity: 19, state: "queued" }]);
  });

  it("never re-links under a command whose link was retired after it applied (P2-16)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    await ensure();
    // No product writer retires a mapping today; the fixture simulates a later identity retirement.
    await retireDropshipMapping(database.pool, targetId, F.variantId);
    const before = await counts(targetId), epochBefore = await epoch();
    expect(await ensure()).toMatchObject({ status: "blocked", publicationTargetId: targetId,
      blockers: [{ code: "STOCK_MAPPING_LINK_CHANGED_AFTER_APPLY", productVariantId: null }] });
    expect(await counts(targetId)).toEqual(before);
    expect(await epoch()).toBe(epochBefore);
  });

  it("reports a stopped destination for an applied command and resumes on the intact link (P2-16)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    await ensure();
    await database.pool.query(`UPDATE inventory.inventory_publication_targets SET state='disabled',activated_by=NULL,activated_at=NULL,
      revision=revision+1 WHERE id=$1`, [targetId]);
    expect(await ensure()).toMatchObject({ status: "blocked", targetCount: 0, publicationTargetId: targetId,
      blockers: expect.arrayContaining([expect.objectContaining({ code: "PUBLICATION_DESTINATION_NOT_LIVE", productVariantId: null })]) });
    await database.pool.query(`UPDATE inventory.inventory_publication_targets SET state='preview',activated_by='operator',
      activated_at=transaction_timestamp(),revision=revision+1 WHERE id=$1`, [targetId]);
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=$1", [targetId]);
    // The mapping was never removed: the same and a new command both find it, nothing is re-applied.
    for (const input of [linkInput(), linkInput({ origin: pushOrigin(2) })])
      expect(await ensure(input)).toMatchObject({ status: "ready", alreadyLinked: true, preparation: null });
    expect(await counts(targetId)).toMatchObject({ mappings: 1, preparations: 1 });
  });

  it("holds the fence only for the apply; a concurrent dispatch publication waits and then completes (P2-17)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    // The command lock is the first statement after the fence (and after the hold clock starts).
    const paused = pausingPool("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "after");
    const link = ensure(linkInput(), paused.pool);
    await paused.reached;
    const started = performance.now();
    const dispatch = (async () => {
      // Same retry bound as canonical claim dispatch: SERIALIZABLE may need one more attempt.
      for (let attempt = 1; ; attempt += 1) {
        const client: PoolClient = await database.pool.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          await publishOperationalShipmentInsideTransaction({ client, request: { productVariantId: F.variantId } } as never);
          await client.query("COMMIT");
          return attempt;
        } catch (error) {
          await client.query("ROLLBACK");
          if (attempt >= 3 || (error as { code?: string }).code !== "40001") throw error;
        } finally { client.release(); }
      }
    })();
    await waitForLockWaiter();
    const heldFor = 300;
    await new Promise(resolve => setTimeout(resolve, heldFor));
    paused.resume();
    const result = await link;
    await expect(dispatch).resolves.toEqual(expect.any(Number));
    const waited = performance.now() - started;
    if (result.status !== "ready") throw new Error("Expected a stock link.");
    expect(result.fenceHoldMs).toBeGreaterThanOrEqual(heldFor);
    // Bounded by the fence hold plus one second (no deadlock, no lock timeout).
    expect(waited).toBeLessThan(result.fenceHoldMs! + 1_000);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ outcome: "linked", fence_hold_ms: result.fenceHoldMs }));
    expect((await outbox(targetId)).at(-1)).toEqual({ desired_quantity: 17, state: "queued" });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=$1",
      [targetId])).rows[0].n).toBe(1);
  });

  it("reviews readiness read-only (preview contract for 2b)", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await newSkuPush();
    const epochBefore = await epoch();
    expect(await reviewDropshipEbayStockReadiness(database.pool, linkInput())).toEqual({ publicationTargetId: targetId, liveTargetCount: 1,
      ready: true, currentlyReady: false, blockers: [],
      variants: [{ productVariantId: F.variantId, sku: F.sku, mappingAction: "create", desiredQuantity: "17" }] });
    await zeroWrites(targetId, epochBefore);
  });
});
