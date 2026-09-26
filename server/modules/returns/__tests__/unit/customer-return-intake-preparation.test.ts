import { describe, expect, it } from "vitest";
import {
  customerReturnSubmissionHash,
  prepareCustomerReturnIntake,
} from "../../application/customer-return-intake-preparation";
import {
  LABEL_LEASE,
  labelPolicy,
  labelPreparationFixture,
  labelSettings,
} from "../support/label-fixtures";
import { projectCustomerReturnLiveWmsAllocations } from "../../application/customer-return-live-delivery";
const policy = { id: 1, version: 1, snapshot: labelPolicy };
describe("trusted live return intake preparation", () => {
  it("preserves purchased-line identities and exact warehouse allocations across repacked boxes", async () => {
    const f = await labelPreparationFixture();
    const before = structuredClone(f.inspection);
    const prepared = prepareCustomerReturnIntake(
      f.input,
      f.inspection,
      labelSettings,
      policy,
      "admin",
      LABEL_LEASE,
    );
    expect(
      prepared.lines.map((line) => [
        line.omsOrderLineId,
        line.externalLineItemId,
        line.quantity,
      ]),
    ).toEqual([
      [101, "501", 2],
      [102, "502", 1],
    ]);
    expect(
      prepared.lines.map((line) =>
        line.allocations.map((a) => [a.wmsOrderItemId, a.quantity]),
      ),
    ).toEqual([[[301, 2]], [[302, 1]]]);
    expect(prepared.parcels.map((parcel) => parcel.weightGrams)).toEqual([
      33, 13,
    ]);
    expect(prepared.parcels.map((parcel) => parcel.items)).toEqual([
      [
        { omsOrderLineId: 101, quantity: 1 },
        { omsOrderLineId: 102, quantity: 1 },
      ],
      [{ omsOrderLineId: 101, quantity: 1 }],
    ]);
    expect(prepared).toMatchObject({
      submissionLeaseToken: LABEL_LEASE,
      policySnapshot: { refundAuthority: "manual_shopify" },
      warehouseSnapshot: { warehouseId: 1 },
    });
    expect(f.inspection).toEqual(before);
  });
  it("does not invent a receiving partition from delivery alone", async () => {
    const f = await labelPreparationFixture();
    f.local.fulfillmentBindings = [];
    const inspection = await f.service.inspectForIntake({
      channelId: 36,
      orderReference: "0012-A",
    });
    expect(inspection.order.lines[0].eligibleQuantity).toBe(2);
    expect(() =>
      prepareCustomerReturnIntake(
        { ...f.input, sourceRevision: inspection.order.sourceRevision },
        inspection,
        labelSettings,
        policy,
        "admin",
        LABEL_LEASE,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "RETURN_LABEL_ALLOCATION_UNVERIFIED" }),
    );
  });
  it.each([
    "revision",
    "settings",
    "disabled",
    "address",
    "weight",
    "quantity",
  ])("blocks invalid %s before persistence", async (kind) => {
    const f = await labelPreparationFixture();
    const settings = structuredClone(labelSettings);
    if (kind === "revision") f.input.sourceRevision = "0".repeat(64);
    if (kind === "settings") settings.version = 2;
    if (kind === "disabled") settings.enabled = false;
    if (kind === "address") f.inspection.provider.order.shippingAddress = null;
    if (kind === "weight") f.inspection.order.lines[0].unitWeightGrams = null;
    if (kind === "quantity") f.input.parcels[0].items[0].quantity = 9;
    expect(() =>
      prepareCustomerReturnIntake(
        f.input,
        f.inspection,
        settings,
        policy,
        "admin",
        LABEL_LEASE,
      ),
    ).toThrow();
  });
  it("hashes normalized intent deterministically without changing inputs or hiding changed boxes", async () => {
    const { input } = await labelPreparationFixture();
    const before = structuredClone(input);
    const reordered = {
      ...input,
      orderReference: "#0012-A",
      sourceRevision: "f".repeat(64),
      selections: [...input.selections].reverse(),
      parcels: input.parcels.map((parcel) => ({
        ...parcel,
        items: [...parcel.items].reverse(),
      })),
    };
    expect(customerReturnSubmissionHash(reordered)).toBe(
      customerReturnSubmissionHash(input),
    );
    expect(
      customerReturnSubmissionHash({
        ...input,
        parcels: [...input.parcels].reverse(),
      }),
    ).not.toBe(customerReturnSubmissionHash(input));
    expect(input).toEqual(before);
  });
  it("shares the delivery projection's duplicate-echo and invalid-binding checks", async () => {
    const f = await labelPreparationFixture();
    expect(
      projectCustomerReturnLiveWmsAllocations({
        local: f.local,
        shopify: f.shopify,
      }).get("gid://shopify/FulfillmentLineItem/701"),
    ).toEqual([{ wmsOrderItemId: 301, originalQuantity: 2 }]);
    f.local.fulfillmentBindings[0].quantity = 3;
    expect(
      projectCustomerReturnLiveWmsAllocations({
        local: f.local,
        shopify: f.shopify,
      }).has("gid://shopify/FulfillmentLineItem/701"),
    ).toBe(false);
  });
});
