import { describe, expect, it, vi } from "vitest";
import { CustomerReturnCustomerOrdersService } from "../../application/customer-return-customer-orders.service";
import { CustomerReturnPreviewService } from "../../application/customer-return-preview.service";
import { CustomerReturnLiveError } from "../../application/customer-return-live-error";
import { CustomerReturnLiveService } from "../../application/customer-return-live.service";
import { LIVE_NOW, liveGid, liveLocalFixture, liveShop, liveShopifyFixture } from "../support/live-inspection-fixtures";
import { labelActivePolicy, labelSources } from "../support/label-fixtures";

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
  const choices = { read: vi.fn(async () => ({ orders: [{ omsOrderId: 7, orderReference: order.orderReference,
    purchasedAt: null, eligibleItemCount: null }], unavailableOrderCount: 0 })) };
  const service = new CustomerReturnCustomerOrdersService({ principal, access, live, choices, shippingVersion: async () => 2, reportUnavailableOrder });
  return { service, order, access, live, choices, candidate, principal, reportUnavailableOrder };
}

function setupLiveInspection() {
  const {local:localFacts,shopify:shopifyFacts} = labelSources();

  localFacts.order.externalCustomerId = "123";
  localFacts.order.shipToCountry = "United States";
  shopifyFacts.order.customerId = liveGid("Customer", "123");
  const live = new CustomerReturnLiveService({
    local: { listShops: async () => [liveShop], read: async () => structuredClone(localFacts) },
    shopify: { read: async () => structuredClone(shopifyFacts) },
    dimensions: { read: async () => null },
    policies: { read: async () => [labelActivePolicy()] },
    now: () => new Date(LIVE_NOW),
  });
  const candidate = { channelId: 36, omsOrderId: 100, externalOrderId: "1001", externalOrderNumber: "#0012-A" };
  const reportUnavailableOrder = vi.fn();
  const service = new CustomerReturnCustomerOrdersService({ principal: { channelId: 36, externalCustomerId: "123" },
    access: { list: async () => ({ orders: [candidate], nextBeforeOmsOrderId: null }), resolveOwned: async () => candidate },
    live, choices: { read: async () => ({ orders: [], unavailableOrderCount: 0 }) }, shippingVersion: async () => 2, reportUnavailableOrder });
  return { service, localFacts, shopifyFacts, reportUnavailableOrder };
}
describe("customer eligible-order list", () => {
  it("reads choices from the owned presentation cache without starting live inspections", async () => {
    const s = setup();
    const result = await s.service.choices({ beforeOmsOrderId: 9 });
    expect(s.access.list).toHaveBeenCalledExactlyOnceWith({ beforeOmsOrderId: 9, pageSize: 10 });
    expect(s.choices.read).toHaveBeenCalledExactlyOnceWith([s.candidate]);
    expect(result.orders[0].eligibleItemCount).toBeNull();
    expect(s.live.lookupCanonical).not.toHaveBeenCalled();
    expect(s.live.reviewCanonical).not.toHaveBeenCalled();
  });
  it("preserves the owned page cursor and rejects cache data for a different purchase", async () => {
    const s = setup();
    s.access.list.mockResolvedValue({ orders: [s.candidate], nextBeforeOmsOrderId: 7 });
    expect((await s.service.choices({})).nextBeforeOmsOrderId).toBe(7);
    s.choices.read.mockResolvedValue({ orders: [{ omsOrderId: 8, orderReference: s.order.orderReference,
      purchasedAt: null, eligibleItemCount: null }], unavailableOrderCount: 0 });
    await expect(s.service.choices({})).rejects.toMatchObject({ code: "RETURN_ORDER_CHOICES_SCOPE_MISMATCH", status: 503 });
    expect(s.live.lookupCanonical).not.toHaveBeenCalled();
  });
  it("does not turn a cache read failure into provider fan-out", async () => {
    const s = setup(); s.choices.read.mockRejectedValue(new Error("cache unavailable"));
    await expect(s.service.choices({})).rejects.toThrow("cache unavailable");
    expect(s.live.lookupCanonical).not.toHaveBeenCalled();
  });
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
    expect(s.reportUnavailableOrder).toHaveBeenCalledExactlyOnceWith({ channelId: 36, omsOrderId: 7,
      reason: "inspection_failed", causeCode: "RETURN_ORDER_INSPECTION_UNKNOWN" });
  });
  it.each([
    "RETURN_LIVE_DATA_UNVERIFIED", "RETURN_SHOPIFY_IDENTITY_MISMATCH",
    "RETURN_INSPECTION_DATA_INVALID", "RETURN_PORTAL_POLICY_AMBIGUOUS",
  ])("reports the safe typed cause %s without adding diagnostics to the customer response", async causeCode => {
    const s = setup();
    s.live.lookupCanonical.mockRejectedValue(new CustomerReturnLiveError(causeCode, "private provider credential", 503));
    expect(await s.service.list({})).toEqual({ orders: [], nextBeforeOmsOrderId: null, unavailableOrderCount: 1 });
    expect(s.reportUnavailableOrder).toHaveBeenCalledExactlyOnceWith({ channelId: 36, omsOrderId: 7,
      reason: "inspection_failed", causeCode });
    expect(JSON.stringify(s.reportUnavailableOrder.mock.calls)).not.toContain("credential");
  });
  it.each([
    ["an untyped error", Object.assign(new Error("private provider credential"), { code: "RETURN_LIVE_SECRET_CREDENTIAL" })],
    ["a plain object with a known code", { code: "RETURN_LIVE_DATA_UNVERIFIED", message: "private provider credential" }],
    ["an unregistered typed code", new CustomerReturnLiveError("RETURN_LIVE_SECRET_CREDENTIAL", "private details", 503)],
    ["a typed code with unsafe characters", new CustomerReturnLiveError("RETURN_LIVE_DATA_UNVERIFIED\ncredential=secret", "private details", 503)],
    ["an oversized typed code", new CustomerReturnLiveError("RETURN_LIVE_" + "SECRET".repeat(1000), "private details", 503)],
  ])("uses an opaque cause for %s", async (_description, error) => {
    const s = setup();
    s.live.lookupCanonical.mockRejectedValue(error);
    expect(await s.service.list({})).toEqual({ orders: [], nextBeforeOmsOrderId: null, unavailableOrderCount: 1 });
    expect(s.reportUnavailableOrder).toHaveBeenCalledExactlyOnceWith({ channelId: 36, omsOrderId: 7,
      reason: "inspection_failed", causeCode: "RETURN_ORDER_INSPECTION_UNKNOWN" });
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
    expect(await s.service.list({})).toEqual({ orders: [], nextBeforeOmsOrderId: null, unavailableOrderCount: 1 });
    expect(s.reportUnavailableOrder).toHaveBeenCalledExactlyOnceWith({ channelId: 36, omsOrderId: 7,
      reason: "invalid_response", causeCode: "RETURN_ORDER_RESPONSE_INVALID" });
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
  it("omits a verified historical cancelled order without reporting country aliases as a verification failure", async () => {
    const s = setupLiveInspection();
    s.localFacts.order.purchasedAt = "2017-09-01T12:00:00.000Z";
    s.shopifyFacts.order.createdAt = s.localFacts.order.purchasedAt;
    s.shopifyFacts.order.processedAt = s.localFacts.order.purchasedAt;
    s.localFacts.order.cancelledAt = "2017-09-02T12:00:00.000Z";
    s.shopifyFacts.order.cancelledAt = s.localFacts.order.cancelledAt;
    expect(await s.service.list({})).toEqual({ orders: [], nextBeforeOmsOrderId: null, unavailableOrderCount: 0 });
    expect(s.reportUnavailableOrder).not.toHaveBeenCalled();
  });
  it("lists a delivered owned order whose local country name matches Shopify's country code", async () => {
    const s = setupLiveInspection();
    const result = await s.service.list({});
    expect(result.orders.map(order => order.omsOrderId)).toEqual([100]);
    expect(result.orders[0].order.lines.map(line => line.eligibleQuantity)).toEqual([3, 1]);
    expect(result.unavailableOrderCount).toBe(0);
    expect(s.reportUnavailableOrder).not.toHaveBeenCalled();
  });
  it("keeps a genuine country mismatch unavailable and reports its classified cause", async () => {
    const s = setupLiveInspection();
    s.localFacts.order.shipToCountry = "Canada";
    expect(await s.service.list({})).toEqual({ orders: [], nextBeforeOmsOrderId: null, unavailableOrderCount: 1 });
    expect(s.reportUnavailableOrder).toHaveBeenCalledExactlyOnceWith({ channelId: 36, omsOrderId: 100,
      reason: "inspection_failed", causeCode: "RETURN_LIVE_DATA_UNVERIFIED" });
  });
});
