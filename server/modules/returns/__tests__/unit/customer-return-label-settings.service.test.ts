import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReturnPolicy } from "@shared/schema";
import { CustomerReturnIntakeError } from "../../application/customer-return-intake.ports";
import { CustomerReturnLabelSettingsService, warehouseLabelAddress, type CustomerReturnSettingsStore, type ReturnLabelWarehouse } from "../../application/customer-return-label-settings.service";
import { labelAddress, labelActivePolicy, labelSettings } from "../support/label-fixtures";

const CHANNEL = 36;
const NOW = new Date("2026-09-26T12:00:00Z");
function warehouse(overrides: Partial<ReturnLabelWarehouse> = {}): ReturnLabelWarehouse {
  return { id: 1, name: "Test Warehouse", address: "1 Test Street", city: "Austin", state: "TX", postalCode: "78701", country: "US", isActive: 1, ...overrides };
}
describe("policy-owned return label settings", () => {
  const store = {
    read: vi.fn<CustomerReturnSettingsStore["read"]>(), readAccepted: vi.fn<CustomerReturnSettingsStore["readAccepted"]>(),
    readControl: vi.fn<CustomerReturnSettingsStore["readControl"]>(), saveControl: vi.fn<CustomerReturnSettingsStore["saveControl"]>(),
    catalog: vi.fn<CustomerReturnSettingsStore["catalog"]>(),
  };
  const authorizeChannel = vi.fn(async (_channelId: number) => undefined);
  const capabilities = vi.fn(async () => ({ configured: true, carriers: [{ id: "se-123", code: "ups", name: "UPS", services: [{ code: "ups_ground", name: "Ground" }] }] }));
  const service = new CustomerReturnLabelSettingsService({ store, authorizeChannel, capabilities, now: () => NOW });
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeChannel.mockResolvedValue(undefined);
    store.read.mockResolvedValue({ ...labelSettings, policyId: 1 });
    store.readAccepted.mockResolvedValue({ ...labelSettings, policyId: 1 });
    store.readControl.mockResolvedValue({ paused: false, version: 0 });
    store.saveControl.mockResolvedValue(undefined);
    store.catalog.mockResolvedValue({ warehouses: [warehouse()], policies: [labelActivePolicy()] });
    capabilities.mockResolvedValue({ configured: true, carriers: [{ id: "se-123", code: "ups", name: "UPS", services: [{ code: "ups_ground", name: "Ground" }] }] });
  });
  it.each(["get", "save", "control", "requireEnabled", "accepted"])("authorizes before %s reads or writes", async operation => {
    const denied = new CustomerReturnIntakeError("DENIED", "Denied", 403);
    authorizeChannel.mockRejectedValue(denied);
    const result = operation === "get" ? service.get(CHANNEL) : operation === "save" ? service.save(CHANNEL, {}, "admin")
      : operation === "control" ? service.control(CHANNEL, { paused: true, expectedVersion: 0 }, "admin")
      : operation === "accepted" ? service.requireAcceptedShippingEnabled(CHANNEL, 51) : service.requireEnabled(CHANNEL, 1);
    await expect(result).rejects.toBe(denied);
    for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled();
    expect(capabilities).not.toHaveBeenCalled();
  });
  it("publishes matching policy shipping, applied policy and independent pause control", async () => {
    expect(await service.get(CHANNEL)).toMatchObject({ settings: { ...labelSettings, policyId: 1 }, control: { paused: false, version: 0 }, resolvedPolicy: { id: 1, version: 1 } });
  });
  it.each([null, { ...labelSettings, policyId: 99 }])("suppresses missing or mismatched shipping %#", async settings => {
    store.read.mockResolvedValue(settings);
    expect((await service.get(CHANNEL)).settings).toBeNull();
    await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({ code: "RETURN_LABEL_SETTINGS_CHANGED" });
  });
  it.each([{}, { enabled: true }, labelSettings])("rejects the old configuration write path %#", async raw => {
    await expect(service.save(CHANNEL, raw, "admin")).rejects.toMatchObject({ code: "RETURN_LABEL_EDIT_POLICY", status: 409 });
    expect(store.saveControl).not.toHaveBeenCalled(); expect(capabilities).not.toHaveBeenCalled();
  });
  it("new intake uses the exact resolved policy identity", async () => {
    expect(await service.requireEnabled(CHANNEL, 1)).toMatchObject({ settings: { policyId: 1 }, operationalPolicy: { id: 1, version: 1 } });
    store.catalog.mockResolvedValue({ warehouses: [warehouse()], policies: [labelActivePolicy({ id: 2 })] });
    await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({ code: "RETURN_LABEL_SETTINGS_CHANGED" });
  });
  it("accepted returns retain original shipping after policy replacement or archive", async () => {
    store.read.mockResolvedValue({ ...labelSettings, policyId: 2, version: 2, warehouseId: 2 });
    store.catalog.mockResolvedValue({ warehouses: [warehouse()], policies: [] });
    expect(await service.requireAcceptedShippingEnabled(CHANNEL, 51)).toEqual({ ...labelSettings, policyId: 1 });
    expect(store.readAccepted).toHaveBeenCalledWith(CHANNEL, 51); expect(store.read).not.toHaveBeenCalled();
  });
  it.each([null, { ...labelSettings, enabled: false }])("blocks missing or disabled accepted shipping %#", async settings => {
    store.readAccepted.mockResolvedValue(settings);
    await expect(service.requireAcceptedShippingEnabled(CHANNEL, 51)).rejects.toMatchObject({ code: "RETURN_LABEL_SETTINGS_CHANGED" });
  });
  it("a channel pause stops new intake and accepted-return purchases", async () => {
    store.readControl.mockResolvedValue({ paused: true, version: 4 });
    await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({ code: "RETURN_LABEL_SETTINGS_CHANGED" });
    await expect(service.requireAcceptedShippingEnabled(CHANNEL, 51)).rejects.toMatchObject({ code: "RETURN_LABEL_SETTINGS_CHANGED" });
    expect(capabilities).not.toHaveBeenCalled();
  });
  it("passes pause CAS, actor and clock before any provider read, including outages", async () => {
    capabilities.mockRejectedValue(new Error("secret provider credential"));
    store.readControl.mockResolvedValue({ paused: true, version: 1 });
    const result = await service.control(CHANNEL, { paused: true, expectedVersion: 0 }, "pause-admin");
    expect(store.saveControl).toHaveBeenCalledExactlyOnceWith(CHANNEL, { paused: true, expectedVersion: 0 }, "pause-admin", NOW);
    expect(result.control).toEqual({ paused: true, version: 1 }); expect(JSON.stringify(result)).not.toContain("secret");
    expect(capabilities.mock.invocationCallOrder[0]).toBeGreaterThan(store.saveControl.mock.invocationCallOrder[0]);
  });
  it.each([{}, { paused: "yes", expectedVersion: 1 }, { paused: true, expectedVersion: -1 }, { paused: true, expectedVersion: 0, enabled: true }])("rejects malformed control requests %#", async value => {
    await expect(service.control(CHANNEL, value, "admin")).rejects.toMatchObject({ code: "RETURN_LABEL_CONTROL_INVALID", status: 400 });
    expect(store.saveControl).not.toHaveBeenCalled();
  });
  it("preserves control conflicts without a second write or success read", async () => {
    const error = new CustomerReturnIntakeError("RETURN_LABEL_CONTROL_CHANGED", "Changed"); store.saveControl.mockRejectedValueOnce(error);
    await expect(service.control(CHANNEL, { paused: true, expectedVersion: 1 }, "admin")).rejects.toBe(error);
    expect(store.saveControl).toHaveBeenCalledTimes(1); expect(store.read).not.toHaveBeenCalled();
  });
  const invalidPolicies: Partial<ReturnPolicy>[] = [{ status: "retired" }, { businessContext: "wholesale" }, { channelId: 104 }, { vendorId: 2 }, { storeConnectionId: 2 }, { returnWindowDays: 0 }, { returnDestination: "vendor" }, { approvalAuthority: "vendor" }, { labelProvider: "vendor" }, { returnShippingPayer: "customer" }];
  it.each(invalidPolicies)("blocks incompatible resolved policy %#", async overrides => {
    store.catalog.mockResolvedValue({ warehouses: [warehouse()], policies: [labelActivePolicy(overrides)] });
    await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({ code: expect.stringMatching(/^RETURN_PORTAL_POLICY_/) });
  });
  it.each([{ warehouses: [] }, { warehouses: [warehouse({ id: 2 })] }, { warehouses: [warehouse({ isActive: 0 })] }, { warehouses: [warehouse({ country: "CA" })] }])("requires an active domestic warehouse %#", async ({ warehouses }) => {
    store.catalog.mockResolvedValue({ warehouses, policies: [labelActivePolicy()] });
    await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({ code: "RETURN_LABEL_CONFIGURATION_UNAVAILABLE" }); expect(capabilities).not.toHaveBeenCalled();
  });
  it.each([{ ...labelSettings, enabled: false }, { ...labelSettings, version: 2 }])("rejects disabled or stale shipping %#", async settings => {
    store.read.mockResolvedValue(settings);
    await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({ code: "RETURN_LABEL_SETTINGS_CHANGED" }); expect(capabilities).not.toHaveBeenCalled();
  });
  it.each([{ configured: false, carriers: [] }, { configured: true, carriers: [] }, { configured: true, carriers: [{ id: "se-123", code: "ups", name: "UPS", services: [{ code: "ups_air", name: "Air" }] }] }])("rechecks connected carriers and services %#", async value => {
    capabilities.mockResolvedValue(value); await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({ code: "RETURN_LABEL_SERVICE_UNAVAILABLE" });
  });
  it("checks every allowed automatic carrier and service", async () => {
    store.read.mockResolvedValue({ ...labelSettings, policyId: 1, selectionMode: "cheapest_eligible", carrierId: null, serviceCode: null, carrierRules: [{ carrierId: "se-123", serviceCodes: ["ups_ground"], maxWeightLb: null }, { carrierId: "se-456", serviceCodes: ["usps_ground_advantage"], maxWeightLb: "20" }] });
    await expect(service.requireEnabled(CHANNEL, 1)).rejects.toMatchObject({ code: "RETURN_LABEL_SERVICE_UNAVAILABLE" });
    capabilities.mockResolvedValue({ configured: true, carriers: [{ id: "se-123", code: "ups", name: "UPS", services: [{ code: "ups_ground", name: "Ground" }] }, { id: "se-456", code: "usps", name: "USPS", services: [{ code: "usps_ground_advantage", name: "Ground Advantage" }] }] });
    expect((await service.requireEnabled(CHANNEL, 1)).settings.selectionMode).toBe("cheapest_eligible");
  });
  it.each(["address", "city", "state", "postalCode"] as const)("never synthesizes missing warehouse %s", key => {
    expect(warehouseLabelAddress(warehouse({ [key]: null }), "Return desk", null)).toBeNull();
  });
  it("uses explicit return contact fields", () => {
    expect(warehouseLabelAddress(warehouse(), "Return desk", "512-555-0100")).toEqual({ ...labelAddress, name: "Return desk", phone: "512-555-0100" });
  });
});
