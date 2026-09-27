import { describe, expect, it } from "vitest";
import { customerReturnLabelSettingsStateSchema } from "@shared/returns/customer-return-label.contract";
import {
  createReturnLabelSettingsDraft,
  parseReturnLabelSettingsDraft,
  returnLabelConfigurationAvailable,
  selectedReturnSettingsChannel,
} from "../../customer-return-label-settings";

function state() {
  const address = {
    name: "Returns",
    addressLine1: "1 Test St",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    countryCode: "US",
  };
  return customerReturnLabelSettingsStateSchema.parse({
    channelId: 36,
    providerConfigured: true,
    settings: null,
    warehouses: [{ id: 1, name: "Main", address }],
    policies: [{ id: 2, name: "Retail", version: 1 }],
    carriers: [
      {
        id: "se-usps",
        code: "stamps_com",
        name: "USPS account",
        services: [
          { code: "ground", name: "Ground" },
          { code: "priority", name: "Priority" },
        ],
      },
      {
        id: "se-ups",
        code: "ups",
        name: "UPS account",
        services: [{ code: "ground", name: "Ground" }],
      },
    ],
    message: null,
  });
}

function draft() {
  return {
    ...createReturnLabelSettingsDraft(state()),
    warehouseId: "1",
    policyId: "2",
    contactName: "Return desk",
    enabled: true,
  };
}

describe("return label settings draft", () => {
  it("starts new settings in automatic mode but allows no service until explicitly selected", () => {
    const value = draft();
    expect(value.selectionMode).toBe("cheapest_eligible");
    expect(value.carrierRules).toEqual([
      {
        carrierId: "se-usps",
        enabled: false,
        serviceCodes: [],
        maxWeightLb: "20",
      },
      {
        carrierId: "se-ups",
        enabled: false,
        serviceCodes: [],
        maxWeightLb: "",
      },
    ]);
    expect(parseReturnLabelSettingsDraft(value, 0).success).toBe(false);
    value.carrierRules[0].enabled = true;
    expect(parseReturnLabelSettingsDraft(value, 0).success).toBe(false);
  });

  it("sends only explicit allowed services, exact decimal business caps, and the optimistic version", () => {
    const value = draft();
    value.carrierRules[0] = {
      ...value.carrierRules[0],
      enabled: true,
      serviceCodes: ["ground"],
      maxWeightLb: "20.000",
    };
    value.carrierRules[1] = {
      ...value.carrierRules[1],
      enabled: true,
      serviceCodes: ["ground"],
      maxWeightLb: "",
    };
    const before = structuredClone(value);
    const parsed = parseReturnLabelSettingsDraft(value, 4);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      expectedVersion: 4,
      selectionMode: "cheapest_eligible",
      carrierId: null,
      serviceCode: null,
      carrierRules: [
        { carrierId: "se-usps", serviceCodes: ["ground"], maxWeightLb: "20" },
        { carrierId: "se-ups", serviceCodes: ["ground"], maxWeightLb: null },
      ],
    });
    expect(returnLabelConfigurationAvailable(parsed.data, state())).toBe(true);
    expect(value).toEqual(before);
  });

  it.each(["0", "-1", "NaN", "Infinity", "20.0001", "1e2", "99999999999"])(
    "rejects an invalid cap %s",
    (maxWeightLb) => {
      const value = draft();
      value.carrierRules[0] = {
        ...value.carrierRules[0],
        enabled: true,
        serviceCodes: ["ground"],
        maxWeightLb,
      };
      expect(parseReturnLabelSettingsDraft(value, 0).success).toBe(false);
    },
  );

  it("preserves an existing fixed service until the administrator changes modes", () => {
    const current = state();
    current.settings = customerReturnLabelSettingsStateSchema.parse({
      ...current,
      settings: {
        version: 8,
        enabled: true,
        warehouseId: 1,
        policyId: 2,
        carrierId: "se-ups",
        serviceCode: "ground",
        contactName: "Return desk",
        contactPhone: null,
        destinationAddress: current.warehouses[0].address,
      },
    }).settings;
    const value = createReturnLabelSettingsDraft(current);
    const parsed = parseReturnLabelSettingsDraft(value, 8);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({
      selectionMode: "fixed_service",
      carrierId: "se-ups",
      serviceCode: "ground",
      carrierRules: [],
    });
    expect(value.carrierRules.every((rule) => !rule.enabled)).toBe(true);
  });

  it("keeps disconnected saved accounts and services visible rather than silently dropping authority", () => {
    const current = state();
    current.settings = customerReturnLabelSettingsStateSchema.parse({
      ...current,
      settings: {
        version: 8,
        enabled: true,
        warehouseId: 1,
        policyId: 2,
        selectionMode: "cheapest_eligible",
        carrierId: null,
        serviceCode: null,
        carrierRules: [
          {
            carrierId: "se-missing",
            serviceCodes: ["ground"],
            maxWeightLb: null,
          },
        ],
        contactName: "Return desk",
        contactPhone: null,
        destinationAddress: current.warehouses[0].address,
      },
    }).settings;
    const value = createReturnLabelSettingsDraft(current);
    expect(value.carrierRules.at(-1)).toEqual({
      carrierId: "se-missing",
      enabled: true,
      serviceCodes: ["ground"],
      maxWeightLb: "",
    });
    const parsed = parseReturnLabelSettingsDraft(value, 8);
    expect(parsed.success).toBe(true);
    expect(
      parsed.success && returnLabelConfigurationAvailable(parsed.data, current),
    ).toBe(false);
  });

  it("does not overwrite a saved USPS limit or automatically allow newly discovered services", () => {
    const current = state();
    current.settings = customerReturnLabelSettingsStateSchema.parse({
      ...current,
      settings: {
        version: 8,
        enabled: true,
        warehouseId: 1,
        policyId: 2,
        selectionMode: "cheapest_eligible",
        carrierId: null,
        serviceCode: null,
        carrierRules: [
          {
            carrierId: "se-usps",
            serviceCodes: ["ground"],
            maxWeightLb: "12.5",
          },
        ],
        contactName: "Return desk",
        contactPhone: null,
        destinationAddress: current.warehouses[0].address,
      },
    }).settings;
    expect(createReturnLabelSettingsDraft(current).carrierRules[0]).toEqual({
      carrierId: "se-usps",
      enabled: true,
      serviceCodes: ["ground"],
      maxWeightLb: "12.5",
    });
  });
});

describe("return settings shop link", () => {
  const shops = [{ channelId: 36 }, { channelId: 37 }];
  it("requires an explicit choice with multiple shops, and auto-selects a single known shop", () => {
    expect(selectedReturnSettingsChannel("", shops)).toBe("");
    expect(selectedReturnSettingsChannel("", [shops[0]])).toBe("36");
    expect(selectedReturnSettingsChannel("channelId=37", shops)).toBe("37");
  });
  it.each([
    "channelId=0",
    "channelId=999",
    "channelId=-1",
    "channelId=36&channelId=37",
    "channelId=https://evil.test",
    "channelId=9007199254740992",
  ])("rejects an invalid or unavailable shop selection %s", (search) => {
    expect(() => selectedReturnSettingsChannel(search, shops)).toThrow(
      "unavailable",
    );
  });
});
