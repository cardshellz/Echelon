import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import { describe, expect, it } from "vitest";
import {
  buildChooseSelectionSave,
  chooseCatalogPageSchema,
  chooseListingTierNameSchema,
  chooseListingTierReasonSchema,
  chooseRulesView,
  chooseSaveBodyBytes,
  chooseSaveResult,
  chooseSelectionActionSchema,
  chooseSelectionReasonSchema,
  chooseSelectionRulesResponseSchema,
  chooseSelectionScopeSchema,
  MAX_SELECTION_RULES,
  reduceChooseChanges,
  sameRuleContent,
  SELECTION_SAVE_BODY_LIMIT_BYTES,
  EMPTY_CHOOSE_CHANGES,
  toSelectionRuleInput,
  type ChooseCatalogRow,
  type ChooseChanges,
  type ChooseMark,
  type ChooseRuleInput,
  type ChooseSelectionRule,
} from "../../../../../client/src/lib/dropship-catalog-choose";
import {
  dropshipVendorSelectionActionSchema,
  dropshipVendorSelectionScopeSchema,
  replaceDropshipVendorSelectionRulesInputSchema,
} from "../../application/dropship-selection-dtos";
import {
  DropshipSelectionAtpService,
  hashVendorSelectionRules,
  normalizeVendorSelectionRule,
  type DropshipSelectionAtpRepository,
  type DropshipVendorCatalogCandidate,
  type DropshipVendorSelectionRuleRecord,
  type DropshipVendorVariantOverrideRecord,
} from "../../application/dropship-selection-atp-service";
import {
  evaluateDropshipVendorCatalogSelection,
  type DropshipVendorCatalogSelectionReason,
  type DropshipVendorVariantOverride,
} from "../../domain/vendor-selection";
import type { DropshipCatalogVariantCandidate } from "../../domain/catalog-exposure";
import { DROPSHIP_LISTING_TIERS, type DropshipListingTierBlockReason, type DropshipListingTierEligibility } from "../../domain/listing-tiers";
import { isDropshipBulkJsonRequest } from "../../interfaces/http/dropship-bulk-json.middleware";
import { GLOBAL_JSON_LIMIT_BYTES, installGlobalJsonBodyParser } from "../../../shipping-engine/interfaces/http/rate-table-admin-body.middleware";

/**
 * Catalog step 1's save (client/src/lib/dropship-catalog-choose.ts) against
 * the unchanged server: its bodies pass the PUT's schema, its limits are the
 * server's, its compact rules store and hash as the full form did, its
 * content compare agrees with the server's hash, and through the real
 * evaluator every marked size ends as marked while every other size stays as
 * it was.
 */

const KEY = "catalog-selection:00000000-0000-4000-8000-000000000000";

function serverParse(rules: readonly unknown[]) {
  return replaceDropshipVendorSelectionRulesInputSchema.safeParse({
    vendorId: 1, idempotencyKey: KEY, actor: { actorType: "vendor", actorId: "m-1" }, rules,
  });
}

function serverHash(rules: readonly unknown[]): string {
  const parsed = serverParse(rules);
  if (!parsed.success) throw new Error(`server refused: ${JSON.stringify(parsed.error.issues)}`);
  return hashVendorSelectionRules(parsed.data.rules.map(normalizeVendorSelectionRule));
}

/** What the server stores for a save: every rule normalized, under new ids (dropship-selection-atp.repository.ts). */
function stored(built: readonly ChooseRuleInput[], firstId: number): ChooseSelectionRule[] {
  const parsed = serverParse(built);
  if (!parsed.success) throw new Error(`server refused: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data.rules.map(normalizeVendorSelectionRule).map((rule, index) => ({
    id: firstId + index, revisionId: 2, scopeType: rule.scopeType, action: rule.action,
    productLineId: rule.productLineId, productId: rule.productId, productVariantId: rule.productVariantId, category: rule.category,
    autoConnectNewSkus: rule.autoConnectNewSkus, autoListNewSkus: rule.autoListNewSkus, priority: rule.priority, metadata: rule.metadata, isActive: true,
  }));
}

function legacyRule(id: number, scopeType: ChooseSelectionRule["scopeType"], action: ChooseSelectionRule["action"], target: Partial<ChooseSelectionRule>): ChooseSelectionRule {
  return { id, revisionId: 1, scopeType, action, productLineId: null, productId: null, productVariantId: null, category: null,
    autoConnectNewSkus: action === "include", autoListNewSkus: false, priority: action === "include" ? 50 : 150,
    metadata: { source: "portal_catalog_scope" }, isActive: true, ...target };
}

interface FixtureSize { candidate: DropshipCatalogVariantCandidate; override: DropshipVendorVariantOverride | null }

function size(productVariantId: number, productId: number, category: string, override: DropshipVendorVariantOverride | null = null): FixtureSize {
  return { candidate: { productId, productVariantId, productLineIds: [9], category, productIsActive: true, variantIsActive: true, variantUomType: "pack" }, override };
}

/**
 * The fixture catalog: picks, a legacy category include, a legacy product
 * include, a legacy variant keep-out, a legacy category keep-out and an
 * override, as older data might hold them.
 */
const SIZES: readonly FixtureSize[] = [
  size(1, 1, "Mailers"), // own pick + category include
  size(2, 1, "Mailers"), // category include only
  size(3, 2, "Sleeves"), // product include only
  size(4, 2, "Sleeves"), // product include + own keep-out ("Removed by you")
  size(5, 3, "Toploaders"), // nothing
  size(6, 3, "Toploaders", { productVariantId: 6, enabledOverride: false }), // own pick, turned off
  size(7, 4, "Penny"), // a lone own pick
  size(8, 5, "Binders"), // own pick + category keep-out (older setting)
  size(9, 6, "Penny", { productVariantId: 9, enabledOverride: false }), // nothing, turned off (review CT3: reads "Not selected")
];
const LEGACY: readonly ChooseSelectionRule[] = [
  legacyRule(1, "variant", "include", { productVariantId: 1, priority: 100, metadata: { source: "portal_catalog" } }),
  legacyRule(2, "category", "include", { category: "Mailers" }),
  legacyRule(3, "product", "include", { productId: 2 }),
  legacyRule(4, "variant", "exclude", { productVariantId: 4, priority: 200, metadata: { source: "portal_catalog" } }),
  legacyRule(5, "variant", "include", { productVariantId: 6, priority: 100, metadata: { source: "portal_catalog" } }),
  legacyRule(6, "variant", "include", { productVariantId: 7, priority: 100, metadata: { source: "portal_catalog" } }),
  legacyRule(7, "category", "exclude", { category: "Binders" }),
  legacyRule(8, "variant", "include", { productVariantId: 8, priority: 100, metadata: { source: "portal_catalog" } }),
];

/** The catalog rows as the server reads them under `rules` (dropship-selection-atp-service.ts, previewCatalog). */
function rowsUnder(rules: readonly ChooseSelectionRule[]): ChooseCatalogRow[] {
  return SIZES.map(({ candidate, override }) => {
    const decision = evaluateDropshipVendorCatalogSelection({
      candidate, adminExposureDecision: { exposed: true, reason: "exposed", includeRuleIds: [], excludeRuleIds: [] },
      rules, rawAtpUnits: 12, override,
    });
    return {
      productId: candidate.productId, productVariantId: candidate.productVariantId, productSku: null, productName: `Product ${candidate.productId}`,
      variantSku: null, variantName: `Size ${candidate.productVariantId}`, category: candidate.category,
      selectionDecision: { selected: decision.selected, reason: decision.reason, marketplaceQuantity: decision.marketplaceQuantity,
        includeRuleIds: decision.includeRuleIds, excludeRuleIds: decision.excludeRuleIds },
    };
  });
}

/** The vendor's clicks on these sizes, through the page's own reducer. */
function clicks(rules: readonly ChooseSelectionRule[], sizes: readonly number[]): ChooseChanges {
  const view = chooseRulesView(rules);
  const rows = rowsUnder(rules);
  return sizes.reduce<ChooseChanges>((changes, productVariantId) => {
    const target = rows.find((entry) => entry.productVariantId === productVariantId);
    if (!target) throw new Error(`no size ${productVariantId}`);
    return reduceChooseChanges(changes, { type: "toggle", row: target, rules: view });
  }, EMPTY_CHOOSE_CHANGES);
}

function decisions(rules: readonly ChooseSelectionRule[]) {
  return new Map(rowsUnder(rules).map((entry) => [entry.productVariantId, { selected: entry.selectionDecision.selected, reason: entry.selectionDecision.reason }]));
}

/** Saves the marks as the page would and checks every size against what it should be. */
function saveAndCheck(rules: readonly ChooseSelectionRule[], marks: readonly ChooseMark[], firstId: number) {
  const built = buildChooseSelectionSave(rules, marks);
  expect(serverParse(built).success).toBe(true);
  const after = stored(built, firstId);
  const before = decisions(rules);
  const now = decisions(after);
  const marked = new Map(marks.map((entry) => [entry.productVariantId, entry.to]));
  for (const [productVariantId, decision] of now) {
    const to = marked.get(productVariantId);
    if (to) expect(decision.selected, `size ${productVariantId}`).toBe(to === "selected");
    else expect(decision, `size ${productVariantId} was not touched`).toEqual(before.get(productVariantId));
  }
  return { built, after, now };
}

describe("catalog step 1 save contract", () => {
  it("C1 every body the builder makes passes the PUT's schema", () => {
    const markSets: number[][] = [[5], [4], [2], [7], [1], [3], [1, 2, 3, 4, 5, 7], []];
    for (const sizes of markSets) {
      const built = buildChooseSelectionSave(LEGACY, clicks(LEGACY, sizes).marks);
      const parsed = serverParse(built);
      expect(parsed.success, JSON.stringify(sizes)).toBe(true);
    }
    // Older duplicates collapse before sending, so a duplicate never makes the PUT a permanent 400.
    const duplicated = [...LEGACY, legacyRule(20, "category", "include", { category: " mailers " })];
    const refused = serverParse(duplicated.map((rule) => toSelectionRuleInput(rule)));
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.message)).toEqual(["Duplicate vendor selection rule."]);
    expect(serverParse(buildChooseSelectionSave(duplicated, [])).success).toBe(true);
  });

  it("C2 the 500-rule cap is the server's: 500 parse, 501 are refused on both sides", () => {
    const picks = (count: number) => Array.from({ length: count }, (_, index) =>
      legacyRule(100 + index, "variant", "include", { productVariantId: 1_000 + index }));
    expect(serverParse(buildChooseSelectionSave(picks(500), [])).success).toBe(true);
    const refused = serverParse(buildChooseSelectionSave(picks(501), []));
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]).toMatchObject({ code: "too_big", maximum: MAX_SELECTION_RULES, path: ["rules"] });
    expect(MAX_SELECTION_RULES).toBe(500);
  });

  it("C3 the body limit is the global JSON parser's, which the PUT goes through; 500 compact picks fit it", async () => {
    expect(SELECTION_SAVE_BODY_LIMIT_BYTES).toBe(GLOBAL_JSON_LIMIT_BYTES);
    expect(isDropshipBulkJsonRequest("PUT", "/api/dropship/catalog/selection-rules")).toBe(false);
    const picks = Array.from({ length: 500 }, (_, index) => legacyRule(100 + index, "variant", "include", { productVariantId: 1_000_000 + index }));
    const built = buildChooseSelectionSave(picks, []);
    expect(chooseSaveBodyBytes(built)).toBeLessThan(GLOBAL_JSON_LIMIT_BYTES);

    const app = express();
    installGlobalJsonBodyParser(app);
    app.put("/api/dropship/catalog/selection-rules", (req, res) => { res.json({ rules: Array.isArray(req.body?.rules) ? req.body.rules.length : -1 }); });
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: "refused" });
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const fits = await put(port, JSON.stringify({ idempotencyKey: KEY, rules: built }));
      expect(fits).toEqual({ status: 200, body: { rules: 500 } });
      // Review CT5: the parser's own boundary. A body of exactly the limit is read (the page sends one, lib test K3);
      // one byte more is the parser's 413.
      const padded = (bytes: number) => {
        const base = Buffer.byteLength(JSON.stringify({ idempotencyKey: KEY, rules: [], padding: "" }));
        return JSON.stringify({ idempotencyKey: KEY, rules: [], padding: "x".repeat(bytes - base) });
      };
      expect(Buffer.byteLength(padded(GLOBAL_JSON_LIMIT_BYTES))).toBe(GLOBAL_JSON_LIMIT_BYTES);
      expect(await put(port, padded(GLOBAL_JSON_LIMIT_BYTES))).toEqual({ status: 200, body: { rules: 0 } });
      expect((await put(port, padded(GLOBAL_JSON_LIMIT_BYTES + 1))).status).toBe(413);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("C4 the compact form hashes exactly as the full form (null targets, metadata kept)", () => {
    const built = buildChooseSelectionSave(LEGACY, clicks(LEGACY, [5, 2, 7]).marks);
    const full = built.map((rule) => ({ productLineId: null, productId: null, productVariantId: null, category: null, ...rule }));
    expect(serverHash(built)).toBe(serverHash(full));
    expect(Object.values(built[0])).not.toContain(null);
  });

  it("C5 the content compare agrees with the server's hash", () => {
    const base = buildChooseSelectionSave(LEGACY, []);
    const pairs: Array<[readonly ChooseRuleInput[], readonly ChooseRuleInput[]]> = [
      [base, [...base].reverse()],
      [base, base.map((rule, index) => (index === 0 ? { ...rule, priority: rule.priority + 1 } : rule))],
      [[{ ...base[0], metadata: { a: 1, b: { c: 2, d: 3 } } }], [{ ...base[0], metadata: { b: { d: 3, c: 2 }, a: 1 } }]],
      [[{ ...base[1], category: "Mailers" }], [{ ...base[1], category: "  Mailers " }]],
      [[{ ...base[1], category: "Mailers" }], [{ ...base[1], category: "mailers" }]],
      [base, base.slice(1)],
    ];
    const agreements = pairs.map(([left, right]) => ({ hash: serverHash(left) === serverHash(right), content: sameRuleContent(left, right) }));
    for (const agreement of agreements) expect(agreement.content).toBe(agreement.hash);
    expect(agreements.map((entry) => entry.hash)).toEqual([true, false, true, true, false, false]);
    // The rules as read back (ids, full form) compare with what was sent.
    expect(sameRuleContent(stored(base, 900), base)).toBe(true);
  });

  it("C6 through the real evaluator: marked sizes end as marked, everything else stays as it was", () => {
    // A size no pick can change gets no mark: kept out by an older setting.
    expect(clicks(LEGACY, [8]).marks).toEqual([]);
    // Verify V6 (pin moved: size 6 got no mark before): turned off for the vendor while their own pick is saved, the pick
    // is theirs to remove. Deleted with no keep-out, so the size reads plainly not selected (and stays so if the
    // override is lifted).
    const offPick = saveAndCheck(LEGACY, clicks(LEGACY, [6]).marks, 50);
    expect(offPick.now.get(6)).toEqual({ selected: false, reason: "missing_vendor_include_rule" });
    expect(offPick.built.some((rule) => rule.productVariantId === 6)).toBe(false);

    // A lone pick removed: deleted, so the size is plainly not selected, with no keep-out written.
    const lone = saveAndCheck(LEGACY, clicks(LEGACY, [7]).marks, 100);
    expect(lone.now.get(7)).toEqual({ selected: false, reason: "missing_vendor_include_rule" });
    expect(lone.built.some((rule) => rule.productVariantId === 7)).toBe(false);

    // Removed under an older include: kept out by a keep-out of its own.
    const under = saveAndCheck(LEGACY, clicks(LEGACY, [2]).marks, 200);
    expect(under.now.get(2)).toEqual({ selected: false, reason: "excluded_by_vendor_rule" });
    // And added back: the keep-out goes, the older include selects it again.
    const back = saveAndCheck(under.after, clicks(under.after, [2]).marks, 300);
    expect(back.now.get(2)).toEqual({ selected: true, reason: "selected" });
    expect(back.built).toHaveLength(LEGACY.length);

    // "Removed by you" checked again under the older product include, and a size that was never chosen.
    const adds = saveAndCheck(LEGACY, clicks(LEGACY, [4, 5]).marks, 400);
    expect(adds.now.get(4)).toEqual({ selected: true, reason: "selected" });
    expect(adds.now.get(5)).toEqual({ selected: true, reason: "selected" });

    // Everything at once, in one save: adds and removes together.
    const all = saveAndCheck(LEGACY, clicks(LEGACY, [1, 2, 3, 4, 5, 7]).marks, 500);
    expect([...all.now.entries()].filter(([, decision]) => decision.selected).map(([id]) => id).sort()).toEqual([4, 5]);
    expect(all.now.get(6)).toEqual({ selected: false, reason: "disabled_by_vendor_override" });
    expect(all.now.get(8)).toEqual({ selected: false, reason: "excluded_by_vendor_rule" });
    // Never a category, product, product line or catalog rule written: the older ones pass through untouched.
    const written = all.built.filter((rule) => !LEGACY.some((old) => sameRuleContent([old], [rule])));
    expect(written.every((rule) => rule.scopeType === "variant")).toBe(true);
  });

  it("C7 (review CT3, MC4) a size turned off for the vendor with no pick reads Not selected, so it can be checked; the save writes the pick, the size stays off, and the saved line says it didn't take", () => {
    const changes = clicks(LEGACY, [9]);
    expect(changes.marks).toHaveLength(1);
    const built = buildChooseSelectionSave(LEGACY, changes.marks);
    expect(serverParse(built).success).toBe(true);
    const after = stored(built, 600);
    expect(decisions(after).get(9)).toEqual({ selected: false, reason: "disabled_by_vendor_override" });
    expect(chooseSaveResult(changes.marks, rowsUnder(after))).toEqual({ add: 0, remove: 0, notTaken: 1 });
    // Every other size is as it was.
    const before = decisions(LEGACY);
    for (const [productVariantId, decision] of decisions(after)) if (productVariantId !== 9) expect(decision).toEqual(before.get(productVariantId));
  });
});

/**
 * Review CT1: the page's Zod contracts copy server enums by hand. These pins fail on drift: the Zod enums at run time,
 * and the TypeScript-only unions at compile time (`satisfies Record<…, true>` needs every member and no other).
 */
describe("catalog step 1 read contracts against the server", () => {
  const SERVER_SELECTION_REASONS = {
    selected: true, not_exposed_by_admin: true, excluded_by_vendor_rule: true, missing_vendor_include_rule: true, disabled_by_vendor_override: true,
  } satisfies Record<DropshipVendorCatalogSelectionReason, true>;
  const SERVER_TIER_BLOCK_REASONS = {
    autopay_off: true, reserve_below_tier: true, balance_below_tier: true,
  } satisfies Record<DropshipListingTierBlockReason, true>;

  it("R1 every enum the page parses is the server's, exactly", () => {
    expect([...chooseSelectionScopeSchema.options]).toEqual([...dropshipVendorSelectionScopeSchema.options]);
    expect([...chooseSelectionActionSchema.options]).toEqual([...dropshipVendorSelectionActionSchema.options]);
    expect([...chooseListingTierNameSchema.options]).toEqual([...DROPSHIP_LISTING_TIERS]);
    expect([...chooseSelectionReasonSchema.options].sort()).toEqual(Object.keys(SERVER_SELECTION_REASONS).sort());
    expect([...chooseListingTierReasonSchema.options].sort()).toEqual(Object.keys(SERVER_TIER_BLOCK_REASONS).sort());
  });

  it("R2 the real service's catalog page and rules, sent as JSON, pass the page's contracts, each selection reason included", async () => {
    const stamp = new Date("2026-10-20T12:00:00.000Z");
    const rule = (id: number, scopeType: DropshipVendorSelectionRuleRecord["scopeType"], action: DropshipVendorSelectionRuleRecord["action"],
      target: Partial<DropshipVendorSelectionRuleRecord> = {}): DropshipVendorSelectionRuleRecord => ({
      id, revisionId: 3, vendorId: 1, scopeType, action, productLineId: null, productId: null, productVariantId: null, category: null,
      autoConnectNewSkus: action === "include", autoListNewSkus: false, priority: 100, isActive: true, metadata: { source: "portal_catalog" },
      createdAt: stamp, updatedAt: stamp, ...target,
    });
    const candidate = (productVariantId: number, variantUomType: DropshipVendorCatalogCandidate["variantUomType"]): DropshipVendorCatalogCandidate => ({
      productId: 10, productSku: "P-10", productName: "Product 10", productVariantId, variantSku: null, variantName: `Size ${productVariantId}`,
      unitsPerVariant: 1, productLineIds: [30], productLineNames: ["Trading Card Supplies"], category: "Supplies",
      categoryId: 5, categoryName: "Supplies", productIsActive: true, variantIsActive: true, variantUomType,
    });
    const selectionRules = [
      rule(1, "variant", "include", { productVariantId: 21 }),
      rule(2, "variant", "include", { productVariantId: 22 }),
      rule(3, "variant", "exclude", { productVariantId: 23 }),
      rule(4, "product_line", "include", { productLineId: 30, metadata: null }),
      rule(5, "variant", "exclude", { productVariantId: 24 }),
    ];
    const override: DropshipVendorVariantOverrideRecord = { id: 1, vendorId: 1, productVariantId: 22, enabledOverride: false, marketplaceQuantityCap: null,
      notes: null, createdAt: stamp, updatedAt: stamp };
    const repository: DropshipSelectionAtpRepository = {
      findVendorByMemberId: async () => null,
      listCatalogExposureRules: async () => [{ id: 1, scopeType: "catalog", action: "include" }],
      listSelectionRules: async () => selectionRules,
      replaceSelectionRules: async () => { throw new Error("not used"); },
      listVendorCatalogCandidates: async () => [candidate(21, "pack"), candidate(22, "pack"), candidate(23, "case"), candidate(25, "case")],
      listVariantOverrides: async () => [override],
      readSelectionCounts: async () => { throw new Error("not used"); },
    };
    const tiers: DropshipListingTierEligibility = {
      pack: { tier: "pack", eligible: true, reason: null, policyMinimumCents: 10_000, minimumCents: 10_000, alreadyOn: true,
        reserveShortfallCents: 0, balanceShortfallCents: 0, upcoming: null },
      case: { tier: "case", eligible: false, reason: "reserve_below_tier", policyMinimumCents: 50_000, minimumCents: 50_000, alreadyOn: false,
        reserveShortfallCents: 40_000, balanceShortfallCents: 38_000, upcoming: null },
    };
    const service = new DropshipSelectionAtpService({
      clock: { now: () => stamp },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      repository,
      atp: { getVariantAtp: async (targets) => ({ authority: "canonical", quantities: new Map(targets.map((target) => [target.productVariantId, 7])) }) },
      listingTiers: { resolveForVendor: async () => ({ eligibility: tiers }) },
    });
    // The route sends both with res.json: Dates become strings, undefined drops.
    const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

    const page = chooseCatalogPageSchema.safeParse(wire(await service.previewCatalog({ vendorId: 1, limit: 200 })));
    expect(page.success, JSON.stringify(page.success ? null : page.error.issues)).toBe(true);
    if (!page.success) return;
    expect(page.data.rows.map((row) => row.selectionDecision.reason)).toEqual(["selected", "disabled_by_vendor_override", "excluded_by_vendor_rule", "selected"]);
    expect(page.data.rows[2].listingTier).toMatchObject({ tier: "case", eligible: false, reason: "reserve_below_tier" });
    expect(JSON.stringify(page.data)).not.toContain("Trading Card Supplies");

    // A size with no include reads "missing_vendor_include_rule": the same service with the product-line include off.
    selectionRules.splice(3, 1);
    const missing = chooseCatalogPageSchema.safeParse(wire(await service.previewCatalog({ vendorId: 1, limit: 200 })));
    expect(missing.success && missing.data.rows.map((row) => row.selectionDecision.reason)[3]).toBe("missing_vendor_include_rule");

    const rules = chooseSelectionRulesResponseSchema.safeParse(wire(await service.listSelectionRules({ vendorId: 1 })));
    expect(rules.success, JSON.stringify(rules.success ? null : rules.error.issues)).toBe(true);
    expect(rules.success && rules.data.rules.map((entry) => entry.id)).toEqual([1, 2, 3, 5]);
  });
});

function put(port: number, body: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: "/api/dropship/catalog/selection-rules", method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as unknown });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}
