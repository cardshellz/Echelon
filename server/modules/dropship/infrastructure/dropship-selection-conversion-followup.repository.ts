import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { countSelectedVariants, offeredVariantIdsAmong } from "../application/dropship-selected-catalog";
import type {
  DropshipSelectionConversionFollowUpRepository,
  FollowUpApplyTransaction,
  FollowUpCatalogRow,
  FollowUpDetectionReads,
  OpenSelectionConversion,
  SelectionConversionRecord,
} from "../application/dropship-selection-conversion-followup";
import { invariantFailed } from "../domain/catalog-arrivals";
import type { DropshipVendorSelectionRule } from "../domain/vendor-selection";
import { readHeadSelectionRevisionId } from "./dropship-listing-push-run.repository";
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";
import { SELECTION_RULE_MATCH_SQL, SIZE_MATCH_INPUTS_SQL } from "./dropship-selection-conversion.sql";
import { lockVendorSelection } from "./dropship-vendor-selection-lock";

/**
 * The conversion follow-up in PostgreSQL (PLAN-B v4.1 §6 step 5, §11.2). The
 * service decides; this module runs parameterized statements.
 *
 * With the frozen rules GET (dropship-selection-atp.repository.ts), this is
 * the only runtime reader of `dropship.dropship_vendor_selection_rules` (V5;
 * the static guard allows exactly these files): the repair compares the
 * TypeScript matcher of the frozen rules with the conversion's SQL twin,
 * `SELECTION_RULE_MATCH_SQL`, evaluated here as a column of each catalog row,
 * so both read the same row (FIDELITY-1). It writes nothing to the rules
 * (the freeze trigger refuses any write, §6 step 8).
 *
 * The apply transaction begins with the picks save's short lock timeout and
 * the vendor's selection lock (dropship-selection-change.repository.ts), so a
 * follow-up and a vendor's save never interleave; the picks writes take the
 * publication selection gate (0743) like the save's.
 */

type Queryable = Pick<PoolClient, "query">;

/** The save's lock timeout (dropship-selection-change.repository.ts SELECTION_CHANGE_LOCK_TIMEOUT): a busy apply gives its connection back fast. */
export const CONVERSION_FOLLOWUP_LOCK_TIMEOUT = "2s";
const SNAPSHOT_BEGIN_SQL = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
const LAST_ERROR_CODE_LENGTH = 80;

/**
 * The repair columns of catalog sizes (every `catalog.product_variants` row
 * joined to its product: the conversion's own domain, sellable or not): the
 * matcher's inputs, the vendor's pick, whether those inputs are still the ones
 * the conversion read for the size (`as_converted`: the size is in the
 * conversion's record of sizes with the same product, text category and
 * product lines; FUP-1) and, for the vendor's active rules, the conversion's
 * own test ("some active include rule matches and no active exclude rule
 * does", §6 step 4) as one boolean column. `$1` is the vendor; the caller adds
 * the size filter as `$2`/`$3`.
 */
function repairRowsSql(sizeFilter: string, tail: string): string {
  return `SELECT pv.id AS product_variant_id, p.id AS product_id, p.category,
       p.is_active AS product_is_active, pv.is_active AS variant_is_active,
       lines.ids AS product_line_ids,
       s.source AS pick_source,
       COALESCE(seen.product_id = p.id AND seen.category IS NOT DISTINCT FROM p.category
         AND seen.product_line_ids = lines.ids, false) AS as_converted,
       (EXISTS (
          SELECT 1 FROM dropship.dropship_vendor_selection_rules r
          WHERE r.vendor_id = $1 AND r.is_active = true AND r.action = 'include'
            AND ${SELECTION_RULE_MATCH_SQL}
        ) AND NOT EXISTS (
          SELECT 1 FROM dropship.dropship_vendor_selection_rules r
          WHERE r.vendor_id = $1 AND r.is_active = true AND r.action = 'exclude'
            AND ${SELECTION_RULE_MATCH_SQL}
        )) AS sql_rules_pick
  FROM catalog.product_variants pv
  INNER JOIN catalog.products p ON p.id = pv.product_id
  CROSS JOIN LATERAL (SELECT ${SIZE_MATCH_INPUTS_SQL.productLineIds} AS ids) lines
  LEFT JOIN dropship.dropship_vendor_selected_variants s ON s.vendor_id = $1 AND s.product_variant_id = pv.id
  LEFT JOIN dropship.dropship_selection_conversion_sizes seen ON seen.product_variant_id = pv.id
  WHERE ${sizeFilter}
  ORDER BY pv.id
  ${tail}`;
}

const REPAIR_ROWS_AFTER_SQL = repairRowsSql("pv.id > $2", "LIMIT $3");
const REPAIR_ROWS_AMONG_SQL = repairRowsSql("pv.id = ANY($2::int[])", "");

interface RepairRow {
  product_variant_id: number;
  product_id: number;
  category: string | null;
  product_is_active: boolean;
  variant_is_active: boolean;
  product_line_ids: number[] | null;
  pick_source: string | null;
  as_converted: boolean;
  sql_rules_pick: boolean;
}

interface ConversionRow {
  vendor_id: number;
  backfill_revision_id: number;
  followup_state: string;
  notice_state: string;
  followup_failures: number;
}

interface RuleRow {
  id: number;
  scope_type: string;
  action: string;
  product_line_id: number | null;
  product_id: number | null;
  product_variant_id: number | null;
  category: string | null;
  is_active: boolean;
}

const CONVERSION_COLUMNS = "vendor_id, backfill_revision_id, followup_state, notice_state, followup_failures";
const FOLLOWUP_STATES: ReadonlySet<string> = new Set(["pending", "done", "requires_review"]);
const NOTICE_STATES: ReadonlySet<string> = new Set(["not_needed", "pending", "sent", "requires_review"]);

export class PgDropshipSelectionConversionFollowUpRepository implements DropshipSelectionConversionFollowUpRepository {
  constructor(private readonly dbPool: Pick<Pool, "query" | "connect"> = defaultPool) {}

  async listOpenConversions(): Promise<OpenSelectionConversion[]> {
    // The partial index's rows, without the follow-ups that need review (never read again, CLAUDE.md §6), each with
    // its vendor's status (the vendor foreign key cascades, so every row has its vendor).
    const result = await this.dbPool.query<ConversionRow & { vendor_status: unknown }>(
      `SELECT c.vendor_id, c.backfill_revision_id, c.followup_state, c.notice_state, c.followup_failures, v.status AS vendor_status
       FROM dropship.dropship_selection_conversions c
       INNER JOIN dropship.dropship_vendors v ON v.id = c.vendor_id
       WHERE c.followup_state = 'pending' OR (c.notice_state = 'pending' AND c.followup_state = 'done')
       ORDER BY c.vendor_id`);
    return result.rows.map((row) => {
      if (typeof row.vendor_status !== "string" || row.vendor_status === "") {
        throw invariantFailed("A conversion record's vendor status failed its contract.", { vendorId: String(row.vendor_id) });
      }
      return { ...mapConversion(row), vendorStatus: row.vendor_status };
    });
  }

  async readFrozenRules(vendorId: number): Promise<DropshipVendorSelectionRule[]> {
    const result = await this.dbPool.query<RuleRow>(
      `SELECT id, scope_type, action, product_line_id, product_id, product_variant_id, category, is_active
       FROM dropship.dropship_vendor_selection_rules
       WHERE vendor_id = $1 AND is_active = true
       ORDER BY id`, [vendorId]);
    return result.rows.map(mapRule);
  }

  detectionReads(): FollowUpDetectionReads {
    return {
      listRepairRowsAfter: async ({ vendorId, afterId, limit }) =>
        (await this.dbPool.query<RepairRow>(REPAIR_ROWS_AFTER_SQL, [vendorId, afterId, limit])).rows.map(mapRepairRow),
      listBroadPickIdsAfter: async ({ vendorId, afterId, limit }) => (await this.dbPool.query<{ product_variant_id: number }>(
        `SELECT product_variant_id FROM dropship.dropship_vendor_selected_variants
         WHERE vendor_id = $1 AND source = 'legacy_broad_rule' AND product_variant_id > $2
         ORDER BY product_variant_id LIMIT $3`, [vendorId, afterId, limit])).rows.map((row) => row.product_variant_id),
      // One snapshot per batch: SEL reads the exposure rules, candidates and overrides one after another.
      readOfferedAmong: (input) => this.inTransaction(SNAPSHOT_BEGIN_SQL, (client) => readOfferedAmong(client, input)),
      readListedAmong: (input) => readListedAmong(this.dbPool, input),
    };
  }

  async runApply<T>(input: { vendorId: number }, work: (tx: FollowUpApplyTransaction) => Promise<T>): Promise<T> {
    return this.inTransaction("BEGIN", async (client) => {
      await client.query(`SET LOCAL lock_timeout = '${CONVERSION_FOLLOWUP_LOCK_TIMEOUT}'`);
      // The lock every write of a vendor's selection takes (the picks save, a run create), until COMMIT.
      await lockVendorSelection(client, input.vendorId);
      return work(applyTransaction(client));
    });
  }

  async readSelectedCount(input: { vendorId: number; now: Date }): Promise<number> {
    return this.inTransaction(SNAPSHOT_BEGIN_SQL, async (client) =>
      (await countSelectedVariants(selectedCatalogReaderForTransaction(client, input.vendorId), input.now)).selected);
  }

  async markNoticeSent(input: { vendorId: number; now: Date }): Promise<void> {
    await this.dbPool.query(
      `UPDATE dropship.dropship_selection_conversions
       SET notice_state = 'sent', notice_at = $2, followup_failures = 0
       WHERE vendor_id = $1 AND notice_state = 'pending'`, [input.vendorId, input.now]);
  }

  async recordFailure(input: { vendorId: number }): Promise<number | null> {
    const result = await this.dbPool.query<{ followup_failures: number }>(
      `UPDATE dropship.dropship_selection_conversions
       SET followup_failures = followup_failures + 1
       WHERE vendor_id = $1 AND (followup_state = 'pending' OR notice_state = 'pending')
       RETURNING followup_failures`, [input.vendorId]);
    return result.rows[0]?.followup_failures ?? null;
  }

  async markRequiresReview(input: { vendorId: number; stage: "followup" | "notice"; errorCode: string }): Promise<void> {
    const errorCode = input.errorCode.slice(0, LAST_ERROR_CODE_LENGTH);
    // The column is chosen from a closed set; the row's CHECK pairs `requires_review` with its code.
    const sql = input.stage === "followup"
      ? `UPDATE dropship.dropship_selection_conversions SET followup_state = 'requires_review', last_error_code = $2
         WHERE vendor_id = $1 AND followup_state = 'pending'`
      : `UPDATE dropship.dropship_selection_conversions SET notice_state = 'requires_review', last_error_code = $2
         WHERE vendor_id = $1 AND notice_state = 'pending'`;
    await this.dbPool.query(sql, [input.vendorId, errorCode]);
  }

  /** `begin`, `work`, COMMIT; ROLLBACK and rethrow the original error. A connection whose rollback failed is destroyed. */
  private async inTransaction<T>(begin: string, work: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    let rollbackFailure: Error | undefined;
    try {
      await client.query(begin);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      rollbackFailure = await rollbackQuietly(client);
      throw error;
    } finally {
      client.release(rollbackFailure);
    }
  }
}

function applyTransaction(client: Queryable): FollowUpApplyTransaction {
  return {
    async lockConversion(vendorId) {
      const result = await client.query<ConversionRow>(
        `SELECT ${CONVERSION_COLUMNS} FROM dropship.dropship_selection_conversions WHERE vendor_id = $1 FOR UPDATE`, [vendorId]);
      return result.rows[0] ? mapConversion(result.rows[0]) : null;
    },
    readHeadRevisionId: (vendorId) => readHeadSelectionRevisionId(client, vendorId),
    readRepairRows: async ({ vendorId, productVariantIds }) => productVariantIds.length === 0 ? []
      : (await client.query<RepairRow>(REPAIR_ROWS_AMONG_SQL, [vendorId, [...productVariantIds]])).rows.map(mapRepairRow),
    async readBroadPickIds({ vendorId, productVariantIds }) {
      if (productVariantIds.length === 0) return new Set();
      const result = await client.query<{ product_variant_id: number }>(
        `SELECT product_variant_id FROM dropship.dropship_vendor_selected_variants
         WHERE vendor_id = $1 AND source = 'legacy_broad_rule' AND product_variant_id = ANY($2::int[])`,
        [vendorId, [...productVariantIds]]);
      return new Set(result.rows.map((row) => row.product_variant_id));
    },
    readOfferedAmong: (input) => readOfferedAmong(client, input),
    readListedAmong: (input) => readListedAmong(client, input),
    async countPicksOutside({ vendorId, productVariantIds }) {
      // One statement (one snapshot), the save's own split (SRV-1): every pick row less the rows of these sizes, by the key.
      const result = await client.query<{ untouched_pick_count: number }>(
        `SELECT ((SELECT count(*) FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = $1)
           - (SELECT count(*) FROM dropship.dropship_vendor_selected_variants
              WHERE vendor_id = $1 AND product_variant_id = ANY($2::integer[])))::integer AS untouched_pick_count`,
        [vendorId, [...productVariantIds]]);
      const count = result.rows[0]?.untouched_pick_count;
      if (typeof count !== "number") throw invariantFailed("The follow-up's pick count read returned no row.", { vendorId });
      return count;
    },
    async insertRevision(input) {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions
           (vendor_id, idempotency_key, request_hash, actor_type, actor_id, rule_count, request_kind, pick_count, result, created_at)
         VALUES ($1, $2, $3, 'system', NULL, 0, 'picks_conversion_followup', $4, $5::jsonb, $6)
         RETURNING id`,
        [input.vendorId, input.idempotencyKey, input.requestHash, input.pickCount, JSON.stringify(input.result), input.now]);
      const revisionId = inserted.rows[0]?.id;
      if (typeof revisionId !== "number") throw invariantFailed("The follow-up revision insert returned no id.", { vendorId: input.vendorId });
      return revisionId;
    },
    async insertAudit(input) {
      await client.query(
        `INSERT INTO dropship.dropship_audit_events
           (vendor_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, 'dropship_vendor_selection_ruleset', $2, 'vendor_selection_conversion_followed_up', 'system', NULL, 'info', $3::jsonb, $4)`,
        [input.vendorId, String(input.revisionId), JSON.stringify(input.payload), input.now]);
    },
    async preLockVariants(productVariantIds) {
      // Ascending, as the save locks; FOR KEY SHARE is what the picks' foreign key takes. A deleted size is missing.
      const locked = await client.query<{ id: number }>(
        "SELECT id FROM catalog.product_variants WHERE id = ANY($1::integer[]) ORDER BY id FOR KEY SHARE", [[...productVariantIds]]);
      return locked.rows.map((row) => row.id);
    },
    async deletePicks({ vendorId, productVariantIds }) {
      const deleted = await client.query(
        `DELETE FROM dropship.dropship_vendor_selected_variants
         WHERE vendor_id = $1 AND product_variant_id = ANY($2::integer[])`, [vendorId, [...productVariantIds]]);
      return deleted.rowCount ?? 0;
    },
    async insertRepairPicks({ vendorId, revisionId, productVariantIds, now }) {
      const inserted = await client.query(
        `INSERT INTO dropship.dropship_vendor_selected_variants
           (vendor_id, product_variant_id, revision_id, source, selected_at)
         SELECT $1, repaired.id, $2, 'conversion_repair', $4
         FROM unnest($3::integer[]) AS repaired(id)
         ORDER BY repaired.id
         ON CONFLICT (vendor_id, product_variant_id) DO NOTHING`, [vendorId, revisionId, [...productVariantIds], now]);
      return inserted.rowCount ?? 0;
    },
    async markFollowUpDone({ vendorId, now }) {
      const updated = await client.query(
        `UPDATE dropship.dropship_selection_conversions
         SET followup_state = 'done', followup_at = $2, followup_failures = 0
         WHERE vendor_id = $1 AND followup_state = 'pending'`, [vendorId, now]);
      if ((updated.rowCount ?? 0) !== 1) throw invariantFailed("The follow-up's conversion row was no longer pending under its lock.", { vendorId });
    },
  };
}

async function readOfferedAmong(client: Queryable, input: { vendorId: number; productVariantIds: readonly number[]; now: Date }): Promise<Set<number>> {
  return offeredVariantIdsAmong(selectedCatalogReaderForTransaction(client, input.vendorId), input.productVariantIds, input.now);
}

async function readListedAmong(client: Queryable, input: { vendorId: number; productVariantIds: readonly number[] }): Promise<Set<number>> {
  if (input.productVariantIds.length === 0) return new Set();
  const result = await client.query<{ product_variant_id: number }>(
    `SELECT DISTINCT product_variant_id FROM dropship.dropship_vendor_listings
     WHERE vendor_id = $1 AND product_variant_id = ANY($2::int[])`, [input.vendorId, [...input.productVariantIds]]);
  return new Set(result.rows.map((row) => row.product_variant_id));
}

function mapConversion(row: ConversionRow): SelectionConversionRecord {
  if (!FOLLOWUP_STATES.has(row.followup_state) || !NOTICE_STATES.has(row.notice_state)
    || !Number.isSafeInteger(row.vendor_id) || !Number.isSafeInteger(row.backfill_revision_id)) {
    throw invariantFailed("A conversion record failed its contract.", { vendorId: String(row.vendor_id) });
  }
  return {
    vendorId: row.vendor_id,
    backfillRevisionId: row.backfill_revision_id,
    followupState: row.followup_state as SelectionConversionRecord["followupState"],
    noticeState: row.notice_state as SelectionConversionRecord["noticeState"],
    followupFailures: row.followup_failures,
  };
}

/** A frozen rule as VS's matcher reads it. An unknown scope or action matches nothing on both sides (VS and the SQL twin). */
function mapRule(row: RuleRow): DropshipVendorSelectionRule {
  return {
    id: row.id,
    scopeType: row.scope_type as DropshipVendorSelectionRule["scopeType"],
    action: row.action as DropshipVendorSelectionRule["action"],
    productLineId: row.product_line_id,
    productId: row.product_id,
    productVariantId: row.product_variant_id,
    category: row.category,
    isActive: row.is_active,
  };
}

function mapRepairRow(row: RepairRow): FollowUpCatalogRow {
  return {
    productVariantId: row.product_variant_id,
    productId: row.product_id,
    productLineIds: row.product_line_ids ?? [],
    category: row.category,
    productIsActive: row.product_is_active === true,
    variantIsActive: row.variant_is_active === true,
    pickSource: row.pick_source,
    asConverted: row.as_converted === true,
    sqlRulesPick: row.sql_rules_pick === true,
  };
}

/** The work's own failure is what the caller rethrows; a failed rollback is returned so the connection is destroyed. */
async function rollbackQuietly(client: Queryable): Promise<Error | undefined> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
