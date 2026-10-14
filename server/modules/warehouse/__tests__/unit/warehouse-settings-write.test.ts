import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROCUREMENT_SETTING_KEYS } from "@shared/procurement/procurement-settings";
import { parseWarehouseSettingsWrite } from "../../domain/warehouse-settings-write";

const runtime = vi.hoisted(() => ({
  current: undefined as { id: number; warehouseCode: string; warehouseId: number | null } | undefined,
  values: vi.fn(), set: vi.fn(), lock: vi.fn(), remove: vi.fn(), transaction: vi.fn(),
}));
vi.mock("../../../../db", () => {
  const select = () => ({ from: () => ({ where: () => ({ for: (mode: string) => {
    runtime.lock(mode); return Promise.resolve(runtime.current ? [runtime.current] : []);
  } }) }) });
  const update = () => ({ set: (data: unknown) => { runtime.set(data); return { where: () => ({ returning: async () => [runtime.current] }) }; } });
  const insert = () => ({ values: (data: unknown) => { runtime.values(data); return { returning: async () => [runtime.current] }; } });
  const remove = () => ({ where: () => ({ returning: async () => { runtime.remove(); return [runtime.current]; } }) });
  const db = { select, update, insert, delete: remove, transaction: (work: (tx: unknown) => unknown) => {
    runtime.transaction(); return work(db);
  } };
  return { db };
});
import { replenishmentMethods } from "../../../inventory/infrastructure/replenishment.repository";

describe("generic warehouse settings owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.current = { id: 1, warehouseCode: "DEFAULT", warehouseId: null };
  });

  it.each([...PROCUREMENT_SETTING_KEYS, "procurementPolicyRevision"])("rejects %s at both direct persistence entrypoints before any database work", async key => {
    const input = { [key]: key === "procurementPolicyRevision" ? 0 : false };
    await expect(replenishmentMethods.createWarehouseSettings(input)).rejects.toMatchObject({
      statusCode: 403, code: "PROCUREMENT_SETTINGS_OWNER_REQUIRED", context: { fields: [key] },
    });
    await expect(replenishmentMethods.updateWarehouseSettings(1, input)).rejects.toMatchObject({
      statusCode: 403, code: "PROCUREMENT_SETTINGS_OWNER_REQUIRED",
    });
    expect(runtime.values).not.toHaveBeenCalled();
    expect(runtime.set).not.toHaveBeenCalled();
    expect(runtime.transaction).not.toHaveBeenCalled();
  });

  it.each([null, [], "settings", { unknown: true }, { id: 2 }, { updatedAt: new Date() },
    { channelSyncEnabled: "0" }, { inlineReplenMaxUnits: 1.5 }, { warehouseCode: " " }, { warehouseId: -1 }])(
    "rejects malformed generic payloads without a write: %j", input => {
      expect(() => parseWarehouseSettingsWrite(input)).toThrow(expect.objectContaining({ code: "WAREHOUSE_SETTINGS_INVALID" }));
    },
  );

  it("rejects previously unsupported forecast policy on direct creation without broadening update rules", async () => {
    await expect(replenishmentMethods.createWarehouseSettings({
      warehouseCode: "NORTH", inlineReplenMaxUnits: 0, purchasingForecastMethod: "weighted_blend_v1",
    })).rejects.toMatchObject({ statusCode: 400, code: "WAREHOUSE_SETTINGS_CREATE_FIELDS_UNSUPPORTED",
      context: { fields: ["purchasingForecastMethod"] } });
    expect(runtime.values).not.toHaveBeenCalled();
    await replenishmentMethods.updateWarehouseSettings(1, { purchasingForecastMethod: "weighted_blend_v1" });
    expect(runtime.set).toHaveBeenCalledWith(expect.objectContaining({ purchasingForecastMethod: "weighted_blend_v1" }));
  });

  it("preserves valid zero and nullable generic settings without mutating the caller", async () => {
    const input = Object.freeze({ warehouseCode: "NORTH", inlineReplenMaxUnits: null, urgentReplenThreshold: 0, channelSyncEnabled: 0 });
    await replenishmentMethods.createWarehouseSettings(input);
    expect(runtime.values).toHaveBeenCalledWith(input);
    expect(Object.keys(input)).toHaveLength(4);
  });

  it("updates ordinary settings on DEFAULT while holding the identity row lock", async () => {
    await replenishmentMethods.updateWarehouseSettings(1, { replenMode: "queue", warehouseCode: "DEFAULT", warehouseId: null });
    expect(runtime.lock).toHaveBeenCalledWith("update");
    expect(runtime.set).toHaveBeenCalledWith(expect.objectContaining({ replenMode: "queue" }));
  });

  it.each([{ warehouseCode: "OTHER" }, { warehouseId: 9 }])("rejects DEFAULT identity replacement %j", async patch => {
    await expect(replenishmentMethods.updateWarehouseSettings(1, patch)).rejects.toMatchObject({ code: "DEFAULT_WAREHOUSE_SETTINGS_PROTECTED" });
    expect(runtime.set).not.toHaveBeenCalled();
  });

  it("rejects DEFAULT deletion and ordinary-row takeover", async () => {
    await expect(replenishmentMethods.deleteWarehouseSettings(1)).rejects.toMatchObject({ code: "DEFAULT_WAREHOUSE_SETTINGS_PROTECTED" });
    runtime.current = { id: 2, warehouseCode: "NORTH", warehouseId: 2 };
    await expect(replenishmentMethods.updateWarehouseSettings(2, { warehouseCode: "DEFAULT" })).rejects.toMatchObject({ code: "DEFAULT_WAREHOUSE_SETTINGS_PROTECTED" });
    expect(runtime.set).not.toHaveBeenCalled();
    expect(runtime.remove).not.toHaveBeenCalled();
  });

  it("retains ordinary rename and deletion behavior", async () => {
    runtime.current = { id: 2, warehouseCode: "NORTH", warehouseId: 2 };
    await replenishmentMethods.updateWarehouseSettings(2, { warehouseCode: "WEST" });
    expect(await replenishmentMethods.deleteWarehouseSettings(2)).toBe(true);
  });

  it("does not invent a settings row for unknown ids", async () => {
    runtime.current = undefined;
    expect(await replenishmentMethods.updateWarehouseSettings(2, { isActive: 0 })).toBeNull();
    expect(await replenishmentMethods.deleteWarehouseSettings(2)).toBe(false);
    expect(runtime.set).not.toHaveBeenCalled();
    expect(runtime.remove).not.toHaveBeenCalled();
  });
});
