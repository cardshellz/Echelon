import { describe, expect, it } from "vitest";
import type { CustomerReturnFlowOrder } from "@shared/returns/customer-return-flow.contract";
import { customerReturnPackingLimits, defaultCustomerReturnShippingGuardrails } from "@shared/returns/customer-return-shipping-guardrails";
import { singlePreviewParcel, buildPreviewReviewInput } from "../../customer-return-preview";
import { splitPreviewPackingBox, previewPackingGuardrailIssue } from "../../customer-return-packing-guardrails";
import { customPreviewParcelSize } from "../../customer-return-parcels";
import { createReturnShippingGuardrailsDraft, returnShippingGuardrailsDraftSchema } from "../../customer-return-guardrails-draft";

function order(): CustomerReturnFlowOrder {
  return { sourceRevision: null, orderReference: "TEST-1", purchasedAt: "2026-10-01T00:00:00Z", evaluatedAt: "2026-10-03T00:00:00Z",
    returnWindowEndsAt: "2027-10-01T00:00:00Z", message: null, boxOptions: [],
    packingLimits: customerReturnPackingLimits({ selectionMode: "fixed_service", carrierId: "se-test", serviceCode: "ups_ground", carrierRules: [],
      parcelGuardrails: defaultCustomerReturnShippingGuardrails() }),
    lines: [{ id: "heavy", title: "Heavy product", variant: null, sku: "HEAVY", unitWeightGrams: 13607.7711,
      purchasedQuantity: 2, deliveredQuantity: 2, alreadyReturningQuantity: 0, eligibleQuantity: 2, message: null }] };
}
const selections = [{ lineId: "heavy", quantity: 2, reasonCode: null }];
const size = () => customPreviewParcelSize({ lengthMm: 254, widthMm: 203.2, heightMm: 152.4 });
describe("customer box guardrail actions", () => {
  it("starts two 30 lb units in two boxes and preserves their selected quantity", () => {
    const source = order();
    const boxes = singlePreviewParcel(selections, source).map(box => ({ ...box, size: size() }));
    expect(boxes).toHaveLength(2);
    expect(boxes.flatMap(box => box.items)).toEqual([{ lineId: "heavy", quantity: "1" }, { lineId: "heavy", quantity: "1" }]);
    expect(buildPreviewReviewInput(source, selections, boxes).ok).toBe(true);
  });
  it("blocks a 60 lb repack and offers a conserving split with fresh keys", () => {
    const source = order();
    const boxes = [{ key: 8, items: [{ lineId: "heavy", quantity: "2" }], size: size() }];
    expect(previewPackingGuardrailIssue(source, boxes[0])).toBe("weight");
    expect(buildPreviewReviewInput(source, selections, boxes).ok).toBe(false);
    const before = structuredClone(boxes);
    const split = splitPreviewPackingBox(source, boxes, 8);
    expect(split.ok && split.parcels.map(box => box.key)).toEqual([8, 9]);
    expect(split.ok && split.parcels[0].size).toEqual(before[0].size);
    expect(boxes).toEqual(before);
  });
  it("shows weight feedback before dimensions are filled and size feedback once complete", () => {
    const source = order();
    const box = { key: 1, items: [{ lineId: "heavy", quantity: "2" }], size: customPreviewParcelSize() };
    expect(previewPackingGuardrailIssue(source, box)).toBe("weight");
    box.items[0].quantity = "1";
    expect(previewPackingGuardrailIssue(source, box)).toBeNull();
    box.size = customPreviewParcelSize({ lengthMm: 3000, widthMm: 100, heightMm: 100 });
    expect(previewPackingGuardrailIssue(source, box)).toBe("size");
  });
  it("routes a single overweight unit to help rather than dividing it", () => {
    const source = order();
    source.lines[0].unitWeightGrams = 30000;
    expect(splitPreviewPackingBox(source, [{ key: 1, items: [{ lineId: "heavy", quantity: "1" }], size: size() }], 1))
      .toMatchObject({ ok: false, message: expect.stringContaining("single item") });
  });
  it("round trips admin defaults and validates incomplete/oversize edits", () => {
    const draft = createReturnShippingGuardrailsDraft();
    expect(returnShippingGuardrailsDraftSchema.parse(draft)).toEqual(defaultCustomerReturnShippingGuardrails());
    draft.ups.referenceLengthInches = "";
    expect(returnShippingGuardrailsDraftSchema.safeParse(draft).success).toBe(false);
    draft.ups.referenceLengthInches = "109";
    expect(returnShippingGuardrailsDraftSchema.safeParse(draft).success).toBe(false);
    draft.ups.referenceLengthInches = "24";
    draft.ups.maxWeightLb = "0";
    expect(returnShippingGuardrailsDraftSchema.safeParse(draft).success).toBe(false);
  });
});
