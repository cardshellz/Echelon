import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  chooseQuantityBaseline,
  decideMarketplaceQuantity,
  decideQuantityPreWrite,
  expectedQuantityRange,
  isQuantityBaselineUsable,
  QUANTITY_POLL_VISIBILITY_LAG_MS,
  QUANTITY_SALE_TIME_SLACK_MS,
  quantitySalesWindows,
  SALES_LEDGER_WARMUP_MS,
  salesLedgerSinceFor,
  type MarketplaceQuantityInput,
} from "../../domain/marketplace-quantity-decision";

const MINUTE = 60_000;
const LEDGER = new Date("2026-10-22T08:00:00.000Z");
const PUBLISHED = new Date("2026-10-22T09:00:00.000Z");
const READ = new Date("2026-10-22T12:00:00.000Z");
const COVERED = new Date(READ.getTime() + QUANTITY_POLL_VISIBILITY_LAG_MS);

/**
 * Card Shellz published 10 at 09:00 (settled), its ATP is still 10, there is no
 * vendor limit, the ledger started at 08:00, and the poll has covered the 12:00 read.
 */
function input(overrides: Partial<MarketplaceQuantityInput> = {}): MarketplaceQuantityInput {
  return {
    observed: { quantity: 10, at: READ },
    baseline: { quantity: 10, at: PUBLISHED, settled: true },
    sales: { all: 0, live: 0 },
    listingLive: true,
    salesLedgerSince: LEDGER,
    lastOrderSyncAt: COVERED,
    vendorQuantityLimit: null,
    atpQuantity: 10,
    ...overrides,
  };
}

/** A listing with a vendor limit of 5 (Card Shellz published 5) and an ATP of 20. */
const LIMITED = { vendorQuantityLimit: 5, baseline: { quantity: 5, at: PUBLISHED, settled: true }, atpQuantity: 20 } as const;
const observed = (quantity: number) => ({ observed: { quantity, at: READ } });

describe("decideMarketplaceQuantity (FF-12, owner rule 1, plan v4 §6.4)", () => {
  it("keeps an unexplained lower number as the listing's vendor limit, with eBay's number as the new baseline", () => {
    expect(decideMarketplaceQuantity(input(observed(4)))).toEqual({
      kind: "set_limit", limit: 4, previousLimit: null, baseline: { quantity: 4, at: READ }, restore: null, expected: { low: 10, high: 10 },
    });
  });

  it("changes nothing when sales explain the drop", () => {
    expect(decideMarketplaceQuantity(input({ ...observed(7), sales: { all: 3, live: 3 } })))
      .toEqual({ kind: "no_change", reason: "explained_by_sales", expected: { low: 7, high: 7 } });
  });

  it("clears the limit when the vendor sets ATP, and puts ATP back when they set more", () => {
    expect(decideMarketplaceQuantity(input({ ...LIMITED, ...observed(20) }))).toEqual({
      kind: "clear_limit", previousLimit: 5, baseline: { quantity: 20, at: READ }, restore: null, expected: { low: 5, high: 5 },
    });
    expect(decideMarketplaceQuantity(input({ ...LIMITED, ...observed(25) }))).toEqual({
      kind: "clear_limit", previousLimit: 5, baseline: null, restore: { quantity: 20, blocked: false }, expected: { low: 5, high: 5 },
    });
  });

  it("puts ATP back when eBay shows more than ATP and there is no limit", () => {
    expect(decideMarketplaceQuantity(input(observed(15)))).toEqual({
      kind: "restore", restore: { quantity: 10, blocked: false }, expected: { low: 10, high: 10 },
    });
  });

  it("makes a new number between the old limit and ATP the new limit", () => {
    expect(decideMarketplaceQuantity(input({ ...LIMITED, ...observed(12) }))).toEqual({
      kind: "set_limit", limit: 12, previousLimit: 5, baseline: { quantity: 12, at: READ }, restore: null, expected: { low: 5, high: 5 },
    });
  });

  it("lowers an existing limit, down to 0", () => {
    expect(decideMarketplaceQuantity(input({ ...LIMITED, ...observed(3) }))).toMatchObject({ kind: "set_limit", limit: 3, previousLimit: 5 });
    expect(decideMarketplaceQuantity(input({ ...LIMITED, ...observed(0) }))).toMatchObject({ kind: "set_limit", limit: 0, previousLimit: 5 });
  });

  it("keeps a limit of 0 when the vendor sets 0 on a listing Card Shellz had stock for (the listing is kept)", () => {
    expect(decideMarketplaceQuantity(input(observed(0)))).toMatchObject({ kind: "set_limit", limit: 0, restore: null });
    // eBay may already have ended it for having 0: still the vendor's 0 (§6.4 condition 2).
    expect(decideMarketplaceQuantity(input({ ...observed(0), listingLive: false }))).toMatchObject({ kind: "set_limit", limit: 0 });
  });

  it("never makes eBay's own stock-out end a limit: Card Shellz published 0 and eBay shows 0 (SB7)", () => {
    expect(decideMarketplaceQuantity(input({ baseline: { quantity: 0, at: PUBLISHED, settled: true }, ...observed(0),
      listingLive: false, atpQuantity: 0 }))).toEqual({ kind: "no_change", reason: "explained_by_sales", expected: { low: 0, high: 0 } });
  });

  it("does not turn a raise into a limit when there was none (ATP rose after our last publish)", () => {
    expect(decideMarketplaceQuantity(input({ ...observed(15), atpQuantity: 20 })))
      .toEqual({ kind: "no_change", reason: "raised_below_atp_without_limit", expected: { low: 10, high: 10 } });
    // eBay already at ATP: nothing to do.
    expect(decideMarketplaceQuantity(input({ ...observed(20), atpQuantity: 20 })))
      .toEqual({ kind: "no_change", reason: "already_ours", expected: { low: 10, high: 10 } });
  });

  it("keeps a lowering as the limit even when ATP fell below it since our publish, and puts ATP back", () => {
    expect(decideMarketplaceQuantity(input({ ...observed(5), atpQuantity: 3 }))).toEqual({
      kind: "set_limit", limit: 5, previousLimit: null, baseline: null, restore: { quantity: 3, blocked: false }, expected: { low: 10, high: 10 },
    });
  });

  it("marks a restore blocked when ATP is 0 (a push cannot send 0)", () => {
    expect(decideMarketplaceQuantity(input({ ...observed(12), atpQuantity: 0 })))
      .toEqual({ kind: "restore", restore: { quantity: 0, blocked: true }, expected: { low: 10, high: 10 } });
    expect(decideMarketplaceQuantity(input({ ...LIMITED, ...observed(8), atpQuantity: 0 }))).toEqual({
      kind: "clear_limit", previousLimit: 5, baseline: null, restore: { quantity: 0, blocked: true }, expected: { low: 5, high: 5 },
    });
  });

  it("treats eBay at the limit after an over-limit publish as ours, and a number under that publish as the new limit", () => {
    const overLimitPublish = { baseline: { quantity: 40, at: PUBLISHED, settled: true }, vendorQuantityLimit: 5, atpQuantity: 20 };
    expect(decideMarketplaceQuantity(input({ ...overLimitPublish, ...observed(5) })))
      .toEqual({ kind: "no_change", reason: "already_ours", expected: { low: 40, high: 40 } });
    expect(decideMarketplaceQuantity(input({ ...overLimitPublish, ...observed(10) })))
      .toMatchObject({ kind: "set_limit", limit: 10, previousLimit: 5, restore: null });
  });

  it("changes nothing inside the band a cancellation opens", () => {
    // 3 sold, 1 of them cancelled: eBay may show 7 or 8.
    for (const quantity of [7, 8]) {
      expect(decideMarketplaceQuantity(input({ ...observed(quantity), sales: { all: 3, live: 2 } })))
        .toEqual({ kind: "no_change", reason: "explained_by_sales", expected: { low: 7, high: 8 } });
    }
  });

  it("drops a stale observation (the baseline is newer than the read)", () => {
    expect(decideMarketplaceQuantity(input({ baseline: { quantity: 10, at: new Date(READ.getTime() + 1), settled: true }, ...observed(2) })))
      .toEqual({ kind: "drop_observation", reason: "baseline_after_observation" });
  });

  it("waits, keeping the observation, until the order poll has covered the read before keeping a lower number", () => {
    for (const lastOrderSyncAt of [null, READ, new Date(COVERED.getTime() - 1)]) {
      expect(decideMarketplaceQuantity(input({ ...observed(4), lastOrderSyncAt }))).toEqual({ kind: "wait", reason: "order_poll_behind" });
    }
    expect(decideMarketplaceQuantity(input({ ...observed(4), lastOrderSyncAt: COVERED })).kind).toBe("set_limit");
  });

  it("decides a raise without waiting for coverage: an unseen sale only lowers E_high", () => {
    expect(decideMarketplaceQuantity(input({ ...observed(12), lastOrderSyncAt: null })).kind).toBe("restore");
    expect(decideMarketplaceQuantity(input({ ...LIMITED, ...observed(12), lastOrderSyncAt: null })).kind).toBe("set_limit");
    expect(decideMarketplaceQuantity(input({ ...LIMITED, ...observed(20), lastOrderSyncAt: null })).kind).toBe("clear_limit");
  });

  it("widens the band for a sale whose time is close to the baseline or the read (ambiguous)", () => {
    const windows = quantitySalesWindows(PUBLISHED, READ);
    expect(windows).toEqual({
      all: { fromExclusive: new Date(PUBLISHED.getTime() - QUANTITY_SALE_TIME_SLACK_MS), toInclusive: new Date(READ.getTime() + QUANTITY_SALE_TIME_SLACK_MS) },
      live: { fromExclusive: new Date(PUBLISHED.getTime() + QUANTITY_SALE_TIME_SLACK_MS), toInclusive: new Date(READ.getTime() - QUANTITY_SALE_TIME_SLACK_MS) },
    });
    // A sale of 2 two minutes before the publish is in the wide window only: eBay at 8 or 10 is explained, 7 is not.
    const ambiguous = { sales: { all: 2, live: 0 } };
    expect(decideMarketplaceQuantity(input({ ...ambiguous, ...observed(8) })).kind).toBe("no_change");
    expect(decideMarketplaceQuantity(input({ ...ambiguous, ...observed(10) })).kind).toBe("no_change");
    expect(decideMarketplaceQuantity(input({ ...ambiguous, ...observed(7) })).kind).toBe("set_limit");
  });

  it("drops observations no later tick could decide", () => {
    expect(decideMarketplaceQuantity(input({ baseline: null }))).toEqual({ kind: "drop_observation", reason: "no_baseline" });
    expect(decideMarketplaceQuantity(input({ baseline: { quantity: 10, at: PUBLISHED, settled: false } })))
      .toEqual({ kind: "drop_observation", reason: "baseline_unsettled" });
    expect(decideMarketplaceQuantity(input({ salesLedgerSince: null })))
      .toEqual({ kind: "drop_observation", reason: "baseline_before_sales_ledger" });
    expect(decideMarketplaceQuantity(input({ salesLedgerSince: new Date(PUBLISHED.getTime() - QUANTITY_SALE_TIME_SLACK_MS + 1) })))
      .toEqual({ kind: "drop_observation", reason: "baseline_before_sales_ledger" });
    expect(decideMarketplaceQuantity(input({ salesLedgerSince: new Date(PUBLISHED.getTime() - QUANTITY_SALE_TIME_SLACK_MS) })).kind)
      .toBe("no_change");
    expect(decideMarketplaceQuantity(input({ listingLive: false, ...observed(3) })))
      .toEqual({ kind: "drop_observation", reason: "not_live_with_quantity" });
  });

  it("holds rule 1 for every limit, baseline, ATP, eBay number and sales mix", () => {
    for (const limit of [null, 0, 3, 8]) {
      for (let atp = 0; atp <= 12; atp += 1) {
        for (let baseline = 0; baseline <= 12; baseline += 1) {
          for (let ebay = 0; ebay <= 14; ebay += 1) {
            for (const sales of [{ all: 0, live: 0 }, { all: 2, live: 1 }, { all: 3, live: 3 }]) {
              const decision = decideMarketplaceQuantity(input({ vendorQuantityLimit: limit, atpQuantity: atp,
                baseline: { quantity: baseline, at: PUBLISHED, settled: true }, ...observed(ebay), sales }));
              const low = Math.max(0, baseline - sales.all);
              const high = Math.max(0, baseline - sales.live);
              const changed = ebay < low || ebay > high;
              if (!changed) expect(decision).toMatchObject({ kind: "no_change", reason: "explained_by_sales" });
              if (decision.kind === "set_limit") {
                // Their number is the limit: a lower one always, a higher one only over an old limit and under ATP.
                expect(decision.limit).toBe(ebay);
                if (ebay > high) expect(limit !== null && ebay < atp).toBe(true);
              }
              if (decision.kind === "clear_limit") expect(limit !== null && ebay >= atp && ebay > high).toBe(true);
              if (decision.kind === "set_limit" || decision.kind === "clear_limit" || decision.kind === "restore") {
                const limitAfter = decision.kind === "set_limit" ? decision.limit : decision.kind === "clear_limit" ? null : limit;
                const published = limitAfter === null ? atp : Math.min(atp, limitAfter);
                // Echelon never publishes above ATP, and puts its number back only when eBay shows more.
                expect(published).toBeLessThanOrEqual(atp);
                expect(decision.restore).toEqual(ebay > published ? { quantity: published, blocked: published === 0 } : null);
              }
            }
          }
        }
      }
    }
  });
});

describe("FF-16: a listing whose published number stays the same after sales", () => {
  it("with 3 sales and eBay at 47 keeps no limit and restores nothing (v2's rule would have restored)", () => {
    expect(decideMarketplaceQuantity(input({ baseline: { quantity: 50, at: PUBLISHED, settled: true }, atpQuantity: 50,
      sales: { all: 3, live: 3 }, ...observed(47) }))).toEqual({ kind: "no_change", reason: "explained_by_sales", expected: { low: 47, high: 47 } });
  });
});

describe("baselines and bands", () => {
  it("chooses the newer of the publish baseline and the limit baseline; a limit baseline is settled", () => {
    const publish = { quantity: 10, at: PUBLISHED, settled: false };
    const limit = { quantity: 4, at: new Date(PUBLISHED.getTime() + MINUTE) };
    expect(chooseQuantityBaseline(publish, limit)).toEqual({ ...limit, settled: true });
    expect(chooseQuantityBaseline({ ...publish, at: new Date(PUBLISHED.getTime() + 2 * MINUTE) }, limit))
      .toEqual({ quantity: 10, at: new Date(PUBLISHED.getTime() + 2 * MINUTE), settled: false });
    expect(chooseQuantityBaseline(null, null)).toBeNull();
    expect(chooseQuantityBaseline(publish, null)).toBe(publish);
  });

  it("never expects a negative quantity, and refuses live sales above all sales as an invariant break", () => {
    expect(expectedQuantityRange({ baselineQuantity: 2, salesAll: 5, salesLive: 3 })).toEqual({ low: 0, high: 0 });
    const error = (() => { try { expectedQuantityRange({ baselineQuantity: 2, salesAll: 1, salesLive: 2 }); } catch (caught) { return caught; } })();
    expect(error).toBeInstanceOf(DropshipError);
    expect(error).toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_INVARIANT_FAILED", context: { classification: "fatal" } });
  });

  it("refuses a fractional or negative quantity input", () => {
    expect(() => decideMarketplaceQuantity(input({ observed: { quantity: 1.5, at: READ } }))).toThrow(DropshipError);
    expect(() => decideMarketplaceQuantity(input({ atpQuantity: -1 }))).toThrow(DropshipError);
    expect(() => decideMarketplaceQuantity(input({ vendorQuantityLimit: 2.5 }))).toThrow(DropshipError);
  });

  it("starts the sales ledger an hour after the first poll success of this release", () => {
    expect(SALES_LEDGER_WARMUP_MS).toBe(60 * MINUTE);
    expect(salesLedgerSinceFor(READ)).toEqual(new Date(READ.getTime() + 60 * MINUTE));
  });

  it("calls a baseline usable only when settled, not after the read, and covered by the ledger", () => {
    expect(isQuantityBaselineUsable({ quantity: 1, at: PUBLISHED, settled: true }, READ, LEDGER)).toBe(true);
    expect(isQuantityBaselineUsable({ quantity: 1, at: PUBLISHED, settled: false }, READ, LEDGER)).toBe(false);
    expect(isQuantityBaselineUsable({ quantity: 1, at: PUBLISHED, settled: true }, PUBLISHED, LEDGER)).toBe(true);
    expect(isQuantityBaselineUsable({ quantity: 1, at: PUBLISHED, settled: true }, new Date(PUBLISHED.getTime() - 1), LEDGER)).toBe(false);
    expect(isQuantityBaselineUsable(null, READ, LEDGER)).toBe(false);
    expect(isQuantityBaselineUsable({ quantity: 1, at: PUBLISHED, settled: true }, READ, null)).toBe(false);
  });
});

describe("decideQuantityPreWrite (SB31: the IP transport hook and the push pre-read)", () => {
  const guard = (overrides: Partial<Parameters<typeof decideQuantityPreWrite>[0]> = {}) => decideQuantityPreWrite({
    desiredQuantity: 10, observed: { quantity: 4, at: READ }, baseline: { quantity: 10, at: PUBLISHED, settled: true },
    salesAll: 2, salesLedgerSince: LEDGER, listingLive: true, ...overrides,
  });

  it("desired 10, eBay 4, E_low 8: refused before any write", () => {
    expect(guard()).toEqual({ kind: "defer", observed: 4, expectedLow: 8 });
  });

  it("eBay at E_low: the write goes", () => {
    expect(guard({ observed: { quantity: 8, at: READ } })).toEqual({ kind: "allow" });
  });

  it("a lower or equal write is never deferred", () => {
    expect(guard({ desiredQuantity: 3 })).toEqual({ kind: "allow" });
    expect(guard({ desiredQuantity: 4 })).toEqual({ kind: "allow" });
  });

  it("the push pre-read (no desired quantity yet) defers on the lowering alone", () => {
    expect(guard({ desiredQuantity: null })).toEqual({ kind: "defer", observed: 4, expectedLow: 8 });
    expect(guard({ desiredQuantity: null, observed: { quantity: 9, at: READ } })).toEqual({ kind: "allow" });
  });

  it("never defers without a usable baseline or ledger, or on a vendor-ended listing (§9 kill switch)", () => {
    expect(guard({ baseline: null })).toEqual({ kind: "allow" });
    expect(guard({ baseline: { quantity: 10, at: PUBLISHED, settled: false } })).toEqual({ kind: "allow" });
    expect(guard({ salesLedgerSince: null })).toEqual({ kind: "allow" });
    expect(guard({ listingLive: false })).toEqual({ kind: "allow" });
    expect(guard({ listingLive: false, observed: { quantity: 0, at: READ } })).toEqual({ kind: "defer", observed: 0, expectedLow: 8 });
  });
});
