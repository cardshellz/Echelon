import { describe, expect, it } from "vitest";
import {
  describeLeavePrompt,
  describeUnsavedDrafts,
  scopeUnsavedDrafts,
  scopeWithoutPrefix,
  updateUnsavedDrafts,
  type UnsavedDraft,
} from "../dropship-unsaved-changes";

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

describe("unsaved changes that count themselves (the new Listing settings step)", () => {
  const discard = () => undefined;
  const step: UnsavedDraft = { id: "listing-settings:22", label: "Shipping policy", changes: 1, discard };

  it("replaces the entry when the count changes, and keeps the same array when label and count match", () => {
    const one = updateUnsavedDrafts([], step.id, step);
    expect(one).toEqual([step]);
    const two = updateUnsavedDrafts(one, step.id, { ...step, changes: 2 });
    expect(two).not.toBe(one);
    expect(two[0].changes).toBe(2);
    // A new closure each render must not re-render forever: same label and count keep the first entry.
    const again = updateUnsavedDrafts(two, step.id, { ...step, changes: 2, discard: () => undefined });
    expect(again).toBe(two);
    expect(again[0].discard).toBe(discard);
  });

  it("replaces the entry when it gains or loses a discard", () => {
    const counted = [step] as const;
    const plain = updateUnsavedDrafts(counted, step.id, { id: step.id, label: step.label, changes: 1 });
    expect(plain).not.toBe(counted);
    expect(plain[0].discard).toBeUndefined();
    expect(updateUnsavedDrafts(plain, step.id, step)).not.toBe(plain);
  });

  it("says how many changes aren't saved when every draft counts them", () => {
    expect(describeLeavePrompt([])).toBeNull();
    expect(describeLeavePrompt([step])).toBe("You have 1 change that isn't saved.");
    expect(describeLeavePrompt([{ ...step, changes: 2 }])).toBe("You have 2 changes that aren't saved.");
    expect(describeLeavePrompt([step, { id: "listing-settings:23", label: "Price", changes: 2, discard }]))
      .toBe("You have 3 changes that aren't saved.");
  });

  it("falls back to today's sentence when any draft has no count", () => {
    expect(describeLeavePrompt([step, pricing])).toBe("You have changes that aren't saved in Shipping policy and Listing pricing rules.");
    expect(describeLeavePrompt([pricing])).toBe(describeUnsavedDrafts([pricing]));
    for (const changes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(describeLeavePrompt([{ ...step, changes }])).toBe("You have changes that aren't saved in Shipping policy.");
    }
  });

  it("asks about one editor's draft when scoped to it, and about every draft otherwise", () => {
    const drafts = [step, pricing, categories];
    expect(scopeUnsavedDrafts(drafts, null)).toBe(drafts);
    expect(scopeUnsavedDrafts(drafts, [step.id])).toEqual([step]);
    expect(scopeUnsavedDrafts(drafts, ["listing-settings:99"])).toEqual([]);
    expect(scopeUnsavedDrafts(drafts, [])).toEqual([]);
    expect(drafts).toEqual([step, pricing, categories]);
  });

  it("leaves a step's own drafts out of the way back onto it, and asks about every other draft", () => {
    const drafts = Object.freeze([step, pricing, categories]) as readonly UnsavedDraft[];
    const scope = scopeWithoutPrefix(drafts, "listing-settings:");
    expect(scope).toEqual([pricing.id, categories.id]);
    expect(scopeUnsavedDrafts(drafts, scope)).toEqual([pricing, categories]);
    // With only the step's own draft held (browser Back to step 1), the scope is empty, so Next goes at once and keeps it.
    expect(scopeWithoutPrefix([step], "listing-settings:")).toEqual([]);
    expect(scopeUnsavedDrafts([step], scopeWithoutPrefix([step], "listing-settings:"))).toEqual([]);
    expect(scopeWithoutPrefix([], "listing-settings:")).toEqual([]);
    // Only a prefix counts: an id that merely contains it elsewhere is another editor's.
    const lookalike: UnsavedDraft = { id: "older:listing-settings:22", label: "Older" };
    expect(scopeWithoutPrefix([lookalike], "listing-settings:")).toEqual([lookalike.id]);
    expect(drafts).toEqual([step, pricing, categories]);
  });
});
