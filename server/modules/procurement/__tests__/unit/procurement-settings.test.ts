import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { procurementSettingsCommandSchema, type ProcurementSettingsSnapshot } from "@shared/procurement/procurement-settings";
import { applyProcurementSettingsCommand, assertProcurementSettingsAuthority } from "../../procurement-settings.policy";
import { readProcurementSettings, type ProcurementSettingsTransaction } from "../../procurement-settings.repository";

const settings: ProcurementSettingsSnapshot = {
  requireApproval: false, autoSendOnApprove: true, requireAcknowledgeBeforeReceive: false,
  hideIncotermsDomestic: true, enableShipmentTracking: true, autoPutawayLocation: true,
  autoCloseOnReconcile: true, oneClickReceiveStart: true, useNewPoEditor: false,
  useNewReorderCockpit: false, revision: 4,
};

describe("procurement policy command validation", () => {
  it("normalizes a single toggle into the same explicit batch contract", () => {
    expect(procurementSettingsCommandSchema.parse({ key: "requireApproval", value: true, expectedRevision: 4 }))
      .toEqual({ expectedRevision: 4, updates: [{ key: "requireApproval", value: true }] });
  });

  it.each([
    { expectedRevision: 0, updates: [] },
    { expectedRevision: 0, updates: [{ key: "requireApproval", value: true }, { key: "requireApproval", value: false }] },
    { expectedRevision: 0, updates: [{ key: "requireApproval", value: true }, { key: "unknown", value: false }] },
    { expectedRevision: 0, updates: [{ key: "requireApproval", value: true }, { key: "useNewPoEditor", value: "true" }] },
    { expectedRevision: 0, updates: [{ key: "requireApproval", value: null }] },
    { expectedRevision: 0, key: "requireApproval", value: 1 },
    { expectedRevision: 0, key: "requireApproval", value: true, extra: true },
    { expectedRevision: 0, updates: [{ key: "requireApproval", value: true, extra: true }] },
    { expectedRevision: 0, updates: [{ key: "requireApproval", value: true }], key: "useNewPoEditor", value: true },
    { key: "requireApproval", value: true },
    { expectedRevision: -1, key: "requireApproval", value: true },
    { expectedRevision: 1.5, key: "requireApproval", value: true },
    { expectedRevision: "0", key: "requireApproval", value: true },
    { expectedRevision: 2_147_483_648, key: "requireApproval", value: true },
  ])("rejects the whole malformed command %j", (command) => {
    expect(procurementSettingsCommandSchema.safeParse(command).success).toBe(false);
  });
});

describe("procurement policy decisions", () => {
  it("changes the aggregate without mutating the caller and advances one revision", () => {
    const before = Object.freeze({ ...settings });
    const after = applyProcurementSettingsCommand(before, { expectedRevision: 4, updates: [{ key: "requireApproval", value: true }, { key: "useNewPoEditor", value: true }] });
    expect(before).toEqual(settings);
    expect(after).toEqual({ ...settings, requireApproval: true, useNewPoEditor: true, revision: 5 });
  });
  it("rejects a stale administrator even when the requested value already matches", () => {
    expect(() => applyProcurementSettingsCommand(settings, { expectedRevision: 3, updates: [{ key: "requireApproval", value: false }] }))
      .toThrow(expect.objectContaining({ code: "PROCUREMENT_SETTINGS_STALE", statusCode: 409 }));
  });
  it("does not overflow the stored revision", () => {
    expect(() => applyProcurementSettingsCommand({ ...settings, revision: 2_147_483_647 }, { expectedRevision: 2_147_483_647, updates: [{ key: "requireApproval", value: true }] }))
      .toThrow(expect.objectContaining({ code: "PROCUREMENT_SETTINGS_REVISION_EXHAUSTED" }));
  });
  it.each([
    { active: true, permissions: ["inventory:adjust", "purchasing:edit"], scopedPermissions: [] },
    { active: false, permissions: ["settings:edit"], scopedPermissions: [] },
    { active: true, permissions: [], scopedPermissions: ["settings:edit"] },
  ])("requires active unscoped settings authority %j", actor => {
    expect(() => assertProcurementSettingsAuthority({ userId: "editor", ...actor })).toThrow(expect.objectContaining({ code: "PROCUREMENT_SETTINGS_FORBIDDEN" }));
  });
  it("accepts an independently assigned settings grant without administrator role assumptions", () => {
    expect(() => assertProcurementSettingsAuthority({ userId: "editor", active: true, permissions: ["settings:edit"], scopedPermissions: [] })).not.toThrow();
  });
});

describe("canonical policy reader", () => {
  it.each([{ rows: [] }, { rows: [{ ...settings, id: 1, warehouseId: null }, { ...settings, id: 2, warehouseId: null }] }])("rejects missing or ambiguous DEFAULT rows", async ({ rows }) => {
    await expect(readProcurementSettings({ execute: async () => ({ rows }) })).rejects.toMatchObject({ code: "PROCUREMENT_SETTINGS_CONFIGURATION_INVALID" });
  });
  it.each([{ ...settings, id: 1, warehouseId: 7 }, { ...settings, id: 1, warehouseId: null, requireApproval: null }])("does not invent defaults for invalid persisted policy", async row => {
    await expect(readProcurementSettings({ execute: async () => ({ rows: [row] }) })).rejects.toMatchObject({ code: "PROCUREMENT_SETTINGS_SOURCE_INVALID" });
  });
  it.each(["share", "update"] as const)("returns only the canonical projection under %s lock", async lock => {
    const statements: string[] = [];
    const tx: ProcurementSettingsTransaction = { execute: async query => {
      statements.push(new PgDialect().sqlToQuery(query).sql);
      return { rows: [{ ...settings, id: 1, warehouseId: null }] };
    } };
    expect(await readProcurementSettings(tx, lock)).toEqual({ id: 1, settings });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("WHERE warehouse_code='DEFAULT'");
    expect(statements[0]).toContain(`FOR ${lock.toUpperCase()}`);
    expect(statements[0]).not.toContain("LIMIT 1");
  });
});
