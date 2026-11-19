import type { Pool, PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import {
  DROPSHIP_EBAY_STOCK as F, addDropshipLivePush, countDropshipStockRows, createDropshipEbayTarget, installDropshipEbayStockFixture,
} from "../fixtures/dropship-ebay-stock.fixture";
import { ensureDropshipEbayStockReady } from "../../quantity-publication";

// Channels PR2 (PLAN-CH2 v4.1 §5 and §11.4 PG 29, TST-5): a behaviour pin of the Dropship
// eBay stock link's command lock and receipts, written and green on main before
// ensureDropshipEbayStockReady becomes a wrapper over the shared stock-link command.
// It imports only the published entry point and test fixtures, and states every key as
// a literal (the same values as unit/dropship-ebay-stock-keys.golden.test.ts), so the
// conversion must pass it without any edit. Only the process pool import is redirected.
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
const NOW = new Date("2026-10-27T12:00:00.000Z");
const quiet = { debug: () => {}, info: () => {}, warn: () => {} };
const linkInput = (jobItemId = 1) => ({ vendorId: F.vendorId, storeConnectionId: F.storeConnectionId, accountId: F.accountId,
  environment: F.environment, productId: F.productId, purpose: "publish", variants: [{ productVariantId: F.variantId, sku: F.sku }],
  origin: { kind: "listing_push" as const, jobId: 1, jobItemId, listingId: 1 } });

/** The push of job item 1 (golden "a listing push"). */
const COMMAND_KEY = "1a1a8c2c-5459-5e1d-8908-fa2952c12e80";
const REQUEST_HASH = "139dbaa092f4c9d72839d8e65c439a2cb48eac19ab8c953403946515f24b7f76";
const PREPARATION_KEY = `dropship-ebay-stock:${COMMAND_KEY}`;
const DRAFT_KEY = `dropship-ebay-stock:${COMMAND_KEY}:101`;
/** Another command of the same store (job item 2): its own key, its own lock. */
const OTHER_COMMAND_KEY = "50676305-a182-5bbe-9d7a-26f0ba5d1560";

dbDescribe.sequential("Dropship eBay stock link command lock and receipts, real PostgreSQL (PG 29)", () => {
  let database: InventoryCutoverTestDatabase;
  const ensure = (jobItemId = 1) => ensureDropshipEbayStockReady(database.pool, linkInput(jobItemId),
    { actor: ACTOR, now: NOW, requestedBy: "vendor-user-7", logger: quiet });
  /** classid/objid of a one-bigint advisory lock: the key's high and low 32 bits (objsubid 1). */
  const lockParts = async (key: string) => (await database.pool.query<{ classid: string; objid: string }>(
    `SELECT ((k >> 32) & 4294967295)::text AS classid, (k & 4294967295)::text AS objid
     FROM (SELECT hashtextextended($1, 0) AS k) key`, [key])).rows[0]!;
  const advisoryLocks = async (granted: boolean) => (await database.pool.query<{ pid: number; classid: string; objid: string;
    objsubid: number; mode: string }>(`SELECT pid,classid::bigint::text AS classid,objid::bigint::text AS objid,objsubid::int AS objsubid,mode
    FROM pg_locks WHERE locktype='advisory' AND granted=$1 AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
    ORDER BY pid`, [granted])).rows;
  const waitForAdvisoryWaiter = async () => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const waiting = await advisoryLocks(false);
      if (waiting.length > 0) return waiting;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("No session waited on an advisory lock.");
  };
  /** A pinned inventory writer's own fence check (migrations/236 pin_cutover_writer_admission). */
  const fenceShareNowait = async () => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT epoch FROM inventory.cutover_admission_fence WHERE singleton_key=true FOR SHARE NOWAIT");
      return "free";
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  };
  const holdLock = async (key: string): Promise<{ holder: PoolClient; pid: number }> => {
    const holder = await database.pool.connect();
    const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    return { holder, pid };
  };

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    await installDropshipEbayStockFixture(database.pool);
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; });

  it("waits inside the fence on the command lock another session holds, writes nothing, then links with the same receipts", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await addDropshipLivePush(database.pool, { listingId: 1, productVariantId: F.variantId, sku: F.sku, jobId: 1, jobItemId: 1, status: "processing" });
    const expected = await lockParts(PREPARATION_KEY);
    const { holder, pid: holderPid } = await holdLock(PREPARATION_KEY);
    try {
      expect(await advisoryLocks(true)).toEqual([{ pid: holderPid, ...expected, objsubid: 1, mode: "ExclusiveLock" }]);
      const link = ensure();
      const waiting = await waitForAdvisoryWaiter();
      expect(waiting).toEqual([{ pid: expect.any(Number), ...expected, objsubid: 1, mode: "ExclusiveLock" }]);
      expect(waiting[0]!.pid).not.toBe(holderPid);
      // The wait is inside the fence: a pinned writer's FOR SHARE NOWAIT is refused meanwhile.
      expect(await fenceShareNowait()).toBe("55P03");
      expect(await countDropshipStockRows(database.pool, targetId)).toEqual({ mappings: 0, drafts: 0, outbox: 0, preparations: 0, audits: 0 });
      expect((await holder.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
        [PREPARATION_KEY])).rows[0]!.unlocked).toBe(true);
      expect(await link).toMatchObject({ status: "ready", commandKey: COMMAND_KEY, publicationTargetId: targetId,
        linkedProductVariantIds: [F.variantId], alreadyLinked: false,
        mappingActions: [{ productVariantId: F.variantId, mappingAction: "create" }],
        preparation: { publicationTargetId: targetId, publicationRows: 1, alreadyApplied: false } });
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
    expect(await fenceShareNowait()).toBe("free");
    expect(await advisoryLocks(true)).toEqual([]);
    // Byte-identical receipts a replay of this push finds.
    expect((await database.pool.query("SELECT idempotency_key,request_hash,actor FROM inventory.publication_mapping_preparations")).rows)
      .toEqual([{ idempotency_key: PREPARATION_KEY, request_hash: REQUEST_HASH, actor: ACTOR }]);
    expect((await database.pool.query(`SELECT key,request_hash FROM public.idempotency_keys
      WHERE key LIKE 'inventory-publication-variant-mapping:%' ORDER BY key`)).rows)
      .toEqual([{ key: `inventory-publication-variant-mapping:${DRAFT_KEY}`, request_hash: REQUEST_HASH }]);
    expect((await database.pool.query(`SELECT idempotency_key,external_inventory_item_id,external_sku,lifecycle_status
      FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=$1`, [targetId])).rows)
      .toEqual([{ idempotency_key: DRAFT_KEY, external_inventory_item_id: F.sku, external_sku: F.sku, lifecycle_status: "sealed" }]);
    expect((await database.pool.query(`SELECT actor,context->>'commandKey' AS command_key,context->>'requestHash' AS request_hash
      FROM public.audit_events WHERE action='inventory_availability.dropship_ebay_stock.linked'`)).rows)
      .toEqual([{ actor: ACTOR, command_key: COMMAND_KEY, request_hash: REQUEST_HASH }]);
  });

  it("is keyed by its own command: another command's held lock does not block it", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await addDropshipLivePush(database.pool, { listingId: 1, productVariantId: F.variantId, sku: F.sku, jobId: 1, jobItemId: 1, status: "processing" });
    const { holder } = await holdLock(`dropship-ebay-stock:${OTHER_COMMAND_KEY}`);
    try {
      expect(await ensure()).toMatchObject({ status: "ready", commandKey: COMMAND_KEY, publicationTargetId: targetId, alreadyLinked: false });
      expect(await advisoryLocks(false)).toEqual([]);
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
    // The other command (job item 2) finds the link on the fast path: no second preparation.
    expect(await ensure(2)).toMatchObject({ status: "ready", commandKey: OTHER_COMMAND_KEY, alreadyLinked: true, preparation: null });
    expect((await database.pool.query("SELECT idempotency_key FROM inventory.publication_mapping_preparations")).rows)
      .toEqual([{ idempotency_key: PREPARATION_KEY }]);
  });
});
