import { describe, expect, it, vi } from "vitest";
import { prepareWarehouseInventorySourceRequestSchema } from "@shared/types/warehouse-inventory-source";
import { WarehouseInventorySourceService, type PrepareWarehouseInventorySourceCommand } from "../../application/warehouse-inventory-source.service";
import { planWarehouseInventorySource, resolveConfiguredWarehouseSource, warehouseInventorySourceFingerprint } from "../../domain/warehouse-inventory-source";

const warehouse = Object.freeze({
  id: 1, code: "LEON", name: "Existing warehouse", warehouseType: "operations" as const,
  inventorySourceType: "internal", isActive: 1 as const,
});
const request = Object.freeze({
  warehouseId: 1, expectedWarehouseFingerprint: warehouseInventorySourceFingerprint(warehouse),
  inventoryAuthority: "echelon" as const, fulfillmentAuthority: "echelon" as const,
  changeReason: "Prepare the existing site", idempotencyKey: "source-test-1",
});
const result = {
  fulfillmentNodeId: 9, warehouseId: 1, lifecycleStatus: "draft" as const, alreadyApplied: false,
  runtimeAuthorityChanged: false as const, providerWriteAttempted: false as const, outboxEnqueued: false as const,
};
const time = new Date("2026-09-06T12:00:00Z");
const savedRequest = Object.freeze({
  warehouseId: request.warehouseId, expectedWarehouseFingerprint: request.expectedWarehouseFingerprint,
  authoritySource: "warehouse_settings" as const, changeReason: request.changeReason, idempotencyKey: request.idempotencyKey,
});
function setup() {
  const store = { getView: vi.fn(async () => ({ warehouses: [] })), prepareDraft: vi.fn(async (_command: PrepareWarehouseInventorySourceCommand) => result) };
  return { store, service: new WarehouseInventorySourceService(store, { now: () => time }) };
}

describe("warehouse inventory source preparation", () => {
  it.each([
    ["operations", "internal", "echelon", "echelon", "internal"],
    ["bulk_storage", "internal", "echelon", "none", "internal"],
    ["3pl", "channel", "external_provider", "external_provider", "inbound"],
    ["3pl", "manual", "manual", "external_provider", "manual"],
    ["3pl", "internal", "echelon", "external_provider", "internal"],
    ["operations", "channel", "external_provider", "echelon", "inbound"],
    ["bulk_storage", "manual", "manual", "none", "manual"],
  ] as const)("reuses %s/%s settings without conflating stock source and fulfillment", (warehouseType, inventorySourceType, inventoryAuthority, fulfillmentAuthority, inventoryDirection) => {
    const input = { ...warehouse, warehouseType, inventorySourceType, inventorySourceChannelId: "37" };
    expect(resolveConfiguredWarehouseSource(input)).toEqual({
      status: "ready", inventoryAuthority, fulfillmentAuthority, inventoryDirection,
      sourceChannelId: inventorySourceType === "channel" ? 37 : null,
    });
    expect(planWarehouseInventorySource(input, { ...savedRequest, expectedWarehouseFingerprint: warehouseInventorySourceFingerprint(input) }))
      .toMatchObject({ inventoryAuthority, fulfillmentAuthority, lifecycleStatus: "draft", providerAccountId: null, providerLocationId: null });
  });
  it.each([undefined, null, "", "0", "-1", "1.5", "37x", " 37", "2147483648", "9".repeat(400)])("blocks an invalid incoming source channel: %j", inventorySourceChannelId => {
    const input = { ...warehouse, inventorySourceType: "channel", inventorySourceChannelId };
    expect(resolveConfiguredWarehouseSource(input)).toMatchObject({ status: "blocked" });
    expect(() => planWarehouseInventorySource(input, { ...savedRequest, expectedWarehouseFingerprint: warehouseInventorySourceFingerprint(input) }))
      .toThrow(expect.objectContaining({ code: "WAREHOUSE_INVENTORY_SOURCE_CONFIGURATION_REQUIRED" }));
  });
  it.each(["integration", "unrecognized"])("does not silently replace an unsupported %s source with internal stock", inventorySourceType => {
    expect(resolveConfiguredWarehouseSource({ ...warehouse, inventorySourceType })).toMatchObject({ status: "blocked" });
  });
  it("includes the incoming channel identity in the stale-settings check", () => {
    const before = { ...warehouse, inventorySourceType: "channel", inventorySourceChannelId: "37" };
    expect(() => planWarehouseInventorySource({ ...before, inventorySourceChannelId: "36" }, {
      ...savedRequest, expectedWarehouseFingerprint: warehouseInventorySourceFingerprint(before),
    })).toThrow(expect.objectContaining({ code: "WAREHOUSE_INVENTORY_SOURCE_STALE" }));
  });
  it("accepts saved-settings commands, rejects overrides and keeps their idempotency hashes distinct", async () => {
    const { store, service } = setup();
    await expect(service.prepareDraft(savedRequest, "operator")).resolves.toEqual(result);
    await service.prepareDraft(savedRequest, "operator");
    expect(store.prepareDraft.mock.calls[0]![0].requestHash).toBe(store.prepareDraft.mock.calls[1]![0].requestHash);
    await service.prepareDraft(request, "operator");
    expect(store.prepareDraft.mock.calls[2]![0].requestHash).not.toBe(store.prepareDraft.mock.calls[0]![0].requestHash);
    await expect(service.prepareDraft({ ...savedRequest, inventoryAuthority: "echelon" }, "operator"))
      .rejects.toMatchObject({ code: "WAREHOUSE_INVENTORY_SOURCE_INVALID_REQUEST" });
    expect(store.prepareDraft).toHaveBeenCalledTimes(3);
  });
  it("copies an existing warehouse into a draft without inventing provider identity", () => {
    expect(planWarehouseInventorySource(warehouse, request)).toEqual({
      warehouseId: 1, code: "LEON", name: "Existing warehouse", nodeType: "internal_warehouse",
      inventoryAuthority: "echelon", fulfillmentAuthority: "echelon",
      providerAccountId: null, providerLocationId: null, lifecycleStatus: "draft",
    });
    expect(warehouse.code).toBe("LEON");
  });
  it.each(["operations", "bulk_storage", "3pl"] as const)("uses the saved %s warehouse classification", warehouseType => {
    const source = { ...warehouse, warehouseType };
    const planned = planWarehouseInventorySource(source, {
      ...request, expectedWarehouseFingerprint: warehouseInventorySourceFingerprint(source),
      inventoryAuthority: "manual", fulfillmentAuthority: "none",
    });
    expect(planned.nodeType).toBe(warehouseType === "3pl" ? "third_party_logistics" : "internal_warehouse");
    expect(planned.inventoryAuthority).toBe("manual");
    expect(planned.fulfillmentAuthority).toBe("none");
  });
  it("does not guess external ownership from a third-party warehouse name", () => {
    const source = { ...warehouse, warehouseType: "3pl" as const };
    expect(planWarehouseInventorySource(source, {
      ...request, expectedWarehouseFingerprint: warehouseInventorySourceFingerprint(source),
    })).toMatchObject({ inventoryAuthority: "echelon", fulfillmentAuthority: "echelon" });
  });
  it.each(["code", "name", "warehouseType", "inventorySourceType", "isActive"] as const)("rejects a changed %s snapshot", field => {
    const values = { code: "NEW", name: "New name", warehouseType: "3pl", inventorySourceType: "external", isActive: 0 };
    expect(() => planWarehouseInventorySource({ ...warehouse, [field]: values[field] }, request))
      .toThrow(expect.objectContaining({ code: "WAREHOUSE_INVENTORY_SOURCE_STALE" }));
  });
  it("rejects inactive and wrong-ID warehouses", () => {
    const inactive = { ...warehouse, isActive: 0 as const };
    expect(() => planWarehouseInventorySource(inactive, {
      ...request, expectedWarehouseFingerprint: warehouseInventorySourceFingerprint(inactive),
    })).toThrow(expect.objectContaining({ code: "WAREHOUSE_INVENTORY_SOURCE_INACTIVE" }));
    expect(() => planWarehouseInventorySource(warehouse, { ...request, warehouseId: 2 }))
      .toThrow(expect.objectContaining({ code: "WAREHOUSE_INVENTORY_SOURCE_STALE" }));
  });
  it.each([
    { warehouseId: 0 }, { warehouseId: "1" }, { warehouseId: 1.5 }, { warehouseId: 2147483648 },
    { expectedWarehouseFingerprint: "bad" }, { inventoryAuthority: undefined },
    { fulfillmentAuthority: undefined }, { inventoryAuthority: "automatic" }, { changeReason: " " },
    { idempotencyKey: "" }, { lifecycleStatus: "active" }, { providerAccountId: 5 }, { actorId: "forged" },
  ])("rejects invalid/undeclared fields: %j", async invalid => {
    const { store, service } = setup();
    await expect(service.prepareDraft({ ...request, ...invalid }, "operator"))
      .rejects.toMatchObject({ code: "WAREHOUSE_INVENTORY_SOURCE_INVALID_REQUEST" });
    expect(store.prepareDraft).not.toHaveBeenCalled();
  });
  it.each([undefined, "", " ".repeat(5), 1, "a".repeat(101)])("requires an authenticated actor: %j", async actor => {
    const { store, service } = setup();
    await expect(service.prepareDraft(request, actor)).rejects.toMatchObject({ status: 401 });
    expect(store.prepareDraft).not.toHaveBeenCalled();
  });
  it("validates the boundary, injects time and binds the request hash to actor and payload", async () => {
    const { store, service } = setup();
    expect(prepareWarehouseInventorySourceRequestSchema.parse(request)).toEqual(request);
    await expect(service.prepareDraft(request, "operator")).resolves.toEqual(result);
    await service.prepareDraft(request, "operator");
    const first = store.prepareDraft.mock.calls[0]![0];
    expect(first).toMatchObject({ ...request, occurredAt: time, actorId: "operator" });
    expect(store.prepareDraft.mock.calls[1]![0].requestHash).toBe(first.requestHash);
    await service.prepareDraft(request, "different-operator");
    expect(store.prepareDraft.mock.calls[2]![0].requestHash).not.toBe(first.requestHash);
    await service.prepareDraft({ ...request, changeReason: "Other reason" }, "operator");
    expect(store.prepareDraft.mock.calls[3]![0].requestHash).not.toBe(first.requestHash);
  });
  it("rejects invalid clocks without writing", async () => {
    const { store } = setup();
    const service = new WarehouseInventorySourceService(store, { now: () => new Date("invalid") });
    await expect(service.prepareDraft(request, "operator")).rejects.toMatchObject({ code: "WAREHOUSE_INVENTORY_SOURCE_INVALID_CLOCK" });
    expect(store.prepareDraft).not.toHaveBeenCalled();
  });
  it("keeps GET read-only and validates returned contracts", async () => {
    const { store, service } = setup();
    await expect(service.getView()).resolves.toEqual({ warehouses: [] });
    expect(store.prepareDraft).not.toHaveBeenCalled();
    store.prepareDraft.mockResolvedValueOnce({ ...result, providerWriteAttempted: true } as never);
    await expect(service.prepareDraft(request, "operator")).rejects.toThrow();
  });
});
