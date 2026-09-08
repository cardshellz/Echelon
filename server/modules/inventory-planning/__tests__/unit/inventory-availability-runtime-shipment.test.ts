import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AuthorityAwareInventoryShipmentRecorder, type InventoryShipmentRuntimeContext,
  type InventoryShipmentRuntimeInput } from "../../application/inventory-availability-runtime-shipment.service";
import { PostgresInventoryShipmentRuntimeExecutor } from "../../infrastructure/inventory-availability-runtime-shipment.repository";

const input: InventoryShipmentRuntimeInput = {
  productVariantId: 10, warehouseLocationId: 20, qty: 3, orderId: 30, orderItemId: 40,
  shipmentId: "50", shipmentItemId: 60, userId: "system:shipstation:v2", deductFromOnHandOnly: false,
};
function service(context: InventoryShipmentRuntimeContext) {
  const execute = vi.fn(async <T>(work: (context: InventoryShipmentRuntimeContext) => Promise<T>) => work(context));
  return { execute, recorder: new AuthorityAwareInventoryShipmentRecorder({ execute }) };
}

describe("authority-aware shipment application", () => {
  it("preserves valid legacy hints, quantity and flags", async () => {
    const recordLegacy = vi.fn().mockResolvedValue(undefined);
    await service({ authority: "legacy", recordLegacy }).recorder.recordShipment(input);
    expect(recordLegacy).toHaveBeenCalledExactlyOnceWith(input);
  });
  it.each([null, 20, 999])("canonical source resolution does not accept bin %s as authority", async (warehouseLocationId) => {
    const dispatchSource = vi.fn().mockResolvedValue(undefined);
    const f = service({ authority: "canonical", dispatchSource });
    await f.recorder.recordShipment({ ...input, warehouseLocationId, deductFromOnHandOnly: true });
    expect(dispatchSource).toHaveBeenCalledExactlyOnceWith({
      productVariantId: 10, quantity: "3", orderId: 30, orderItemId: 40,
      outboundShipmentId: 50, sourceShipmentItemId: 60, actor: input.userId,
      reason: "Provider-confirmed customer shipment inventory posting",
    });
  });
  it("rejects a missing legacy location without calling the owner", async () => {
    const recordLegacy = vi.fn();
    await expect(service({ authority: "legacy", recordLegacy }).recorder.recordShipment({ ...input, warehouseLocationId: null }))
      .rejects.toMatchObject({ code: "LEGACY_SHIPMENT_SOURCE_LOCATION_REQUIRED" });
    expect(recordLegacy).not.toHaveBeenCalled();
  });
  it.each([{ orderItemId: undefined }, { releaseReservation: false }])("rejects unsupported canonical purposes %j", async (overrides) => {
    const dispatchSource = vi.fn();
    await expect(service({ authority: "canonical", dispatchSource }).recorder.recordShipment({ ...input, ...overrides }))
      .rejects.toMatchObject({ code: "CANONICAL_SHIPMENT_PURPOSE_UNSUPPORTED" });
    expect(dispatchSource).not.toHaveBeenCalled();
  });
  it.each([
    { qty: 0 }, { qty: 1.5 }, { qty: 2_147_483_648 }, { shipmentId: "01" }, { shipmentId: "1e2" },
    { shipmentId: "9007199254740993" }, { shipmentItemId: -1 }, { userId: " " }, { warehouseLocationId: 0 },
  ])("validates before reading authority %j", async (overrides) => {
    const f = service({ authority: "canonical", dispatchSource: vi.fn() });
    await expect(f.recorder.recordShipment({ ...input, ...overrides })).rejects.toMatchObject({ code: "INVENTORY_SHIPMENT_INPUT_INVALID" });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("propagates canonical failures, never choosing a second authority", async () => {
    const error = Object.assign(new Error("ambiguous picked source"), { code: "CLAIM_DISPATCH_SOURCE_AMBIGUOUS" });
    const dispatchSource = vi.fn().mockRejectedValue(error);
    const f = service({ authority: "canonical", dispatchSource });
    await expect(f.recorder.recordShipment(input)).rejects.toBe(error);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});

function executorFixture(authority: "legacy" | "canonical") {
  const calls: string[] = [];
  const query = vi.fn(async (text: string) => {
    calls.push(text);
    if (text.includes("availability_runtime_authority")) return { rows: [{ authority,
      authority_revision: "2", activation_run_id: authority === "canonical" ? "1" : null }] };
    return { rows: [] };
  });
  const release = vi.fn(() => { calls.push("release"); });
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const recordShipmentInsideTransaction = vi.fn(async () => { calls.push("legacy"); });
  const resolve = vi.fn();
  const dispatchPrepared = vi.fn(async () => { calls.push("canonical"); return {} as never; });
  const executor = new PostgresInventoryShipmentRuntimeExecutor({ connect }, { recordShipmentInsideTransaction }, { dispatchPrepared }, { resolve });
  return { calls, client, query, release, connect, recordShipmentInsideTransaction, resolve, dispatchPrepared,
    recorder: new AuthorityAwareInventoryShipmentRecorder(executor) };
}

describe("shipment routing transaction", () => {
  it("pins and commits legacy on one connection with the bound database", async () => {
    const f = executorFixture("legacy");
    await f.recorder.recordShipment(input);
    expect(f.calls.slice(-3)).toEqual(["legacy", "COMMIT", "release"]);
    expect(f.calls[1]).toContain("FOR SHARE");
    expect(f.recordShipmentInsideTransaction).toHaveBeenCalledWith(input, expect.objectContaining({ $client: f.client }));
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.dispatchPrepared).not.toHaveBeenCalled();
  });
  it("releases routing capacity before opening canonical work, including a single-connection pool", async () => {
    const f = executorFixture("canonical");
    f.dispatchPrepared.mockImplementation(async (prepare) => {
      expect(f.release).toHaveBeenCalledTimes(1);
      await prepare(f.client);
      return {} as never;
    });
    await f.recorder.recordShipment(input);
    expect(f.resolve).toHaveBeenCalledWith(f.client, expect.objectContaining({ sourceShipmentItemId: 60 }));
    expect(f.recordShipmentInsideTransaction).not.toHaveBeenCalled();
    expect(f.calls.slice(-2)).toEqual(["COMMIT", "release"]);
  });
  it("rolls back all legacy owner failures", async () => {
    const f = executorFixture("legacy");
    const error = new Error("posting failed");
    f.recordShipmentInsideTransaction.mockRejectedValue(error);
    await expect(f.recorder.recordShipment(input)).rejects.toBe(error);
    expect(f.calls.slice(-2)).toEqual(["ROLLBACK", "release"]);
    expect(f.calls).not.toContain("COMMIT");
  });
  it("does not rollback a released routing client when canonical fails", async () => {
    const f = executorFixture("canonical");
    const error = new Error("dispatch failed");
    f.dispatchPrepared.mockRejectedValue(error);
    await expect(f.recorder.recordShipment(input)).rejects.toBe(error);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.calls).not.toContain("ROLLBACK");
  });
  it("discards a connection with ambiguous BEGIN outcome", async () => {
    const f = executorFixture("legacy");
    f.query.mockRejectedValueOnce(new Error("connection lost during BEGIN"));
    await expect(f.recorder.recordShipment(input)).rejects.toThrow("connection lost");
    expect(f.release).toHaveBeenCalledWith(expect.any(Error));
    expect(f.recordShipmentInsideTransaction).not.toHaveBeenCalled();
  });
  it("reports rollback failure and discards the damaged connection", async () => {
    const f = executorFixture("legacy");
    f.recordShipmentInsideTransaction.mockRejectedValue(new Error("posting failed"));
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (text) => {
      if (text === "ROLLBACK") throw new Error("rollback failed");
      return original(text);
    });
    await expect(f.recorder.recordShipment(input)).rejects.toBeInstanceOf(AggregateError);
    expect(f.release).toHaveBeenCalledWith(expect.objectContaining({ message: "rollback failed" }));
  });
});
