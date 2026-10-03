import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PickingUseCases } from "../../picking.use-cases";
import { releaseClearedPickExceptions } from "../../../oms/oms-flow-reconciliation.service";

// 2026-10-03, #63721: every line was picked, but the unmapped graded card
// (SKU "UNKNOWN", no bin) failed the "has a pick bin" check, so the order was
// parked in exception. Only another pick re-evaluates an exception order, and
// exception orders get no shipment, so it never reached ShipStation.

const NOW = new Date("2099-01-01T12:00:00.000Z");

const unmappedLine = {
  id: 1, orderId: 63721, sku: "UNKNOWN", name: "2023 Topps Now Victor Wembanyama Draft RC PSA 9",
  quantity: 1, pickedQuantity: 1, requiresShipping: 1, onHold: false, status: "completed",
  location: "UNASSIGNED", catalogProductId: null, productId: null, inventoryTracking: null,
};
const stockedLine = {
  id: 2, orderId: 63721, sku: "EG-SLV-PF-P100", name: "Sleeves", quantity: 1, pickedQuantity: 1,
  requiresShipping: 1, onHold: false, status: "completed", location: "C-13",
  catalogProductId: 36, productId: 105, inventoryTracking: true,
};

function text(statement: unknown): string {
  return JSON.stringify(statement);
}

function harness(options: {
  candidates?: number[];
  items?: Array<Record<string, unknown>>;
  lockedRow?: boolean;
} = {}) {
  const candidates = options.candidates ?? [63721];
  const items = options.items ?? [unmappedLine, stockedLine];
  const db = {
    execute: vi.fn(async (statement: unknown) => {
      const sqlText = text(statement);
      if (sqlText.includes("ORDER BY wo.id ASC")) return { rows: candidates.map((id) => ({ id })) };
      return { rows: [] }; // no open allocation exception or replen task
    }),
    transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(tx)),
  };
  const audit = vi.fn(async () => undefined);
  const tx = {
    execute: vi.fn(async (statement: unknown) => {
      const sqlText = text(statement);
      if (sqlText.includes("UPDATE wms.orders")) return { rows: [{ new_status: "ready_to_ship" }] };
      if (sqlText.includes("FOR UPDATE")) {
        return { rows: options.lockedRow === false ? [] : [{ order_number: "#63721" }] };
      }
      return { rows: [] };
    }),
    insert: vi.fn(() => ({ values: audit })),
  };
  const storage = {
    getOrderItems: vi.fn(async () => items),
    getOrderById: vi.fn(async () => ({ id: 63721, orderNumber: "#63721", warehouseStatus: "exception", assignedPickerId: null })),
    updateOrderStatus: vi.fn(async () => ({ id: 63721, orderNumber: "#63721", warehouseStatus: "ready_to_ship" })),
    getUser: vi.fn(async () => null),
    createPickingLog: vi.fn(async () => ({})),
  };
  const service = new PickingUseCases(db as any, {} as any, {} as any, storage as any);
  return { service, db, tx, audit, storage };
}

describe("ready-to-ship blockers", () => {
  it("do not require a pick bin for an unmapped line", async () => {
    const { service, storage } = harness();
    await expect(service.markReadyToShip(63721)).resolves.toMatchObject({ warehouseStatus: "ready_to_ship" });
    expect(storage.updateOrderStatus).toHaveBeenCalledWith(63721, "ready_to_ship");
  });

  it("still require a pick bin for a stocked line", async () => {
    const { service, storage } = harness({ items: [{ ...stockedLine, location: "UNASSIGNED" }] });
    await expect(service.markReadyToShip(63721)).rejects.toThrow("EG-SLV-PF-P100 has no pick bin");
    expect(storage.updateOrderStatus).not.toHaveBeenCalled();
  });
});

describe("releaseClearedPickExceptions", () => {
  it("moves an exception order with no blocker left to ready_to_ship, under a guarded update, and audits it", async () => {
    const { service, db, tx, audit } = harness();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(service.releaseClearedPickExceptions(100, () => NOW))
      .resolves.toEqual({ checked: 1, released: 1, stillBlocked: 0, failed: 0 });

    const scan = text(db.execute.mock.calls[0][0]);
    expect(scan).toContain("wo.warehouse_status = 'exception'");
    expect(scan).toContain("wo.exception_resolution IS NULL");
    expect(scan).toContain("wo.on_hold = 0");
    const statements = tx.execute.mock.calls.map(([statement]) => text(statement));
    expect(statements[0]).toContain("FOR UPDATE");
    expect(statements[0]).toContain("exception_resolution IS NULL");
    expect(statements[1]).toContain("UPDATE wms.orders");
    expect(statements[1]).toContain("'exception'");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      timestamp: NOW,
      actionType: "exception_auto_cleared",
      pickerId: "system:pick-exception-recheck",
      orderId: 63721,
      orderNumber: "#63721",
      orderStatusBefore: "exception",
      orderStatusAfter: "ready_to_ship",
    }));
    log.mockRestore();
  });

  it("ignores a missing_variant blocker on an unmapped line, in both the rule and the pre-filter", async () => {
    // A picker who tried to give the UNKNOWN card a bin raised one; it records
    // the line's expected state, not a reason to hold the order.
    const { service, db } = harness();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await service.releaseClearedPickExceptions(100, () => NOW);
    const statements = db.execute.mock.calls.map(([statement]) => text(statement));
    const scan = statements[0];
    const rule = statements.find((statement) => statement.includes("blocking.review_reason"));
    for (const statement of [scan, rule]) {
      expect(statement).toContain("blocking.exception_type = 'missing_variant'");
      expect(statement).toContain("unmapped.catalog_product_id IS NULL");
      expect(statement).toContain("unmapped.product_id IS NULL");
    }
    log.mockRestore();
  });

  it("leaves an order that still has a blocker in exception without writing", async () => {
    const { service, db } = harness({ items: [unmappedLine, { ...stockedLine, location: "UNASSIGNED" }] });
    await expect(service.releaseClearedPickExceptions(100, () => NOW))
      .resolves.toEqual({ checked: 1, released: 0, stillBlocked: 1, failed: 0 });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("writes nothing when a lead decided or a hold landed after the scan", async () => {
    const { service, tx, audit } = harness({ lockedRow: false });
    await expect(service.releaseClearedPickExceptions(100, () => NOW))
      .resolves.toEqual({ checked: 1, released: 0, stillBlocked: 0, failed: 0 });
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it("keeps going when one order fails, and counts it", async () => {
    const { service, db } = harness({ candidates: [63720, 63721] });
    db.transaction.mockRejectedValueOnce(Object.assign(new Error("could not serialize access"), { code: "40001" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(service.releaseClearedPickExceptions(100, () => NOW))
      .resolves.toEqual({ checked: 2, released: 1, stillBlocked: 0, failed: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("\"error_code\":\"40001\""));
    error.mockRestore();
    log.mockRestore();
  });

  it("warns when the batch is full so delayed orders are visible", async () => {
    const { service } = harness({ candidates: [63721, 63722] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await service.releaseClearedPickExceptions(2, () => NOW);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("\"outcome\":\"batch_full\""));
    warn.mockRestore();
    log.mockRestore();
  });

  it.each([0, -1, 1.5, 501])("rejects a batch size of %s", async (limit) => {
    const { service, db } = harness();
    await expect(service.releaseClearedPickExceptions(limit, () => NOW)).rejects.toThrow("limit must be an integer");
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe("scheduled exception re-check", () => {
  const deps = { reservation: null, fulfillmentAuthority: {} as any };

  it("is a no-op when the picking service is not wired", async () => {
    await expect(releaseClearedPickExceptions(deps)).resolves.toEqual({ checked: 0, released: 0, stillBlocked: 0, failed: 0 });
  });

  it("delegates one bounded pass to the picking owner", async () => {
    const releaseClearedPickExceptionsOwner = vi.fn(async () => ({ checked: 3, released: 1, stillBlocked: 2, failed: 0 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(releaseClearedPickExceptions({
      ...deps, pickExceptions: { releaseClearedPickExceptions: releaseClearedPickExceptionsOwner },
    })).resolves.toEqual({ checked: 3, released: 1, stillBlocked: 2, failed: 0 });
    expect(releaseClearedPickExceptionsOwner).toHaveBeenCalledWith(100);
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
