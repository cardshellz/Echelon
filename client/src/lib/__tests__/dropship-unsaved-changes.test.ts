import { describe, expect, it } from "vitest";
import { describeUnsavedDrafts, updateUnsavedDrafts, type UnsavedDraft } from "../dropship-unsaved-changes";

const pricing: UnsavedDraft = { id: "pricing-rules:22", label: "Listing pricing rules" };
const categories: UnsavedDraft = { id: "ebay-category-rules:22", label: "eBay categories" };
const templates: UnsavedDraft = { id: "/api/dropship/listings/stores/22/content-profile", label: "Description templates" };

describe("unsaved changes on Listing settings", () => {
  it("adds, replaces and removes one editor's entry without touching the others", () => {
    const one = updateUnsavedDrafts([], pricing.id, pricing);
    const two = updateUnsavedDrafts(one, categories.id, categories);
    expect(two).toEqual([pricing, categories]);
    expect(updateUnsavedDrafts(two, pricing.id, { ...pricing, label: "Pricing" })).toEqual([{ ...pricing, label: "Pricing" }, categories]);
    expect(updateUnsavedDrafts(two, pricing.id, null)).toEqual([categories]);
  });
  it("returns the same array when nothing changes, and never mutates its input", () => {
    const drafts = Object.freeze([pricing]) as readonly UnsavedDraft[];
    expect(updateUnsavedDrafts(drafts, pricing.id, pricing)).toBe(drafts);
    expect(updateUnsavedDrafts(drafts, "missing", null)).toBe(drafts);
    expect(() => updateUnsavedDrafts(drafts, categories.id, categories)).not.toThrow();
    expect(drafts).toEqual([pricing]);
  });
  it("names every editor with unsaved changes, once each", () => {
    expect(describeUnsavedDrafts([])).toBeNull();
    expect(describeUnsavedDrafts([pricing])).toBe("You have changes that aren't saved in Listing pricing rules.");
    expect(describeUnsavedDrafts([pricing, categories])).toBe("You have changes that aren't saved in Listing pricing rules and eBay categories.");
    expect(describeUnsavedDrafts([pricing, categories, templates, { id: "pricing-rules:23", label: "Listing pricing rules" }]))
      .toBe("You have changes that aren't saved in Listing pricing rules, eBay categories and Description templates.");
  });
});
