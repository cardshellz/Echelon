import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrationRetryNotice } from "../../../../../migrations/migration-executor";
import {
  readCatalogStockSelectionFactsForProducts,
  readCatalogStockSelectionFactsForVariants,
} from "../../../catalog/catalog-stock-selection.reader";
import type { EbayListingInspection } from "../../../marketplace-listings/domain/ebay-listing-inspection";
import { tryLockListingMemberRemote } from "../../../marketplace-listings/listing-member-lifecycle";
import { quantityPublicationScopeLockKey } from "../../../inventory-planning/infrastructure/quantity-publication-admission.repository";
import { PostgresQuantityProviderResponseRecovery } from "../../../inventory-planning/infrastructure/quantity-provider-response-recovery.repository";
import type { ListingMemberIdentity } from "../../../../../shared/types/listing-member-lifecycle";
import {
  DropshipListingEndService,
  type DropshipListingEndProvider,
  type ListingEndCredential,
  type ListingEndRow,
  type ListingEndWithdrawResult,
} from "../../application/dropship-listing-end-service";
import { DropshipListingEndOpsService } from "../../application/dropship-listing-end-ops-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import { hashSelectionChangeRequest, parseSelectionChangeBody } from "../../application/dropship-selection-change-dtos";
import {
  DropshipSelectionChangeService,
  seededJitterSource,
  type DropshipSelectionChangeRepository,
  type DropshipSelectionChangeTransaction,
} from "../../application/dropship-selection-change-service";
import { evaluateDropshipCatalogExposure } from "../../domain/catalog-exposure";
import { DROPSHIP_CATALOG_CODE_VERSION } from "../../domain/catalog-code-version";
import { DropshipError } from "../../domain/errors";
import { decideDueRowAction, decideStoreBreaker, parseListingEndResolvedIdentity } from "../../domain/listing-end-claims";
import { decideListingOrderAcceptability } from "../../domain/order-listing-acceptability";
import { LISTING_END_SUPERSEDED_BY_SELECTION, isVisibleInStep1 } from "../../domain/vendor-selection-ends";
import {
  LISTING_SELECTION_LOCK_SQL,
  STORE_LOCK_SQL,
  SYSTEM_OWNER_SQL,
  VARIANT_LOCK_SQL,
} from "../../infrastructure/dropship-listing-setting-writes.repository";
import { PgDropshipListingEndRepository } from "../../infrastructure/dropship-listing-end.repository";
import { PgDropshipListingEndOpsRepository } from "../../infrastructure/dropship-listing-end-ops.repository";
import { PgDropshipListingPushWorkerRepository } from "../../infrastructure/dropship-listing-push-worker.repository";
import { writeProcessHeartbeat } from "../../infrastructure/dropship-process-heartbeat.repository";
import { PgDropshipSelectionAtpRepository } from "../../infrastructure/dropship-selection-atp.repository";
import { PgDropshipSelectionChangeRepository } from "../../infrastructure/dropship-selection-change.repository";
import { readDropshipSelectionEffectsFacts } from "../../infrastructure/dropship-selection-effects.reader";
import { readDropshipListingStockSelection } from "../../stock-publication-selection";
import type { SelectionChangeAnswer, SelectionChangePreviewAnswer } from "../../../../../shared/dropship/vendor-selection-changes";
import { B_STORED_ANSWER } from "../fixtures/vendor-selection-changes-b.fixture";
import {
  LISTING_END_FIXTURE_AT,
  LISTING_END_MIGRATION_FILE,
  applyThroughReleaseExecutor,
  createListingEndDatabase,
  insertListingEndRequests,
  listingEndMigrationSql,
  type ListingEndDatabase,
  type ListingEndRequestRow,
} from "../fixtures/listing-end.fixture";
import {
  inspectedOffer,
  observedPublication,
  publishedInspection,
  unpublishedInspection,
} from "../fixtures/listing-end-inspection.fixture";
import { seedPicks } from "../fixtures/listing-push-runs.fixture";
import { publicationSelectionGateHoldMs, samplePublicationSelectionGate } from "../fixtures/selection-picks-migration.fixture";

/**
 * Listing end requests against a real PostgreSQL (PR C, PLAN-C v4.1 §3, §13.2). The schema path of PR B's suites
 * (the listing-push-runs base, the real 0743, PR A's runs migration, the real B picks file), then C's file through the
 * release executor while a listing writer of the previous release holds its lock. C1 cases: the release; the state
 * CHECKs; one open end per listing; the immutable identity; the cascades; the consistency trigger (FID-6), with plain
 * reads that never wait on a retirement-style catalog row lock; and the invalidation (FID-7): an insert re-plans
 * nothing by itself, the save's picks DELETE re-plans the product once, a state change re-plans it and a side write
 * does not. Later steps add the save, the worker, the staff routes and the interleavings to this suite.
 *
 * Every case that writes rolls back, except the two invalidation cases, which commit on sizes of their own.
 *
 * C3 (PLAN-C v4.1 §4, §13.2): the picks save through the real service and repository, on a database of its own. Its
 * revision, picks, ends, supersedes and audit rows commit together and a failure in step 9 rolls all back; hidden
 * picks go with their product and the revision's pick count stays count(*) (FID-1); the save re-plans a product once
 * (FID-7); a B page's lost answer is answered again and a B page without one is refused with nothing written; one key
 * sent twice in parallel ends once (TST-5); the visible predicate equals step 1's list (A15); the catalog's product
 * read equals its size read (TST-7); the 30,000-size bound; interleaving (g) with sync adoption's locks (FID-2); and
 * the scale case near the bound (TST-8).
 *
 * C4 (PLAN-C v4.1 §5, §13.2): the end worker on real rows, on a database of its own, with eBay stubbed behind the
 * worker's provider port: the claim, the withdraw, the readback and the finish (ids kept, no vendor end time, stock
 * `none`); the finish guard; re-picked while `ending`; the remote-member lock alone across eBay; the version gate;
 * breakers, canary and caps read from real rows (with their plans); the claim's table, the shared-listing guard; and
 * interleavings (a)-(f), (h)-(j) against the real claim.
 *
 * C5 (PLAN-C v4.1 §10, §13.2): the staff surface on the worker's database, through the real service and repository:
 * the list; Retry refused while the SKU's withdraw attempt is unsettled (inventory planning's real response recovery
 * over its reduced journal tables), then pending and ended by the worker's own claim; interleaving (e) through the real
 * Retry; keys scoped by action, also in parallel; "Ended on eBay" (the finish's listing write, not a verified end, a
 * vendor press queued before it fenced) and "Left on sale"; and the 2 s lock wait.
 */
// The service's repositories default to the app pool; every case passes its own.
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const CASE_TIMEOUT_MS = 60_000;
const AT = LISTING_END_FIXTURE_AT;
const ONE_MINUTE_BEFORE = "2026-10-25T11:59:00.000Z";
const IDENTITY_IMMUTABLE = "DROPSHIP_LISTING_END_REQUEST_IDENTITY_IMMUTABLE";
const INCONSISTENT = "DROPSHIP_LISTING_END_REQUEST_INCONSISTENT";

/**
 * Products 1001-1005 with two sizes each (2001-2010), every size enrolled (an active mapping head, so 0743 re-plans
 * its product). Vendor 10 lists every size on eBay store 110, size 2001 on its second store 115 and size 2002 on store
 * 113 (no listing config, so it can be deleted); vendor 11 lists size 2001 on store 111.
 */
const SEED_SQL = `
  INSERT INTO catalog.products (id, sku, name, category, is_active, status, product_type, ebay_listing_excluded)
    SELECT g, 'P-' || g, 'Product ' || g, 'Supplies', true, 'active', 'sleeves', false FROM generate_series(1001, 1005) g;
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded)
    SELECT g, 1001 + (g - 2001) / 2, 'S-' || g, 'Size ' || g, 'pack', true, true, true, 'sellable', false FROM generate_series(2001, 2010) g;
  INSERT INTO inventory.publication_variant_mapping_heads (publication_target_id, product_variant_id, active_mapping_id)
    SELECT 1, id, id FROM catalog.product_variants;
  INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (10, 'member-10'), (11, 'member-11');
  INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, external_account_id, provider_environment,
    external_display_name) VALUES
    (110, 10, 'ebay', 'connected', 'seller-10', 'production', 'Store 110'),
    (115, 10, 'ebay', 'connected', 'seller-10-b', 'production', 'Store 115'),
    (113, 10, 'ebay', 'connected', 'seller-10-c', 'production', 'Store 113'),
    (111, 11, 'ebay', 'connected', 'seller-11', 'production', 'Store 111');
  INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, external_listing_id,
    external_offer_id, status)
    SELECT 10, 110, g, 'ebay', '110000' || g, 'OFFER-110-' || g, 'active' FROM generate_series(2001, 2010) g;
  INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, external_listing_id,
    external_offer_id, status) VALUES
    (10, 115, 2001, 'ebay', '1150002001', 'OFFER-115-2001', 'active'),
    (10, 113, 2002, 'ebay', '1130002002', 'OFFER-113-2002', 'active'),
    (11, 111, 2001, 'ebay', '1110002001', 'OFFER-111-2001', 'active');
  INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions (vendor_id, idempotency_key, request_hash, actor_type, rule_count)
    VALUES (10, 'fixture-ends:10', repeat('0', 64), 'system', 0), (11, 'fixture-ends:11', repeat('0', 64), 'system', 0);
`;

describeDatabase.sequential("dropship listing end requests: schema (PostgreSQL)", () => {
  let db: ListingEndDatabase;
  let pool: Pool;
  const notices: MigrationRetryNotice[] = [];
  let beforeRetry: unknown[] = [];
  let attempts = 0;
  const listings = new Map<string, number>();
  const revisions = new Map<number, number>();

  /** The listing of a size on a store. */
  const listingOf = (store: number, size: number): number => {
    const id = listings.get(`${store}:${size}`);
    if (id === undefined) throw new Error(`No fixture listing for store ${store}, size ${size}.`);
    return id;
  };
  /** A `pending` end of vendor 10's listing of a size on store 110 (or the store given). */
  const endOf = (size: number, overrides: Partial<ListingEndRequestRow> = {}): ListingEndRequestRow => {
    const store = overrides.storeConnectionId ?? 110;
    const vendor = overrides.vendorId ?? (store === 111 ? 11 : 10);
    return { vendorId: vendor, storeConnectionId: store, listingId: listingOf(store, size), productId: 1001 + Math.floor((size - 2001) / 2),
      productVariantId: size, selectionRevisionId: revisions.get(vendor)!, ...overrides };
  };

  beforeAll(async () => {
    db = await createListingEndDatabase({ seed: SEED_SQL, applyListingEnd: false });
    pool = db.pool;
    for (const row of (await pool.query<{ id: number; store_connection_id: number; product_variant_id: number }>(
      "SELECT id, store_connection_id, product_variant_id FROM dropship.dropship_vendor_listings")).rows) {
      listings.set(`${row.store_connection_id}:${row.product_variant_id}`, row.id);
    }
    for (const row of (await pool.query<{ id: number; vendor_id: number }>(
      "SELECT id, vendor_id FROM dropship.dropship_vendor_selection_rule_set_revisions")).rows) {
      revisions.set(row.vendor_id, row.id);
    }

    // A listing writer of the previous release holds the listings while the release runs: the file's foreign key on
    // them waits and times out (55P03); the retry runs once the writer commits.
    const blocker = await pool.connect();
    const migrationClient = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE dropship.dropship_vendor_listings IN ROW EXCLUSIVE MODE");
      attempts = await applyThroughReleaseExecutor(migrationClient, LISTING_END_MIGRATION_FILE, listingEndMigrationSql(), {
        maxAttempts: 3, lockTimeoutMs: 300,
        onRetry: (notice) => { notices.push(notice); },
        sleep: async () => {
          beforeRetry = (await pool.query(`SELECT to_regclass('dropship.dropship_listing_end_requests') AS ends,
            to_regproc('dropship.check_listing_end_request_rows') AS consistency,
            EXISTS (SELECT 1 FROM public._migrations WHERE filename = $1) AS applied`, [LISTING_END_MIGRATION_FILE])).rows;
          await blocker.query("COMMIT");
        },
      });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      migrationClient.release();
    }
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  /** Statements in one transaction that is always rolled back. */
  async function rolledBack(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await work(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  /** The error a piece of work raises, inside a savepoint of the caller's transaction (rolled back to after). */
  async function refusalIn(client: PoolClient, work: () => Promise<unknown>): Promise<Record<string, unknown>> {
    await client.query("SAVEPOINT refusal");
    const error = await work().then(() => null, (caught: unknown) => caught as Record<string, unknown>);
    await client.query("ROLLBACK TO SAVEPOINT refusal");
    expect(error, "expected a refusal").not.toBeNull();
    return error!;
  }

  /** The product's publication selection revision (0743's work row); every enrolled product has one after the seed. */
  async function planRevision(productId: number): Promise<number> {
    const row = (await pool.query<{ revision: string }>(
      "SELECT revision::text AS revision FROM inventory.publication_selection_work WHERE product_id = $1", [productId])).rows[0];
    if (row === undefined) throw new Error(`Product ${productId} has no publication selection work row.`);
    return Number(row.revision);
  }

  it("applies once through the release executor; a lock wait on a referenced table left nothing behind", async () => {
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ file: LISTING_END_MIGRATION_FILE, attempt: 1, sqlState: "55P03" });
    expect(beforeRetry).toEqual([{ ends: null, consistency: null, applied: false }]);
    expect(attempts).toBe(2);
    expect((await pool.query("SELECT 1 FROM public._migrations WHERE filename = $1", [LISTING_END_MIGRATION_FILE])).rowCount).toBe(1);
    // The table is new and empty; its three triggers are installed.
    expect((await pool.query("SELECT count(*)::int AS n FROM dropship.dropship_listing_end_requests")).rows).toEqual([{ n: 0 }]);
    expect((await pool.query<{ tgname: string }>(`SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'dropship.dropship_listing_end_requests'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows.map((row) => row.tgname))
      .toEqual(["listing_end_request_consistency", "listing_end_request_identity_immutable", "publication_selection_invalidation"]);
    // Not written to be re-run: a second application fails loudly and changes nothing.
    await rolledBack(async (client) => {
      expect(await refusalIn(client, () => client.query(listingEndMigrationSql()))).toMatchObject({ code: "42P07" });
    });
  }, CASE_TIMEOUT_MS);

  it("accepts every state the save, the worker and staff write, with the defaults the writers rely on", async () => {
    await rolledBack(async (client) => {
      const ids = await insertListingEndRequests(client, [
        endOf(2001),
        endOf(2002, { state: "ending", resolvedIdentity: { listingMemberKey: "dropship:110:2002" }, withdrawRequestedAt: AT }),
        endOf(2003, { state: "failed", code: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN", context: { requiresReview: true } }),
        endOf(2004, { state: "ended", reason: "product_removed" }),
        endOf(2004, { state: "superseded", code: "DROPSHIP_LISTING_END_RE_PICKED" }),
        endOf(2004, { state: "resolved", staffAction: "resolve_left", staffActionKey: "staff:1" }),
      ]);
      const rows = (await client.query(`SELECT state, next_attempt_at IS NOT NULL AS due, decided_at IS NOT NULL AS decided,
          ended_at IS NOT NULL AS ended, context, attempt_count, deferral_count, withdraw_call_count, version
        FROM dropship.dropship_listing_end_requests WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids])).rows;
      expect(rows.map((row) => [row.state, row.due, row.decided, row.ended])).toEqual([
        ["pending", true, false, false], ["ending", true, false, false], ["failed", false, true, false],
        ["ended", false, true, true], ["superseded", false, true, false], ["resolved", false, true, false]]);
      expect(rows[0]).toMatchObject({ context: {}, attempt_count: 0, deferral_count: 0, withdraw_call_count: 0, version: 1 });
      expect(rows[2]!.context).toEqual({ requiresReview: true });
    });
  }, CASE_TIMEOUT_MS);

  it.each<[string, () => Partial<ListingEndRequestRow>, string, string]>([
    ["a failed end with a due time (the worker would pick it up again)", () => ({ state: "failed", nextAttemptAt: AT }), "23514", "dropship_end_due_chk"],
    ["a pending end with no due time", () => ({ nextAttemptAt: null }), "23514", "dropship_end_due_chk"],
    ["an ended end without its end time", () => ({ state: "ended", endedAt: null }), "23514", "dropship_end_ended_at_chk"],
    ["a pending end with an end time", () => ({ endedAt: AT }), "23514", "dropship_end_ended_at_chk"],
    ["an ending end without its resolved identity", () => ({ state: "ending" }), "23514", "dropship_end_ending_identity_chk"],
    ["a withdraw returned before it was requested", () => ({ withdrawRequestedAt: AT, withdrawReturnedAt: ONE_MINUTE_BEFORE }), "23514",
      "dropship_end_withdraw_chk"],
    ["a withdraw returned that was never requested", () => ({ withdrawReturnedAt: AT }), "23514", "dropship_end_withdraw_chk"],
    ["a staff key without its action", () => ({ staffActionKey: "staff:1" }), "23514", "dropship_end_staff_key_chk"],
    ["a staff action without its key", () => ({ staffAction: "retry" }), "23514", "dropship_end_staff_key_chk"],
    ["an unknown staff action", () => ({ staffAction: "delete", staffActionKey: "staff:1" }), "23514", "dropship_end_staff_action_chk"],
    ["a closed end with no decision time", () => ({ state: "superseded", decidedAt: null }), "23514", "dropship_end_decided_chk"],
    ["an open end with a decision time", () => ({ decidedAt: AT }), "23514", "dropship_end_decided_chk"],
    ["a fourth withdraw call", () => ({ withdrawCallCount: 4 }), "23514", "dropship_end_withdraw_call_count_chk"],
    ["an unknown state", () => ({ state: "cancelled", nextAttemptAt: null, decidedAt: null }), "23514", "dropship_end_state_chk"],
    ["an unknown reason", () => ({ reason: "vendor_ended" }), "23514", "dropship_end_reason_chk"],
    ["a requested identity that is not an object", () => ({ requestedIdentity: ["110000"] }), "23514", "dropship_end_requested_identity_chk"],
    ["a resolved identity that is not an object", () => ({ state: "ending", resolvedIdentity: "dropship:110:2001" }), "23514",
      "dropship_end_resolved_identity_chk"],
    ["a context that is not an object", () => ({ context: [] }), "23514", "dropship_end_context_chk"],
    ["a negative attempt count", () => ({ attemptCount: -1 }), "23514", "dropship_end_attempt_count_chk"],
    ["a negative deferral count", () => ({ deferralCount: -1 }), "23514", "dropship_end_deferral_count_chk"],
    ["version 0", () => ({ version: 0 }), "23514", "dropship_end_version_chk"],
    ["a store of another vendor", () => ({ storeConnectionId: 111, vendorId: 10, listingId: listingOf(111, 2001) }), "23503",
      "dropship_end_store_owner_fk"],
    ["a listing that does not exist", () => ({ listingId: 999_999 }), "23503", "dropship_end_listing_fk"],
  ])("refuses %s", async (_name, overrides, code, constraint) => {
    await rolledBack(async (client) => {
      expect(await refusalIn(client, () => insertListingEndRequests(client, [endOf(2001, overrides())]))).toMatchObject({ code, constraint });
    });
  }, CASE_TIMEOUT_MS);

  it("keeps one open end per listing: pending, ending and failed block another; closed ends do not", async () => {
    await rolledBack(async (client) => {
      const [pending] = await insertListingEndRequests(client, [endOf(2005)]);
      for (const second of [endOf(2005), endOf(2005, { state: "ending", resolvedIdentity: {} }), endOf(2005, { state: "failed" })]) {
        expect(await refusalIn(client, () => insertListingEndRequests(client, [second])))
          .toMatchObject({ code: "23505", constraint: "dropship_end_one_open_idx" });
      }
      // Closed ends of the same listing sit beside the open one; an end of the same size on another store is another listing.
      await insertListingEndRequests(client, [endOf(2005, { state: "ended" }), endOf(2005, { state: "superseded" }),
        endOf(2005, { state: "resolved", staffAction: "resolve_left", staffActionKey: "staff:2" }), endOf(2001, { storeConnectionId: 115 })]);
      // Once the open end closes, a new one may open.
      await client.query(`UPDATE dropship.dropship_listing_end_requests SET state = 'superseded', next_attempt_at = NULL, decided_at = $2
        WHERE id = $1`, [pending, AT]);
      await insertListingEndRequests(client, [endOf(2005, { state: "failed" })]);
      expect((await client.query(`SELECT count(*)::int AS n FROM dropship.dropship_listing_end_requests
        WHERE listing_id = $1 AND state IN ('pending', 'ending', 'failed')`, [listingOf(110, 2005)])).rows).toEqual([{ n: 1 }]);
    });
  }, CASE_TIMEOUT_MS);

  it("never changes a request's identity, while its state and the worker's fields move", async () => {
    await rolledBack(async (client) => {
      const [id] = await insertListingEndRequests(client, [endOf(2006)]);
      const changes: Array<[string, unknown]> = [
        ["vendor_id", 11], ["store_connection_id", 115], ["listing_id", listingOf(110, 2005)], ["product_id", 1004],
        ["product_variant_id", 2007], ["selection_revision_id", revisions.get(11)], ["reason", "product_removed"],
        ["requested_identity", JSON.stringify({ externalListingId: "1100002006" })], ["created_at", ONE_MINUTE_BEFORE],
      ];
      for (const [column, value] of changes) {
        expect(await refusalIn(client, () => client.query(`UPDATE dropship.dropship_listing_end_requests SET ${column} = $2 WHERE id = $1`,
          [id, value])), column).toMatchObject({ code: "P0001", message: IDENTITY_IMMUTABLE });
      }
      // Naming an identity column without changing it is not a change (the same object in another key order is equal jsonb).
      await client.query(`UPDATE dropship.dropship_listing_end_requests SET reason = reason, created_at = created_at,
          requested_identity = '{"providerEnvironment": null, "externalAccountId": null, "externalOfferId": null, "externalListingId": null}',
          state = 'ending', resolved_identity = '{}', withdraw_requested_at = $2, withdraw_call_count = 1, attempt_count = 1,
          context = '{"lastCode": "DROPSHIP_LISTING_END_READBACK_PENDING"}', version = version + 1, updated_at = $2
        WHERE id = $1`, [id, AT]);
      expect((await client.query(`SELECT state, version, vendor_id, listing_id, reason FROM dropship.dropship_listing_end_requests
        WHERE id = $1`, [id])).rows).toEqual([{ state: "ending", version: 2, vendor_id: 10, listing_id: listingOf(110, 2006),
        reason: "size_removed" }]);
    });
  }, CASE_TIMEOUT_MS);

  it("goes with its listing and its store, and keeps a listed size undeletable", async () => {
    await rolledBack(async (client) => {
      const ids = await insertListingEndRequests(client, [endOf(2001, { storeConnectionId: 115 }), endOf(2002, { storeConnectionId: 113 })]);
      await client.query("DELETE FROM dropship.dropship_vendor_listings WHERE id = $1", [listingOf(115, 2001)]);
      await client.query("DELETE FROM dropship.dropship_store_connections WHERE id = 113");
      expect((await client.query("SELECT count(*)::int AS n FROM dropship.dropship_listing_end_requests WHERE id = ANY($1::bigint[])",
        [ids])).rows).toEqual([{ n: 0 }]);
      // A size with a listing cannot be deleted (0086's listing key), so an end row never outlives its size.
      expect(await refusalIn(client, () => client.query("DELETE FROM catalog.product_variants WHERE id = 2008")))
        .toMatchObject({ code: "23503" });
    });
  }, CASE_TIMEOUT_MS);

  it.each<[string, () => ListingEndRequestRow[]]>([
    ["the size of another listing", () => [endOf(2001, { productVariantId: 2002 })]],
    ["a product its size is not in", () => [endOf(2001, { productId: 1002 })]],
    ["a size that does not exist", () => [endOf(2001, { productVariantId: 999_999 })]],
    ["the listing of another vendor", () => [endOf(2001, { vendorId: 11, storeConnectionId: 111, listingId: listingOf(110, 2001) })]],
    ["the listing of the vendor's other store", () => [endOf(2001, { storeConnectionId: 115, listingId: listingOf(110, 2001) })]],
    ["one bad row among good ones", () => [endOf(2001), endOf(2002, { productVariantId: 2001 }), endOf(2003)]],
  ])("refuses an end whose ids do not match its listing: %s (23514, FID-6)", async (_name, rows) => {
    await rolledBack(async (client) => {
      expect(await refusalIn(client, () => insertListingEndRequests(client, rows())))
        .toMatchObject({ code: "23514", message: INCONSISTENT });
    });
    // Outside a transaction the statement is refused whole: none of its rows, good or bad, is written.
    const listingIds = rows().map((row) => row.listingId);
    await expect(insertListingEndRequests(pool, rows())).rejects.toMatchObject({ code: "23514", message: INCONSISTENT });
    expect((await pool.query("SELECT count(*)::int AS n FROM dropship.dropship_listing_end_requests WHERE listing_id = ANY($1::int[])",
      [listingIds])).rows).toEqual([{ n: 0 }]);
  }, CASE_TIMEOUT_MS);

  it("accepts matching ends of several vendors and stores in one statement", async () => {
    await rolledBack(async (client) => {
      const ids = await insertListingEndRequests(client, [endOf(2001), endOf(2001, { storeConnectionId: 115 }),
        endOf(2001, { storeConnectionId: 111 }), endOf(2010, { reason: "product_removed" })]);
      expect(ids).toHaveLength(4);
    });
  }, CASE_TIMEOUT_MS);

  it("proves the ids with plain reads: an insert never waits on a retirement-style catalog row lock (FID-6)", async () => {
    const holder = await pool.connect();
    try {
      // Retirement holds the catalog rows FOR UPDATE across eBay calls (MLR:164).
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM catalog.product_variants WHERE id = 2009 FOR UPDATE");
      await holder.query("SELECT id FROM catalog.products WHERE id = 1005 FOR UPDATE");
      await rolledBack(async (client) => {
        await client.query("SET LOCAL lock_timeout = '2s'");
        expect(await insertListingEndRequests(client, [endOf(2009)])).toHaveLength(1);
        // The control: what a catalog foreign key check takes (FOR KEY SHARE) waits on that lock and times out.
        expect(await refusalIn(client, async () => {
          await client.query("SET LOCAL lock_timeout = '200ms'");
          await client.query("SELECT 1 FROM catalog.product_variants WHERE id = 2009 FOR KEY SHARE");
        })).toMatchObject({ code: "55P03" });
      });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }, CASE_TIMEOUT_MS);

  it("re-plans nothing on an end insert by itself; with the save's picks DELETE in one transaction, the product once (FID-7)", async () => {
    // Product 1002's sizes 2003 and 2004 are picked by a save of their own first.
    await seedPicks(pool, 10, [2003, 2004]);
    const start = await planRevision(1002);
    const others = await planRevision(1001);
    await insertListingEndRequests(pool, [endOf(2003)]);
    expect(await planRevision(1002)).toBe(start);
    // The save's shape: the picks DELETE and the end insert in one transaction.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = 10 AND product_variant_id = 2004");
      await insertListingEndRequests(client, [endOf(2004)]);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(await planRevision(1002)).toBe(start + 1);
    expect(await planRevision(1001)).toBe(others);
  }, CASE_TIMEOUT_MS);

  it("re-plans a product when an end's state changes, and never on a side write or a same-state write (FID-7)", async () => {
    const ids = await insertListingEndRequests(pool, [endOf(2005), endOf(2006), endOf(2007)]);
    const before = { p1003: await planRevision(1003), p1004: await planRevision(1004) };
    const current = async () => ({ p1003: await planRevision(1003), p1004: await planRevision(1004) });
    // The worker's side writes: withdraw fields, a deferral, its context. No state change, so nothing is re-planned.
    await pool.query(`UPDATE dropship.dropship_listing_end_requests SET withdraw_requested_at = $2, withdraw_call_count = 1,
        deferral_count = deferral_count + 1, context = '{"lastCode": "DROPSHIP_LISTING_END_REMOTE_BUSY"}', updated_at = $2
      WHERE id = ANY($1::bigint[])`, [ids, AT]);
    await pool.query("UPDATE dropship.dropship_listing_end_requests SET state = state WHERE id = ANY($1::bigint[])", [ids]);
    expect(await current()).toEqual(before);
    // A supersede of both ends of product 1003 in one statement re-plans 1003 only.
    await pool.query(`UPDATE dropship.dropship_listing_end_requests SET state = 'superseded', next_attempt_at = NULL, decided_at = $2,
        code = 'DROPSHIP_LISTING_END_RE_PICKED', version = version + 1, updated_at = $2
      WHERE id = ANY($1::bigint[])`, [ids.slice(0, 2), AT]);
    expect(await current()).toEqual({ p1003: before.p1003 + 1, p1004: before.p1004 });
    // A claim (pending → ending) re-plans 1004.
    await pool.query(`UPDATE dropship.dropship_listing_end_requests SET state = 'ending', resolved_identity = '{}', version = version + 1,
        updated_at = $2 WHERE id = $1`, [ids[2], AT]);
    expect(await current()).toEqual({ p1003: before.p1003 + 1, p1004: before.p1004 + 1 });
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------------------------------
// C3: the picks save writes its ends (PLAN-C v4.1 §4.7, §13.2).
// ---------------------------------------------------------------------------------------------------------------------

/** The save's clock: the fixture time, inside the admin rule window of size 30096 and before rule 6 starts. */
const SAVE_NOW = new Date(LISTING_END_FIXTURE_AT);
const SAVE_VENDORS = [40, 41, 42, 43, 44, 45, 46, 47] as const;
/** The sizes every vendor lists on its eBay store (100 + vendor id), live, with eBay ids. */
const LISTED_SIZES = [30011, 30012, 30013, 30021, 30022, 30031, 30032, 30041, 30051, 30052, 30061, 30062, 30071] as const;

/**
 * Card Shellz's catalog for the save cases (every size enrolled, so 0743 re-plans its product):
 *   3001  30011, 30012 visible; 30013 does not ship (hidden)        3002  30021, 30022
 *   3003  30031, 30032 ("SUPPLIES ", the rules' category spelling)   3004  30041
 *   3005  30051, 30052                                               3006  30061, 30062
 *   3007  30071, product status `archived` but active (listed in step 1; retirement's, so never ended: DC31)
 *   3008  30081, inactive product
 *   3009  30091 inactive size; 30092 does not ship; 30093 tracks no inventory; 30094 track_inventory NULL (visible);
 *         30095 internal only; 30096 excluded by admin rule 5 from 11:00 to 13:00
 *   3010  30101, excluded by product (rule 2)    3011  30111, category "Excluded cat" (rule 3)
 *   3012  30121, product line 9 (rule 4)         3013  30131, excluded from 13:00 only (rule 6): visible at the clock
 * Vendors 40-46 each have one connected, live eBay store 1xx listing LISTED_SIZES; vendor 40 also has Shopify store 240
 * listing 30011. Vendor 44 turned size 30022 off (still listed in step 1: "Turned off for you").
 */
const SAVE_SEED_SQL = `
  -- What step 1's list reads beyond the picks schema (production shapes: catalog.schema.ts).
  CREATE TABLE catalog.product_categories (id integer PRIMARY KEY, name varchar(100) NOT NULL);
  ALTER TABLE catalog.product_variants ADD COLUMN position integer NOT NULL DEFAULT 0;
  INSERT INTO catalog.product_lines (id, name) VALUES (9, 'Hidden line');
  INSERT INTO catalog.products (id, sku, name, category, is_active, status, product_type, ebay_listing_excluded) VALUES
    (3001, 'P-3001', 'Product 3001', 'Supplies', true, 'active', 'sleeves', false),
    (3002, 'P-3002', 'Product 3002', 'Supplies', true, 'active', 'sleeves', false),
    (3003, 'P-3003', 'Product 3003', 'SUPPLIES ', true, 'active', 'sleeves', false),
    (3004, 'P-3004', 'Product 3004', 'Supplies', true, 'active', 'sleeves', false),
    (3005, 'P-3005', 'Product 3005', 'Supplies', true, 'active', 'sleeves', false),
    (3006, 'P-3006', 'Product 3006', 'Supplies', true, 'active', 'sleeves', false),
    (3007, 'P-3007', 'Product 3007', 'Supplies', true, 'archived', 'sleeves', false),
    (3008, 'P-3008', 'Product 3008', 'Supplies', false, 'active', 'sleeves', false),
    (3009, 'P-3009', 'Product 3009', 'Supplies', true, 'active', 'sleeves', false),
    (3010, 'P-3010', 'Product 3010', 'Supplies', true, 'active', 'sleeves', false),
    (3011, 'P-3011', 'Product 3011', 'Excluded cat', true, 'active', 'sleeves', false),
    (3012, 'P-3012', 'Product 3012', 'Supplies', true, 'active', 'sleeves', false),
    (3013, 'P-3013', 'Product 3013', 'Supplies', true, 'active', 'sleeves', false);
  INSERT INTO catalog.product_line_products (product_id, product_line_id) VALUES (3012, 9);
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded) VALUES
    (30011, 3001, 'S-30011', 'Size 30011', 'pack', true, true, true, 'sellable', false),
    (30012, 3001, 'S-30012', 'Size 30012', 'pack', true, true, true, 'sellable', false),
    (30013, 3001, 'S-30013', 'Size 30013', 'pack', true, false, true, 'sellable', false),
    (30021, 3002, 'S-30021', 'Size 30021', 'pack', true, true, true, 'sellable', false),
    (30022, 3002, 'S-30022', 'Size 30022', 'pack', true, true, true, 'sellable', false),
    (30031, 3003, 'S-30031', 'Size 30031', 'pack', true, true, true, 'sellable', false),
    (30032, 3003, 'S-30032', 'Size 30032', 'pack', true, true, true, 'sellable', false),
    (30041, 3004, 'S-30041', 'Size 30041', 'pack', true, true, true, 'sellable', false),
    (30051, 3005, 'S-30051', 'Size 30051', 'pack', true, true, true, 'sellable', false),
    (30052, 3005, 'S-30052', 'Size 30052', 'pack', true, true, true, 'sellable', false),
    (30061, 3006, 'S-30061', 'Size 30061', 'pack', true, true, true, 'sellable', false),
    (30062, 3006, 'S-30062', 'Size 30062', 'pack', true, true, true, 'sellable', false),
    (30071, 3007, 'S-30071', 'Size 30071', 'pack', true, true, true, 'sellable', false),
    (30081, 3008, 'S-30081', 'Size 30081', 'pack', true, true, true, 'sellable', false),
    (30091, 3009, 'S-30091', 'Size 30091', 'pack', false, true, true, 'sellable', false),
    (30092, 3009, 'S-30092', 'Size 30092', 'pack', true, false, true, 'sellable', false),
    (30093, 3009, 'S-30093', 'Size 30093', 'pack', true, true, false, 'sellable', false),
    (30094, 3009, 'S-30094', 'Size 30094', 'pack', true, true, NULL, 'sellable', false),
    (30095, 3009, 'S-30095', 'Size 30095', 'pack', true, true, true, 'internal_only', false),
    (30096, 3009, 'S-30096', 'Size 30096', 'pack', true, true, true, 'sellable', false),
    (30101, 3010, 'S-30101', 'Size 30101', 'pack', true, true, true, 'sellable', false),
    (30111, 3011, 'S-30111', 'Size 30111', 'pack', true, true, true, 'sellable', false),
    (30121, 3012, 'S-30121', 'Size 30121', 'pack', true, true, true, 'sellable', false),
    (30131, 3013, 'S-30131', 'Size 30131', 'pack', true, true, true, 'sellable', false);
  INSERT INTO dropship.dropship_catalog_rules (id, scope_type, action, product_line_id, product_id, product_variant_id, category,
    starts_at, ends_at, is_active, priority) OVERRIDING SYSTEM VALUE VALUES
    (1, 'catalog', 'include', NULL, NULL, NULL, NULL, NULL, NULL, true, 0),
    (2, 'product', 'exclude', NULL, 3010, NULL, NULL, NULL, NULL, true, 10),
    (3, 'category', 'exclude', NULL, NULL, NULL, 'excluded cat', NULL, NULL, true, 10),
    (4, 'product_line', 'exclude', 9, NULL, NULL, NULL, NULL, NULL, true, 10),
    (5, 'variant', 'exclude', NULL, NULL, 30096, NULL, '2026-10-25T11:00:00Z', '2026-10-25T13:00:00Z', true, 10),
    (6, 'variant', 'exclude', NULL, NULL, 30131, NULL, '2026-10-25T13:00:00Z', NULL, true, 10);
  INSERT INTO inventory.publication_variant_mapping_heads (publication_target_id, product_variant_id, active_mapping_id)
    SELECT 1, id, id FROM catalog.product_variants;
  INSERT INTO dropship.dropship_vendors (id, member_id) SELECT g, 'member-' || g FROM unnest(ARRAY[${SAVE_VENDORS.join(", ")}]) g;
  INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, external_account_id, provider_environment,
    external_display_name)
    SELECT 100 + g, g, 'ebay', 'connected', 'seller-' || g, 'production', 'Store ' || (100 + g)
    FROM unnest(ARRAY[${SAVE_VENDORS.join(", ")}]) g;
  INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, external_account_id, provider_environment,
    external_display_name) VALUES (240, 40, 'shopify', 'connected', 'shop-40', 'production', 'Shop 240');
  INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode, inventory_mode, is_active)
    SELECT id, platform, 'live', 'managed_quantity_sync', true FROM dropship.dropship_store_connections;
  INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, external_listing_id,
    external_offer_id, status)
    SELECT v, 100 + v, s, 'ebay', 'L-' || v || '-' || s, 'O-' || v || '-' || s, 'active'
    FROM unnest(ARRAY[${SAVE_VENDORS.join(", ")}]) v CROSS JOIN unnest(ARRAY[${LISTED_SIZES.join(", ")}]) s ORDER BY v, s;
  INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, external_listing_id,
    external_offer_id, status) VALUES (40, 240, 30011, 'shopify', 'SHOP-30011', 'SHOP-O-30011', 'active');
  INSERT INTO dropship.dropship_vendor_variant_overrides (vendor_id, product_variant_id, enabled_override) VALUES (44, 30022, false);
`;

interface SaveHarness {
  service: DropshipSelectionChangeService;
  logs: Array<{ level: string } & DropshipLogEvent>;
  sleeps: number[];
}

function saveHarness(pool: Pool, repository?: DropshipSelectionChangeRepository): SaveHarness {
  const logs: SaveHarness["logs"] = [];
  const sleeps: number[] = [];
  const service = new DropshipSelectionChangeService({
    repository: repository ?? new PgDropshipSelectionChangeRepository(pool),
    clock: { now: () => SAVE_NOW },
    logger: {
      debug: (event) => logs.push({ level: "debug", ...event }),
      info: (event) => logs.push({ level: "info", ...event }),
      warn: (event) => logs.push({ level: "warn", ...event }),
      error: (event) => logs.push({ level: "error", ...event }),
    },
    sleep: async (delayMs) => { sleeps.push(delayMs); await pause(delayMs); },
    random: seededJitterSource(23),
    picksWritesDisabled: () => false,
  });
  return { service, logs, sleeps };
}

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await pause(5);
  }
}

/** The backend running a statement that starts with `prefix` and waits on a heavyweight lock, if any. */
async function lockWaiter(pool: Pool, prefix: string): Promise<number | null> {
  const row = (await pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
    WHERE state = 'active' AND wait_event_type = 'Lock' AND left(ltrim(query), $2) = $1 AND pid <> pg_backend_pid()
    ORDER BY query_start LIMIT 1`, [prefix, prefix.length])).rows[0];
  return row?.pid ?? null;
}

interface SaveRequest { vendorId: number; add?: number[]; remove?: number[]; key?: string }
let saveKeySeq = 0;

async function headRevisionOf(pool: Pool, vendorId: number): Promise<number | null> {
  return (await pool.query<{ id: number | null }>(
    "SELECT max(id) AS id FROM dropship.dropship_vendor_selection_rule_set_revisions WHERE vendor_id = $1", [vendorId])).rows[0]?.id ?? null;
}

async function previewSave(pool: Pool, h: SaveHarness, request: SaveRequest): Promise<SelectionChangePreviewAnswer> {
  return h.service.preview({ vendorId: request.vendorId, body: {
    clientVersion: DROPSHIP_CATALOG_CODE_VERSION, expectedRevisionId: await headRevisionOf(pool, request.vendorId),
    add: { productVariantIds: request.add ?? [] }, remove: { productVariantIds: request.remove ?? [] },
  } });
}

/** A version-3 page's save body for a confirmed preview: the head, the effects and the echoed ends (§4.1, §4.6). */
function saveBodyOf(request: SaveRequest, preview: SelectionChangePreviewAnswer): Record<string, unknown> {
  return {
    clientVersion: DROPSHIP_CATALOG_CODE_VERSION, expectedRevisionId: preview.headRevisionId,
    add: { productVariantIds: request.add ?? [] }, remove: { productVariantIds: request.remove ?? [] },
    idempotencyKey: request.key ?? `catalog-selection:${request.vendorId}:c3-${saveKeySeq += 1}`,
    expectedEffectsHash: preview.effectsHash,
    expectedEnds: { listingIds: preview.ends.listingIds, hiddenRemovedIds: preview.ends.hiddenRemovedIds },
    expectedOtherEntriesHash: preview.otherEntriesHash,
  };
}

async function applySave(h: SaveHarness, vendorId: number, body: Record<string, unknown>): Promise<{
  answer: SelectionChangeAnswer; idempotentReplay: boolean;
}> {
  return h.service.applyChange({ vendorId, actor: { actorType: "vendor", actorId: `member-${vendorId}` }, body });
}

async function saveRefusal(work: Promise<unknown>): Promise<DropshipError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof DropshipError) return error;
    throw error;
  }
  throw new Error("Expected a refusal.");
}

interface EndRow { id: number; listingId: number; storeConnectionId: number; productVariantId: number; reason: string; state: string;
  code: string | null; revisionId: number; decided: boolean; due: boolean; version: number; requestedIdentity: unknown }

async function endRowsOf(pool: Pool, vendorId: number): Promise<EndRow[]> {
  return (await pool.query<EndRow>(`SELECT id::int AS id, listing_id AS "listingId", store_connection_id AS "storeConnectionId",
      product_variant_id AS "productVariantId", reason, state, code, selection_revision_id AS "revisionId",
      decided_at IS NOT NULL AS decided, next_attempt_at IS NOT NULL AS due, version, requested_identity AS "requestedIdentity"
    FROM dropship.dropship_listing_end_requests WHERE vendor_id = $1 ORDER BY id`, [vendorId])).rows;
}

/** Everything a save writes for one vendor, for before/after comparisons. */
async function vendorWrites(pool: Pool, vendorId: number): Promise<{ revisions: number; picks: number[]; ends: EndRow[]; audits: string[] }> {
  const revisions = (await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM dropship.dropship_vendor_selection_rule_set_revisions WHERE vendor_id = $1", [vendorId])).rows[0]!.n;
  const picks = (await pool.query<{ id: number }>(
    "SELECT product_variant_id AS id FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = $1 ORDER BY 1", [vendorId])).rows
    .map((row) => row.id);
  const audits = (await pool.query<{ event_type: string }>(
    "SELECT event_type FROM dropship.dropship_audit_events WHERE vendor_id = $1 ORDER BY id", [vendorId])).rows.map((row) => row.event_type);
  return { revisions, picks, ends: await endRowsOf(pool, vendorId), audits };
}

async function pickCountOf(pool: Pool, revisionId: number): Promise<{ pickCount: number | null; picks: number }> {
  const row = (await pool.query<{ pick_count: number | null; picks: number }>(`SELECT r.pick_count, (SELECT count(*)::int
      FROM dropship.dropship_vendor_selected_variants s WHERE s.vendor_id = r.vendor_id) AS picks
    FROM dropship.dropship_vendor_selection_rule_set_revisions r WHERE r.id = $1`, [revisionId])).rows[0]!;
  return { pickCount: row.pick_count, picks: row.picks };
}

describeDatabase.sequential("dropship listing end requests: the picks save (PostgreSQL)", () => {
  let db: ListingEndDatabase;
  let pool: Pool;
  const listings = new Map<string, number>();
  const listingOf = (store: number, size: number): number => {
    const id = listings.get(`${store}:${size}`);
    if (id === undefined) throw new Error(`No fixture listing for store ${store}, size ${size}.`);
    return id;
  };
  const planRevisionOf = async (productId: number): Promise<number> => Number((await pool.query<{ revision: string }>(
    "SELECT revision::text AS revision FROM inventory.publication_selection_work WHERE product_id = $1", [productId])).rows[0]!.revision);

  beforeAll(async () => {
    db = await createListingEndDatabase({ seed: SAVE_SEED_SQL });
    pool = db.pool;
    // Version 2 settled with no older process: picks writes are open (PICKS_WRITES_CODE_VERSION; release readiness).
    await writeProcessHeartbeat(pool, { processKey: "web.1:c3", catalogCodeVersion: 2 });
    await pool.query(`UPDATE dropship.dropship_catalog_code_versions SET first_seen_at = clock_timestamp() - interval '10 minutes'
      WHERE catalog_code_version = 2`);
    for (const row of (await pool.query<{ id: number; store_connection_id: number; product_variant_id: number }>(
      "SELECT id, store_connection_id, product_variant_id FROM dropship.dropship_vendor_listings")).rows) {
      listings.set(`${row.store_connection_id}:${row.product_variant_id}`, row.id);
    }
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("writes the revision, the picks, the ends, the supersedes and their audit rows together; a failure in step 9 rolls all back", async () => {
    // Vendor 40 picked both visible sizes of 3001 and its hidden one, and one size of 3002.
    await seedPicks(pool, 40, [30011, 30012, 30013, 30021]);
    const h = saveHarness(pool);

    // Save 1 removes 3001 wholly: both removed sizes end, the hidden size's listing ends with its product and its pick goes.
    const removal = { vendorId: 40, remove: [30011, 30012] };
    const preview = await previewSave(pool, h, removal);
    const firstEnds = [listingOf(140, 30011), listingOf(140, 30012), listingOf(140, 30013)];
    expect(preview).toMatchObject({ toRemove: 2, ends: { listingIds: firstEnds, hiddenRemovedIds: [30013], otherSizes: 1 },
      effects: [{ storeConnectionId: 140, ends: 3 }, { storeConnectionId: 240, ends: 0 }] });
    const first = await applySave(h, 40, saveBodyOf(removal, preview));
    expect(first).toMatchObject({ idempotentReplay: false, answer: { drifted: false, ends: { listingIds: firstEnds, hiddenRemovedIds: [30013] } } });
    const afterFirst = await vendorWrites(pool, 40);
    expect(afterFirst.picks).toEqual([30021]);
    expect(afterFirst.ends.map((end) => [end.listingId, end.productVariantId, end.reason, end.state, end.revisionId, end.due, end.decided]))
      .toEqual([
        [firstEnds[0], 30011, "size_removed", "pending", first.answer.revisionId, true, false],
        [firstEnds[1], 30012, "size_removed", "pending", first.answer.revisionId, true, false],
        [firstEnds[2], 30013, "product_removed", "pending", first.answer.revisionId, true, false],
      ]);
    // The identity eBay is asked to end: the listing's ids and the store's account, frozen at the request.
    expect(afterFirst.ends[0]!.requestedIdentity).toEqual({ externalListingId: "L-40-30011", externalOfferId: "O-40-30011",
      externalAccountId: "seller-40", providerEnvironment: "production" });
    // The Shopify listing of 30011 is never ended.
    expect(afterFirst.ends.some((end) => end.storeConnectionId === 240)).toBe(false);
    expect(afterFirst.audits.slice(-5)).toEqual(["vendor_selection_picks_changed", "listing_end_requested", "listing_end_requested",
      "listing_end_requested", "vendor_selection_ends_recorded"]);
    // FID-1: the hidden pick left with the count.
    expect(await pickCountOf(pool, first.answer.revisionId)).toEqual({ pickCount: 1, picks: 1 });
    const summary = (await pool.query(`SELECT entity_id, payload FROM dropship.dropship_audit_events
      WHERE vendor_id = 40 AND event_type = 'vendor_selection_ends_recorded'`)).rows;
    expect(summary).toEqual([{ entity_id: String(first.answer.revisionId), payload: {
      revisionId: first.answer.revisionId, supersededEndIds: [], hiddenRemovedVariantIds: [30013], hiddenRemovedReason: "removed_with_product",
      endRequestIds: { size_removed: afterFirst.ends.slice(0, 2).map((end) => end.id), product_removed: [afterFirst.ends[2]!.id] } } }]);
    const requested = (await pool.query(`SELECT store_connection_id, entity_type, entity_id, actor_type, actor_id, payload
      FROM dropship.dropship_audit_events WHERE vendor_id = 40 AND event_type = 'listing_end_requested' ORDER BY id LIMIT 1`)).rows[0];
    expect(requested).toEqual({ store_connection_id: 140, entity_type: "dropship_listing_end_request", entity_id: String(afterFirst.ends[0]!.id),
      actor_type: "vendor", actor_id: "member-40", payload: { endRequestId: afterFirst.ends[0]!.id, listingId: firstEnds[0],
        productVariantId: 30011, reason: "size_removed", revisionId: first.answer.revisionId, before: { state: null },
        after: { state: "pending" } } });

    // Save 2 adds 30011 back (its end and 3001's product end are taken back; 30012's own end stays) and removes 3002
    // wholly (two new ends). First with a failure after every step 9 write: nothing of it stays.
    const second = { vendorId: 40, add: [30011], remove: [30021] };
    const secondPreview = await previewSave(pool, h, second);
    const secondEnds = [listingOf(140, 30021), listingOf(140, 30022)];
    expect(secondPreview).toMatchObject({ toAdd: 1, toRemove: 1, ends: { listingIds: secondEnds, hiddenRemovedIds: [], otherSizes: 1,
      stillEnding: 0 } });
    const real = new PgDropshipSelectionChangeRepository(pool);
    let audited = 0;
    const failing: DropshipSelectionChangeRepository = {
      runPreview: (work) => real.runPreview(work),
      runChange: (input, work) => real.runChange(input, (tx) => work({
        ...tx,
        insertListingEndAudits: async (rows) => {
          await tx.insertListingEndAudits(rows);
          audited += 1;
          throw new Error("forced failure after the step 9 writes");
        },
      } satisfies DropshipSelectionChangeTransaction)),
    };
    const failingHarness = saveHarness(pool, failing);
    await expect(applySave(failingHarness, 40, saveBodyOf({ ...second, key: "catalog-selection:40:rolled-back" }, secondPreview)))
      .rejects.toThrow("forced failure after the step 9 writes");
    expect(audited).toBe(1);
    expect(failingHarness.sleeps).toEqual([]);
    expect(await vendorWrites(pool, 40)).toEqual(afterFirst);

    const saved = await applySave(h, 40, saveBodyOf({ ...second, key: "catalog-selection:40:rolled-back" }, secondPreview));
    expect(saved.idempotentReplay).toBe(false);
    const afterSecond = await vendorWrites(pool, 40);
    expect(afterSecond.picks).toEqual([30011]);
    expect(afterSecond.ends.map((end) => [end.listingId, end.reason, end.state, end.code, end.decided, end.due, end.version])).toEqual([
      [firstEnds[0], "size_removed", "superseded", LISTING_END_SUPERSEDED_BY_SELECTION, true, false, 2],
      [firstEnds[1], "size_removed", "pending", null, false, true, 1],
      [firstEnds[2], "product_removed", "superseded", LISTING_END_SUPERSEDED_BY_SELECTION, true, false, 2],
      [secondEnds[0], "size_removed", "pending", null, false, true, 1],
      [secondEnds[1], "product_removed", "pending", null, false, true, 1],
    ]);
    expect(afterSecond.audits.slice(afterFirst.audits.length)).toEqual(["vendor_selection_picks_changed", "listing_end_superseded",
      "listing_end_superseded", "listing_end_requested", "listing_end_requested", "vendor_selection_ends_recorded"]);
    expect(await pickCountOf(pool, saved.answer.revisionId)).toEqual({ pickCount: 1, picks: 1 });
    const superseded = (await pool.query(`SELECT payload FROM dropship.dropship_audit_events
      WHERE vendor_id = 40 AND event_type = 'listing_end_superseded' ORDER BY id LIMIT 1`)).rows[0]!.payload;
    expect(superseded).toMatchObject({ endRequestId: afterFirst.ends[0]!.id, before: { state: "pending" },
      after: { state: "superseded", code: LISTING_END_SUPERSEDED_BY_SELECTION }, revisionId: saved.answer.revisionId });
  }, CASE_TIMEOUT_MS);

  it("keeps the revision's pick count equal to count(*) with an untouched picked sibling, and re-plans the product once (FID-1, FID-7)", async () => {
    // 30031 and 30032 of 3003, and 30041 of 3004; the save removes 30031 only, so 3003 is not wholly removed.
    await seedPicks(pool, 41, [30031, 30032, 30041]);
    const h = saveHarness(pool);
    const before = { p3003: await planRevisionOf(3003), p3004: await planRevisionOf(3004) };
    const request = { vendorId: 41, remove: [30031] };
    const preview = await previewSave(pool, h, request);
    expect(preview.ends).toEqual({ listingIds: [listingOf(141, 30031)], hiddenRemovedIds: [], otherSizes: 0, stillEnding: 0, endReview: 0,
      endedReAdd: 0 });
    const { answer } = await applySave(h, 41, saveBodyOf(request, preview));
    expect(await pickCountOf(pool, answer.revisionId)).toEqual({ pickCount: 2, picks: 2 });
    expect((await endRowsOf(pool, 41)).map((end) => [end.productVariantId, end.reason])).toEqual([[30031, "size_removed"]]);
    // The picks DELETE re-plans 3003 once; the end insert re-plans nothing by itself; 3004 is untouched.
    expect({ p3003: await planRevisionOf(3003), p3004: await planRevisionOf(3004) }).toEqual({ p3003: before.p3003 + 1, p3004: before.p3004 });
  }, CASE_TIMEOUT_MS);

  it("answers a B page's lost answer again by its key, and refuses a B page without one (409) with nothing written", async () => {
    await seedPicks(pool, 42, [30051]);
    const h = saveHarness(pool);
    // A B page's body: version 2, no echo. Its save went through on a B dyno before C's release; the answer was lost.
    const bBody = { clientVersion: 2, expectedRevisionId: await headRevisionOf(pool, 42), add: { productVariantIds: [] },
      remove: { productVariantIds: [30051] }, idempotencyKey: "catalog-selection:42:b-lost", expectedEffectsHash: "e".repeat(64) };
    const stored = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions
        (vendor_id, idempotency_key, request_hash, actor_type, actor_id, rule_count, request_kind, pick_count, result, created_at)
      VALUES (42, $1, $2, 'vendor', 'member-42', 0, 'picks_change', 0, $3::jsonb, $4) RETURNING id`,
    [bBody.idempotencyKey, hashSelectionChangeRequest(parseSelectionChangeBody(bBody)), JSON.stringify(B_STORED_ANSWER), SAVE_NOW])).rows[0]!.id;
    const before = await vendorWrites(pool, 42);
    const replay = await applySave(h, 42, bBody);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.answer).toMatchObject({ ...B_STORED_ANSWER, revisionId: stored,
      effects: [{ ...B_STORED_ANSWER.effects[0], ends: 0, storeConnected: true }],
      ends: { listingIds: [], hiddenRemovedIds: [], otherSizes: 0, stillEnding: 0, endReview: 0, endedReAdd: 0 } });
    expect(await vendorWrites(pool, 42)).toEqual(before);

    // The same B page pressing Save again with a new key: refused before anything is written.
    const refusal = await saveRefusal(applySave(h, 42, { ...bBody, expectedRevisionId: stored, idempotencyKey: "catalog-selection:42:b-new" }));
    expect(refusal).toMatchObject({ code: "DROPSHIP_SELECTION_PAGE_OUTDATED", context: { clientVersion: 2, serverVersion: 3,
      classification: "permanent", retryable: false } });
    expect(h.sleeps).toEqual([]);
    expect(await vendorWrites(pool, 42)).toEqual(before);
  }, CASE_TIMEOUT_MS);

  it("creates its ends once when one save is sent twice in parallel with one key (TST-5)", async () => {
    await seedPicks(pool, 43, [30051]);
    const h = saveHarness(pool);
    const request = { vendorId: 43, remove: [30051], key: "catalog-selection:43:twice" };
    const preview = await previewSave(pool, h, request);
    expect(preview.ends.listingIds).toEqual([listingOf(143, 30051), listingOf(143, 30052)]);
    const body = saveBodyOf(request, preview);
    // The first send holds its transaction open after its writes (review TST-3): the second must wait on the vendor
    // lock, then answer the stored revision again.
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reachedWrites = new Promise<void>((resolve) => { reached = resolve; });
    const real = new PgDropshipSelectionChangeRepository(pool);
    const holding = saveHarness(pool, {
      runPreview: (work) => real.runPreview(work),
      runChange: (input, work) => real.runChange(input, async (tx) => {
        const result = await work(tx);
        reached();
        await gate;
        return result;
      }),
    });
    const leftSave = applySave(holding, 43, body);
    try {
      await reachedWrites;
      const rightSave = applySave(h, 43, body);
      await waitUntil(async () => (await lockWaiter(pool, "SELECT pg_advisory_xact_lock(hashtext('dropship_vendor_selection_rules')")) !== null,
        "the second send to wait on the first's vendor lock");
      release();
      const left = await leftSave;
      const right = await rightSave;
      expect([left.idempotentReplay, right.idempotentReplay]).toEqual([false, true]);
      expect(right.answer).toEqual(left.answer);
    } finally {
      release();
      await leftSave.catch(() => undefined);
    }
    const writes = await vendorWrites(pool, 43);
    expect(writes.ends.map((end) => [end.productVariantId, end.reason, end.state])).toEqual([[30051, "size_removed", "pending"],
      [30052, "product_removed", "pending"]]);
    expect(writes.audits.slice(-4)).toEqual([
      "vendor_selection_picks_changed", "listing_end_requested", "listing_end_requested", "vendor_selection_ends_recorded"]);
    expect(writes.audits.filter((event) => event === "listing_end_requested")).toHaveLength(2);
    expect(h.logs.filter((line) => line.level === "error")).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("decides visibility as step 1's list does over every catalog row (A15), and never ends an archived size (DC31)", async () => {
    const atp = new PgDropshipSelectionAtpRepository(pool);
    const rules = await atp.listCatalogExposureRules();
    const listed = (await atp.listVendorCatalogCandidates({ vendorId: 44 }))
      .filter((candidate) => evaluateDropshipCatalogExposure(candidate, rules, SAVE_NOW).exposed)
      .map((candidate) => candidate.productVariantId).sort((left, right) => left - right);
    const allSizes = (await pool.query<{ id: number }>("SELECT id FROM catalog.product_variants ORDER BY id")).rows.map((row) => row.id);
    const facts = await readDropshipSelectionEffectsFacts(pool, { vendorId: 44, productVariantIds: allSizes });
    expect(facts.candidates.map((candidate) => candidate.productVariantId)).toEqual(allSizes);
    const visible = facts.candidates.filter((candidate) => isVisibleInStep1(candidate, facts.adminRules, SAVE_NOW))
      .map((candidate) => candidate.productVariantId);
    expect(visible).toEqual(listed);
    // Not vacuous: every odd row is decided, the archived-status product is listed and the turned-off size is too.
    expect(visible).toEqual([30011, 30012, 30021, 30022, 30031, 30032, 30041, 30051, 30052, 30061, 30062, 30071, 30094, 30131]);

    // A removal of the archived product's only pick plans no end: retirement owns that listing (DC31).
    await seedPicks(pool, 44, [30071]);
    const h = saveHarness(pool);
    const preview = await previewSave(pool, h, { vendorId: 44, remove: [30071] });
    expect(preview.ends).toMatchObject({ listingIds: [], hiddenRemovedIds: [] });
    expect(listingOf(144, 30071)).toBeGreaterThan(0);
  }, CASE_TIMEOUT_MS);

  it("reads the same catalog facts by product as by size (TST-7)", async () => {
    const productIds = [3001, 3003, 3007, 3008, 3009, 3012, 3999];
    const sizes = (await pool.query<{ id: number }>("SELECT id FROM catalog.product_variants WHERE product_id = ANY($1::int[]) ORDER BY id",
      [productIds])).rows.map((row) => row.id);
    const byProduct = await readCatalogStockSelectionFactsForProducts(pool, productIds, { maxSizes: 30_000 });
    expect(byProduct.length).toBe(sizes.length);
    expect(byProduct).toEqual(await readCatalogStockSelectionFactsForVariants(pool, sizes));
    // Bounded: one more row than asked tells the caller the products hold more sizes than it reads.
    expect(await readCatalogStockSelectionFactsForProducts(pool, productIds, { maxSizes: 3 })).toHaveLength(4);
  }, CASE_TIMEOUT_MS);

  it("interleaving (g): sync adoption with a price holds its locks while a removal saves; no deadlock, the save waits and commits after (FID-2)", async () => {
    await seedPicks(pool, 46, [30061]);
    const h = saveHarness(pool);
    const request = { vendorId: 46, remove: [30061] };
    const preview = await previewSave(pool, h, request);
    expect(preview.ends.listingIds).toEqual([listingOf(146, 30061), listingOf(146, 30062)]);
    const adoption = await pool.connect();
    try {
      // Sync-back's lockListing order with a price (dropship-marketplace-sync.repository.ts): the store lock, the owner
      // rows FOR SHARE, the selection SHARE locks and the size FOR SHARE.
      await adoption.query("BEGIN");
      await adoption.query(STORE_LOCK_SQL, [146]);
      await adoption.query(SYSTEM_OWNER_SQL, [146]);
      await adoption.query(LISTING_SELECTION_LOCK_SQL);
      await adoption.query(VARIANT_LOCK_SQL, [[30061]]);
      const saving = applySave(h, 46, saveBodyOf(request, preview));
      // The save waits at its picks DELETE (the SHARE lock), holding no lock on the listing rows yet.
      await waitUntil(async () => (await lockWaiter(pool, "DELETE FROM dropship.dropship_vendor_selected_variants")) !== null,
        "the picks delete to wait on the adoption's SHARE locks");
      // So the adoption's listing row lock is free: with the end insert before the DELETE this would wait on the save
      // while the save waits on the adoption (a deadlock, 40P01).
      await adoption.query("SET LOCAL lock_timeout = '1s'");
      const locked = await adoption.query("SELECT id FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE", [listingOf(146, 30061)]);
      expect(locked.rowCount).toBe(1);
      await adoption.query("COMMIT");
      const { answer } = await saving;
      expect(answer).toMatchObject({ toRemove: 1, drifted: false });
      expect(h.sleeps).toEqual([]);
      expect(h.logs.filter((line) => line.code === "dropship.selection.change_retry")).toEqual([]);
      expect((await endRowsOf(pool, 46)).map((end) => [end.productVariantId, end.state])).toEqual([[30061, "pending"], [30062, "pending"]]);
    } finally {
      await adoption.query("ROLLBACK").catch(() => undefined);
      adoption.release();
    }
  }, CASE_TIMEOUT_MS);

  it("review DB-1: sync adoption without a price (listing FOR UPDATE, then a listing write) while a removal saves: no deadlock either side", async () => {
    await seedPicks(pool, 47, [30051]);
    const h = saveHarness(pool);
    const request = { vendorId: 47, remove: [30051] };
    const preview = await previewSave(pool, h, request);
    const listing = listingOf(147, 30051);
    expect(preview.ends.listingIds).toEqual([listing, listingOf(147, 30052)]);
    const adoption = await pool.connect();
    try {
      // Sync-back's lockListing without a price (dropship-marketplace-sync.repository.ts): the listing FOR UPDATE only.
      await adoption.query("BEGIN");
      await adoption.query("SET LOCAL lock_timeout = '5s'");
      await adoption.query("SELECT id FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE", [listing]);
      const saving = applySave(h, 47, saveBodyOf(request, preview));
      // The save reaches its end insert while the adoption holds the listing: it waits there, or gives way and retries.
      await waitUntil(async () => h.sleeps.length > 0
        || (await lockWaiter(pool, "INSERT INTO dropship.dropship_listing_end_requests")) !== null
        || (await lockWaiter(pool, "SELECT id FROM dropship.dropship_vendor_listings")) !== null,
      "the save to meet the adoption's listing lock");
      // The adoption's listing write re-plans the product (0743's listings trigger): the work row the save's picks DELETE takes.
      await adoption.query("UPDATE dropship.dropship_vendor_listings SET external_listing_id = 'L-47-30051-relinked' WHERE id = $1", [listing]);
      await adoption.query("COMMIT");
      const { answer } = await saving;
      expect(answer).toMatchObject({ toRemove: 1 });
      const retryCodes = h.logs.filter((line) => line.code === "dropship.selection.change_retry")
        .map((line) => (line.context as { error_code?: string }).error_code);
      expect(retryCodes).not.toContain("40P01");
      expect((await endRowsOf(pool, 47)).map((end) => [end.productVariantId, end.state])).toEqual([[30051, "pending"], [30052, "pending"]]);
    } finally {
      await adoption.query("ROLLBACK").catch(() => undefined);
      adoption.release();
    }
  }, CASE_TIMEOUT_MS);

  it("reads up to 30,000 sizes for a removal and refuses 30,001 with 422 before any listing is read", async () => {
    // Products 6001-9000 with ten sizes each (700001-730000, no mapping head): vendor 45 removes the first size of each,
    // so the facts widen to exactly 30,000 sizes. Ten per product, as a large catalog has them: 0743's row trigger reads
    // a product's sizes per inserted size, so one product of 30,000 sizes would cost a quadratic seed, not a removal.
    await pool.query(`INSERT INTO catalog.products (id, sku, name, category, is_active, status, product_type, ebay_listing_excluded)
      SELECT g, 'P-' || g, 'Product ' || g, 'Supplies', true, 'active', 'sleeves', false FROM generate_series(6001, 9000) g`);
    await pool.query(`INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
        sales_eligibility, ebay_listing_excluded)
      SELECT g, 6001 + (g - 700001) / 10, 'S-' || g, 'Size ' || g, 'pack', true, true, true, 'sellable', false
      FROM generate_series(700001, 730000) g`);
    const removed = Array.from({ length: 3_000 }, (_, index) => 700_001 + index * 10);
    const atBound = await readDropshipSelectionEffectsFacts(pool, { vendorId: 45, productVariantIds: removed, removedIds: removed });
    expect(atBound.candidates).toHaveLength(30_000);
    // One more size of one of the products: past the bound, refused before the listings, overrides or picks are read.
    await pool.query(`INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
        sales_eligibility, ebay_listing_excluded) VALUES (730001, 6001, 'S-730001', 'Size 730001', 'pack', true, true, true, 'sellable', false)`);
    const statements: string[] = [];
    const recording = { query: (text: string, values?: readonly unknown[]) => { statements.push(text); return pool.query(text, values as unknown[]); } };
    await expect(readDropshipSelectionEffectsFacts(recording, { vendorId: 45, productVariantIds: removed, removedIds: removed }))
      .rejects.toMatchObject({ code: "DROPSHIP_SELECTION_REMOVAL_TOO_LARGE", context: { factSizes: 30_001, limit: 30_000,
        classification: "permanent" } });
    expect(statements.some((text) => text.includes("dropship_vendor_listings"))).toBe(false);
    // Only a removal widens: the same sizes touched by an add read their own facts.
    expect((await readDropshipSelectionEffectsFacts(pool, { vendorId: 45, productVariantIds: removed })).candidates).toHaveLength(3_000);
  }, CASE_TIMEOUT_MS);
});

/** TST-8: 2,999 products of ten sizes each (29,990 sizes, just under the 30,000 bound), every size listed live on eBay. */
const SCALE_PRODUCTS = 2_999;
const SCALE_SIZES_PER_PRODUCT = 10;
const SCALE_SIZES = SCALE_PRODUCTS * SCALE_SIZES_PER_PRODUCT;
const SCALE_FIRST_SIZE = 500_001;
const SCALE_QUEUED_ITEMS = 3_000;
const SCALE_CASE_TIMEOUT_MS = 300_000;

/**
 * Products 50001-52999, sizes 500001-529990 (ten per product, each enrolled), vendor 60's connected live eBay store 160
 * listing every size with eBay ids. The vendor picked the first size of each product; a queued push job holds 3,000
 * items with a live intent (the listing rows' push reads, Risk 5).
 */
const SCALE_SEED_SQL = `
  INSERT INTO catalog.products (id, sku, name, category, is_active, status, product_type, ebay_listing_excluded)
    SELECT g, 'P-' || g, 'Product ' || g, 'Supplies', true, 'active', 'sleeves', false FROM generate_series(50001, ${50_000 + SCALE_PRODUCTS}) g;
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded)
    SELECT g, 50001 + (g - ${SCALE_FIRST_SIZE}) / ${SCALE_SIZES_PER_PRODUCT}, 'S-' || g, 'Size ' || g, 'pack', true, true, true, 'sellable', false
    FROM generate_series(${SCALE_FIRST_SIZE}, ${SCALE_FIRST_SIZE + SCALE_SIZES - 1}) g;
  INSERT INTO dropship.dropship_catalog_rules (scope_type, action, is_active, priority) VALUES ('catalog', 'include', true, 0);
  INSERT INTO inventory.publication_variant_mapping_heads (publication_target_id, product_variant_id, active_mapping_id)
    SELECT 1, id, id FROM catalog.product_variants;
  INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (60, 'member-60');
  INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, external_account_id, provider_environment,
    external_display_name) VALUES (160, 60, 'ebay', 'connected', 'seller-160', 'production', 'Store 160');
  INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode, inventory_mode, is_active)
    VALUES (160, 'ebay', 'live', 'managed_quantity_sync', true);
  INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, external_listing_id,
    external_offer_id, status)
    SELECT 60, 160, id, 'ebay', 'L-160-' || id, 'O-160-' || id, 'active' FROM catalog.product_variants ORDER BY id;
  INSERT INTO dropship.dropship_listing_push_jobs (vendor_id, store_connection_id, status, idempotency_key, request_hash, requested_by)
    VALUES (60, 160, 'queued', 'scale-queued', 'hash', 'system');
  INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id, product_variant_id, status, preview_hash, result)
    SELECT (SELECT id FROM dropship.dropship_listing_push_jobs WHERE idempotency_key = 'scale-queued'), l.id, l.product_variant_id,
      'queued', 'preview-' || l.product_variant_id, jsonb_build_object('listingIntent', jsonb_build_object('listingMode', 'live',
        'inventoryMode', 'managed_quantity_sync', 'productVariantId', l.product_variant_id, 'platform', 'ebay'))
    FROM dropship.dropship_vendor_listings l ORDER BY l.id LIMIT ${SCALE_QUEUED_ITEMS};
  ANALYZE;
`;

describeDatabase.sequential("dropship listing end requests: the picks save near the 30,000-size bound (PostgreSQL)", () => {
  let db: ListingEndDatabase;
  let pool: Pool;

  beforeAll(async () => {
    db = await createListingEndDatabase({ seed: SCALE_SEED_SQL });
    pool = db.pool;
    await writeProcessHeartbeat(pool, { processKey: "web.1:c3-scale", catalogCodeVersion: 2 });
    await pool.query(`UPDATE dropship.dropship_catalog_code_versions SET first_seen_at = clock_timestamp() - interval '10 minutes'
      WHERE catalog_code_version = 2`);
  }, SCALE_CASE_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  it(`removes ${SCALE_PRODUCTS} products wholly (${SCALE_SIZES} ends) and adds them back (${SCALE_SIZES} supersedes), recording the timings`, async () => {
    const picked = Array.from({ length: SCALE_PRODUCTS }, (_, index) => SCALE_FIRST_SIZE + index * SCALE_SIZES_PER_PRODUCT);
    await seedPicks(pool, 60, picked);
    const h = saveHarness(pool);
    const measured: Record<string, number> = {};

    // The widened facts read alone, in the preview's snapshot: every size of the removed products with its listing.
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const started = performance.now();
      const facts = await readDropshipSelectionEffectsFacts(client, { vendorId: 60, productVariantIds: picked, removedIds: picked });
      measured.factsReadMs = performance.now() - started;
      expect(facts.candidates).toHaveLength(SCALE_SIZES);
      expect(facts.stores[0]!.listings).toHaveLength(SCALE_SIZES);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    const removal = { vendorId: 60, remove: picked };
    let started = performance.now();
    const preview = await previewSave(pool, h, removal);
    measured.previewRemoveMs = performance.now() - started;
    expect(preview).toMatchObject({ toRemove: SCALE_PRODUCTS, selectedAfter: 0, effects: [{ storeConnectionId: 160, ends: SCALE_SIZES,
      goesToZero: 0 }], ends: { hiddenRemovedIds: [], otherSizes: SCALE_SIZES - SCALE_PRODUCTS } });
    expect(preview.ends.listingIds).toHaveLength(SCALE_SIZES);

    let sampler = samplePublicationSelectionGate(pool);
    started = performance.now();
    const removed = await applySave(h, 60, saveBodyOf(removal, preview));
    measured.saveRemoveMs = performance.now() - started;
    measured.gateHoldRemoveMs = publicationSelectionGateHoldMs(await sampler.stop());
    expect(removed.answer).toMatchObject({ toRemove: SCALE_PRODUCTS, drifted: false });
    expect((await pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE reason = 'product_removed')::int AS product_removed,
        bool_and(state = 'pending' AND selection_revision_id = $2) AS planned
      FROM dropship.dropship_listing_end_requests WHERE vendor_id = $1`, [60, removed.answer.revisionId])).rows)
      .toEqual([{ n: SCALE_SIZES, product_removed: SCALE_SIZES - SCALE_PRODUCTS, planned: true }]);
    expect(await pickCountOf(pool, removed.answer.revisionId)).toEqual({ pickCount: 0, picks: 0 });

    // Adding the same sizes back takes back every end: the removed sizes' own and their products' others.
    const addBack = { vendorId: 60, add: picked };
    started = performance.now();
    const addPreview = await previewSave(pool, h, addBack);
    measured.previewAddBackMs = performance.now() - started;
    expect(addPreview).toMatchObject({ toAdd: SCALE_PRODUCTS, ends: { listingIds: [], stillEnding: 0 } });
    sampler = samplePublicationSelectionGate(pool);
    started = performance.now();
    const added = await applySave(h, 60, saveBodyOf(addBack, addPreview));
    measured.saveSupersedeMs = performance.now() - started;
    measured.gateHoldSupersedeMs = publicationSelectionGateHoldMs(await sampler.stop());
    expect(added.answer).toMatchObject({ toAdd: SCALE_PRODUCTS, drifted: false });
    expect((await pool.query(`SELECT state, count(*)::int AS n FROM dropship.dropship_listing_end_requests WHERE vendor_id = 60
      GROUP BY state`)).rows).toEqual([{ state: "superseded", n: SCALE_SIZES }]);
    expect(await pickCountOf(pool, added.answer.revisionId)).toEqual({ pickCount: SCALE_PRODUCTS, picks: SCALE_PRODUCTS });

    const retries = h.logs.filter((line) => line.code === "dropship.selection.change_retry").length;
    // Recorded for BUILD-NOTES (PLAN-C v4.1 §13.2 TST-8, Risk 5).
    process.stdout.write(`[pg-record] picks save near the size bound: ${JSON.stringify({
      ...Object.fromEntries(Object.entries(measured).map(([key, value]) => [key, Math.round(value)])), retries,
      sizes: SCALE_SIZES, queuedItems: SCALE_QUEUED_ITEMS })}\n`);
    expect(retries).toBe(0);
  }, SCALE_CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------------------------------
// C4: the end worker on real rows (PLAN-C v4.1 §5, §13.2): the real claim, the remote work's lock and the finish, with
// eBay stubbed (the provider port; never real eBay). Interleavings (a)-(f) and (h)-(j) run against the real claim here
// (interleaving (g) is the save's, above; the fence's own side of (a) and (b) is in the interplay suite).
// ---------------------------------------------------------------------------------------------------------------------

/** The worker's clock: after every fixture row's due time (LISTING_END_FIXTURE_AT). */
const WORKER_NOW = new Date("2026-10-26T09:00:00.000Z");
const WORKER_VENDOR = 70;
const OTHER_VENDOR = 71;
const CARD_SHELLZ_EBAY_CHANNEL = 900;
const VERIFIED_AT = "2026-10-01T00:00:00.000Z";
/** The claim's lock timeout (dropship-listing-end.repository.ts LOCK_TIMEOUT_SQL), plus room to see it pass. */
const CLAIM_LOCK_TIMEOUT_MS = 2_000;

/**
 * Card Shellz's catalog for the worker cases (every size enrolled; a catalog include rule, so every visible size is
 * listable): 7001 sizes 70011-70016; 7002 sizes 70021 (visible) and 70022 (does not ship: hidden); 7003 size 70031 (the
 * "another product" a save picks meanwhile); 7004 size 70041, product `archived` (retirement's). Vendors 70 and 71; a
 * Card Shellz eBay channel 900. Stores and listings are seeded per case, each store on an eBay account of its own, so
 * no case's listing shares an account with another case's (the shared-listing guard reads every listing of an account).
 */
const WORKER_SEED_SQL = `
  -- What the worker reads beyond PR B's schema: the store's verified account columns (0657's shapes) and, reduced to the
  -- columns marketplace-listings' destination reader joins, Card Shellz's eBay tokens (that module's fixtures' shape).
  ALTER TABLE dropship.dropship_store_connections ADD COLUMN external_account_identity_scheme varchar(40),
    ADD COLUMN external_account_verified_at timestamptz;
  CREATE TABLE ebay.ebay_oauth_tokens (channel_id integer NOT NULL REFERENCES channels.channels(id), environment text NOT NULL,
    external_account_id text);
  -- What the picks save reads beyond the picks schema (as the save cases above).
  CREATE TABLE catalog.product_categories (id integer PRIMARY KEY, name varchar(100) NOT NULL);
  ALTER TABLE catalog.product_variants ADD COLUMN position integer NOT NULL DEFAULT 0;
  INSERT INTO catalog.products (id, sku, name, category, is_active, status, product_type, ebay_listing_excluded) VALUES
    (7001, 'P-7001', 'Product 7001', 'Supplies', true, 'active', 'sleeves', false),
    (7002, 'P-7002', 'Product 7002', 'Supplies', true, 'active', 'sleeves', false),
    (7003, 'P-7003', 'Product 7003', 'Supplies', true, 'active', 'sleeves', false),
    (7004, 'P-7004', 'Product 7004', 'Supplies', true, 'archived', 'sleeves', false);
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded)
    SELECT g, 7001, 'S-' || g, 'Size ' || g, 'pack', true, true, true, 'sellable', false FROM generate_series(70011, 70016) g;
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded) VALUES
    (70021, 7002, 'S-70021', 'Size 70021', 'pack', true, true, true, 'sellable', false),
    (70022, 7002, 'S-70022', 'Size 70022', 'pack', true, false, true, 'sellable', false),
    (70031, 7003, 'S-70031', 'Size 70031', 'pack', true, true, true, 'sellable', false),
    (70041, 7004, 'S-70041', 'Size 70041', 'pack', true, true, true, 'sellable', false);
  -- 7010-7012, ten sizes each (70100-70129): one store with thirty due ends (the per-store due rank, review WRK-1).
  INSERT INTO catalog.products (id, sku, name, category, is_active, status, product_type, ebay_listing_excluded)
    SELECT g, 'P-' || g, 'Product ' || g, 'Supplies', true, 'active', 'sleeves', false FROM generate_series(7010, 7012) g;
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded)
    SELECT g, g / 10, 'S-' || g, 'Size ' || g, 'pack', true, true, true, 'sellable', false FROM generate_series(70100, 70129) g;
  INSERT INTO dropship.dropship_catalog_rules (id, scope_type, action, product_line_id, product_id, product_variant_id, category,
    starts_at, ends_at, is_active, priority) OVERRIDING SYSTEM VALUE VALUES (1, 'catalog', 'include', NULL, NULL, NULL, NULL, NULL, NULL, true, 0);
  INSERT INTO inventory.publication_variant_mapping_heads (publication_target_id, product_variant_id, active_mapping_id)
    SELECT 1, id, id FROM catalog.product_variants;
  INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (${WORKER_VENDOR}, 'member-${WORKER_VENDOR}'), (${OTHER_VENDOR}, 'member-${OTHER_VENDOR}');
  INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions (vendor_id, idempotency_key, request_hash, actor_type, rule_count)
    VALUES (${WORKER_VENDOR}, 'fixture-worker:${WORKER_VENDOR}', repeat('0', 64), 'system', 0),
      (${OTHER_VENDOR}, 'fixture-worker:${OTHER_VENDOR}', repeat('0', 64), 'system', 0);
  INSERT INTO channels.channels (id, name, provider, type, status) VALUES (${CARD_SHELLZ_EBAY_CHANNEL}, 'Card Shellz eBay', 'eBay', 'marketplace', 'active');
`;

/** One Dropship eBay listing as the worker cases seed it, with the identity eBay knows it by. */
interface WorkerMember {
  vendorId: number;
  storeId: number;
  account: string;
  size: number;
  productId: number;
  listingId: number;
  listingExternalId: string | null;
  offerId: string | null;
  sku: string;
}

/** The inspection the shared registration observer answers for a member: published (ours, for sale) or withdrawn. */
function inspectionOf(member: WorkerMember, published: boolean): EbayListingInspection {
  const base = published ? publishedInspection() : unpublishedInspection();
  const providerAccount = { ...base.providerAccount, externalAccountId: member.account };
  const offer = published
    ? inspectedOffer({ sku: member.sku, offerId: member.offerId!, listingId: member.listingExternalId })
    : inspectedOffer({ sku: member.sku, offerId: member.offerId!, status: "UNPUBLISHED", listingId: null, listingStatus: null });
  return {
    ...base, providerAccount, skus: [{ sku: member.sku, inventoryItemExists: true, offers: [offer], issue: null }],
    publication: published
      ? { ...observedPublication({ listingId: member.listingExternalId!, sku: member.sku, offerId: member.offerId! }), providerAccount }
      : null,
    unpublishedTarget: published ? null : { groupKey: null, skus: [member.sku] },
  };
}

/** The retirement view's Dropship identity of a member (migration 900000013000018480001 :88-92), as retirement would lock it. */
function viewIdentityOf(member: WorkerMember): ListingMemberIdentity {
  return { destinationKind: "dropship_store_connection", connectionId: member.storeId, channelId: null, vendorId: member.vendorId,
    provider: "ebay", accountId: member.account, environment: "production", market: "EBAY_US", productId: member.productId,
    productVariantId: member.size, externalSku: member.sku, externalProductId: member.listingExternalId, externalVariantId: member.offerId,
    externalInventoryItemId: null, identityConflict: false };
}

/**
 * eBay and inventory planning behind the worker's provider port, scripted per case (never real eBay). Every call is
 * recorded in order; `holdInspect` makes the first inspect wait until released (a slow eBay read).
 */
class StubEbay implements DropshipListingEndProvider {
  readonly calls: string[] = [];
  inspections: EbayListingInspection[] = [];
  withdrawals: ListingEndWithdrawResult[] = [];
  /** Runs before each inspect (1-based call number): a write another process makes while eBay is being read. */
  beforeInspect: ((call: number) => Promise<void>) | null = null;
  private inspectCalls = 0;
  private held: { reached: () => void; gate: Promise<void> } | null = null;

  constructor(private readonly credential: ListingEndCredential) {}

  static for(member: WorkerMember): StubEbay {
    const stub = new StubEbay({ externalAccountId: member.account, externalAccountVerifiedAt: new Date(VERIFIED_AT), environment: "production",
      accessTokenRef: `access-${member.storeId}` });
    stub.inspections = [inspectionOf(member, true), inspectionOf(member, false)];
    return stub;
  }

  /** The first inspect waits for `release`; `reached` resolves once it started waiting. */
  holdInspect(): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.held = { reached, gate };
    return { reached: reachedPromise, release };
  }

  async loadCredential() {
    this.calls.push("credentials");
    return this.credential;
  }
  async inspect() {
    this.calls.push("inspect");
    this.inspectCalls += 1;
    if (this.beforeInspect) await this.beforeInspect(this.inspectCalls);
    const held = this.held;
    if (held) {
      this.held = null;
      held.reached();
      await held.gate;
    }
    const next = this.inspections.shift();
    if (!next) throw new Error("No inspection scripted.");
    return next;
  }
  async reconcile() {
    this.calls.push("reconcile");
    return { resolved: [], unresolved: [], busy: false };
  }
  async withdraw(input: { offerId: string }) {
    this.calls.push(`withdraw:${input.offerId}`);
    return this.withdrawals.shift() ?? { outcome: "ok" as const };
  }
  async recordAccessTokenRejection() {
    this.calls.push("record_token_rejection");
  }
}

/**
 * The pool, except that the first transaction's COMMIT waits until `release` is called: a repository's transaction is
 * held open after its writes (TST-4), as the interplay suite's helper.
 */
function poolHoldingFirstCommit(pool: Pool): { pool: Pool; reachedCommit: Promise<void>; release: () => void } {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reachedCommit = new Promise<void>((resolve) => { reached = resolve; });
  let held = false;
  const wrapped = {
    query: (text: string, values?: unknown[]) => pool.query(text, values),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: unknown, values?: unknown[]) => {
          if (text === "COMMIT" && !held) {
            held = true;
            reached();
            await gate;
          }
          return client.query(text as string, values);
        },
        release: (error?: Error) => client.release(error),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool: wrapped, reachedCommit, release };
}

interface WorkerEndRow { state: string; code: string | null; context: Record<string, unknown>; version: number; attempt_count: number;
  deferral_count: number; withdraw_call_count: number; withdraw_outcome: string | null; withdraw_requested_at: Date | null;
  withdraw_returned_at: Date | null; next_attempt_at: Date | null; decided_at: Date | null; ended_at: Date | null; resolved_identity: unknown }

describeDatabase.sequential("dropship listing end requests: the end worker (PostgreSQL)", () => {
  let db: ListingEndDatabase;
  let pool: Pool;
  let repository: PgDropshipListingEndRepository;
  let storeSeq = 0;
  const revisions = new Map<number, number>();

  beforeAll(async () => {
    db = await createListingEndDatabase({ seed: WORKER_SEED_SQL });
    pool = db.pool;
    repository = new PgDropshipListingEndRepository(pool);
    // Versions 2 and 3 first ran a day ago and no older process reports: the worker's gates (and the picks save's) are open.
    await pool.query(`INSERT INTO dropship.dropship_catalog_code_versions (catalog_code_version, first_seen_at)
      VALUES (2, clock_timestamp() - interval '1 day'), (3, clock_timestamp() - interval '1 day')`);
    for (const row of (await pool.query<{ id: number; vendor_id: number }>(
      "SELECT id, vendor_id FROM dropship.dropship_vendor_selection_rule_set_revisions")).rows) {
      revisions.set(row.vendor_id, row.id);
    }
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  // Every case starts with no end row and no picks: a tick reads every due row, and the breakers count every decided one.
  // No trigger fires on TRUNCATE (the table's triggers are INSERT and UPDATE ones), and nothing references the table.
  beforeEach(async () => {
    await pool.query("TRUNCATE dropship.dropship_listing_end_requests");
    await pool.query("DELETE FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = ANY($1::integer[])",
      [[WORKER_VENDOR, OTHER_VENDOR]]);
  });

  /** A connected, verified eBay store with a live listing config and a completed push job, on an account of its own. */
  async function seedStore(input: { vendorId?: number; account?: string; scheme?: string | null; verified?: boolean } = {}):
    Promise<{ storeId: number; vendorId: number; account: string; jobId: number }> {
    storeSeq += 1;
    const storeId = 800 + storeSeq;
    const vendorId = input.vendorId ?? WORKER_VENDOR;
    const account = input.account ?? `seller-${storeId}`;
    await pool.query(`INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, external_account_id,
        provider_environment, external_display_name, external_account_identity_scheme, external_account_verified_at)
      VALUES ($1, $2, 'ebay', 'connected', $3, 'production', $4, $5, $6)`,
    [storeId, vendorId, account, `Store ${storeId}`, input.scheme === undefined ? "provider_user_id" : input.scheme,
      input.verified === false ? null : VERIFIED_AT]);
    await pool.query(`INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode, inventory_mode, is_active)
      VALUES ($1, 'ebay', 'live', 'managed_quantity_sync', true)`, [storeId]);
    const jobId = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs
        (vendor_id, store_connection_id, status, idempotency_key, request_hash, requested_by)
      VALUES ($1, $2, 'completed', $3, 'hash', 'system') RETURNING id`, [vendorId, storeId, `worker-${storeId}`])).rows[0]!.id;
    return { storeId, vendorId, account, jobId };
  }

  /**
   * A live listing of a size with its eBay ids and the completed push that named its SKU (the claim's SKU source,
   * §5.4). `sku: null` leaves no completed push; ids default to `L-<store>-<size>` / `O-<store>-<size>`.
   */
  async function seedMember(store: { storeId: number; vendorId: number; account: string; jobId: number }, size: number, input: {
    listingExternalId?: string | null; offerId?: string | null; sku?: string | null; status?: string; issueCodes?: string[];
  } = {}): Promise<WorkerMember> {
    const listingExternalId = input.listingExternalId === undefined ? `L-${store.storeId}-${size}` : input.listingExternalId;
    const offerId = input.offerId === undefined ? `O-${store.storeId}-${size}` : input.offerId;
    // Dated before the worker's clock, not by the database's: the stock reader's "newer saved push" rule compares a
    // push's created_at with the listing's updated_at, which the finish writes from the worker's clock (review round:
    // with the defaults, every case went wrong once the wall clock passed WORKER_NOW).
    const listingId = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_vendor_listings
        (vendor_id, store_connection_id, product_variant_id, platform, external_listing_id, external_offer_id, status, marketplace_issue_codes,
          created_at, updated_at)
      VALUES ($1, $2, $3, 'ebay', $4, $5, $6, $7, $8, $8) RETURNING id`,
    [store.vendorId, store.storeId, size, listingExternalId, offerId, input.status ?? "active", input.issueCodes ?? [],
      LISTING_END_FIXTURE_AT])).rows[0]!.id;
    const sku = input.sku === undefined ? `S-${size}` : input.sku;
    if (sku !== null) {
      await pool.query(`INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id, product_variant_id, status, preview_hash, result,
          created_at, updated_at)
        VALUES ($1, $2, $3, 'completed', 'preview', $4::jsonb, $5, $5)`, [store.jobId, listingId, size, JSON.stringify({ listingIntent: {
        platform: "ebay", listingMode: "live", inventoryMode: "managed_quantity_sync", productVariantId: size, sku,
        marketplaceConfig: { marketplaceId: "EBAY_US" } } }), LISTING_END_FIXTURE_AT]);
    }
    return { vendorId: store.vendorId, storeId: store.storeId, account: store.account, size, productId: Math.floor(size / 10), listingId,
      listingExternalId, offerId, sku: sku ?? `S-${size}` };
  }

  /** The member's end request as the save writes it: the listing's ids and the store's account, frozen. */
  async function requestEnd(member: WorkerMember, overrides: Partial<ListingEndRequestRow> = {}): Promise<number> {
    const [id] = await insertListingEndRequests(pool, [{ vendorId: member.vendorId, storeConnectionId: member.storeId,
      listingId: member.listingId, productId: member.productId, productVariantId: member.size,
      selectionRevisionId: revisions.get(member.vendorId)!, requestedIdentity: { externalListingId: member.listingExternalId,
        externalOfferId: member.offerId, externalAccountId: member.account, providerEnvironment: "production" }, ...overrides }]);
    return id!;
  }

  async function endRow(id: number): Promise<WorkerEndRow> {
    return (await pool.query<WorkerEndRow>(`SELECT state, code, context, version, attempt_count, deferral_count, withdraw_call_count,
        withdraw_outcome, withdraw_requested_at, withdraw_returned_at, next_attempt_at, decided_at, ended_at, resolved_identity
      FROM dropship.dropship_listing_end_requests WHERE id = $1`, [id])).rows[0]!;
  }

  /** The due row as the tick reads it (readTickFacts), for the repository's claim and finish. */
  async function dueRow(id: number): Promise<ListingEndRow> {
    const entry = (await repository.readTickFacts(WORKER_NOW)).due.find((due) => due.kind === "row" && due.row.id === id);
    if (!entry || entry.kind !== "row") throw new Error(`End request ${id} is not due.`);
    return entry.row;
  }

  /** Claims a pending row to `ending` through the real claim and returns the ending row. */
  async function claimToEnding(id: number): Promise<ListingEndRow> {
    const claimed = await repository.claim({ row: await dueRow(id), now: WORKER_NOW });
    if (claimed.kind !== "decided" || claimed.decision.outcome !== "ending" || !claimed.row) {
      throw new Error(`Expected end request ${id} to be claimed; got ${JSON.stringify(claimed)}.`);
    }
    return claimed.row;
  }

  async function listingRow(id: number): Promise<{ status: string; external_listing_id: string | null; external_offer_id: string | null;
    marketplace_ended_at: Date | null; updated_at: Date }> {
    return (await pool.query(`SELECT status, external_listing_id, external_offer_id, marketplace_ended_at, updated_at
      FROM dropship.dropship_vendor_listings WHERE id = $1`, [id])).rows[0];
  }

  async function requestAudits(id: number): Promise<string[]> {
    return (await pool.query<{ event_type: string }>(`SELECT event_type FROM dropship.dropship_audit_events
      WHERE entity_type = 'dropship_listing_end_request' AND entity_id = $1 ORDER BY id`, [String(id)])).rows.map((row) => row.event_type);
  }

  async function listingEndedAudits(listingId: number): Promise<Array<{ actor_type: string; actor_id: string; payload: Record<string, unknown> }>> {
    return (await pool.query(`SELECT actor_type, actor_id, payload FROM dropship.dropship_audit_events
      WHERE entity_type = 'dropship_vendor_listing' AND entity_id = $1 AND event_type = 'listing_ended_by_card_shellz' ORDER BY id`,
    [String(listingId)])).rows;
  }

  async function stockOf(member: WorkerMember) {
    return (await readDropshipListingStockSelection(pool, { storeConnectionId: member.storeId, productId: member.productId,
      productVariantIds: [member.size], now: WORKER_NOW })).variants[0]!;
  }

  function worker(provider: DropshipListingEndProvider, input: { pool?: Pool; clock?: () => Date } = {}) {
    const logs: Array<{ level: string; action: string; fields: Record<string, unknown> }> = [];
    const log = (level: string) => (action: string, fields: Record<string, unknown>) => { logs.push({ level, action, fields }); };
    const service = new DropshipListingEndService({
      repository: input.pool ? new PgDropshipListingEndRepository(input.pool) : repository, provider,
      clock: { now: input.clock ?? (() => WORKER_NOW) }, timer: () => 0, dryRun: false,
      log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    });
    return { service, logs };
  }

  /** A transaction on its own connection that tries the remote-member lock as retirement's withMember does. */
  async function retirementTryLock(member: WorkerMember): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await tryLockListingMemberRemote(client, viewIdentityOf(member));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  async function addPick(vendorId: number, size: number): Promise<void> {
    // A version-2-style picks write (§5.4 b, interleaving d): no C save, so no end is superseded by it.
    await pool.query(`INSERT INTO dropship.dropship_vendor_selected_variants (vendor_id, product_variant_id, revision_id, source, selected_at)
      VALUES ($1, $2, $3, 'vendor', now())`, [vendorId, size, revisions.get(vendorId)!]);
  }

  it("ends a listing on real rows: claim, withdraw once, readback, finish; ids kept, no vendor end time, stock none", async () => {
    const store = await seedStore();
    const member = await seedMember(store, 70011);
    const id = await requestEnd(member);
    const ebay = StubEbay.for(member);
    const { service, logs } = worker(ebay);

    expect(await service.runTick()).toMatchObject({ outcome: "completed", gate: null, due: 1, claimed: 1, ended: 1, failed: 0, deferred: 0,
      retried: 0, skipped: 0 });
    expect(ebay.calls).toEqual(["credentials", "inspect", "reconcile", `withdraw:${member.offerId}`, "inspect"]);
    expect(await endRow(id)).toMatchObject({ state: "ended", code: null, version: 3, attempt_count: 1, withdraw_call_count: 1,
      withdraw_outcome: "ok", withdraw_requested_at: WORKER_NOW, withdraw_returned_at: WORKER_NOW, next_attempt_at: null,
      decided_at: WORKER_NOW, ended_at: WORKER_NOW, resolved_identity: viewIdentityOf(member) });
    // The listing is `ended` with its ids kept; marketplace_ended_at means "the vendor ended it" and stays NULL (SST).
    expect(await listingRow(member.listingId)).toEqual({ status: "ended", external_listing_id: member.listingExternalId,
      external_offer_id: member.offerId, marketplace_ended_at: null, updated_at: WORKER_NOW });
    expect(await requestAudits(id)).toEqual(["listing_end_started", "listing_end_withdraw_sent", "listing_end_withdraw_returned",
      "listing_end_ended"]);
    expect(await listingEndedAudits(member.listingId)).toEqual([{ actor_type: "system", actor_id: "dropship-listing-end-worker",
      payload: { listingId: member.listingId, endRequestId: id, productVariantId: member.size, externalOfferId: member.offerId,
        externalListingId: member.listingExternalId, before: { status: "active" }, after: { status: "ended" } } }]);
    // Nothing is published for an ended listing (§7): the stock reader answers `none`.
    expect(await stockOf(member)).toMatchObject({ productVariantId: member.size, action: "none", reason: "listing_ended" });
    expect(logs.filter((line) => line.level === "error" || line.level === "warn")).toEqual([]);
    // The remote-member lock went with the remote transaction; the next tick finds nothing due.
    expect(await retirementTryLock(member)).toBe(true);
    expect(await worker(ebay).service.runTick()).toMatchObject({ outcome: "completed", due: 0, claimed: 0, ended: 0 });
    expect(ebay.calls).toHaveLength(5);
  }, CASE_TIMEOUT_MS);

  it("refuses to finish a listing whose ids moved after the claim: IDENTITY_MISMATCH, the listing untouched", async () => {
    const member = await seedMember(await seedStore(), 70012);
    const id = await requestEnd(member);
    const ending = await claimToEnding(id);
    // A relink (sync-back) moved the offer between the claim and the finish.
    await pool.query("UPDATE dropship.dropship_vendor_listings SET external_offer_id = 'O-RELINKED' WHERE id = $1", [member.listingId]);
    expect(await repository.finish({ row: ending, identity: parseListingEndResolvedIdentity(ending.resolvedIdentity), verified: true,
      clock: () => WORKER_NOW })).toEqual({ kind: "identity_moved" });
    expect(await endRow(id)).toMatchObject({ state: "failed", code: "DROPSHIP_LISTING_END_IDENTITY_MISMATCH", version: 3, ended_at: null,
      decided_at: WORKER_NOW, context: expect.objectContaining({ reason: "listing_ids_moved_before_finish", requiresReview: true,
        lastCode: "DROPSHIP_LISTING_END_IDENTITY_MISMATCH" }) });
    expect(await listingRow(member.listingId)).toMatchObject({ status: "active", external_offer_id: "O-RELINKED" });
    expect(await requestAudits(id)).toEqual(["listing_end_started", "listing_end_failed"]);
    expect(await listingEndedAudits(member.listingId)).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("interleaving (j): a finish run twice at once writes the listing once and one audit row of each", async () => {
    const member = await seedMember(await seedStore(), 70013);
    const id = await requestEnd(member);
    const ending = await claimToEnding(id);
    const identity = parseListingEndResolvedIdentity(ending.resolvedIdentity);
    // The first finish holds its transaction open after its writes (TST-4 / review TST-3); the second must wait on the
    // request's row lock, not merely run after it.
    const held = poolHoldingFirstCommit(pool);
    const first = new PgDropshipListingEndRepository(held.pool).finish({ row: ending, identity, verified: true, clock: () => WORKER_NOW });
    try {
      await held.reachedCommit;
      const second = repository.finish({ row: ending, identity, verified: true, clock: () => WORKER_NOW });
      await waitUntil(async () => (await lockWaiter(pool, "SELECT id FROM dropship.dropship_listing_end_requests")) !== null,
        "the second finish to wait on the first's request lock");
      held.release();
      expect(await first).toEqual({ kind: "ended", listingWritten: true });
      expect(await second).toEqual({ kind: "moved" });
    } finally {
      held.release();
      await first.catch(() => undefined);
    }
    expect(await endRow(id)).toMatchObject({ state: "ended", version: 3 });
    expect(await listingEndedAudits(member.listingId)).toHaveLength(1);
    expect(await requestAudits(id)).toEqual(["listing_end_started", "listing_end_ended"]);
    // Once more, later: nothing is written again.
    expect(await repository.finish({ row: ending, identity, verified: true, clock: () => WORKER_NOW })).toEqual({ kind: "moved" });
    expect(await listingEndedAudits(member.listingId)).toHaveLength(1);
  }, CASE_TIMEOUT_MS);

  it("keeps a size re-picked while its end is `ending` at stock zero: the claimed end still goes on", async () => {
    const member = await seedMember(await seedStore(), 70014);
    const id = await requestEnd(member);
    await claimToEnding(id);
    await addPick(WORKER_VENDOR, member.size);
    expect(await stockOf(member)).toMatchObject({ productVariantId: member.size, action: "zero", reason: "listing_end_in_progress",
      listingSelected: true });
    expect(await endRow(id)).toMatchObject({ state: "ending", version: 2 });
  }, CASE_TIMEOUT_MS);

  it("holds only the remote-member lock across eBay: retirement's try-lock fails, rows stay unlocked, a save of another product and the shared 918419 lock go through", async () => {
    const member = await seedMember(await seedStore(), 70015);
    const id = await requestEnd(member);
    const ebay = StubEbay.for(member);
    const inspect = ebay.holdInspect();
    const ticking = worker(ebay).service.runTick();
    try {
      await inspect.reached;
      // The worker is inside eBay's first read, holding the remote-member lock on a pinned transaction of its own.
      expect(await retirementTryLock(member)).toBe(false);
      // No row lock is held across the call: the request, the listing and the store are free to lock without waiting.
      const probe = await pool.connect();
      try {
        await probe.query("BEGIN");
        await probe.query("SELECT id FROM dropship.dropship_listing_end_requests WHERE id = $1 FOR UPDATE NOWAIT", [id]);
        await probe.query("SELECT id FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE NOWAIT", [member.listingId]);
        await probe.query("SELECT id FROM dropship.dropship_store_connections WHERE id = $1 FOR UPDATE NOWAIT", [member.storeId]);
        // The publication selection gate's shared side (0743) is free: picks writes are not held up.
        expect((await probe.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock_shared(918419, 0) AS locked")).rows)
          .toEqual([{ locked: true }]);
      } finally {
        await probe.query("ROLLBACK").catch(() => undefined);
        probe.release();
      }
      // Another vendor's picks save of another product commits meanwhile, without waiting on the remote transaction.
      const h = saveHarness(pool);
      const request = { vendorId: OTHER_VENDOR, add: [70031] };
      const saved = await Promise.race([
        previewSave(pool, h, request).then((preview) => applySave(h, OTHER_VENDOR, saveBodyOf(request, preview))),
        pause(10_000).then(() => { throw new Error("The picks save waited on the worker's remote transaction."); }),
      ]);
      expect(saved.idempotentReplay).toBe(false);
      expect((await pool.query("SELECT product_variant_id FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = $1",
        [OTHER_VENDOR])).rows).toEqual([{ product_variant_id: 70031 }]);
      expect(await endRow(id)).toMatchObject({ state: "ending", withdraw_requested_at: null });
    } finally {
      inspect.release();
    }
    expect(await ticking).toMatchObject({ outcome: "completed", claimed: 1, ended: 1 });
    expect(await endRow(id)).toMatchObject({ state: "ended" });
    expect(await retirementTryLock(member)).toBe(true);
  }, CASE_TIMEOUT_MS);

  it("claims nothing while version 3 settles or a version-2 process still reports, and claims once both pass (§5.2)", async () => {
    const member = await seedMember(await seedStore(), 70016);
    const id = await requestEnd(member);
    const ebay = StubEbay.for(member);
    const untouched = await endRow(id);
    try {
      // Version 3 first seen just now (< 300 s): the worker waits.
      await pool.query("UPDATE dropship.dropship_catalog_code_versions SET first_seen_at = clock_timestamp() WHERE catalog_code_version = 3");
      expect(await worker(ebay).service.runTick()).toMatchObject({ outcome: "gated", gate: "version_settling", due: 0, claimed: 0 });
      expect(await endRow(id)).toEqual(untouched);
      // Version 3 settled, but a version-2 process reported just now: the worker waits.
      await pool.query(`UPDATE dropship.dropship_catalog_code_versions SET first_seen_at = clock_timestamp() - interval '1 day'
        WHERE catalog_code_version = 3`);
      await writeProcessHeartbeat(pool, { processKey: "web.1:c4-older", catalogCodeVersion: 2 });
      const gated = worker(ebay);
      expect(await gated.service.runTick()).toMatchObject({ outcome: "gated", gate: "older_process", due: 0, claimed: 0 });
      expect(gated.logs).toEqual([{ level: "debug", action: "dropship.listing_end.gate_closed", fields: { outcome: "skipped", gate: "older_process" } }]);
      expect(await endRow(id)).toEqual(untouched);
      expect(ebay.calls).toEqual([]);
      // The version-2 process stopped reporting past the grace: the next tick claims and ends.
      await pool.query(`UPDATE dropship.dropship_process_heartbeats SET last_seen_at = clock_timestamp() - interval '10 minutes'
        WHERE process_key = 'web.1:c4-older'`);
      expect(await worker(ebay).service.runTick()).toMatchObject({ outcome: "completed", gate: null, claimed: 1, ended: 1 });
      expect(await endRow(id)).toMatchObject({ state: "ended" });
    } finally {
      await pool.query("DELETE FROM dropship.dropship_process_heartbeats WHERE process_key = 'web.1:c4-older'");
      await pool.query(`UPDATE dropship.dropship_catalog_code_versions SET first_seen_at = clock_timestamp() - interval '1 day'
        WHERE catalog_code_version = 3`);
    }
  }, CASE_TIMEOUT_MS);

  it("reads the breakers, the canary and the caps from real rows, and a tick claims nothing they hold back (§5.3)", async () => {
    const decided = (minutesAgo: number) => new Date(WORKER_NOW.getTime() - minutesAgo * 60_000).toISOString();
    // Store A: its three newest decided ends failed an hour ago (the store breaker is open for 6 h).
    const storeA = await seedStore();
    const failedA = await Promise.all([70011, 70012, 70013].map((size) => seedMember(storeA, size)));
    for (const member of failedA) await requestEnd(member, { state: "failed", code: "DROPSHIP_LISTING_END_REJECTED", decidedAt: decided(60) });
    const pendingA = await requestEnd(await seedMember(storeA, 70014));
    // Store B: no verified end yet (the canary) and one end `ending`, not due.
    const storeB = await seedStore();
    const endingB = await seedMember(storeB, 70011);
    await requestEnd(endingB, { state: "ending", resolvedIdentity: viewIdentityOf(endingB), nextAttemptAt: "2026-10-27T00:00:00.000Z" });
    const pendingB = await requestEnd(await seedMember(storeB, 70012));
    // Store C: 600 withdraw calls in the last hour (verified ends, so the canary is closed): its hourly cap is used up.
    const storeC = await seedStore();
    const calledC = await seedMember(storeC, 70011);
    await insertListingEndRequests(pool, Array.from({ length: 600 }, (): ListingEndRequestRow => ({ vendorId: WORKER_VENDOR,
      storeConnectionId: storeC.storeId, listingId: calledC.listingId, productId: calledC.productId, productVariantId: calledC.size,
      selectionRevisionId: revisions.get(WORKER_VENDOR)!, state: "ended", withdrawCallCount: 1, withdrawRequestedAt: decided(10),
      withdrawReturnedAt: decided(10), withdrawOutcome: "ok", decidedAt: decided(10), endedAt: decided(10) })));
    const pendingC = await requestEnd(await seedMember(storeC, 70012));

    const facts = await repository.readTickFacts(WORKER_NOW);
    expect(facts.due.map((entry) => entry.kind === "row" ? entry.row.id : -1).sort((left, right) => left - right))
      .toEqual([pendingA, pendingB, pendingC]);
    const storeFacts = (storeId: number) => facts.stores.find((store) => store.storeConnectionId === storeId)!;
    expect(storeFacts(storeA.storeId)).toMatchObject({ newestDecided: [{ state: "failed" }, { state: "failed" }, { state: "failed" }],
      hasVerifiedEnd: false, endingCount: 0, callsInWindow: 0 });
    expect(storeFacts(storeB.storeId)).toMatchObject({ newestDecided: [], hasVerifiedEnd: false, endingCount: 1, callsInWindow: 0 });
    expect(storeFacts(storeC.storeId)).toMatchObject({ hasVerifiedEnd: true, endingCount: 0, callsInWindow: 600,
      oldestCallInWindowAt: new Date(decided(10)) });
    expect(facts.global).toEqual({ failuresInWindow: 0, failuresInTwoWindows: 3, newestFailureAt: new Date(decided(60)),
      verifiedEndSinceNewestFailure: true, callsInWindow: 600, oldestCallInWindowAt: new Date(decided(10)) });
    const counters = { claims: 0, claimsByStore: new Map(), endingByStore: new Map(), verifiedStores: new Set<number>(), callsByStore: new Map(),
      calls: 0 };
    const actionOf = (id: number) => {
      const entry = facts.due.find((due) => due.kind === "row" && due.row.id === id);
      if (!entry || entry.kind !== "row") throw new Error("not due");
      return decideDueRowAction({ row: entry.row, store: storeFacts(entry.row.storeConnectionId), global: facts.global, counters, now: WORKER_NOW });
    };
    expect([actionOf(pendingA), actionOf(pendingB), actionOf(pendingC)]).toEqual([{ action: "skip", reason: "breaker_open" },
      { action: "skip", reason: "one_at_a_time" }, { action: "skip", reason: "cap" }]);
    // A tick leaves all three as they were: nothing claimed, nothing written, eBay never called.
    const before = await Promise.all([pendingA, pendingB, pendingC].map(endRow));
    const ebay = StubEbay.for(endingB);
    expect(await worker(ebay).service.runTick()).toMatchObject({ outcome: "completed", due: 3, claimed: 0, skipped: 3, deferred: 0 });
    expect(await Promise.all([pendingA, pendingB, pendingC].map(endRow))).toEqual(before);
    expect(ebay.calls).toEqual([]);

    // Ten failures in the last hour on another store: the global breaker opens and holds back every store.
    const storeD = await seedStore();
    for (const size of [70011, 70012, 70013, 70014, 70015, 70016, 70021, 70022, 70031, 70041]) {
      await requestEnd(await seedMember(storeD, size), { state: "failed", code: "DROPSHIP_LISTING_END_REJECTED", decidedAt: decided(5) });
    }
    const storeE = await seedStore();
    const pendingE = await requestEnd(await seedMember(storeE, 70011));
    const afterTrip = await repository.readTickFacts(WORKER_NOW);
    expect(afterTrip.global).toMatchObject({ failuresInWindow: 10, failuresInTwoWindows: 13, newestFailureAt: new Date(decided(5)),
      verifiedEndSinceNewestFailure: false });
    const dueE = afterTrip.due.find((due) => due.kind === "row" && due.row.id === pendingE);
    if (!dueE || dueE.kind !== "row") throw new Error("not due");
    expect(decideDueRowAction({ row: dueE.row, store: afterTrip.stores.find((store) => store.storeConnectionId === storeE.storeId)!,
      global: afterTrip.global, counters, now: WORKER_NOW })).toEqual({ action: "skip", reason: "breaker_open" });

    // The plans: with sequential scans priced out, every read of the end table the tick makes can be served by one of
    // the migration's indexes (§3); which one the planner picks depends on the table's size (BUILD-NOTES C4 records them).
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const recording = { connect: () => pool.connect(), query: (text: string, values: unknown[] = []) => {
      statements.push({ text, values });
      return pool.query(text, values);
    } } as unknown as Pool;
    await new PgDropshipListingEndRepository(recording).readTickFacts(WORKER_NOW);
    expect(statements).toHaveLength(3);
    const planOf = async (statement: { text: string; values: unknown[] }): Promise<string> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off");
        return (await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${statement.text}`, statement.values)).rows
          .map((row) => row["QUERY PLAN"]).join("\n");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    };
    const plans = await Promise.all(statements.map(planOf));
    for (const plan of plans) {
      expect(plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
      expect(plan).not.toMatch(/Seq Scan on dropship_listing_end_requests/);
    }
  }, CASE_TIMEOUT_MS);

  it("claims by the table of §5.4 on real rows: archived, nothing listed, an unsettled send (e), each identity issue (h), a changed account (i)", async () => {
    const store = await seedStore();
    const claimOf = async (id: number) => repository.claim({ row: await dueRow(id), now: WORKER_NOW });
    // (a) An archived size is retirement's: superseded before the listing is locked.
    const archived = await requestEnd(await seedMember(store, 70041));
    expect(await claimOf(archived)).toMatchObject({ kind: "decided", decision: { outcome: "superseded", code: "DROPSHIP_LISTING_END_ARCHIVED" } });
    // (e) No ids and no send pending: nothing to end. No ids but a send attempted after the newest completed push: a person decides.
    const nothing = await requestEnd(await seedMember(store, 70011, { listingExternalId: null, offerId: null, sku: null }));
    expect(await claimOf(nothing)).toMatchObject({ kind: "decided", decision: { outcome: "superseded", code: "DROPSHIP_LISTING_END_NOTHING_LISTED" } });
    const unsettled = await seedMember(store, 70012, { listingExternalId: null, offerId: null, sku: null });
    await pool.query(`INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type, source, payload, created_at)
      VALUES ($1, 'listing_push_attempted', 'push', '{}'::jsonb, $2)`, [unsettled.listingId, WORKER_NOW]);
    const unsettledId = await requestEnd(unsettled);
    expect(await claimOf(unsettledId)).toMatchObject({ kind: "decided", decision: { outcome: "failed",
      code: "DROPSHIP_LISTING_END_IDENTITY_MISSING", context: { reason: "unsettled_push_attempt" } } });
    expect(await endRow(unsettledId)).toMatchObject({ state: "failed", code: "DROPSHIP_LISTING_END_IDENTITY_MISSING", version: 2,
      context: expect.objectContaining({ reason: "unsettled_push_attempt", requiresReview: true }) });
    expect(await requestAudits(unsettledId)).toEqual(["listing_end_failed"]);
    // (h) Each issue code that means sync-back cannot prove the live offer is this SKU's.
    const issueSizes = [70013, 70014, 70015, 70016, 70021];
    for (const [index, issue] of ["sku_changed", "offer_missing", "variation_listing_unsupported", "observation_unreadable",
      "sync_requires_review"].entries()) {
      const id = await requestEnd(await seedMember(store, issueSizes[index]!, { issueCodes: [issue, "ended_out_of_stock"] }));
      expect(await claimOf(id), issue).toMatchObject({ kind: "decided", decision: { outcome: "failed",
        code: "DROPSHIP_LISTING_END_IDENTITY_MISMATCH", context: { issueCodes: [issue] } } });
    }
    // (i) The store's account changed since the save froze it: never ended on the new account (B9).
    const moved = await seedStore();
    const movedMember = await seedMember(moved, 70011);
    const movedId = await requestEnd(movedMember, { requestedIdentity: { externalListingId: movedMember.listingExternalId,
      externalOfferId: movedMember.offerId, externalAccountId: "seller-before", providerEnvironment: "production" } });
    expect(await claimOf(movedId)).toMatchObject({ kind: "decided", decision: { outcome: "failed", code: "DROPSHIP_LISTING_END_ACCOUNT_CHANGED",
      context: { reason: "store_account_changed_since_save" } } });
    // The store not connected waits (a deferral, no attempt), and so does an unverified account.
    const unverified = await seedStore({ verified: false });
    const unverifiedId = await requestEnd(await seedMember(unverified, 70011));
    expect(await claimOf(unverifiedId)).toMatchObject({ kind: "decided", decision: { outcome: "deferred",
      code: "DROPSHIP_LISTING_END_STORE_ACCOUNT_UNVERIFIED" } });
    expect(await endRow(unverifiedId)).toMatchObject({ state: "pending", version: 1, attempt_count: 0, deferral_count: 1,
      code: "DROPSHIP_LISTING_END_STORE_ACCOUNT_UNVERIFIED", next_attempt_at: new Date(WORKER_NOW.getTime() + 6 * 60 * 60 * 1000) });
  }, CASE_TIMEOUT_MS);

  it("never ends a shared listing (SAF-4): same store by offer, listing id or SKU; another Dropship store on the account; a Card Shellz channel", async () => {
    const claimOf = async (id: number) => repository.claim({ row: await dueRow(id), now: WORKER_NOW });
    const sharedWith = async (id: number) => {
      const claimed = await claimOf(id);
      if (claimed.kind !== "decided") return claimed.kind;
      return claimed.decision.outcome === "failed" ? `${claimed.decision.code}:${String(claimed.decision.context.sharedWith)}`
        : claimed.decision.outcome;
    };
    // The same store: another size's listing with the same offer id, the same listing id, or the push SKU as its size's SKU.
    const same = await seedStore();
    const byOffer = await seedMember(same, 70011);
    await seedMember(same, 70012, { offerId: byOffer.offerId });
    expect(await sharedWith(await requestEnd(byOffer))).toBe("DROPSHIP_LISTING_END_SHARED_LISTING:dropship_listing");
    const byListing = await seedMember(same, 70013);
    await seedMember(same, 70014, { listingExternalId: byListing.listingExternalId });
    expect(await sharedWith(await requestEnd(byListing))).toBe("DROPSHIP_LISTING_END_SHARED_LISTING:dropship_listing");
    const bySku = await seedMember(same, 70015, { sku: " s-70016 " });
    await seedMember(same, 70016);
    expect(await sharedWith(await requestEnd(bySku))).toBe("DROPSHIP_LISTING_END_SHARED_LISTING:dropship_listing");
    // Another Dropship store (another vendor's) on the same account, with no identity scheme: the same size listed there.
    const own = await seedStore();
    const onAccount = await seedMember(own, 70011);
    await seedMember(await seedStore({ vendorId: OTHER_VENDOR, account: own.account, scheme: null }), 70011);
    expect(await sharedWith(await requestEnd(onAccount))).toBe("DROPSHIP_LISTING_END_SHARED_LISTING:dropship_listing");
    // A Card Shellz eBay channel with a token on the account (QC2 default a), the account as the token spells it with spaces.
    const channelStore = await seedStore();
    const channelMember = await seedMember(channelStore, 70011);
    await pool.query(`INSERT INTO ebay.ebay_oauth_tokens (channel_id, environment, external_account_id) VALUES ($1, 'production', $2)`,
      [CARD_SHELLZ_EBAY_CHANNEL, ` ${channelStore.account} `]);
    expect(await sharedWith(await requestEnd(channelMember))).toBe("DROPSHIP_LISTING_END_SHARED_LISTING:card_shellz_channel");
    // Shared with nothing: the same ids on another account, an ended listing of the size on the account, and a token of
    // the account in the other environment.
    const alone = await seedStore();
    const aloneMember = await seedMember(alone, 70011);
    await seedMember(await seedStore(), 70012, { offerId: aloneMember.offerId, listingExternalId: aloneMember.listingExternalId });
    await seedMember(await seedStore({ vendorId: OTHER_VENDOR, account: alone.account }), 70011, { status: "ended" });
    await pool.query(`INSERT INTO ebay.ebay_oauth_tokens (channel_id, environment, external_account_id) VALUES ($1, 'sandbox', $2)`,
      [CARD_SHELLZ_EBAY_CHANNEL, alone.account]);
    expect(await sharedWith(await requestEnd(aloneMember))).toBe("ending");
  }, CASE_TIMEOUT_MS);

  it("interleaving (a): the fence's start holds the listing; the real claim waits for it, then sees the push processing and defers", async () => {
    const store = await seedStore();
    const member = await seedMember(store, 70011);
    const job = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs
        (vendor_id, store_connection_id, status, idempotency_key, request_hash, requested_by)
      VALUES ($1, $2, 'processing', $3, 'hash', 'system') RETURNING id`, [WORKER_VENDOR, store.storeId, `fence-${store.storeId}`])).rows[0]!.id;
    const item = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id,
        product_variant_id, status, preview_hash, result) VALUES ($1, $2, $3, 'queued', 'preview', '{}'::jsonb) RETURNING id`,
    [job, member.listingId, member.size])).rows[0]!.id;
    const held = poolHoldingFirstCommit(pool);
    const starting = new PgDropshipListingPushWorkerRepository(held.pool).markItemProcessing({ jobId: job, itemId: item, workerId: "worker-c4",
      now: WORKER_NOW });
    try {
      await held.reachedCommit;
      // The save's end insert goes through while the fence holds the listing FOR SHARE (a key share lock).
      const id = await requestEnd(member);
      const row = await dueRow(id);
      const claiming = repository.claim({ row, now: WORKER_NOW });
      await waitUntil(async () => (await lockWaiter(pool, 'SELECT status, marketplace_ended_at AS "marketplaceEndedAt"')) !== null,
        "the claim's listing lock to wait on the fence");
      held.release();
      expect(await starting).toBe("started");
      expect(await claiming).toMatchObject({ kind: "decided", decision: { outcome: "deferred", code: "DROPSHIP_LISTING_END_WAITING_FOR_PUSH" } });
      expect(await endRow(id)).toMatchObject({ state: "pending", version: 1, deferral_count: 1, attempt_count: 0,
        code: "DROPSHIP_LISTING_END_WAITING_FOR_PUSH", next_attempt_at: new Date(WORKER_NOW.getTime() + 60_000) });
    } finally {
      held.release();
      await starting.catch(() => undefined);
    }
  }, CASE_TIMEOUT_MS);

  it("interleaving (b): the real claim commits `ending` first; the fence waits on the listing, then refuses the item", async () => {
    const store = await seedStore();
    const member = await seedMember(store, 70012);
    const id = await requestEnd(member);
    const job = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs
        (vendor_id, store_connection_id, status, idempotency_key, request_hash, requested_by)
      VALUES ($1, $2, 'processing', $3, 'hash', 'system') RETURNING id`, [WORKER_VENDOR, store.storeId, `fence-${store.storeId}`])).rows[0]!.id;
    const item = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id,
        product_variant_id, status, preview_hash, result) VALUES ($1, $2, $3, 'queued', 'preview', '{}'::jsonb) RETURNING id`,
    [job, member.listingId, member.size])).rows[0]!.id;
    const held = poolHoldingFirstCommit(pool);
    const claiming = new PgDropshipListingEndRepository(held.pool).claim({ row: await dueRow(id), now: WORKER_NOW });
    try {
      await held.reachedCommit;
      const starting = new PgDropshipListingPushWorkerRepository(pool).markItemProcessing({ jobId: job, itemId: item, workerId: "worker-c4",
        now: WORKER_NOW });
      await waitUntil(async () => (await lockWaiter(pool, "SELECT 1 FROM dropship.dropship_vendor_listings WHERE id = $1 FOR SHARE")) !== null,
        "the fence's listing lock to wait on the claim");
      held.release();
      expect(await claiming).toMatchObject({ kind: "decided", decision: { outcome: "ending" } });
      expect(await starting).toBe("end_open");
      expect((await pool.query("SELECT status FROM dropship.dropship_listing_push_job_items WHERE id = $1", [item])).rows)
        .toEqual([{ status: "queued" }]);
    } finally {
      held.release();
      await claiming.catch(() => undefined);
    }
  }, CASE_TIMEOUT_MS);

  it("interleaving (c): a save that re-adds the size holds the vendor lock; the real claim waits, then finds the end superseded", async () => {
    const member = await seedMember(await seedStore(), 70013);
    const id = await requestEnd(member);
    const request = { vendorId: WORKER_VENDOR, add: [member.size] };
    const h = saveHarness(pool);
    const preview = await previewSave(pool, h, request);
    expect(preview.ends).toMatchObject({ stillEnding: 0 });
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reachedWrites = new Promise<void>((resolve) => { reached = resolve; });
    const real = new PgDropshipSelectionChangeRepository(pool);
    const holding = saveHarness(pool, {
      runPreview: (work) => real.runPreview(work),
      runChange: (input, work) => real.runChange(input, async (tx) => {
        const result = await work(tx);
        reached();
        await gate;
        return result;
      }),
    });
    const saving = applySave(holding, WORKER_VENDOR, saveBodyOf(request, preview));
    try {
      await reachedWrites;
      // The tick's reads are plain: they never wait on the save.
      const claiming = repository.claim({ row: await dueRow(id), now: WORKER_NOW });
      await waitUntil(async () => (await lockWaiter(pool, "SELECT pg_advisory_xact_lock(hashtext('dropship_vendor_selection_rules')")) !== null,
        "the claim's vendor lock to wait on the save");
      release();
      expect((await saving).idempotentReplay).toBe(false);
      expect(await claiming).toEqual({ kind: "moved" });
      expect(await endRow(id)).toMatchObject({ state: "superseded", code: LISTING_END_SUPERSEDED_BY_SELECTION, version: 2 });
      expect(await requestAudits(id)).toEqual(["listing_end_superseded"]);
    } finally {
      release();
      await saving.catch(() => undefined);
    }
  }, CASE_TIMEOUT_MS);

  it("interleaving (d): a re-pick without a C save (a version-2-style picks write) supersedes the end RE_PICKED; a hidden pick of the product does not", async () => {
    const store = await seedStore();
    const sized = await requestEnd(await seedMember(store, 70014));
    await addPick(WORKER_VENDOR, 70014);
    expect(await repository.claim({ row: await dueRow(sized), now: WORKER_NOW })).toMatchObject({ kind: "decided",
      decision: { outcome: "superseded", code: "DROPSHIP_LISTING_END_RE_PICKED" } });
    expect(await endRow(sized)).toMatchObject({ state: "superseded", code: "DROPSHIP_LISTING_END_RE_PICKED", version: 2 });
    expect(await requestAudits(sized)).toEqual(["listing_end_superseded"]);
    // A wholly removed product (§4.3): a pick of its hidden size is not a visible pick, so the end goes on ...
    await addPick(WORKER_VENDOR, 70022);
    const hiddenOnly = await requestEnd(await seedMember(store, 70021), { reason: "product_removed" });
    expect(await repository.claim({ row: await dueRow(hiddenOnly), now: WORKER_NOW })).toMatchObject({ kind: "decided",
      decision: { outcome: "ending" } });
    // ... and a pick of a visible size of the product supersedes it.
    await addPick(WORKER_VENDOR, 70021);
    const visible = await requestEnd(await seedMember(await seedStore(), 70021), { reason: "product_removed" });
    expect(await repository.claim({ row: await dueRow(visible), now: WORKER_NOW })).toMatchObject({ kind: "decided",
      decision: { outcome: "superseded", code: "DROPSHIP_LISTING_END_RE_PICKED" } });
  }, CASE_TIMEOUT_MS);

  it("interleaving (e): a staff Retry of a failed end after a re-pick is superseded by the claim, and eBay is never called", async () => {
    const member = await seedMember(await seedStore(), 70015);
    // The row as a staff Retry leaves it (C5 writes it; here a fixture): pending again, due, with its staff action and key.
    const id = await requestEnd(member, { state: "pending", code: "DROPSHIP_LISTING_END_REJECTED", staffAction: "retry",
      staffActionKey: "staff-retry:c4", attemptCount: 2, version: 3 });
    await addPick(WORKER_VENDOR, member.size);
    const ebay = StubEbay.for(member);
    expect(await worker(ebay).service.runTick()).toMatchObject({ outcome: "completed", claimed: 0, superseded: 1 });
    expect(ebay.calls).toEqual([]);
    expect(await endRow(id)).toMatchObject({ state: "superseded", code: "DROPSHIP_LISTING_END_RE_PICKED", withdraw_call_count: 0 });
  }, CASE_TIMEOUT_MS);

  it("interleaving (f): the claim first; a save that re-adds the size reports it still ending and leaves the end alone", async () => {
    const member = await seedMember(await seedStore(), 70016);
    const id = await requestEnd(member);
    await claimToEnding(id);
    const h = saveHarness(pool);
    const request = { vendorId: WORKER_VENDOR, add: [member.size] };
    const preview = await previewSave(pool, h, request);
    expect(preview.ends).toMatchObject({ stillEnding: 1 });
    const saved = await applySave(h, WORKER_VENDOR, saveBodyOf(request, preview));
    expect(saved.answer.ends).toMatchObject({ stillEnding: 1 });
    expect(await endRow(id)).toMatchObject({ state: "ending", version: 2 });
    // The size is picked again, and its listing stays at zero until the end finishes (§7).
    expect(await stockOf(member)).toMatchObject({ action: "zero", reason: "listing_end_in_progress" });
  }, CASE_TIMEOUT_MS);

  it("interleaving (h): retirement holding the listing FOR SHARE past the lock timeout: the claim defers LOCK_BUSY and the tick goes on", async () => {
    const member = await seedMember(await seedStore(), 70011);
    const id = await requestEnd(member);
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM dropship.dropship_vendor_listings WHERE id = $1 FOR SHARE", [member.listingId]);
      const ebay = StubEbay.for(member);
      const started = performance.now();
      const { service, logs } = worker(ebay);
      expect(await service.runTick()).toMatchObject({ outcome: "completed", due: 1, claimed: 0, deferred: 1, failed: 0 });
      expect(performance.now() - started).toBeGreaterThanOrEqual(CLAIM_LOCK_TIMEOUT_MS - 100);
      expect(ebay.calls).toEqual([]);
      expect(await endRow(id)).toMatchObject({ state: "pending", version: 1, attempt_count: 0, deferral_count: 1,
        code: "DROPSHIP_LISTING_END_LOCK_BUSY", next_attempt_at: new Date(WORKER_NOW.getTime() + 60_000) });
      expect(await requestAudits(id)).toEqual(["listing_end_deferred"]);
      expect(logs.filter((line) => line.level === "error")).toEqual([]);
      expect(logs.find((line) => line.action === "dropship.listing_end.deferred")?.fields).toMatchObject({
        code: "DROPSHIP_LISTING_END_LOCK_BUSY", detail: { causeCode: "55P03" } });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }, CASE_TIMEOUT_MS);

  it("interleaving (i): two claims of one request at once: one `ending`, one stopped by the version guard", async () => {
    const member = await seedMember(await seedStore(), 70012);
    const id = await requestEnd(member);
    const row = await dueRow(id);
    // The first claim holds its transaction open after writing `ending` (review TST-3): the second must wait on the
    // vendor's selection lock the first holds, then find the request moved.
    const held = poolHoldingFirstCommit(pool);
    const first = new PgDropshipListingEndRepository(held.pool).claim({ row, now: WORKER_NOW });
    try {
      await held.reachedCommit;
      const second = repository.claim({ row, now: WORKER_NOW });
      await waitUntil(async () => (await lockWaiter(pool, "SELECT pg_advisory_xact_lock(hashtext('dropship_vendor_selection_rules')")) !== null,
        "the second claim to wait on the first's vendor lock");
      held.release();
      expect(await first).toMatchObject({ kind: "decided", decision: { outcome: "ending" } });
      expect(await second).toEqual({ kind: "moved" });
    } finally {
      held.release();
      await first.catch(() => undefined);
    }
    expect(await endRow(id)).toMatchObject({ state: "ending", version: 2, attempt_count: 1 });
    expect(await requestAudits(id)).toEqual(["listing_end_started"]);
  }, CASE_TIMEOUT_MS);

  // -------------------------------------------------------------------------------------------------------------------
  // Review round (server): each case was written first and shown red against b73f62360 (BUILD-NOTES "Review round").

  it("review WRK-1/TST-2: reads at most 25 due rows a store, an `ending` row first, and another store's row too", async () => {
    const storeA = await seedStore();
    const members = [];
    for (let size = 70100; size < 70130; size += 1) members.push(await seedMember(storeA, size));
    const pendingA = [];
    for (const member of members) pendingA.push(await requestEnd(member));
    // An `ending` row of store A whose verify was put off (READBACK_PENDING): due, but later than every pending row.
    const endingMember = await seedMember(storeA, 70011);
    const endingId = await requestEnd(endingMember, { state: "ending", resolvedIdentity: viewIdentityOf(endingMember), attemptCount: 2,
      withdrawCallCount: 1, withdrawRequestedAt: new Date(WORKER_NOW.getTime() - 120_000).toISOString(),
      withdrawReturnedAt: new Date(WORKER_NOW.getTime() - 119_000).toISOString(), withdrawOutcome: "ok",
      code: "DROPSHIP_LISTING_END_READBACK_PENDING", nextAttemptAt: new Date(WORKER_NOW.getTime() - 60_000).toISOString() });
    const pendingB = await requestEnd(await seedMember(await seedStore(), 70011));

    const facts = await repository.readTickFacts(WORKER_NOW);
    const ids = facts.due.map((entry) => (entry.kind === "row" ? entry.row.id : -1));
    const ofA = facts.due.filter((entry) => entry.kind === "row" && entry.row.storeConnectionId === storeA.storeId);
    expect(ofA).toHaveLength(25);
    expect(ids).toContain(endingId);
    expect(ids).toContain(pendingB);
    // The `ending` row is worked first: with it the store's canary has an open end, and it is the one that can finish.
    expect(ids[0]).toBe(endingId);
    expect(pendingA.filter((id) => ids.includes(id))).toHaveLength(24);
    // A tick verifies and finishes it first (verify only: its withdraw went through), so it is never starved.
    const ebay = StubEbay.for(endingMember);
    ebay.inspections = [inspectionOf(endingMember, false)];
    await worker(ebay).service.runTick();
    expect(ebay.calls.slice(0, 2)).toEqual(["credentials", "inspect"]);
    expect(await endRow(endingId)).toMatchObject({ state: "ended", code: null, withdraw_call_count: 1 });
  }, CASE_TIMEOUT_MS);

  it("review WRK-3: a listing that took the claimed end's offer after the claim stops the send (SHARED_LISTING), eBay never withdrawn", async () => {
    const store = await seedStore();
    const member = await seedMember(store, 70014);
    const id = await requestEnd(member);
    await claimToEnding(id);
    // Another size of the store now carries the same offer (a push of a size without its own SKU adopted it).
    await seedMember(store, 70015, { offerId: member.offerId, listingExternalId: member.listingExternalId });
    const ebay = StubEbay.for(member);
    expect(await worker(ebay).service.runTick()).toMatchObject({ outcome: "completed", failed: 1, ended: 0 });
    expect(ebay.calls.filter((call) => call.startsWith("withdraw:"))).toEqual([]);
    expect(await endRow(id)).toMatchObject({ state: "failed", code: "DROPSHIP_LISTING_END_SHARED_LISTING", withdraw_call_count: 0,
      context: expect.objectContaining({ sharedWith: "dropship_listing", stage: "before_withdraw", requiresReview: true }) });
    expect(await listingRow(member.listingId)).toMatchObject({ status: "active" });
  }, CASE_TIMEOUT_MS);

  it("review WRK-6: a finish that withdrew nothing (NOT_PUBLISHED_ON_EBAY) never closes a half-open store breaker; a verified end does", async () => {
    const decided = (minutesAgo: number) => new Date(WORKER_NOW.getTime() - minutesAgo * 60_000).toISOString();
    const store = await seedStore();
    for (const size of [70011, 70012, 70013]) {
      await requestEnd(await seedMember(store, size), { state: "failed", code: "DROPSHIP_LISTING_END_REJECTED", decidedAt: decided(7 * 60) });
    }
    await requestEnd(await seedMember(store, 70014), { state: "ended", code: "DROPSHIP_LISTING_END_NOT_PUBLISHED_ON_EBAY", decidedAt: decided(60),
      endedAt: decided(60) });
    await requestEnd(await seedMember(store, 70015));
    const storeFacts = async () => (await repository.readTickFacts(WORKER_NOW)).stores.find((entry) => entry.storeConnectionId === store.storeId)!;
    const half = await storeFacts();
    expect(half.newestDecided.map((entry) => entry.state)).toEqual(["failed", "failed", "failed"]);
    expect(decideStoreBreaker(half, WORKER_NOW)).toEqual({ state: "half_open" });
    await requestEnd(await seedMember(store, 70016), { state: "ended", decidedAt: decided(30), endedAt: decided(30), withdrawCallCount: 1,
      withdrawRequestedAt: decided(31), withdrawReturnedAt: decided(31), withdrawOutcome: "ok" });
    const closed = await storeFacts();
    expect(closed.newestDecided[0]).toMatchObject({ state: "ended" });
    expect(decideStoreBreaker(closed, WORKER_NOW)).toEqual({ state: "closed" });
  }, CASE_TIMEOUT_MS);

  it("review WRK-7: a stale copy of an `ending` row never sends a second withdraw once another tick's went through", async () => {
    const member = await seedMember(await seedStore(), 70016);
    const id = await requestEnd(member);
    const stale = await claimToEnding(id);
    // Tick A: sent and returned ok (its verify then read published: READBACK_PENDING, the version unchanged).
    const sentAt = new Date(WORKER_NOW.getTime() + 1_000);
    expect(await repository.markWithdrawSent({ row: stale, now: sentAt })).toBe(true);
    expect(await repository.markWithdrawReturned({ row: { ...stale, withdrawCallCount: 1, withdrawRequestedAt: sentAt,
      withdrawReturnedAt: null, withdrawOutcome: null }, outcome: "ok", sentNothing: false, now: new Date(sentAt.getTime() + 1_000) })).toBe(true);
    // Tick B read the row before A's writes: its marker must not match, so it never calls eBay again.
    expect(await repository.markWithdrawSent({ row: stale, now: new Date(sentAt.getTime() + 5_000) })).toBe(false);
    expect(await endRow(id)).toMatchObject({ state: "ending", withdraw_call_count: 1, withdraw_outcome: "ok", withdraw_requested_at: sentAt });
    expect(await requestAudits(id)).toEqual(["listing_end_started", "listing_end_withdraw_sent", "listing_end_withdraw_returned"]);
    // A stale copy's return marker is refused too.
    expect(await repository.markWithdrawReturned({ row: { ...stale, withdrawCallCount: 1, withdrawRequestedAt: new Date(sentAt.getTime() - 1),
      withdrawReturnedAt: null, withdrawOutcome: null }, outcome: "network", sentNothing: false, now: new Date(sentAt.getTime() + 6_000) })).toBe(false);
  }, CASE_TIMEOUT_MS);

  it("review DB-4: ends a listing whose stored ids carry spaces or a blank listing id, as the claim resolved them", async () => {
    const store = await seedStore();
    const member = await seedMember(store, 70021, { offerId: "O-trim-70021 ", listingExternalId: "" });
    const id = await requestEnd(member);
    // eBay knows the offer by its exact id (no spaces) and lists it under its own item number.
    const ebay = StubEbay.for({ ...member, offerId: "O-trim-70021", listingExternalId: "L-ebay-70021" });
    expect(await worker(ebay).service.runTick()).toMatchObject({ outcome: "completed", claimed: 1, ended: 1, failed: 0 });
    expect(await endRow(id)).toMatchObject({ state: "ended", code: null, withdraw_outcome: "ok" });
    expect(await listingRow(member.listingId)).toMatchObject({ status: "ended", external_offer_id: "O-trim-70021 ", external_listing_id: "" });
  }, CASE_TIMEOUT_MS);

  it("review FEN-1/DB-2: stamps the end when it ends, so a vendor press made during the tick is fenced and updated_at never goes back", async () => {
    const store = await seedStore();
    const member = await seedMember(store, 70022);
    const id = await requestEnd(member);
    let seconds = 0;
    const clock = () => new Date(WORKER_NOW.getTime() + (seconds += 10) * 1000);
    // Something wrote the listing later than this tick's start (another dyno's clock): its updated_at must never move back.
    const later = new Date(WORKER_NOW.getTime() + 60 * 60_000);
    await pool.query("UPDATE dropship.dropship_vendor_listings SET updated_at = $2 WHERE id = $1", [member.listingId, later]);
    const ebay = StubEbay.for(member);
    const press = { at: new Date(0), jobId: 0, itemId: 0 };
    ebay.beforeInspect = async (call) => {
      if (call !== 2) return;
      // During the verify read, the vendor presses Publish in step 3: an item created before the end finishes.
      press.at = clock();
      press.jobId = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs
          (vendor_id, store_connection_id, status, idempotency_key, request_hash, requested_by)
        VALUES ($1, $2, 'queued', $3, 'hash', 'member-70') RETURNING id`, [WORKER_VENDOR, store.storeId, `press-${store.storeId}`])).rows[0]!.id;
      press.itemId = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id,
          product_variant_id, status, preview_hash, result, created_at)
        VALUES ($1, $2, $3, 'queued', 'preview', '{"relistAllowed":true}'::jsonb, $4) RETURNING id`,
      [press.jobId, member.listingId, member.size, press.at])).rows[0]!.id;
    };
    expect(await worker(ebay, { clock }).service.runTick()).toMatchObject({ outcome: "completed", ended: 1 });
    const ended = await endRow(id);
    expect(ended.state).toBe("ended");
    expect(press.itemId).toBeGreaterThan(0);
    expect(ended.ended_at!.getTime()).toBeGreaterThan(press.at.getTime());
    expect(ended.withdraw_requested_at!.getTime()).toBeGreaterThan(WORKER_NOW.getTime() + 10_000);
    expect((await listingRow(member.listingId)).updated_at).toEqual(later);
    // An eBay order placed at the press, while the listing was still for sale, is accepted (plan §0): the end time is
    // the finish's, not the tick's start.
    expect(decideListingOrderAcceptability({ status: "ended", externalListingId: member.listingExternalId,
      listingEndedAt: ended.ended_at, orderedAt: press.at })).toEqual({ acceptable: true, reason: "ordered_before_listing_ended" });
    // The press was made while the end was still open: it never relists the listing Card Shellz just ended (SAF-9).
    expect(await new PgDropshipListingPushWorkerRepository(pool).markItemProcessing({ jobId: press.jobId, itemId: press.itemId,
      workerId: "worker-review", now: new Date(WORKER_NOW.getTime() + 600_000) })).toBe("ended_since_queued");
  }, CASE_TIMEOUT_MS);

  it("review DB-1: a push completion holding the product's work row: the claim of a re-picked size waits for the push, no deadlock", async () => {
    const store = await seedStore();
    const member = await seedMember(store, 70031);
    const job = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs
        (vendor_id, store_connection_id, status, idempotency_key, request_hash, requested_by)
      VALUES ($1, $2, 'processing', $3, 'hash', 'system') RETURNING id`, [WORKER_VENDOR, store.storeId, `complete-${store.storeId}`])).rows[0]!.id;
    const item = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id,
        product_variant_id, status, preview_hash, result) VALUES ($1, $2, $3, 'processing', 'preview', '{}'::jsonb) RETURNING id`,
    [job, member.listingId, member.size])).rows[0]!.id;
    const id = await requestEnd(member);
    await addPick(WORKER_VENDOR, member.size);
    const completion = await pool.connect();
    try {
      // completeItem's order (WR): the item's terminal status first (its trigger re-plans the product: the work row
      // is held), then the listing FOR UPDATE.
      await completion.query("BEGIN");
      await completion.query("SET LOCAL lock_timeout = '5s'");
      await completion.query("UPDATE dropship.dropship_listing_push_job_items SET status = 'completed' WHERE id = $1", [item]);
      let settled = false;
      const claiming = repository.claim({ row: await dueRow(id), now: WORKER_NOW }).finally(() => { settled = true; });
      await waitUntil(async () => settled || (await lockWaiter(pool, "UPDATE dropship.dropship_listing_end_requests")) !== null,
        "the claim to decide or to wait on the product's work row");
      // The completion now takes the listing: it must never meet a claim holding it while that claim waits on the work row.
      await completion.query("SELECT id FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE", [member.listingId]);
      await completion.query("COMMIT");
      expect(await claiming).toMatchObject({ kind: "decided", decision: { outcome: "deferred", code: "DROPSHIP_LISTING_END_WAITING_FOR_PUSH" } });
    } finally {
      await completion.query("ROLLBACK").catch(() => undefined);
      completion.release();
    }
    expect(await endRow(id)).toMatchObject({ state: "pending", deferral_count: 1, code: "DROPSHIP_LISTING_END_WAITING_FOR_PUSH" });
    // Next time (after its 60 s wait), with the push recorded, the claim's re-pick check takes the end back.
    const later = new Date(WORKER_NOW.getTime() + 61_000);
    const again = (await repository.readTickFacts(later)).due.find((entry) => entry.kind === "row" && entry.row.id === id);
    if (!again || again.kind !== "row") throw new Error(`End request ${id} is not due again.`);
    expect(await repository.claim({ row: again.row, now: later })).toMatchObject({ kind: "decided",
      decision: { outcome: "superseded", code: "DROPSHIP_LISTING_END_RE_PICKED" } });
  }, CASE_TIMEOUT_MS);
  // -------------------------------------------------------------------------------------------------------------------
  // C5: the staff surface on real rows (PLAN-C v4.1 §10, §13.2): the list, Retry (refused while an inventory request on
  // the SKU is unsettled, through inventory planning's real response recovery over its reduced tables), Mark resolved
  // ("Ended on eBay", "Left on sale"), keys scoped by action, a lock wait, and interleaving (e) through the real Retry.
  // The sweep's side of "Ended on eBay" / "Left on sale" is in the interplay suite (its schema has the sync-back reads).

  describe("the staff surface (C5)", () => {
    /** The staff member's clock: before the worker's, so a Retry's `next_attempt_at` is due at the worker's tick. */
    const STAFF_NOW = new Date(WORKER_NOW.getTime() - 5 * 60_000);
    const STAFF = { actorType: "admin", actorId: "staff-1" } as const;
    let keySeq = 0;
    const newKey = () => `staff-key-${String(++keySeq).padStart(4, "0")}`;

    beforeAll(async () => {
      // What the staff list reads beyond PR B's schema: the vendor's name and email (0086's shapes). Inventory planning's
      // request journal, reduced to the columns its response recovery reads and writes (migration 237's shapes): the
      // attempt fence, its provider requests and their recorded results, and the catch-up rows it re-dates.
      await pool.query(`
        ALTER TABLE dropship.dropship_vendors ADD COLUMN business_name varchar(200), ADD COLUMN email varchar(255);
        CREATE TABLE inventory.quantity_publication_catchup (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, scope_key text NOT NULL UNIQUE,
          revision bigint NOT NULL DEFAULT 1, completed_revision bigint NOT NULL DEFAULT 0, next_attempt_at timestamptz,
          updated_at timestamptz);
        CREATE TABLE inventory.quantity_publication_attempts (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          owner_kind text NOT NULL, scope jsonb NOT NULL, affected_scope_keys text[] NOT NULL, state text NOT NULL,
          completed_at timestamptz, outcome_hash text, error_code text, resolution_basis text);
        CREATE TABLE inventory.quantity_provider_requests (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, attempt_id bigint NOT NULL,
          ordinal integer NOT NULL, method text NOT NULL, path text NOT NULL, request_hash text NOT NULL);
        CREATE TABLE inventory.quantity_provider_request_results (request_id bigint PRIMARY KEY, outcome text, http_status integer,
          response_hash text, error_codes text[] NOT NULL DEFAULT '{}', request_terminated boolean, recorded_at timestamptz);`);
    });

    beforeEach(async () => {
      await pool.query(`TRUNCATE inventory.quantity_provider_request_results, inventory.quantity_provider_requests,
        inventory.quantity_publication_attempts, inventory.quantity_publication_catchup`);
    });

    function staffService() {
      const lines: Array<{ level: string; action: string; fields: Record<string, unknown> }> = [];
      const service = new DropshipListingEndOpsService({
        repository: new PgDropshipListingEndOpsRepository(pool),
        recovery: new PostgresQuantityProviderResponseRecovery(pool, () => STAFF_NOW),
        clock: { now: () => STAFF_NOW },
        log: { debug: (action, fields) => lines.push({ level: "debug", action, fields }),
          info: (action, fields) => lines.push({ level: "info", action, fields }) },
      });
      return { service, lines };
    }

    /** A failed end as the worker leaves one, with the claim's identity (`resolved: false` for one that failed at the claim). */
    async function failedEnd(member: WorkerMember, overrides: Partial<ListingEndRequestRow> & { resolved?: boolean } = {}): Promise<number> {
      const { resolved, ...row } = overrides;
      return requestEnd(member, { state: "failed", code: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN", decidedAt: WORKER_NOW.toISOString(),
        ...(resolved === false ? {} : { resolvedIdentity: viewIdentityOf(member) }), ...row });
    }

    /** An inventory attempt left open on the member's SKU scope by a withdraw whose answer never came back. */
    async function openWithdrawAttempt(member: WorkerMember): Promise<string> {
      const scope = { destinationKind: "dropship_store_connection", connectionId: member.storeId, providerKey: "ebay", providerScopeType: "account",
        externalScopeId: member.account, externalInventoryItemId: member.sku, productId: null, productVariantId: null } as const;
      const attempt = (await pool.query<{ id: string }>(`INSERT INTO inventory.quantity_publication_attempts
          (owner_kind, scope, affected_scope_keys, state) VALUES ('legacy', $1::jsonb, $2, 'uncertain') RETURNING id::text AS id`,
      [JSON.stringify(scope), [quantityPublicationScopeLockKey(scope)]])).rows[0]!.id;
      const request = (await pool.query<{ id: string }>(`INSERT INTO inventory.quantity_provider_requests (attempt_id, ordinal, method, path,
          request_hash) VALUES ($1, 1, 'POST', $2, repeat('a', 64)) RETURNING id::text AS id`,
      [attempt, `/sell/inventory/v1/offer/${member.offerId}/withdraw`])).rows[0]!.id;
      await pool.query(`INSERT INTO inventory.quantity_provider_request_results (request_id, outcome, http_status, request_terminated, recorded_at)
        VALUES ($1, 'uncertain', 500, false, $2)`, [request, WORKER_NOW]);
      return attempt;
    }

    async function staffRefusal(work: Promise<unknown>): Promise<DropshipError> {
      const error = await work.then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(DropshipError);
      return error as DropshipError;
    }

    async function staffRow(id: number) {
      return (await pool.query(`SELECT state, version, code, context, attempt_count, deferral_count, withdraw_call_count, withdraw_requested_at,
          withdraw_returned_at, withdraw_outcome, next_attempt_at, decided_at, ended_at, staff_action, staff_action_key
        FROM dropship.dropship_listing_end_requests WHERE id = $1`, [id])).rows[0];
    }

    async function staffAudits(id: number) {
      return (await pool.query<{ event_type: string; actor_type: string; actor_id: string; payload: Record<string, any> }>(`SELECT event_type,
          actor_type, actor_id, payload FROM dropship.dropship_audit_events
        WHERE entity_type = 'dropship_listing_end_request' AND entity_id = $1 ORDER BY id`, [String(id)])).rows;
    }

    it("lists failed ends newest first with the size's SKU and the context's staff parts; filters, pages and other states", async () => {
      const storeA = await seedStore();
      const a = await seedMember(storeA, 70011);
      const b = await seedMember(storeA, 70012);
      const d = await seedMember(storeA, 70014);
      const c = await seedMember(await seedStore({ vendorId: OTHER_VENDOR }), 70013);
      const aId = await failedEnd(a, { attemptCount: 2, withdrawCallCount: 1, withdrawRequestedAt: WORKER_NOW.toISOString(),
        withdrawOutcome: "uncertain_500", context: { lastCode: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN", attemptIds: ["41"], evidence: "published",
          requiresReview: true, rejectedAccessTokenRef: "token-ref-1" } });
      const bId = await failedEnd(b, { code: "DROPSHIP_LISTING_END_SHARED_LISTING", resolved: false });
      const cId = await failedEnd(c, { code: "DROPSHIP_LISTING_END_REJECTED" });
      const dId = await requestEnd(d);
      const { service } = staffService();

      const failed = await service.list({});
      expect(failed).toMatchObject({ total: 3, page: 1, limit: 50, state: "failed" });
      expect(failed.items.map((row) => row.endRequestId)).toEqual([cId, bId, aId]);
      expect(failed.items[2]).toEqual({
        endRequestId: aId,
        vendor: { vendorId: WORKER_VENDOR, memberId: `member-${WORKER_VENDOR}`, businessName: null, email: null },
        store: { storeConnectionId: storeA.storeId, platform: "ebay", status: "connected", displayName: `Store ${storeA.storeId}` },
        listing: { listingId: a.listingId, status: "active", externalListingId: a.listingExternalId, externalOfferId: a.offerId },
        productId: a.productId, productVariantId: a.size, sku: "S-70011", reason: "size_removed", state: "failed",
        code: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN", message: null,
        // Only the parts staff act on: never the rejected token's reference.
        context: { lastCode: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN", attemptIds: ["41"], evidence: "published", requiresReview: true },
        attemptCount: 2, deferralCount: 0,
        withdraw: { callCount: 1, requestedAt: WORKER_NOW.toISOString(), returnedAt: null, outcome: "uncertain_500" },
        staffAction: null, decidedAt: WORKER_NOW.toISOString(), createdAt: LISTING_END_FIXTURE_AT, updatedAt: LISTING_END_FIXTURE_AT,
      });
      expect((await service.list({ storeConnectionId: storeA.storeId })).items.map((row) => row.endRequestId)).toEqual([bId, aId]);
      expect((await service.list({ vendorId: OTHER_VENDOR })).items.map((row) => row.endRequestId)).toEqual([cId]);
      expect(await service.list({ limit: 1, page: 2 })).toMatchObject({ total: 3, items: [{ endRequestId: bId }] });
      expect(await service.list({ limit: 1, page: 4 })).toMatchObject({ total: 3, items: [] });
      expect((await service.list({ state: "pending" })).items.map((row) => row.endRequestId)).toEqual([dId]);
    }, CASE_TIMEOUT_MS);

    it("Retry is refused while the SKU's withdraw attempt is unsettled (real recovery); once attested, it sets the end pending and the worker's claim ends it", async () => {
      const member = await seedMember(await seedStore(), 70011);
      const id = await failedEnd(member, { attemptCount: 3, version: 3, withdrawCallCount: 1, withdrawRequestedAt: WORKER_NOW.toISOString(),
        withdrawReturnedAt: WORKER_NOW.toISOString(), withdrawOutcome: "uncertain_500",
        context: { lastCode: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN", attemptIds: ["1"], evidence: "unreadable", requiresReview: true } });
      const attempt = await openWithdrawAttempt(member);
      const { service, lines } = staffService();

      const refused = await staffRefusal(service.retry({ endRequestId: id, idempotencyKey: newKey(), actor: STAFF }));
      expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_END_QUANTITY_RECOVERY_REQUIRED",
        context: { attemptIds: [attempt], reason: "unresolved_attempts", classification: "permanent" } });
      expect(await staffRow(id)).toMatchObject({ state: "failed", version: 3, staff_action: null, withdraw_call_count: 1 });
      expect(await staffAudits(id)).toEqual([]);
      // Recovery cannot settle a withdraw receipt by itself: the attempt is still open.
      expect((await pool.query("SELECT state FROM inventory.quantity_publication_attempts WHERE id = $1", [attempt])).rows).toEqual([{ state: "uncertain" }]);

      // An inventory operator attests the attempt (quantity-publication-recovery.routes.ts); then Retry goes through.
      await pool.query(`UPDATE inventory.quantity_publication_attempts SET state = 'resolved', completed_at = $2,
        resolution_basis = 'operator_attestation' WHERE id = $1`, [attempt, STAFF_NOW]);
      const key = newKey();
      const answer = await service.retry({ endRequestId: id, idempotencyKey: key, reason: "Attempt attested; eBay shows it for sale.", actor: STAFF });
      expect(answer).toMatchObject({ action: "retry", idempotentReplay: false, endRequest: { endRequestId: id, state: "pending", staffAction: "retry",
        attemptCount: 0, withdraw: { callCount: 0, requestedAt: null, returnedAt: null, outcome: null } } });
      expect(await staffRow(id)).toMatchObject({ state: "pending", version: 4, code: null, context: {}, attempt_count: 0, deferral_count: 0,
        withdraw_call_count: 0, withdraw_requested_at: null, withdraw_returned_at: null, withdraw_outcome: null, next_attempt_at: STAFF_NOW,
        decided_at: null, staff_action: "retry", staff_action_key: key });
      const audits = await staffAudits(id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ event_type: "listing_end_retry_requested", actor_type: "admin", actor_id: "staff-1", payload: {
        action: "retry", idempotencyKey: key, reason: "Attempt attested; eBay shows it for sale.",
        // The old values are the staff authorization of another withdraw (§10).
        before: { state: "failed", version: 3, attemptCount: 3, withdrawCallCount: 1, withdrawOutcome: "uncertain_500",
          withdrawRequestedAt: WORKER_NOW.toISOString(), context: { attemptIds: ["1"] } },
        after: { state: "pending", version: 4, staffAction: "retry" } } });
      expect(lines).toContainEqual(expect.objectContaining({ level: "info", action: "dropship.listing_end_ops.applied" }));

      // The worker's claim re-runs every check (§5.4), then withdraws once and verifies.
      const ebay = StubEbay.for(member);
      expect(await worker(ebay).service.runTick()).toMatchObject({ outcome: "completed", claimed: 1, ended: 1, failed: 0 });
      expect(ebay.calls.filter((call) => call.startsWith("withdraw:"))).toEqual([`withdraw:${member.offerId}`]);
      expect(await staffRow(id)).toMatchObject({ state: "ended", withdraw_call_count: 1, withdraw_outcome: "ok", staff_action: "retry" });
    }, CASE_TIMEOUT_MS);

    it("interleaving (e) through the real Retry: a size the vendor picked again is superseded by the claim, never withdrawn", async () => {
      const member = await seedMember(await seedStore(), 70015);
      const id = await failedEnd(member, { code: "DROPSHIP_LISTING_END_REJECTED", attemptCount: 2, version: 3 });
      await addPick(WORKER_VENDOR, member.size);
      const { service } = staffService();
      await service.retry({ endRequestId: id, idempotencyKey: newKey(), actor: STAFF });

      const ebay = StubEbay.for(member);
      expect(await worker(ebay).service.runTick()).toMatchObject({ outcome: "completed", claimed: 0, superseded: 1 });
      expect(ebay.calls).toEqual([]);
      expect(await staffRow(id)).toMatchObject({ state: "superseded", code: "DROPSHIP_LISTING_END_RE_PICKED", withdraw_call_count: 0 });
    }, CASE_TIMEOUT_MS);

    it("keys are scoped by action: the same key answers again, another action with it is refused, a new key on a pending end is refused", async () => {
      const member = await seedMember(await seedStore(), 70012);
      const id = await failedEnd(member, { code: "DROPSHIP_LISTING_END_SHARED_LISTING", resolved: false });
      const { service } = staffService();
      const key = newKey();

      expect(await service.retry({ endRequestId: id, idempotencyKey: key, actor: STAFF })).toMatchObject({ idempotentReplay: false });
      expect(await service.retry({ endRequestId: id, idempotencyKey: key, actor: STAFF }))
        .toMatchObject({ idempotentReplay: true, endRequest: { state: "pending" } });
      expect((await staffRefusal(service.resolve({ endRequestId: id, outcome: "left_on_sale", reason: "Kept it.", idempotencyKey: key,
        actor: STAFF }))).code).toBe("DROPSHIP_LISTING_END_STAFF_KEY_REUSED");
      expect((await staffRefusal(service.retry({ endRequestId: id, idempotencyKey: newKey(), actor: STAFF }))).code)
        .toBe("DROPSHIP_LISTING_END_STAFF_STATE_INVALID");
      expect((await staffRefusal(service.retry({ endRequestId: id + 1_000, idempotencyKey: newKey(), actor: STAFF }))).code)
        .toBe("DROPSHIP_LISTING_END_NOT_FOUND");
      expect((await staffAudits(id)).map((audit) => audit.event_type)).toEqual(["listing_end_retry_requested"]);
      expect(await staffRow(id)).toMatchObject({ state: "pending", version: 2, staff_action: "retry", staff_action_key: key });
    }, CASE_TIMEOUT_MS);

    it("two Retries with one key at once write once: one applies, the other answers it again (TST-5)", async () => {
      const member = await seedMember(await seedStore(), 70013);
      const id = await failedEnd(member, { resolved: false, code: "DROPSHIP_LISTING_END_SHARED_LISTING" });
      const key = newKey();
      // The first Retry holds its transaction open after its write (review TST-3): the second waits on the vendor lock.
      const held = poolHoldingFirstCommit(pool);
      const heldService = new DropshipListingEndOpsService({
        repository: new PgDropshipListingEndOpsRepository(held.pool),
        recovery: new PostgresQuantityProviderResponseRecovery(pool, () => STAFF_NOW),
        clock: { now: () => STAFF_NOW },
        log: { debug: () => undefined, info: () => undefined },
      });
      const first = heldService.retry({ endRequestId: id, idempotencyKey: key, actor: STAFF });
      try {
        await held.reachedCommit;
        const second = staffService().service.retry({ endRequestId: id, idempotencyKey: key, actor: STAFF });
        await waitUntil(async () => (await lockWaiter(pool, "SELECT pg_advisory_xact_lock(hashtext('dropship_vendor_selection_rules')")) !== null,
          "the second Retry to wait on the first's vendor lock");
        held.release();
        expect(await first).toMatchObject({ idempotentReplay: false });
        expect(await second).toMatchObject({ idempotentReplay: true, endRequest: { state: "pending" } });
      } finally {
        held.release();
        await first.catch(() => undefined);
      }
      expect((await staffAudits(id)).map((audit) => audit.event_type)).toEqual(["listing_end_retry_requested"]);
    }, CASE_TIMEOUT_MS);

    it("Ended on eBay: the listing gets the finish's write, the end is ENDED_BY_STAFF (not a verified end), and a vendor press queued before it is fenced", async () => {
      const store = await seedStore();
      const member = await seedMember(store, 70014);
      // A verify that never read the offer unpublished: its withdraw went through ('ok'), then the readback exhausted.
      const id = await failedEnd(member, { code: "DROPSHIP_LISTING_END_RETRIES_EXHAUSTED", version: 5, withdrawCallCount: 1,
        withdrawRequestedAt: WORKER_NOW.toISOString(), withdrawReturnedAt: WORKER_NOW.toISOString(), withdrawOutcome: "ok",
        context: { lastCode: "DROPSHIP_LISTING_END_READBACK_PENDING", requiresReview: true } });
      const job = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs
          (vendor_id, store_connection_id, status, idempotency_key, request_hash, requested_by)
        VALUES ($1, $2, 'queued', $3, 'hash', 'member-70') RETURNING id`, [WORKER_VENDOR, store.storeId, `staff-${store.storeId}`])).rows[0]!.id;
      const item = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id, product_variant_id,
          status, preview_hash, result, created_at) VALUES ($1, $2, $3, 'queued', 'preview', '{"relistAllowed":true}'::jsonb, $4) RETURNING id`,
      [job, member.listingId, member.size, new Date(STAFF_NOW.getTime() - 60 * 60_000)])).rows[0]!.id;
      const { service } = staffService();

      const answer = await service.resolve({ endRequestId: id, outcome: "ended_on_ebay", reason: "Ended it on eBay by hand.", idempotencyKey: newKey(),
        actor: STAFF });
      expect(answer).toMatchObject({ action: "resolve_ended", endRequest: { state: "ended", code: "DROPSHIP_LISTING_END_ENDED_BY_STAFF",
        staffAction: "resolve_ended", listing: { status: "ended" } } });
      expect(await listingRow(member.listingId)).toEqual({ status: "ended", external_listing_id: member.listingExternalId,
        external_offer_id: member.offerId, marketplace_ended_at: null, updated_at: STAFF_NOW });
      expect(await staffRow(id)).toMatchObject({ state: "ended", version: 6, ended_at: STAFF_NOW, decided_at: STAFF_NOW, next_attempt_at: null,
        staff_action: "resolve_ended" });
      expect((await staffAudits(id)).map((audit) => [audit.event_type, audit.actor_type, audit.actor_id]))
        .toEqual([["listing_end_resolved", "admin", "staff-1"]]);
      expect(await listingEndedAudits(member.listingId)).toEqual([{ actor_type: "admin", actor_id: "staff-1", payload: {
        listingId: member.listingId, endRequestId: id, productVariantId: member.size, externalOfferId: member.offerId,
        externalListingId: member.listingExternalId, endedBy: "staff", reason: "Ended it on eBay by hand.",
        before: { status: "active" }, after: { status: "ended" } } }]);
      // Not a verified end: the store's canary still waits for one, and it never ends a breaker's streak (§5.3; review WRK-6).
      await requestEnd(await seedMember(store, 70015));
      const facts = await repository.readTickFacts(WORKER_NOW);
      expect(facts.stores.find((entry) => entry.storeConnectionId === store.storeId)).toMatchObject({ hasVerifiedEnd: false,
        newestDecided: [] });
      // A Card Shellz end: nothing is published for it, and the vendor's press queued before it never relists it (SAF-9).
      expect(await stockOf(member)).toMatchObject({ action: "none", reason: "listing_ended" });
      expect(await new PgDropshipListingPushWorkerRepository(pool).markItemProcessing({ jobId: job, itemId: item, workerId: "worker-c5",
        now: WORKER_NOW })).toBe("ended_since_queued");
    }, CASE_TIMEOUT_MS);

    it("Left on sale: the end closes (resolved), the listing is left as it is, and its pushes are no longer fenced", async () => {
      const store = await seedStore();
      const member = await seedMember(store, 70016);
      const id = await failedEnd(member, { code: "DROPSHIP_LISTING_END_IDENTITY_MISMATCH" });
      const before = await listingRow(member.listingId);
      const { service } = staffService();

      expect(await service.resolve({ endRequestId: id, outcome: "left_on_sale", reason: "The vendor sells it; it stays.", idempotencyKey: newKey(),
        actor: STAFF })).toMatchObject({ action: "resolve_left", endRequest: { state: "resolved", staffAction: "resolve_left" } });
      expect(await staffRow(id)).toMatchObject({ state: "resolved", version: 2, decided_at: STAFF_NOW, ended_at: null, next_attempt_at: null,
        code: "DROPSHIP_LISTING_END_IDENTITY_MISMATCH" });
      expect(await listingRow(member.listingId)).toEqual(before);
      expect(await listingEndedAudits(member.listingId)).toEqual([]);
      const job = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_jobs
          (vendor_id, store_connection_id, status, idempotency_key, request_hash, requested_by)
        VALUES ($1, $2, 'queued', $3, 'hash', 'system') RETURNING id`, [WORKER_VENDOR, store.storeId, `left-${store.storeId}`])).rows[0]!.id;
      const item = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id, product_variant_id,
          status, preview_hash, result) VALUES ($1, $2, $3, 'queued', 'preview', '{}'::jsonb) RETURNING id`,
      [job, member.listingId, member.size])).rows[0]!.id;
      expect(await new PgDropshipListingPushWorkerRepository(pool).markItemProcessing({ jobId: job, itemId: item, workerId: "worker-c5",
        now: WORKER_NOW })).toBe("started");
    }, CASE_TIMEOUT_MS);

    it("waits at most 2 s for the request's lock, then answers STAFF_BUSY (transient) with nothing written", async () => {
      const member = await seedMember(await seedStore(), 70011);
      const id = await failedEnd(member, { resolved: false, code: "DROPSHIP_LISTING_END_SHARED_LISTING" });
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM dropship.dropship_listing_end_requests WHERE id = $1 FOR UPDATE", [id]);
        const started = performance.now();
        const refused = await staffRefusal(staffService().service.retry({ endRequestId: id, idempotencyKey: newKey(), actor: STAFF }));
        expect(performance.now() - started).toBeGreaterThanOrEqual(CLAIM_LOCK_TIMEOUT_MS - 100);
        expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_END_STAFF_BUSY", context: { causeCode: "55P03", classification: "transient" } });
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
      expect(await staffRow(id)).toMatchObject({ state: "failed", version: 1, staff_action: null });
      expect(await staffAudits(id)).toEqual([]);
    }, CASE_TIMEOUT_MS);
  });
});
