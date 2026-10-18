import { describe, expect, it } from "vitest";
import {
  ebayCategoryRulesStateSchema,
  saveEbayCategoryRulesInputSchema,
  type EbayCategoryRule,
} from "../../../../../shared/dropship/ebay-category-rules";
import { contentProfileStateSchema, saveContentProfileInputSchema } from "../../../../../shared/dropship/listing-content";
import { pricingProfileStateSchema, reviewPricingRulesInputSchema } from "../../../../../shared/dropship/pricing-rules";
import { DropshipError } from "../../domain/errors";
import {
  DROPSHIP_LISTING_GROUP_RULES_CLOSED,
  MAX_GROUP_RULE_IDS_IN_REFUSAL,
  olderGroupRulesClosed,
  olderGroupRulesEdit,
  type DescriptionGroupRule,
  type EbayCategoryRuleDraft,
  type PricingGroupRule,
} from "../../domain/older-group-rules-edit";

/**
 * The pure rule that closes older group rules (Listing settings PR 12, plan D9, 3.2, T1): keep or remove, never add,
 * change or (eBay) reorder. Every case per kind; the re-parse cases pin that what a GET answers, sent back through the
 * write's own input schema, is the same group (risk K2: an unchanged resend must never be refused).
 */

const STAMP = "2026-10-18T09:00:00.000Z";
const RECIPE = { basis: "catalog_retail" as const, markupBps: 2_000, flatCents: 0, rounding: "cent" as const };

function pricingGroup(id: string, overrides: Partial<PricingGroupRule> = {}): PricingGroupRule {
  return { id, name: `Group ${id}`, priority: 10, scope: { type: "category", category: "Toploaders" }, recipe: RECIPE, ...overrides };
}

function descriptionGroup(id: string, overrides: Partial<DescriptionGroupRule> = {}): DescriptionGroupRule {
  return { id, name: `Text ${id}`, priority: 10, scope: { type: "product", productId: 7 },
    template: { introduction: "Fits any binder.", footer: "Ships flat." }, ...overrides };
}

const TOPLOADERS = { categoryId: "900101", categoryName: "Toploaders", path: ["Collectibles", "Card Storage", "Toploaders"] };
const SLEEVES = { categoryId: "900102", categoryName: "Sleeves", path: ["Collectibles", "Card Storage", "Sleeves"] };

function storedRule(id: string, overrides: Partial<EbayCategoryRule> = {}): EbayCategoryRule {
  return { id, name: `Rule ${id}`, scope: { type: "category", category: `Category ${id}` }, category: TOPLOADERS, ...overrides };
}

/** The draft a step sends for a stored rule: the category by number only. */
function draftOf(rule: EbayCategoryRule): EbayCategoryRuleDraft {
  return { id: rule.id, name: rule.name, scope: rule.scope, categoryId: rule.category.categoryId };
}

/** A copy frozen all the way down, so any write to an input throws. */
function deepFrozen<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    Object.freeze(node);
    for (const child of Object.values(node)) freeze(child);
  };
  freeze(copy);
  return copy;
}

const ALLOWED = { allowed: true, addedIds: [], changedIds: [], reordered: false };

describe("olderGroupRulesEdit: pricing groups", () => {
  const stored = [pricingGroup("a"), pricingGroup("b", { priority: 20 })];

  it("allows the stored groups unchanged, in any order", () => {
    expect(olderGroupRulesEdit("pricing", stored, stored)).toEqual(ALLOWED);
    // Order is free: the resolver sorts by priority, then id.
    expect(olderGroupRulesEdit("pricing", stored, [stored[1], stored[0]])).toEqual(ALLOWED);
  });

  it("allows one group removed, and all of them removed", () => {
    expect(olderGroupRulesEdit("pricing", stored, [stored[1]])).toEqual(ALLOWED);
    expect(olderGroupRulesEdit("pricing", stored, [])).toEqual(ALLOWED);
  });

  it("refuses an added group, naming it", () => {
    expect(olderGroupRulesEdit("pricing", stored, [...stored, pricingGroup("c")]))
      .toEqual({ allowed: false, addedIds: ["c"], changedIds: [], reordered: false });
  });

  it.each([
    ["name", { name: "Renamed" }],
    ["priority", { priority: 11 }],
    ["scope", { scope: { type: "product" as const, productId: 7 } }],
    ["recipe", { recipe: { ...RECIPE, markupBps: 2_001 } }],
  ])("refuses a group whose %s changed, naming it", (_field, change) => {
    expect(olderGroupRulesEdit("pricing", stored, [{ ...stored[0], ...change }, stored[1]]))
      .toEqual({ allowed: false, addedIds: [], changedIds: ["a"], reordered: false });
  });

  it("refuses a change inside a named-size scope, the sizes' order included", () => {
    const named = pricingGroup("n", { scope: { type: "listings", productVariantIds: [101, 102] } });
    expect(olderGroupRulesEdit("pricing", [named], [{ ...named, scope: { type: "listings", productVariantIds: [101, 102, 103] } }]).changedIds)
      .toEqual(["n"]);
    expect(olderGroupRulesEdit("pricing", [named], [{ ...named, scope: { type: "listings", productVariantIds: [102, 101] } }]).changedIds)
      .toEqual(["n"]);
  });

  it("allows only an empty request on a store with no profile", () => {
    expect(olderGroupRulesEdit("pricing", [], [])).toEqual(ALLOWED);
    expect(olderGroupRulesEdit("pricing", [], [pricingGroup("a")])).toEqual({ allowed: false, addedIds: ["a"], changedIds: [], reordered: false });
  });

  it("counts a group named twice as added again", () => {
    expect(olderGroupRulesEdit("pricing", stored, [stored[0], stored[0]]))
      .toEqual({ allowed: false, addedIds: ["a"], changedIds: [], reordered: false });
  });
});

describe("olderGroupRulesEdit: description groups", () => {
  const stored = [descriptionGroup("a"), descriptionGroup("b", { priority: 20 })];

  it("allows the stored groups unchanged in any order, fewer, or none", () => {
    expect(olderGroupRulesEdit("description", stored, [stored[1], stored[0]])).toEqual(ALLOWED);
    expect(olderGroupRulesEdit("description", stored, [stored[0]])).toEqual(ALLOWED);
    expect(olderGroupRulesEdit("description", stored, [])).toEqual(ALLOWED);
  });

  it("refuses an added group", () => {
    expect(olderGroupRulesEdit("description", stored, [...stored, descriptionGroup("c")]))
      .toEqual({ allowed: false, addedIds: ["c"], changedIds: [], reordered: false });
  });

  it.each([
    ["text above", { template: { introduction: "Other words.", footer: "Ships flat." } }],
    ["text below", { template: { introduction: "Fits any binder.", footer: "" } }],
    ["scope", { scope: { type: "category" as const, category: "Sleeves" } }],
    ["priority", { priority: 9 }],
    ["name", { name: "Renamed" }],
  ])("refuses a group whose %s changed", (_field, change) => {
    expect(olderGroupRulesEdit("description", stored, [stored[0], { ...stored[1], ...change }]))
      .toEqual({ allowed: false, addedIds: [], changedIds: ["b"], reordered: false });
  });

  it("allows only an empty request on a store with no profile", () => {
    expect(olderGroupRulesEdit("description", [], [descriptionGroup("a")]).addedIds).toEqual(["a"]);
    expect(olderGroupRulesEdit("description", [], [])).toEqual(ALLOWED);
  });
});

describe("olderGroupRulesEdit: eBay category rules", () => {
  const stored = [storedRule("a"), storedRule("b", { category: SLEEVES }), storedRule("c")];
  const drafts = stored.map(draftOf);

  it("allows the stored rules unchanged, in their stored order", () => {
    expect(olderGroupRulesEdit("ebay_category", stored, drafts)).toEqual(ALLOWED);
  });

  it("allows one rule removed, a subset in stored order, and all removed", () => {
    expect(olderGroupRulesEdit("ebay_category", stored, [drafts[0], drafts[2]])).toEqual(ALLOWED);
    expect(olderGroupRulesEdit("ebay_category", stored, [drafts[1]])).toEqual(ALLOWED);
    expect(olderGroupRulesEdit("ebay_category", stored, [])).toEqual(ALLOWED);
  });

  it("refuses kept rules out of their stored order: order is precedence", () => {
    expect(olderGroupRulesEdit("ebay_category", stored, [drafts[1], drafts[0], drafts[2]]))
      .toEqual({ allowed: false, addedIds: [], changedIds: [], reordered: true });
    expect(olderGroupRulesEdit("ebay_category", stored, [drafts[2], drafts[0]]))
      .toEqual({ allowed: false, addedIds: [], changedIds: [], reordered: true });
  });

  it("refuses an added rule, judging the kept ones' order by themselves", () => {
    const added = { id: "new", name: "New", scope: { type: "product" as const, productId: 9 }, categoryId: SLEEVES.categoryId };
    expect(olderGroupRulesEdit("ebay_category", stored, [drafts[0], added, drafts[1], drafts[2]]))
      .toEqual({ allowed: false, addedIds: ["new"], changedIds: [], reordered: false });
  });

  it.each([
    ["name", { name: "Renamed" }],
    ["scope", { scope: { type: "product" as const, productId: 8 } }],
    ["category", { categoryId: SLEEVES.categoryId }],
  ])("refuses a rule whose %s changed", (_field, change) => {
    expect(olderGroupRulesEdit("ebay_category", stored, [{ ...drafts[0], ...change }, drafts[1], drafts[2]]))
      .toEqual({ allowed: false, addedIds: [], changedIds: ["a"], reordered: false });
  });

  it("compares the stored category by its number only: eBay's stored name and path are not sent back", () => {
    const renamedAtEbay = [{ ...stored[0], category: { ...TOPLOADERS, categoryName: "Top Loaders", path: ["Other"] } }];
    expect(olderGroupRulesEdit("ebay_category", renamedAtEbay, [drafts[0]])).toEqual(ALLOWED);
  });

  it("names every kind of difference at once", () => {
    const added = { id: "new", name: "New", scope: { type: "product" as const, productId: 9 }, categoryId: SLEEVES.categoryId };
    expect(olderGroupRulesEdit("ebay_category", stored, [drafts[2], { ...drafts[0], name: "Renamed" }, added]))
      .toEqual({ allowed: false, addedIds: ["new"], changedIds: ["a"], reordered: true });
  });

  it("allows only an empty request on a store with no rules", () => {
    expect(olderGroupRulesEdit("ebay_category", [], [drafts[0]]).addedIds).toEqual(["a"]);
    expect(olderGroupRulesEdit("ebay_category", [], [])).toEqual(ALLOWED);
  });

  it("orders nothing for pricing and description groups: reordered stays false", () => {
    const groups = [pricingGroup("a"), pricingGroup("b")];
    expect(olderGroupRulesEdit("pricing", groups, [groups[1], groups[0]]).reordered).toBe(false);
  });
});

describe("olderGroupRulesEdit: inputs and re-parsing", () => {
  it("never changes its inputs", () => {
    const stored = deepFrozen([storedRule("a"), storedRule("b")]);
    const requested = deepFrozen([draftOf(stored[1]), draftOf(stored[0]), { ...draftOf(stored[0]), id: "c" }]);
    const before = structuredClone({ stored, requested });
    expect(olderGroupRulesEdit("ebay_category", stored, requested)).toEqual({ allowed: false, addedIds: ["c"], changedIds: [], reordered: true });
    expect({ stored, requested }).toEqual(before);
    const groups = deepFrozen([pricingGroup("a")]);
    expect(olderGroupRulesEdit("pricing", groups, deepFrozen([pricingGroup("a"), pricingGroup("b")])).addedIds).toEqual(["b"]);
    expect(groups).toEqual([pricingGroup("a")]);
  });

  it("finds a stored pricing group, read through the GET's schema and sent back through the review's, unchanged", () => {
    // As stored before the trimming normalised them: the read trims names and scope names.
    const read = pricingProfileStateSchema.parse({ revisionId: 3, updatedAt: STAMP, profile: { defaultRecipe: RECIPE, groups: [
      { id: "trim", name: "  Toploaders  ", priority: 1, scope: { type: "category", category: " Toploaders " }, recipe: RECIPE },
      { id: "named", name: "Two sizes", priority: 2, scope: { type: "listings", productVariantIds: [102, 101] }, recipe: { ...RECIPE, rounding: "up_99" } },
    ] } });
    const wire = JSON.parse(JSON.stringify({ expectedRevisionId: read.revisionId, releaseFixedOverrides: false,
      profile: { defaultRecipe: { ...RECIPE, markupBps: 3_000 }, groups: read.profile!.groups } }));
    const sent = reviewPricingRulesInputSchema.parse(wire);
    expect(olderGroupRulesEdit("pricing", read.profile!.groups, sent.profile.groups)).toEqual(ALLOWED);
  });

  it("finds a stored description group, read through the GET's schema and sent back through the save's, unchanged", () => {
    const read = contentProfileStateSchema.parse({ revisionId: 5, updatedAt: STAMP, profile: {
      defaultTemplate: { introduction: "", footer: "" },
      groups: [{ id: "lines", name: " Mailers ", priority: 1, scope: { type: "category", category: "Mailers" },
        template: { introduction: "First line\r\nSecond line  ", footer: "\rShips flat." } }] } });
    const wire = JSON.parse(JSON.stringify({ expectedRevisionId: read.revisionId, idempotencyKey: "ls-text:1",
      profile: { defaultTemplate: { introduction: "New store text", footer: "" }, groups: read.profile!.groups } }));
    const sent = saveContentProfileInputSchema.parse(wire);
    expect(olderGroupRulesEdit("description", read.profile!.groups, sent.profile.groups)).toEqual(ALLOWED);
  });

  it("finds a stored eBay rule, read through the GET's schema and sent back as a draft, unchanged", () => {
    const read = ebayCategoryRulesStateSchema.parse({ revisionId: 7, updatedAt: STAMP, profile: { version: 1, defaultCategory: null, rules: [
      { id: "sleeves", name: "  Sleeves ", scope: { type: "category", category: " Sleeves" }, category: SLEEVES },
      { id: "sizes", name: "Two sizes", scope: { type: "listings", productVariantIds: [11, 12] }, category: TOPLOADERS },
    ] } });
    const wire = JSON.parse(JSON.stringify({ expectedRevisionId: read.revisionId, idempotencyKey: "ls-category:1",
      draft: { defaultCategoryId: SLEEVES.categoryId, rules: read.profile!.rules.map(draftOf) } }));
    const sent = saveEbayCategoryRulesInputSchema.parse(wire);
    expect(olderGroupRulesEdit("ebay_category", read.profile!.rules, sent.draft.rules)).toEqual(ALLOWED);
  });
});

describe("olderGroupRulesClosed", () => {
  it("is a permanent DropshipError with the plan's words and ids only", () => {
    const edit = olderGroupRulesEdit("ebay_category", [storedRule("a"), storedRule("b")],
      [draftOf(storedRule("b")), { ...draftOf(storedRule("a")), name: "Renamed" }, { ...draftOf(storedRule("a")), id: "c" }]);
    const error = olderGroupRulesClosed(44, "ebay_category", edit);
    expect(error).toBeInstanceOf(DropshipError);
    expect(error.code).toBe(DROPSHIP_LISTING_GROUP_RULES_CLOSED);
    expect(error.message).toBe(
      "Older group rules can't be added or changed any more. Nothing was saved. Use See what changes on Listing settings to move them over.");
    expect(error.context).toEqual({ storeConnectionId: 44, kind: "ebay_category", addedIds: ["c"], changedIds: ["a"], reordered: true,
      retryable: false, classification: "permanent" });
    // No group's name or text leaves in the context.
    expect(JSON.stringify(error.context)).not.toContain("Renamed");
  });

  it("caps each id list at 100", () => {
    const many = Array.from({ length: 150 }, (_, index) => pricingGroup(`g${index}`));
    const edit = olderGroupRulesEdit("pricing", [], many);
    expect(edit.addedIds).toHaveLength(150);
    const changed = olderGroupRulesEdit("pricing", many, many.map((group) => ({ ...group, priority: group.priority + 1 })));
    const context = olderGroupRulesClosed(22, "pricing", { ...edit, changedIds: changed.changedIds }).context!;
    expect(MAX_GROUP_RULE_IDS_IN_REFUSAL).toBe(100);
    expect(context.addedIds).toEqual(many.slice(0, 100).map((group) => group.id));
    expect(context.changedIds).toEqual(many.slice(0, 100).map((group) => group.id));
  });
});
