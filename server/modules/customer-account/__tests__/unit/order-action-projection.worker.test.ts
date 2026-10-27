import { describe, expect, it, vi } from "vitest";
import { OrderActionProjectionWorker } from "../../application/order-action-projection.worker";
import type { OrderActionProjectionStore } from "../../application/order-action-projection.ports";
import type { CustomerOrderActionSnapshot } from "@shared/customer-account/order-actions";
import { CustomerReturnPreviewService } from "../../../returns/application/customer-return-preview.service";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const scope = { omsOrderId: 1, channelId: 36, connectionId: 4, externalOrderId: "99", externalCustomerId: "100",
  orderReference: "#fixture", generation: "3", leaseId: "00000000-0000-4000-8000-000000000001", attempts: 0 };
const snapshot: CustomerOrderActionSnapshot = { order: { connectionId: 4, omsOrderId: 1, orderNumber: "#fixture",
  currency: "USD", customerName: "Synthetic", customerEmail: null, activeOperationId: null, revision: "test",
  eligibility: { editable: true, reasons: [] }, lines: [], totalCents: 0, financialStatus: "Paid", warehouseStatus: "Not shipped" },
returnOrder: null, orderFailed: false, returnFailed: false };
function fixture(value: CustomerOrderActionSnapshot = structuredClone(snapshot)) {
  const store = { drainInvalidations: vi.fn<OrderActionProjectionStore["drainInvalidations"]>(async () => 1),
    seed: vi.fn<OrderActionProjectionStore["seed"]>(async () => 1), claim: vi.fn<OrderActionProjectionStore["claim"]>(async () => [scope]),
    complete: vi.fn<OrderActionProjectionStore["complete"]>(async () => true),
    fail: vi.fn<OrderActionProjectionStore["fail"]>(async () => undefined), read: vi.fn<OrderActionProjectionStore["read"]>() } satisfies OrderActionProjectionStore;
  const inspector = { inspect: vi.fn(async () => value) };
  const report = vi.fn();
  const worker = new OrderActionProjectionWorker({ store, inspector, now: () => new Date(NOW), newId: () => scope.leaseId, report });
  return { worker, store, inspector, report, value };
}
describe("background customer order action projection", () => {
  it("leases only immediately executable work and retains a bounded refresh deadline", async () => {
    const h = fixture(); await h.worker.run();
    expect(h.store.drainInvalidations).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(h.store.seed).toHaveBeenCalledExactlyOnceWith(200);
    expect(h.store.claim).toHaveBeenCalledExactlyOnceWith(2, NOW, scope.leaseId);
    expect(h.store.complete).toHaveBeenCalledExactlyOnceWith(scope, snapshot, NOW, new Date(NOW.getTime() + 60_000));
    expect(h.store.fail).not.toHaveBeenCalled();
  });
  it("retains independent verified actions when return inspection failed", async () => {
    const h = fixture({ ...snapshot, returnFailed: true }); await h.worker.run();
    expect(h.store.complete.mock.calls[0][1]).toMatchObject({ order: snapshot.order, returnFailed: true, returnOrder: null });
  });
  it("reports superseded evidence rather than publishing a late inspection", async () => {
    const h = fixture(); h.store.complete.mockResolvedValue(false); await h.worker.run();
    expect(h.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: "superseded", omsOrderId: 1 }));
  });
  it("uses bounded retry backoff and never logs provider messages", async () => {
    const h = fixture(); h.store.claim.mockResolvedValue([{ ...scope, attempts: 5 }]);
    h.inspector.inspect.mockRejectedValue(new Error("private token and address")); await h.worker.run();
    expect(h.store.fail).toHaveBeenCalledWith(expect.anything(), NOW, new Date(NOW.getTime() + 30 * 60_000), "ORDER_ACTION_INSPECTION_FAILED");
    expect(JSON.stringify(h.report.mock.calls)).not.toMatch(/token|address/);
    expect(h.store.complete).not.toHaveBeenCalled();
  });
  it("rejects invalid inspection output before persistence", async () => {
    const h = fixture(); h.inspector.inspect.mockResolvedValue({ ...snapshot, order: { ...snapshot.order!, totalCents: -1 } });
    await h.worker.run(); expect(h.store.complete).not.toHaveBeenCalled(); expect(h.store.fail).toHaveBeenCalledOnce();
  });
  it("refreshes return availability at the return-window boundary even without an event", async () => {
    const preview = new CustomerReturnPreviewService().lookup({ scenarioId: "split_delivered", orderReference: "TEST-1001" });
    const { mode: _mode, scenarioId: _scenario, ...order } = preview;
    const h = fixture({ ...snapshot, order: { ...snapshot.order!, eligibility: { editable: false, reasons: ["Shipped"] } },
      returnOrder: { omsOrderId: 1, settingsVersion: null, order: { ...order, sourceRevision: "a".repeat(64),
        returnWindowEndsAt: new Date(NOW.getTime() + 30_000).toISOString() } } });
    await h.worker.run(); expect(h.store.complete.mock.calls[0][3]).toEqual(new Date(NOW.getTime() + 30_000));
  });
});
