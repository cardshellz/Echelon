import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssemblyPackageEvidence } from "../../AssemblyPackageReview";
import type { AssemblyPackageReview } from "@shared/assembly-package-review";
const empty: AssemblyPackageReview = { taskId: "1", orderId: 70, warehouseId: 1, readOnly: true,
  closesPackage: false, discoveryComplete: false, packages: [] };
describe("assembly bench observed package display", () => {
  it("explains delayed label evidence without offering a duplicate label or fake close", () => {
    const html = renderToStaticMarkup(createElement(AssemblyPackageEvidence, { review: empty }));
    expect(html).toContain("No linked package label"); expect(html).toContain("not connected yet");
    expect(html).not.toContain("<button");
  });
  it("shows exact provider-declared quantities and keeps observation distinct from completion", () => {
    const html = renderToStaticMarkup(createElement(AssemblyPackageEvidence, { review: { ...empty, packages: [{
      labelId: "601", provider: "shipstation", providerPackageId: "44001", trackingNumber: "TRACK1234", labelStatus: "active",
      evidenceHash: "a".repeat(64), status: "observed_contents", issues: [], items: [{ sourceShipmentItemId: 101, orderItemId: 71, sku: "P5", quantity: 2 }],
    }] } }));
    expect(html).toContain("2 × P5"); expect(html).toContain("TRACK1234"); expect(html).toContain("Provider-declared contents");
    expect(html).toContain("not a packed/shipped receipt");
  });
  it("explains wrong or void label evidence and hides partial package instructions", () => {
    const html = renderToStaticMarkup(createElement(AssemblyPackageEvidence, { review: { ...empty, packages: [{
      labelId: "601", provider: "shipstation", providerPackageId: "44001", trackingNumber: "TRACK1234", labelStatus: "voided",
      evidenceHash: "a".repeat(64), status: "review_required", issues: ["label_not_active"], items: [],
    }] } }));
    expect(html).toContain("Do not apply it"); expect(html).not.toContain("Provider-declared contents:");
  });
});
