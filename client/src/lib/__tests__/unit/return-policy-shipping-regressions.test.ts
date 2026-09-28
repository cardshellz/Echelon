import { describe, expect, it } from "vitest";
import {
  readReturnPolicySaveResponse,
  returnPolicyDraftChannelId,
  returnPolicyVersionCommandSchema,
} from "../../return-policy-shipping";
import {
  returnLabelSettingsReadiness,
  type ReturnLabelSettingsDraft,
  type ReturnShippingDraftSource,
} from "../../customer-return-label-settings";

function storeCommand() {
  return returnPolicyVersionCommandSchema.parse({
    name: "Store returns",
    appliesTo: "store",
    channelId: null,
    vendorId: 5,
    storeConnectionId: 8,
    expectedPolicyId: 3,
    returnWindowDays: 30,
    returnDestination: "card_shellz",
    approvalAuthority: "card_shellz",
    labelProvider: "shipstation",
    returnShippingPayer: "card_shellz",
    inspectionRequirement: "required",
    inspectionOwner: "card_shellz",
    customerRefundAuthority: "card_shellz",
    vendorSettlementTrigger: "none",
    returnlessRefundAllowed: false,
    notes: null,
    shipping: null,
  });
}

function response(overrides: Record<string, unknown> = {}) {
  const { appliesTo: _scope, expectedPolicyId, ...fields } = storeCommand();
  return new Response(
    JSON.stringify({
      policy: {
        ...fields,
        id: 4,
        version: 2,
        status: "active",
        scopeKind: "store",
        channelId: 99,
        businessContext: "dropship",
        supersedesPolicyId: expectedPolicyId,
        ...overrides,
      },
      replayed: false,
    }),
  );
}

describe("store policy public and canonical scope boundaries", () => {
  it("normalizes a persisted store channel into the public vendor/store-only command", () => {
    expect(returnPolicyDraftChannelId("store", 99)).toBeNull();
    expect(returnPolicyDraftChannelId("vendor", null)).toBeNull();
    expect(returnPolicyDraftChannelId("all_orders", null)).toBeNull();
    expect(returnPolicyDraftChannelId("channel", 36)).toBe(36);
    expect(
      returnPolicyVersionCommandSchema.safeParse({
        ...storeCommand(),
        channelId: returnPolicyDraftChannelId("store", 99),
      }).success,
    ).toBe(true);
    expect(
      returnPolicyVersionCommandSchema.safeParse({
        ...storeCommand(),
        channelId: 99,
      }).success,
    ).toBe(false);
  });

  it("accepts the canonical Dropship channel only when it matches the trusted overview", async () => {
    await expect(
      readReturnPolicySaveResponse(response(), storeCommand(), {
        dropshipOmsChannelId: 99,
      }),
    ).resolves.toMatchObject({
      policy: { id: 4, channelId: 99, businessContext: "dropship" },
    });
  });

  it.each([
    { channelId: null },
    { channelId: 36 },
    { businessContext: "retail" },
    { businessContext: null },
    { vendorId: 7 },
    { storeConnectionId: 9 },
    { supersedesPolicyId: 2 },
  ])(
    "keeps a mismatched canonical response unconfirmed: %j",
    async (override) => {
      await expect(
        readReturnPolicySaveResponse(response(override), storeCommand(), {
          dropshipOmsChannelId: 99,
        }),
      ).rejects.toMatchObject({
        code: "RETURN_POLICY_SAVE_UNCONFIRMED",
        definitive: false,
      });
    },
  );

  it("never infers the Dropship channel from the response", async () => {
    await expect(
      readReturnPolicySaveResponse(response(), storeCommand()),
    ).rejects.toMatchObject({ code: "RETURN_POLICY_SAVE_UNCONFIRMED" });
    await expect(
      readReturnPolicySaveResponse(response(), storeCommand(), {
        dropshipOmsChannelId: 36,
      }),
    ).rejects.toMatchObject({ code: "RETURN_POLICY_SAVE_UNCONFIRMED" });
  });
});

function source(): ReturnShippingDraftSource {
  return {
    settings: null,
    providerConfigured: false,
    carriers: [],
    warehouses: [
      {
        id: 1,
        name: "Returns",
        address: {
          name: "Returns",
          addressLine1: "1 Test St",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          countryCode: "US",
        },
      },
    ],
    message: "Provider unavailable",
  };
}
function draft(): ReturnLabelSettingsDraft {
  return {
    warehouseId: "1",
    selectionMode: "fixed_service",
    carrierId: "se-test",
    serviceCode: "ground",
    carrierRules: [],
    contactName: "Receiving",
    contactPhone: "",
    enabled: false,
  };
}

describe("disabled policy shipping during carrier outages", () => {
  it("preserves valid fixed terms without requiring a live carrier while labels remain disabled", () => {
    const input = draft();
    const before = structuredClone(input);
    const result = returnLabelSettingsReadiness(input, source());
    expect(result.canSave).toBe(true);
    expect(result.issues).toEqual([]);
    expect(input).toEqual(before);
    expect(result.parsed.success && result.parsed.data).toMatchObject({
      enabled: false,
      carrierId: "se-test",
      serviceCode: "ground",
    });
  });

  it("preserves explicit automatic rules and decimal limits without enabling unavailable accounts", () => {
    const result = returnLabelSettingsReadiness(
      {
        ...draft(),
        selectionMode: "cheapest_eligible",
        carrierRules: [
          {
            carrierId: "se-test",
            enabled: true,
            serviceCodes: ["ground"],
            maxWeightLb: "20.000",
          },
        ],
      },
      source(),
    );
    expect(result.canSave).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.parsed.success && result.parsed.data).toMatchObject({
      enabled: false,
      carrierRules: [
        { carrierId: "se-test", serviceCodes: ["ground"], maxWeightLb: "20" },
      ],
    });
  });

  it("still requires verified provider and services when enabling labels", () => {
    const result = returnLabelSettingsReadiness(
      { ...draft(), enabled: true },
      source(),
    );
    expect(result.canSave).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { field: null, message: "Provider unavailable" },
        { field: "carrierId", message: "Choose an available return carrier." },
      ]),
    );
  });

  it.each(["0", "20.0001", "-1", "not a weight"])(
    "rejects malformed disabled rules (%s)",
    (maxWeightLb) => {
      expect(
        returnLabelSettingsReadiness(
          {
            ...draft(),
            selectionMode: "cheapest_eligible",
            carrierRules: [
              {
                carrierId: "se-test",
                enabled: true,
                serviceCodes: ["ground"],
                maxWeightLb,
              },
            ],
          },
          source(),
        ).canSave,
      ).toBe(false);
    },
  );

  it("still requires a current complete warehouse and receiving contact", () => {
    expect(
      returnLabelSettingsReadiness(draft(), { ...source(), warehouses: [] })
        .canSave,
    ).toBe(false);
    expect(
      returnLabelSettingsReadiness({ ...draft(), contactName: "" }, source())
        .canSave,
    ).toBe(false);
    expect(
      returnLabelSettingsReadiness({ ...draft(), serviceCode: "" }, source())
        .canSave,
    ).toBe(false);
    expect(
      returnLabelSettingsReadiness(
        { ...draft(), selectionMode: "cheapest_eligible" },
        source(),
      ).canSave,
    ).toBe(false);
  });
});
