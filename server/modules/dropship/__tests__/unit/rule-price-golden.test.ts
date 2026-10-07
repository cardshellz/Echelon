import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pricingProfileStateSchema, type PricingProfileState } from "../../../../../shared/dropship/pricing-rules";
import { createRulePriceResolver, pricingHash, type ListingRulePrice } from "../../application/dropship-rule-price";
import { classifyListing, type CostActionVendorFacts } from "../../application/dropship-cost-change-listing-action-service";
import { DropshipPricingRulesService, type PricingRulesTransaction, type StoredPricingReview } from "../../application/dropship-pricing-rules-service";
import type { DropshipListingCatalogCandidate, DropshipListingPreviewRepository } from "../../application/dropship-listing-preview-service";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import { loadListingRulePrices } from "../../infrastructure/dropship-rule-price.loader";
import { PgShellzClubProductCostAdapter } from "../../infrastructure/shellz-club-product-cost.adapter";
import { GOLDEN_RULE_PRICE_CASES, GOLDEN_RULE_PRICES, GOLDEN_RULE_PROFILE_STATE, type GoldenRulePriceCase } from "../fixtures/rule-price-golden.fixture";

const STORE_ID = 22;
const VENDOR_ID = 10;
const cases = GOLDEN_RULE_PRICE_CASES.map((row, index) => [row.name, row, GOLDEN_RULE_PRICES[index]] as const);

function pinnedFields(price: ListingRulePrice, productVariantId: number) {
  return { productVariantId, priceCents: price.priceCents, ruleName: price.ruleName, ruleId: price.ruleId,
    issue: price.issue, basis: price.basis, profileRevisionId: price.profileRevisionId, evidenceHash: price.evidenceHash };
}

/** The evidence recipe written out in full: one sha256 over the whole JSON, as the code before the shared resolver did. */
function legacyEvidenceHash(state: PricingProfileState, row: GoldenRulePriceCase, price: { priceCents: number | null;
  ruleName: string | null; ruleId: string | null; issue: string | null }): string {
  return pricingHash({ profile: state, productVariantId: row.candidate.productVariantId,
    productId: row.candidate.productId, category: row.candidate.category,
    productLineIds: [...row.candidate.productLineIds].sort((a, b) => a - b),
    catalogRetailCents: row.candidate.defaultRetailPriceCents, cost: row.cost,
    price: { priceCents: price.priceCents, ruleName: price.ruleName, ruleId: price.ruleId, issue: price.issue } });
}

/** The golden profile as readPricingProfile returns it from its database row. */
const profileRow = { id: GOLDEN_RULE_PROFILE_STATE.revisionId, profile: GOLDEN_RULE_PROFILE_STATE.profile,
  created_at: new Date(GOLDEN_RULE_PROFILE_STATE.updatedAt!) };

afterEach(() => vi.restoreAllMocks());

describe("golden rule prices", () => {
  it("has one pinned result per case, on a profile shaped like a stored one", () => {
    expect(GOLDEN_RULE_PRICES.map((row) => row.productVariantId))
      .toEqual(GOLDEN_RULE_PRICE_CASES.map((row) => row.candidate.productVariantId));
    // The hash serializes the state, so the fixture must keep the stored key order.
    expect(JSON.stringify(pricingProfileStateSchema.parse(JSON.parse(JSON.stringify(GOLDEN_RULE_PROFILE_STATE)))))
      .toBe(JSON.stringify(GOLDEN_RULE_PROFILE_STATE));
  });

  it.each(cases)("the evidence recipe gives the pinned hash: %s", (_name, row, golden) => {
    expect(legacyEvidenceHash(GOLDEN_RULE_PROFILE_STATE, row, golden)).toBe(golden.evidenceHash);
  });

  it.each(cases)("the shared resolver keeps the pinned price and evidence: %s", (_name, row, golden) => {
    const price = createRulePriceResolver({ state: GOLDEN_RULE_PROFILE_STATE }).price(row.candidate, row.cost);
    expect(pinnedFields(price, row.candidate.productVariantId)).toEqual(golden);
    expect(price.productCost).toBe(row.cost);
  });

  it("gives every size of a batch the same price and evidence as resolving it alone", () => {
    const batch = createRulePriceResolver({ state: GOLDEN_RULE_PROFILE_STATE });
    const together = GOLDEN_RULE_PRICE_CASES.map((row) => batch.price(row.candidate, row.cost));
    // Twice through the same resolver: the hash prefix it reuses is never consumed.
    const again = GOLDEN_RULE_PRICE_CASES.map((row) => batch.price(row.candidate, row.cost));
    expect(together.map((price) => price.evidenceHash)).toEqual(GOLDEN_RULE_PRICES.map((row) => row.evidenceHash));
    expect(again).toEqual(together);
  });

  it.each(cases)("the price at a given .ops cost matches the pinned price: %s", (_name, row, golden) => {
    const costCents = row.cost?.status === "available" ? row.cost.unitCostCents : null;
    expect(createRulePriceResolver({ state: GOLDEN_RULE_PROFILE_STATE }).priceAtCost(row.candidate, costCents)).toEqual({
      priceCents: golden.priceCents, ruleName: golden.ruleName, ruleId: golden.ruleId, issue: golden.issue, basis: golden.basis });
  });

  it("says a store without a pricing profile has no rules, and still prices nothing", () => {
    const resolver = createRulePriceResolver({ state: { revisionId: null, profile: null, updatedAt: null } });
    expect(resolver.configured).toBe(false);
    expect(createRulePriceResolver({ state: GOLDEN_RULE_PROFILE_STATE }).configured).toBe(true);
    const row = GOLDEN_RULE_PRICE_CASES[0];
    expect(resolver.priceAtCost(row.candidate, 809)).toEqual({ priceCents: null, ruleName: null, ruleId: null,
      issue: "pricing_rules_not_configured", basis: null });
  });
});

describe("every price path gives the golden rule prices", () => {
  function costsFor(rows: readonly GoldenRulePriceCase[]): Map<number, DropshipProductCost> {
    // A size whose cost was never read has no entry, as the cost reader returns it.
    return new Map(rows.flatMap((row) => (row.cost ? [[row.candidate.productVariantId, row.cost] as const] : [])));
  }
  /** Answers only the pricing profile read; any other query fails the test. */
  function fakeClient(profile: typeof profileRow | null) {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (/FROM dropship\.dropship_pricing_profiles/.test(sql)) return { rows: profile ? [profile] : [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    return { query, client: { query } as unknown as Pick<PoolClient, "query"> };
  }

  it("listing preview and queue: the shared loader reads the profile, then every cost in one read", async () => {
    const loadProductCosts = vi.fn(async () => costsFor(GOLDEN_RULE_PRICE_CASES));
    const forTransaction = vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction")
      .mockReturnValue({ loadProductCosts } as unknown as PgShellzClubProductCostAdapter);
    const { query, client } = fakeClient(profileRow);

    const prices = await loadListingRulePrices(client, { vendorId: VENDOR_ID, storeConnectionId: STORE_ID,
      candidates: GOLDEN_RULE_PRICE_CASES.map((row) => row.candidate) });

    for (const [, row, golden] of cases) {
      expect(pinnedFields(prices.get(row.candidate.productVariantId)!, row.candidate.productVariantId)).toEqual(golden);
    }
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([STORE_ID, VENDOR_ID]);
    expect(forTransaction).toHaveBeenCalledWith(client);
    expect(loadProductCosts).toHaveBeenCalledTimes(1);
    expect(loadProductCosts).toHaveBeenCalledWith({ vendorId: VENDOR_ID,
      productVariantIds: GOLDEN_RULE_PRICE_CASES.map((row) => row.candidate.productVariantId) });
  });

  it("per-size price: the same loader for one size gives that size's golden price", async () => {
    const row = GOLDEN_RULE_PRICE_CASES[3];
    const loadProductCosts = vi.fn(async () => costsFor([row]));
    vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction")
      .mockReturnValue({ loadProductCosts } as unknown as PgShellzClubProductCostAdapter);

    const prices = await loadListingRulePrices(fakeClient(profileRow).client, { vendorId: VENDOR_ID, storeConnectionId: STORE_ID,
      candidates: [row.candidate] });

    expect(pinnedFields(prices.get(row.candidate.productVariantId)!, row.candidate.productVariantId)).toEqual(GOLDEN_RULE_PRICES[3]);
    expect(loadProductCosts).toHaveBeenCalledWith({ vendorId: VENDOR_ID, productVariantIds: [row.candidate.productVariantId] });
  });

  it("a store without rules gets no rule prices, and no cost is read for them", async () => {
    const forTransaction = vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction");
    const prices = await loadListingRulePrices(fakeClient(null).client, { vendorId: VENDOR_ID, storeConnectionId: STORE_ID,
      candidates: GOLDEN_RULE_PRICE_CASES.map((row) => row.candidate) });
    expect(prices.size).toBe(0);
    expect(forTransaction).not.toHaveBeenCalled();
  });

  it("pricing review: new prices and row evidence are what the code before the shared resolver gave", async () => {
    const candidates = GOLDEN_RULE_PRICE_CASES.map((row): DropshipListingCatalogCandidate => ({ ...row.candidate,
      productName: row.name, variantName: `Size ${row.candidate.productVariantId}`, title: row.name,
      sku: `SKU-${row.candidate.productVariantId}`, productIsActive: true, variantIsActive: true, variantUomType: "pack",
      unitsPerVariant: 1 } as DropshipListingCatalogCandidate));
    let stored: StoredPricingReview | null = null;
    const catalog = {
      loadStoreContext: vi.fn(async () => ({ vendorId: VENDOR_ID, vendorStatus: "active", entitlementStatus: "active", storeStatus: "connected" })),
      listCatalogExposureRules: vi.fn(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
      listSelectionRules: vi.fn(async () => [{ id: 2, scopeType: "catalog", action: "include", isActive: true }]),
      listCatalogCandidates: vi.fn(async (ids: number[]) => candidates.filter((row) => ids.includes(row.productVariantId))),
      listVariantOverrides: vi.fn(async () => []), listExistingListings: vi.fn(async () => []),
      listSavedListingPrices: vi.fn(async () => []), listPricingPolicies: vi.fn(async () => []),
    } as unknown as DropshipListingPreviewRepository;
    const tx = { vendorId: VENDOR_ID, catalog,
      costs: { loadProductCosts: vi.fn(async () => costsFor(GOLDEN_RULE_PRICE_CASES)) },
      listVariantIds: vi.fn(async (afterId: number, limit: number) => candidates
        .map((row) => row.productVariantId).filter((id) => id > afterId).sort((a, b) => a - b).slice(0, limit)),
      listProductLines: vi.fn(async () => []), loadProfile: vi.fn(async () => GOLDEN_RULE_PROFILE_STATE),
      storeReview: vi.fn(async (review: StoredPricingReview) => { stored = review; }),
      loadReview: vi.fn(async () => stored), findApplication: vi.fn(async () => null), applyReview: vi.fn(async () => 1),
    } as unknown as PricingRulesTransaction;
    const service = new DropshipPricingRulesService({ repository: { execute: async (_member, _store, operation) => operation(tx) },
      clock: { now: () => new Date("2026-10-06T12:00:00.000Z") }, newId: () => "02892196-a1f2-4e72-823a-32188b9cb234",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    // The same rules proposed again: every new price is the golden one.
    await service.reviewForMember("member-1", STORE_ID, { profile: GOLDEN_RULE_PROFILE_STATE.profile,
      expectedRevisionId: GOLDEN_RULE_PROFILE_STATE.revisionId, releaseFixedOverrides: false });

    const rows = new Map(stored!.rows.map((row) => [row.productVariantId, row]));
    // A proposed profile is not stored yet, so it has no updated time.
    const proposed: PricingProfileState = { revisionId: GOLDEN_RULE_PROFILE_STATE.revisionId,
      profile: GOLDEN_RULE_PROFILE_STATE.profile, updatedAt: null };
    for (const [, row, golden] of cases) {
      const reviewRow = rows.get(row.candidate.productVariantId)!;
      expect(reviewRow).toMatchObject({ priceCents: golden.priceCents, ruleName: golden.ruleName, basis: golden.basis,
        preserved: false });
      if (golden.issue) expect(reviewRow.issues).toContain(golden.issue);
      expect(reviewRow.evidenceHash).toBe(pricingHash({ rule: legacyEvidenceHash(proposed, row, golden),
        oldRule: golden.evidenceHash, setting: null, existing: null, guardrails: [] }));
    }
  });

  it.each(cases.filter(([, row]) => row.cost?.status === "available"))(
    "cost-change classifier: a rule-priced listing resolves to the golden price at that cost: %s",
    (_name, row, golden) => {
      const facts: CostActionVendorFacts = {
        listings: [], profiles: new Map([[STORE_ID, GOLDEN_RULE_PROFILE_STATE]]),
        savedPrices: [{ storeConnectionId: STORE_ID, productVariantId: row.candidate.productVariantId, overridePriceCents: null, pricingMode: "rules" }],
        candidates: new Map([[row.candidate.productVariantId, row.candidate]]),
      };
      const listing = { listingId: 1, storeConnectionId: STORE_ID, productVariantId: row.candidate.productVariantId,
        status: "active", vendorRetailPriceCents: null, platform: "ebay", variantSku: null, variantName: "Size", productName: row.name };

      const classification = classifyListing(facts, listing, row.cost!.unitCostCents!);

      expect(classification.priceCents).toBe(golden.priceCents);
      if (golden.priceCents !== null) expect(classification.followsCost).toBe(golden.basis === "product_cost");
    },
  );
});
