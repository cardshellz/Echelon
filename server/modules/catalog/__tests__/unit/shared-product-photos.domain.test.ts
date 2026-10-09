import { describe, expect, it } from "vitest";
import { planSharedPhotoAdditions } from "../../shared-product-photos.domain";
describe("shared imported photo planning", () => {
  it("retains existing photos, deduplicates source URLs and does not mutate input", () => {
    const existing = Object.freeze([Object.freeze({ id: 1, url: "https://cdn.example.com/current.jpg", position: 9 })]);
    const photos = Object.freeze([
      Object.freeze({ url: "https://cdn.example.com/front.jpg", position: 1 }),
      Object.freeze({ url: "https://cdn.example.com/current.jpg", position: 0 }),
      Object.freeze({ url: "https://cdn.example.com/front.jpg", position: 1 }),
    ]);
    expect(planSharedPhotoAdditions(existing, photos)).toEqual([
      { url: "https://cdn.example.com/front.jpg", altText: null, position: 10, isPrimary: 0, productVariantId: null },
    ]);
  });
  it("does not erase a stored-file gallery or create a second primary", () => {
    expect(planSharedPhotoAdditions([{ id: 1, url: null, position: 0 }], [])).toEqual([]);
    expect(planSharedPhotoAdditions([{ id: 1, url: null, position: 0 }], [{ url: "https://cdn.example.com/new.jpg", position: 0 }])[0].isPrimary).toBe(0);
  });
  it("rejects position overflow rather than wrapping an integer", () => {
    expect(() => planSharedPhotoAdditions([{ id: 1, url: null, position: 2147483647 }], [{ url: "https://cdn.example.com/new.jpg", position: 0 }])).toThrowError(expect.objectContaining({ code: "IMPORTED_PHOTOS_LIMIT" }));
  });
  it("rejects excessive new rows, while repeated URLs do not multiply writes", () => {
    const repeated = Array.from({ length: 1001 }, () => ({ url: "https://cdn.example.com/repeat.jpg", position: 0 }));
    expect(planSharedPhotoAdditions([], repeated)).toHaveLength(1);
    const unique = Array.from({ length: 1001 }, (_, index) => ({ url: `https://cdn.example.com/${index}.jpg`, position: index }));
    expect(() => planSharedPhotoAdditions([], unique)).toThrowError(expect.objectContaining({ code: "IMPORTED_PHOTOS_LIMIT" }));
  });
});
