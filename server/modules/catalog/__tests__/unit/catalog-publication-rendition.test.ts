import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { inspectCatalogImage } from "../../catalog-image-inspection";
import { catalogRenditionProfile, prepareCatalogPublicationRendition } from "../../catalog-publication-rendition";

describe("Catalog publication renditions", () => {
  it.each([
    ["jpeg", "image/jpeg", 400, 200, 500, 250],
    ["png", "image/png", 200, 400, 250, 500],
    ["webp", "image/webp", 300, 300, 500, 500],
    ["gif", "image/gif", 400, 300, 500, 375],
  ] as const)("enlarges %s without cropping or changing the original", async (format, mimeType, width, height, expectedWidth, expectedHeight) => {
    const original = await sharp({create:{width,height,channels:3,background:"#b42a12"}}).toFormat(format).toBuffer();
    const before = Buffer.from(original);
    const result = await prepareCatalogPublicationRendition({data:original,mimeType});
    expect(original).toEqual(before);
    expect(result).not.toBeNull();
    expect(inspectCatalogImage(result!.image)).toMatchObject({width:expectedWidth,height:expectedHeight,mimeType});
    expect(result!.sourceHash).toBe(inspectCatalogImage({data:original,mimeType}).contentHash);
    expect(result!.contentHash).not.toBe(result!.sourceHash);
  });
  it("keeps a large original unchanged and selects a profile only for a compatible requirement", async () => {
    const data = await sharp({create:{width:640,height:320,channels:3,background:"#000"}}).png().toBuffer();
    expect(await prepareCatalogPublicationRendition({data,mimeType:"image/png"})).toBeNull();
    expect(catalogRenditionProfile(undefined)).toBeNull();
    expect(catalogRenditionProfile(500)).toBe("minimum-500-v1");
    expect(catalogRenditionProfile(300)).toBe("minimum-500-v1");
    expect(catalogRenditionProfile(800)).toBeNull();
    expect(() => catalogRenditionProfile(0)).toThrow();
  });
  it("retains all animation frames, timing and loop count", async () => {
    const raw = Buffer.alloc(100 * 200 * 3);
    raw.fill(220,0,100 * 100 * 3);
    raw.fill(80,100 * 100 * 3);
    const data = await sharp(raw,{raw:{width:100,height:200,channels:3,pageHeight:100}}).gif({delay:[100,250],loop:3}).toBuffer();
    const result = await prepareCatalogPublicationRendition({data,mimeType:"image/gif"});
    const metadata = await sharp(result!.image.data,{animated:true}).metadata();
    expect(metadata).toMatchObject({width:500,pageHeight:500,pages:2,delay:[100,250],loop:3});
  });
  it("reports an undecodable image instead of publishing a fabricated copy", async () => {
    const data = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000", "hex");
    await expect(prepareCatalogPublicationRendition({data,mimeType:"image/png"})).rejects.toMatchObject({code:"CATALOG_IMAGE_RENDITION_FAILED"});
  });
});
