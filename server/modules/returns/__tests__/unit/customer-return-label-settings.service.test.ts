import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReturnPolicy } from "@shared/schema";
import type { CustomerReturnLabelSettingsInput } from "@shared/returns/customer-return-label.contract";
import { CustomerReturnIntakeError } from "../../application/customer-return-intake.ports";
import {
  CustomerReturnLabelSettingsService,
  isPortalReturnPolicy,
  warehouseLabelAddress,
  type CustomerReturnLabelSettingsDependencies,
  type CustomerReturnSettingsStore,
  type ReturnLabelWarehouse,
} from "../../application/customer-return-label-settings.service";
import {
  labelAddress,
  labelPolicy,
  labelSettings,
} from "../support/label-fixtures";

const CHANNEL = 36;
const NOW = new Date("2026-09-26T12:00:00Z");

function policy(overrides: Partial<ReturnPolicy> = {}): ReturnPolicy {
  return {
    ...labelPolicy,
    businessContext: "retail",
    channelId: CHANNEL,
    vendorId: null,
    storeConnectionId: null,
    status: "active",
    notes: null,
    supersedesPolicyId: null,
    createdBy: "admin-1",
    retiredBy: null,
    retiredAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function warehouse(
  overrides: Partial<ReturnLabelWarehouse> = {},
): ReturnLabelWarehouse {
  return {
    id: 1,
    name: "Test Warehouse",
    address: "1 Test Street",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
    isActive: 1,
    ...overrides,
  };
}

function settingsInput(
  overrides: Partial<CustomerReturnLabelSettingsInput> = {},
): CustomerReturnLabelSettingsInput {
  return {
    expectedVersion: 1,
    enabled: true,
    warehouseId: 1,
    policyId: 1,
    carrierId: "se-123",
    serviceCode: "ups_ground",
    contactName: "Test Warehouse",
    contactPhone: null,
    ...overrides,
  };
}

describe("private return label settings service", () => {
  let store: {
    read: ReturnType<typeof vi.fn<CustomerReturnSettingsStore["read"]>>;
    catalog: ReturnType<typeof vi.fn<CustomerReturnSettingsStore["catalog"]>>;
    save: ReturnType<typeof vi.fn<CustomerReturnSettingsStore["save"]>>;
  };
  let authorizeChannel: ReturnType<
    typeof vi.fn<CustomerReturnLabelSettingsDependencies["authorizeChannel"]>
  >;
  let capabilities: ReturnType<
    typeof vi.fn<CustomerReturnLabelSettingsDependencies["capabilities"]>
  >;
  let service: CustomerReturnLabelSettingsService;

  beforeEach(() => {
    store = {
      read: vi.fn(async () => structuredClone(labelSettings)),
      catalog: vi.fn(async () => ({
        warehouses: [warehouse()],
        policies: [policy()],
      })),
      save: vi.fn(async () => ({
        ...structuredClone(labelSettings),
        version: 2,
      })),
    };
    authorizeChannel = vi.fn(async () => undefined);
    capabilities = vi.fn(async () => ({
      configured: true,
      carriers: [
        {
          id: "se-123",
          name: "Test carrier",
          services: [{ code: "ups_ground", name: "Ground" }],
        },
      ],
    }));
    service = new CustomerReturnLabelSettingsService({
      store,
      authorizeChannel,
      capabilities,
      now: () => NOW,
    });
  });

  it.each(["get", "save", "requireEnabled"] as const)(
    "authorizes the requested shop before %s reads or writes",
    async (operation) => {
      const denied = new CustomerReturnIntakeError(
        "RETURN_LIVE_SHOP_UNAVAILABLE",
        "This shop is unavailable.",
        403,
      );
      authorizeChannel.mockRejectedValue(denied);
      const result =
        operation === "get"
          ? service.get(104)
          : operation === "save"
            ? service.save(104, settingsInput(), "admin-1")
            : service.requireEnabled(104, 1);
      await expect(result).rejects.toBe(denied);
      expect(authorizeChannel).toHaveBeenCalledWith(104);
      expect(store.read).not.toHaveBeenCalled();
      expect(store.catalog).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
      expect(capabilities).not.toHaveBeenCalled();
    },
  );

  it("does not infer a warehouse or policy when settings have not been explicitly saved", async () => {
    store.read.mockResolvedValue(null);
    const state = await service.get(CHANNEL);
    expect(state.settings).toBeNull();
    expect(state.warehouses).toEqual([
      { id: 1, name: "Test Warehouse", address: labelAddress },
    ]);
    expect(state.policies).toEqual([
      { id: 1, name: labelPolicy.name, version: 1 },
    ]);
    await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({
      code: "RETURN_LABEL_SETTINGS_CHANGED",
    });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("presents inactive warehouses as unavailable and incomplete or foreign addresses as null", async () => {
    store.catalog.mockResolvedValue({
      warehouses: [
        warehouse(),
        warehouse({ id: 2, isActive: 0 }),
        warehouse({ id: 3, address: null }),
        warehouse({ id: 4, country: "CA" }),
      ],
      policies: [policy()],
    });
    expect((await service.get(CHANNEL)).warehouses).toEqual([
      { id: 1, name: "Test Warehouse", address: labelAddress },
      { id: 3, name: "Test Warehouse", address: null },
      { id: 4, name: "Test Warehouse", address: null },
    ]);
  });

  it.each([null, "retail"])(
    "accepts applicable 365-day policies with %s business context",
    async (businessContext) => {
      store.catalog.mockResolvedValue({
        warehouses: [warehouse()],
        policies: [policy({ businessContext, channelId: null })],
      });
      const result = await service.requireEnabled(CHANNEL, 1);
      expect(result.settings).toEqual(labelSettings);
      expect(result.operationalPolicy).toEqual({
        id: 1,
        version: 1,
        snapshot: labelPolicy,
      });
    },
  );

  const invalidPolicies: [string, Partial<ReturnPolicy>][] = [
    ["retired", { status: "retired" }],
    ["wholesale", { businessContext: "wholesale" }],
    ["another shop", { channelId: 104 }],
    ["vendor scoped", { vendorId: 2 }],
    ["store scoped", { storeConnectionId: 2 }],
    ["30-day window", { returnWindowDays: 30 }],
    ["zero-day window", { returnWindowDays: 0 }],
    ["vendor destination", { returnDestination: "vendor" }],
    ["vendor approval", { approvalAuthority: "vendor" }],
    ["vendor labels", { labelProvider: "vendor" }],
    ["customer postage", { returnShippingPayer: "customer" }],
    ["marketplace refund", { customerRefundAuthority: "marketplace" }],
    ["vendor inspection", { inspectionOwner: "vendor" }],
    ["vendor settlement", { vendorSettlementTrigger: "inspection_approved" }],
  ];
  it.each(invalidPolicies)(
    "excludes %s policy from both configuration choices and current enablement",
    async (_name, overrides) => {
      const invalidPolicy = policy(overrides);
      expect(isPortalReturnPolicy(invalidPolicy, CHANNEL)).toBe(false);
      store.catalog.mockResolvedValue({
        warehouses: [warehouse()],
        policies: [invalidPolicy],
      });
      expect((await service.get(CHANNEL)).policies).toEqual([]);
      await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({
        code: "RETURN_LABEL_CONFIGURATION_UNAVAILABLE",
      });
    },
  );

  it.each([
    { warehouses: [] },
    { warehouses: [warehouse({ id: 2 })] },
    { warehouses: [warehouse({ isActive: 0 })] },
    { warehouses: [warehouse({ country: "CA" })] },
  ])(
    "requires the explicitly configured active U.S. warehouse %#",
    async ({ warehouses }) => {
      store.catalog.mockResolvedValue({ warehouses, policies: [policy()] });
      await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({
        code: "RETURN_LABEL_CONFIGURATION_UNAVAILABLE",
      });
      expect(capabilities).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "version"])(
    "rejects %s settings before catalog/provider inspection",
    async (kind) => {
      store.read.mockResolvedValue({
        ...labelSettings,
        ...(kind === "disabled" ? { enabled: false } : { version: 2 }),
      });
      await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({
        code: "RETURN_LABEL_SETTINGS_CHANGED",
      });
      expect(store.catalog).not.toHaveBeenCalled();
      expect(capabilities).not.toHaveBeenCalled();
    },
  );

  it("rereads enablement and exact version rather than caching a previously allowed configuration", async () => {
    await service.requireEnabled(CHANNEL, 1);
    store.read.mockResolvedValue({
      ...labelSettings,
      version: 2,
      enabled: false,
    });
    await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({
      code: "RETURN_LABEL_SETTINGS_CHANGED",
    });
    expect(authorizeChannel.mock.calls).toEqual([[CHANNEL], [CHANNEL]]);
    expect(store.read.mock.calls).toEqual([[CHANNEL], [CHANNEL]]);
  });

  it.each([
    { configured: false, carriers: [] },
    { configured: true, carriers: [] },
    {
      configured: true,
      carriers: [
        {
          id: "se-other",
          name: "Other",
          services: [{ code: "ups_ground", name: "Ground" }],
        },
      ],
    },
    {
      configured: true,
      carriers: [
        {
          id: "se-123",
          name: "Test",
          services: [{ code: "ups_express", name: "Express" }],
        },
      ],
    },
  ])(
    "rejects unavailable or mismatched carrier/service for enabling and current use %#",
    async (value) => {
      capabilities.mockResolvedValue(value);
      await expect(
        service.save(CHANNEL, settingsInput(), "admin-1"),
      ).rejects.toMatchObject({ code: "RETURN_LABEL_SERVICE_UNAVAILABLE" });
      await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({
        code: "RETURN_LABEL_SERVICE_UNAVAILABLE",
      });
      expect(store.save).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { ...settingsInput(), expectedVersion: -1 },
    { ...settingsInput(), warehouseId: 0 },
    { ...settingsInput(), policyId: null },
    { ...settingsInput(), carrierId: "not-a-provider-id" },
    { ...settingsInput(), serviceCode: "arbitrary URL" },
    { ...settingsInput(), contactName: "\n" },
    { ...settingsInput(), destinationAddress: labelAddress },
  ])("rejects malformed settings without persistence %#", async (value) => {
    await expect(service.save(CHANNEL, value, "admin-1")).rejects.toMatchObject(
      { code: "RETURN_LABEL_SETTINGS_INVALID", status: 400 },
    );
    expect(store.save).not.toHaveBeenCalled();
    expect(capabilities).not.toHaveBeenCalled();
  });

  it("passes version CAS, actor, and injected time to persistence, then returns the persisted state", async () => {
    const input = settingsInput({ expectedVersion: 7 });
    const before = structuredClone(input);
    const persisted = { ...labelSettings, version: 8 };
    store.save.mockResolvedValue(persisted);
    store.read.mockResolvedValue(persisted);
    expect((await service.save(CHANNEL, input, "admin-7")).settings).toEqual(
      persisted,
    );
    expect(store.save).toHaveBeenCalledExactlyOnceWith(
      CHANNEL,
      input,
      "admin-7",
      NOW,
    );
    expect(store.read).toHaveBeenCalledExactlyOnceWith(CHANNEL);
    expect(input).toEqual(before);
  });

  it.each([
    "RETURN_LABEL_SETTINGS_CHANGED",
    "RETURN_LABEL_CONFIGURATION_INVALID",
  ])(
    "preserves persistence %s without a second write or success read",
    async (code) => {
      const failure = new CustomerReturnIntakeError(
        code,
        "Reload the saved configuration.",
        409,
      );
      store.save.mockRejectedValue(failure);
      await expect(
        service.save(CHANNEL, settingsInput(), "admin-1"),
      ).rejects.toBe(failure);
      expect(store.save).toHaveBeenCalledTimes(1);
      expect(store.read).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "outage"])(
    "allows an unchanged pause when the provider is %s",
    async (kind) => {
      if (kind === "outage")
        capabilities.mockRejectedValue(new Error("secret carrier credentials"));
      else capabilities.mockResolvedValue({ configured: false, carriers: [] });
      const paused = { ...labelSettings, enabled: false, version: 2 };
      store.save.mockResolvedValue(paused);
      store.read.mockResolvedValue(paused);
      const input = settingsInput({ enabled: false });
      const result = await service.save(CHANNEL, input, "admin-1");
      expect(store.save).toHaveBeenCalledExactlyOnceWith(
        CHANNEL,
        input,
        "admin-1",
        NOW,
      );
      expect(result.settings).toEqual(paused);
      expect(result.providerConfigured).toBe(false);
      expect(result.message).toMatch(
        kind === "outage"
          ? /could not be verified/
          : /Configure the ShipStation/,
      );
      expect(JSON.stringify(result)).not.toContain("secret");
      // The sole capability read is the post-save presentation; pause requires no provider operation.
      expect(capabilities).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["address", "city", "state", "postalCode"] as const)(
    "does not synthesize a missing warehouse %s",
    (key) => {
      expect(
        warehouseLabelAddress(warehouse({ [key]: null }), "Return desk", null),
      ).toBeNull();
    },
  );

  it("uses explicit return contact fields in a complete U.S. warehouse address", () => {
    expect(
      warehouseLabelAddress(warehouse(), "Return desk", "512-555-0100"),
    ).toEqual({
      ...labelAddress,
      name: "Return desk",
      phone: "512-555-0100",
    });
  });
});
