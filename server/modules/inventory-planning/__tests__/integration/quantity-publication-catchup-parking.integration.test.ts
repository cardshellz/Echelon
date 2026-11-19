import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { installEbayListingScopeFixture } from "../fixtures/ebay-listing-preparation-scope.fixture";
import { createAuthorityAwareInventoryPublicationService } from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { planCurrentCanonicalListingQuantity } from "../../infrastructure/quantity-publication-runtime";
import { PostgresQuantityPublicationAdmission, quantityPublicationScopeLockKey, retainCatchupScopes } from "../../infrastructure/quantity-publication-admission.repository";
import { QuantityPublicationCatchupService } from "../../application/quantity-publication-admission.port";
import { acquireInventoryCutoverFenceInsideTransaction } from "../../infrastructure/inventory-cutover-admission-fence.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "../../infrastructure/inventory-cutover-definitions.repository";
import { retireStockLinkMappingsInsideTransaction } from "../../infrastructure/stock-link-retire";
import { quantityCatchupHealthChecks } from "../../quantity-catchup-health";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";

// Channels PR5 (PLAN-CH-v3 section 6 "Catch-up", "Wake matching"; section 9 PR5 tests). Only the process
// composition root is redirected: planning, admission, parking, the sealer's wake and settlement all run real SQL
// against disposable PostgreSQL. No provider HTTP exists in these paths.
const runtime = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable database is not initialized.");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const START = Date.parse("2026-10-29T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TARGET = 1;
const VARIANT = 101;
const quiet = { info: () => {}, warn: () => {} };
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const shopifyScope = (item: string, productVariantId: number | null = VARIANT): QuantityPublicationScope => ({
  destinationKind: "channel_connection", connectionId: 7, providerKey: "shopify", providerScopeType: "location",
  externalScopeId: "test-location", externalInventoryItemId: item, productId: productVariantId === null ? null : 20, productVariantId,
});

dbDescribe.sequential("quantity catch-up parking: park, wake, settle", () => {
  let database: InventoryCutoverTestDatabase;
  let clockMs = START;
  const clock = () => new Date(clockMs);
  let admission: PostgresQuantityPublicationAdmission;
  let replan: ReturnType<typeof vi.fn>;
  let service: QuantityPublicationCatchupService;

  beforeEach(async () => {
    clockMs = START;
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    await installEbayListingScopeFixture(database.pool);
    for (const file of ["900000016000018560001_quantity_publication_archived_catchup_settlement.sql",
      "900000039000019440002_quantity_catchup_identity_retired_settlement.sql"]) {
      await database.pool.query(readFileSync(resolve("migrations", file), "utf8"));
    }
    // As quantity-publication-listing-scope: the live Shopify target 1 carries size 101 on item 'test-item'.
    await database.pool.query(`UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=1;
      INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_variant_id,channel_inventory_item_id,channel_sku)
        VALUES(35,101,'shopify-P10','test-item','P5')`);
    await createAuthorityAwareInventoryPublicationService(database.pool, { logger: quiet })
      .publishProduct({ productId: 20, publicationTargetId: TARGET, productVariantIds: [VARIANT], dryRun: false }, async () => null);
    admission = new PostgresQuantityPublicationAdmission(database.pool, clock);
    // The production replan for canonical authority (quantity-publication-runtime.ts), spied only to count calls.
    replan = vi.fn((scope: QuantityPublicationScope) => planCurrentCanonicalListingQuantity(scope));
    service = new QuantityPublicationCatchupService(admission, replan as never, undefined, silent);
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; });

  async function inFence<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async function head(): Promise<{ active: number | null; revision: string }> {
    const row = (await database.pool.query<{ active_mapping_id: number | null; revision: string }>(`SELECT active_mapping_id,revision::text
      FROM inventory.publication_variant_mapping_heads WHERE publication_target_id=$1 AND product_variant_id=$2`, [TARGET, VARIANT])).rows[0];
    return { active: row.active_mapping_id, revision: row.revision };
  }
  /** The engine's retire (stock-link-retire.ts) under the real fence. */
  async function retire(at: number): Promise<void> {
    const current = await head();
    await inFence(client => retireStockLinkMappingsInsideTransaction(client, { publicationTargetId: TARGET,
      members: [{ productVariantId: VARIANT, mappingId: current.active!, expectedHeadRevision: current.revision }],
      actor: "system:stock-link", reason: "Store item gone", now: new Date(at) }));
  }
  /** A draft of the size's next version, then the shared sealer (every link writer's last step), optionally retiring first. */
  async function link(item: string, at: number, options: { retireFirst?: boolean } = {}): Promise<number> {
    return inFence(async client => {
      const before = await head();
      if (options.retireFirst && before.active !== null) await retireStockLinkMappingsInsideTransaction(client, { publicationTargetId: TARGET,
        members: [{ productVariantId: VARIANT, mappingId: before.active, expectedHeadRevision: before.revision }],
        actor: "system:stock-link", reason: "Relink", now: new Date(at) });
      const previous = (await client.query<{ id: number; version: number }>(`SELECT id,version FROM inventory.publication_variant_mapping_versions
        WHERE publication_target_id=$1 AND product_variant_id=$2 ORDER BY version DESC LIMIT 1`, [TARGET, VARIANT])).rows[0];
      const mappingId = (await client.query<{ id: number }>(`INSERT INTO inventory.publication_variant_mapping_versions
        (publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,definition_hash,supersedes_mapping_id,
         change_reason,idempotency_key,request_hash,created_by)
        VALUES($1,$2,$3,$4,'P5',repeat('c',64),$5,'Parking fixture link',$6,repeat('c',64),'system:stock-link') RETURNING id`,
      [TARGET, VARIANT, previous.version + 1, item, previous.id, `parking-link-${item}`])).rows[0].id;
      await client.query(`UPDATE inventory.publication_variant_mapping_heads SET draft_mapping_id=$3,revision=revision+1
        WHERE publication_target_id=$1 AND product_variant_id=$2`, [TARGET, VARIANT, mappingId]);
      await promoteInventoryCutoverDefinitionsInsideTransaction(client, { contractVersion: "inventory_cutover_selection_manifest_v1",
        productIds: [], publicationTargetIds: [TARGET],
        selections: [{ kind: "variant_mapping", key: `${TARGET}:${VARIANT}`, definitionId: mappingId, definitionHash: "c".repeat(64) }] },
      { actor: "system:stock-link", reason: "Parking fixture link", occurredAt: new Date(at) });
      return mappingId;
    });
  }
  async function retain(scope: QuantityPublicationScope): Promise<string> {
    await retainCatchupScopes(database.pool, [scope], null, "parking_test_event", clock());
    return (await database.pool.query<{ id: string }>("SELECT id::text FROM inventory.quantity_publication_catchup WHERE scope_key=$1",
      [quantityPublicationScopeLockKey(scope)])).rows[0].id;
  }
  async function row(id: string) {
    return (await database.pool.query<{ revision: string; completed_revision: string; attempt_count: number; failure_class: string | null;
      parked_at: Date | null; parked_code: string | null; requires_review_at: Date | null; next_attempt_at: Date; last_error_code: string | null }>(
      `SELECT revision::text,completed_revision::text,attempt_count,failure_class,parked_at,parked_code,requires_review_at,next_attempt_at,last_error_code
       FROM inventory.quantity_publication_catchup WHERE id=$1`, [id])).rows[0];
  }
  async function receipts(id: string) {
    return (await database.pool.query("SELECT basis,actor,evidence,revision::text FROM inventory.quantity_publication_catchup_settlements WHERE catchup_id=$1", [id])).rows;
  }
  const at = (offset: number) => new Date(START + offset);

  it("parks a missing-link refusal, stops retrying, wakes on the link and then completes (pins the woken-row HYPOTHESIS)", async () => {
    await retire(START - HOUR);
    const waiting = await retain(shopifyScope("1001"));
    const unrelated = await retain(shopifyScope("9999"));
    expect(await service.processDue()).toEqual({ completed: 0, failed: 2 });
    expect(await row(waiting)).toMatchObject({ failure_class: "parked", parked_code: "PUBLICATION_LISTING_TARGET_UNMAPPED",
      parked_at: at(0), attempt_count: 0, completed_revision: "0", next_attempt_at: at(24 * HOUR), requires_review_at: null });
    clockMs = START + 10 * MINUTE;
    expect(await admission.listDue(25)).toEqual([]);
    expect(await service.processDue()).toEqual({ completed: 0, failed: 0 });

    await link("1001", START + 20 * MINUTE);
    expect((await row(waiting)).next_attempt_at).toEqual(at(20 * MINUTE));
    expect((await row(unrelated)).next_attempt_at).toEqual(at(24 * HOUR));

    clockMs = START + 21 * MINUTE;
    expect(await service.processDue()).toEqual({ completed: 1, failed: 0 });
    expect(await row(waiting)).toMatchObject({ completed_revision: "1", revision: "1" });
    expect((await database.pool.query(`SELECT count(*)::int AS n FROM inventory.inventory_publication_outbox
      WHERE publication_target_id=$1 AND product_variant_id=$2 AND external_inventory_item_id_snapshot='1001'`, [TARGET, VARIANT])).rows[0].n).toBe(1);
    expect(await receipts(waiting)).toEqual([]);
  });

  it("settles a row parked on a retired item with an identity_retired receipt after a relink, and never re-parks it", async () => {
    await link("2001", START - 2 * HOUR, { retireFirst: true });
    await retire(START - HOUR);
    const waiting = await retain(shopifyScope("2001", null));
    expect(await service.processDue()).toEqual({ completed: 0, failed: 1 });
    expect((await row(waiting)).failure_class).toBe("parked");

    const linked = await link("2002", START + 5 * MINUTE);
    expect((await row(waiting)).next_attempt_at).toEqual(at(5 * MINUTE));
    clockMs = START + 6 * MINUTE;
    expect(await service.processDue()).toEqual({ completed: 1, failed: 0 });
    expect(await row(waiting)).toMatchObject({ completed_revision: "1", failure_class: null, parked_at: null, parked_code: null });
    const [receipt] = await receipts(waiting);
    expect(receipt).toMatchObject({ basis: "identity_retired", actor: "system:quantity-publication-catchup", revision: "1",
      evidence: { basis: "identity_retired", publicationTargetId: TARGET, productVariantId: VARIANT, activeMappingId: linked,
        activeExternalInventoryItemId: "2002", externalInventoryItemId: "2001" } });
    expect(await receipts(waiting)).toHaveLength(1);
    clockMs = START + 30 * HOUR;
    expect(await admission.listDue(25)).toEqual([]);
  });

  it("wakes a gid-form scope on a decimal link and settles it: the decimal link's outbox carries the quantity", async () => {
    await retire(START - HOUR);
    const waiting = await retain(shopifyScope("gid://shopify/InventoryItem/3003", null));
    await service.processDue();
    expect((await row(waiting)).failure_class).toBe("parked");
    await link("3003", START + MINUTE);
    expect((await row(waiting)).next_attempt_at).toEqual(at(MINUTE));
    clockMs = START + 2 * MINUTE;
    expect(await service.processDue()).toEqual({ completed: 1, failed: 0 });
    expect((await receipts(waiting))[0]).toMatchObject({ basis: "identity_retired",
      evidence: { activeExternalInventoryItemId: "3003", externalInventoryItemId: "gid://shopify/InventoryItem/3003" } });
  });

  it("re-checks a parked row once a day and keeps its parked-since time", async () => {
    await retire(START - HOUR);
    const waiting = await retain(shopifyScope("4004"));
    await service.processDue();
    clockMs = START + 24 * HOUR - 1;
    expect(await admission.listDue(25)).toEqual([]);
    clockMs = START + 24 * HOUR;
    expect((await admission.listDue(25)).map(claim => claim.catchupId)).toEqual([waiting]);
    expect(await service.processDue()).toEqual({ completed: 0, failed: 1 });
    expect(await row(waiting)).toMatchObject({ failure_class: "parked", parked_at: at(0), attempt_count: 0, next_attempt_at: at(48 * HOUR) });
  });

  it("pauses busy codes without an attempt (also a link holding the authority row), and backs off counted transient failures", async () => {
    const waiting = await retain(shopifyScope("test-item"));
    replan.mockRejectedValueOnce(Object.assign(new Error("Scope busy"), { code: "PUBLICATION_SCOPE_BUSY" }));
    expect(await service.processDue()).toEqual({ completed: 0, failed: 1 });
    let current = await row(waiting);
    expect(current).toMatchObject({ failure_class: "paused", attempt_count: 0, last_error_code: "PUBLICATION_SCOPE_BUSY" });
    const delay = (current.next_attempt_at.getTime() - START) / 1000;
    expect(delay).toBeGreaterThanOrEqual(60); expect(delay).toBeLessThanOrEqual(180);

    // A link transaction holds the authority row FOR UPDATE: the park proof is busy, not a wait for a link.
    clockMs = current.next_attempt_at.getTime();
    replan.mockRejectedValueOnce(Object.assign(new Error("Unmapped"), { code: "PUBLICATION_LISTING_TARGET_UNMAPPED" }));
    const holder = await database.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR UPDATE");
      expect(await service.processDue()).toEqual({ completed: 0, failed: 1 });
    } finally { await holder.query("ROLLBACK"); holder.release(); }
    current = await row(waiting);
    expect(current).toMatchObject({ failure_class: "paused", attempt_count: 0, parked_at: null });

    for (const [attempt, seconds] of [[1, 60], [2, 120], [3, 240]] as const) {
      clockMs = current.next_attempt_at.getTime();
      replan.mockRejectedValueOnce(Object.assign(new Error("Timeout"), { code: "PROVIDER_TIMEOUT" }));
      expect(await service.processDue()).toEqual({ completed: 0, failed: 1 });
      const next = await row(waiting);
      expect(next).toMatchObject({ failure_class: "transient", attempt_count: attempt });
      expect(next.next_attempt_at.getTime() - clockMs).toBe(seconds * 1000);
      current = next;
    }
  });

  it("stops a permanent failure for review, raises it on Ops Health, and lets a newer stock event start afresh", async () => {
    const waiting = await retain(shopifyScope("test-item"));
    replan.mockRejectedValueOnce(Object.assign(new Error("Refused"), { code: "SHOPIFY_INVENTORY_REJECTED", retryable: false }));
    expect(await service.processDue()).toEqual({ completed: 0, failed: 1 });
    expect(await row(waiting)).toMatchObject({ failure_class: "permanent", requires_review_at: at(0), attempt_count: 0 });
    clockMs = START + 365 * 24 * HOUR;
    expect(await admission.listDue(25)).toEqual([]);

    const dialect = new PgDialect();
    const counts = async (now: Date) => Object.fromEntries(await Promise.all(quantityCatchupHealthChecks({ now }).map(async check => {
      const query = dialect.sqlToQuery(check.countSql);
      await database.pool.query(dialect.sqlToQuery(check.sampleSql).sql);
      return [check.code, (await database.pool.query<{ count: number }>(query.sql, query.params)).rows[0].count];
    })));
    expect(await counts(clock())).toEqual({ QUANTITY_CATCHUP_PARKED: 0, QUANTITY_CATCHUP_REVIEW_REQUIRED: 1 });

    await retainCatchupScopes(database.pool, [shopifyScope("test-item")], null, "newer_event", clock());
    expect(await row(waiting)).toMatchObject({ revision: "2", failure_class: null, requires_review_at: null, attempt_count: 0 });
    expect(await counts(clock())).toEqual({ QUANTITY_CATCHUP_PARKED: 0, QUANTITY_CATCHUP_REVIEW_REQUIRED: 0 });
    expect(await service.processDue()).toEqual({ completed: 1, failed: 0 });

    // A parked row is raised only after an hour of waiting.
    await retire(clockMs);
    const parked = await retain(shopifyScope("5005"));
    await service.processDue();
    expect((await row(parked)).failure_class).toBe("parked");
    expect((await counts(new Date(clockMs + HOUR - 1))).QUANTITY_CATCHUP_PARKED).toBe(0);
    expect((await counts(new Date(clockMs + HOUR + 1))).QUANTITY_CATCHUP_PARKED).toBe(1);
  });
});
