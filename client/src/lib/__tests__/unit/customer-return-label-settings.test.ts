import { describe, expect, it } from "vitest";
import { customerReturnLabelSettingsStateSchema } from "@shared/returns/customer-return-label.contract";
import {
  createReturnLabelSettingsDraft,
  parseReturnLabelSettingsDraft,
  refreshReturnLabelSettingsDraft,
  returnLabelConfigurationAvailable,
  returnLabelSettingsReadiness,
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

describe("return label settings readiness", () => {
  function completeDraft() {
    const value = draft();
    value.carrierRules[0].enabled = true;
    value.carrierRules[0].serviceCodes = ["ground"];
    return value;
  }

  it("explains missing policy and contact even after carrier choices are complete", () => {
    const catalog = state();
    catalog.policies = [];
    const value = { ...completeDraft(), policyId: "", contactName: "  " };
    const result = returnLabelSettingsReadiness(value, catalog);
    expect(result.canSave).toBe(false);
    expect(result.issues).toEqual([
      {
        field: "policyId",
        message:
          "No compatible active return policy is available for this shop.",
      },
      { field: "contactName", message: "Enter the receiving contact name." },
    ]);
  });

  it("clears each blocker only after the administrator makes a valid explicit choice", () => {
    const value = { ...completeDraft(), policyId: "", contactName: "" };
    expect(
      returnLabelSettingsReadiness(value, state()).issues.map(
        (issue) => issue.field,
      ),
    ).toEqual(["policyId", "contactName"]);
    value.contactName = "Returns team";
    expect(returnLabelSettingsReadiness(value, state()).issues).toEqual([
      { field: "policyId", message: "Choose a return policy." },
    ]);
    value.policyId = "2";
    expect(returnLabelSettingsReadiness(value, state())).toMatchObject({
      canSave: true,
      issues: [],
    });
  });

  it.each([
    { field: "warehouseId", value: "", message: "Choose a return warehouse" },
    {
      field: "warehouseId",
      value: "99",
      message: "selected warehouse is unavailable",
    },
    {
      field: "policyId",
      value: "99",
      message: "selected return policy is no longer available",
    },
    {
      field: "contactName",
      value: "Return\nteam",
      message: "without control characters",
    },
    { field: "contactPhone", value: "123\n456", message: "phone number" },
  ] as const)(
    "identifies an invalid $field without permitting a save",
    ({ field, value, message }) => {
      const result = returnLabelSettingsReadiness(
        { ...completeDraft(), [field]: value },
        state(),
      );
      expect(result.canSave).toBe(false);
      expect(result.issues).toEqual([
        { field, message: expect.stringContaining(message) },
      ]);
    },
  );

  it("permits optional phone and an explicitly disabled configuration", () => {
    const result = returnLabelSettingsReadiness(
      { ...completeDraft(), enabled: false, contactPhone: " " },
      state(),
    );
    expect(result).toMatchObject({
      canSave: true,
      issues: [],
      parsed: { success: true, data: { enabled: false, contactPhone: null } },
    });
  });

  it("explains provider and warehouse availability without changing the draft", () => {
    const catalog = state();
    catalog.providerConfigured = false;
    catalog.message = "Return services could not be verified.";
    catalog.warehouses[0].address = null;
    const value = completeDraft();
    const before = structuredClone(value);
    const result = returnLabelSettingsReadiness(value, catalog);
    expect(result.canSave).toBe(false);
    expect(result.issues).toEqual([
      { field: null, message: catalog.message },
      {
        field: "warehouseId",
        message: expect.stringContaining("complete U.S. address"),
      },
    ]);
    expect(value).toEqual(before);
  });

  it("explains enabled carrier rules with missing services, unavailable accounts, and invalid caps", () => {
    const value = completeDraft();
    value.carrierRules[0].serviceCodes = [];
    expect(returnLabelSettingsReadiness(value, state()).issues).toEqual([
      {
        field: "carrierRules",
        message: expect.stringContaining(
          "Choose at least one return service for USPS account",
        ),
      },
    ]);
    value.carrierRules[0].serviceCodes = ["unavailable"];
    expect(returnLabelSettingsReadiness(value, state()).issues).toEqual([
      {
        field: "carrierRules",
        message: expect.stringContaining("Remove unavailable return services"),
      },
    ]);
    value.carrierRules[0].serviceCodes = ["ground"];
    value.carrierRules[0].maxWeightLb = "20lb";
    expect(returnLabelSettingsReadiness(value, state()).issues).toEqual([
      {
        field: "carrierRules",
        message: expect.stringContaining("Enter a positive maximum weight"),
      },
    ]);
    value.carrierRules[0].maxWeightLb = "20";
    const catalog = state();
    catalog.carriers = catalog.carriers.filter(
      (carrier) => carrier.id !== "se-usps",
    );
    expect(returnLabelSettingsReadiness(value, catalog).issues).toEqual([
      {
        field: "carrierRules",
        message: expect.stringContaining(
          "allowed account se-usps is unavailable",
        ),
      },
    ]);
  });

  it("keeps fixed-service availability separate from automatic rules", () => {
    const value = {
      ...completeDraft(),
      selectionMode: "fixed_service" as const,
      carrierId: "se-ups",
      serviceCode: "priority",
    };
    expect(returnLabelSettingsReadiness(value, state()).issues).toEqual([
      { field: "serviceCode", message: "Choose an available return service." },
    ]);
    value.serviceCode = "ground";
    expect(returnLabelSettingsReadiness(value, state())).toMatchObject({
      canSave: true,
      issues: [],
    });
  });

  it("preserves unsaved intent across catalog refresh without selecting a newly created policy or carrier", () => {
    const value = {
      ...completeDraft(),
      policyId: "",
      contactPhone: "555-0100",
    };
    value.carrierRules[0].maxWeightLb = "15.5";
    const original = structuredClone(value);
    const catalog = state();
    catalog.policies = [{ id: 3, name: "New retail policy", version: 1 }];
    catalog.carriers.push({
      id: "se-new",
      code: "usps",
      name: "New account",
      services: [{ code: "ground", name: "Ground" }],
    });
    const refreshed = refreshReturnLabelSettingsDraft(value, catalog);
    expect(refreshed).toEqual({
      ...value,
      carrierRules: [
        ...value.carrierRules,
        {
          carrierId: "se-new",
          enabled: false,
          serviceCodes: [],
          maxWeightLb: "20",
        },
      ],
    });
    expect(returnLabelSettingsReadiness(refreshed, catalog).issues).toEqual([
      { field: "policyId", message: "Choose a return policy." },
    ]);
    expect(value).toEqual(original);
    expect(refreshed.carrierRules[0].serviceCodes).not.toBe(
      value.carrierRules[0].serviceCodes,
    );
  });

  it("retains removed selected services after refresh so the administrator must resolve them", () => {
    const value = completeDraft();
    const catalog = state();
    catalog.carriers[0].services = [];
    const refreshed = refreshReturnLabelSettingsDraft(value, catalog);
    expect(refreshed.carrierRules[0].serviceCodes).toEqual(["ground"]);
    expect(returnLabelSettingsReadiness(refreshed, catalog).canSave).toBe(
      false,
    );
    expect(
      returnLabelSettingsReadiness(refreshed, catalog).issues[0].message,
    ).toContain("Remove unavailable return services");
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
