import { describe, expect, it, vi } from "vitest";
import { planImageScopeRepair, type ImageScopeRepair, type ImageScopeSnapshot } from "../../product-image-scope-repair";
vi.mock("../../../../db", () => ({ db: {} }));

const image: ImageScopeSnapshot = { id: 7192, productId: 103, productVariantId: 78, variantProductId: 39,
  assetType: "image", url: "https://cdn.example.com/shared.jpg", position: 0, isPrimary: 1 };
const command: ImageScopeRepair = { productId: 103,
  expected: [{ id: 7192, url: image.url!, productVariantId: 78, position: 0, isPrimary: 1 }],
  actor: "test:operator", reason: "Verified shared photo in source product", evidenceReference: "test-source-snapshot",
  now: new Date("2026-10-07T00:00:00Z") };

describe("reviewed catalog image scope repair", () => {
  it("plans the exact cross-product correction without changing its inputs", () => {
    const before = structuredClone(image);
    const result = planImageScopeRepair(command, [image]);
    expect(result.after).toEqual([{ ...image, productVariantId: null, variantProductId: null }]);
    expect(result.alreadyApplied).toBe(false);
    expect(image).toEqual(before);
  });
  it("recognizes a fully applied retry", () => {
    expect(planImageScopeRepair(command, [{ ...image, productVariantId: null, variantProductId: null }]).alreadyApplied).toBe(true);
  });
  it.each([
    { variantProductId: 103 }, { variantProductId: null }, { productId: 39 }, { productVariantId: 265 },
    { url: "https://cdn.example.com/replaced.jpg" }, { position: 1 }, { isPrimary: 0 }, { assetType: "video" },
  ])("refuses valid variant ownership or stale content: %j", change => {
    expect(() => planImageScopeRepair(command, [{ ...image, ...change }])).toThrow(expect.objectContaining({ code: "IMAGE_SCOPE_REPAIR_STALE" }));
  });
  it("refuses missing, duplicate, invalid and partially changed selections", () => {
    for (const invalid of [{ ...command, expected: [] }, { ...command, productId: 0 }, { ...command, actor: " " },
      { ...command, expected: [command.expected[0], command.expected[0]] }]) {
      expect(() => planImageScopeRepair(invalid, [image])).toThrow(expect.objectContaining({ code: "IMAGE_SCOPE_REPAIR_INVALID" }));
    }
    expect(() => planImageScopeRepair(command, [])).toThrow(expect.objectContaining({ code: "IMAGE_SCOPE_REPAIR_STALE" }));
    const two = { ...command, expected: [...command.expected, { ...command.expected[0], id: 7193 }] };
    expect(() => planImageScopeRepair(two, [image, { ...image, id: 7193, productVariantId: null, variantProductId: null }]))
      .toThrow(expect.objectContaining({ code: "IMAGE_SCOPE_REPAIR_STALE" }));
  });
});
