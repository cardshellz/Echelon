import { describe, expect, it } from "vitest";
import { isWmsCartonizationShadowEnabled } from "../../application/wms-cartonization-shadow";

describe("isWmsCartonizationShadowEnabled", () => {
  it("defaults to off", () => {
    expect(isWmsCartonizationShadowEnabled(undefined)).toBe(false);
  });

  it("requires an explicit true value", () => {
    expect(isWmsCartonizationShadowEnabled("true")).toBe(true);
    expect(isWmsCartonizationShadowEnabled(" TRUE ")).toBe(true);
    expect(isWmsCartonizationShadowEnabled("false")).toBe(false);
    expect(isWmsCartonizationShadowEnabled("required")).toBe(false);
  });
});
