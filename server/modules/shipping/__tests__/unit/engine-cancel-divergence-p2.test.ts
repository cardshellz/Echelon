import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SHIPSTATION_SRC = readFileSync(
  resolve(__dirname, "../../../oms/shipstation.service.ts"),
  "utf8",
);
const OMS_ROUTES_SRC = readFileSync(
  resolve(__dirname, "../../../../routes/oms.routes.ts"),
  "utf8",
);
const OMS_ORDERS_SRC = readFileSync(
  resolve(__dirname, "../../../../../client/src/pages/OmsOrders.tsx"),
  "utf8",
);

// Engine-cancel divergence P2 (ENGINE-CANCEL-DIVERGENCE-DESIGN.md §4.3): an
// operator can resolve an "engine cancelled but order is live" review by
// clearing the flag and re-pushing — intentionally resurrecting the cancelled
// ShipStation order. The override is privileged (gated on orders:hold).
describe("engine-cancel divergence P2 — clear-review-and-push override", () => {
  it("pushShipment accepts an overrideReview option", () => {
    expect(SHIPSTATION_SRC).toMatch(/opts:\s*\{\s*overrideReview\?:\s*boolean\s*\}/);
  });

  it("overrideReview bypasses the requires_review and cancelled-SS-order guards", () => {
    expect(SHIPSTATION_SRC).toMatch(/shipmentRow\.requires_review === true && !opts\.overrideReview/);
    expect(SHIPSTATION_SRC).toMatch(/isUpdate && !opts\.overrideReview/);
  });

  it("overrideReview clears the review flag after a successful push", () => {
    expect(SHIPSTATION_SRC).toMatch(/if \(opts\.overrideReview\)/);
    expect(SHIPSTATION_SRC).toMatch(/SET requires_review = false, review_reason = NULL/);
  });

  it("the push endpoint gates overrideReview on the orders:hold permission", () => {
    expect(OMS_ROUTES_SRC).toMatch(/req\.body\?\.overrideReview === true/);
    expect(OMS_ROUTES_SRC).toMatch(/hasPermission\(userId, "orders", "hold"\)/);
    expect(OMS_ROUTES_SRC).toMatch(/pushShipment\(shipmentId, \{ overrideReview \}\)/);
  });

  it("the OMS Orders re-push button is permission-gated and sends overrideReview", () => {
    expect(OMS_ORDERS_SRC).toMatch(/canOverrideReview = hasPermission\("orders", "hold"\)/);
    expect(OMS_ORDERS_SRC).toMatch(/overrideReview: true/);
    expect(OMS_ORDERS_SRC).toMatch(/Re-push to ShipStation/);
  });
});
