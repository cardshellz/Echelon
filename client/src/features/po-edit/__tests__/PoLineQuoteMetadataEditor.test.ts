import { describe, expect, it } from "vitest";
import {
  changedPoLineQuoteMetadata,
  createEmptyPoLineQuoteMetadataDraft,
  createPoLineQuoteMetadataDraftFromStored,
  evaluatePoLineQuoteMetadataDraft,
  populatedPoLineQuoteMetadata,
  reusableCatalogQuoteDateMissing,
} from "../PoLineQuoteMetadataEditor";

describe("PO line quote metadata", () => {
  it("normalizes optional metadata without inventing values", () => {
    expect(evaluatePoLineQuoteMetadataDraft(
      createEmptyPoLineQuoteMetadataDraft({ quoteReference: "  RFQ-4821  " }),
    )).toEqual({
      metadata: {
        quoteReference: "RFQ-4821",
        quotedAt: null,
        quoteValidUntil: null,
      },
      error: null,
    });
  });

  it("hydrates real date inputs while preserving the stored reference", () => {
    expect(createPoLineQuoteMetadataDraftFromStored({
      quoteReference: "EMAIL-778",
      quotedAt: "2026-07-13T18:42:11.123Z",
      quoteValidUntil: "2026-08-31",
    })).toEqual({
      quoteReference: "EMAIL-778",
      quotedAt: "2026-07-13",
      quoteValidUntil: "2026-08-31",
    });
  });

  it("rejects overlong references even if state is populated outside the input", () => {
    expect(evaluatePoLineQuoteMetadataDraft(
      createEmptyPoLineQuoteMetadataDraft({ quoteReference: "Q".repeat(256) }),
    )).toMatchObject({
      metadata: null,
      error: "Quote reference must be 255 characters or fewer.",
    });
  });

  it("rejects impossible calendar dates", () => {
    expect(evaluatePoLineQuoteMetadataDraft(
      createEmptyPoLineQuoteMetadataDraft({ quotedAt: "2026-02-30" }),
    )).toMatchObject({ metadata: null, error: "Quote date must be a valid date." });
  });

  it("rejects a validity date before the quote date", () => {
    expect(evaluatePoLineQuoteMetadataDraft(
      createEmptyPoLineQuoteMetadataDraft({
        quotedAt: "2026-07-13",
        quoteValidUntil: "2026-07-12",
      }),
    )).toMatchObject({
      metadata: null,
      error: "Valid-until date must be on or after the quote date.",
    });
  });

  it("omits empty metadata from create payloads", () => {
    expect(populatedPoLineQuoteMetadata({
      quoteReference: "RFQ-19",
      quotedAt: null,
      quoteValidUntil: null,
    })).toEqual({ quoteReference: "RFQ-19" });
  });

  it("requires a quote date only when saving reusable catalog pricing", () => {
    const undated = evaluatePoLineQuoteMetadataDraft(
      createEmptyPoLineQuoteMetadataDraft(),
    ).metadata!;
    expect(reusableCatalogQuoteDateMissing(true, "per_piece", undated)).toBe(true);
    expect(reusableCatalogQuoteDateMissing(false, "per_piece", undated)).toBe(false);
    expect(reusableCatalogQuoteDateMissing(true, "extended_total", undated)).toBe(false);

    const dated = evaluatePoLineQuoteMetadataDraft(
      createEmptyPoLineQuoteMetadataDraft({ quotedAt: "2026-07-13" }),
    ).metadata!;
    expect(reusableCatalogQuoteDateMissing(true, "per_purchase_uom", dated)).toBe(false);
  });

  it("patches only changed fields so untouched quote timestamps stay exact", () => {
    const original = createEmptyPoLineQuoteMetadataDraft({
      quoteReference: "RFQ-19",
      quotedAt: "2026-07-13",
      quoteValidUntil: "2026-08-13",
    });
    const current = { ...original, quoteReference: "RFQ-20" };
    const normalized = evaluatePoLineQuoteMetadataDraft(current).metadata!;

    expect(changedPoLineQuoteMetadata(original, current, normalized)).toEqual({
      quoteReference: "RFQ-20",
    });
  });
});
