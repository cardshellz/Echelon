import { describe, expect, it } from "vitest";
import { legacyDropshipReturnDestination } from "../returns-admin-navigation";

describe("legacyDropshipReturnDestination", () => {
  it("redirects the retired Dropship Returns tab to first-class cases", () => {
    expect(legacyDropshipReturnDestination("?tab=returns")).toBe(
      "/returns/cases",
    );
  });

  it("redirects the retired Dropship policy tab to first-class policies", () => {
    expect(
      legacyDropshipReturnDestination("tab=return-policies&source=bookmark"),
    ).toBe("/return-policies");
  });

  it("does not redirect active Dropship tabs or missing tab values", () => {
    expect(legacyDropshipReturnDestination("?tab=stores")).toBeNull();
    expect(legacyDropshipReturnDestination("")).toBeNull();
  });
});
