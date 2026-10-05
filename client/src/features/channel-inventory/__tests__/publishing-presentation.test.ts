import { describe, expect, it } from "vitest";
import { describeResumeIssue, describeStockUpdates } from "../publishing-presentation";
import { explainQuantity } from "../model";
import { previewRow, target } from "./fixtures";

describe("stock update presentation", () => {
  it("describes missing and stale marketplace checks without promising that a local review fetches new stock", () => {
    expect(describeResumeIssue("INVENTORY_PUBLICATION_TARGET_RESUME_READBACK_MISSING")).toContain("recorded check is needed");
    expect(describeResumeIssue("INVENTORY_PUBLICATION_TARGET_RESUME_READBACK_STALE")).toContain("current stock check is needed");
    expect(describeResumeIssue("UNKNOWN_NEW_BLOCKER")).toContain("Check details");
  });
  it("does not advertise a live account as enabled when the global switch cannot be read", () => {
    expect(describeStockUpdates(target({ state: "live" }), "canonical", null).label).toBe("Status unavailable");
    expect(describeStockUpdates(target({ state: "live" }), "canonical", false).label).toBe("Paused for all channels");
    expect(describeStockUpdates(target({ state: "live" }), "canonical", true).label).toBe("Enabled");
  });
  it("does not turn preview or disabled accounts on just because the global control is on", () => {
    expect(describeStockUpdates(target({ state: "preview" }), "canonical", true).label).toBe("Off");
    expect(describeStockUpdates(target({ state: "disabled" }), "canonical", true).label).toBe("Off");
  });
  it.each(["external_provider", "manual"] as const)("does not claim Echelon controls %s stock", authority => {
    const result = describeStockUpdates(target({ state: "live", publicationAuthority: authority }), "canonical", true);
    expect(result.label).toBe("Managed elsewhere");
    expect(result.explanation).toContain("Echelon does not send");
  });
  it("does not claim the new rules control a legacy runtime", () => {
    expect(describeStockUpdates(target({ state: "live" }), "legacy", true).label).toBe("Setup only");
  });
  it("does not mistake a stock hold for a global pause or an individual stock rule", () => {
    const hold = { heldBy: "operator-1", heldAt: "2026-10-04T12:00:00.000Z", reason: "Inventory count" };
    expect(describeStockUpdates(target({ state: "live", hold }), "canonical", false).label).toBe("Paused for all channels");
    expect(describeStockUpdates(target({ state: "live", hold }), "canonical", true).label).toBe("Holding at zero");
    const explanation = explainQuantity(previewRow({ hold, sharedUnits: "0", afterHoldbackUnits: "0", cappedUnits: "0", publishedUnits: "0" }));
    expect(explanation.steps).toEqual([
      { label: "Available", units: "100", detail: "Available stock in the selected warehouses." },
      { label: "Stock hold", units: "0", detail: "Inventory count" },
    ]);
    expect(explanation.zeroReason).toContain("Inventory count");
  });
});
