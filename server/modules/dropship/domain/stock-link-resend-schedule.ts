/**
 * When the one-time re-send (owner decision Q4) looks at a store's stock
 * destination or a listing's selection again (review MC-2, CF-2, CF-6).
 *
 * Explicitly stateful, in process: the push sweep's recovery keeps one instance
 * across passes (dropship-listing-push-job-runner creates the recovery once).
 * Time is always passed in (the sweep's injected clock). It only ever postpones a
 * read: a store is re-sent to only after a fresh read proves its destination
 * live, and a listing only after a fresh selection read says `publish`, so a lost
 * schedule (a restart, another process) costs at most one extra read, never a send.
 *
 * - A store whose destination is not live (missing, held, not live, duplicated,
 *   not source-ready) is read again after STOCK_DESTINATION_RECHECK_MS; the
 *   ops-health issues report it meanwhile (DROPSHIP_STOCK_DESTINATION_MISSING /
 *   _HELD).
 * - A store whose read failed for a passing reason waits a growing time
 *   (STOCK_DESTINATION_READ_BACKOFF_MS); only its first failure in a row is an
 *   anomaly worth a WARN, the repeats are DEBUG.
 * - A listing that is temporarily not eligible (paused, store mode switched off)
 *   is looked at again after STOCK_LINK_RESEND_RECHECK_MS instead of losing its
 *   only automatic re-send.
 * The postponed ids are passed to the SQL as exclusions, so they never take a
 * place in a pass's LIMIT (no starvation of other stores or items).
 */

const MINUTE_MS = 60_000;

/** A destination that is not live is read again after a minute: the re-send then follows within a minute of it going live. */
export const STOCK_DESTINATION_RECHECK_MS = 1 * MINUTE_MS;

/** Waits after 1, 2, 3+ failed destination reads in a row (a passing database or inventory condition). */
export const STOCK_DESTINATION_READ_BACKOFF_MS: readonly number[] = Object.freeze([1 * MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS]);

/** A temporarily ineligible listing's selection is read again after 15 minutes. */
export const STOCK_LINK_RESEND_RECHECK_MS = 15 * MINUTE_MS;

/**
 * Stock selection reasons (domain/stock-publication-selection.ts) that a store or
 * listing setting turns back on: a paused listing or inactive listing configuration
 * (`listing_paused`), and a store switched out of live + Card Shellz-managed
 * quantity (`managed_live_publication_not_enabled`). Every other reason (the
 * vendor or admin rules no longer select it, the listing ended, the catalog item
 * is gone or not stock-eligible) is final for the one-time re-send. A catalog rule
 * that only starts later reads as `missing_include_rule`, the same reason as no
 * rule at all (domain/catalog-exposure.ts filters rules by effectiveness before
 * matching), so it cannot be told apart and is treated as final: no send.
 */
export const STOCK_LINK_RESEND_DEFERRABLE_REASONS: ReadonlySet<string> = new Set(["listing_paused", "managed_live_publication_not_enabled"]);

export class StockLinkResendSchedule {
  private readonly stores = new Map<number, { notBefore: number; failures: number }>();
  private readonly items = new Map<number, number>();

  /** Stores whose destination is not read in this pass. */
  waitingStoreIds(now: Date): number[] {
    const at = now.getTime();
    return [...this.stores.entries()].filter(([, entry]) => entry.notBefore > at).map(([storeId]) => storeId).sort((a, b) => a - b);
  }

  /** Items whose selection is not read in this pass; expired entries are dropped. */
  deferredItemIds(now: Date): number[] {
    const at = now.getTime();
    for (const [itemId, notBefore] of this.items) if (notBefore <= at) this.items.delete(itemId);
    return [...this.items.keys()].sort((a, b) => a - b);
  }

  recordDestinationLive(storeId: number): void {
    this.stores.delete(storeId);
  }

  recordDestinationNotLive(storeId: number, now: Date): void {
    this.stores.set(storeId, { notBefore: now.getTime() + STOCK_DESTINATION_RECHECK_MS, failures: 0 });
  }

  /** A passing read failure: the store waits longer after each one in a row; `repeated` is false only for the first. */
  recordDestinationReadFailure(storeId: number, now: Date): { failures: number; waitMs: number; repeated: boolean } {
    const failures = (this.stores.get(storeId)?.failures ?? 0) + 1;
    const waitMs = STOCK_DESTINATION_READ_BACKOFF_MS[Math.min(failures, STOCK_DESTINATION_READ_BACKOFF_MS.length) - 1]!;
    this.stores.set(storeId, { notBefore: now.getTime() + waitMs, failures });
    return { failures, waitMs, repeated: failures > 1 };
  }

  /** A store whose open re-sends were taken out for review is not read again. */
  forgetStore(storeId: number): void {
    this.stores.delete(storeId);
  }

  deferItem(itemId: number, now: Date): void {
    this.items.set(itemId, now.getTime() + STOCK_LINK_RESEND_RECHECK_MS);
  }
}
