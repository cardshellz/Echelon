import { marketplaceSyncError, MARKETPLACE_SYNC_CODES } from "./marketplace-sync-errors";

/**
 * eBay sync-back quantity (owner rule 1, plan v4 §6.4). Echelon publishes its
 * ATP exactly as today. A number the vendor sets on eBay below what Echelon
 * sent, that sales since then cannot explain, is kept as the listing's vendor
 * limit, and Echelon then publishes min(ATP, that limit). A number at ATP or
 * above clears the limit (and ATP goes back when eBay shows more); a number
 * between the old limit and ATP is the new limit. 0 is a limit of 0 and the
 * listing is kept; eBay's own stock-out end is never a limit. The decision is
 * pure: the caller passes the saved observation, the baseline, the sales sums
 * for the windows `quantitySalesWindows` names, ATP and the store's order poll
 * coverage; nothing here reads a clock or the database.
 */

/** Sales this close to the baseline or the read are counted in the wide band only, never the narrow one (PROPOSED). */
export const QUANTITY_SALE_TIME_SLACK_MS = 5 * 60_000;
/** How far the order poll must have reached past the read before a limit is saved (PROPOSED; HYPOTHESIS about eBay's order search lag). */
export const QUANTITY_POLL_VISIBILITY_LAG_MS = 2 * 60_000;
/** The sales ledger starts this long after the first poll success of this release (§9: past the deploy overlap; PROPOSED). */
export const SALES_LEDGER_WARMUP_MS = 60 * 60_000;

/**
 * B, the newest of what Card Shellz last published (its settle time) and the
 * limit baseline a saved limit wrote. A publish not yet verified or
 * acknowledged (canonical), or with a push still queued or running (legacy),
 * is not settled: nothing is decided against it.
 */
export interface QuantityBaseline {
  quantity: number;
  at: Date;
  settled: boolean;
}

/** The newer of the publish baseline and the limit baseline (§6.4 "B"). A limit baseline is always settled. */
export function chooseQuantityBaseline(publish: QuantityBaseline | null,
  limit: { quantity: number; at: Date } | null): QuantityBaseline | null {
  const limitBaseline = limit === null ? null : { quantity: limit.quantity, at: limit.at, settled: true };
  if (publish === null) return limitBaseline;
  if (limitBaseline === null) return publish;
  return limitBaseline.at.getTime() >= publish.at.getTime() ? limitBaseline : publish;
}

/** A half-open time window (from, to] over sales `ordered_at`. */
export interface SalesWindow { fromExclusive: Date; toInclusive: Date }

/**
 * The two windows the sales ledger is summed over (§6.4): every sale that
 * could have happened since the baseline (wide, cancelled ones included) and
 * every live sale that surely did (narrow). An ambiguous sale time only
 * widens the band, so nothing is decided on it.
 */
export function quantitySalesWindows(baselineAt: Date, observedAt: Date): { all: SalesWindow; live: SalesWindow } {
  const slack = QUANTITY_SALE_TIME_SLACK_MS;
  return {
    all: { fromExclusive: new Date(baselineAt.getTime() - slack), toInclusive: new Date(observedAt.getTime() + slack) },
    live: { fromExclusive: new Date(baselineAt.getTime() + slack), toInclusive: new Date(observedAt.getTime() - slack) },
  };
}

/** E_low = max(0, B − S_all), E_high = max(0, B − S_live): what eBay may show after the sales Card Shellz saw. */
export function expectedQuantityRange(input: { baselineQuantity: number; salesAll: number; salesLive: number }): { low: number; high: number } {
  assertCount(input.baselineQuantity, "baselineQuantity");
  assertCount(input.salesAll, "salesAll");
  assertCount(input.salesLive, "salesLive");
  if (input.salesLive > input.salesAll) {
    throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "Live sales cannot exceed all sales.", "fatal",
      { salesAll: input.salesAll, salesLive: input.salesLive });
  }
  return { low: Math.max(0, input.baselineQuantity - input.salesAll), high: Math.max(0, input.baselineQuantity - input.salesLive) };
}

export interface MarketplaceQuantityInput {
  /** Qe and when it was read (the saved observation). */
  observed: { quantity: number; at: Date };
  baseline: QuantityBaseline | null;
  /** Σ quantity over quantitySalesWindows(B_at, t): all rows in the wide window, rows not cancelled in the narrow one. */
  sales: { all: number; live: number };
  listingLive: boolean;
  /** The store's marketplace_sales_ledger_since: before it, sales may be missing from the ledger. */
  salesLedgerSince: Date | null;
  /** The store's last_order_sync_at: the end of the last successful order poll window. */
  lastOrderSyncAt: Date | null;
  /** The listing's vendor limit now (dropship_vendor_listings.vendor_quantity_limit); null when it has none. */
  vendorQuantityLimit: number | null;
  /** Echelon's ATP for the listing, computed exactly as today, before any vendor limit. */
  atpQuantity: number;
}

export type QuantityDropReason =
  | "no_baseline" | "baseline_unsettled" | "baseline_after_observation" | "not_live_with_quantity" | "baseline_before_sales_ledger";

/** Echelon's number goes back with one push: eBay shows more than Echelon would publish. `blocked`: that number is 0, which a push cannot send. */
export interface QuantityRestore { quantity: number; blocked: boolean }

export type MarketplaceQuantityDecision =
  /** Nothing can be decided on this observation, now or later: clear it (DEBUG). */
  | { kind: "drop_observation"; reason: QuantityDropReason }
  /** Keep the observation and decide on a later tick, once the order poll has covered the read. */
  | { kind: "wait"; reason: "order_poll_behind" }
  /**
   * Clear the observation and change nothing: sales explain eBay's number, eBay
   * already shows what Echelon publishes, or a raise with no limit stays under
   * ATP (our next publish sends ATP, as today).
   */
  | { kind: "no_change"; reason: "explained_by_sales" | "already_ours" | "raised_below_atp_without_limit";
    expected: { low: number; high: number } }
  /**
   * eBay's number is the listing's vendor limit from now on. `baseline` is
   * eBay's number as the new B when it stands; null when a restore follows
   * (that publish becomes B).
   */
  | { kind: "set_limit"; limit: number; previousLimit: number | null; baseline: { quantity: number; at: Date } | null;
    restore: QuantityRestore | null; expected: { low: number; high: number } }
  /** The vendor set ATP or more: the limit goes, and Echelon publishes ATP. */
  | { kind: "clear_limit"; previousLimit: number; baseline: { quantity: number; at: Date } | null;
    restore: QuantityRestore | null; expected: { low: number; high: number } }
  /** The limit is unchanged and eBay shows more than Echelon would publish. */
  | { kind: "restore"; restore: QuantityRestore; expected: { low: number; high: number } };

/**
 * Decides one saved observation (§6.4). A baseline that is missing, not yet
 * settled, newer than the read, or older than the sales ledger can never
 * decide this observation (B_at is fixed and the ledger start is set once),
 * so the observation is dropped rather than kept for a warning that can only
 * be false; the next read after the next publish decides. Only keeping a
 * lower number waits for order poll coverage: an unseen sale only lowers
 * E_high, so a raise (Qe > E_high) holds without it.
 */
export function decideMarketplaceQuantity(input: MarketplaceQuantityInput): MarketplaceQuantityDecision {
  const qe = assertCount(input.observed.quantity, "observed");
  const atp = assertCount(input.atpQuantity, "atpQuantity");
  const limit = input.vendorQuantityLimit === null ? null : assertCount(input.vendorQuantityLimit, "vendorQuantityLimit");
  const t = input.observed.at.getTime();
  const baseline = input.baseline;
  if (baseline === null) return { kind: "drop_observation", reason: "no_baseline" };
  if (!baseline.settled) return { kind: "drop_observation", reason: "baseline_unsettled" };
  if (baseline.at.getTime() > t) return { kind: "drop_observation", reason: "baseline_after_observation" };
  // A listing not on sale with stock is the vendor's end (SB7), not a quantity.
  if (!input.listingLive && qe > 0) return { kind: "drop_observation", reason: "not_live_with_quantity" };
  if (input.salesLedgerSince === null || baseline.at.getTime() < input.salesLedgerSince.getTime() + QUANTITY_SALE_TIME_SLACK_MS) {
    return { kind: "drop_observation", reason: "baseline_before_sales_ledger" };
  }
  const expected = expectedQuantityRange({ baselineQuantity: baseline.quantity, salesAll: input.sales.all, salesLive: input.sales.live });
  if (qe >= expected.low && qe <= expected.high) return { kind: "no_change", reason: "explained_by_sales", expected };
  const lowered = qe < expected.low;
  if (lowered && (input.lastOrderSyncAt === null || input.lastOrderSyncAt.getTime() < t + QUANTITY_POLL_VISIBILITY_LAG_MS)) {
    return { kind: "wait", reason: "order_poll_behind" };
  }
  // Owner rule 1, in its order: lower than we sent → their number; at or above ATP → no limit;
  // between an old limit and ATP → their number. A raise with no old limit makes none.
  let limitAfter: number | null;
  if (lowered) limitAfter = qe;
  else if (qe >= atp) limitAfter = null;
  else if (limit !== null) limitAfter = qe;
  else return { kind: "no_change", reason: "raised_below_atp_without_limit", expected };
  const published = limitAfter === null ? atp : Math.min(atp, limitAfter);
  const restore = qe > published ? { quantity: published, blocked: published === 0 } : null;
  const newBaseline = restore === null ? { quantity: qe, at: input.observed.at } : null;
  if (limitAfter !== limit) {
    return limitAfter === null
      ? { kind: "clear_limit", previousLimit: limit as number, baseline: newBaseline, restore, expected }
      : { kind: "set_limit", limit: limitAfter, previousLimit: limit, baseline: newBaseline, restore, expected };
  }
  if (restore !== null) return { kind: "restore", restore, expected };
  // Here eBay shows exactly what Echelon publishes.
  return { kind: "no_change", reason: "already_ours", expected };
}

/**
 * Whether a baseline can judge an observation at all (§6.4 conditions 1-3):
 * the pre-write guards defer only on such a baseline, so with no baseline or
 * no ledger they never defer (§9 kill switch row).
 */
export function isQuantityBaselineUsable(baseline: QuantityBaseline | null, observedAt: Date,
  salesLedgerSince: Date | null): baseline is QuantityBaseline {
  return baseline !== null && baseline.settled && baseline.at.getTime() <= observedAt.getTime()
    && salesLedgerSince !== null
    && baseline.at.getTime() >= salesLedgerSince.getTime() + QUANTITY_SALE_TIME_SLACK_MS;
}

export type QuantityPreWriteDecision =
  | { kind: "allow" }
  /** eBay is below what sales explain and the write would raise it: refuse before any write, decide the observation first. */
  | { kind: "defer"; observed: number; expectedLow: number };

/**
 * The pre-write guard (SB31) for the inventory transport and the push
 * pre-read: refuse to write more than eBay shows while eBay is below E_low
 * (computed with the sales known now; no coverage needed to defer), so a
 * stock update never erases a vendor's lowering before it is decided. A
 * lower or equal write, or one with no usable baseline, is never deferred.
 * `desiredQuantity` null (the push pre-read, before its quantity is known)
 * defers on the lowering alone.
 */
export function decideQuantityPreWrite(input: {
  desiredQuantity: number | null; observed: { quantity: number; at: Date }; baseline: QuantityBaseline | null;
  salesAll: number; salesLedgerSince: Date | null; listingLive: boolean;
}): QuantityPreWriteDecision {
  const qe = assertCount(input.observed.quantity, "observed");
  if (input.desiredQuantity !== null && assertCount(input.desiredQuantity, "desiredQuantity") <= qe) return { kind: "allow" };
  if (!input.listingLive && qe > 0) return { kind: "allow" };
  const baseline = input.baseline;
  if (!isQuantityBaselineUsable(baseline, input.observed.at, input.salesLedgerSince)) return { kind: "allow" };
  const low = Math.max(0, baseline.quantity - assertCount(input.salesAll, "salesAll"));
  return qe < low ? { kind: "defer", observed: qe, expectedLow: low } : { kind: "allow" };
}

/** The store's sales ledger start (§8 notes, §9): the first poll success of this release plus the warm-up. */
export function salesLedgerSinceFor(firstPollSuccessAt: Date): Date {
  return new Date(firstPollSuccessAt.getTime() + SALES_LEDGER_WARMUP_MS);
}

function assertCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, `Quantity input ${name} must be a whole number.`, "fatal", { [name]: value });
  }
  return value;
}
