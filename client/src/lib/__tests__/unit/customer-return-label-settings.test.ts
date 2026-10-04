import { describe, expect, it } from "vitest";
import { customerReturnLabelSettingsStateSchema } from "@shared/returns/customer-return-label.contract";
import {
  createReturnLabelSettingsDraft,
  parseReturnLabelSettingsDraft,
  refreshReturnLabelSettingsDraft,
  returnLabelConfigurationAvailable,
  returnLabelSettingsReadiness,
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
    control: { paused: false, version: 0 },
    settings: null,
    warehouses: [{ id: 1, name: "Main", address }],
    resolvedPolicy: {
      id: 2,
      name: "Retail",
      version: 1,
      returnWindowDays: 45,
      scopeKind: "channel_context",
    },
    policyIssue: null,
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
    contactName: "Return desk",
    enabled: true,
  };
}

describe("return label settings draft", () => {
  it("defaults the warehouse to commercial and saves the administrator's residential override", () => {
    const value = draft();
    expect(value.warehouseAddressType).toBe("commercial");
    value.carrierRules[0].enabled = true;
    value.carrierRules[0].serviceCodes = ["ground"];
    expect(parseReturnLabelSettingsDraft(value, 0)).toMatchObject({ success: true, data: { warehouseAddressType: "commercial" } });
    value.warehouseAddressType = "residential";
    expect(parseReturnLabelSettingsDraft(value, 0)).toMatchObject({ success: true, data: { warehouseAddressType: "residential" } });
    expect(refreshReturnLabelSettingsDraft(value, state()).warehouseAddressType).toBe("residential");
    const current = state();
    const parsed = parseReturnLabelSettingsDraft(value, 0);
    if (!parsed.success) throw parsed.error;
    const { expectedVersion: _version, ...saved } = parsed.data;
    current.settings = customerReturnLabelSettingsStateSchema.parse({ ...current,
      settings: { ...saved, version: 1, destinationAddress: current.warehouses[0].address } }).settings;
    expect(createReturnLabelSettingsDraft(current).warehouseAddressType).toBe("residential");
  });
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
  it("explains an invalid warehouse address type and prevents saving it", () => {
    const value = draft();
    value.carrierRules[0].enabled = true;
    value.carrierRules[0].serviceCodes = ["ground"];
    Object.assign(value, { warehouseAddressType: "unknown" });
    expect(returnLabelSettingsReadiness(value, state())).toMatchObject({ canSave: false,
      issues: [expect.objectContaining({ field: "warehouseAddressType" })] });
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

  it("keeps shipping validation independent of an unavailable return policy", () => {
    const catalog = state();
    catalog.resolvedPolicy = null;
    catalog.policyIssue = {
      code: "RETURN_POLICY_NOT_CONFIGURED",
      message: "No active return policy applies to this shop.",
    };
    const value = { ...completeDraft(), contactName: "  " };
    const result = returnLabelSettingsReadiness(value, catalog);
    expect(result.canSave).toBe(false);
    expect(result.issues).toEqual([
      { field: "contactName", message: "Enter the receiving contact name." },
    ]);
    value.contactName = "Receiving team";
    expect(returnLabelSettingsReadiness(value, catalog)).toMatchObject({
      canSave: true,
      issues: [],
    });
  });

  it("allows enabled shipping settings to save when the resolved policy is unsupported", () => {
    const catalog = state();
    catalog.policyIssue = {
      code: "RETURN_POLICY_UNSUPPORTED",
      message:
        "This policy uses a return destination that the portal does not support.",
    };
    const value = completeDraft();
    expect(returnLabelSettingsReadiness(value, catalog)).toMatchObject({
      canSave: true,
      issues: [],
      parsed: { success: true, data: { enabled: true } },
    });
  });

  it("clears each blocker only after the administrator makes a valid explicit choice", () => {
    const value = { ...completeDraft(), warehouseId: "", contactName: "" };
    expect(
      returnLabelSettingsReadiness(value, state()).issues.map(
        (issue) => issue.field,
      ),
    ).toEqual(["warehouseId", "contactName"]);
    value.contactName = "Returns team";
    expect(returnLabelSettingsReadiness(value, state()).issues).toEqual([
      {
        field: "warehouseId",
        message: "Choose a return warehouse with a complete U.S. address.",
      },
    ]);
    value.warehouseId = "1";
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

  it("preserves unsaved shipping choices when the resolved policy and carrier catalog change", () => {
    const value = {
      ...completeDraft(),
      contactPhone: "555-0100",
    };
    value.carrierRules[0].maxWeightLb = "15.5";
    const original = structuredClone(value);
    const catalog = state();
    catalog.resolvedPolicy = {
      id: 3,
      name: "New retail policy",
      version: 2,
      returnWindowDays: 60,
      scopeKind: "global",
    };
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
    expect(returnLabelSettingsReadiness(refreshed, catalog)).toMatchObject({
      canSave: true,
      issues: [],
    });
    expect(
      returnLabelSettingsReadiness(refreshed, catalog).parsed.data,
    ).not.toHaveProperty("policyId");
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
