import { describe, expect, it, vi } from "vitest";
import { CachedCustomerReturnOrderChoicesReader } from "../../infrastructure/customer-return-order-choices.reader";
import { CustomerReturnPreviewService } from "../../application/customer-return-preview.service";
import type { CustomerOrderActionPage } from "@shared/customer-account/order-actions";
import type { OrderActionProjectionReader } from "../../../customer-account/application/order-action-projection.ports";

const NOW = new Date("2026-10-30T12:00:00.000Z");
function fixture() {
  const samples = new CustomerReturnPreviewService();
  const scenario = samples.getState().scenarios[0];
  const { mode: _mode, scenarioId: _scenario, ...fields } = samples.lookup({ scenarioId: scenario.id, orderReference: scenario.orderReference });
  const owned = { channelId: 36, omsOrderId: 7, externalOrderId: "7000", externalOrderNumber: fields.orderReference };
  const row: CustomerOrderActionPage["orders"][number] = {
    externalOrderId: "7000", orderReference: fields.orderReference, omsOrderId: 7, state: "ready",
    verifiedAt: NOW.toISOString(), validUntil: "2026-10-30T12:10:00.000Z",
    snapshot: { order: null, orderFailed: false, returnFailed: false,
      returnOrder: { omsOrderId: 7, settingsVersion: 2, order: { ...fields, sourceRevision: "a".repeat(64) } } },
  };
  const read = vi.fn<OrderActionProjectionReader["read"]>(async () => ({ orders: [structuredClone(row)] }));
  const reader = new CachedCustomerReturnOrderChoicesReader({
    principal: { channelId: 36, externalCustomerId: "123" }, projection: { read }, now: () => NOW,
  });
  return { owned, row, read, reader };
}
describe("local return order chooser", () => {
  it("uses one ownership-scoped cache lookup without exposing its full document", async () => {
    const s = fixture(); const result = await s.reader.read([s.owned]);
    expect(s.read).toHaveBeenCalledExactlyOnceWith({ channelId: 36, externalCustomerId: "123",
      orders: [{ externalOrderId: "7000", orderReference: s.owned.externalOrderNumber }] }, NOW);
    expect(result.orders[0]).toEqual({ omsOrderId: 7, orderReference: s.owned.externalOrderNumber,
      purchasedAt: s.row.snapshot!.returnOrder!.order.purchasedAt,
      eligibleItemCount: s.row.snapshot!.returnOrder!.order.lines.reduce((sum, line) => sum + line.eligibleQuantity, 0) });
    expect(result.orders[0]).not.toHaveProperty("lines");
    expect(result.orders[0]).not.toHaveProperty("externalCustomerId");
  });
  it.each(["refreshing", "failed"] as const)("keeps owned purchases selectable while inspection is %s", async state => {
    const s = fixture(); s.read.mockResolvedValue({ orders: [{ ...s.row, state, snapshot: null }] });
    expect(await s.reader.read([s.owned])).toEqual({ orders: [{ omsOrderId: 7, orderReference: s.owned.externalOrderNumber,
      purchasedAt: null, eligibleItemCount: null }], unavailableOrderCount: 0 });
  });
  it("does not hide a purchase because only its return inspection failed", async () => {
    const s = fixture(); s.row.snapshot!.returnFailed = true; s.row.snapshot!.returnOrder = null;
    expect((await s.reader.read([s.owned])).orders[0].eligibleItemCount).toBeNull();
  });
  it("omits only a currently verified zero-quantity purchase", async () => {
    const s = fixture(); s.row.snapshot!.returnOrder!.order.lines.forEach(line => { line.eligibleQuantity = 0; });
    expect(await s.reader.read([s.owned])).toEqual({ orders: [], unavailableOrderCount: 0 });
  });
  it("does not reuse an identity whose current owner no longer matches", async () => {
    const s = fixture(); s.read.mockResolvedValue({ orders: [{ ...s.row, state: "not_managed", omsOrderId: null, snapshot: null }] });
    expect(await s.reader.read([s.owned])).toEqual({ orders: [], unavailableOrderCount: 1 });
  });
  it("rejects swapped purchase identities instead of displaying another order", async () => {
    const s = fixture(); s.read.mockResolvedValue({ orders: [{ ...s.row, externalOrderId: "8000" }] });
    await expect(s.reader.read([s.owned])).rejects.toMatchObject({ code: "RETURN_ORDER_CHOICES_IDENTITY_MISMATCH", status: 503 });
  });
  it("normalizes verified Shopify GIDs and retains the paired display reference", async () => {
    const s = fixture(); await s.reader.read([{ ...s.owned, externalOrderId: "gid://shopify/Order/7000" }]);
    expect(s.read.mock.calls[0][0].orders[0].externalOrderId).toBe("7000");
  });
  it("performs no lookup for empty pages and rejects foreign scope or duplicate IDs", async () => {
    const s = fixture(); expect(await s.reader.read([])).toEqual({ orders: [], unavailableOrderCount: 0 });
    await expect(s.reader.read([{ ...s.owned, channelId: 37 }])).rejects.toMatchObject({ code: "RETURN_ORDER_CHOICES_SCOPE_MISMATCH" });
    await expect(s.reader.read([s.owned, s.owned])).rejects.toMatchObject({ code: "RETURN_ORDER_CHOICES_DUPLICATE_IDENTITY" });
    expect(s.read).not.toHaveBeenCalled();
  });
  it("propagates a local read failure without a provider fallback", async () => {
    const s = fixture(); s.read.mockRejectedValue(new Error("local read unavailable"));
    await expect(s.reader.read([s.owned])).rejects.toThrow("local read unavailable");
  });
});
