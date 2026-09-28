import { describe, expect, it, vi } from "vitest";
import { PostgresCustomerReturnSettingsStore } from "../../infrastructure/customer-return-label-settings.repository";
import { CustomerReturnLabelSettingsService } from "../../application/customer-return-label-settings.service";
import { labelSettings } from "../support/label-fixtures";

function repository(execute: ReturnType<typeof vi.fn>) {
  return new PostgresCustomerReturnSettingsStore({ execute } as unknown as ConstructorParameters<typeof PostgresCustomerReturnSettingsStore>[0]);
}

describe("pre-migration accepted return shipping", () => {
  it("uses independent channel pause/resume instead of the retired enabled flag", async () => {
    const { policyId: _policyId, ...settings } = labelSettings;
    const legacy = { ...settings, enabled: false };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ shipping_policy_id: null, configuration: null }] })
      .mockResolvedValueOnce({ rows: [legacy] })
      .mockResolvedValueOnce({ rows: [{ shipping_policy_id: null, configuration: null }] })
      .mockResolvedValueOnce({ rows: [legacy] });
    const persisted = repository(execute);
    const readControl = vi.fn().mockResolvedValue({ paused: true, version: 1 });
    const capabilities = vi.fn(async () => ({ configured: true, carriers: [{ id: "se-123", code: "ups", name: "UPS", services: [{ code: "ups_ground", name: "Ground" }] }] }));
    const service = new CustomerReturnLabelSettingsService({
      store: {
        read: vi.fn(), readAccepted: (channelId, authorizationId) => persisted.readAccepted(channelId, authorizationId),
        readControl, saveControl: vi.fn(),
        catalog: async () => ({ policies: [], warehouses: [{ id: 1, name: "Test", address: "1 Test Street", city: "Austin", state: "TX", postalCode: "78701", country: "US", isActive: 1 }] }),
      },
      authorizeChannel: async () => undefined, capabilities, now: () => new Date("2026-09-28T12:00:00Z"),
    });
    await expect(service.requireAcceptedShippingEnabled(36, 51)).rejects.toMatchObject({ code: "RETURN_LABEL_SETTINGS_CHANGED" });
    expect(capabilities).not.toHaveBeenCalled();
    readControl.mockResolvedValue({ paused: false, version: 2 });
    expect(await service.requireAcceptedShippingEnabled(36, 51)).toEqual({ ...settings, enabled: true });
    expect(legacy.enabled).toBe(false);
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it("does not override disabled shipping on a policy-owned accepted return", async () => {
    const disabled = { ...labelSettings, enabled: false };
    const execute = vi.fn().mockResolvedValue({ rows: [{ shipping_policy_id: 1, configuration: disabled }] });
    expect(await repository(execute).readAccepted(36, 51)).toEqual(disabled);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not borrow legacy shipping for an explicitly unconfigured policy", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ shipping_policy_id: 1, configuration: null }] });
    expect(await repository(execute).readAccepted(36, 51)).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("requires a matching channel and accepted authorization before any fallback read", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await expect(repository(execute).readAccepted(36, 51)).rejects.toMatchObject({ code: "RETURN_LABEL_NOT_FOUND", status: 404 });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
