import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PUBLICATION_SCOPE_BUSY_BACKOFF_MS,
  STOCK_LINK_MAX_ATTEMPTS,
  STOCK_LINK_REFUSAL_POLICY,
  STOCK_LINK_RETRY_BACKOFF_MS,
  classifyStockLinkBlockers,
  classifyStockLinkFailure,
  dropshipCodeForStockBlocker,
  isManagedLiveIntent,
  stockLinkError,
  stockLinkRefusal,
} from "../../domain/stock-link-readiness";
import {
  DROPSHIP_STOCK_LINK_REFUSAL_CODES,
  DROPSHIP_STOCK_LINK_REFUSAL_WORDS,
  dropshipStockLinkServerMessage,
} from "../../../../../shared/dropship/stock-link-refusals";
import { DropshipError } from "../../domain/errors";

const item = (code: string, productVariantId = 101) => ({ code, productVariantId });
const target = (code: string) => ({ code, productVariantId: null });

describe("isManagedLiveIntent", () => {
  it("is true only for live listings whose quantity Card Shellz manages", () => {
    expect(isManagedLiveIntent({ listingMode: "live", inventoryMode: "managed_quantity_sync" })).toBe(true);
    for (const [listingMode, inventoryMode] of [["draft_first", "managed_quantity_sync"], ["manual_only", "managed_quantity_sync"],
      ["live", "manual_quantity"], ["live", "disabled"]]) {
      expect(isManagedLiveIntent({ listingMode, inventoryMode })).toBe(false);
    }
  });
});

describe("plan 6.1: inventory blocker -> Dropship code", () => {
  it.each([
    [target("STOCK_LISTING_TARGET_MISMATCH"), 0, "DROPSHIP_STOCK_DESTINATION_NOT_READY"],
    [target("STOCK_LISTING_TARGET_MISMATCH"), 2, "DROPSHIP_STOCK_DESTINATION_DUPLICATED"],
    [target("STOCK_LISTING_TARGET_MISMATCH"), 3, "DROPSHIP_STOCK_DESTINATION_DUPLICATED"],
    [target("PUBLICATION_DESTINATION_NOT_LIVE"), 0, "DROPSHIP_STOCK_DESTINATION_NOT_READY"],
    [target("PUBLICATION_SOURCE_NOT_READY"), 1, "DROPSHIP_STOCK_DESTINATION_NOT_READY"],
    [target("STOCK_LISTING_TARGET_UNAVAILABLE"), 1, "DROPSHIP_STOCK_DESTINATION_NOT_READY"],
    [target("CHANNEL_EXPOSURE_POLICY_INCOMPLETE"), 1, "DROPSHIP_STOCK_DESTINATION_NOT_READY"],
    [item("STOCK_LISTING_QUANTITY_UNAVAILABLE"), 1, "DROPSHIP_STOCK_ITEM_NOT_READY"],
    [item("CHANNEL_EXPOSURE_POLICY_INCOMPLETE"), 1, "DROPSHIP_STOCK_ITEM_NOT_READY"],
    [item("CHANNEL_SOURCE_OVERRIDE_UNAVAILABLE"), 1, "DROPSHIP_STOCK_ITEM_NOT_READY"],
    [item("PARTITIONED_CHANNEL_SHARE_EXCEEDS_100_PERCENT"), 1, "DROPSHIP_STOCK_ITEM_NOT_READY"],
    [target("STOCK_LISTING_HELD"), 1, "DROPSHIP_STOCK_STORE_ON_HOLD"],
    [item("STOCK_LISTING_HELD"), 1, "DROPSHIP_STOCK_ITEM_ON_HOLD"],
    [target("STOCK_LISTING_ACCOUNT_CHANGED"), 1, "DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED"],
    [item("STOCK_LISTING_MAPPING_CONFLICT"), 1, "DROPSHIP_STOCK_SKU_LINK_CONFLICT"],
    // Review TW-4: the item's own active mapping or draft names another SKU (domain/ebay-publication-readiness.ts).
    [item("STOCK_LISTING_MAPPING_REVIEW_REQUIRED"), 1, "DROPSHIP_STOCK_ITEM_LINKED_TO_OTHER_SKU"],
    [target("INVENTORY_PUBLICATION_VARIANT_MAPPING_IDENTITY_CONFLICT"), 1, "DROPSHIP_STOCK_SKU_LINK_CONFLICT"],
    [item("STOCK_LISTING_SOURCE_CHANGED"), 1, "DROPSHIP_STOCK_SKU_CHANGED"],
    [target("STOCK_MAPPING_COMMAND_CONFLICT"), 0, "DROPSHIP_STOCK_SKU_CHANGED"],
    [target("STOCK_MAPPING_LINK_CHANGED_AFTER_APPLY"), 1, "DROPSHIP_STOCK_LINK_CHANGED"],
    [item("STOCK_LISTING_NOT_SELECTED"), 1, "DROPSHIP_STOCK_NOT_OFFERED"],
    [target("INVENTORY_PUBLICATION_VARIANT_MAPPING_SCOPE_INVALID"), 1, "DROPSHIP_STOCK_NOT_OFFERED"],
    [item("DROPSHIP_STOCK_CATALOG_IDENTITY_MISSING"), 1, "DROPSHIP_STOCK_NOT_OFFERED"],
    [target("STOCK_LISTING_GLOBAL_STOP"), 1, "DROPSHIP_STOCK_UPDATES_PAUSED"],
    [target("STOCK_MAPPING_TARGET_CHANGED"), 1, "DROPSHIP_STOCK_LINK_BUSY"],
    [target("CANONICAL_AUTHORITY_REQUIRED"), 1, "DROPSHIP_STOCK_LINK_BUSY"],
    [target("STOCK_MAPPING_NOT_READY"), 1, "DROPSHIP_STOCK_LINK_BUSY"],
  ])("%o (targetCount %i) -> %s", (blocker, targetCount, code) => {
    expect(dropshipCodeForStockBlocker(blocker, targetCount)).toBe(code);
  });

  it("names the policy of every code exactly as the plan's table", () => {
    const table = Object.fromEntries(Object.entries(STOCK_LINK_REFUSAL_POLICY)
      .map(([code, policy]) => [code, [policy.classification, policy.retryable, policy.needsOperator, policy.logLevel]]));
    expect(table).toEqual({
      DROPSHIP_STOCK_DESTINATION_NOT_READY: ["permanent", false, true, "error"],
      DROPSHIP_STOCK_DESTINATION_DUPLICATED: ["permanent", false, true, "error"],
      DROPSHIP_STOCK_ITEM_NOT_READY: ["permanent", false, true, "error"],
      DROPSHIP_STOCK_STORE_ON_HOLD: ["permanent", false, false, "info"],
      DROPSHIP_STOCK_ITEM_ON_HOLD: ["permanent", false, false, "info"],
      DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED: ["permanent", false, false, "warn"],
      DROPSHIP_STOCK_SKU_LINK_CONFLICT: ["permanent", false, true, "error"],
      DROPSHIP_STOCK_ITEM_LINKED_TO_OTHER_SKU: ["permanent", false, true, "error"],
      DROPSHIP_STOCK_SKU_CHANGED: ["permanent", false, false, "info"],
      DROPSHIP_STOCK_LINK_CHANGED: ["permanent", false, false, "warn"],
      DROPSHIP_STOCK_NOT_OFFERED: ["permanent", false, false, "info"],
      DROPSHIP_STOCK_MODE_NOT_MANAGED: ["permanent", false, false, "info"],
      DROPSHIP_STOCK_UPDATES_PAUSED: ["transient", true, false, "warn"],
      DROPSHIP_STOCK_LINK_BUSY: ["transient", true, false, "warn"],
      DROPSHIP_STOCK_LINK_FAILED: ["fatal", false, true, "error"],
      DROPSHIP_STOCK_READINESS_REQUIRED: ["fatal", false, true, "error"],
      // Review TW-1: the vendor decides whether Card Shellz may take over that listing; nothing for an operator.
      DROPSHIP_STOCK_RESEND_LISTING_FOUND: ["permanent", false, false, "warn"],
    });
    expect(Object.keys(STOCK_LINK_REFUSAL_POLICY).sort()).toEqual([...DROPSHIP_STOCK_LINK_REFUSAL_CODES].sort());
  });
});

describe("classifyStockLinkBlockers", () => {
  it("lets a store-level refusal decide over item-level ones, and any permanent refusal over a transient one", () => {
    const refusal = classifyStockLinkBlockers({ targetCount: 0, blockers: [
      target("STOCK_LISTING_GLOBAL_STOP"), item("STOCK_LISTING_QUANTITY_UNAVAILABLE"), target("STOCK_LISTING_TARGET_MISMATCH"),
    ] });
    expect(refusal).toMatchObject({ code: "DROPSHIP_STOCK_DESTINATION_NOT_READY", inventoryCode: "STOCK_LISTING_TARGET_MISMATCH",
      inventoryCodes: ["STOCK_LISTING_GLOBAL_STOP", "STOCK_LISTING_QUANTITY_UNAVAILABLE", "STOCK_LISTING_TARGET_MISMATCH"],
      classification: "permanent", retryable: false, needsOperator: true, targetCount: 0, productVariantId: null });
    expect(classifyStockLinkBlockers({ targetCount: 1, blockers: [target("STOCK_LISTING_GLOBAL_STOP"), item("STOCK_LISTING_HELD")] }))
      .toMatchObject({ code: "DROPSHIP_STOCK_ITEM_ON_HOLD", productVariantId: 101, retryable: false });
    expect(classifyStockLinkBlockers({ targetCount: 1, blockers: [target("STOCK_LISTING_GLOBAL_STOP")] }))
      .toMatchObject({ code: "DROPSHIP_STOCK_UPDATES_PAUSED", classification: "transient", retryable: true });
    expect(classifyStockLinkBlockers({ targetCount: 2, blockers: [target("STOCK_LISTING_TARGET_MISMATCH"), target("STOCK_LISTING_ACCOUNT_CHANGED")] }))
      .toMatchObject({ code: "DROPSHIP_STOCK_DESTINATION_DUPLICATED", targetCount: 2 });
  });

  it("ranks an item linked to another SKU right after a SKU owned by another item", () => {
    expect(classifyStockLinkBlockers({ targetCount: 1, blockers: [item("STOCK_LISTING_MAPPING_REVIEW_REQUIRED"), item("STOCK_LISTING_MAPPING_CONFLICT")] }))
      .toMatchObject({ code: "DROPSHIP_STOCK_SKU_LINK_CONFLICT", inventoryCode: "STOCK_LISTING_MAPPING_CONFLICT" });
    expect(classifyStockLinkBlockers({ targetCount: 1, blockers: [item("STOCK_LISTING_NOT_SELECTED"), item("STOCK_LISTING_MAPPING_REVIEW_REQUIRED")] }))
      .toMatchObject({ code: "DROPSHIP_STOCK_ITEM_LINKED_TO_OTHER_SKU", needsOperator: true,
        message: "This item is already linked to a different SKU in Card Shellz stock for your store." });
  });

  it("refuses an empty blocked result instead of inventing a reason", () => {
    expect(() => classifyStockLinkBlockers({ targetCount: 1, blockers: [] })).toThrow("at least one blocker");
  });

  it("uses the vendor reason in sentence case as the server message", () => {
    for (const code of DROPSHIP_STOCK_LINK_REFUSAL_CODES) {
      const reason = DROPSHIP_STOCK_LINK_REFUSAL_WORDS[code].reason;
      // Review AV1-2: a reason that starts with "eBay" already starts its sentence; every other one is upper-cased.
      expect(stockLinkRefusal(code).message).toBe(reason.startsWith("eBay ") ? reason : reason[0]!.toUpperCase() + reason.slice(1));
      expect(dropshipStockLinkServerMessage(code)).toBe(stockLinkRefusal(code).message);
      expect(stockLinkRefusal(code).message).not.toMatch(/^EBay/);
    }
    expect(stockLinkRefusal("DROPSHIP_STOCK_SKU_CHANGED").message).toBe("The item's SKU or details changed after it was queued.");
    // The vendor email carries this message as is (describeFailedListingPushJob).
    expect(stockLinkRefusal("DROPSHIP_STOCK_RESEND_LISTING_FOUND").message)
      .toBe("eBay already has a published listing with this SKU in your store, so Card Shellz did not send this listing again automatically.");
  });

  it("builds a DropshipError the worker reads: retryable and needsOperator from the policy, detail in context", () => {
    const error = stockLinkError(classifyStockLinkBlockers({ targetCount: 0, blockers: [target("STOCK_LISTING_TARGET_MISMATCH")] }),
      { command_key: "k" });
    expect(error).toBeInstanceOf(DropshipError);
    expect(error).toMatchObject({ code: "DROPSHIP_STOCK_DESTINATION_NOT_READY",
      message: "Card Shellz hasn't turned on stock updates for your eBay store yet.",
      context: { source: "dropship_stock_link", retryable: false, needsOperator: true, classification: "permanent",
        inventoryCode: "STOCK_LISTING_TARGET_MISMATCH", targetCount: 0, command_key: "k" } });
  });
});

describe("classifyStockLinkFailure (thrown)", () => {
  const coded = (code: string, message = "x") => Object.assign(new Error(message), { code });
  it.each([
    "STOCK_MAPPING_PROVIDER_BUSY", "STOCK_MAPPING_CONCURRENT_CHANGE", "STOCK_MAPPING_REVIEW_STALE", "STOCK_MAPPING_TARGET_CHANGED",
    "STOCK_MAPPING_NOT_READY", "STOCK_MAPPING_CLEANUP_UNCERTAIN", "STOCK_MAPPING_AUTHORITY_CHANGED", "CANONICAL_AUTHORITY_REQUIRED",
    "INVENTORY_PUBLICATION_TARGET_BUSY", "CUTOVER_REVIEWED_HEAD_CHANGED",
    "40001", "40P01", "55P03", "57014", "53300", "08006", "08000", "08P01",
  ])("%s is transient", code => {
    expect(classifyStockLinkFailure(coded(code))).toEqual({ kind: "transient", inventoryCode: code });
  });

  it("classifies SQLSTATE 55000 by the fence's own message", () => {
    expect(classifyStockLinkFailure(coded("55000", "CUTOVER_CONFIGURATION_FREEZE_CHANGED")))
      .toEqual({ kind: "transient", inventoryCode: "CUTOVER_CONFIGURATION_FREEZE_CHANGED" });
    expect(classifyStockLinkFailure(coded("55000", "CUTOVER_AUTHORITY_CHANGED")))
      .toEqual({ kind: "transient", inventoryCode: "CUTOVER_AUTHORITY_CHANGED" });
    expect(classifyStockLinkFailure(coded("55000", "CUTOVER_AUTHORITY_INVALID")))
      .toEqual({ kind: "fatal", inventoryCode: "55000" });
  });

  // Review CF-1: node-postgres connection failures mostly carry no SQLSTATE. They
  // clear by themselves (pool exhausted, failover, dropped socket), and the link
  // writer is idempotent (fast path, command receipt), so they are retried like the
  // other transient conditions. Same taxonomy as dropship-finance-read-transaction.ts.
  it.each([
    ["the pool's connect timeout", new Error("timeout exceeded when trying to connect"), "DATABASE_UNAVAILABLE"],
    ["a dropped connection", new Error("Connection terminated unexpectedly"), "DATABASE_UNAVAILABLE"],
    ["a dropped connection while reading", new Error("Connection terminated due to connection timeout"), "DATABASE_UNAVAILABLE"],
    ["a client that lost its connection", new Error("Client has encountered a connection error and is not queryable"), "DATABASE_UNAVAILABLE"],
    ...["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH"]
      .map(code => [`socket ${code}`, coded(code, `connect ${code}`), code] as [string, Error, string]),
    ["57P01 administrator shutdown (failover)", coded("57P01", "terminating connection due to administrator command"), "57P01"],
    ["57P02 crash shutdown", coded("57P02", "terminating connection because of crash of another server process"), "57P02"],
    ["57P03 cannot connect now", coded("57P03", "the database system is starting up"), "57P03"],
  ])("%s is transient", (_name, error, inventoryCode) => {
    expect(classifyStockLinkFailure(error)).toEqual({ kind: "transient", inventoryCode });
  });

  it("fails closed for invariant and unknown failures", () => {
    expect(classifyStockLinkFailure(coded("PUBLICATION_AUTHORITY_MISSING"))).toEqual({ kind: "fatal", inventoryCode: "PUBLICATION_AUTHORITY_MISSING" });
    expect(classifyStockLinkFailure(coded("INVENTORY_CHANNEL_EXPOSURE_IDEMPOTENCY_CONFLICT")).kind).toBe("fatal");
    expect(classifyStockLinkFailure(coded("STOCK_MAPPING_PREPARATION_RECEIPT_INVALID")).kind).toBe("fatal");
    expect(classifyStockLinkFailure(coded("23514")).kind).toBe("fatal");
    const zod = z.object({ a: z.string() }).safeParse({});
    expect(classifyStockLinkFailure(zod.success ? null : zod.error)).toEqual({ kind: "fatal", inventoryCode: "ZodError" });
    expect(classifyStockLinkFailure(new AggregateError([], "rollback failed"))).toEqual({ kind: "fatal", inventoryCode: "AggregateError" });
    expect(classifyStockLinkFailure(new Error("boom"))).toEqual({ kind: "fatal", inventoryCode: "UNKNOWN" });
    expect(classifyStockLinkFailure("boom")).toEqual({ kind: "fatal", inventoryCode: "UNKNOWN" });
  });
});

describe("retry constants", () => {
  it("bounds the in-process retries as the plan names them", () => {
    expect(STOCK_LINK_MAX_ATTEMPTS).toBe(4);
    expect(STOCK_LINK_RETRY_BACKOFF_MS).toEqual([500, 2_000, 5_000]);
    expect(PUBLICATION_SCOPE_BUSY_BACKOFF_MS).toEqual([500, 1_500, 3_000]);
  });
});
