import { describe, expect, it, vi } from "vitest";
import { createCatalogPublicImageUrl } from "../../catalog-public-image";
import { resolveCatalogPublicationImage, type CatalogPublicationImage } from "../../catalog-publication-images.reader";
import { MAX_PRODUCT_IMAGE_BYTES } from "../../product-image-download.service";

const hash = "ab".repeat(32);
const image: CatalogPublicationImage = {
  id: 42, productId: 10, productVariantId: null, position: 1,
  url: null, storageType: "file", fileBytes: 100, fileHash: hash,
  fileHeader: Buffer.from("89504e470d0a1a0a00000000", "hex"), mimeType: "image/png",
};

describe("catalog public image URL", () => {
  it("generates a stable exact-image URL from a configured origin without changing the source", () => {
    const env = { CATALOG_PUBLIC_BASE_URL: " https://catalog.example.com/ " };
    const url = createCatalogPublicImageUrl(env);
    env.CATALOG_PUBLIC_BASE_URL = "https://changed.example.com";
    expect(resolveCatalogPublicationImage(Object.freeze(image), url)).toBe(`https://catalog.example.com/api/catalog/images/42/${hash}`);
    expect(url(42, hash)).toBe(url(42, hash));
    expect(url(42, "cd".repeat(32))).not.toBe(url(42, hash));
  });
  it.each(["PUBLIC_APP_URL", "APP_BASE_URL", "HEROKU_APP_DEFAULT_DOMAIN"])("supports existing deployment configuration %s", key => {
    const value = key === "HEROKU_APP_DEFAULT_DOMAIN" ? "catalog.example.com" : "https://catalog.example.com";
    expect(createCatalogPublicImageUrl({ [key]: value })(42, hash)).toContain("https://catalog.example.com/api/catalog/images/");
  });
  it.each([
    undefined, "", "http://catalog.example.com", "https://user:password@catalog.example.com",
    "https://catalog.example.com/path", "https://catalog.example.com?q=1", "https://catalog.example.com/#fragment",
    "https://localhost", "https://app.localhost", "https://app.internal", "https://127.0.0.1",
    "https://10.0.0.1", "https://[::1]", "https://catalog.example.com:444", "not a url",
  ])("rejects a missing or unsuitable public origin %s when needed", origin => {
    const url = createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: origin });
    expect(() => url(42, hash)).toThrow(expect.objectContaining({ code: "CATALOG_PUBLIC_URL_REQUIRED", status: 503 }));
  });
  it("does not fall back past an explicitly invalid configuration", () => {
    expect(() => createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: "invalid", PUBLIC_APP_URL: "https://catalog.example.com" })(42, hash))
      .toThrow(expect.objectContaining({ code: "CATALOG_PUBLIC_URL_REQUIRED" }));
  });
  it.each([[0, hash], [-1, hash], [1.5, hash], [2147483648, hash], [42, "short"], [42, "../" + hash]])("rejects invalid image identity %s", (id, digest) => {
    expect(() => createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: "https://catalog.example.com" })(id as number, digest as string))
      .toThrow(expect.objectContaining({ code: "CATALOG_IMAGE_INVALID" }));
  });
  it("preserves external URLs and missing URL-only images without requiring public hosting", () => {
    const url = vi.fn(createCatalogPublicImageUrl({}));
    expect(resolveCatalogPublicationImage({ ...image, url: "https://cdn.example.com/existing.jpg" }, url)).toBe("https://cdn.example.com/existing.jpg");
    expect(resolveCatalogPublicationImage({ ...image, storageType: "url", fileHash: null }, url)).toBeNull();
    expect(url).not.toHaveBeenCalled();
  });
  it.each([
    { fileBytes: null }, { fileBytes: 0 }, { fileBytes: MAX_PRODUCT_IMAGE_BYTES + 1 }, { fileHash: null }, { fileHeader: null },
  ])("reports unavailable uploaded content before producing a broken URL: %j", change => {
    expect(() => resolveCatalogPublicationImage({ ...image, ...change }, vi.fn())).toThrow(expect.objectContaining({ code: "CATALOG_IMAGE_UNAVAILABLE" }));
  });
  it.each([{ mimeType: "image/svg+xml" }, { fileHeader: Buffer.from("not an image") }])("rejects unsafe or mislabeled content %j", change => {
    expect(() => resolveCatalogPublicationImage({ ...image, ...change }, vi.fn())).toThrow(expect.objectContaining({ code: "IMAGE_FORMAT_UNSUPPORTED" }));
  });
});
