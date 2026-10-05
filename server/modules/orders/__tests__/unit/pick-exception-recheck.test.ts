import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pickingReadinessBlockers, type WmsPickingProgressLine } from "@shared/wms-picking-progress";

const reconcileWmsPickingProgress = vi.hoisted(() => vi.fn());
vi.mock("../../../wms/picking-progress.repository", async (original) => ({
  ...(await original<typeof import("../../../wms/picking-progress.repository")>()),
  reconcileWmsPickingProgress,
}));

import { readWmsPickingBlockers } from "../../../wms/picking-progress.repository";
import { PickingUseCases } from "../../picking.use-cases";
import { releaseClearedPickExceptions } from "../../../oms/oms-flow-reconciliation.service";

// 2026-10-03, #63721: every line was picked, but the unmapped graded card
// (SKU "UNKNOWN", no bin) kept the order in exception. Only another pick
// re-evaluates an exception order, and exception orders get no shipment, so it
// never reached ShipStation.

const NOW = new Date("2099-01-01T12:00:00.000Z");

const unmappedLine: WmsPickingProgressLine = {
  id: 1, sku: "UNKNOWN", quantity: 1, pickedQuantity: 1, requiresShipping: true, onHold: false,
  status: "completed", inventoryTracking: null, catalogProductId: null, productId: null, location: "UNASSIGNED",
};
const stockedLine: WmsPickingProgressLine = {
  id: 2, sku: "EG-SLV-PF-P100", quantity: 1, pickedQuantity: 1, requiresShipping: true, onHold: false,
  status: "completed", inventoryTracking: true, catalogProductId: 36, productId: 105, location: "C-13",
};

function text(statement: unknown): string {
  return JSON.stringify(statement);
}

describe("ready-to-ship blockers for an unmapped line", () => {
  it("need no pick bin for the unmapped line, but still need one for a stocked line", () => {
    expect(pickingReadinessBlockers([unmappedLine, stockedLine])).toEqual([]);
    expect(pickingReadinessBlockers([unmappedLine, { ...stockedLine, location: "UNASSIGNED" }]))
      .toEqual(["EG-SLV-PF-P100 has no pick bin"]);
  });

  it("do not count a missing_variant exception raised on an unmapped line", async () => {
    // A picker who tried to give the UNKNOWN card a bin raised one; it records
    // the line's expected state, not a reason to hold the order.
    const tx = { execute: vi.fn(async (_statement: unknown) => ({ rows: [] })), select: vi.fn() };
    await readWmsPickingBlockers(tx as any, 63721, []);
    const allocationQuery = tx.execute.mock.calls.map(([statement]) => text(statement))
      .find((statement) => statement.includes("FROM wms.allocation_exceptions blocking"));
    expect(allocationQuery).toContain("blocking.exception_type = 'missing_variant'");
    expect(allocationQuery).toContain("unmapped.catalog_product_id IS NULL");
    expect(allocationQuery).toContain("unmapped.product_id IS NULL");
  });
});

function harness(options: { candidates?: Array<{ id: number; warehouse_id: number | null }>; lockedRow?: boolean } = {}) {
  const candidates = options.candidates ?? [{ id: 63721, warehouse_id: 1 }];
  const db = {
    execute: vi.fn(async (_statement: unknown) => ({ rows: candidates })),
    transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(tx)),
  };
  const tx = {
    execute: vi.fn(async (_statement: unknown) => ({ rows: options.lockedRow === false ? [] : [{ id: 63721 }] })),
  };
  const storage = {
    getAllWarehouseSettings: vi.fn(async () => [{ warehouseId: 1, postPickStatus: "ready_to_ship" }]),
  };
  const service = new PickingUseCases(db as any, {} as any, {} as any, storage as any,
    undefined, undefined, false, undefined, undefined, () => NOW);
  return { service, db, tx };
}

describe("releaseClearedPickExceptions", () => {
  beforeEach(() => {
    reconcileWmsPickingProgress.mockReset();
    reconcileWmsPickingProgress.mockResolvedValue({ warehouseStatus: "ready_to_ship" });
  });

  it("runs the pick projection under a guarded lock and counts a released order", async () => {
    const { service, db, tx } = harness();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(service.releaseClearedPickExceptions(100))
      .resolves.toEqual({ checked: 1, released: 1, stillBlocked: 0, failed: 0 });

    const scan = text(db.execute.mock.calls[0][0]);
    expect(scan).toContain("wo.warehouse_status = 'exception'");
    expect(scan).toContain("wo.exception_resolution IS NULL");
    expect(scan).toContain("wo.on_hold = 0");
    expect(scan).toContain("blocking.exception_type = 'missing_variant'");
    const lock = text(tx.execute.mock.calls[0][0]);
    expect(lock).toContain("FOR UPDATE");
    expect(lock).toContain("exception_resolution IS NULL");
    expect(reconcileWmsPickingProgress).toHaveBeenCalledWith(
      tx, 63721, "ready_to_ship", "system:pick-exception-recheck", expect.any(Function));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("\"outcome\":\"released\""));
    log.mockRestore();
  });

  it("counts an order the projection keeps in exception as still blocked", async () => {
    reconcileWmsPickingProgress.mockResolvedValue({ warehouseStatus: "exception" });
    const { service } = harness();
    await expect(service.releaseClearedPickExceptions(100))
      .resolves.toEqual({ checked: 1, released: 0, stillBlocked: 1, failed: 0 });
  });

  it("does nothing when a lead decided or a hold landed after the scan", async () => {
    const { service } = harness({ lockedRow: false });
    await expect(service.releaseClearedPickExceptions(100))
      .resolves.toEqual({ checked: 1, released: 0, stillBlocked: 0, failed: 0 });
    expect(reconcileWmsPickingProgress).not.toHaveBeenCalled();
  });

  it("keeps going when one order fails, and counts it", async () => {
    const { service, db } = harness({ candidates: [{ id: 63720, warehouse_id: 1 }, { id: 63721, warehouse_id: 1 }] });
    db.transaction.mockRejectedValueOnce(Object.assign(new Error("could not serialize access"), { code: "40001" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(service.releaseClearedPickExceptions(100))
      .resolves.toEqual({ checked: 2, released: 1, stillBlocked: 0, failed: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("\"error_code\":\"40001\""));
    error.mockRestore();
    log.mockRestore();
  });

  it("warns when the batch is full so delayed orders are visible", async () => {
    const { service } = harness({ candidates: [{ id: 63720, warehouse_id: 1 }, { id: 63721, warehouse_id: 1 }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await service.releaseClearedPickExceptions(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("\"outcome\":\"batch_full\""));
    warn.mockRestore();
    log.mockRestore();
  });

  it.each([0, -1, 1.5, 501])("rejects a batch size of %s", async (limit) => {
    const { service, db } = harness();
    await expect(service.releaseClearedPickExceptions(limit)).rejects.toThrow("limit must be an integer");
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe("scheduled exception re-check", () => {
  const deps = { reservation: null, fulfillmentAuthority: {} as any };

  it("is a no-op when the picking service is not wired", async () => {
    await expect(releaseClearedPickExceptions(deps)).resolves.toEqual({ checked: 0, released: 0, stillBlocked: 0, failed: 0 });
  });

  it("delegates one bounded pass to the picking owner", async () => {
    const owner = vi.fn(async () => ({ checked: 3, released: 1, stillBlocked: 2, failed: 0 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(releaseClearedPickExceptions({ ...deps, pickExceptions: { releaseClearedPickExceptions: owner } }))
      .resolves.toEqual({ checked: 3, released: 1, stillBlocked: 2, failed: 0 });
    expect(owner).toHaveBeenCalledWith(100);
    log.mockRestore();
  });

  it("reports failed orders on the run so they are not silent", async () => {
    const owner = vi.fn(async () => ({ checked: 2, released: 1, stillBlocked: 0, failed: 1 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(releaseClearedPickExceptions({ ...deps, pickExceptions: { releaseClearedPickExceptions: owner } }))
      .rejects.toThrow("exception re-check failed for 1 order(s)");
    log.mockRestore();
  });

  it("runs before detection, so a released order gets its missing shipment in the same run, and is wired at boot", () => {
    const flow = readFileSync(resolve(process.cwd(), "server/modules/oms/oms-flow-reconciliation.service.ts"), "utf8");
    const release = flow.indexOf('step("releaseClearedPickExceptions"');
    expect(release).toBeGreaterThan(0);
    expect(release).toBeLessThan(flow.indexOf('step("collect"'));
    const boot = readFileSync(resolve(process.cwd(), "server/index.ts"), "utf8");
    expect(boot).toContain("pickExceptions: services.picking");
  });
});
