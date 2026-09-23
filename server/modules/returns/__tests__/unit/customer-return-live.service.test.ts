import { describe, expect, it, vi } from "vitest";
import { CustomerReturnLiveService } from "../../application/customer-return-live.service";
import { CustomerReturnLocalInspectionError } from "../../application/customer-return-local-inspection.ports";
import { CustomerReturnShopifySnapshotError } from "../../application/customer-return-shopify-snapshot.ports";
import { LIVE_NOW, liveGid as gid, liveLocalFixture, liveNativeReturn, liveShop, liveShopifyFixture } from "../support/live-inspection-fixtures";

const lookup = { channelId: 36, orderReference: " # 0012-A " };
function setup() {
  const localFacts = liveLocalFixture(); const shopifyFacts = liveShopifyFixture();
  const local = { listShops: vi.fn(async () => [liveShop]), read: vi.fn(async () => structuredClone(localFacts)) };
  const shopify = { read: vi.fn(async () => structuredClone(shopifyFacts)) };
  const now = vi.fn(() => new Date(LIVE_NOW));
  const service = new CustomerReturnLiveService({ local, shopify, now });
  return { service, local, shopify, now, localFacts, shopifyFacts };
}
async function reviewInput(service: CustomerReturnLiveService) {
  const order = await service.lookup(lookup);
  return { ...lookup, sourceRevision: order.sourceRevision,
    selections: [{ lineId: order.lines[0].id, quantity: 2, reasonCode: null }, { lineId: order.lines[1].id, quantity: 1, reasonCode: null }],
    parcels: [{ items: [{ lineId: order.lines[0].id, quantity: 1 }, { lineId: order.lines[1].id, quantity: 1 }] },
      { items: [{ lineId: order.lines[0].id, quantity: 1 }] }],
  };
}

describe("private live order inspection", () => {
  it("offers exact delivered quantities across split shipments and same-SKU purchased lines", async () => {
    const { service, local, shopify } = setup();
    const order = await service.lookup(lookup);
    expect(order.orderReference).toBe("0012-A");
    expect(order.lines.map(line => [line.purchasedQuantity, line.deliveredQuantity, line.eligibleQuantity])).toEqual([[3, 2, 2], [1, 1, 1]]);
    expect(order.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(local.read).toHaveBeenCalledTimes(2);
    expect(shopify.read).toHaveBeenCalledWith({ shop: liveShop, externalOrderId: "1001" });
    expect(JSON.stringify(order)).not.toContain("gid://shopify/");
    expect(order).not.toHaveProperty("email"); expect(order).not.toHaveProperty("warehouse");
  });
  it("isolates a contradictory allocation while offering other delivered units of the same purchased line", async () => {
    const { service, shopifyFacts } = setup();
    shopifyFacts.fulfillments[1].deliveredAt = "2026-09-20T12:00:00.000Z";
    shopifyFacts.fulfillments[1].displayStatus = "DELIVERED";
    shopifyFacts.fulfillments[0].displayStatus = "NOT_DELIVERED";
    const order = await service.lookup(lookup);
    expect(order.lines[0]).toMatchObject({ deliveredQuantity: 1, eligibleQuantity: 1, message: expect.stringContaining("verification") });
    expect(order.lines[1].eligibleQuantity).toBe(1);
  });
  it("publishes only explicitly selected shops, and unconfigured mode stays empty", async () => {
    const { service, local, shopify } = setup();
    local.listShops.mockResolvedValue([]);
    expect(await service.getState()).toEqual({ mode: "admin_live", customerAccess: "disabled", effects: "none", shops: [] });
    await expect(service.lookup(lookup)).rejects.toMatchObject({ code: "RETURN_LIVE_SHOP_UNAVAILABLE" });
    expect(shopify.read).not.toHaveBeenCalled(); expect(local.read).not.toHaveBeenCalled();
  });
  it.each([{ channelId: 37 }, { orderReference: "##0012-A" }, { channelId: "36" }, { extraAuthority: true }])("rejects invalid or unselected lookup %j", async change => {
    const { service, shopify } = setup();
    await expect(service.lookup({ ...lookup, ...change })).rejects.toBeInstanceOf(Error);
    expect(shopify.read).not.toHaveBeenCalled();
  });
  it("does not mutate adapter snapshots", async () => {
    const { service, localFacts, shopifyFacts } = setup();
    const before = JSON.stringify({ localFacts, shopifyFacts });
    await service.lookup(lookup);
    expect(JSON.stringify({ localFacts, shopifyFacts })).toBe(before);
  });
  it("accepts lossless large Shopify identities", async () => {
    const { service, localFacts, shopifyFacts } = setup();
    localFacts.order.externalOrderId = "900719925474099312345";
    shopifyFacts.order.id = gid("Order", localFacts.order.externalOrderId);
    expect((await service.lookup(lookup)).lines[0].eligibleQuantity).toBe(2);
  });
  it.each(["shop", "order", "reference", "purchase", "country", "line", "quantity", "shipping"])("rejects conflicting %s identity", async kind => {
    const { service, shopifyFacts } = setup();
    if (kind === "shop") shopifyFacts.shop.connectionId = 5;
    if (kind === "order") shopifyFacts.order.id = gid("Order", 9999);
    if (kind === "reference") shopifyFacts.order.name = "#12-A";
    if (kind === "purchase") shopifyFacts.order.createdAt = "2026-09-02T12:00:00.000Z";
    if (kind === "country") shopifyFacts.order.destinationCountryCode = "CA";
    if (kind === "line") shopifyFacts.lines[0].id = gid("LineItem", 9999);
    if (kind === "quantity") shopifyFacts.lines[0].quantity = 4;
    if (kind === "shipping") shopifyFacts.lines[0].requiresShipping = false;
    await expect(service.lookup(lookup)).rejects.toMatchObject({ code: "RETURN_LIVE_DATA_UNVERIFIED" });
  });
  it("matches the ingested createdAt order date without conflating Shopify processedAt", async () => {
    const { service, shopifyFacts } = setup();
    shopifyFacts.order.processedAt = "2026-08-31T12:00:00.000Z";
    expect((await service.lookup(lookup)).purchasedAt).toBe(shopifyFacts.order.createdAt);
  });
  it("keeps domestic and cancellation policy separate from delivery", async () => {
    const first = setup(); first.localFacts.order.shipToCountry = "CA"; first.shopifyFacts.order.destinationCountryCode = "CA";
    expect((await first.service.lookup(lookup)).lines.every(line => line.eligibleQuantity === 0)).toBe(true);
    const second = setup(); second.shopifyFacts.order.cancelledAt = LIVE_NOW;
    expect((await second.service.lookup(lookup)).lines.every(line => line.eligibleQuantity === 0)).toBe(true);
  });
  it("counts CLOSED native returns and does not double-count their linked refund", async () => {
    const { service, shopifyFacts } = setup();
    const ret = liveNativeReturn(); ret.status = "CLOSED"; ret.lines[0].refundedQuantity = 1;
    shopifyFacts.returns = [ret];
    shopifyFacts.refunds = [{ id: gid("Refund", 1), updatedAt: LIVE_NOW, returnId: ret.id,
      lines: [{ id: gid("RefundLineItem", 1), lineItemId: gid("LineItem", 501), quantity: 1, restockType: "RETURN" }] }];
    expect((await service.lookup(lookup)).lines[0]).toMatchObject({ alreadyReturningQuantity: 1, eligibleQuantity: 1 });
  });
  it("does not allocate standalone refunded units to an arbitrary fulfillment", async () => {
    const { service, shopifyFacts } = setup();
    shopifyFacts.refunds = [{ id: gid("Refund", 1), updatedAt: LIVE_NOW, returnId: null,
      lines: [{ id: null, lineItemId: gid("LineItem", 501), quantity: 1, restockType: "NO_RESTOCK" }] }];
    expect((await service.lookup(lookup)).lines[0]).toMatchObject({ eligibleQuantity: 0, alreadyReturningQuantity: 0, message: expect.stringContaining("verification") });
  });
  it.each(["refund_overlap", "local_overlap", "unknown_history", "overclaim"])("rejects unreconciled %s without invented counts", async kind => {
    const { service, localFacts, shopifyFacts } = setup();
    shopifyFacts.returns = [liveNativeReturn(kind === "overclaim" ? 4 : 1)];
    if (kind === "refund_overlap") shopifyFacts.refunds = [{ id: gid("Refund", 1), updatedAt: LIVE_NOW, returnId: null,
      lines: [{ id: null, lineItemId: gid("LineItem", 501), quantity: 1, restockType: "RETURN" }] }];
    if (kind === "local_overlap") localFacts.rootClaims = [{ claimId: 1, authorizationId: 1, authorizationLineId: 1, channelId: 36,
      omsOrderId: 100, omsOrderLineId: 101, externalLineItemId: "501", wmsOrderItemId: 1,
      fulfillmentId: "601", fulfillmentLineItemId: "701", quantity: 1 }];
    if (kind === "unknown_history") localFacts.issues = [{ code: "unallocated_return_evidence", omsOrderLineId: null }];
    if (kind === "unknown_history") {
      await expect(service.lookup(lookup)).rejects.toMatchObject({ code: "RETURN_LIVE_EVIDENCE_UNRESOLVED" });
    } else {
      const order = await service.lookup(lookup);
      expect(order.lines[0]).toMatchObject({ eligibleQuantity: 0, alreadyReturningQuantity: null, message: expect.stringContaining("verification") });
      expect(order.lines[1].eligibleQuantity).toBe(1);
    }
  });
  it("isolates exactly scoped legacy history without fabricating a zero return count", async () => {
    const { service, localFacts } = setup();
    localFacts.issues = [{ code: "legacy_claim_allocation_unknown", omsOrderLineId: 101 }];
    const order = await service.lookup(lookup);
    expect(order.lines[0]).toMatchObject({ alreadyReturningQuantity: null, eligibleQuantity: 0 });
    expect(order.lines[1].eligibleQuantity).toBe(1);
  });
  it("does not use unrefunded return reservations to explain a removed quantity", async () => {
    const { service, shopifyFacts } = setup();
    shopifyFacts.returns = [liveNativeReturn()];
    shopifyFacts.lines[0].currentQuantity = 2;
    shopifyFacts.lines[0].refundableQuantity = 2;
    expect((await service.lookup(lookup)).lines[0]).toMatchObject({ eligibleQuantity: 0, message: expect.stringContaining("verification") });
  });
  it("does not offer unexplained removed or nonrefundable quantities", async () => {
    const { service, shopifyFacts } = setup(); shopifyFacts.lines[0].refundableQuantity = 2;
    expect((await service.lookup(lookup)).lines[0].eligibleQuantity).toBe(0);
  });
  it("rejects a local change during provider I/O", async () => {
    const { service, local, localFacts } = setup();
    local.read.mockResolvedValueOnce(structuredClone(localFacts));
    localFacts.order.cancelledAt = LIVE_NOW;
    await expect(service.lookup(lookup)).rejects.toMatchObject({ code: "RETURN_LIVE_REVIEW_CHANGED" });
  });
  it("ignores only observation time and collection ordering in a stable revision", async () => {
    const { service, now, localFacts, shopifyFacts } = setup();
    const first = await service.lookup(lookup);
    localFacts.observedAt = "2026-09-23T12:00:05.000Z"; shopifyFacts.observedAt = localFacts.observedAt;
    now.mockReturnValue(new Date(localFacts.observedAt)); localFacts.lines.reverse(); shopifyFacts.lines.reverse(); shopifyFacts.fulfillments.reverse();
    expect((await service.lookup(lookup)).sourceRevision).toBe(first.sourceRevision);
  });
  it.each(["2026-09-23T12:02:00.001Z", "2026-09-23T11:59:59.999Z"])("rejects stale or future observations at %s", async timestamp => {
    const { service, now } = setup(); now.mockReturnValue(new Date(timestamp));
    await expect(service.lookup(lookup)).rejects.toMatchObject({ code: "RETURN_LIVE_REVIEW_CHANGED" });
  });
  it("classifies malformed server-owned references as source errors, not customer input errors", async () => {
    const one = setup(); one.localFacts.order.externalOrderNumber = "##0012-A";
    await expect(one.service.lookup(lookup)).rejects.toMatchObject({ status: 503, code: "RETURN_LIVE_DATA_UNVERIFIED" });
    const two = setup(); two.shopifyFacts.order.name = "##0012-A";
    await expect(two.service.lookup(lookup)).rejects.toMatchObject({ status: 503, code: "RETURN_LIVE_DATA_UNVERIFIED" });
    const three = setup(); three.shopify.read.mockRejectedValue(new CustomerReturnShopifySnapshotError("RETURN_SHOPIFY_INPUT_INVALID"));
    await expect(three.service.lookup(lookup)).rejects.toMatchObject({ status: 503 });
  });
  it("sanitizes provider, local and unexpected failures", async () => {
    const one = setup(); one.shopify.read.mockRejectedValue(new CustomerReturnShopifySnapshotError("RETURN_SHOPIFY_SCOPE_MISSING"));
    await expect(one.service.lookup(lookup)).rejects.toMatchObject({ code: "RETURN_SHOPIFY_SCOPE_MISSING", status: 503 });
    const two = setup(); two.local.read.mockRejectedValue(new CustomerReturnLocalInspectionError("RETURN_INSPECTION_READ_FAILED", "secret connection"));
    await expect(two.service.lookup(lookup)).rejects.toMatchObject({ code: "RETURN_INSPECTION_READ_FAILED", message: expect.not.stringContaining("secret") });
    const three = setup(); three.shopify.read.mockRejectedValue(new Error("secret token"));
    await expect(three.service.lookup(lookup)).rejects.toMatchObject({ code: "RETURN_LIVE_DATA_UNVERIFIED", message: expect.not.stringContaining("secret") });
  });
});

describe("live box review", () => {
  it("freshly rereads sources and conserves every purchased line across boxes without effects", async () => {
    const { service, local, shopify } = setup(); const input = await reviewInput(service);
    const result = await service.review(input);
    expect(result).toMatchObject({ mode: "admin_live", sourceRevision: input.sourceRevision, selectedQuantity: 3, effects: "none", refundMethod: "manual_shopify" });
    expect(result.parcels.map(parcel => parcel.items.map(item => item.quantity))).toEqual([[1, 1], [1]]);
    expect(local.read).toHaveBeenCalledTimes(4); expect(shopify.read).toHaveBeenCalledTimes(2);
  });
  it("invalidates a reviewed plan after a newly created native return", async () => {
    const { service, shopifyFacts } = setup(); const input = await reviewInput(service); shopifyFacts.returns = [liveNativeReturn()];
    await expect(service.review(input)).rejects.toMatchObject({ code: "RETURN_LIVE_REVIEW_CHANGED", status: 409 });
  });
  it.each(["missing_box_unit", "extra_box_unit", "duplicate_selection", "duplicate_box_line", "unselected_line", "excess_selection"])("rejects %s", async kind => {
    const { service } = setup(); const input = await reviewInput(service);
    if (kind === "missing_box_unit") input.parcels.pop();
    if (kind === "extra_box_unit") input.parcels[1].items[0].quantity = 2;
    if (kind === "duplicate_selection") input.selections.push({ ...input.selections[0] });
    if (kind === "duplicate_box_line") input.parcels[0].items.push({ ...input.parcels[0].items[0] });
    if (kind === "unselected_line") input.parcels[1].items[0].lineId = gid("LineItem", 999);
    if (kind === "excess_selection") input.selections[0].quantity = 3;
    await expect(service.review(input)).rejects.toBeInstanceOf(Error);
  });
});
