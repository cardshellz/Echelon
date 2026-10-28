import { describe, expect, it } from "vitest";
import type { StockLinkSizeDecision } from "../../domain/stock-link";
import { classifyStockLinkFailure, StockLinkError } from "../../domain/stock-link-errors";
import {
  STOCK_LINK_CHECK_MESSAGE_MAX, boundedStockLinkMessage, stockLinkCheckAfterDecision, stockLinkCheckAfterFailure,
  stockLinkDecisionMessage, type StockLinkCheckFacts,
} from "../../domain/stock-link-check-outcome";

// Channels PR2 (PLAN-CH2 v4.1 §4.3 step 10, §4.6, §10): what a claimed check row becomes, from the decision or the
// failure, with the injected clock and random. Pure; the writer guards it by the claim's lease and revision.
const NOW = new Date("2026-10-27T12:00:00.000Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const random = () => 0.25;

const previous = (overrides: Partial<StockLinkCheckFacts> = {}): StockLinkCheckFacts => ({ status: "waiting", reasonCode: null,
  attemptCount: 0, firstFailureAt: null, busySince: null, nextCheckAt: NOW, updatedAt: NOW, waitingItemId: null, observedSku: null,
  ...overrides });

const decision = (overrides: Partial<StockLinkSizeDecision> = {}): StockLinkSizeDecision => ({ productVariantId: 101, productId: 20,
  change: "link", status: "linked", code: null, retry: null, link: { itemId: "222", storeSku: "P5", mappingAction: "create", draft: null },
  replacesMappingId: null, expectedHeadRevision: "0", cardShellzSku: "P5", selectionAction: "publish", waitingItemId: null,
  dueNextTick: false, recordObservedSku: null, detail: null, rule: "L10", ...overrides });

describe("stockLinkCheckAfterDecision", () => {
  it("settles a linked size: streaks cleared, re-observed in 24 h", () => {
    expect(stockLinkCheckAfterDecision(decision(), previous({ attemptCount: 3, firstFailureAt: at(-DAY), busySince: at(-MIN),
      reasonCode: "STOCK_LINK_LOOKUP_MISSED", observedSku: "OLD" }), NOW, random)).toEqual({ status: "linked", reasonCode: null,
      errorClass: null, message: null, attemptCount: 0, firstFailureAt: null, busySince: null, nextCheckAt: at(DAY), waitingItemId: null,
      observedSku: null });
  });

  it("re-observes a flagged size daily, keeps the item it waits on and says why", () => {
    const flagged = decision({ change: "retire", status: "flagged", code: "STOCK_LINK_ITEM_SHARED", link: null, replacesMappingId: 61,
      waitingItemId: "223", detail: { kind: "ITEM_HELD", itemId: "223", heldByProductVariantIds: [102] } });
    expect(stockLinkCheckAfterDecision(flagged, previous(), NOW, random)).toMatchObject({ status: "flagged",
      reasonCode: "STOCK_LINK_ITEM_SHARED", nextCheckAt: at(DAY), waitingItemId: "223",
      message: "ITEM_HELD: store item 223 held by sizes 102" });
  });

  it("backs a repeated wait off from its last interval, restarts a new or early-woken wait at 15 min, and never past 24 h", () => {
    const waiting = decision({ change: "retire", status: "waiting", code: "STOCK_LINK_NOT_LISTED", link: null, replacesMappingId: 61 });
    expect(stockLinkCheckAfterDecision(waiting, previous(), NOW, random).nextCheckAt).toEqual(at(15 * MIN));
    expect(stockLinkCheckAfterDecision(waiting, previous({ reasonCode: "STOCK_LINK_NOT_LISTED", updatedAt: at(-60 * MIN) }), NOW, random)
      .nextCheckAt).toEqual(at(120 * MIN));
    // Another wait reason, or a wake (updated_at = next_check_at), starts again.
    expect(stockLinkCheckAfterDecision(waiting, previous({ reasonCode: "STOCK_LINK_NOT_ON_SALE", updatedAt: at(-60 * MIN) }), NOW, random)
      .nextCheckAt).toEqual(at(15 * MIN));
    expect(stockLinkCheckAfterDecision(waiting, previous({ reasonCode: "STOCK_LINK_NOT_LISTED" }), NOW, random).nextCheckAt).toEqual(at(15 * MIN));
    expect(stockLinkCheckAfterDecision(waiting, previous({ reasonCode: "STOCK_LINK_NOT_LISTED", updatedAt: at(-20 * 60 * MIN) }), NOW, random)
      .nextCheckAt).toEqual(at(DAY));
  });

  it("makes a size waiting for a freed item due at once (next tick, SAF-5)", () => {
    expect(stockLinkCheckAfterDecision(decision({ change: "retire", status: "waiting", code: "STOCK_LINK_WAITING_FOR_FREED_ITEM", link: null,
      replacesMappingId: 61, waitingItemId: "224", dueNextTick: true }), previous(), NOW, random))
      .toMatchObject({ status: "waiting", nextCheckAt: NOW, waitingItemId: "224" });
  });

  it("counts a self-check miss as a transient attempt and keeps the link status", () => {
    const missed = decision({ change: "none", status: "linked", code: "STOCK_LINK_LOOKUP_MISSED", retry: "transient", link: null });
    expect(stockLinkCheckAfterDecision(missed, previous({ status: "linked", attemptCount: 2, firstFailureAt: at(-DAY), busySince: at(-MIN) }),
      NOW, random)).toMatchObject({ status: "linked", reasonCode: "STOCK_LINK_LOOKUP_MISSED", errorClass: "transient", attemptCount: 3,
      firstFailureAt: at(-DAY), busySince: null, nextCheckAt: at(40 * MIN) });
  });

  it("releases a size the tick could not read as busy (no attempt), and keeps a held retire as it was", () => {
    const unread = decision({ change: "none", status: "unchanged", code: "STOCK_LINK_CALL_BUDGET_USED", retry: "busy", link: null });
    expect(stockLinkCheckAfterDecision(unread, previous({ status: "linked", attemptCount: 1, busySince: at(-MIN) }), NOW, random))
      .toMatchObject({ status: "linked", attemptCount: 1, busySince: at(-MIN), errorClass: "transient", nextCheckAt: at(MIN + 30_000) });
    const held = decision({ change: "none", status: "unchanged", code: "STOCK_LINK_RETIRES_HELD", retry: null, link: null });
    expect(stockLinkCheckAfterDecision(held, previous({ status: "linked", observedSku: "S" }), NOW, random))
      .toEqual({ status: "linked", reasonCode: "STOCK_LINK_RETIRES_HELD", errorClass: null, message: null, attemptCount: 0,
        firstFailureAt: null, busySince: null, nextCheckAt: at(DAY), waitingItemId: null, observedSku: "S" });
  });

  it("records a grandfathered store SKU once and keeps it while the link stays", () => {
    const kept = decision({ change: "none", link: null, rule: "V6", recordObservedSku: "SHOPIFY-5" });
    expect(stockLinkCheckAfterDecision(kept, previous({ status: "linked" }), NOW, random).observedSku).toBe("SHOPIFY-5");
    expect(stockLinkCheckAfterDecision(decision({ change: "none", link: null, rule: "V5" }), previous({ status: "linked", observedSku: "SHOPIFY-5" }),
      NOW, random).observedSku).toBe("SHOPIFY-5");
  });

  it("refuses a row stopped on an error (never claimed) and an undecided size without a reason", () => {
    expect(() => stockLinkCheckAfterDecision(decision(), previous({ status: "error", nextCheckAt: null }), NOW, random))
      .toThrow(expect.objectContaining({ code: "STOCK_LINK_STATE_INVALID" }));
    expect(() => stockLinkCheckAfterDecision(decision({ status: "unchanged", code: null, retry: null }), previous(), NOW, random))
      .toThrow(expect.objectContaining({ code: "STOCK_LINK_STATE_INVALID" }));
  });
});

describe("stockLinkCheckAfterFailure", () => {
  const failure = (error: unknown) => classifyStockLinkFailure(error);

  it("busy: released in 60-180 s from the injected random, no attempt, the busy streak kept or started", () => {
    const busy = failure(new StockLinkError("STOCK_LINK_SCOPE_BUSY", "busy"));
    expect(stockLinkCheckAfterFailure(busy, "busy", previous({ attemptCount: 2, firstFailureAt: at(-DAY) }), NOW, () => 0))
      .toMatchObject({ status: "waiting", attemptCount: 2, firstFailureAt: at(-DAY), busySince: NOW, nextCheckAt: at(MIN),
        reasonCode: "STOCK_LINK_SCOPE_BUSY", errorClass: "transient" });
    expect(stockLinkCheckAfterFailure(busy, "busy", previous({ busySince: at(-DAY) }), NOW, () => 0.999999).busySince).toEqual(at(-DAY));
    expect(stockLinkCheckAfterFailure(busy, "busy", previous(), NOW, () => 0.999999).nextCheckAt).toEqual(at(3 * MIN));
  });

  it("transient: an attempt, the failure streak kept, backoff from the attempt count, Retry-After honoured only when longer", () => {
    const transient = failure(new StockLinkError("STOCK_LINK_HEAD_CHANGED", "changed"));
    expect(stockLinkCheckAfterFailure(transient, "changed", previous({ attemptCount: 1, firstFailureAt: at(-MIN), busySince: at(-MIN) }), NOW, random))
      .toMatchObject({ attemptCount: 2, firstFailureAt: at(-MIN), busySince: null, nextCheckAt: at(20 * MIN), errorClass: "transient" });
    const throttled = failure(new StockLinkError("STOCK_LINK_PROVIDER_THROTTLED", "slow down", {}, { retryAfterMs: 3_600_000 }));
    expect(stockLinkCheckAfterFailure(throttled, "slow down", previous(), NOW, random).nextCheckAt).toEqual(at(60 * MIN));
    // A statement timeout (57014) is a transient attempt, never an error (TST-2).
    expect(stockLinkCheckAfterFailure(failure(Object.assign(new Error("canceling statement"), { code: "57014" })), "timeout", previous(), NOW, random))
      .toMatchObject({ status: "waiting", reasonCode: "STOCK_LINK_STATEMENT_TIMEOUT", attemptCount: 1, nextCheckAt: at(10 * MIN) });
  });

  it("cleanup uncertain without a receipt counts as a transient attempt (TST-7)", () => {
    expect(stockLinkCheckAfterFailure(failure(new StockLinkError("STOCK_MAPPING_CLEANUP_UNCERTAIN", "uncertain")), "uncertain", previous(), NOW, random))
      .toMatchObject({ attemptCount: 1, errorClass: "transient", reasonCode: "STOCK_MAPPING_CLEANUP_UNCERTAIN" });
  });

  it("permanent: the row stops on an error with no next check until Check again", () => {
    expect(stockLinkCheckAfterFailure(failure(new StockLinkError("STOCK_MAPPING_COMMAND_CONFLICT", "conflict")), "conflict",
      previous({ attemptCount: 2, busySince: at(-MIN), waitingItemId: "223" }), NOW, random)).toEqual({ status: "error",
      reasonCode: "STOCK_MAPPING_COMMAND_CONFLICT", errorClass: "permanent", message: "conflict", attemptCount: 2, firstFailureAt: null,
      busySince: null, nextCheckAt: null, waitingItemId: "223", observedSku: null });
  });

  it.each([
    ["fatal", new StockLinkError("STOCK_LINK_STATE_INVALID", "broken")],
    ["pause", new StockLinkError("STOCK_LINK_STORE_AUTH_REFUSED", "401")],
    ["database_unavailable", Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P01" })],
  ])("never writes a %s failure to the row (the tick owns it)", (_kind, error) => {
    expect(() => stockLinkCheckAfterFailure(failure(error), "x", previous(), NOW, random))
      .toThrow(expect.objectContaining({ code: "STOCK_LINK_STATE_INVALID" }));
  });
});

describe("messages", () => {
  it("summarises each decision detail technically, and bounds a message to the column", () => {
    expect(stockLinkDecisionMessage({ detail: { kind: "ECHELON_SKU_SHARED", productVariantIds: [101, 102] } })).toBe("ECHELON_SKU_SHARED: sizes 101, 102");
    expect(stockLinkDecisionMessage({ detail: { kind: "SKU_DUPLICATE", itemIds: ["222", "223"] } })).toBe("SKU_DUPLICATE: store items 222, 223");
    expect(stockLinkDecisionMessage({ detail: { kind: "SELECTION_BLOCKED", action: "zero", blockerCodes: ["A", "B"] } })).toBe("SELECTION_BLOCKED: zero (A, B)");
    expect(stockLinkDecisionMessage({ detail: { kind: "SELECTION_BLOCKED", action: "none", blockerCodes: [] } })).toBe("SELECTION_BLOCKED: none");
    expect(stockLinkDecisionMessage({ detail: { kind: "WAITING_FOR_FREED_ITEM", itemId: "224", freedByProductVariantIds: [201] } }))
      .toBe("WAITING_FOR_FREED_ITEM: store item 224 freed by sizes 201");
    expect(stockLinkDecisionMessage({ detail: null })).toBeNull();
    expect(boundedStockLinkMessage("   ")).toBeNull();
    const long = boundedStockLinkMessage("é".repeat(2_000))!;
    expect(Array.from(long)).toHaveLength(STOCK_LINK_CHECK_MESSAGE_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});
