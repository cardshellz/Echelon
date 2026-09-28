import { describe, expect, it, vi } from "vitest";
import { CustomerReturnCustomerOrdersService } from "../../application/customer-return-customer-orders.service";
import { CustomerReturnPreviewService } from "../../application/customer-return-preview.service";

function setup() {
  const samples = new CustomerReturnPreviewService();
  const scenario = samples.getState().scenarios[0];
  const { mode: _mode, scenarioId: _scenarioId, ...sample } = samples.lookup({ scenarioId: scenario.id, orderReference: scenario.orderReference });
  const order = { ...sample, mode: "admin_live" as const, sourceRevision: "a".repeat(64) };
  const principal = { channelId: 36, externalCustomerId: "123" };
  const candidate = { channelId: 36, omsOrderId: 7, externalOrderId: "7000", externalOrderNumber: order.orderReference };
  const access = { list: vi.fn(async () => ({ orders: [candidate], nextBeforeOmsOrderId: null as number | null })), resolveOwned: vi.fn(async () => candidate) };
  const live = { lookupCanonical: vi.fn(async () => order), reviewCanonical: vi.fn() };
  const reportUnavailableOrder = vi.fn();
  const service = new CustomerReturnCustomerOrdersService({ principal, access, live, shippingVersion: async () => 2, reportUnavailableOrder });
  return { service, order, access, live, candidate, principal, reportUnavailableOrder };
}
describe("customer eligible-order list", () => {
  it("passes only trusted canonical identity to the live verifier and removes private mode", async () => {
    const { service, live, principal } = setup();
    const result = await service.list({});
    expect(result.orders).toHaveLength(1);
    expect(live.lookupCanonical).toHaveBeenCalledWith({ ...principal, omsOrderId: 7, externalOrderId: "7000" });
    expect(JSON.stringify(result)).not.toContain("admin_live");
    expect(JSON.stringify(result)).not.toContain("externalCustomerId");
  });
  it("hides ineligible candidates while preserving continuation across empty pages", async () => {
    const s = setup(); s.access.list.mockResolvedValue({ orders: [s.candidate], nextBeforeOmsOrderId: 7 });
    s.live.lookupCanonical.mockResolvedValue({ ...s.order, lines: s.order.lines.map(line => ({ ...line, eligibleQuantity: 0 })) });
    expect(await s.service.list({ beforeOmsOrderId: 9 })).toEqual({ orders: [], nextBeforeOmsOrderId: 7, unavailableOrderCount: 0 });
    expect(s.access.list).toHaveBeenCalledWith({ beforeOmsOrderId: 9, pageSize: 10 });
  });
  it("reports provider failures instead of claiming the customer has no orders", async () => {
    const s = setup(); s.live.lookupCanonical.mockRejectedValue(new Error("provider unavailable"));
    expect(await s.service.list({})).toEqual({ orders: [], nextBeforeOmsOrderId: null, unavailableOrderCount: 1 });
    expect(s.reportUnavailableOrder).toHaveBeenCalledExactlyOnceWith({ channelId: 36, omsOrderId: 7, reason: "inspection_failed" });
  });
  it("preserves verified orders and pagination when another order cannot be verified", async () => {
    const s = setup();
    s.access.list.mockResolvedValue({ orders: [s.candidate, { ...s.candidate, omsOrderId: 6 }], nextBeforeOmsOrderId: 6 });
    s.live.lookupCanonical.mockRejectedValueOnce(new Error("provider credential must not be logged"));
    const result = await s.service.list({});
    expect(result.orders.map(order => order.omsOrderId)).toEqual([6]);
    expect(result).toMatchObject({ nextBeforeOmsOrderId: 6, unavailableOrderCount: 1 });
    expect(JSON.stringify(s.reportUnavailableOrder.mock.calls)).not.toContain("credential");
  });
  it("reports invalid provider output without exposing the malformed order", async () => {
    const s = setup();
    s.live.lookupCanonical.mockResolvedValue({ ...s.order, sourceRevision: "bad" });
    expect((await s.service.list({})).unavailableOrderCount).toBe(1);
    expect(s.reportUnavailableOrder).toHaveBeenCalledWith({ channelId: 36, omsOrderId: 7, reason: "invalid_response" });
  });
  it("rejects client-supplied channel or customer scope", async () => {
    const s = setup();
    await expect(s.service.list({ channelId: 37 })).rejects.toThrow();
    await expect(s.service.list({ externalCustomerId: "other" })).rejects.toThrow();
    expect(s.access.list).not.toHaveBeenCalled();
  });
  it("checks order ownership before querying Shopify on a direct selection", async () => {
    const s = setup(); s.access.resolveOwned.mockRejectedValue(new Error("not owned"));
    await expect(s.service.order(8)).rejects.toThrow("not owned");
    expect(s.live.lookupCanonical).not.toHaveBeenCalled();
  });
});
