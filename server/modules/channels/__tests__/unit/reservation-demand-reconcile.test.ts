import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import { createReservationService } from "../../reservation.service";

describe("legacy reservation demand reconciliation", () => {
  it("does not mutate reservations when a retry observed no new WMS demand change", async () => {
    const service = createService();
    const release = vi.spyOn(service, "releaseOrderReservation");
    const reserve = vi.spyOn(service, "reserveOrder");

    await expect(service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:900",
      demandChanged: false,
      reason: "order edited",
    })).resolves.toMatchObject({ reconciled: false });
    expect(release).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("retains the deployed release-then-reserve sequence for a changed legacy order", async () => {
    const service = createService();
    const release = vi.spyOn(service, "releaseOrderReservation").mockResolvedValue({
      released: 1,
      failed: [],
    });
    const reservation = {
      orderId: 42,
      reserved: 1,
      promised: 0,
      failed: [],
      totalBaseUnits: 1,
      totalPromisedBaseUnits: 0,
    };
    const reserve = vi.spyOn(service, "reserveOrder").mockResolvedValue(reservation);

    await expect(service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:900",
      demandChanged: true,
      reason: "order edited",
      userId: "user:7",
    })).resolves.toEqual({
      reconciled: true,
      release: { released: 1, failed: [] },
      reservation,
    });
    expect(release).toHaveBeenCalledWith(
      42,
      "order edited",
      "user:7",
      { disposition: "release" },
    );
    expect(reserve).toHaveBeenCalledWith(42, "user:7");
  });

  it("propagates one authority transaction through both legacy reconciliation steps", async () => {
    const service = createService();
    const dbOverride = { execute: vi.fn() };
    const release = vi.spyOn(service, "releaseOrderReservation").mockResolvedValue({
      released: 0,
      failed: [],
    });
    const reserve = vi.spyOn(service, "reserveOrder").mockResolvedValue({
      orderId: 42,
      reserved: 0,
      promised: 0,
      failed: [],
      totalBaseUnits: 0,
      totalPromisedBaseUnits: 0,
    });

    await service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:900",
      demandChanged: true,
      reason: "order edited",
      dbOverride,
    });

    expect(release).toHaveBeenCalledWith(
      42,
      "order edited",
      undefined,
      { disposition: "release", dbOverride },
    );
    expect(reserve).toHaveBeenCalledWith(42, undefined, dbOverride);
  });

  it("locks every refund target and product deterministically before grouped line releases", async () => {
    const dialect = new PgDialect();
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    let committed = false;
    const tx = {
      execute: vi.fn(async (query: any) => {
        const rendered = dialect.sqlToQuery(query);
        executed.push({ sql: rendered.sql, params: rendered.params });
        if (rendered.sql.includes("FROM wms.order_items oi")) {
          return { rows: [
            { order_item_id: 700, product_variant_id: 107, catalog_product_id: 5 },
            { order_item_id: 600, product_variant_id: 106, catalog_product_id: 3 },
          ] };
        }
        if (rendered.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
        throw new Error(`Unexpected grouped refund query: ${rendered.sql}`);
      }),
    };
    const db = {
      transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => {
        const result = await work(tx);
        committed = true;
        return result;
      }),
    };
    const channelSync = {
      queueSyncAfterInventoryChange: vi.fn(async () => {
        expect(committed).toBe(true);
      }),
    };
    const service = createService(db, channelSync);
    const release = vi.spyOn(service, "releaseOrderItemReservation")
      .mockImplementation(async (command) => ({
        orderId: command.orderId,
        orderItemId: command.orderItemId,
        productVariantId: command.orderItemId === 600 ? 106 : 107,
        requestedQuantity: command.quantity,
        previouslyReleasedQuantity: 0,
        releasedQuantity: command.quantity,
        openReservationAfter: 0,
        idempotentReplay: false,
      }));

    await expect(service.reconcileRefundOrderDemand({
      orderId: 42,
      sourceEventId: "refund:901",
      releaseTargets: [
        { orderItemId: 700, quantity: 2 },
        { orderItemId: 600, quantity: 1 },
      ],
      reason: "refund demand changed",
    })).resolves.toEqual({ releasedReservationQuantity: 3 });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(release.mock.calls.map(([command]) => command)).toEqual([
      expect.objectContaining({ orderItemId: 600, quantity: 1, dbOverride: tx }),
      expect.objectContaining({ orderItemId: 700, quantity: 2, dbOverride: tx }),
    ]);
    const productLocks = executed.filter((query) => query.sql.includes("pg_advisory_xact_lock"));
    expect(productLocks.map((query) => query.params)).toEqual([
      [918410, 3],
      [918410, 5],
    ]);
    expect(channelSync.queueSyncAfterInventoryChange.mock.calls).toEqual([[106], [107]]);
  });

  it("rejects duplicate refund targets before opening a transaction", async () => {
    const db = { transaction: vi.fn() };
    const service = createService(db);

    await expect(service.reconcileRefundOrderDemand({
      orderId: 42,
      sourceEventId: "refund:duplicate",
      releaseTargets: [
        { orderItemId: 600, quantity: 1 },
        { orderItemId: 600, quantity: 2 },
      ],
      reason: "refund demand changed",
    })).rejects.toThrow("duplicate order item 600");
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("queues affected variants again when a grouped refund is an idempotent replay", async () => {
    const dialect = new PgDialect();
    const tx = {
      execute: vi.fn(async (query: any) => {
        const rendered = dialect.sqlToQuery(query);
        if (rendered.sql.includes("FROM wms.order_items oi")) {
          return { rows: [
            { order_item_id: 600, product_variant_id: 106, catalog_product_id: 3 },
          ] };
        }
        if (rendered.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
        throw new Error(`Unexpected grouped refund replay query: ${rendered.sql}`);
      }),
    };
    const db = {
      transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const channelSync = { queueSyncAfterInventoryChange: vi.fn(async () => {}) };
    const service = createService(db, channelSync);
    vi.spyOn(service, "releaseOrderItemReservation").mockResolvedValue({
      orderId: 42,
      orderItemId: 600,
      productVariantId: 106,
      requestedQuantity: 1,
      previouslyReleasedQuantity: 1,
      releasedQuantity: 0,
      openReservationAfter: 0,
      idempotentReplay: true,
    });

    await expect(service.reconcileRefundOrderDemand({
      orderId: 42,
      sourceEventId: "refund:replay",
      releaseTargets: [{ orderItemId: 600, quantity: 1 }],
      reason: "refund demand changed",
    })).resolves.toEqual({ releasedReservationQuantity: 0 });

    expect(channelSync.queueSyncAfterInventoryChange).toHaveBeenCalledWith(106);
  });

  it("requires a post-commit registrar when grouped work joins an authority transaction", async () => {
    const transaction = { execute: vi.fn() };
    const service = createService();

    await expect(service.reconcileRefundOrderDemand({
      orderId: 42,
      sourceEventId: "refund:external-transaction",
      releaseTargets: [{ orderItemId: 600, quantity: 1 }],
      reason: "refund demand changed",
      dbOverride: transaction,
    })).rejects.toThrow("requires a post-commit effect registrar");
    expect(transaction.execute).not.toHaveBeenCalled();
  });
});

function createService(
  db: any = {},
  channelSync: any = { queueSyncAfterInventoryChange: vi.fn() },
) {
  return createReservationService(
    db,
    {} as never,
    channelSync,
    {} as never,
  );
}
