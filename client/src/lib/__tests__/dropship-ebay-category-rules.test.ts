import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogScope } from "@shared/dropship/catalog-scope";
import { ebayCategorySourceValues, type EbayCategory, type EbayCategoryRulesState } from "@shared/dropship/ebay-category-rules";
import {
  browseEbayCategories,
  categoryFromOption,
  categoryPathLabel,
  checkEbayCategoryDraft,
  ebayCategorySourceLabel,
  editorDraftFromState,
  isSearchableEbayCategoryQuery,
  searchEbayCategories,
  setEbayDefaultCategory,
  type EbayCategoryRuleEditorRow,
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

/** One editor row, unnamed and with no target until the test says otherwise. */
function rule(id: string, overrides: Partial<Omit<EbayCategoryRuleEditorRow, "id">> = {}): EbayCategoryRuleEditorRow {
  return { id, name: "", scope: { type: "category", category: "" }, category: null, ...overrides };
}

function draftOf(...rules: EbayCategoryRuleEditorRow[]): EbayCategoryRulesEditorDraft {
  return { defaultCategory: null, rules };
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

  it("sets and clears the default category without touching the previous draft", () => {
    const empty: EbayCategoryRulesEditorDraft = { defaultCategory: null, rules: [] };
    const set = setEbayDefaultCategory(empty, SLEEVES);
    expect(set.defaultCategory).toEqual(SLEEVES);
    expect(empty.defaultCategory).toBeNull();
    // A copy, so a later change to the picked category can't reach the draft.
    expect(set.defaultCategory).not.toBe(SLEEVES);
    expect(setEbayDefaultCategory(set, null).defaultCategory).toBeNull();
  });

  // The cases below are the unit coverage of the store default eBay category save's check
  // (`prepareEbayCategoryDefaultSave` runs every saved rule through it). Their drafts were built with the rule editor
  // helpers deleted in Listing settings PR 12; they are literal now (TESTS5). Since the PR 12 review (DUX3) the check
  // is the shared draft schema alone: its only caller says one sentence for any refusal, so it names no rule, and
  // each case pins only whether the draft is refused and the body it builds.
  it("sends category numbers only, with trimmed names, in the saved order", () => {
    const saved = editorDraftFromState(savedState());
    const draft = { ...saved, rules: saved.rules.map((row) => ({ ...row, name: "  Toploaders  " })) };
    expect(checkEbayCategoryDraft(draft)).toEqual({ ok: true, draft: {
      defaultCategoryId: "183435",
      rules: [{ id: "toploaders", name: "Toploaders", scope: { type: "category", category: "Toploaders" }, categoryId: "183436" }],
    } });
  });

  it("refuses a rule with no name, no target or no category before anything is sent, naming no rule", () => {
    expect(checkEbayCategoryDraft(draftOf(rule("a", { scope: { type: "product", productId: 9 }, category: SLEEVES })))).toEqual({ ok: false });
    expect(checkEbayCategoryDraft(draftOf(rule("a", { name: "   ", scope: { type: "product", productId: 9 }, category: SLEEVES })))).toEqual({ ok: false });
    // Scopes with no target chosen.
    const placeholders: CatalogScope[] = [{ type: "category", category: "  " }, { type: "product_line", productLineId: 0 },
      { type: "product", productId: 0 }, { type: "listings", productVariantIds: [] }];
    for (const scope of placeholders) {
      expect(checkEbayCategoryDraft(draftOf(rule("a", { name: "Sleeves", scope, category: SLEEVES })))).toEqual({ ok: false });
    }
    const scoped = rule("a", { name: "Sleeves", scope: { type: "product", productId: 9 } });
    expect(checkEbayCategoryDraft(draftOf(scoped))).toEqual({ ok: false });
    expect(checkEbayCategoryDraft(draftOf({ ...scoped, category: SLEEVES })).ok).toBe(true);
  });

  it("refuses two rules on the same group, which would leave the second unreachable", () => {
    const first = rule("a", { name: "Sleeves", scope: { type: "product", productId: 9 }, category: SLEEVES });
    const second = rule("b", { name: "Sleeves again", scope: { type: "product", productId: 9 }, category: TOPLOADERS });
    expect(checkEbayCategoryDraft(draftOf(first, second))).toEqual({ ok: false });
    // The same category named with spaces around it is the same group.
    const category = (id: string, name: string) => rule(id, { name, scope: { type: "category", category: name }, category: SLEEVES });
    expect(checkEbayCategoryDraft(draftOf(category("c", "Sleeves"), { ...category("d", "Sleeves "), name: "Other" }))).toEqual({ ok: false });
    const listings = { ...second, scope: { type: "listings" as const, productVariantIds: [1, 2] } };
    expect(checkEbayCategoryDraft(draftOf(first, listings)).ok).toBe(true);
  });

  it("allows 10,000 named listings in total and refuses one more", () => {
    const ids = (start: number, count: number) => Array.from({ length: count }, (_, index) => start + index);
    const a = rule("a", { name: "A", scope: { type: "listings", productVariantIds: ids(1, 6_000) }, category: SLEEVES });
    const b = rule("b", { name: "B", scope: { type: "listings", productVariantIds: ids(10_001, 4_000) }, category: SLEEVES });
    expect(checkEbayCategoryDraft(draftOf(a, b)).ok).toBe(true);
    const over = { ...b, scope: { type: "listings" as const, productVariantIds: ids(10_001, 4_001) } };
    expect(checkEbayCategoryDraft(draftOf(a, over))).toEqual({ ok: false });
  });
});

describe("eBay category words", () => {
  it("shows the path eBay uses, and the name alone when no path is known", () => {
    expect(categoryPathLabel(SLEEVES)).toBe("Collectibles › Trading Cards › Card Sleeves");
    expect(categoryPathLabel({ categoryName: "Card Sleeves", path: [] })).toBe("Card Sleeves");
    expect(categoryFromOption({ ...SLEEVES, leaf: true })).toEqual(SLEEVES);
  });

  it("says where each listing's category came from", () => {
    // Interim (PR 12 PROPOSAL): the step's and the sheet's name for these rules.
    expect(ebayCategorySourceLabel("rule", "Envelopes")).toBe("From your older group rule “Envelopes”");
    expect(ebayCategorySourceLabel("rule", null)).toBe("From one of your older group rules");
    expect(ebayCategorySourceLabel("store_default", null)).toBe("From your store default");
    // The catalog's own pick, in the drawer's words, so it can't be read as the category's setting (mS3 b.1).
    expect(ebayCategorySourceLabel("catalog", null)).toBe("Card Shellz picks");
    expect(ebayCategorySourceLabel("none", null)).toBe("No eBay category yet");
    // A product's own category and a Card Shellz category's (PR 10h): a place or a name, never an id.
    expect(ebayCategorySourceLabel("product", null)).toBe("Set in Listing settings");
    expect(ebayCategorySourceLabel("product", "Envelopes")).toBe("Set in Listing settings");
    expect(ebayCategorySourceLabel("category", "Sleeves")).toBe("From category: Sleeves");
    expect(ebayCategorySourceLabel("category", null)).toBe("From its Card Shellz category");
    for (const source of ebayCategorySourceValues) {
      for (const label of [ebayCategorySourceLabel(source, "Envelopes"), ebayCategorySourceLabel(source, null)]) {
        expect(label).not.toMatch(/[a-z]+_[a-z_]+|#\d|\d{4,}/);
        expect(label).not.toBe(source);
      }
    }
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
});
