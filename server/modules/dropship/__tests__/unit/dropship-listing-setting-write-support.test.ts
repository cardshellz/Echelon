import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z, ZodError } from "zod";
import type { DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";
import {
  HEAVY_WRITE_RETRY_AFTER_SECONDS,
  LISTING_SETTING_INVALID_INPUT_MESSAGE,
  ListingSettingHeavyWriteGate,
  MAX_ECHOED_ISSUES,
  assertListingSettingMember,
  authorizeListingSettingWrite,
  listingSettingBulkTooLarge,
  listingSettingEbaySignInRequired,
  listingSettingIssues,
  listingSettingKeyConflict,
  listingSettingPricesMoved,
  listingSettingRequestKeyChanged,
  listingSettingOlderRulesPresent,
  listingSettingStoreIdSchema,
  listingSettingStoreTextLimit,
  listingSettingWriteHash,
  loadChosenSizes,
  parseListingSettingInput,
  requestKeyUsePath,
  type ChosenSizeReader,
  type PricingCatalogCandidate,
} from "../../application/dropship-listing-setting-write-support";
import type { ListingPriceChangeSize } from "../../application/dropship-listing-price-change-builder";
import type { DropshipListingCatalogCandidate } from "../../application/dropship-listing-preview-service";
import type { ListingSettingWriteTransaction } from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";
import { listingSettingRequestHash } from "../../domain/listing-setting-values";

const STORE = 22;
const VENDOR = 10;
const context: DropshipListingStoreContext = Object.freeze({
  vendorId: VENDOR, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE, storeStatus: "connected",
  setupStatus: "ready", platform: "ebay", storeLaunchReady: true,
});

function txWith(found: DropshipListingStoreContext | null) {
  const loadStoreContext = vi.fn(async () => found);
  const tx = { vendorId: VENDOR, storeConnectionId: STORE, catalog: { loadStoreContext } } as unknown as
    Pick<ListingSettingWriteTransaction, "vendorId" | "storeConnectionId" | "catalog">;
  return { tx, loadStoreContext };
}

async function refusal(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

describe("authorizeListingSettingWrite (plan PR 9, P10, section 3.8)", () => {
  it("reads the owner's store context once and answers it when every check passes", async () => {
    const { tx, loadStoreContext } = txWith(context);
    await expect(authorizeListingSettingWrite(tx)).resolves.toEqual(context);
    expect(loadStoreContext).toHaveBeenCalledExactlyOnceWith({ vendorId: VENDOR, storeConnectionId: STORE });
  });

  it.each([
    ["onboarding vendor", { vendorStatus: "onboarding" }],
    ["store that needs a sign-in", { storeStatus: "needs_reauth" }],
    ["store whose token refresh failed", { storeStatus: "refresh_failed" }],
  ])("allows an %s", async (_label, fields) => {
    const { tx } = txWith({ ...context, ...fields } as DropshipListingStoreContext);
    await expect(authorizeListingSettingWrite(tx)).resolves.toMatchObject(fields);
  });

  it.each([
    ["no store", null, "DROPSHIP_STORE_CONNECTION_REQUIRED", undefined],
    ["a suspended vendor", { ...context, vendorStatus: "suspended" }, "DROPSHIP_LISTING_VENDOR_BLOCKED", "suspended"],
    ["a closed vendor", { ...context, vendorStatus: "closed" }, "DROPSHIP_LISTING_VENDOR_BLOCKED", "closed"],
    ["a lapsed .ops entitlement", { ...context, entitlementStatus: "lapsed" }, "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "lapsed"],
    ["a paused store", { ...context, storeStatus: "paused" }, "DROPSHIP_LISTING_STORE_BLOCKED", "paused"],
    ["a disconnected store", { ...context, storeStatus: "disconnected" }, "DROPSHIP_LISTING_STORE_BLOCKED", "disconnected"],
    ["a store not on eBay", { ...context, platform: "shopify" }, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", undefined],
  ])("refuses %s, permanently", async (_label, found, code, reason) => {
    const error = await refusal(authorizeListingSettingWrite(txWith(found as DropshipListingStoreContext | null).tx));
    expect(error.code).toBe(code);
    expect(error.context).toEqual({ storeConnectionId: STORE, ...(reason ? { reason } : {}), retryable: false, classification: "permanent" });
  });

  it("refuses in order: vendor before entitlement before store status before platform", async () => {
    const everything: DropshipListingStoreContext = { ...context, vendorStatus: "suspended", entitlementStatus: "lapsed",
      storeStatus: "paused", platform: "shopify" };
    expect((await refusal(authorizeListingSettingWrite(txWith(everything).tx))).code).toBe("DROPSHIP_LISTING_VENDOR_BLOCKED");
    expect((await refusal(authorizeListingSettingWrite(txWith({ ...everything, vendorStatus: "active" }).tx))).code)
      .toBe("DROPSHIP_LISTING_ENTITLEMENT_BLOCKED");
    expect((await refusal(authorizeListingSettingWrite(txWith({ ...everything, vendorStatus: "active", entitlementStatus: "active" }).tx))).code)
      .toBe("DROPSHIP_LISTING_STORE_BLOCKED");
    expect((await refusal(authorizeListingSettingWrite(txWith({ ...context, platform: "shopify" }).tx))).code)
      .toBe("DROPSHIP_LISTING_SETTINGS_EBAY_ONLY");
  });
});

describe("the request hash and the replay path", () => {
  it("hashes the operation and the parsed body, and never a request key", () => {
    const body = Object.freeze({ storeConnectionId: STORE, rows: Object.freeze([Object.freeze({ productVariantId: 1, priceCents: 1, expectedRevisionId: null })]) });
    expect(listingSettingWriteHash("size_prices_v1", body)).toBe(listingSettingRequestHash({ operation: "size_prices_v1", ...body }));
    expect(listingSettingWriteHash("size_prices_v1", body)).not.toBe(listingSettingWriteHash("size_prices_v2", body));
    expect(() => listingSettingWriteHash("size_prices_v1", { ...body, idempotencyKey: "listing:abcdefgh" }))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" }));
  });

  it("takes new and replay as they are, and turns a conflict and an incomplete replay into their errors", () => {
    expect(requestKeyUsePath({ kind: "new" }, { storeConnectionId: STORE })).toBe("new");
    expect(requestKeyUsePath({ kind: "replay" }, { storeConnectionId: STORE })).toBe("replay");
    expect(() => requestKeyUsePath({ kind: "conflict", mismatched: ["size.requestHash"] }, { storeConnectionId: STORE }))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT",
        context: { storeConnectionId: STORE, mismatched: ["size.requestHash"], retryable: false, classification: "permanent" } }));
    expect(() => requestKeyUsePath({ kind: "incomplete" }, { storeConnectionId: STORE }))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE",
        context: { storeConnectionId: STORE, retryable: false, classification: "fatal" } }));
  });

  it("words a key conflict as the 8a writers do, and copies the mismatched list", () => {
    const mismatched = ["ledger.operation"];
    const error = listingSettingKeyConflict(mismatched, { storeConnectionId: STORE });
    expect(error.message).toBe("This request key was already used for a different listing settings change.");
    mismatched.push("changed later");
    expect(error.context?.mismatched).toEqual(["ledger.operation"]);
  });

  it("refuses a blank member as authentication required", () => {
    expect(() => assertListingSettingMember(" ")).toThrow(expect.objectContaining({ code: "DROPSHIP_AUTH_REQUIRED" }));
    expect(() => assertListingSettingMember("member-1")).not.toThrow();
  });
});

describe("the route input parser and its issues (plan P5)", () => {
  it("returns the parsed value, and refuses bad input as the permanent 400 code with the issues, never a bare ZodError", () => {
    expect(parseListingSettingInput(listingSettingStoreIdSchema, 22)).toBe(22);
    let thrown: unknown = null;
    try { parseListingSettingInput(listingSettingStoreIdSchema, Number.NaN); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DropshipError);
    expect(thrown).not.toBeInstanceOf(ZodError);
    expect(thrown).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", message: LISTING_SETTING_INVALID_INPUT_MESSAGE,
      context: { issues: [{ path: [], code: "invalid_type" }], retryable: false, classification: "permanent" } });
  });

  it("keeps at most 20 issues, each { path, code }, with a message only on a custom issue, and never mutates its input", () => {
    const schema = z.object({ rows: z.array(z.object({ name: z.enum(["a", "b"]) })) }).refine(() => false, "Each size once.");
    const parsed = schema.safeParse({ rows: Array.from({ length: 30 }, () => ({ name: "vendor secret text" })) });
    expect(parsed.success).toBe(false);
    const issues = Object.freeze([...parsed.error!.issues]);

    const echoed = listingSettingIssues(issues);

    expect(echoed).toHaveLength(MAX_ECHOED_ISSUES);
    expect(echoed[0]).toEqual({ path: ["rows", 0, "name"], code: "invalid_enum_value" });
    expect(JSON.stringify(echoed)).not.toContain("vendor secret text");
    expect(listingSettingIssues([{ code: "custom", path: ["rows"], message: "Each size once." }]))
      .toEqual([{ path: ["rows"], code: "custom", message: "Each size once." }]);
    // 8a's writers report a dotted path; a record without a code or a path is not an issue.
    expect(listingSettingIssues([{ path: "rows.0.priceCents", code: "too_small" }, { path: ["x"] }, { code: "custom" }, 7]))
      .toEqual([{ path: "rows.0.priceCents", code: "too_small" }]);
  });
});

describe("loadChosenSizes (plan PR 9, P12, 6.2 #5)", () => {
  const NOW = new Date("2026-10-12T09:00:00.000Z");
  function candidate(productVariantId: number, productId = 7): DropshipListingCatalogCandidate {
    return {
      productId, productVariantId, productLineIds: [], category: "Toploaders", categoryId: 3,
      ebayBrowseCategoryId: null, ebayBrowseCategoryName: null, productIsActive: true, variantIsActive: true, variantUomType: "pack",
      unitsPerVariant: 25, defaultRetailPriceCents: 1_199, sku: `S-${productVariantId}`, productName: "Toploader", variantName: "Pack",
      title: "Toploader", description: "Rigid card protection.", brand: "Card Shellz", gtin: null, mpn: null, condition: "new",
      itemSpecifics: { Size: "3x4" }, imageUrls: ["https://example.test/a.jpg"], weightGrams: 100,
    };
  }

  /** A catalog with every given size, all exposed by an include-all rule and chosen by the vendor's include-all rule. */
  function reader(options: { sizes: number[]; hidden?: number[]; disabled?: number[]; notInCatalog?: number[] }) {
    const calls: string[] = [];
    const catalog = {
      listCatalogExposureRules: vi.fn(async () => {
        calls.push("exposureRules");
        return [{ id: 1, scopeType: "catalog", action: "include" },
          ...(options.hidden ?? []).map((id, index) => ({ id: 10 + index, scopeType: "variant", action: "exclude", productVariantId: id }))];
      }),
      listSelectionRules: vi.fn(async () => { calls.push("selectionRules"); return [{ id: 2, scopeType: "catalog", action: "include", isActive: true }]; }),
      listCatalogCandidates: vi.fn(async (ids: readonly number[]) => {
        calls.push(`candidates:${ids.length}`);
        // Out of order, as a reader may return them.
        return ids.filter((id) => !(options.notInCatalog ?? []).includes(id)).map((id) => candidate(id)).reverse();
      }),
      listVariantOverrides: vi.fn(async (input: { productVariantIds: readonly number[] }) => {
        calls.push(`overrides:${input.productVariantIds.length}`);
        return input.productVariantIds.filter((id) => (options.disabled ?? []).includes(id))
          .map((productVariantId) => ({ productVariantId, enabledOverride: false }));
      }),
    };
    return { tx: { vendorId: VENDOR, catalog } as unknown as ChosenSizeReader, calls, catalog };
  }

  it("checks only the given sizes, ascending and once, in batches of 250 with the rules read once", async () => {
    const sizes = Array.from({ length: 600 }, (_, index) => 1_000 + index);
    const { tx, calls, catalog } = reader({ sizes });
    const input = Object.freeze([...sizes].reverse().concat([1_000]));

    const chosen = await loadChosenSizes(tx, input, NOW);

    expect(chosen.map((size) => size.productVariantId)).toEqual(sizes);
    expect(chosen[0]).toEqual({ productVariantId: 1_000, productId: 7, candidate: candidate(1_000) });
    expect(calls).toEqual(["exposureRules", "selectionRules", "candidates:250", "overrides:250", "candidates:250", "overrides:250",
      "candidates:100", "overrides:100"]);
    expect(catalog.listCatalogCandidates.mock.calls[0][0]).toEqual(sizes.slice(0, 250));
    expect(catalog.listVariantOverrides).toHaveBeenCalledWith({ vendorId: VENDOR, productVariantIds: sizes.slice(500) });
  });

  it("keeps only sizes Card Shellz shows and the vendor chose, and none the catalog no longer has", async () => {
    const { tx } = reader({ sizes: [101, 102, 103, 104], hidden: [102], disabled: [103], notInCatalog: [104] });
    const chosen = await loadChosenSizes(tx, [104, 103, 102, 101], NOW);
    expect(chosen).toEqual([{ productVariantId: 101, productId: 7, candidate: candidate(101) }]);
  });

  it("reads nothing for no sizes", async () => {
    const none = reader({ sizes: [] });
    await expect(loadChosenSizes(none.tx, [], NOW)).resolves.toEqual([]);
    await expect(loadChosenSizes(none.tx, [], NOW, { keepCandidates: false, firstOnly: true })).resolves.toEqual([]);
    expect(none.calls).toEqual([]);
  });

  it("keeps ids only with keepCandidates false: the same sizes, in the same batches, no candidate kept (v3r, C-money-8)", async () => {
    const sizes = Array.from({ length: 600 }, (_, index) => 1_000 + index);
    const full = reader({ sizes, hidden: [1_001], disabled: [1_002] });
    const idsOnly = reader({ sizes, hidden: [1_001], disabled: [1_002] });

    const withCandidates = await loadChosenSizes(full.tx, sizes, NOW);
    const chosen = await loadChosenSizes(idsOnly.tx, Object.freeze([...sizes].reverse()), NOW, { keepCandidates: false });

    expect(chosen).toEqual(withCandidates.map(({ productVariantId, productId }) => ({ productVariantId, productId })));
    expect(chosen).toHaveLength(598);
    expect(chosen.every((size) => !("candidate" in size))).toBe(true);
    expect(idsOnly.calls).toEqual(full.calls);
  });

  it("stops after the first batch that holds a chosen size with firstOnly, and reads on past batches with none", async () => {
    const sizes = Array.from({ length: 600 }, (_, index) => 1_000 + index);
    // Nothing in the first batch is chosen (hidden by Card Shellz), so the second batch is read, and the third is not.
    const { tx, calls } = reader({ sizes, hidden: sizes.slice(0, 250) });

    const chosen = await loadChosenSizes(tx, sizes, NOW, { keepCandidates: false, firstOnly: true });

    expect(chosen.map((size) => size.productVariantId)).toEqual(sizes.slice(250, 500));
    expect(calls).toEqual(["exposureRules", "selectionRules", "candidates:250", "overrides:250", "candidates:250", "overrides:250"]);
    // Without firstOnly every batch is read.
    const every = reader({ sizes, hidden: sizes.slice(0, 250) });
    await expect(loadChosenSizes(every.tx, sizes, NOW, { keepCandidates: false })).resolves.toHaveLength(350);
    expect(every.calls.filter((call) => call.startsWith("candidates:"))).toHaveLength(3);
  });

  it("keeps each candidate without its description, item specifics and image URLs in the pricing mode (W7; v2, C-money-12)", async () => {
    const sizes = Array.from({ length: 600 }, (_, index) => 1_000 + index);
    const full = reader({ sizes, hidden: [1_001], disabled: [1_002] });
    const pricing = reader({ sizes, hidden: [1_001], disabled: [1_002] });

    const withCandidates = await loadChosenSizes(full.tx, sizes, NOW);
    // A bound the 598 chosen sizes stay within: every batch is read.
    const chosen = await loadChosenSizes(pricing.tx, Object.freeze([...sizes].reverse()), NOW, { keepCandidates: "pricing", stopAbove: 598 });

    // The same sizes, in the same batches and order, each with every other field of its candidate.
    expect(pricing.calls).toEqual(full.calls);
    expect(chosen).toHaveLength(598);
    expect(chosen).toEqual(withCandidates.map(({ productVariantId, productId, candidate: whole }) => {
      const { description: _description, itemSpecifics: _itemSpecifics, imageUrls: _imageUrls, ...kept } = whole;
      return { productVariantId, productId, candidate: kept };
    }));
    for (const size of chosen) {
      for (const content of ["description", "itemSpecifics", "imageUrls"]) expect(size.candidate).not.toHaveProperty(content);
    }
    // A pricing candidate is what the price-change builder prices (plan 6.4), so W7 passes it as it is.
    expectTypeOf<PricingCatalogCandidate>().toMatchTypeOf<ListingPriceChangeSize["candidate"]>();
    // Everything a price, a limit or a review row reads is kept.
    expect(chosen[0].candidate).toMatchObject({ productVariantId: 1_000, productId: 7, categoryId: 3, category: "Toploaders",
      productLineIds: [], defaultRetailPriceCents: 1_199, title: "Toploader", sku: "S-1000", variantName: "Pack", unitsPerVariant: 25 });
  });

  it("stops at the first chosen size over stopAbove in the pricing mode: no later batch is read, nothing past it is kept", async () => {
    const sizes = Array.from({ length: 900 }, (_, index) => 1_000 + index);
    // Two hidden sizes in the first batch do not count toward the bound.
    const { tx, calls } = reader({ sizes, hidden: [1_001, 1_002] });

    const chosen = await loadChosenSizes(tx, sizes, NOW, { keepCandidates: "pricing", stopAbove: 300 });

    // The 301st chosen size is 1,302 (the batch of 250..499); the third and fourth batches are never read.
    expect(chosen).toHaveLength(301);
    expect(chosen.at(-1)?.productVariantId).toBe(1_302);
    expect(chosen.map((size) => size.productVariantId)).toEqual(sizes.filter((id) => id !== 1_001 && id !== 1_002).slice(0, 301));
    expect(calls).toEqual(["exposureRules", "selectionRules", "candidates:250", "overrides:250", "candidates:250", "overrides:250"]);
  });

  it("reads every batch in the pricing mode when the chosen sizes are exactly stopAbove, and keeps them all", async () => {
    const sizes = Array.from({ length: 600 }, (_, index) => 1_000 + index);
    const { tx, calls } = reader({ sizes, disabled: [1_599] });

    const chosen = await loadChosenSizes(tx, sizes, NOW, { keepCandidates: "pricing", stopAbove: 599 });

    expect(chosen).toHaveLength(599);
    expect(calls.filter((call) => call.startsWith("candidates:"))).toEqual(["candidates:250", "candidates:250", "candidates:100"]);
    // One more chosen size is over the bound: the same batches are read, and the one over it is the last kept.
    const over = reader({ sizes });
    const refused = await loadChosenSizes(over.tx, sizes, NOW, { keepCandidates: "pricing", stopAbove: 599 });
    expect(refused).toHaveLength(600);
    expect(over.calls).toEqual(calls);
  });

  it("leaves the reader's candidates as they were in the pricing mode", async () => {
    const kept = candidate(101);
    const frozen = Object.freeze({ ...kept, itemSpecifics: Object.freeze({ ...kept.itemSpecifics }), imageUrls: Object.freeze([...kept.imageUrls]) });
    const catalog = {
      listCatalogExposureRules: async () => [{ id: 1, scopeType: "catalog", action: "include" }],
      listSelectionRules: async () => [{ id: 2, scopeType: "catalog", action: "include", isActive: true }],
      listCatalogCandidates: async () => [frozen],
      listVariantOverrides: async () => [],
    };
    const chosen = await loadChosenSizes({ vendorId: VENDOR, catalog } as unknown as ChosenSizeReader, [101], NOW,
      { keepCandidates: "pricing", stopAbove: 10_000 });
    expect(chosen).toHaveLength(1);
    expect(frozen).toEqual(kept);
    expect(chosen[0].candidate).not.toBe(frozen);
  });

  it("reads every batch with firstOnly when no size is chosen at all", async () => {
    const sizes = Array.from({ length: 300 }, (_, index) => 1_000 + index);
    const { tx, calls } = reader({ sizes, disabled: sizes });
    await expect(loadChosenSizes(tx, sizes, NOW, { keepCandidates: false, firstOnly: true })).resolves.toEqual([]);
    expect(calls.filter((call) => call.startsWith("candidates:"))).toEqual(["candidates:250", "candidates:50"]);
  });
});

describe("the 9e refusal (plan P21, 8.7)", () => {
  it("builds OLDER_RULES_PRESENT with the three counts, permanent", () => {
    const error = listingSettingOlderRulesPresent(STORE, { pricingGroups: 2, contentGroups: 0, ebayCategoryRules: 1 });
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT");
    expect(error.context).toEqual({ storeConnectionId: STORE, pricingGroups: 2, contentGroups: 0, ebayCategoryRules: 1,
      retryable: false, classification: "permanent" });
  });
});

describe("the 9c refusals (plan 3.3, 6.8)", () => {
  it("builds PRICES_MOVED with at most 100 sizes and the full count, permanent", () => {
    const sizes = Array.from({ length: 150 }, (_, index) => ({ productVariantId: index + 1, expectedPriceCents: 100, priceCents: 200 }));
    const error = listingSettingPricesMoved(STORE, sizes);
    expect(error.code).toBe("DROPSHIP_LISTING_PRICES_MOVED");
    expect(error.message).toBe("Prices changed while you were editing. Reload to see the new prices, then save again.");
    expect(error.context).toMatchObject({ storeConnectionId: STORE, sizeCount: 150, retryable: false, classification: "permanent" });
    expect(error.context?.sizes).toHaveLength(100);
  });

  it("builds the sign-in refusal with the fields, the store text cap with its numbers, and a key change as retryable BUSY", () => {
    expect(listingSettingEbaySignInRequired(STORE, ["shippingPolicy"])).toMatchObject({
      code: "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED",
      context: { storeConnectionId: STORE, fields: ["shippingPolicy"], retryable: false, classification: "permanent" } });
    expect(listingSettingStoreTextLimit(STORE, 30_000_001, 30_000_000)).toMatchObject({
      code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
      message: "This store's saved listing text is at its limit. Shorten or remove text on other products, or set it once on a category or as the store default.",
      context: { reason: "store_text_limit", textBytes: 30_000_001, maxTextBytes: 30_000_000, classification: "permanent" } });
    expect(listingSettingRequestKeyChanged(STORE)).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY",
      context: { reason: "request_key_changed", retryAfterSeconds: 5, retryable: true, classification: "transient" } });
  });
});

describe("the 9d heavy-write gate and text budget refusal (plan P9, 3.10 (a), (b))", () => {
  /** A promise and the functions that settle it, so a test holds the gate as long as it wants. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  }

  it("refuses a second run while the first holds it, as retryable BUSY with five seconds, and never starts the second", async () => {
    const gate = new ListingSettingHeavyWriteGate();
    const held = deferred<string>();
    const second = vi.fn(async () => "second");
    const first = gate.run(() => held.promise);

    const busy = await refusal(gate.run(second));

    expect(HEAVY_WRITE_RETRY_AFTER_SECONDS).toBe(5);
    expect(busy).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: {
      reason: "heavy_write_in_progress", retryAfterSeconds: 5, retryable: true, classification: "transient" } });
    expect(second).not.toHaveBeenCalled();
    held.resolve("first");
    await expect(first).resolves.toBe("first");
    // Released on success: the next run goes through.
    await expect(gate.run(second)).resolves.toBe("second");
  });

  it("releases after the work throws, synchronously or later", async () => {
    const gate = new ListingSettingHeavyWriteGate();
    await expect(gate.run(async () => { throw new Error("rolled back"); })).rejects.toThrow("rolled back");
    await expect(gate.run(() => { throw new Error("thrown at once"); })).rejects.toThrow("thrown at once");
    await expect(gate.run(async () => "after")).resolves.toBe("after");
  });

  it("claims in the same step as the check: of two runs started together, exactly one works", async () => {
    const gate = new ListingSettingHeavyWriteGate();
    const work = vi.fn(async () => "done");
    const results = await Promise.allSettled([gate.run(work), gate.run(work)]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("builds the bulk text refusal with its numbers, permanent", () => {
    expect(listingSettingBulkTooLarge(STORE, 30_000_001, 30_000_000, 3_750)).toMatchObject({
      code: "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE",
      context: { storeConnectionId: STORE, textBytes: 30_000_001, maxTextBytes: 30_000_000, productCount: 3_750,
        retryable: false, classification: "permanent" },
    });
  });
});
