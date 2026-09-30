import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogScope } from "@shared/dropship/catalog-scope";
import type { EbayCategory, EbayCategoryRulesReview, EbayCategoryRulesState } from "@shared/dropship/ebay-category-rules";
import {
  addEbayCategoryRule,
  browseEbayCategories,
  categoryFromOption,
  categoryPathLabel,
  checkEbayCategoryDraft,
  describeEbayCategoryReview,
  ebayCategorySourceLabel,
  editorDraftFromState,
  isSearchableEbayCategoryQuery,
  moveEbayCategoryRule,
  namedListingCount,
  removeEbayCategoryRule,
  sameEbayCategoryDraft,
  saveEbayCategoryRules,
  searchEbayCategories,
  setEbayDefaultCategory,
  updateEbayCategoryRule,
  type EbayCategoryRulesEditorDraft,
} from "../dropship-ebay-category-rules";

const SLEEVES: EbayCategory = { categoryId: "183435", categoryName: "Card Sleeves", path: ["Collectibles", "Trading Cards", "Card Sleeves"] };
const TOPLOADERS: EbayCategory = { categoryId: "183436", categoryName: "Toploaders", path: ["Collectibles", "Trading Cards", "Toploaders"] };

function savedState(): EbayCategoryRulesState {
  return {
    revisionId: 7,
    updatedAt: "2026-09-30T12:00:00.000Z",
    profile: {
      version: 1,
      defaultCategory: SLEEVES,
      rules: [{ id: "toploaders", name: "Toploaders", scope: { type: "category", category: "Toploaders" }, category: TOPLOADERS }],
    },
  };
}

function review(overrides: Partial<EbayCategoryRulesReview> = {}): EbayCategoryRulesReview {
  return {
    expectedRevisionId: 7, selectedCount: 800, changedCount: 142, unchangedCount: 658, withoutCategoryBefore: 20, withoutCategoryAfter: 0,
    bySource: { rule: 300, store_default: 500, catalog: 0, none: 0 }, byRule: [], byCategory: [], otherCategoriesCount: 0, changes: [],
    ...overrides,
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("eBay category rules editor model", () => {
  it("loads the saved rules as an editable copy that never shares arrays with the server state", () => {
    const state = savedState();
    const draft = editorDraftFromState(state);
    expect(draft).toEqual({ defaultCategory: SLEEVES, rules: [{ id: "toploaders", name: "Toploaders",
      scope: { type: "category", category: "Toploaders" }, category: TOPLOADERS }] });
    draft.defaultCategory!.path.push("changed");
    expect(state.profile!.defaultCategory!.path).toEqual(["Collectibles", "Trading Cards", "Card Sleeves"]);
    expect(editorDraftFromState({ revisionId: null, profile: null, updatedAt: null })).toEqual({ defaultCategory: null, rules: [] });
  });

  it("adds, edits, reorders and removes rules without touching the previous draft", () => {
    const empty: EbayCategoryRulesEditorDraft = { defaultCategory: null, rules: [] };
    const one = addEbayCategoryRule(empty, "a");
    const two = addEbayCategoryRule(one, "b");
    expect(empty.rules).toEqual([]);
    expect(two.rules.map((rule) => rule.id)).toEqual(["a", "b"]);
    expect(two.rules[0]).toEqual({ id: "a", name: "", scope: { type: "category", category: "" }, category: null });
    const named = updateEbayCategoryRule(two, "b", { name: "Sleeves", category: SLEEVES });
    expect(named.rules[1]).toMatchObject({ name: "Sleeves", category: SLEEVES });
    expect(two.rules[1].name).toBe("");
    expect(moveEbayCategoryRule(named, "b", -1).rules.map((rule) => rule.id)).toEqual(["b", "a"]);
    expect(moveEbayCategoryRule(named, "a", -1)).toBe(named);
    expect(moveEbayCategoryRule(named, "b", 1)).toBe(named);
    expect(moveEbayCategoryRule(named, "missing", 1)).toBe(named);
    expect(removeEbayCategoryRule(named, "a").rules.map((rule) => rule.id)).toEqual(["b"]);
    expect(setEbayDefaultCategory(empty, SLEEVES).defaultCategory).toEqual(SLEEVES);
    expect(setEbayDefaultCategory(setEbayDefaultCategory(empty, SLEEVES), null).defaultCategory).toBeNull();
  });

  it("stops adding rules at the server's limit of 100", () => {
    let draft: EbayCategoryRulesEditorDraft = { defaultCategory: null, rules: [] };
    for (let index = 0; index < 101; index += 1) draft = addEbayCategoryRule(draft, `rule_${index}`);
    expect(draft.rules).toHaveLength(100);
  });

  it("sends category numbers only, with trimmed names, in the saved order", () => {
    const draft = updateEbayCategoryRule(editorDraftFromState(savedState()), "toploaders", { name: "  Toploaders  " });
    expect(checkEbayCategoryDraft(draft)).toEqual({ ok: true, draft: {
      defaultCategoryId: "183435",
      rules: [{ id: "toploaders", name: "Toploaders", scope: { type: "category", category: "Toploaders" }, categoryId: "183436" }],
    } });
  });

  it("names the rule to fix before anything is sent", () => {
    const base = addEbayCategoryRule({ defaultCategory: null, rules: [] }, "a");
    expect(checkEbayCategoryDraft(base)).toEqual({ ok: false, message: "Name rule 1.", ruleId: "a" });
    const named = updateEbayCategoryRule(base, "a", { name: "Sleeves" });
    expect(checkEbayCategoryDraft(named)).toMatchObject({ ok: false, message: 'Choose what rule "Sleeves" applies to.' });
    // The scope picker's placeholders before a target is chosen.
    const placeholders: CatalogScope[] = [{ type: "product_line", productLineId: 0 }, { type: "product", productId: 0 }, { type: "listings", productVariantIds: [] }];
    for (const scope of placeholders) {
      expect(checkEbayCategoryDraft(updateEbayCategoryRule(named, "a", { scope })).ok).toBe(false);
    }
    const scoped = updateEbayCategoryRule(named, "a", { scope: { type: "product", productId: 9 } });
    expect(checkEbayCategoryDraft(scoped)).toMatchObject({ ok: false, message: 'Pick an eBay category for rule "Sleeves".' });
    expect(checkEbayCategoryDraft(updateEbayCategoryRule(scoped, "a", { category: SLEEVES })).ok).toBe(true);
  });

  it("refuses two rules on the same group, which would leave the second unreachable", () => {
    let draft = addEbayCategoryRule(addEbayCategoryRule({ defaultCategory: null, rules: [] }, "a"), "b");
    draft = updateEbayCategoryRule(draft, "a", { name: "Sleeves", scope: { type: "product", productId: 9 }, category: SLEEVES });
    draft = updateEbayCategoryRule(draft, "b", { name: "Sleeves again", scope: { type: "product", productId: 9 }, category: TOPLOADERS });
    expect(checkEbayCategoryDraft(draft)).toEqual({ ok: false, ruleId: "b",
      message: 'Rule "Sleeves again" targets the same group as rule "Sleeves". Keep one rule per category, product line or product.' });
    const listings = updateEbayCategoryRule(draft, "b", { scope: { type: "listings", productVariantIds: [1, 2] } });
    expect(checkEbayCategoryDraft(listings).ok).toBe(true);
  });

  it("counts named listings and refuses more than 10,000 in total", () => {
    let draft = addEbayCategoryRule(addEbayCategoryRule({ defaultCategory: null, rules: [] }, "a"), "b");
    const ids = (start: number, count: number) => Array.from({ length: count }, (_, index) => start + index);
    draft = updateEbayCategoryRule(draft, "a", { name: "A", scope: { type: "listings", productVariantIds: ids(1, 6_000) }, category: SLEEVES });
    draft = updateEbayCategoryRule(draft, "b", { name: "B", scope: { type: "listings", productVariantIds: ids(10_001, 4_000) }, category: SLEEVES });
    expect(namedListingCount(draft)).toBe(10_000);
    expect(checkEbayCategoryDraft(draft).ok).toBe(true);
    const over = updateEbayCategoryRule(draft, "b", { scope: { type: "listings", productVariantIds: ids(10_001, 4_001) } });
    expect(checkEbayCategoryDraft(over)).toMatchObject({ ok: false, ruleId: null,
      message: "Rules can name up to 10,000 listings in total. Use a category, product line or product rule for broader coverage." });
  });

  it("treats a draft as unchanged when only surrounding spaces differ", () => {
    const saved = editorDraftFromState(savedState());
    expect(sameEbayCategoryDraft(saved, updateEbayCategoryRule(saved, "toploaders", { name: " Toploaders " }))).toBe(true);
    expect(sameEbayCategoryDraft(saved, updateEbayCategoryRule(saved, "toploaders", { category: SLEEVES }))).toBe(false);
    expect(sameEbayCategoryDraft(saved, setEbayDefaultCategory(saved, null))).toBe(false);
  });
});

describe("eBay category words", () => {
  it("shows the path eBay uses, and the name alone when no path is known", () => {
    expect(categoryPathLabel(SLEEVES)).toBe("Collectibles › Trading Cards › Card Sleeves");
    expect(categoryPathLabel({ categoryName: "Card Sleeves", path: [] })).toBe("Card Sleeves");
    expect(categoryFromOption({ ...SLEEVES, leaf: true })).toEqual(SLEEVES);
  });

  it("says where each listing's category came from", () => {
    expect(ebayCategorySourceLabel("rule", "Envelopes")).toBe('From your rule "Envelopes"');
    expect(ebayCategorySourceLabel("rule", null)).toBe("From one of your rules");
    expect(ebayCategorySourceLabel("store_default", null)).toBe("From your store default");
    expect(ebayCategorySourceLabel("catalog", null)).toBe("From the Card Shellz category");
    expect(ebayCategorySourceLabel("none", null)).toBe("No eBay category yet");
  });

  it("summarizes the review before the vendor confirms", () => {
    expect(describeEbayCategoryReview(review())).toEqual({
      headline: "142 of 800 selected listings change eBay category.",
      details: ["20 listings without an eBay category now get one.", "After saving: 300 from your rules · 500 from your store default."],
    });
    expect(describeEbayCategoryReview(review({ changedCount: 1 })).headline).toBe("1 of 800 selected listings changes eBay category.");
    expect(describeEbayCategoryReview(review({ changedCount: 0, withoutCategoryBefore: 3, withoutCategoryAfter: 3,
      bySource: { rule: 0, store_default: 0, catalog: 797, none: 3 } }))).toEqual({
      headline: "No listing changes eBay category. 800 selected listings checked.",
      details: ["3 listings still have no eBay category and cannot be published until a rule or your store default covers them.",
        "After saving: 797 from Card Shellz categories."],
    });
    expect(describeEbayCategoryReview(review({ selectedCount: 0, changedCount: 0, unchangedCount: 0, withoutCategoryBefore: 0,
      bySource: { rule: 0, store_default: 0, catalog: 0, none: 0 } }))).toEqual({
      headline: "No listings are selected in this store yet.", details: ["The rules apply to listings as you select them."] });
  });

  it("never sends a search the server would refuse", () => {
    expect(isSearchableEbayCategoryQuery("s")).toBe(false);
    expect(isSearchableEbayCategoryQuery("  s  ")).toBe(false);
    expect(isSearchableEbayCategoryQuery("sl")).toBe(true);
    expect(isSearchableEbayCategoryQuery("x".repeat(100))).toBe(true);
    expect(isSearchableEbayCategoryQuery("x".repeat(101))).toBe(false);
  });
});

describe("eBay category requests", () => {
  function stubFetch(body: unknown, status = 200) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("encodes the search and browse parameters and validates eBay's answer", async () => {
    const fetchMock = stubFetch({ categories: [{ ...SLEEVES, leaf: true }] });
    await expect(searchEbayCategories(22, "  card sleeves & cases ")).resolves.toEqual([{ ...SLEEVES, leaf: true }]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/ebay-categories/search?q=card+sleeves+%26+cases");
    stubFetch({ parent: null, children: [{ categoryId: "550", categoryName: "Art", path: ["Art"], leaf: false }] });
    await expect(browseEbayCategories(22, null)).resolves.toMatchObject({ parent: null, children: [{ categoryId: "550" }] });
    const browse = stubFetch({ parent: { categoryId: "550", categoryName: "Art", path: ["Art"], leaf: false }, children: [] });
    await browseEbayCategories(22, "550");
    expect(browse.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/ebay-categories?parentId=550");
    stubFetch({ categories: [{ categoryId: "not-a-number", categoryName: "Bad", path: ["Bad"], leaf: true }] });
    await expect(searchEbayCategories(22, "bad")).rejects.toThrow();
  });

  it("saves with a PUT that carries the key and the expected revision", async () => {
    const fetchMock = stubFetch({ state: savedState(), idempotentReplay: false });
    const draft = { defaultCategoryId: "183435", rules: [] };
    await expect(saveEbayCategoryRules(22, { expectedRevisionId: 7, draft, idempotencyKey: "ebay-category-rules:abc" }))
      .resolves.toMatchObject({ idempotentReplay: false, state: { revisionId: 7 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/dropship/listings/stores/22/ebay-category-rules");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ expectedRevisionId: 7, draft, idempotencyKey: "ebay-category-rules:abc" });
  });
});
