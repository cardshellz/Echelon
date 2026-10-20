import { describe, expect, it } from "vitest";
import {
  limitPublicationMediaPlan,
  resolveExplicitPublicationMediaPlan,
} from "../../catalog-publication-media";

describe("Catalog reviewed URL media selection", () => {
  it("retains exact input provenance, deduplicates before capacity and does not invent Catalog assets", () => {
    const urls = Object.freeze([
      "https://cdn.example.com/a.jpg",
      "https://cdn.example.com/a.jpg",
      "https://cdn.example.com/b.jpg",
      "https://cdn.example.com/c.jpg",
    ]);
    const plan = resolveExplicitPublicationMediaPlan({
      variantIds: [11, 10],
      urls,
      maxPhotosPerVariant: 2,
      maxGroupPhotos: 3,
    });
    expect(plan.variants.map((v) => v.variantId)).toEqual([10, 11]);
    expect(plan.variants[0].gallery.selected.map((p) => p.url)).toEqual([
      urls[0],
      urls[2],
    ]);
    expect(plan.group.selected.map((p) => p.url)).toEqual([
      urls[0],
      urls[2],
      urls[3],
    ]);
    expect(
      plan.group.selected.every(
        (p) => p.assetId === null && p.versionHash === null && !p.uploaded,
      ),
    ).toBe(true);
    expect(plan.group.omissions).toEqual([
      {
        assetId: null,
        sourceIndex: 1,
        reason: "duplicate",
        duplicateOfSourceIndex: 0,
        blocking: false,
      },
    ]);
    expect(plan.variants[0].gallery.omissions.at(-1)).toEqual({
      assetId: null,
      sourceIndex: 3,
      reason: "capacity",
      blocking: false,
    });
    expect(
      resolveExplicitPublicationMediaPlan({
        variantIds: [10, 11],
        urls,
        maxPhotosPerVariant: 2,
        maxGroupPhotos: 3,
      }).sourceRevision,
    ).toBe(plan.sourceRevision);
  });
  it("projects a one-image protocol without losing input counts, duplicates or omission provenance", () => {
    const plan = resolveExplicitPublicationMediaPlan({
      variantIds: [10],
      urls: [
        "https://cdn.example.com/a.jpg",
        "https://cdn.example.com/a.jpg",
        "https://cdn.example.com/b.jpg",
      ],
      maxPhotosPerVariant: 20,
    });
    const limited = limitPublicationMediaPlan(plan, {
      maxPhotosPerVariant: 1,
      maxGroupPhotos: 1,
    });
    expect(limited.group.expected).toBe(3);
    expect(limited.group.selected).toHaveLength(1);
    expect(limited.group.omissions.map((o) => o.reason)).toEqual([
      "duplicate",
      "capacity",
    ]);
    expect(limited.sourceRevision).not.toBe(plan.sourceRevision);
    expect(plan.group.selected).toHaveLength(2);
  });
  it.each([
    "http://cdn.example.com/a.jpg",
    "https://127.0.0.1/a.jpg",
    "https://user:secret@cdn.example.com/a.jpg",
    "not-a-url",
  ])(
    "keeps unsafe URL %s out of the selected plan with an actionable blocking reason",
    (url) => {
      const plan = resolveExplicitPublicationMediaPlan({
        variantIds: [10],
        urls: [url],
        maxPhotosPerVariant: 20,
      });
      expect(plan.group.selected).toEqual([]);
      expect(plan.group.omissions).toEqual([
        {
          assetId: null,
          sourceIndex: 0,
          reason: "invalid",
          blocking: true,
          code: "CATALOG_IMAGE_URL_INVALID",
          message: expect.any(String),
        },
      ]);
    },
  );
});
