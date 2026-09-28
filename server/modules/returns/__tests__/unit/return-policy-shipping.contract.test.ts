import { describe, expect, it } from "vitest";
import {
  customerReturnPolicyShippingInputSchema,
  customerReturnLabelControlInputSchema,
  customerReturnLabelControlSchema,
} from "@shared/returns/return-policy-shipping.contract";
import { customerReturnLabelSettingsSchema } from "@shared/returns/customer-return-label.contract";
import { labelSettings } from "../support/label-fixtures";

describe("immutable policy shipping input and independent pause contracts", () => {
  function input() {
    const {
      version: _version,
      policyId: _owner,
      destinationAddress: _destination,
      ...value
    } = labelSettings;
    return value;
  }
  it("accepts shipping choices while retaining server-owned policy identity only in output", () => {
    expect(customerReturnPolicyShippingInputSchema.parse(input())).toEqual(
      input(),
    );
    expect(
      customerReturnLabelSettingsSchema.parse({
        ...labelSettings,
        policyId: 19,
        version: 19,
      }),
    ).toMatchObject({ policyId: 19, version: 19 });
  });
  it.each(["policyId", "version", "expectedVersion", "destinationAddress"])(
    "rejects client-owned %s on policy shipping input",
    (field) => {
      expect(
        customerReturnPolicyShippingInputSchema.safeParse({
          ...input(),
          [field]:
            field === "destinationAddress"
              ? labelSettings.destinationAddress
              : 1,
        }).success,
      ).toBe(false);
    },
  );
  it("retains historical output without an owner without inventing one", () => {
    const { policyId: _policy, ...legacy } = labelSettings;
    expect(customerReturnLabelSettingsSchema.parse(legacy)).not.toHaveProperty(
      "policyId",
    );
  });
  it("requires an automatic allowlist and rejects simultaneously pinned carrier values", () => {
    const automatic = {
      ...input(),
      selectionMode: "cheapest_eligible",
      carrierId: null,
      serviceCode: null,
      carrierRules: [
        {
          carrierId: "se-123",
          serviceCodes: ["ups_ground"],
          maxWeightLb: "20",
        },
      ],
    };
    expect(
      customerReturnPolicyShippingInputSchema.safeParse(automatic).success,
    ).toBe(true);
    expect(
      customerReturnPolicyShippingInputSchema.safeParse({
        ...automatic,
        carrierRules: [],
      }).success,
    ).toBe(false);
    expect(
      customerReturnPolicyShippingInputSchema.safeParse({
        ...automatic,
        carrierId: "se-123",
      }).success,
    ).toBe(false);
  });
  it("represents missing controls as version zero but never accepts shipping fields in pause commands", () => {
    expect(
      customerReturnLabelControlSchema.parse({ paused: false, version: 0 }),
    ).toEqual({ paused: false, version: 0 });
    expect(
      customerReturnLabelControlInputSchema.parse({
        paused: true,
        expectedVersion: 0,
      }),
    ).toEqual({ paused: true, expectedVersion: 0 });
    for (const invalid of [
      { paused: true, expectedVersion: -1 },
      { paused: "true", expectedVersion: 0 },
      { paused: true, expectedVersion: 0, carrierId: "se-123" },
    ]) {
      expect(
        customerReturnLabelControlInputSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });
});
