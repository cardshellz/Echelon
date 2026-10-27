import { createHash } from "node:crypto";
import pg, { type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isCustomerSellableVariant } from "@shared/catalog/variant-sales-eligibility";
import {
  executeMigrationWithRetry,
  type MigrationRetryNotice,
  type MigrationRetryOptions,
} from "../../../../../migrations/migration-executor";
import { evaluateDropshipCatalogExposure, type DropshipCatalogExposureDecision } from "../../domain/catalog-exposure";
import { isReservedSelectionIdempotencyKey } from "../../domain/selection-release";
import { evaluateDropshipVendorCatalogSelection, vendorRulesPick } from "../../domain/vendor-selection";
import { DROPSHIP_VENDOR_SELECTION_LOCK_SQL } from "../../infrastructure/dropship-vendor-selection-lock";
import {
  createInventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { decideSelectionEffects, type SelectionEffectsListing } from "../../domain/vendor-selection-effects";
import { loadSelectedVariantIds, selectedVariantIdsAmong, countSelectedVariants } from "../../application/dropship-selected-catalog";
import { listSellableVariantIdsAfter, selectedCatalogReaderForTransaction } from "../../infrastructure/dropship-selected-catalog.reader";
import { PgDropshipListingPreviewRepository } from "../../infrastructure/dropship-listing-preview.repository";
import { PgDropshipVendorProvisioningRepository } from "../../infrastructure/dropship-vendor-provisioning.repository";
import { readDropshipSelectionEffectsFacts } from "../../infrastructure/dropship-selection-effects.reader";
import { FOLLOW_UP_REPAIR_BATCH_SIZE } from "../../application/dropship-selection-conversion-followup";
import { PgDropshipSelectionConversionFollowUpRepository } from "../../infrastructure/dropship-selection-conversion-followup.repository";
import { readDropshipListingStockSelection } from "../../stock-publication-selection";
import { legacyEvaluateVendorSelection } from "../fixtures/legacy-vendor-selection";
import { legacyDecisionUnderPicks } from "../fixtures/legacy-vendor-selection-meaning";
import {
  SELECTED_VARIANTS_MIGRATION_FILE,
  installPicksMigrationPrerequisites,
  picksMigrationSchemaSql,
  selectedVariantsMigrationSql,
} from "../fixtures/selection-picks-migration.fixture";
import {
  MAIN_SELECTION_GOLDEN,
  MAIN_SELECTION_GOLDEN_SEED_SHA256,
  MAIN_SELECTION_GOLDEN_SOURCE_COMMIT,
} from "../fixtures/selection-oracle.golden";
import {
  SELECTION_ORACLE_TIMES,
  loadSelectionOracleInputs,
  readSelectionOracleSnapshot,
  selectionGoldenKey,
  selectionOracleSeedSha256,
  selectionOracleSeedSql,
  type SelectionGoldenEntry,
  type SelectionOracleTime,
} from "../fixtures/selection-oracle.fixture";
import { LISTING_END_REQUESTS_REDUCED_FIXTURE_SQL } from "../fixtures/listing-end-reduced.fixture";

/**
 * The picks migration of PR B against a real PostgreSQL (step 1 plan S2-5, PLAN-B v4.1 §15.3).
 *
 * B1a, the oracle first (TESTS-2, SAFETY-12): before the evaluator (VS) or the stock selection reader
 * (SPR) changed, A's reader under rules over the equivalence and fingerprint fixture was recorded at main
 * (cea5cb027) as the golden, on the shared listing-push-runs base (0086/0091 shapes), the sync-back listing
 * columns (cut from the real migration) and the columns SPR reads that the base leaves out (BUILD-NOTES
 * "B1a oracle"). B1c made the evaluator and SPS decide from `picked`.
 *
 * B1b, the B file itself on that schema plus the real 0743 (TESTS-4), applied through the release executor:
 * the conversion equals the frozen oracle for every scope and at three times, the records and audit it
 * writes, the freeze before the gate, the picks' triggers, a size delete taking its picks (CHK5), the lock
 * order against a rules save at every point (CHK1) and a SHARE holder, a forced lock timeout rolled back and
 * retried, and the lock windows on 30,000 sizes (CHK11, SAFETY-4, SAFETY-5). Each case that applies the file
 * gets a database of its own (createInventoryCutoverTestDatabase), dropped afterwards, so no case cleans up
 * after the freeze (V7: a cleanup there would need TRUNCATE ... CASCADE).
 *
 * B1d, every reader reads the picks (§9): the golden comparison now runs after the B file, so SPR reads the
 * converted picks (fingerprint equivalence: identical action per size; the changed reasons and fingerprints
 * are exactly the retired keep-out reason's, listed in BUILD-NOTES "B1d readers"), and the real readers run
 * on the converted schema: the bounded pick lookup, the selected-catalog keyset and its scans, the arrivals
 * keyset, the provisioning count, the effects reader's parity with SPR over every listing state (R5) and
 * SPR's `listingSelected` from picks (V15).
 */

/**
 * Records every input the stock decision (SPS) is given, for the reader parity case (R5): SPR and the
 * effects decision call the one domain function, so the inputs they give it can be compared directly. A
 * pass-through: the decision itself is unchanged, and nothing is recorded unless a case turns it on.
 */
const stockDecisionRecorder = vi.hoisted(() => ({ recording: false, inputs: [] as unknown[] }));
vi.mock("../../domain/stock-publication-selection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../domain/stock-publication-selection")>();
  return {
    ...actual,
    decideDropshipStockPublicationSelection: (input: Parameters<typeof actual.decideDropshipStockPublicationSelection>[0]) => {
      if (stockDecisionRecorder.recording) stockDecisionRecorder.inputs.push(input);
      return actual.decideDropshipStockPublicationSelection(input);
    },
  };
});
type StockDecisionInput = Parameters<typeof import("../../domain/stock-publication-selection").decideDropshipStockPublicationSelection>[0];

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

/** Each (vendor, size, time) whose reader answer carries `listingSelected`; the rest end before selection. */
const MIN_READER_SELECTION_COMPARISONS = 200;

/** A golden key's (time, store, product) read: every size of one read shares its fingerprint. */
function readKey(goldenKey: string): string {
  return goldenKey.replace(/ size \d+$/, "");
}

describeDatabase.sequential("picks migration: the stock selection reader after the B file against the golden at main (PostgreSQL)", () => {
  let db: PicksDatabase | undefined;
  let pool: Pool;
  let snapshot: Record<string, SelectionGoldenEntry>;

  beforeAll(async () => {
    // Only the seed the golden was recorded on, then the B file: SPR reads the picks the conversion wrote.
    db = await createPicksDatabase([selectionOracleSeedSql]);
    pool = db.pool;
    const client = await pool.connect();
    try {
      await applyPicksMigration(client);
    } finally {
      client.release();
    }
    snapshot = await readSelectionOracleSnapshot(pool);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("seeds exactly the fixture the golden was recorded on", () => {
    expect(MAIN_SELECTION_GOLDEN_SOURCE_COMMIT).toBe("cea5cb0279982a5688dd96a712a0ed2f522f88af");
    expect(selectionOracleSeedSha256()).toBe(MAIN_SELECTION_GOLDEN_SEED_SHA256);
  });

  it("reads the converted picks to the golden's action for every (time, store, product, size); only the retired keep-out reason changes", () => {
    expect(Object.keys(snapshot)).toHaveLength(Object.keys(MAIN_SELECTION_GOLDEN).length);
    // §4.2: only the keep-out reason changes (to the retained not-picked name), and with it the fingerprint of
    // exactly the (time, store, product) reads that hold such a size; action, listingSelected and limit stay.
    const changedReads = new Set<string>();
    for (const [key, golden] of Object.entries(MAIN_SELECTION_GOLDEN)) {
      if (golden.reason === "excluded_by_vendor_rule") changedReads.add(readKey(key));
    }
    const expected: Record<string, SelectionGoldenEntry> = {};
    for (const [key, golden] of Object.entries(MAIN_SELECTION_GOLDEN)) {
      expected[key] = {
        ...golden,
        reason: golden.reason === "excluded_by_vendor_rule" ? "missing_vendor_include_rule" : golden.reason,
        fingerprint: changedReads.has(readKey(key)) ? snapshot[key]?.fingerprint ?? "missing" : golden.fingerprint,
      };
    }
    expect(snapshot).toEqual(expected);
    for (const key of Object.keys(MAIN_SELECTION_GOLDEN).filter((entry) => changedReads.has(readKey(entry)))) {
      expect(snapshot[key].fingerprint, key).not.toBe(MAIN_SELECTION_GOLDEN[key].fingerprint);
    }
    // Every size of one read carries that read's one fingerprint.
    const fingerprintsByRead = new Map<string, Set<string>>();
    for (const [key, entry] of Object.entries(snapshot)) {
      fingerprintsByRead.set(readKey(key), (fingerprintsByRead.get(readKey(key)) ?? new Set()).add(entry.fingerprint));
    }
    expect([...fingerprintsByRead.values()].every((fingerprints) => fingerprints.size === 1)).toBe(true);
    // The fixture reaches every action, so the golden is not one shape repeated, and the change is not vacuous.
    expect(new Set(Object.values(snapshot).map((entry) => entry.action))).toEqual(new Set(["publish", "zero", "read_only", "none"]));
    expect(Object.values(snapshot).some((entry) => entry.reason === "excluded_by_vendor_rule")).toBe(false);
    expect(changedReads.size).toBeGreaterThan(0);
    expect(changedReads.size).toBeLessThan(fingerprintsByRead.size);
    expect(Object.values(snapshot).some((entry) => entry.publishLimitUnits === 0)).toBe(true);
  });

  it("B's evaluator fed the rules' pick equals the frozen oracle, and so does the reader's selection from picks, for every (vendor, size) at three times", async () => {
    const inputs = await loadSelectionOracleInputs(pool);
    const mismatches: string[] = [];
    const selectedByVendor = new Map<number, number>();
    let readerComparisons = 0;
    for (const time of Object.keys(SELECTION_ORACLE_TIMES) as SelectionOracleTime[]) {
      for (const store of inputs.stores) {
        for (const candidate of inputs.candidates) {
          // The reader's own invocation (SPS): selection only, no quantity.
          const rules = inputs.vendorRules.get(store.vendorId) ?? [];
          const input = {
            candidate,
            adminExposureDecision: evaluateDropshipCatalogExposure(candidate, inputs.adminRules, SELECTION_ORACLE_TIMES[time]),
            override: inputs.overrides.get(`${store.vendorId}:${candidate.productVariantId}`) ?? null,
            rawAtpUnits: 0,
            applyMarketplaceQuantityCap: false,
          };
          const label = `${time} vendor ${store.vendorId} store ${store.id} size ${candidate.productVariantId}`;
          const oracle = legacyEvaluateVendorSelection({ ...input, rules });
          const picked = vendorRulesPick(rules, candidate);
          if (JSON.stringify(legacyDecisionUnderPicks(oracle, picked)) !== JSON.stringify(evaluateDropshipVendorCatalogSelection({ ...input, picked }))) {
            mismatches.push(`${label}: evaluator`);
          }
          if (oracle.selected) selectedByVendor.set(store.vendorId, (selectedByVendor.get(store.vendorId) ?? 0) + 1);
          const answer = snapshot[selectionGoldenKey(time, store.id, candidate.productId, candidate.productVariantId)];
          if (!answer) {
            mismatches.push(`${label}: no reader answer`);
          } else if (answer.listingSelected !== null) {
            readerComparisons += 1;
            if (answer.listingSelected !== (oracle.selected && isCustomerSellableVariant(candidate))) mismatches.push(`${label}: reader`);
          }
        }
      }
    }

    expect(mismatches).toEqual([]);
    expect(readerComparisons).toBeGreaterThanOrEqual(MIN_READER_SELECTION_COMPARISONS);
    // Vendor 302's rules match nothing; every other vendor selects something.
    expect(selectedByVendor.has(302)).toBe(false);
    expect([...selectedByVendor.keys()].sort()).toEqual([301, 303, 304, 305, 306]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// B1b: the B file (PLAN-B v4.1 §6, §15.3).
// ---------------------------------------------------------------------------------------------------------

/** The production executor settings (migration-executor.ts), without the waits between attempts. */
const RELEASE_OPTIONS: MigrationRetryOptions = { maxAttempts: 5, retryBaseDelayMs: 1, retryMaxDelayMs: 1, lockTimeoutMs: 15_000 };
const LOCK_CASE_TIMEOUT_MS = 60_000;
/** TESTS-15: the 30,000-size case seeds, converts and compares well inside this. */
const SCALE_CASE_TIMEOUT_MS = 300_000;
/** SAFETY-5, CHK11: the file, the revisions hold and every wait it causes stay under this (§15.3). */
const LOCK_WINDOW_BUDGET_MS = 10_000;
const RULES_RETIRED_MESSAGE = "DROPSHIP_SELECTION_RULES_RETIRED";
/** 0743's global selection gate key. */
const SELECTION_GATE_SQL = "SELECT pg_advisory_xact_lock_shared(918419, 0)";
/**
 * A's SHARE lock statement at cea5cb027 (dropship-listing-setting-writes.repository.ts:148-149, used by six
 * call sites). B renames the table in that constant, but every process that holds this lock while the B file
 * runs is a process of the previous release, so the text here is A's.
 */
const A_LISTING_SELECTION_LOCK_SQL = `LOCK TABLE dropship.dropship_catalog_rules, dropship.dropship_vendor_selection_rules,
       dropship.dropship_vendor_variant_overrides, catalog.product_line_products IN SHARE MODE`;
const EXPOSED: DropshipCatalogExposureDecision = { exposed: true, reason: "exposed", includeRuleIds: [], excludeRuleIds: [] };

/**
 * Additions to the oracle seed (its text and sha stay pinned): a revision saved before the release, so the
 * backfill keys carry a head id other than 0; vendor 307 with a variant include and only a broad exclude (a
 * record whose notice is not needed); 308 with only an inactive rule (nothing converted); 309 with variant
 * includes only (a revision, no record), one naming no size; 310 without rules; and active mapping heads on
 * products 1001, 1005 and 1007 so the picks' invalidation has products to re-plan.
 */
const conversionEdgeSeedSql = `
  INSERT INTO dropship.dropship_vendors (id, member_id, status, entitlement_status) VALUES
    (307, 'member-307', 'active', 'active'), (308, 'member-308', 'active', 'active'),
    (309, 'member-309', 'active', 'active'), (310, 'member-310', 'active', 'active');
  INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions (id, vendor_id, idempotency_key, request_hash, actor_type,
    actor_id, rule_count, created_at) OVERRIDING SYSTEM VALUE VALUES
    (77, 307, 'vendor-save-307-a', repeat('a', 64), 'vendor', 'member-307', 2, '2026-10-20T08:00:00Z');
  INSERT INTO dropship.dropship_vendor_selection_rules (id, revision_id, vendor_id, scope_type, action, product_line_id, product_id,
    product_variant_id, category, auto_connect_new_skus, auto_list_new_skus, priority, is_active) OVERRIDING SYSTEM VALUE VALUES
    (71, 77, 307, 'variant', 'include', NULL, NULL, 2001, NULL, true, false, 0, true),
    (72, 77, 307, 'category', 'exclude', NULL, NULL, NULL, 'toploaders', true, false, 0, true),
    (73, NULL, 308, 'catalog', 'include', NULL, NULL, NULL, NULL, true, false, 0, false),
    (74, NULL, 309, 'variant', 'include', NULL, NULL, 2002, NULL, true, false, 0, true),
    (75, NULL, 309, 'variant', 'include', NULL, NULL, 2999, NULL, true, false, 0, true);
  INSERT INTO inventory.publication_variant_mapping_heads (publication_target_id, product_variant_id, active_mapping_id)
    VALUES (1, 2001, 1), (1, 2041, 1), (1, 2061, 1);
`;

interface PicksDatabase {
  pool: pg.Pool;
  close(): Promise<void>;
}

interface AppliedMigration {
  attempts: number;
  notices: MigrationRetryNotice[];
  elapsedMs: number;
}

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** A database of its own: the schema, the reduced owners, the real 0743, then the seeds. */
async function createPicksDatabase(seeds: readonly string[]): Promise<PicksDatabase> {
  const database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, picksMigrationSchemaSql);
  let pool: pg.Pool | undefined;
  try {
    await installPicksMigrationPrerequisites(database.pool);
    // PR C's end requests (reduced, empty, no keys): SPR and the effects reader read each listing's open end since C2
    // (PLAN-C v4.1 §7); with none open, every answer and fingerprint is main's, so the golden still holds.
    await database.pool.query(LISTING_END_REQUESTS_REDUCED_FIXTURE_SQL);
    for (const seed of seeds) await database.pool.query(seed);
    pool = new pg.Pool({ connectionString: database.connectionString, max: 8 });
    const opened = pool;
    return { pool: opened, close: async () => { await opened.end(); await database.close(); } };
  } catch (error) {
    await pool?.end();
    await database.close();
    throw error;
  }
}

/** The B file through the release executor, on one client. */
async function applyPicksMigration(client: PoolClient, options: Partial<MigrationRetryOptions> & {
  sleep?: (delayMs: number) => Promise<void>;
} = {}): Promise<AppliedMigration> {
  const sql = selectedVariantsMigrationSql();
  const notices: MigrationRetryNotice[] = [];
  const started = performance.now();
  const { sleep, ...overrides } = options;
  const result = await executeMigrationWithRetry({
    client, file: SELECTED_VARIANTS_MIGRATION_FILE, sql, contentHash: createHash("sha256").update(sql).digest("hex"),
    options: { ...RELEASE_OPTIONS, ...overrides }, onRetry: (notice) => { notices.push(notice); },
    sleep: sleep ?? (async () => undefined),
  });
  return { attempts: result.attempts, notices, elapsedMs: performance.now() - started };
}

/** Starts the file without awaiting it; the outcome never rejects, so a lock case can always clean up. */
function startPicksMigration(client: PoolClient): Promise<{ applied?: AppliedMigration; error?: unknown }> {
  return applyPicksMigration(client).then((applied) => ({ applied }), (error: unknown) => ({ error }));
}

async function backendPid(client: PoolClient): Promise<number> {
  return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
}

async function isWaitingOnLock(pool: Pool, pid: number): Promise<boolean> {
  return (await pool.query<{ waiting: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted) AS waiting", [pid])).rows[0]!.waiting;
}

/** Whether the backend waits for a lock on the named table (`schema.table`). */
async function isWaitingOnTable(pool: Pool, pid: number, table: string): Promise<boolean> {
  return (await pool.query<{ waiting: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE l.pid = $1 AND l.locktype = 'relation' AND NOT l.granted AND n.nspname || '.' || c.relname = $2) AS waiting`,
  [pid, table])).rows[0]!.waiting;
}

/**
 * provisionVendor's write shape (dropship-vendor-provisioning.repository.ts:71-125): the member's advisory lock, the
 * vendor row FOR UPDATE, its UPDATE. `lockTimeoutMs`, when given, makes a blocked write fail with 55P03 instead of waiting.
 */
async function provisionVendorShaped(client: PoolClient, vendorId: number, lockTimeoutMs?: number): Promise<void> {
  await client.query("BEGIN");
  try {
    if (lockTimeoutMs !== undefined) await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_vendor_profile'), hashtext($1))", [`member-${vendorId}`]);
    await client.query("SELECT id, status FROM dropship.dropship_vendors WHERE member_id::text = $1 LIMIT 1 FOR UPDATE", [`member-${vendorId}`]);
    await client.query("UPDATE dropship.dropship_vendors SET status = 'active' WHERE id = $1", [vendorId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(10);
  }
}

async function storedPicks(pool: Pool): Promise<string[]> {
  return (await pool.query<{ key: string }>(`SELECT vendor_id || ':' || product_variant_id AS key
    FROM dropship.dropship_vendor_selected_variants`)).rows.map((row) => row.key).sort();
}

/**
 * What the frozen copy of A's evaluator picks from every vendor's stored rules for every size, with the
 * admin exposure and the overrides taken out: the rule part alone, which is what a pick records.
 */
async function oracleRulePicks(pool: Pool): Promise<string[]> {
  const inputs = await loadSelectionOracleInputs(pool);
  const picks: string[] = [];
  for (const [vendorId, rules] of inputs.vendorRules) {
    for (const candidate of inputs.candidates) {
      const decision = legacyEvaluateVendorSelection({
        candidate, adminExposureDecision: EXPOSED, rules, override: null, rawAtpUnits: 0, applyMarketplaceQuantityCap: false,
      });
      if (decision.selected) picks.push(`${vendorId}:${candidate.productVariantId}`);
    }
  }
  return picks.sort();
}

async function selectionWork(pool: Pool): Promise<Array<{ product_id: number; revision: string }>> {
  return (await pool.query<{ product_id: number; revision: string }>(
    "SELECT product_id, revision::text AS revision FROM inventory.publication_selection_work ORDER BY product_id")).rows;
}

async function pgErrorOf(work: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await work;
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error("Expected the statement to fail.");
}

interface SaveRule {
  scopeType: "catalog" | "product_line" | "category" | "product" | "variant";
  action: "include" | "exclude";
  productLineId?: number;
  productId?: number;
  productVariantId?: number;
  category?: string;
}

/**
 * A rules save shaped as A's PUT at cea5cb027 (dropship-selection-atp.repository.ts:161-262), statement by
 * statement, so a case can stop it at any point: the vendor lock, the replay read FOR UPDATE, the revision
 * insert, the deactivation and the inserts of the rules, the audit, the commit.
 */
class RulesSave {
  private revisionId: number | null = null;

  constructor(private readonly client: PoolClient, private readonly vendorId: number, private readonly key: string,
    private readonly rules: readonly SaveRule[]) {}

  async begin(): Promise<void> {
    await this.client.query("BEGIN");
    await this.client.query(DROPSHIP_VENDOR_SELECTION_LOCK_SQL, [this.vendorId]);
  }

  async replayRead(): Promise<void> {
    await this.client.query(`SELECT id, request_hash FROM dropship.dropship_vendor_selection_rule_set_revisions
      WHERE vendor_id = $1 AND idempotency_key = $2 FOR UPDATE`, [this.vendorId, this.key]);
    await this.client.query(`SELECT id FROM dropship.dropship_vendor_selection_rules WHERE vendor_id = $1 AND is_active = true
      ORDER BY is_active DESC, priority DESC, id ASC`, [this.vendorId]);
  }

  async insertRevision(): Promise<void> {
    const inserted = await this.client.query<{ id: number }>(`INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions
      (vendor_id, idempotency_key, request_hash, actor_type, actor_id, rule_count, created_at)
      VALUES ($1, $2, $3, 'vendor', $4, $5, $6) RETURNING id`,
    [this.vendorId, this.key, "b".repeat(64), `member-${this.vendorId}`, this.rules.length, "2026-10-24T08:00:00Z"]);
    this.revisionId = inserted.rows[0]!.id;
  }

  async writeRules(): Promise<void> {
    await this.client.query(`UPDATE dropship.dropship_vendor_selection_rules SET is_active = false, updated_at = $2
      WHERE vendor_id = $1 AND is_active = true`, [this.vendorId, "2026-10-24T08:00:00Z"]);
    for (const rule of this.rules) {
      await this.client.query(`INSERT INTO dropship.dropship_vendor_selection_rules
        (revision_id, vendor_id, scope_type, action, product_line_id, product_id, product_variant_id, category,
         auto_connect_new_skus, auto_list_new_skus, priority, is_active, metadata, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, 0, true, '{}'::jsonb, $9, $9)`,
      [this.revisionId, this.vendorId, rule.scopeType, rule.action, rule.productLineId ?? null, rule.productId ?? null,
        rule.productVariantId ?? null, rule.category ?? null, "2026-10-24T08:00:00Z"]);
    }
  }

  async commit(): Promise<void> {
    await this.client.query(`INSERT INTO dropship.dropship_audit_events
      (vendor_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
      VALUES ($1, 'dropship_vendor_selection_ruleset', $2, 'vendor_selection_rules_replaced', 'vendor', $3, 'info', '{}'::jsonb, $4)`,
    [this.vendorId, String(this.revisionId), `member-${this.vendorId}`, "2026-10-24T08:00:00Z"]);
    await this.client.query("COMMIT");
  }

  async rollback(): Promise<void> {
    await this.client.query("ROLLBACK");
  }
}

/** Vendor 302's rules match nothing in the oracle seed; this save gives it a size and a category. */
const SAVE_RULES: readonly SaveRule[] = [
  { scopeType: "variant", action: "include", productVariantId: 2011 },
  { scopeType: "category", action: "include", category: "Toploaders" },
];
/** Size 2011 by its variant include; 2061 and 2062 are product 1007's ("Toploaders"). */
const SAVED_PICKS = ["302:2011", "302:2061", "302:2062"];

describeDatabase.sequential("picks migration: the conversion on the real 0743 path (PostgreSQL)", () => {
  let db: PicksDatabase;
  let applied: AppliedMigration;
  let workBeforeMigration: Awaited<ReturnType<typeof selectionWork>>;

  beforeAll(async () => {
    db = await createPicksDatabase([selectionOracleSeedSql, conversionEdgeSeedSql]);
    // A holder of the shared selection gate for the whole file: the file must not need the gate (§6 step 7).
    const gate = await db.pool.connect();
    const client = await db.pool.connect();
    try {
      await gate.query("BEGIN");
      await gate.query(SELECTION_GATE_SQL);
      workBeforeMigration = await selectionWork(db.pool);
      applied = await applyPicksMigration(client);
    } finally {
      await gate.query("COMMIT");
      gate.release();
      client.release();
    }
  }, LOCK_CASE_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  it("applies in one attempt while the selection gate is held, and queues no publication work", async () => {
    expect(applied.attempts).toBe(1);
    expect(applied.notices).toEqual([]);
    expect(workBeforeMigration.length).toBe(3);
    expect(await selectionWork(db.pool)).toEqual(workBeforeMigration);
    const recorded = await db.pool.query<{ filename: string }>("SELECT filename FROM public._migrations");
    expect(recorded.rows.map((row) => row.filename)).toEqual([SELECTED_VARIANTS_MIGRATION_FILE]);
  });

  it("picks exactly the sizes the frozen oracle's rule part picks, for every vendor and size (§6 step 4)", async () => {
    const picks = await storedPicks(db.pool);
    expect(picks).toEqual(await oracleRulePicks(db.pool));
    const vendors = new Set(picks.map((key) => Number(key.split(":")[0])));
    // 302's rules and 308's inactive one match nothing; 310 has no rules.
    expect([...vendors].sort()).toEqual([301, 303, 304, 305, 306, 307, 309]);
    // Non-sellable (2003), inactive (2004) and never-offered sizes are picked when a rule matches them.
    for (const key of ["301:2003", "301:2004", "304:2003", "306:2051"]) expect(picks).toContain(key);
    // The category spellings of the oracle seed (case, tab, no-break space, trailing space) all matched as JS does.
    expect(picks.filter((key) => key.startsWith("304:"))).toEqual(
      ["304:2001", "304:2003", "304:2004", "304:2011", "304:2012", "304:2031", "304:2041", "304:2051", "304:2061", "304:2062", "304:2071"]);
    expect(picks.filter((key) => key.startsWith("305:"))).toEqual(["305:2041", "305:2061", "305:2062"]);
  });

  it("gives overlapping includes one pick, sourced from the variant include (SAFETY-2)", async () => {
    const overlap = await db.pool.query<{ source: string; count: number }>(`SELECT source, count(*)::int AS count
      FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = 303 AND product_variant_id = 2001 GROUP BY source`);
    expect(overlap.rows).toEqual([{ source: "legacy_variant_rule", count: 1 }]);
    const variantSourced = await db.pool.query<{ key: string }>(`SELECT vendor_id || ':' || product_variant_id AS key
      FROM dropship.dropship_vendor_selected_variants WHERE source = 'legacy_variant_rule' ORDER BY vendor_id, product_variant_id`);
    expect(variantSourced.rows.map((row) => row.key)).toEqual(["303:2001", "305:2041", "307:2001", "309:2002"]);
    const sources = await db.pool.query<{ source: string }>("SELECT DISTINCT source FROM dropship.dropship_vendor_selected_variants ORDER BY source");
    expect(sources.rows.map((row) => row.source)).toEqual(["legacy_broad_rule", "legacy_variant_rule"]);
  });

  it("selects, for every (vendor, size) at three times, exactly what A's evaluator selected under the rules", async () => {
    const inputs = await loadSelectionOracleInputs(db.pool);
    const picked = new Set(await storedPicks(db.pool));
    const mismatches: string[] = [];
    const reasons = new Set<string>();
    let compared = 0;
    for (const time of Object.keys(SELECTION_ORACLE_TIMES) as SelectionOracleTime[]) {
      for (const store of inputs.stores) {
        for (const candidate of inputs.candidates) {
          const exposure = evaluateDropshipCatalogExposure(candidate, inputs.adminRules, SELECTION_ORACLE_TIMES[time]);
          const override = inputs.overrides.get(`${store.vendorId}:${candidate.productVariantId}`) ?? null;
          const oracle = legacyEvaluateVendorSelection({
            candidate, adminExposureDecision: exposure, rules: inputs.vendorRules.get(store.vendorId) ?? [], override,
            rawAtpUnits: 0, applyMarketplaceQuantityCap: false,
          });
          // B's evaluator (§7.1; the §6 step 4 proof) fed the stored pick.
          const selectedFromPicks = evaluateDropshipVendorCatalogSelection({
            candidate, adminExposureDecision: exposure, picked: picked.has(`${store.vendorId}:${candidate.productVariantId}`), override,
            rawAtpUnits: 0, applyMarketplaceQuantityCap: false,
          }).selected;
          reasons.add(oracle.reason);
          compared += 1;
          if (oracle.selected !== selectedFromPicks) {
            mismatches.push(`${time} vendor ${store.vendorId} store ${store.id} size ${candidate.productVariantId}: ${oracle.reason}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBe(3 * inputs.stores.length * inputs.candidates.length);
    expect([...reasons].sort()).toEqual(["disabled_by_vendor_override", "excluded_by_vendor_rule", "missing_vendor_include_rule",
      "not_exposed_by_admin", "selected"]);
  });

  it("writes one backfill revision per vendor with an active rule, keyed past the head revision (§6 step 3, SAFETY-10)", async () => {
    const inputs = await loadSelectionOracleInputs(db.pool);
    const revisions = await db.pool.query<{ id: number; vendor_id: number; idempotency_key: string; request_hash: string;
      actor_type: string; actor_id: string | null; rule_count: number; pick_count: number | null; request_kind: string; result: unknown }>(
      `SELECT id, vendor_id, idempotency_key, request_hash, actor_type, actor_id, rule_count, pick_count, request_kind, result
       FROM dropship.dropship_vendor_selection_rule_set_revisions ORDER BY id`);
    const saved = revisions.rows.filter((row) => row.request_kind !== "picks_backfill");
    expect(saved).toEqual([expect.objectContaining({ id: 77, request_kind: "rules_replace", pick_count: null, result: null })]);
    const backfill = revisions.rows.filter((row) => row.request_kind === "picks_backfill");
    expect(backfill.map((row) => row.vendor_id)).toEqual([301, 302, 303, 304, 305, 306, 307, 309]);
    const picks = await storedPicks(db.pool);
    for (const row of backfill) {
      const activeRules = (inputs.vendorRules.get(row.vendor_id) ?? []).filter((rule) => rule.isActive);
      expect(row).toMatchObject({
        idempotency_key: `legacy-picks-backfill:${row.vendor_id}:77`, request_hash: "0".repeat(64), actor_type: "system",
        actor_id: null, rule_count: activeRules.length, pick_count: picks.filter((key) => key.startsWith(`${row.vendor_id}:`)).length,
        result: null,
      });
      expect(isReservedSelectionIdempotencyKey(row.idempotency_key)).toBe(true);
    }
    // Every pick is under its vendor's backfill revision.
    const orphans = await db.pool.query(`SELECT 1 FROM dropship.dropship_vendor_selected_variants s
      JOIN dropship.dropship_vendor_selection_rule_set_revisions rev ON rev.id = s.revision_id
      WHERE rev.vendor_id <> s.vendor_id OR rev.request_kind <> 'picks_backfill'`);
    expect(orphans.rowCount).toBe(0);
  });

  it("records each converted vendor with a broad rule, its notice due only for a broad include (§6 step 5)", async () => {
    const records = await db.pool.query(`SELECT c.vendor_id, c.broad_rule_ids, c.followup_state, c.followup_at, c.followup_failures,
        c.notice_state, c.notice_at, c.last_error_code, rev.request_kind, rev.vendor_id = c.vendor_id AS own_revision
      FROM dropship.dropship_selection_conversions c
      JOIN dropship.dropship_vendor_selection_rule_set_revisions rev ON rev.id = c.backfill_revision_id ORDER BY c.vendor_id`);
    const open = { followup_state: "pending", followup_at: null, followup_failures: 0, notice_at: null, last_error_code: null,
      request_kind: "picks_backfill", own_revision: true };
    expect(records.rows).toEqual([
      { vendor_id: 301, broad_rule_ids: [11], notice_state: "pending", ...open },
      { vendor_id: 302, broad_rule_ids: [22, 23], notice_state: "pending", ...open },
      { vendor_id: 303, broad_rule_ids: [31, 32, 34], notice_state: "pending", ...open },
      { vendor_id: 304, broad_rule_ids: [41, 43, 44], notice_state: "pending", ...open },
      { vendor_id: 305, broad_rule_ids: [51, 52, 53], notice_state: "pending", ...open },
      { vendor_id: 306, broad_rule_ids: [61], notice_state: "pending", ...open },
      { vendor_id: 307, broad_rule_ids: [72], notice_state: "not_needed", ...open },
    ]);
    // Every record is in the partial index the follow-up reads.
    const due = await db.pool.query("SELECT count(*)::int AS count FROM dropship.dropship_selection_conversions WHERE followup_state = 'pending' OR notice_state = 'pending'");
    expect(due.rows[0].count).toBe(7);
  });

  it("audits each conversion with the rules read, the counts by source and every picked size (§6 step 6)", async () => {
    const inputs = await loadSelectionOracleInputs(db.pool);
    const picks = await storedPicks(db.pool);
    const audit = await db.pool.query<{ vendor_id: number; entity_type: string; entity_id: string; event_type: string;
      actor_type: string; actor_id: string | null; severity: string; payload: { revisionId: number; ruleIds: number[];
        pickCountsBySource: { legacy_variant_rule: number; legacy_broad_rule: number }; pickedVariantIds: number[] } }>(
      `SELECT vendor_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload
       FROM dropship.dropship_audit_events ORDER BY id`);
    expect(audit.rows.map((row) => row.vendor_id)).toEqual([301, 302, 303, 304, 305, 306, 307, 309]);
    for (const row of audit.rows) {
      expect(row).toMatchObject({ entity_type: "dropship_vendor_selection_ruleset", event_type: "vendor_selection_picks_backfilled",
        actor_type: "system", actor_id: null, severity: "info" });
      expect(row.entity_id).toBe(String(row.payload.revisionId));
      const activeRuleIds = (inputs.vendorRules.get(row.vendor_id) ?? []).filter((rule) => rule.isActive)
        .map((rule) => rule.id!).sort((left, right) => left - right);
      expect(row.payload.ruleIds).toEqual(activeRuleIds);
      const vendorPicks = picks.filter((key) => key.startsWith(`${row.vendor_id}:`)).map((key) => Number(key.split(":")[1]))
        .sort((left, right) => left - right);
      expect(row.payload.pickedVariantIds).toEqual(vendorPicks);
      expect(row.payload.pickCountsBySource.legacy_variant_rule + row.payload.pickCountsBySource.legacy_broad_rule).toBe(vendorPicks.length);
    }
    expect(audit.rows.find((row) => row.vendor_id === 303)!.payload.pickCountsBySource).toEqual({ legacy_variant_rule: 1, legacy_broad_rule: 13 });
  });

  it("freezes every rules write before the selection gate, and leaves the rules active (§6 step 8)", async () => {
    const activeBefore = (await db.pool.query("SELECT count(*)::int AS count FROM dropship.dropship_vendor_selection_rules WHERE is_active")).rows[0].count;
    const gate = await db.pool.connect();
    try {
      await gate.query("BEGIN");
      await gate.query(SELECTION_GATE_SQL);
      for (const write of [
        "UPDATE dropship.dropship_vendor_selection_rules SET is_active = false WHERE vendor_id = 301",
        "DELETE FROM dropship.dropship_vendor_selection_rules WHERE id = 11",
        `INSERT INTO dropship.dropship_vendor_selection_rules (vendor_id, scope_type, action, is_active) VALUES (310, 'catalog', 'include', true)`,
        // A statement that touches no row is refused too (the trigger is per statement).
        "UPDATE dropship.dropship_vendor_selection_rules SET priority = priority WHERE vendor_id = 310",
      ]) {
        // With the gate held, a gate first would answer 55P03 PUBLICATION_SELECTION_BUSY: the freeze fires first.
        const error = await pgErrorOf(db.pool.query(write));
        expect({ code: error.code, message: error.message }).toEqual({ code: "P0001", message: RULES_RETIRED_MESSAGE });
      }
      // The picks themselves are gated: a pick write with the gate held is BUSY.
      const busy = await pgErrorOf(db.pool.query(`INSERT INTO dropship.dropship_vendor_selected_variants
        (vendor_id, product_variant_id, revision_id, source, selected_at)
        SELECT 302, 2001, id, 'vendor', now() FROM dropship.dropship_vendor_selection_rule_set_revisions
        WHERE vendor_id = 302 AND request_kind = 'picks_backfill'`));
      expect({ code: busy.code, message: busy.message }).toEqual({ code: "55P03", message: "PUBLICATION_SELECTION_BUSY" });
    } finally {
      await gate.query("COMMIT");
      gate.release();
    }
    expect((await db.pool.query("SELECT count(*)::int AS count FROM dropship.dropship_vendor_selection_rules WHERE is_active")).rows[0].count)
      .toBe(activeBefore);
    // Reads go through.
    expect((await db.pool.query("SELECT count(*)::int AS count FROM dropship.dropship_vendor_selection_rules")).rows[0].count).toBe(24);
  });

  it("re-plans only the product whose pick changed (§6 step 7)", async () => {
    const revision = (await db.pool.query<{ id: number }>(`SELECT id FROM dropship.dropship_vendor_selection_rule_set_revisions
      WHERE vendor_id = 302 AND request_kind = 'picks_backfill'`)).rows[0]!.id;
    const revisionsOf = async () => Object.fromEntries((await selectionWork(db.pool)).map((row) => [row.product_id, Number(row.revision)]));
    const start = await revisionsOf();
    expect(Object.keys(start).map(Number)).toEqual([1001, 1005, 1007]);
    await db.pool.query(`INSERT INTO dropship.dropship_vendor_selected_variants (vendor_id, product_variant_id, revision_id, source, selected_at)
      VALUES (302, 2001, $1, 'vendor', now())`, [revision]);
    const added = await revisionsOf();
    expect(added).toEqual({ ...start, 1001: start[1001]! + 1 });
    await db.pool.query("UPDATE dropship.dropship_vendor_selected_variants SET product_variant_id = 2041 WHERE vendor_id = 302 AND product_variant_id = 2001");
    const moved = await revisionsOf();
    expect(moved).toEqual({ ...added, 1001: added[1001]! + 1, 1005: added[1005]! + 1 });
    // A write that changes no watched column re-plans nothing.
    await db.pool.query("UPDATE dropship.dropship_vendor_selected_variants SET selected_at = now() WHERE vendor_id = 302");
    expect(await revisionsOf()).toEqual(moved);
    await db.pool.query("DELETE FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = 302");
    expect(await revisionsOf()).toEqual({ ...moved, 1005: moved[1005]! + 1 });
  });

  it("lets the catalog delete a picked, unlisted size and its picks with it; a listed size stays undeletable (CHK5)", async () => {
    const picksOf = async (sizeId: number) => (await db.pool.query<{ vendor_id: number }>(
      "SELECT vendor_id FROM dropship.dropship_vendor_selected_variants WHERE product_variant_id = $1 ORDER BY vendor_id", [sizeId]))
      .rows.map((row) => row.vendor_id);
    expect(await picksOf(2004)).toEqual([301, 303, 304, 306]);
    await db.pool.query("DELETE FROM catalog.product_variants WHERE id = 2004");
    expect(await picksOf(2004)).toEqual([]);
    expect(await picksOf(2001)).toEqual([301, 303, 304, 306, 307]);
    const listed = await pgErrorOf(db.pool.query("DELETE FROM catalog.product_variants WHERE id = 2001"));
    expect(listed.code).toBe("23503");
    expect(await picksOf(2001)).toEqual([301, 303, 304, 306, 307]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// B1d: the readers on the converted schema (PLAN-B v4.1 §9, §15.3; V15, V17, V21, R5).
// ---------------------------------------------------------------------------------------------------------

/**
 * The listing states of map-interactions §3 the oracle seed does not already hold (it has a live listing
 * 901, limits 5 and 0 on 902 and 905, an ended one 903, a queued first push 904, a failed one without ids
 * 934, a paused listing 943, a paused store 406 and a draft-first store 407): ended on eBay then queued
 * (971), failed (972) and blocked (973); eBay's stock-out end (974); a push in progress (975); a first push
 * blocked before anything was published (976); a draft listing on the draft-first store (977).
 */
const readerStatesSeedSql = `
  INSERT INTO dropship.dropship_vendor_listings (id, vendor_id, store_connection_id, product_variant_id, platform, status,
    external_listing_id, external_offer_id, vendor_quantity_limit, marketplace_ended_at, marketplace_issue_codes,
    created_at, updated_at) OVERRIDING SYSTEM VALUE VALUES
    (971, 301, 401, 2031, 'ebay', 'queued', 'L-971', 'O-971', NULL, '2026-10-22T08:00:00Z', '{}', '2026-10-21T08:00:00Z', '2026-10-23T08:00:00Z'),
    (972, 303, 403, 2011, 'ebay', 'failed', 'L-972', 'O-972', NULL, '2026-10-22T08:00:00Z', '{}', '2026-10-21T08:00:00Z', '2026-10-23T08:00:00Z'),
    (973, 303, 403, 2021, 'ebay', 'blocked', 'L-973', 'O-973', NULL, '2026-10-22T08:00:00Z', '{}', '2026-10-21T08:00:00Z', '2026-10-23T08:00:00Z'),
    (974, 301, 401, 2012, 'ebay', 'active', 'L-974', 'O-974', NULL, NULL, '{ended_out_of_stock}', '2026-10-21T08:00:00Z', '2026-10-23T08:00:00Z'),
    (975, 304, 404, 2011, 'ebay', 'pushing', NULL, NULL, NULL, NULL, '{}', '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (976, 304, 404, 2061, 'ebay', 'blocked', NULL, NULL, NULL, NULL, '{}', '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (977, 301, 407, 2002, 'ebay', 'preview_ready', NULL, NULL, NULL, NULL, '{}', '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z');
  INSERT INTO dropship.dropship_listing_push_jobs (id, vendor_id, store_connection_id, job_type, status, created_at, updated_at)
    OVERRIDING SYSTEM VALUE VALUES (1052, 304, 404, 'push', 'processing', '2026-10-23T07:00:00Z', '2026-10-23T07:00:00Z');
  INSERT INTO dropship.dropship_listing_push_job_items (id, job_id, listing_id, product_variant_id, action, status, result, created_at)
    OVERRIDING SYSTEM VALUE VALUES
    (1105, 1052, 975, 2011, 'push', 'processing', '{"listingIntent":{"platform":"ebay","productVariantId":2011,"listingMode":"live","inventoryMode":"managed_quantity_sync"}}', '2026-10-23T08:30:00Z'),
    (1106, 1052, 976, 2061, 'push', 'blocked', '{"listingIntent":{"platform":"ebay","productVariantId":2061,"listingMode":"live","inventoryMode":"managed_quantity_sync"}}', '2026-10-23T08:30:00Z');
`;

/** The selected-catalog keyset's sellable filter (dropship-selected-catalog.reader.ts), read from the seeded rows. */
async function sellableSizeIds(pool: Pool): Promise<number[]> {
  return (await pool.query<{ id: number }>(`SELECT id FROM catalog.product_variants
    WHERE requires_shipping = true AND COALESCE(track_inventory, true) = true AND sales_eligibility = 'sellable' ORDER BY id`))
    .rows.map((row) => row.id);
}

async function allSizeIds(pool: Pool): Promise<number[]> {
  return (await pool.query<{ id: number }>("SELECT id FROM catalog.product_variants ORDER BY id")).rows.map((row) => row.id);
}

function picksOfVendor(picks: readonly string[], vendorId: number): number[] {
  return picks.filter((key) => key.startsWith(`${vendorId}:`)).map((key) => Number(key.split(":")[1])).sort((left, right) => left - right);
}

/**
 * A listing as the stock decision receives it from SPR: the effects reader's row without #1900's end facts and
 * without PR C's end request id and push-in-flight flag (SPR reads only the open end's state, PLAN-C v4.1 §7).
 */
function withoutEndFacts(input: StockDecisionInput): StockDecisionInput {
  if (!input.listing) return input;
  const { marketplaceEndedAt: _ended, marketplaceIssueCodes: _issues, openEndId: _endId, pushInFlight: _inFlight, ...listing } =
    input.listing as StockDecisionInput["listing"]
      & { marketplaceEndedAt?: unknown; marketplaceIssueCodes?: unknown; openEndId?: unknown; pushInFlight?: unknown };
  return { ...input, listing };
}

describeDatabase.sequential("picks migration: the readers on the converted schema (PostgreSQL)", () => {
  let db: PicksDatabase;
  let client: PoolClient;
  let picks: string[];
  const vendorsWithStores = [301, 302, 303, 304, 305, 306];
  const vendorsWithRules = [301, 302, 303, 304, 305, 306, 307, 308, 309, 310];

  beforeAll(async () => {
    db = await createPicksDatabase([selectionOracleSeedSql, conversionEdgeSeedSql, readerStatesSeedSql]);
    client = await db.pool.connect();
    await applyPicksMigration(client);
    picks = await storedPicks(db.pool);
  }, LOCK_CASE_TIMEOUT_MS);

  afterAll(async () => {
    client?.release();
    await db?.close();
  });

  it("looks a vendor's picks up among given sizes only: the bounded lookup step 2's readers use (§9 rows 1, 2)", async () => {
    const reader = PgDropshipListingPreviewRepository.readerForTransaction(client);
    const sizes = await allSizeIds(db.pool);
    for (const vendorId of vendorsWithRules) {
      expect([...(await reader.listPickedVariantIds(vendorId, sizes))].sort((left, right) => left - right), `vendor ${vendorId}`)
        .toEqual(picksOfVendor(picks, vendorId));
    }
    // Only the sizes asked about, each once; none asked, nothing read.
    expect([...(await reader.listPickedVariantIds(301, [2002, 2001, 2001, 2999]))].sort()).toEqual([2001, 2002]);
    expect(await reader.listPickedVariantIds(301, [])).toEqual(new Set());
  });

  it("walks only the vendor's picked sellable sizes in the selected-catalog keyset; the arrivals keyset walks every sellable size (§9 row 3)", async () => {
    const sellable = await sellableSizeIds(db.pool);
    for (const vendorId of vendorsWithRules) {
      const reader = selectedCatalogReaderForTransaction(client, vendorId);
      expect(reader.vendorId).toBe(vendorId);
      const walked: number[] = [];
      // A batch of 2 so the keyset turns more than once.
      for (let afterId = 0, batch = await reader.listVariantIds(afterId, 2); batch.length; batch = await reader.listVariantIds(afterId, 2)) {
        walked.push(...batch);
        afterId = batch[batch.length - 1]!;
      }
      const picked = picksOfVendor(picks, vendorId);
      expect(walked, `vendor ${vendorId}`).toEqual(picked.filter((id) => sellable.includes(id)));
      // FIDELITY-3: never a sellable size the vendor did not pick.
      expect(walked.filter((id) => !picked.includes(id))).toEqual([]);
    }
    // 2003 (internal only), 2012 (no shipping) and 2062 (no inventory tracking) are picked by 301 but never walked.
    expect(picksOfVendor(picks, 301)).toEqual(expect.arrayContaining([2003, 2012, 2062]));
    expect(await listSellableVariantIdsAfter(client, 0, 100)).toEqual(sellable);
    expect(await listSellableVariantIdsAfter(client, 2041, 2)).toEqual(sellable.filter((id) => id > 2041).slice(0, 2));
  });

  it("selects through the picks exactly what A's scan selected under the rules, for every vendor at three times (§9 rows 3, 3b)", async () => {
    const inputs = await loadSelectionOracleInputs(db.pool);
    const sellable = new Set(await sellableSizeIds(db.pool));
    const sizes = await allSizeIds(db.pool);
    const mismatches: string[] = [];
    let selectedSomewhere = 0;
    for (const time of Object.keys(SELECTION_ORACLE_TIMES) as SelectionOracleTime[]) {
      const now = SELECTION_ORACLE_TIMES[time];
      for (const vendorId of vendorsWithRules) {
        // A's selected-catalog scan at cea5cb027: every sellable size, exposed and selected by the vendor's rules.
        const expected = inputs.candidates.filter((candidate) => {
          if (!sellable.has(candidate.productVariantId)) return false;
          const exposure = evaluateDropshipCatalogExposure(candidate, inputs.adminRules, now);
          return exposure.exposed && legacyEvaluateVendorSelection({
            candidate, adminExposureDecision: exposure, rules: inputs.vendorRules.get(vendorId) ?? [],
            override: inputs.overrides.get(`${vendorId}:${candidate.productVariantId}`) ?? null,
            rawAtpUnits: 0, applyMarketplaceQuantityCap: false,
          }).selected;
        }).map((candidate) => candidate.productVariantId).sort((left, right) => left - right);
        selectedSomewhere += expected.length;
        const reader = selectedCatalogReaderForTransaction(client, vendorId);
        const scanned = await loadSelectedVariantIds(reader, now, "listing_push_run");
        const among = [...await selectedVariantIdsAmong(reader, sizes, now)].sort((left, right) => left - right);
        const counted = await countSelectedVariants(reader, now, new Set([2001]));
        const label = `${time} vendor ${vendorId}`;
        if (JSON.stringify(scanned) !== JSON.stringify(expected)) mismatches.push(`${label}: scan ${scanned} != ${expected}`);
        if (JSON.stringify(among) !== JSON.stringify(expected)) mismatches.push(`${label}: among ${among} != ${expected}`);
        if (counted.selected !== expected.length || counted.selectedAmong !== (expected.includes(2001) ? 1 : 0)) {
          mismatches.push(`${label}: count ${JSON.stringify(counted)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(selectedSomewhere).toBeGreaterThan(0);
  });

  it("counts the vendor's picks for onboarding, the old field kept with the same value (§9 row 7, V17)", async () => {
    const provisioning = new PgDropshipVendorProvisioningRepository(db.pool);
    for (const vendorId of vendorsWithRules) {
      const count = picksOfVendor(picks, vendorId).length;
      expect(await provisioning.getCatalogSetupSummary(vendorId), `vendor ${vendorId}`)
        .toEqual({ adminExposureRuleCount: 1, vendorSelectedItemCount: count, vendorSelectionRuleCount: count });
    }
    // 302's rules match nothing: frozen rules alone are no selection.
    expect((await provisioning.getCatalogSetupSummary(302)).vendorSelectedItemCount).toBe(0);
  });

  it("gives the stock decision the same input from the effects reader as from SPR, for every listing state (R5, V21)", async () => {
    const now = SELECTION_ORACLE_TIMES.T2;
    const sizes = await allSizeIds(db.pool);
    const listingIds = (await db.pool.query<{ id: number }>("SELECT id FROM dropship.dropship_vendor_listings ORDER BY id"))
      .rows.map((row) => row.id);
    const stores = (await db.pool.query<{ id: number }>("SELECT id FROM dropship.dropship_store_connections ORDER BY id")).rows;
    const products = (await db.pool.query<{ id: number; sizes: number[] }>(`SELECT p.id, array_agg(pv.id ORDER BY pv.id) AS sizes
      FROM catalog.products p JOIN catalog.product_variants pv ON pv.product_id = p.id GROUP BY p.id ORDER BY p.id`)).rows;

    // SPR: every (store, product) read, as the stock publication runtime makes it.
    const fromSpr = new Map<number, StockDecisionInput>();
    stockDecisionRecorder.inputs = [];
    stockDecisionRecorder.recording = true;
    try {
      for (const store of stores) {
        for (const product of products) {
          await readDropshipListingStockSelection(client, { storeConnectionId: store.id, productId: product.id, productVariantIds: product.sizes, now });
        }
      }
    } finally {
      stockDecisionRecorder.recording = false;
    }
    for (const input of stockDecisionRecorder.inputs as StockDecisionInput[]) {
      if (input.listing) fromSpr.set(input.listing.id, input);
    }

    // The effects reader for every vendor and every size, decided as a save that flips every pick: the first
    // decision of each listing is its decision under today's picks, which is what SPR decides.
    const fromEffects = new Map<number, StockDecisionInput>();
    const entries: number[] = [];
    for (const vendorId of vendorsWithStores) {
      const facts = await readDropshipSelectionEffectsFacts(client, { vendorId, productVariantIds: sizes });
      stockDecisionRecorder.inputs = [];
      stockDecisionRecorder.recording = true;
      try {
        const effects = decideSelectionEffects({
          now, insertIds: sizes.filter((id) => !facts.pickedBefore.has(id)), deleteIds: sizes.filter((id) => facts.pickedBefore.has(id)),
          candidates: facts.candidates, adminRules: facts.adminRules, overrides: facts.overrides, stores: facts.stores,
          // PR C: no end planned, so every listing keeps B's quantity decision, the one compared with SPR's here.
          ends: { endPlans: [], hiddenRemovedIds: [], supersedeIds: [], stillEnding: [], endReview: [], endedReAdd: [] },
        });
        entries.push(...effects.entries.map((entry) => entry[1]));
      } finally {
        stockDecisionRecorder.recording = false;
      }
      for (const input of stockDecisionRecorder.inputs as StockDecisionInput[]) {
        if (input.listing && !fromEffects.has(input.listing.id)) fromEffects.set(input.listing.id, input);
      }
      expect(facts.pickedBefore, `vendor ${vendorId}`).toEqual(new Set(picksOfVendor(picks, vendorId)));
    }

    expect([...fromSpr.keys()].sort((left, right) => left - right)).toEqual(listingIds);
    expect([...fromEffects.keys()].sort((left, right) => left - right)).toEqual(listingIds);
    for (const id of listingIds) expect(withoutEndFacts(fromEffects.get(id)!), `listing ${id}`).toEqual(fromSpr.get(id));
    // The end facts reach the effects decision (§7.6): the states above carry them.
    const endFacts = (id: number) => {
      // The effects reader's row (SelectionEffectsListing): the stock decision's listing state plus #1900's end facts.
      const listing = fromEffects.get(id)!.listing as SelectionEffectsListing;
      return [listing.marketplaceEndedAt?.toISOString() ?? null, listing.marketplaceIssueCodes];
    };
    expect([971, 972, 973, 974, 901].map(endFacts)).toEqual([["2026-10-22T08:00:00.000Z", []], ["2026-10-22T08:00:00.000Z", []],
      ["2026-10-22T08:00:00.000Z", []], [null, ["ended_out_of_stock"]], [null, []]]);
    // Nothing on eBay (no identity) and anything ended on eBay is never an effect; a live listing is.
    expect(entries.filter((id) => [903, 904, 934, 971, 972, 973, 974, 975, 976, 977].includes(id))).toEqual([]);
    expect(entries).toContain(901);
  });

  // V15 (FIDELITY-12): the lifecycle reader's input is SPR's `listingSelected`, now from the picks.
  it("answers listingSelected from the picks: a removed pick turns a live listing to zero, the other sizes keep their answer (V15)", async () => {
    const read = () => readDropshipListingStockSelection(client, { storeConnectionId: 401, productId: 1001,
      productVariantIds: [2001, 2002, 2003, 2004], now: SELECTION_ORACLE_TIMES.T2 });
    const before = await read();
    expect(before.variants.find((variant) => variant.productVariantId === 2001)).toMatchObject({ action: "publish", listingSelected: true });
    await db.pool.query("DELETE FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = 301 AND product_variant_id = 2001");
    const after = await read();
    expect(after.variants.find((variant) => variant.productVariantId === 2001))
      .toMatchObject({ action: "zero", reason: "missing_vendor_include_rule", listingSelected: false });
    expect(after.variants.filter((variant) => variant.productVariantId !== 2001))
      .toEqual(before.variants.filter((variant) => variant.productVariantId !== 2001));
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});

describeDatabase.sequential("picks migration: lock order against a rules save and a SHARE holder (PostgreSQL)", () => {
  it.each(["replay read", "revision insert", "rules writes"] as const)(
    "a save holding its %s when the file starts finishes first and is converted, with no deadlock (CHK1)", async (point) => {
      const db = await createPicksDatabase([selectionOracleSeedSql]);
      const saveClient = await db.pool.connect();
      const migrationClient = await db.pool.connect();
      try {
        const save = new RulesSave(saveClient, 302, `vendor-save-${point.replace(" ", "-")}`, SAVE_RULES);
        await save.begin();
        await save.replayRead();
        if (point !== "replay read") await save.insertRevision();
        if (point === "rules writes") await save.writeRules();
        const migrationPid = await backendPid(migrationClient);
        const migration = startPicksMigration(migrationClient);
        await waitFor(() => isWaitingOnLock(db.pool, migrationPid), "the file to wait behind the save");
        // The save goes on while the file waits: ahead of it in the lock queue, it needs nothing the file holds.
        if (point === "replay read") await save.insertRevision();
        if (point !== "rules writes") await save.writeRules();
        await save.commit();
        const outcome = await migration;
        expect(outcome.error).toBeUndefined();
        expect(outcome.applied!.notices).toEqual([]);
        expect(outcome.applied!.attempts).toBe(1);
        const picks = await storedPicks(db.pool);
        expect(picks.filter((key) => key.startsWith("302:"))).toEqual(SAVED_PICKS);
        expect(picks).toEqual(await oracleRulePicks(db.pool));
        const revisions = await db.pool.query<{ idempotency_key: string; request_kind: string; rule_count: number }>(
          "SELECT idempotency_key, request_kind, rule_count FROM dropship.dropship_vendor_selection_rule_set_revisions WHERE vendor_id = 302 ORDER BY id");
        expect(revisions.rows).toEqual([
          { idempotency_key: `vendor-save-${point.replace(" ", "-")}`, request_kind: "rules_replace", rule_count: 2 },
          { idempotency_key: "legacy-picks-backfill:302:1", request_kind: "picks_backfill", rule_count: 2 },
        ]);
      } finally {
        await saveClient.query("ROLLBACK").catch(() => undefined);
        saveClient.release();
        migrationClient.release();
        await db.close();
      }
    }, LOCK_CASE_TIMEOUT_MS);

  it("a save that has not read when the file takes its locks waits for the file, then meets the freeze (CHK1)", async () => {
    const db = await createPicksDatabase([selectionOracleSeedSql]);
    const holder = await db.pool.connect();
    const saveClient = await db.pool.connect();
    const migrationClient = await db.pool.connect();
    try {
      // A SHARE holder keeps the file at its second lock, holding the revisions, while the save starts.
      await holder.query("BEGIN");
      await holder.query(A_LISTING_SELECTION_LOCK_SQL);
      const save = new RulesSave(saveClient, 302, "vendor-save-late", SAVE_RULES);
      await save.begin();
      const migrationPid = await backendPid(migrationClient);
      const migration = startPicksMigration(migrationClient);
      await waitFor(() => isWaitingOnLock(db.pool, migrationPid), "the file to wait behind the SHARE holder");
      const savePid = await backendPid(saveClient);
      const saving = (async () => {
        await save.replayRead();
        await save.insertRevision();
        await save.writeRules();
      })().then(() => null, (error: { code?: string; message?: string }) => error);
      await waitFor(() => isWaitingOnLock(db.pool, savePid), "the save's replay read to wait behind the file");
      await holder.query("COMMIT");
      const outcome = await migration;
      expect(outcome.error).toBeUndefined();
      expect(outcome.applied!.notices).toEqual([]);
      const refused = await saving;
      expect({ code: refused?.code, message: refused?.message }).toEqual({ code: "P0001", message: RULES_RETIRED_MESSAGE });
      await save.rollback();
      const picks = await storedPicks(db.pool);
      expect(picks.filter((key) => key.startsWith("302:"))).toEqual([]);
      expect(picks).toEqual(await oracleRulePicks(db.pool));
      const late = await db.pool.query("SELECT 1 FROM dropship.dropship_vendor_selection_rule_set_revisions WHERE idempotency_key = 'vendor-save-late'");
      expect(late.rowCount).toBe(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await saveClient.query("ROLLBACK").catch(() => undefined);
      holder.release();
      saveClient.release();
      migrationClient.release();
      await db.close();
    }
  }, LOCK_CASE_TIMEOUT_MS);

  it("converts a save committed before the file, and refuses one after it", async () => {
    const db = await createPicksDatabase([selectionOracleSeedSql]);
    const saveClient = await db.pool.connect();
    const migrationClient = await db.pool.connect();
    try {
      const before = new RulesSave(saveClient, 302, "vendor-save-before", SAVE_RULES);
      await before.begin();
      await before.replayRead();
      await before.insertRevision();
      await before.writeRules();
      await before.commit();
      const applied = await applyPicksMigration(migrationClient);
      expect(applied).toMatchObject({ attempts: 1, notices: [] });
      expect((await storedPicks(db.pool)).filter((key) => key.startsWith("302:"))).toEqual(SAVED_PICKS);
      const after = new RulesSave(saveClient, 305, "vendor-save-after", SAVE_RULES);
      await after.begin();
      await after.replayRead();
      await after.insertRevision();
      const refused = await pgErrorOf(after.writeRules());
      expect({ code: refused.code, message: refused.message }).toEqual({ code: "P0001", message: RULES_RETIRED_MESSAGE });
      await after.rollback();
      expect(await storedPicks(db.pool)).toEqual(await oracleRulePicks(db.pool));
    } finally {
      await saveClient.query("ROLLBACK").catch(() => undefined);
      saveClient.release();
      migrationClient.release();
      await db.close();
    }
  }, LOCK_CASE_TIMEOUT_MS);

  it("waits behind a SHARE holder of the rules (the six call sites' lock) and never deadlocks with it", async () => {
    const db = await createPicksDatabase([selectionOracleSeedSql]);
    const holder = await db.pool.connect();
    const migrationClient = await db.pool.connect();
    try {
      // sync-back's lockListing shape (dropship-marketplace-sync.repository.ts:400-415): owner rows FOR SHARE, the
      // selection SHARE locks, the size FOR SHARE, then the listing FOR UPDATE and its write.
      await holder.query("BEGIN");
      await holder.query(`SELECT sc.vendor_id FROM dropship.dropship_store_connections sc
        JOIN dropship.dropship_vendors v ON v.id = sc.vendor_id WHERE sc.id = 401 FOR SHARE OF v, sc`);
      await holder.query(A_LISTING_SELECTION_LOCK_SQL);
      const migrationPid = await backendPid(migrationClient);
      const migration = startPicksMigration(migrationClient);
      await waitFor(() => isWaitingOnLock(db.pool, migrationPid), "the file to wait behind the SHARE holder");
      await holder.query("SELECT id FROM catalog.product_variants WHERE id = 2001 FOR SHARE");
      await holder.query("SELECT id FROM dropship.dropship_vendor_listings WHERE id = 901 FOR UPDATE");
      await holder.query("UPDATE dropship.dropship_vendor_listings SET updated_at = updated_at WHERE id = 901");
      expect(await isWaitingOnLock(db.pool, migrationPid)).toBe(true);
      await holder.query("COMMIT");
      const outcome = await migration;
      expect(outcome.error).toBeUndefined();
      expect(outcome.applied).toMatchObject({ attempts: 1, notices: [] });
      expect(await storedPicks(db.pool)).toEqual(await oracleRulePicks(db.pool));
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      migrationClient.release();
      await db.close();
    }
  }, LOCK_CASE_TIMEOUT_MS);

  it("rolls a lock timeout mid-file back whole, and the retry under the same locks writes the same picks", async () => {
    const db = await createPicksDatabase([selectionOracleSeedSql, conversionEdgeSeedSql]);
    const blocker = await db.pool.connect();
    const migrationClient = await db.pool.connect();
    const between: unknown[] = [];
    try {
      // A catalog writer holds the sizes: the file's sizes lock times out after the conversion and the new tables
      // already ran in that attempt (a 55P03 mid-file).
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE catalog.product_variants IN ROW EXCLUSIVE MODE");
      const applied = await applyPicksMigration(migrationClient, {
        lockTimeoutMs: 300,
        sleep: async () => {
          between.push((await db.pool.query(`SELECT to_regclass('dropship.dropship_vendor_selected_variants') IS NULL AS no_picks,
              to_regclass('dropship.dropship_selection_conversions') IS NULL AS no_records,
              NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'dropship'
                AND table_name = 'dropship_vendor_selection_rule_set_revisions' AND column_name = 'request_kind') AS no_kind,
              (SELECT count(*)::int FROM dropship.dropship_vendor_selection_rule_set_revisions) AS revisions,
              (SELECT count(*)::int FROM dropship.dropship_audit_events) AS audit,
              NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'aa_selection_rules_retired') AS not_frozen,
              (SELECT count(*)::int FROM public._migrations) AS applied`)).rows[0]);
          await blocker.query("COMMIT");
        },
      });
      expect(applied.attempts).toBe(2);
      expect(applied.notices.map((notice) => notice.sqlState)).toEqual(["55P03"]);
      expect(between).toEqual([{ no_picks: true, no_records: true, no_kind: true, revisions: 1, audit: 0, not_frozen: true, applied: 0 }]);
      expect(await storedPicks(db.pool)).toEqual(await oracleRulePicks(db.pool));
      const keys = await db.pool.query<{ idempotency_key: string }>(`SELECT idempotency_key FROM dropship.dropship_vendor_selection_rule_set_revisions
        WHERE request_kind = 'picks_backfill' ORDER BY vendor_id`);
      expect(keys.rows.map((row) => row.idempotency_key)).toEqual(
        [301, 302, 303, 304, 305, 306, 307, 309].map((vendorId) => `legacy-picks-backfill:${vendorId}:77`));
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      migrationClient.release();
      await db.close();
    }
  }, LOCK_CASE_TIMEOUT_MS);

  it("picks no size a catalog delete removes while the file runs: one attempt, no 23503, counts and audit without it (MIG-1)", async () => {
    const db = await createPicksDatabase([selectionOracleSeedSql, conversionEdgeSeedSql]);
    const blocker = await db.pool.connect();
    const migrationClient = await db.pool.connect();
    try {
      // An admin's delete of unlisted size 2004, which catalog includes pick (DELETE /api/product-variants/:id,
      // catalog.storage.ts deleteProductVariant), still open when the file reads the sizes; it commits while the
      // file waits for the sizes, at production's lock timeout.
      expect((await oracleRulePicks(db.pool)).filter((key) => key.endsWith(":2004"))).toEqual(["301:2004", "303:2004", "304:2004", "306:2004"]);
      await blocker.query("BEGIN");
      await blocker.query("DELETE FROM catalog.product_variants WHERE id = 2004");
      const migrationPid = await backendPid(migrationClient);
      const migration = startPicksMigration(migrationClient);
      await waitFor(() => isWaitingOnTable(db.pool, migrationPid, "catalog.product_variants"), "the file to wait for the sizes");
      await blocker.query("COMMIT");
      const outcome = await migration;
      expect(outcome.error).toBeUndefined();
      expect(outcome.applied).toMatchObject({ attempts: 1, notices: [] });
      const picks = await storedPicks(db.pool);
      expect(picks.filter((key) => key.endsWith(":2004"))).toEqual([]);
      expect(picks).toEqual(await oracleRulePicks(db.pool));
      // Each backfill revision's pick count and audit row describe exactly the picks written.
      const backfills = await db.pool.query<{ vendor_id: number; pick_count: number; picked: number[]; by_source: number }>(
        `SELECT rev.vendor_id, rev.pick_count, a.payload->'pickedVariantIds' AS picked,
           ((a.payload->'pickCountsBySource'->>'legacy_variant_rule')::int + (a.payload->'pickCountsBySource'->>'legacy_broad_rule')::int) AS by_source
         FROM dropship.dropship_vendor_selection_rule_set_revisions rev
         JOIN dropship.dropship_audit_events a ON a.entity_id = rev.id::text AND a.event_type = 'vendor_selection_picks_backfilled'
         WHERE rev.request_kind = 'picks_backfill' ORDER BY rev.vendor_id`);
      expect(backfills.rows.map((row) => row.vendor_id)).toEqual([301, 302, 303, 304, 305, 306, 307, 309]);
      for (const row of backfills.rows) {
        const vendorPicks = picksOfVendor(picks, row.vendor_id);
        expect({ vendor: row.vendor_id, pickCount: row.pick_count, picked: row.picked, bySource: row.by_source })
          .toEqual({ vendor: row.vendor_id, pickCount: vendorPicks.length, picked: vendorPicks, bySource: vendorPicks.length });
      }
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      migrationClient.release();
      await db.close();
    }
  }, LOCK_CASE_TIMEOUT_MS);

  it("records every size's matcher inputs as the conversion read them: an edit committed while the file waits is in neither them nor the picks (FUP-1)", async () => {
    const db = await createPicksDatabase([selectionOracleSeedSql, conversionEdgeSeedSql]);
    const blocker = await db.pool.connect();
    const migrationClient = await db.pool.connect();
    try {
      const catalogInputs = async () => (await db.pool.query<{ id: number; product_id: number; category: string | null; product_line_ids: number[] }>(
        `SELECT pv.id, p.id AS product_id, p.category,
           ARRAY(SELECT plp.product_line_id FROM catalog.product_line_products plp WHERE plp.product_id = p.id ORDER BY plp.product_line_id)
             AS product_line_ids
         FROM catalog.product_variants pv JOIN catalog.products p ON p.id = pv.product_id ORDER BY pv.id`)).rows;
      const before = await catalogInputs();
      const oracleBefore = await oracleRulePicks(db.pool);
      // Vendor 303's category include 'supplies' picks product 1001's sizes as the file reads them.
      expect(oracleBefore.filter((key) => key.startsWith("303:200"))).toContain("303:2001");
      // A catalog writer holds the sizes, so the file waits at its sizes lock, after the conversion's statement.
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE catalog.product_variants IN ROW EXCLUSIVE MODE");
      const migrationPid = await backendPid(migrationClient);
      const migration = startPicksMigration(migrationClient);
      await waitFor(() => isWaitingOnTable(db.pool, migrationPid, "catalog.product_variants"), "the file to wait for the sizes");
      // Meanwhile an admin moves product 1001 out of Supplies and adds product 1002 to a second line (neither table is
      // locked by the file), and both commit before the file's next statement.
      await db.pool.query("UPDATE catalog.products SET category = 'Toploaders' WHERE id = 1001");
      await db.pool.query("INSERT INTO catalog.product_line_products (product_id, product_line_id) VALUES (1002, 8)");
      await blocker.query("COMMIT");
      const outcome = await migration;
      expect(outcome.error).toBeUndefined();
      expect(outcome.applied).toMatchObject({ attempts: 1, notices: [] });

      const recorded = (await db.pool.query<{ id: number; product_id: number; category: string | null; product_line_ids: number[] }>(
        `SELECT product_variant_id AS id, product_id, category, product_line_ids
         FROM dropship.dropship_selection_conversion_sizes ORDER BY product_variant_id`)).rows;
      expect(recorded).toEqual(before);
      const after = await catalogInputs();
      const edited = after.filter((row, index) => JSON.stringify(row) !== JSON.stringify(before[index])).map((row) => row.id);
      expect(edited).toEqual(before.filter((row) => row.product_id === 1001 || row.product_id === 1002).map((row) => row.id));
      // The picks are the conversion's read too, not the catalog after the edit.
      expect(await storedPicks(db.pool)).toEqual(oracleBefore);
      expect(await oracleRulePicks(db.pool)).not.toEqual(oracleBefore);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      migrationClient.release();
      await db.close();
    }
  }, LOCK_CASE_TIMEOUT_MS);

  it("leaves every vendor write free while the file waits behind a catalog writer (MIG-3)", async () => {
    const db = await createPicksDatabase([selectionOracleSeedSql, conversionEdgeSeedSql]);
    const blocker = await db.pool.connect();
    const migrationClient = await db.pool.connect();
    const vendorClient = await db.pool.connect();
    try {
      // A lot receipt or COGS update holds the sizes ROW EXCLUSIVE (receiving.service.ts receives every line in one
      // transaction); the file waits for the sizes at production's lock timeout.
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE catalog.product_variants IN ROW EXCLUSIVE MODE");
      const migrationPid = await backendPid(migrationClient);
      const migration = startPicksMigration(migrationClient);
      await waitFor(() => isWaitingOnTable(db.pool, migrationPid, "catalog.product_variants"), "the file to wait for the sizes");
      // Meanwhile sign-in, orders, onboarding and wallet keep writing vendors: one without rules (310), a converted one
      // (301), and a new sign-up. Each gives up after 2 s instead of hanging, so a blocked write fails the case.
      const VENDOR_WRITE_LOCK_TIMEOUT_MS = 2_000;
      const writes: Record<string, string> = {};
      for (const vendorId of [310, 301]) {
        writes[`provision ${vendorId}`] = await provisionVendorShaped(vendorClient, vendorId, VENDOR_WRITE_LOCK_TIMEOUT_MS)
          .then(() => "committed", (error: { code?: string }) => `failed ${error.code}`);
      }
      writes["sign-up 311"] = await (async () => {
        await vendorClient.query("BEGIN");
        await vendorClient.query("SELECT set_config('lock_timeout', $1, true)", [`${VENDOR_WRITE_LOCK_TIMEOUT_MS}ms`]);
        await vendorClient.query("INSERT INTO dropship.dropship_vendors (id, member_id, status, entitlement_status) VALUES (311, 'member-311', 'active', 'active')");
        await vendorClient.query("COMMIT");
      })().then(() => "committed", async (error: { code?: string }) => {
        await vendorClient.query("ROLLBACK");
        return `failed ${error.code}`;
      });
      expect(writes).toEqual({ "provision 310": "committed", "provision 301": "committed", "sign-up 311": "committed" });
      expect(await isWaitingOnTable(db.pool, migrationPid, "catalog.product_variants")).toBe(true);
      await blocker.query("COMMIT");
      const outcome = await migration;
      expect(outcome.error).toBeUndefined();
      expect(outcome.applied).toMatchObject({ attempts: 1, notices: [] });
      expect(await storedPicks(db.pool)).toEqual(await oracleRulePicks(db.pool));
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await vendorClient.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      migrationClient.release();
      vendorClient.release();
      await db.close();
    }
  }, LOCK_CASE_TIMEOUT_MS);
});

/**
 * 3,000 products of 10 sizes; 10 vendors: five catalog includes, a category include with a product exclude, a product
 * line include, 100 variant includes, one without rules and one with only an inactive rule. Then the two shapes stage 1
 * saves at A's 500-rule cap (MIG-4; dropship-selection-dtos.ts:69 at cea5cb027, one variant rule per ticked size,
 * dropship-catalog-choose.ts pickRule): 20 vendors of 500 variant includes, and 10 vendors of a catalog include with 499
 * variant excludes (a size unticked under a broad include). How many vendors production has of each shape is
 * INSUFFICIENT EVIDENCE (R2, R3).
 */
const SCALE_SIZES = 30_000;
/** A's cap on active rules per vendor at cea5cb027 (dropship-selection-dtos.ts:69). */
const STAGE_1_RULE_CAP = 500;
const CAPPED_INCLUDE_VENDORS = 20;
const CAPPED_EXCLUDE_VENDORS = 10;
const scaleSeedSql = `
  INSERT INTO catalog.product_lines (id, name) VALUES (7, 'Sleeves');
  INSERT INTO catalog.products (id, sku, name, category, is_active, status, product_type, ebay_listing_excluded)
    SELECT 100000 + g, 'SP-' || g, 'Scale product ' || g, 'Scale category ' || (g % 50), true, 'active', 'sleeves', false
    FROM generate_series(1, 3000) g;
  INSERT INTO catalog.product_line_products (product_id, product_line_id)
    SELECT 100000 + g, 7 FROM generate_series(1, 3000) g WHERE g % 7 = 0;
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded)
    SELECT 200000 + g, 100000 + (g - 1) / 10 + 1, 'SV-' || g, 'Scale size ' || g, 'pack', true, true, true, 'sellable', false
    FROM generate_series(1, ${SCALE_SIZES}) g;
  INSERT INTO dropship.dropship_vendors (id, member_id, status, entitlement_status)
    SELECT 500 + g, 'member-' || (500 + g), 'active', 'active' FROM generate_series(1, 10) g;
  INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions (vendor_id, idempotency_key, request_hash, actor_type, rule_count, created_at)
    SELECT 500 + g, 'scale-save-' || g, repeat('a', 64), 'vendor', 1, '2026-10-20T08:00:00Z' FROM generate_series(1, 8) g;
  INSERT INTO dropship.dropship_vendor_selection_rules (vendor_id, scope_type, action, is_active)
    SELECT 500 + g, 'catalog', 'include', true FROM generate_series(1, 5) g;
  INSERT INTO dropship.dropship_vendor_selection_rules (vendor_id, scope_type, action, product_line_id, product_id, category, is_active) VALUES
    (506, 'category', 'include', NULL, NULL, ' scale CATEGORY 7', true), (506, 'product', 'exclude', NULL, 100007, NULL, true),
    (507, 'product_line', 'include', 7, NULL, NULL, true), (510, 'catalog', 'include', NULL, NULL, NULL, false);
  INSERT INTO dropship.dropship_vendor_selection_rules (vendor_id, scope_type, action, product_variant_id, is_active)
    SELECT 508, 'variant', 'include', 200000 + g * 300, true FROM generate_series(1, 100) g;
  INSERT INTO dropship.dropship_vendors (id, member_id, status, entitlement_status)
    SELECT 510 + k, 'member-' || (510 + k), 'active', 'active' FROM generate_series(1, ${CAPPED_INCLUDE_VENDORS + CAPPED_EXCLUDE_VENDORS}) k;
  INSERT INTO dropship.dropship_vendor_selection_rules (vendor_id, scope_type, action, product_variant_id, is_active)
    SELECT 510 + k, 'variant', 'include', 200001 + (g * 59 + k * 1009) % ${SCALE_SIZES}, true
    FROM generate_series(1, ${CAPPED_INCLUDE_VENDORS}) k CROSS JOIN generate_series(1, ${STAGE_1_RULE_CAP}) g;
  INSERT INTO dropship.dropship_vendor_selection_rules (vendor_id, scope_type, action, is_active)
    SELECT 510 + k, 'catalog', 'include', true
    FROM generate_series(${CAPPED_INCLUDE_VENDORS + 1}, ${CAPPED_INCLUDE_VENDORS + CAPPED_EXCLUDE_VENDORS}) k;
  INSERT INTO dropship.dropship_vendor_selection_rules (vendor_id, scope_type, action, product_variant_id, is_active)
    SELECT 510 + k, 'variant', 'exclude', 200001 + (g * 61 + k * 997) % ${SCALE_SIZES}, true
    FROM generate_series(${CAPPED_INCLUDE_VENDORS + 1}, ${CAPPED_INCLUDE_VENDORS + CAPPED_EXCLUDE_VENDORS}) k
    CROSS JOIN generate_series(1, ${STAGE_1_RULE_CAP - 1}) g;
`;

interface Probe {
  start: number;
  end: number;
}

/**
 * The conversion follow-up's detection walk (§11.2; B3 review): it reads every size of the catalog, a page of
 * FOLLOW_UP_REPAIR_BATCH_SIZE at a time, with the SQL twin's answer for the vendor's active rules, at runtime and
 * outside the release's locks. A page may take this long on the stage-1-cap fixture (the plan names no budget: one
 * page is one statement of the minute tick, so it stays well under the tick).
 */
const FOLLOW_UP_PAGE_BUDGET_MS = 2_000;

/** One vendor's whole detection walk through the real repository: pages, the slowest page and every row's answers. */
async function followUpDetectionWalk(pool: Pool, vendorId: number): Promise<{
  pages: number; rows: number; maxPageMs: number; totalMs: number; sqlPicked: string[]; asConverted: number;
}> {
  const reads = new PgDropshipSelectionConversionFollowUpRepository(pool).detectionReads();
  const started = performance.now();
  let afterId = 0;
  let pages = 0;
  let rows = 0;
  let maxPageMs = 0;
  let asConverted = 0;
  const sqlPicked: string[] = [];
  for (;;) {
    const pageStarted = performance.now();
    const page = await reads.listRepairRowsAfter({ vendorId, afterId, limit: FOLLOW_UP_REPAIR_BATCH_SIZE });
    maxPageMs = Math.max(maxPageMs, performance.now() - pageStarted);
    if (page.length === 0) break;
    pages += 1;
    rows += page.length;
    for (const row of page) {
      if (row.sqlRulesPick) sqlPicked.push(`${vendorId}:${row.productVariantId}`);
      if ((row as { asConverted?: boolean }).asConverted !== false) asConverted += 1;
    }
    afterId = page[page.length - 1]!.productVariantId;
  }
  return { pages, rows, maxPageMs: Math.round(maxPageMs), totalMs: Math.round(performance.now() - started), sqlPicked: sqlPicked.sort(), asConverted };
}

/** Runs `step` again and again until `done`, then once more, recording each run's start and end. */
async function probeUntil(step: () => Promise<void>, done: () => boolean): Promise<Probe[]> {
  const probes: Probe[] = [];
  for (let last = false; ; last = done()) {
    const start = performance.now();
    await step();
    probes.push({ start, end: performance.now() });
    if (last) return probes;
    await delay(5);
  }
}

describeDatabase.sequential("picks migration: lock windows on 30,000 sizes (PostgreSQL)", () => {
  /** A probe that started this long before a window opened must not have waited (sampling granularity). */
  const SAMPLE_SLACK_MS = 50;
  /** The most a probe outside a lock window may take under the file's load. */
  const UNBLOCKED_MS = 500;

  it("holds the revisions, the sizes and the vendors only for their windows, each under budget (CHK11, SAFETY-4, SAFETY-5)", async () => {
    const db = await createPicksDatabase([scaleSeedSql]);
    const migrationClient = await db.pool.connect();
    const sampler = await db.pool.connect();
    const sizeWriter = await db.pool.connect();
    const convertedVendor = await db.pool.connect();
    const otherVendor = await db.pool.connect();
    try {
      const pid = await backendPid(migrationClient);
      let done = false;
      const firstSeen = new Map<string, number>();
      const sampling = (async () => {
        while (!done) {
          const locks = await sampler.query<{ relation: string; mode: string }>(`SELECT n.nspname || '.' || c.relname AS relation, l.mode
            FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE l.pid = $1 AND l.locktype = 'relation' AND l.granted`, [pid]);
          const at = performance.now();
          for (const lock of locks.rows) {
            const key = `${lock.relation} ${lock.mode}`;
            if (!firstSeen.has(key)) firstSeen.set(key, at);
          }
          await delay(2);
        }
      })();
      // A catalog writer (lot receiving, COGS) and provisionVendor's shape for a converted vendor and for one without rules.
      const probing = Promise.all([
        probeUntil(async () => { await sizeWriter.query("UPDATE catalog.product_variants SET name = name WHERE id = 200001"); }, () => done),
        probeUntil(() => provisionVendorShaped(convertedVendor, 501), () => done),
        probeUntil(() => provisionVendorShaped(otherVendor, 509), () => done),
      ]);
      await delay(100);
      const started = performance.now();
      let outcome: { applied?: AppliedMigration; error?: unknown };
      try {
        outcome = { applied: await applyPicksMigration(migrationClient) };
      } catch (error) {
        outcome = { error };
      }
      const committed = performance.now();
      done = true;
      const [sizeProbes, convertedProbes, otherProbes] = await probing;
      await sampling;

      expect(outcome.error).toBeUndefined();
      const applied = outcome.applied!;
      expect(applied.attempts).toBe(1);
      expect(applied.notices).toEqual([]);
      const seen = (key: string) => {
        const at = firstSeen.get(key);
        expect(at, key).toBeDefined();
        return at!;
      };
      const revisionsHeldAt = seen("dropship.dropship_vendor_selection_rule_set_revisions AccessExclusiveLock");
      const backfillAt = seen("dropship.dropship_vendor_selection_rule_set_revisions RowExclusiveLock");
      const sizesHeldAt = seen("catalog.product_variants ShareRowExclusiveLock");
      const vendorsHeldAt = seen("dropship.dropship_vendors ShareRowExclusiveLock");
      // The sizes are locked after the conversion and before the first vendor lock (MIG-1, MIG-3): the backfill
      // revisions follow it at once (the same ~2 ms sample when the prune is quick), the vendor foreign keys after the copy.
      expect(revisionsHeldAt).toBeLessThan(sizesHeldAt);
      expect(sizesHeldAt).toBeLessThanOrEqual(backfillAt);
      expect(backfillAt).toBeLessThan(vendorsHeldAt);
      const longest = (probes: Probe[]) => Math.max(...probes.map((probe) => probe.end - probe.start));
      const waitedBefore = (probes: Probe[], opened: number) => probes
        .filter((probe) => probe.start < opened - SAMPLE_SLACK_MS && probe.end - probe.start > UNBLOCKED_MS);
      const measured = {
        sizes: SCALE_SIZES,
        picks: (await db.pool.query("SELECT count(*)::int AS count FROM dropship.dropship_vendor_selected_variants")).rows[0].count as number,
        activeRules: (await db.pool.query("SELECT count(*)::int AS count FROM dropship.dropship_vendor_selection_rules WHERE is_active")).rows[0].count as number,
        cappedVendors: (await db.pool.query(`SELECT count(*)::int AS count FROM (SELECT vendor_id FROM dropship.dropship_vendor_selection_rules
          WHERE is_active GROUP BY vendor_id HAVING count(*) = ${STAGE_1_RULE_CAP}) capped`)).rows[0].count as number,
        totalFileMs: Math.round(applied.elapsedMs),
        revisionsHoldMs: Math.round(committed - revisionsHeldAt),
        backfillToCommitMs: Math.round(committed - backfillAt),
        sizesHoldMs: Math.round(committed - sizesHeldAt),
        vendorsHoldMs: Math.round(committed - vendorsHeldAt),
        longestSizeWriteMs: Math.round(longest(sizeProbes)),
        longestConvertedVendorWriteMs: Math.round(longest(convertedProbes)),
        longestOtherVendorWriteMs: Math.round(longest(otherProbes)),
        probes: { sizes: sizeProbes.length, convertedVendor: convertedProbes.length, otherVendor: otherProbes.length },
        startedAfterProbesMs: Math.round(started - Math.min(sizeProbes[0]!.start, convertedProbes[0]!.start)),
      };
      process.stdout.write(`[pg-record] picks migration lock windows: ${JSON.stringify(measured)}\n`);

      for (const value of [measured.totalFileMs, measured.revisionsHoldMs, measured.longestSizeWriteMs,
        measured.longestConvertedVendorWriteMs, measured.longestOtherVendorWriteMs]) {
        expect(value).toBeLessThan(LOCK_WINDOW_BUDGET_MS);
      }
      // Each writer waits only inside its window: the sizes from the sizes lock, other vendors from the foreign key
      // step, a converted vendor's row from its backfill revision (FOR KEY SHARE), each until commit.
      expect(waitedBefore(sizeProbes, sizesHeldAt)).toEqual([]);
      expect(waitedBefore(otherProbes, vendorsHeldAt)).toEqual([]);
      expect(waitedBefore(convertedProbes, backfillAt)).toEqual([]);
      expect(measured.longestSizeWriteMs).toBeLessThanOrEqual(measured.sizesHoldMs + UNBLOCKED_MS);
      expect(measured.longestOtherVendorWriteMs).toBeLessThanOrEqual(measured.vendorsHoldMs + UNBLOCKED_MS);
      expect(measured.longestConvertedVendorWriteMs).toBeLessThanOrEqual(measured.backfillToCommitMs + UNBLOCKED_MS);
      for (const probes of [sizeProbes, convertedProbes, otherProbes]) expect(probes.length).toBeGreaterThanOrEqual(3);

      // And the conversion itself, on every size: the frozen oracle's rule part.
      const stored = await storedPicks(db.pool);
      expect(stored).toEqual(await oracleRulePicks(db.pool));
      expect(measured.picks).toBeGreaterThan(5 * SCALE_SIZES);
      expect(measured.cappedVendors).toBe(CAPPED_INCLUDE_VENDORS + CAPPED_EXCLUDE_VENDORS);

      // The follow-up's detection on the same catalog, for the converted vendors with broad rules: a catalog include, the
      // category include with a product exclude, the product line include, and the first capped vendor of a catalog include
      // with 499 variant excludes (the stage-1 cap; the variant-only vendors have no conversion record, so no follow-up).
      // Its SQL twin agrees with the stored picks on every size (ASCII categories: no A10 disagreement) and every row is
      // as the conversion read it (no catalog edit since).
      const walks: Record<string, unknown> = {};
      for (const vendorId of [501, 506, 507, 510 + CAPPED_INCLUDE_VENDORS + 1]) {
        const walk = await followUpDetectionWalk(db.pool, vendorId);
        walks[vendorId] = { pages: walk.pages, rows: walk.rows, maxPageMs: walk.maxPageMs, totalMs: walk.totalMs };
        expect(walk.rows, String(vendorId)).toBe(SCALE_SIZES);
        expect(walk.sqlPicked, String(vendorId)).toEqual(stored.filter((key) => key.startsWith(`${vendorId}:`)));
        expect(walk.asConverted, String(vendorId)).toBe(SCALE_SIZES);
        expect(walk.maxPageMs, String(vendorId)).toBeLessThan(FOLLOW_UP_PAGE_BUDGET_MS);
      }
      process.stdout.write(`[pg-record] follow-up detection walks: ${JSON.stringify(walks)}\n`);
    } finally {
      for (const client of [convertedVendor, otherVendor]) await client.query("ROLLBACK").catch(() => undefined);
      for (const client of [migrationClient, sampler, sizeWriter, convertedVendor, otherVendor]) client.release();
      await db.close();
    }
  }, SCALE_CASE_TIMEOUT_MS);
});
