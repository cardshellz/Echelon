import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  classifyMarketplaceSyncError,
  marketplaceSyncError,
  MARKETPLACE_SYNC_CODES,
} from "../../domain/marketplace-sync-errors";

function pgError(code: string, message = "pg failure") {
  return Object.assign(new Error(message), { code });
}

function http(status: number, method = "GET") {
  return new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", `eBay HTTP ${status}`, { status, method, retryable: status >= 500 || status === 429 });
}

describe("classifyMarketplaceSyncError (plan v4 §6.6, CLAUDE.md §6)", () => {
  it.each([
    ["a 429", http(429), "transient", "stop_store", "warn"],
    ["a 401 after its repair", http(401), "transient", "skip_store", "warn"],
    ["a 403", http(403), "transient", "skip_store", "warn"],
    ["a 5xx", http(503), "transient", "skip_listing", "warn"],
    ["no answer", new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_NETWORK_ERROR", "no answer", { retryable: true, network: true }), "transient", "skip_listing", "warn"],
    ["a 400 from eBay", http(400), "permanent", "review", "error"],
    ["W9's version conflict", new DropshipError("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", "moved"), "transient", "retry_next_tick", "debug"],
    ["a lost observation compare-and-set", marketplaceSyncError(MARKETPLACE_SYNC_CODES.observationChanged, "lost", "transient"), "transient", "retry_next_tick", "debug"],
    ["W9's price limit", new DropshipError("DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", "limit"), "permanent", "flag_price_limit", "warn"],
    ["a vendor that may not list", new DropshipError("DROPSHIP_LISTING_VENDOR_BLOCKED", "blocked"), "expected", "ignore", "debug"],
    ["an entitlement block", new DropshipError("DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "blocked"), "expected", "ignore", "debug"],
    ["a size not available", new DropshipError("DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", "na"), "expected", "ignore", "debug"],
    ["W9's invariant", new DropshipError("DROPSHIP_LISTING_PRICE_INVARIANT_FAILED", "broken"), "fatal", "abort_tick", "error"],
    ["sync-back's invariant", marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "broken", "fatal"), "fatal", "abort_tick", "error"],
    ["a bad key", marketplaceSyncError(MARKETPLACE_SYNC_CODES.invalidKey, "bad", "fatal"), "fatal", "abort_tick", "error"],
    // The store's credentials could not be loaded: every listing of it would fail the same way (the sweep's provider read).
    ["a store that cannot be read now", marketplaceSyncError(MARKETPLACE_SYNC_CODES.storeUnavailable, "no token", "transient"), "transient", "skip_store", "warn"],
    ["another classified transient error", new DropshipError("DROPSHIP_X", "x", { classification: "transient" }), "transient", "retry_next_tick", "warn"],
    ["an unclassified dropship error", new DropshipError("DROPSHIP_X", "x"), "permanent", "review", "error"],
    ["a serialization failure", pgError("40001"), "transient", "retry_next_tick", "debug"],
    ["a deadlock", pgError("40P01"), "transient", "retry_next_tick", "debug"],
    ["a lock timeout", pgError("55P03"), "transient", "retry_next_tick", "debug"],
    ["a content predecessor conflict", pgError("23514", "Listing content predecessor conflict"), "transient", "retry_next_tick", "debug"],
    ["another CHECK violation", pgError("23514", 'new row violates check constraint "dropship_listing_qty_observed_chk"'), "permanent", "review", "error"],
    ["a unique violation", pgError("23505"), "permanent", "review", "error"],
    ["an SQL defect", pgError("42703"), "permanent", "review", "error"],
    ["a lost connection", pgError("08006"), "transient", "skip_listing", "warn"],
    // MS4: an error nothing classifies is a defect a retry repeats: reviewed once, never retried every tick.
    ["something unknown", new Error("boom"), "permanent", "review", "error"],
    ["a code defect", new TypeError("Cannot read properties of undefined"), "permanent", "review", "error"],
    // A socket that failed below the providers' own wrapping is still I/O: read again next tick.
    ["a reset socket", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), "transient", "skip_listing", "warn"],
  ])("%s is %s (%s, logged at %s)", (_name, error, classification, handling, logLevel) => {
    expect(classifyMarketplaceSyncError(error)).toMatchObject({ classification, handling, logLevel });
  });

  it("logs the error's own code, the SQLSTATE, or UNEXPECTED_ERROR", () => {
    expect(classifyMarketplaceSyncError(http(429)).code).toBe("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR");
    expect(classifyMarketplaceSyncError(pgError("40P01")).code).toBe("40P01");
    expect(classifyMarketplaceSyncError("not an error").code).toBe("UNEXPECTED_ERROR");
  });

  it("builds classified errors whose retryable flag follows the class", () => {
    expect(marketplaceSyncError("C", "m", "transient", { listingId: 1 }).context).toEqual({ listingId: 1, classification: "transient", retryable: true });
    expect(marketplaceSyncError("C", "m", "permanent").context).toEqual({ classification: "permanent", retryable: false });
  });
});
