import { describe, expect, it } from "vitest";
import { PROCUREMENT_SETTING_KEYS } from "@shared/procurement/procurement-settings";
import { warehouseSettingsPayload } from "../../warehouse-settings-payload";

describe("warehouse settings form payload", () => {
  it("limits DEFAULT-seeded creation to the existing POST fields while preserving update compatibility", () => {
    const defaults = { warehouseCode: "NORTH", warehouseId: 2, inlineReplenMaxUnits: 0,
      purchasingForecastMethod: "weighted_blend_v1", autoDraftApprovalPolicy: "high_confidence_only", requireApproval: true };
    expect(warehouseSettingsPayload(defaults, "create")).toEqual({ warehouseCode: "NORTH", warehouseId: 2, inlineReplenMaxUnits: 0 });
    expect(warehouseSettingsPayload(defaults, "update")).toMatchObject({ purchasingForecastMethod: "weighted_blend_v1", autoDraftApprovalPolicy: "high_confidence_only" });
  });

  it("preserves generic values while excluding every procurement field and server version", () => {
    const settings = Object.freeze({
      id: 1, createdAt: "2026-10-13", updatedAt: "2026-10-13", procurementPolicyRevision: 4,
      ...Object.fromEntries(PROCUREMENT_SETTING_KEYS.map(key => [key, true])),
      warehouseCode: "DEFAULT", warehouseId: null, inlineReplenMaxUnits: 0, channelSyncEnabled: 0,
    });
    expect(warehouseSettingsPayload(settings)).toEqual({
      warehouseCode: "DEFAULT", warehouseId: null, inlineReplenMaxUnits: 0, channelSyncEnabled: 0,
    });
    expect(settings.procurementPolicyRevision).toBe(4);
  });
});
