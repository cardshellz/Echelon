import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedProductPhotoImporter } from "../../shared-product-photos.service";
vi.mock("../../../../db", () => ({ db: {} }));
afterEach(() => vi.restoreAllMocks());
describe("shared photo import validation", () => {
  it.each([
    { productId: 0, photos: [] },
    { productId: 1, photos: [{ url: "not a URL", position: 0 }] },
    { productId: 1, photos: [{ url: "", position: 0 }] }, { productId: 1, photos: [{ url: "javascript:alert(1)", position: 0 }] },
    { productId: 1, photos: [{ url: "https://user:secret@example.com/a.jpg", position: 0 }] },
    { productId: 1, photos: [{ url: "https://cdn.example.com/a.jpg", position: -1 }] },
    { productId: 1, photos: [{ url: "https://cdn.example.com/a.jpg", position: 0, altText: "a".repeat(501) }] },
    { productId: 1, photos: [{ url: "https://cdn.example.com/a.jpg", position: 0, productVariantId: 10 }] },
  ])("rejects invalid imported metadata before any DB write", async (input) => {
    const transaction = vi.fn();
    const importer = createSharedProductPhotoImporter({ transaction } as never, () => new Date(0));
    await expect(importer.append({ ...input, actor: "operator" } as never)).rejects.toMatchObject({ code: "IMPORTED_PHOTOS_INVALID" });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("an empty source is a no-op", async () => {
    const transaction = vi.fn();
    expect(await createSharedProductPhotoImporter({ transaction } as never, () => new Date(0)).append({ productId: 1, photos: [], actor: "operator" })).toEqual({ created: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });
});
