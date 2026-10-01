import { describe, expect, it } from "vitest";
import { listingDraftItemSchema } from "@shared/types/channel-listing-publication";
import {
  inheritedContentState,
  normalizeListingContent,
  normalizeTextOverride,
  parseImageOverride,
} from "../content-inheritance";

describe("listing content inheritance", () => {
  it("distinguishes inherited catalog content, known empty content and unavailable catalog metadata", () => {
    expect(inheritedContentState(null, "Catalog title")).toBe("catalog");
    expect(inheritedContentState(null, "")).toBe("catalog_empty");
    expect(inheritedContentState(null, undefined)).toBe("catalog_unavailable");
    expect(inheritedContentState("Custom title", undefined)).toBe("custom");
    expect(inheritedContentState("", "Catalog title")).toBe("catalog");
  });

  it("keeps all inherited fields null on save without copying displayed catalog content", () => {
    const draft = listingDraftItemSchema.parse({
      variantId: 1,
      attributes: { weight: 2 },
    });
    const result = normalizeListingContent(draft, null);
    expect(result).toEqual(draft);
    expect(result).toMatchObject({
      title: null,
      description: null,
      brand: null,
      images: null,
    });
    expect(result.attributes).toBe(draft.attributes);
  });

  it("preserves explicit nonempty values even when they equal the catalog", () => {
    const draft = listingDraftItemSchema.parse({
      variantId: 1,
      title: "Same as catalog",
      description: "  Paragraph\nwith spacing  ",
      brand: "Brand",
    });
    const result = normalizeListingContent(
      draft,
      "https://example.com/image.png",
    );
    expect(result).toMatchObject({
      title: "Same as catalog",
      description: "  Paragraph\nwith spacing  ",
      brand: "Brand",
      images: ["https://example.com/image.png"],
    });
    expect(draft.images).toBeNull();
  });

  it("turns cleared fields into inheritance while preserving unrelated draft fields", () => {
    const draft = listingDraftItemSchema.parse({
      variantId: 1,
      productType: "Type",
      title: "Custom",
      brand: "Custom",
      priceOverrideCents: 549,
      attributes: { weight: 2 },
      identifier: { type: "UPC", value: "012345678905" },
    });
    const edited = { ...draft, title: "", description: " \n ", brand: "\t" };
    expect(normalizeListingContent(edited, " \r\n ")).toEqual({
      ...draft,
      title: null,
      description: null,
      brand: null,
      images: null,
    });
    expect(draft.title).toBe("Custom");
  });

  it("parses only explicitly edited image URLs without mutating prior image arrays", () => {
    const draft = listingDraftItemSchema.parse({
      variantId: 1,
      images: ["https://example.com/old.png"],
    });
    const result = normalizeListingContent(
      draft,
      "https://example.com/a.png\r\n\n https://example.com/b.png ",
    );
    expect(result.images).toEqual([
      "https://example.com/a.png",
      "https://example.com/b.png",
    ]);
    expect(draft.images).toEqual(["https://example.com/old.png"]);
    expect(parseImageOverride(null)).toBeNull();
  });

  it("leaves URL validity, field limits and final publication checks to existing schemas", () => {
    const draft = listingDraftItemSchema.parse({ variantId: 1 });
    const invalid = normalizeListingContent(draft, "not a URL");
    expect(listingDraftItemSchema.safeParse(invalid).success).toBe(false);
    const excessive = normalizeListingContent(
      draft,
      Array(21).fill("https://example.com/a.png").join("\n"),
    );
    expect(listingDraftItemSchema.safeParse(excessive).success).toBe(false);
    expect(normalizeTextOverride(" a ")).toBe(" a ");
  });
});
