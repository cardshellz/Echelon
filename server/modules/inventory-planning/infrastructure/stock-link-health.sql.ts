import { sql, type SQL } from "drizzle-orm";
import { stockLinkRunnerDisableReason } from "./stock-link-runner-switch";

/**
 * The stock-link engine's operations health (channels PR2, PLAN-CH2 v4.1 §8): read-only SQL fragments, one count and
 * one sample query per issue, that OMS operations health embeds instead of reading inventory planning's tables itself
 * (published through server/modules/inventory-planning/stock-link-health.ts). Dependency-free on purpose (drizzle
 * `sql` only, like channel-stock-update-dead-letter.sql.ts): a read-only caller must not load the engine or its pool.
 * The engine's constants are written as literals here so the rendered SQL keeps no runtime import; a unit test pins
 * each literal equal to the domain's constant (STOCK_LINK_ACTOR, STOCK_LINK_RETIRE_HOLD, the escalation limits).
 *
 * Only live, Echelon-managed targets under canonical runtime authority count (§8). The destination-level issues
 * (paused, retires held, halted, stalled) count switch-on destinations only: a person who turned linking off for a
 * store has already decided about it, and the tick does nothing there (BUILD-NOTES D-P8-6).
 *
 * While the runner's kill switch is on (STOCK_LINK_AUTO_DISABLED or DISABLE_SCHEDULERS, the first rollback step, §21)
 * no tick writes the engine's rows, so a pause, a busy or retry streak and a missing heartbeat can never clear: those
 * checks are left out and one info line says linking is off (review CMP-1). Failed (`error`), flagged, waiting, held
 * and halted sizes still count: a person can act on them (Check again and Continue write the rows directly).
 */

export interface StockLinkHealthCheck {
  code: string;
  severity: "critical" | "warning" | "info";
  message: string;
  countSql: SQL;
  sampleSql: SQL;
}

const SAMPLE_LIMIT = 10;
/** IP/domain/stock-link.ts STOCK_LINK_ACTOR: every engine retire carries it in `retired_by`. */
export const STOCK_LINK_HEALTH_ENGINE_ACTOR = "system:stock-link";
/** IP/domain/stock-link.ts STOCK_LINK_RETIRE_HOLD: the window and the allowance of retires without replacement. */
export const STOCK_LINK_HEALTH_RETIRE_HOLD = Object.freeze({ windowHours: 24, limit: 25 });
/** IP/domain/stock-link.ts STOCK_LINK_DECISION_CODES.retiresHeld: the reason a check row records when the hold kept its link. */
export const STOCK_LINK_HEALTH_RETIRES_HELD_CODE = "STOCK_LINK_RETIRES_HELD";
/**
 * When a row needs a person although it is still retrying (§8 STOCK_LINK_ERROR, §10 LOOKUP_MISSED "ERROR after 8
 * attempts and 72 h", TST-9 a busy streak over 24 h). Ops Health is the only reader of these limits.
 */
export const STOCK_LINK_HEALTH_ESCALATION = Object.freeze({ attempts: 8, transientStreakHours: 72, busyStreakHours: 24 });
/** A destination paused for longer than this is raised (§8 STOCK_LINK_DESTINATION_PAUSED). */
export const STOCK_LINK_HEALTH_PAUSED_HOURS = 1;
/** A switch-on destination whose runner wrote nothing for this long is raised (§8 STOCK_LINK_STALLED). */
export const STOCK_LINK_HEALTH_STALLED_MINUTES = 10;

/**
 * The engine's retire count (§4.2 RETIRES_HELD, TST-8, D-P7-6) as text with three slots, so the engine's statement
 * (stock-link-checks.repository.ts, `$1..$3`) and Ops Health's correlated count are one predicate: versions the engine
 * retired whose head has no active version again and that have no sealed successor (a relink's old version has one),
 * retired after the window's start.
 */
export function stockLinkRetiresWithoutReplacementCountText(slots: {
  publicationTargetId: string; actor: string; windowStart: string;
}): string {
  return `SELECT count(*)::int AS count
  FROM inventory.publication_variant_mapping_versions v
  JOIN inventory.publication_variant_mapping_heads h
    ON h.publication_target_id = v.publication_target_id AND h.product_variant_id = v.product_variant_id
  WHERE v.publication_target_id = ${slots.publicationTargetId} AND v.lifecycle_status = 'retired' AND v.retired_by = ${slots.actor}
    AND h.active_mapping_id IS NULL AND v.retired_at > ${slots.windowStart}
    -- A relink retires the old version with a replacement (its sealed successor): only the last version of a pair
    -- left without one counts (BUILD-NOTES D-P7-6).
    AND NOT EXISTS (SELECT 1 FROM inventory.publication_variant_mapping_versions s
      WHERE s.supersedes_mapping_id = v.id AND s.lifecycle_status <> 'draft')`;
}

/**
 * The sizes whose retire the hold is keeping right now (review LNK-3), as text with two slots: check rows the engine
 * recorded STOCK_LINK_RETIRES_HELD for and that are not due yet (the hold writes them due in 24 h; Continue, Check
 * again or a wake makes them due, and the next tick decides them again). Reaching the allowance alone holds nothing:
 * the engine allows `limit` retires and holds only the next one (domain/stock-link.ts S2).
 */
export function stockLinkRetiresHeldCountText(slots: { publicationTargetId: string; now: string }): string {
  return `SELECT count(*)::int AS count FROM inventory.stock_link_checks held
  WHERE held.publication_target_id = ${slots.publicationTargetId} AND held.reason_code = '${STOCK_LINK_HEALTH_RETIRES_HELD_CODE}'
    AND held.next_check_at > ${slots.now}`;
}

/**
 * The clock every check compares with: the database's `now()` in production; a test passes the engine's injected
 * clock so both sides count the same rows with equal clocks (TST-8). A Date's ISO text is the only value ever
 * inlined (never caller text).
 */
function clockText(now: Date | undefined): string {
  if (now === undefined) return "now()";
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("A stock-link health clock must be a valid Date.");
  return `'${now.toISOString()}'::timestamptz`;
}

/** Live, Echelon-managed targets under canonical authority (alias `t`). */
const IN_SCOPE = `t.state = 'live' AND t.publication_authority = 'echelon'
  AND EXISTS (SELECT 1 FROM inventory.availability_runtime_authority a WHERE a.singleton_key = true AND a.authority = 'canonical')`;

function checkRows(where: string): string {
  return `FROM inventory.stock_link_checks c
    JOIN inventory.inventory_publication_targets t ON t.id = c.publication_target_id
    WHERE ${IN_SCOPE} AND (${where})`;
}

function destinationRows(where: string): string {
  return `FROM inventory.stock_link_destinations d
    JOIN inventory.inventory_publication_targets t ON t.id = d.publication_target_id
    WHERE ${IN_SCOPE} AND d.auto_link_enabled AND (${where})`;
}

const CHECK_SAMPLE_COLUMNS = `c.publication_target_id, t.channel_id, t.channel_connection_id, c.product_variant_id, c.status,
  c.reason_code, c.error_class, c.attempt_count, c.first_failure_at, c.busy_since, c.updated_at`;
const DESTINATION_SAMPLE_COLUMNS = `d.publication_target_id, t.channel_id, t.channel_connection_id, t.external_scope_id,
  d.paused_code, d.paused_since, d.paused_until, d.halted_code, d.halted_at, d.heartbeat_at, d.retires_released_at`;

function checkIssue(where: string, order: string): Pick<StockLinkHealthCheck, "countSql" | "sampleSql"> {
  return {
    countSql: sql.raw(`SELECT COUNT(*)::int AS count ${checkRows(where)}`),
    sampleSql: sql.raw(`SELECT ${CHECK_SAMPLE_COLUMNS} ${checkRows(where)} ORDER BY ${order}, c.publication_target_id, c.product_variant_id
      LIMIT ${SAMPLE_LIMIT}`),
  };
}

function destinationIssue(where: string, extraColumns = ""): Pick<StockLinkHealthCheck, "countSql" | "sampleSql"> {
  return {
    countSql: sql.raw(`SELECT COUNT(*)::int AS count ${destinationRows(where)}`),
    sampleSql: sql.raw(`SELECT ${DESTINATION_SAMPLE_COLUMNS}${extraColumns} ${destinationRows(where)}
      ORDER BY d.publication_target_id LIMIT ${SAMPLE_LIMIT}`),
  };
}

/** The checks, compared with `now` (default: the database clock); `runnerOff`: the runner's kill switch is on. */
export function stockLinkHealthChecks(options: { now?: Date; runnerOff?: boolean } = {}): readonly StockLinkHealthCheck[] {
  const now = clockText(options.now);
  const runnerOff = options.runnerOff === true;
  const escalation = STOCK_LINK_HEALTH_ESCALATION;
  const hold = STOCK_LINK_HEALTH_RETIRE_HOLD;
  const retiresInWindow = `(${stockLinkRetiresWithoutReplacementCountText({
    publicationTargetId: "d.publication_target_id", actor: `'${STOCK_LINK_HEALTH_ENGINE_ACTOR}'`,
    // stockLinkRetireWindowStart: max(now − windowHours, retires_released_at); GREATEST ignores a NULL release.
    windowStart: `GREATEST(${now} - interval '${hold.windowHours} hours', d.retires_released_at)` })})`;
  const retiresHeld = `(${stockLinkRetiresHeldCountText({ publicationTargetId: "d.publication_target_id", now })})`;
  const unlinked = checkIssue("c.status = 'waiting'", "c.updated_at");
  return Object.freeze([
    {
      code: "STOCK_LINK_UNLINKED",
      severity: "info",
      // PROPOSED: owner wording
      message: "Some store sizes are waiting for a store item with their SKU.",
      countSql: unlinked.countSql,
      // Per store: how many sizes are linked, waiting, flagged and failed (D-G), stores with a waiting size only.
      sampleSql: sql.raw(`SELECT c.publication_target_id, t.channel_id, t.channel_connection_id, t.external_scope_id,
          COUNT(*) FILTER (WHERE c.status = 'linked')::int AS linked, COUNT(*) FILTER (WHERE c.status = 'waiting')::int AS waiting,
          COUNT(*) FILTER (WHERE c.status = 'flagged')::int AS flagged, COUNT(*) FILTER (WHERE c.status = 'error')::int AS error
        ${checkRows("true")}
        GROUP BY c.publication_target_id, t.channel_id, t.channel_connection_id, t.external_scope_id
        HAVING COUNT(*) FILTER (WHERE c.status = 'waiting') > 0
        ORDER BY c.publication_target_id LIMIT ${SAMPLE_LIMIT}`),
    },
    {
      code: "STOCK_LINK_FLAGGED",
      severity: "critical",
      // PROPOSED: owner wording
      message: "Some store sizes can't be linked: a blank SKU, or a SKU used twice. Fix the SKU in the store or in Card Shellz.",
      ...checkIssue("c.status = 'flagged'", "c.updated_at"),
    },
    {
      code: "STOCK_LINK_ERROR",
      severity: "critical",
      // PROPOSED: owner wording
      message: "Stock linking failed for some store sizes and needs a person. Fix the cause, then press Check again in Channel Inventory.",
      // A streak only grows while the runner runs: with the kill switch on only rows stopped on an error count.
      ...checkIssue(runnerOff ? "c.status = 'error'" : `c.status = 'error'
        OR (c.attempt_count >= ${escalation.attempts} AND c.first_failure_at < ${now} - interval '${escalation.transientStreakHours} hours')
        OR c.busy_since < ${now} - interval '${escalation.busyStreakHours} hours'`, "c.updated_at"),
    },
    ...(runnerOff ? [] : [{
      code: "STOCK_LINK_DESTINATION_PAUSED",
      severity: "critical",
      // PROPOSED: owner wording
      message: "A store stopped answering stock-link checks for over an hour. Existing links keep working; linking resumes by itself.",
      ...destinationIssue(`d.paused_since < ${now} - interval '${STOCK_LINK_HEALTH_PAUSED_HOURS} hours'`),
    } satisfies StockLinkHealthCheck]),
    {
      code: "STOCK_LINK_RETIRES_HELD",
      severity: "critical",
      // PROPOSED: owner wording
      message: "Many store items lost their SKU today. Echelon kept their links. Check the store, then press Continue in Channel Inventory.",
      // Raised only while a retire is actually held (review LNK-3); Continue makes the held sizes due and moves the
      // window's start. The window's retire count is sampled next to it (the engine's own count, TST-8).
      ...destinationIssue(`${retiresHeld} > 0`, `, ${retiresHeld} AS retires_held, ${retiresInWindow} AS retires_in_window`),
    },
    {
      code: "STOCK_LINK_HALTED",
      severity: "critical",
      // PROPOSED: owner wording
      message: "Stock linking stopped for a store because of a setup problem. Fix it, then press Check again in Channel Inventory.",
      ...destinationIssue("d.halted_at IS NOT NULL"),
    },
    ...(runnerOff ? [{
      code: "STOCK_LINK_RUNNER_OFF",
      severity: "info",
      // PROPOSED: owner wording
      message: "Automatic stock linking is turned off for every store on the server. Existing links keep sending stock; nothing is linked, relinked or removed until it is turned back on.",
      // The stores it would run for: switch-on destinations (a store switched off is off either way).
      ...destinationIssue("true"),
    } satisfies StockLinkHealthCheck] : [{
      code: "STOCK_LINK_STALLED",
      severity: "warning",
      // PROPOSED: owner wording
      message: "Stock linking has not run for 10 minutes.",
      // The heartbeat is written every tick while the switch is on, also when paused or halted (TST-9). A destination
      // row a control just created or switched on (no beat yet) gets the same grace from its own last change.
      ...destinationIssue(`GREATEST(COALESCE(d.heartbeat_at, d.created_at), d.updated_at)
        < ${now} - interval '${STOCK_LINK_HEALTH_STALLED_MINUTES} minutes'`),
    } satisfies StockLinkHealthCheck]),
  ]);
}

/** The checks while the runner runs, against the database clock. */
export const STOCK_LINK_HEALTH_CHECKS: readonly StockLinkHealthCheck[] = stockLinkHealthChecks();
/** The checks while the runner's kill switch is on, against the database clock (review CMP-1). */
export const STOCK_LINK_HEALTH_CHECKS_RUNNER_OFF: readonly StockLinkHealthCheck[] = stockLinkHealthChecks({ runnerOff: true });

/** The checks Ops Health runs in this process: the runner is started here, so its kill switch is read here too. */
export function stockLinkHealthChecksForProcess(environment: NodeJS.ProcessEnv = process.env): readonly StockLinkHealthCheck[] {
  return stockLinkRunnerDisableReason(environment) === null ? STOCK_LINK_HEALTH_CHECKS : STOCK_LINK_HEALTH_CHECKS_RUNNER_OFF;
}
