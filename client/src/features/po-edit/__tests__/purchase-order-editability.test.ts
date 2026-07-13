import { describe, expect, it } from "vitest";
import {
  canUseFullPurchaseOrderEditor,
  isImmutableRecommendationPurchaseOrder,
} from "../purchase-order-editability";

describe("purchase order editor routing", () => {
  it.each([
    { source: "manual", metadata: { source: "accepted_recommendation_handoff" } },
    { source: "manual", metadata: { source: "automatic_recommendation_handoff" } },
  ])("recognizes immutable recommendation ownership", (po) => {
    expect(isImmutableRecommendationPurchaseOrder(po)).toBe(true);
  });

  it("allows only ordinary drafts into the full editor", () => {
    expect(canUseFullPurchaseOrderEditor({ status: "draft", source: "manual" })).toBe(true);
    expect(canUseFullPurchaseOrderEditor({ status: "sent", source: "manual" })).toBe(false);
    // Source alone predates immutable handoff provenance. The server blocks
    // only POs with a real handoff row, whose metadata carries this marker.
    expect(canUseFullPurchaseOrderEditor({ status: "draft", source: "auto_draft" })).toBe(true);
    expect(canUseFullPurchaseOrderEditor({
      status: "draft",
      source: "auto_draft",
      metadata: { source: "automatic_recommendation_handoff" },
    })).toBe(false);
  });
});
