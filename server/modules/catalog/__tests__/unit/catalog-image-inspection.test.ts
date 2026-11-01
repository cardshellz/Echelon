import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assertCatalogPublicationPhotoRequirements, createCatalogImageInspector, inspectCatalogImage } from "../../catalog-image-inspection";
import { ProductAssetError } from "../../product-asset-errors";

const png = (name: string) => ({ mimeType: "image/png", data: readFileSync(new URL(`../fixtures/photos/${name}.png`, import.meta.url)) });
describe("Catalog original image inspection", () => {
  it.each([["original", 640], ["minimum", 500], ["thumbnail", 400]] as const)("measures the actual %s PNG bytes", (name, size) => {
    const image = png(name), before = Buffer.from(image.data);
    expect(inspectCatalogImage(image)).toMatchObject({ width: size, height: size, bytes: image.data.length });
    expect(image.data).toEqual(before);
  });
  it("enforces each channel's declared minimum rather than a global marketplace rule", async () => {
    const inspector = createCatalogImageInspector(async () => png("thumbnail"));
    await expect(assertCatalogPublicationPhotoRequirements(inspector, ["https://cdn.example.com/actual-original.jpg"], { minimumLongestSide: 500 }))
      .rejects.toMatchObject({ code: "CATALOG_IMAGE_RESOLUTION_TOO_SMALL", message: expect.stringContaining("400 × 400") });
    await expect(assertCatalogPublicationPhotoRequirements(inspector, ["https://cdn.example.com/actual-original.jpg"], { minimumLongestSide: 300 })).resolves.toBeUndefined();
  });
  it("accepts the exact 500px boundary and rejects truncated or mislabeled input", async () => {
    await expect(assertCatalogPublicationPhotoRequirements(createCatalogImageInspector(async () => png("minimum")), ["https://cdn.example.com/photo.png"], { minimumLongestSide: 500 })).resolves.toBeUndefined();
    expect(() => inspectCatalogImage({ mimeType: "image/png", data: png("minimum").data.subarray(0, 12) })).toThrow(ProductAssetError);
    expect(() => inspectCatalogImage({ mimeType: "image/jpeg", data: png("minimum").data })).toThrow(ProductAssetError);
  });
  it("deduplicates galleries and caps concurrent downloads", async () => {
    let active = 0, maximum = 0;
    const read = vi.fn(async () => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return png("original"); });
    const results = await createCatalogImageInspector(read).inspect(["a", "a", "b", "c"]);
    expect(results.size).toBe(3); expect(read).toHaveBeenCalledTimes(3); expect(maximum).toBeLessThanOrEqual(2);
  });
  it("preserves source failures without returning an empty successful inspection", async () => {
    const error = new ProductAssetError("IMAGE_SOURCE_UNAVAILABLE", "Source failed", 502);
    await expect(createCatalogImageInspector(async () => { throw error; }).inspect(["https://cdn.example.com/photo.png"])).rejects.toBe(error);
  });
  it("drains in-flight work but does not start more downloads after the first failure", async () => {
    const error = new ProductAssetError("IMAGE_SOURCE_UNAVAILABLE", "Source failed", 502);
    let release!:()=>void,entered!:()=>void;
    const held = new Promise<void>(resolve=>{release=resolve;});
    const started = new Promise<void>(resolve=>{entered=resolve;});
    const read = vi.fn(async (url:string)=>{if(url==="a")throw error;entered();await held;return png("original");});
    const result = createCatalogImageInspector(read).inspect(["a","b","c"]);
    const rejected = expect(result).rejects.toBe(error);
    await started; await Promise.resolve(); release(); await rejected;
    expect(read.mock.calls.map(([url])=>url)).toEqual(["a","b"]);
  });
});
