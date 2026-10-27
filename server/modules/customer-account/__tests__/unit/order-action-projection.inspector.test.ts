import { describe, expect, it, vi } from "vitest";
import { OrderActionProjectionInspectorService } from "../../application/order-action-projection.inspector";
import type { OrderEditOrder } from "@shared/order-edits/order-edit.contract";
import { OrderEditError } from "../../../order-edits/domain/order-edit-error";
import { CustomerReturnLiveError } from "../../../returns/application/customer-return-live-error";
import { CustomerReturnPreviewService } from "../../../returns/application/customer-return-preview.service";
import { customerOrderActionsSchema } from "@shared/customer-account/order-actions";
import { CustomerReturnLiveService } from "../../../returns/application/customer-return-live.service";
import { LIVE_NOW, liveGid, liveLocalFixture, liveShop, liveShopifyFixture } from "../../../returns/__tests__/support/live-inspection-fixtures";
import { labelActivePolicy } from "../../../returns/__tests__/support/label-fixtures";

const scope = { omsOrderId: 1, channelId: 36, connectionId: 4, externalOrderId: "99", externalCustomerId: "100",
  orderReference: "#TEST-1001", generation: "1", leaseId: "00000000-0000-4000-8000-000000000001", attempts: 0 };
const order: OrderEditOrder = { connectionId: 4, omsOrderId: 1, orderNumber: scope.orderReference,
  currency: "USD", customerName: "Synthetic", customerEmail: null, activeOperationId: null, revision: "test",
  eligibility: { editable: false, reasons: ["Shipped"] }, lines: [], totalCents: 0, financialStatus: "Paid", warehouseStatus: "Shipped",
  fulfillment: { code: "shipped", label: "Shipped" } };
function fixture() {
  const { mode: _mode, scenarioId: _scenario, ...fields } = new CustomerReturnPreviewService().lookup({ scenarioId: "split_delivered", orderReference: "TEST-1001" });
  const readEdit = vi.fn(async () => structuredClone(order));
  const inspectReturnAndRetainMeasurements = vi.fn(async () => ({ omsOrderId: 1, settingsVersion: null,
    order: { ...fields, sourceRevision: "a".repeat(64) } }));
  const report = vi.fn();
  const service = new OrderActionProjectionInspectorService({ readEdit, inspectReturnAndRetainMeasurements, report });
  return { service, readEdit, inspectReturnAndRetainMeasurements, report };
}
describe("order action inspection reuses existing capability owners", () => {
  it("publishes cancelled-order options without a failure across retries when the OMS receipt time differs", async () => {
    const local = liveLocalFixture();
    local.order.externalCustomerId = "100";
    local.order.purchasedAt = "2026-09-01T12:00:01.901Z";
    local.order.cancelledAt = LIVE_NOW;
    const provider = liveShopifyFixture();
    provider.order.customerId = liveGid("Customer", "100");
    provider.order.cancelledAt = LIVE_NOW;
    const sourceBefore = structuredClone({ local, provider });
    const returns = new CustomerReturnLiveService({
      local: { listShops: async () => [liveShop], read: async () => structuredClone(local) },
      shopify: { read: async () => structuredClone(provider) },
      policies: { read: async () => [labelActivePolicy()] }, now: () => new Date(LIVE_NOW),
    });
    const ownedScope = { ...scope, omsOrderId: 100, externalOrderId: "1001", orderReference: "#0012-A" };
    const report = vi.fn();
    const inspector = new OrderActionProjectionInspectorService({
      readEdit: async () => ({ ...order, omsOrderId: 100, orderNumber: ownedScope.orderReference,
        financialStatus: "Refunded", fulfillment: { code: "cancelled", label: "Cancelled" } }),
      inspectReturnAndRetainMeasurements: async () => {
        const { mode: _mode, ...fields } = await returns.lookupCanonical({ channelId: ownedScope.channelId,
          omsOrderId: ownedScope.omsOrderId, externalOrderId: ownedScope.externalOrderId,
          externalCustomerId: ownedScope.externalCustomerId });
        return { omsOrderId: 100, settingsVersion: null, order: fields };
      }, report,
    });
    const first = await inspector.inspect(ownedScope);
    const retried = await inspector.inspect({ ...ownedScope, attempts: 4 });
    expect(first).toEqual(retried);
    expect(first).toMatchObject({ orderFailed: false, returnFailed: false,
      returnOrder: { order: { purchasedAt: provider.order.createdAt, message: expect.stringContaining("canceled") } } });
    expect(first.returnOrder?.order.lines.every(line => line.eligibleQuantity === 0)).toBe(true);
    expect(first).not.toHaveProperty("failureClass");
    expect(report).not.toHaveBeenCalled();
    expect({ local, provider }).toEqual(sourceBefore);
  });
  it("accepts a legacy display reference without '#' while retaining exact external/order ownership", async () => {
    const h = fixture();
    const snapshot = await h.service.inspect({ ...scope, orderReference: "TEST-1001" });
    expect(snapshot).toMatchObject({ orderFailed: false, returnFailed: false, order: { orderNumber: "#TEST-1001" } });
    const dto = { externalOrderId: "99", orderReference: "TEST-1001", omsOrderId: 1, state: "ready",
      verifiedAt: "2026-10-27T12:00:00.000Z", validUntil: "2026-10-27T12:05:00.000Z", snapshot };
    expect(customerOrderActionsSchema.safeParse(dto).success).toBe(true);
    expect(customerOrderActionsSchema.safeParse({ ...dto, orderReference: "TEST-1002" }).success).toBe(false);
  });
  it("retains return actions independently of a failed edit inspection", async () => {
    const h = fixture(); h.readEdit.mockRejectedValue(new Error("transport failed"));
    expect(await h.service.inspect(scope)).toMatchObject({ order: null, orderFailed: true, returnFailed: false, returnOrder: { omsOrderId: 1 }, failureClass: "transient" });
  });
  it("keeps verified edit evidence and classifies policy faults as permanent", async () => {
    const h = fixture(); h.inspectReturnAndRetainMeasurements.mockRejectedValue(new CustomerReturnLiveError("RETURN_PORTAL_POLICY_MISSING", "private diagnostic", 409));
    expect(await h.service.inspect(scope)).toMatchObject({ order, returnOrder: null, returnFailed: true, orderFailed: false, failureClass: "permanent" });
    expect(JSON.stringify(h.report.mock.calls)).not.toContain("private");
  });
  it("does not infer return eligibility from a warehouse hold or edit restriction", async () => {
    const h = fixture(); h.readEdit.mockResolvedValue({ ...order, fulfillment: { code: "on_hold", label: "On hold" } });
    expect(await h.service.inspect(scope)).toMatchObject({ orderFailed: false, returnFailed: false, returnOrder: { omsOrderId: 1 } });
    expect(h.inspectReturnAndRetainMeasurements).toHaveBeenCalledOnce();
  });
  it("does not expose a mismatched cached order even if the other capability succeeds", async () => {
    const h = fixture(); h.readEdit.mockResolvedValue({ ...order, omsOrderId: 999 });
    expect(await h.service.inspect(scope)).toMatchObject({ order: null, orderFailed: true, returnFailed: false });
  });
  it("does not retry a permanent fault to resolve a different transient fault", async () => {
    const h = fixture(); h.readEdit.mockRejectedValue(new OrderEditError("ORDER_MISSING", "missing", 404));
    h.inspectReturnAndRetainMeasurements.mockRejectedValue(new Error("temporarily unavailable"));
    expect(await h.service.inspect(scope)).toMatchObject({ failureClass: "permanent", orderFailed: true, returnFailed: true });
  });
});
