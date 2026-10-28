import { describe, expect, it } from "vitest";
import { prepareChannelPackage } from "../../domain/channel-package";

const input = { productId: 20, variantId: 101, sku: "TEST-VARIANT",
  requirements: { weight: true, dimensions: true },
  catalog: { weightGrams: "120.25", lengthMm: "152.40", widthMm: "101.60", heightMm: "25.40" },
  observed: { weightGrams: 1, lengthMm: 1, widthMm: 1, heightMm: 1 } };
describe("shared channel package ownership", () => {
  it("uses validated catalog facts without mutating either source", () => {
    const before = structuredClone(input);
    expect(prepareChannelPackage(input)).toEqual({ values: { weightGrams: 120.25, lengthMm: 152.4, widthMm: 101.6, heightMm: 25.4 },
      sources: { weight: "catalog", dimensions: "catalog" } });
    expect(input).toEqual(before);
  });
  it("preserves known channel facts when catalog facts are unspecified, including explicit null", () => {
    expect(prepareChannelPackage({ ...input, catalog: { weightGrams: null, lengthMm: null } })).toEqual({
      values: input.observed, sources: { weight: "channel", dimensions: "channel" } });
  });
  it("never combines measurements from different packages", () => {
    expect(() => prepareChannelPackage({ ...input, catalog: { lengthMm: 100 } })).toThrowError(expect.objectContaining({
      context: { validation: { field: "package_dimensions", reason: "required", productId: 20, variantId: 101, variantSku: "TEST-VARIANT" } } }));
  });
  it.each([0, -1, Number.NaN, Infinity, "", "oops"])("rejects invalid catalog facts instead of falling back (%s)", value => {
    expect(() => prepareChannelPackage({ ...input, catalog: { ...input.catalog, weightGrams: value } })).toThrow(/weight is invalid/);
  });
  it.each(["weight", "dimensions"] as const)("blocks missing required %s without inventing values", field => {
    expect(() => prepareChannelPackage({ ...input, catalog: {}, observed: {},
      requirements: { weight: field === "weight", dimensions: field === "dimensions" } })).toThrow(/required/);
  });
  it("allows absent optional package data", () => {
    expect(prepareChannelPackage({ ...input, catalog: {}, observed: {}, requirements: { weight: false, dimensions: false } }).sources)
      .toEqual({ weight: "absent", dimensions: "absent" });
  });
  it("warns for recommended dimensions without creating measurements", () => {
    const plan = prepareChannelPackage({ ...input, catalog: { weightGrams: 120 }, observed: {},
      requirements: { weight: true, dimensions: "recommended" } });
    expect(plan).toEqual({ values: { weightGrams: 120, lengthMm: null, widthMm: null, heightMm: null },
      sources: { weight: "catalog", dimensions: "absent" }, warnings: [{ code: "CHANNEL_PACKAGE_DIMENSIONS_MISSING",
        field: "package_dimensions", productId: 20, variantId: 101, variantSku: "TEST-VARIANT" }] });
  });
  it("does not turn partial or invalid supplied measurements into warnings", () => {
    for (const catalog of [{ weightGrams: 120, lengthMm: 10 }, { weightGrams: 120, lengthMm: 0, widthMm: 10, heightMm: 10 }]) {
      expect(() => prepareChannelPackage({ ...input, catalog, observed: {},
        requirements: { weight: true, dimensions: "recommended" } })).toThrow();
    }
  });
});
