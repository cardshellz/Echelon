import { describe, expect, it, vi } from "vitest";
import { CustomerReturnLiveService } from "../../application/customer-return-live.service";
import { CustomerReturnLocalInspectionError } from "../../application/customer-return-local-inspection.ports";
import { CustomerReturnShopifySnapshotError } from "../../application/customer-return-shopify-snapshot.ports";
import { LIVE_NOW, addLiveOriginalBox, liveGid as gid, liveLocalFixture, liveNativeReturn, liveShop, liveShopifyFixture } from "../support/live-inspection-fixtures";
import { labelActivePolicy } from "../support/label-fixtures";

const lookup = { channelId: 36, orderReference: " # 0012-A " };
const boxDimensions = { lengthMm: 300, widthMm: 200, heightMm: 100 };
function setup() {
  const localFacts = liveLocalFixture(); const shopifyFacts = liveShopifyFixture();
  const local = { listShops: vi.fn(async () => [liveShop]), read: vi.fn(async () => structuredClone(localFacts)) };
  const shopify = { read: vi.fn(async () => structuredClone(shopifyFacts)) };
  const dimensions = { read: vi.fn(async () => ({ ...boxDimensions })) };
  const reportBoxDiagnostic = vi.fn();
  const now = vi.fn(() => new Date(LIVE_NOW));
  const policies = { read: vi.fn(async () => [labelActivePolicy()]) };
  const service = new CustomerReturnLiveService({ local, shopify, dimensions, policies, reportBoxDiagnostic, now });
  return { service, local, shopify, dimensions, policies, reportBoxDiagnostic, now, localFacts, shopifyFacts };
}
function setupCanonical(externalCustomerId = "901") {
  const s = setup();
  s.localFacts.order.externalCustomerId = externalCustomerId;
  s.shopifyFacts.order.customerId = externalCustomerId.startsWith("gid://") ? externalCustomerId : gid("Customer", externalCustomerId);
  const scope = { channelId: 36, omsOrderId: 100, externalOrderId: "1001", externalCustomerId };
  return { ...s, scope };
}
async function reviewInput(service: CustomerReturnLiveService) {
  const order = await service.lookup(lookup);
  return { ...lookup, sourceRevision: order.sourceRevision,
    selections: [{ lineId: order.lines[0].id, quantity: 2, reasonCode: null }, { lineId: order.lines[1].id, quantity: 1, reasonCode: null }],
    parcels: [{ dimensions: { ...boxDimensions }, originalBoxId: null as string | null,
      items: [{ lineId: order.lines[0].id, quantity: 1 }, { lineId: order.lines[1].id, quantity: 1 }] },
      { dimensions: { ...boxDimensions }, originalBoxId: null as string | null, items: [{ lineId: order.lines[0].id, quantity: 1 }] }],
  };
}

describe("private live order inspection", () => {
  it("verifies chooser eligibility without requesting optional box measurements", async () => {
    const s = setupCanonical();
    addLiveOriginalBox(s.localFacts);
    const summary = await s.service.lookupCanonicalSummary(s.scope);
    expect(s.dimensions.read).not.toHaveBeenCalled();
    expect(s.local.read).toHaveBeenCalledTimes(2);
    expect(s.shopify.read).toHaveBeenCalledTimes(1);
    expect(summary.boxOptions).toEqual([]);
    const full = await s.service.lookupCanonical(s.scope);
    expect(s.dimensions.read).toHaveBeenCalled();
    expect(full.boxOptions).toHaveLength(1);
    expect(summary.lines).toEqual(full.lines);
    expect(summary.sourceRevision).toBe(full.sourceRevision);
  });

  it("does not omit ownership verification from the faster chooser inspection", async () => {
    const s = setupCanonical();
    s.shopifyFacts.order.customerId = gid("Customer", 902);
    await expect(s.service.lookupCanonicalSummary(s.scope)).rejects.toMatchObject({ code: "RETURN_LIVE_ORDER_NOT_FOUND" });
    expect(s.dimensions.read).not.toHaveBeenCalled();
  });
  it.each(["901", gid("Customer", 901), "900719925474099312345", gid("Customer", "900719925474099312345")])(
    "matches the provider owner and repeats exact canonical local scope without loss for %s", async externalCustomerId => {
    const s = setupCanonical(externalCustomerId);
    const order = await s.service.lookupCanonical(s.scope);
    expect(order.lines[0].eligibleQuantity).toBe(2);
    expect(s.local.read).toHaveBeenCalledTimes(2);
    for (const call of s.local.read.mock.calls) expect(call).toEqual([{ channelId: 36, connectionId: 4,
      canonicalOrder: { omsOrderId: 100, externalOrderId: "1001", externalCustomerId } }]);
    expect(JSON.stringify(order)).not.toContain("customerId");
  });
  it.each(["customer", "canonical", "channel"])("rejects changed %s ownership during provider reads", async change => {
    const s = setupCanonical();
    s.shopify.read.mockImplementation(async () => {
      if (change === "customer") s.localFacts.order.externalCustomerId = "other-customer";
      if (change === "canonical") s.localFacts.order.omsOrderId = 101;
      if (change === "channel") s.localFacts.order.channelId = 37;
      return structuredClone(s.shopifyFacts);
    });
    await expect(s.service.inspectCanonicalForIntake(s.scope)).rejects.toMatchObject({ code: "RETURN_LIVE_ORDER_NOT_FOUND" });
    expect(s.local.read).toHaveBeenCalledTimes(2);
  });
  it("rejects an unowned first observation before provider I/O even with the same display number", async () => {
    const s = setupCanonical();
    s.localFacts.order.externalCustomerId = "other-customer";
    await expect(s.service.lookupCanonical(s.scope))
      .rejects.toMatchObject({ code: "RETURN_LIVE_ORDER_NOT_FOUND" });
    expect(s.shopify.read).not.toHaveBeenCalled();
  });
  it("rechecks canonical ownership for review, including absence from the second scoped read", async () => {
    const s = setupCanonical();
    const input = await reviewInput(s.service);
    expect((await s.service.reviewCanonical(input, s.scope)).effects).toBe("none");
    s.local.read.mockResolvedValueOnce(structuredClone(s.localFacts)).mockResolvedValueOnce(null as never);
    await expect(s.service.reviewCanonical(input, s.scope)).rejects.toMatchObject({ code: "RETURN_LIVE_REVIEW_CHANGED" });
  });
  it.each([null, undefined, gid("Customer", 902)])("denies canonical access without the matching provider owner: %s", async customerId => {
    const s = setupCanonical();
    s.shopifyFacts.order.customerId = customerId;
    addLiveOriginalBox(s.localFacts);
    await expect(s.service.lookupCanonical(s.scope)).rejects.toMatchObject({ code: "RETURN_LIVE_ORDER_NOT_FOUND", status: 404 });
    await expect(s.service.inspectCanonicalForIntake(s.scope)).rejects.toMatchObject({ code: "RETURN_LIVE_ORDER_NOT_FOUND", status: 404 });
    expect(s.dimensions.read).not.toHaveBeenCalled();
  });
  it.each(["901", gid("Order", 901), gid("Customer", "0901"), gid("Customer", "901/subpath")])(
    "rejects malformed snapshot customer identity %s", async customerId => {
      const s = setupCanonical();
      s.shopifyFacts.order.customerId = customerId;
      await expect(s.service.lookupCanonical(s.scope)).rejects.toMatchObject({ code: "RETURN_LIVE_DATA_UNVERIFIED", status: 503 });
    },
  );
  it.each(["customer-901", "0901", "9.01e2", gid("Order", 901), gid("Customer", "901/subpath")])(
    "rejects malformed trusted customer identity %s", async externalCustomerId => {
      const s = setupCanonical(externalCustomerId);
      s.shopifyFacts.order.customerId = gid("Customer", 901);
      await expect(s.service.lookupCanonical(s.scope)).rejects.toMatchObject({ code: "RETURN_LIVE_IDENTITY_INVALID", status: 503 });
    },
  );
  it("does not conflate neighboring customer IDs above the safe integer limit", async () => {
    const s = setupCanonical("900719925474099312344");
    s.shopifyFacts.order.customerId = gid("Customer", "900719925474099312345");
    await expect(s.service.lookupCanonical(s.scope)).rejects.toMatchObject({ code: "RETURN_LIVE_ORDER_NOT_FOUND", status: 404 });
  });
  it.each([null, undefined, gid("Customer", 902)])("freshly denies review when the provider owner changes: %s", async customerId => {
    const s = setupCanonical();
    const input = await reviewInput(s.service);
    s.shopifyFacts.order.customerId = customerId;
    await expect(s.service.reviewCanonical(input, s.scope)).rejects.toMatchObject({ code: "RETURN_LIVE_ORDER_NOT_FOUND", status: 404 });
  });
  it("keeps staff-only snapshots without provider customer evidence backward compatible", async () => {
    const s = setup();
    expect(s.shopifyFacts.order.customerId).toBeUndefined();
    await expect(s.service.lookup(lookup)).resolves.toMatchObject({ orderReference: "0012-A" });
  });
  it.each(["version", "identity", "inspection"])("uses the winning window and binds same-window policy %s to review", async (change) => {
    const s = setup();
    s.policies.read.mockResolvedValue([labelActivePolicy({ returnWindowDays: 30 })]);
    const initial = await s.service.lookup(lookup);
    expect(Date.parse(initial.returnWindowEndsAt) - Date.parse(initial.purchasedAt)).toBe(30 * 86_400_000);
    const input = await reviewInput(s.service);
    s.policies.read.mockResolvedValue([labelActivePolicy({ returnWindowDays: 30,
      ...(change === "version" ? { version: 2 } : change === "identity" ? { id: 2 } : { inspectionRequirement: "conditional" }) })]);
    await expect(s.service.review(input)).rejects.toMatchObject({ code: "RETURN_LIVE_REVIEW_CHANGED" });
  });
  it("rejects a policy changed during provider observation", async () => {
    const s = setup();
    s.policies.read.mockResolvedValueOnce([labelActivePolicy()]).mockResolvedValueOnce([labelActivePolicy({ returnWindowDays: 30 })]);
    await expect(s.service.lookup(lookup)).rejects.toMatchObject({ code: "RETURN_LIVE_REVIEW_CHANGED" });
  });
  it("never reads Shopify when the current winning policy is unsupported or missing", async () => {
    const s = setup();
    s.policies.read.mockResolvedValue([]);
    await expect(s.service.lookup(lookup)).rejects.toMatchObject({ code: "RETURN_PORTAL_POLICY_MISSING" });
    s.policies.read.mockResolvedValue([labelActivePolicy({ returnWindowDays: 0 })]);
    await expect(s.service.lookup(lookup)).rejects.toMatchObject({ code: "RETURN_PORTAL_POLICY_UNSUPPORTED" });
    expect(s.shopify.read).not.toHaveBeenCalled();
  });
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
  it.each(["United States", "United States of America", "USA", " u.s. ", "us"])(
    "verifies a stored country alias %s without changing ownership, quantities, or raw evidence", async country => {
      const s = setupCanonical();
      s.localFacts.order.shipToCountry = country;
      const before = structuredClone(s.localFacts);
      const order = await s.service.lookupCanonical(s.scope);
      expect(order.lines.map(line => line.eligibleQuantity)).toEqual([2, 1]);
      const review = await reviewInput(s.service);
      await expect(s.service.reviewCanonical(review, s.scope)).resolves.toMatchObject({ effects: "none" });
      expect(s.localFacts).toEqual(before);
      s.shopifyFacts.order.customerId = gid("Customer", 902);
      await expect(s.service.lookupCanonical(s.scope)).rejects.toMatchObject({ code: "RETURN_LIVE_ORDER_NOT_FOUND" });
    },
  );
  it("inspects a historical cancelled, unfulfilled order stored with a full country name as ineligible", async () => {
    const s = setupCanonical();
    const purchasedAt = "2021-10-18T15:30:08.000Z";
    s.localFacts.order.shipToCountry = "United States";
    s.localFacts.order.purchasedAt = purchasedAt;
    s.localFacts.lines = [{ ...s.localFacts.lines[0], quantity: 1 }];
    s.shopifyFacts.order.createdAt = purchasedAt;
    s.shopifyFacts.order.processedAt = purchasedAt;
    s.shopifyFacts.order.cancelledAt = "2021-10-19T10:25:19.000Z";
    s.shopifyFacts.lines = [{ ...s.shopifyFacts.lines[0], quantity: 1, currentQuantity: 0, refundableQuantity: 0 }];
    s.shopifyFacts.fulfillments = [];
    for (const order of [await s.service.lookup(lookup), await s.service.lookupCanonical(s.scope)]) {
      expect(order.message).toContain("canceled");
      expect(order.lines).toHaveLength(1);
      expect(order.lines[0]).toMatchObject({ purchasedQuantity: 1, deliveredQuantity: 0, eligibleQuantity: 0 });
    }
  });
  it.each(["", "   ", "Freedonia", "XX", "constructor", "__proto__"])(
    "never treats unknown stored country %j as a verified missing or US destination", async country => {
      for (const providerCountry of [null, "US"]) {
        const s = setupCanonical();
        s.localFacts.order.shipToCountry = country;
        s.shopifyFacts.order.destinationCountryCode = providerCountry;
        await expect(s.service.lookupCanonical(s.scope)).rejects.toMatchObject({ code: "RETURN_LIVE_DATA_UNVERIFIED" });
      }
    },
  );
  it("keeps missing and verified foreign destinations ineligible and rejects conflicting countries", async () => {
    for (const [localCountry, providerCountry] of [[null, null], ["Canada", "CA"]]) {
      const s = setupCanonical();
      s.localFacts.order.shipToCountry = localCountry;
      s.shopifyFacts.order.destinationCountryCode = providerCountry;
      const order = await s.service.lookupCanonical(s.scope);
      expect(order.lines.every(line => line.eligibleQuantity === 0)).toBe(true);
      expect(order.message).toContain("U.S. orders only");
    }
    const s = setupCanonical();
    s.localFacts.order.shipToCountry = "United States";
    s.shopifyFacts.order.destinationCountryCode = "CA";
    await expect(s.service.lookupCanonical(s.scope)).rejects.toMatchObject({ code: "RETURN_LIVE_DATA_UNVERIFIED" });
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
    expect(result.parcels.map(parcel => parcel.weightGrams)).toEqual([33, 13]);
    expect(result.parcels.map(parcel => parcel.dimensions)).toEqual([boxDimensions, boxDimensions]);
    expect(local.read).toHaveBeenCalledTimes(4); expect(shopify.read).toHaveBeenCalledTimes(2);
  });
  it("invalidates a reviewed plan after a newly created native return", async () => {
    const { service, shopifyFacts } = setup(); const input = await reviewInput(service); shopifyFacts.returns = [liveNativeReturn()];
    await expect(service.review(input)).rejects.toMatchObject({ code: "RETURN_LIVE_REVIEW_CHANGED", status: 409 });
  });
  it("keeps missing weight separate from eligibility and requires verification before review", async () => {
    const { service, localFacts } = setup(); localFacts.lines[0].unitWeightGrams = null;
    const order = await service.lookup(lookup);
    expect(order.lines[0]).toMatchObject({ eligibleQuantity: 2, unitWeightGrams: null });
    await expect(service.review(await reviewInput(service))).rejects.toMatchObject({ code: "RETURN_LIVE_WEIGHT_INVALID", status: 409 });
  });
  it("does not accept a browser-supplied parcel weight", async () => {
    const { service } = setup(); const input = await reviewInput(service);
    await expect(service.review({ ...input, parcels: input.parcels.map(parcel => ({ ...parcel, weightGrams: 1 })) }))
      .rejects.toMatchObject({ code: "RETURN_LIVE_INPUT_INVALID", status: 400 });
  });
  it("binds changed product weights to the reviewed source revision", async () => {
    const { service, localFacts } = setup(); const input = await reviewInput(service);
    localFacts.lines[0].unitWeightGrams = 12.35;
    await expect(service.review(input)).rejects.toMatchObject({ code: "RETURN_LIVE_REVIEW_CHANGED", status: 409 });
  });
  it("rereads verified original box sizes and invalidates a changed measurement", async () => {
    const { service, localFacts, dimensions } = setup(); addLiveOriginalBox(localFacts);
    const order = await service.lookup(lookup);
    expect(order.boxOptions).toHaveLength(1);
    expect(order.boxOptions[0].items).toEqual(expect.arrayContaining([
      { lineId: order.lines[0].id, quantity: 2 }, { lineId: order.lines[1].id, quantity: 1 },
    ]));
    const input = await reviewInput(service);
    input.parcels[0].originalBoxId = order.boxOptions[0].id;
    expect((await service.review(input)).parcels[0].weightGrams).toBe(33);
    expect(dimensions.read).toHaveBeenCalledTimes(3);
    dimensions.read.mockResolvedValue({ ...boxDimensions, lengthMm: 301 });
    await expect(service.review(input)).rejects.toMatchObject({ code: "RETURN_LIVE_PARCELS_INVALID", status: 400 });
    dimensions.read.mockRejectedValue(new Error("private provider failure"));
    await expect(service.review(input)).rejects.toMatchObject({ code: "RETURN_LIVE_PARCELS_INVALID", status: 400 });
  });
  it("keeps manual sizing and exact eligible quantities available during a dimensions outage", async () => {
    const { service, localFacts, dimensions, reportBoxDiagnostic } = setup(); addLiveOriginalBox(localFacts);
    dimensions.read.mockRejectedValue(new Error("private provider failure"));
    const order = await service.lookup(lookup);
    expect(order.boxOptions).toEqual([]);
    expect(order.lines.map(line => line.eligibleQuantity)).toEqual([2, 1]);
    expect((await service.review(await reviewInput(service))).parcels.map(parcel => parcel.weightGrams)).toEqual([33, 13]);
    expect(JSON.stringify(reportBoxDiagnostic.mock.calls)).not.toContain("private provider failure");
  });
  it("keeps custom-box review stable when optional original dimensions become available", async () => {
    const { service, localFacts, dimensions } = setup(); addLiveOriginalBox(localFacts);
    dimensions.read.mockRejectedValue(new Error("private provider failure"));
    const input = await reviewInput(service);
    dimensions.read.mockResolvedValue({ ...boxDimensions });
    expect((await service.review(input)).parcels.map(parcel => parcel.weightGrams)).toEqual([33, 13]);
  });
  it("suppresses a combined package's preset without changing eligible quantities for this order", async () => {
    const { service, localFacts, dimensions } = setup(); addLiveOriginalBox(localFacts);
    localFacts.packageItems.push({ ...localFacts.packageItems[0], physicalShipmentItemId: 999,
      wmsOrderItemId: 999, omsOrderLineId: 999, originalQuantity: 1, effectiveQuantity: 1 });
    const order = await service.lookup(lookup);
    expect(order.boxOptions).toEqual([]);
    expect(order.lines.map(line => line.eligibleQuantity)).toEqual([2, 1]);
    expect(dimensions.read).not.toHaveBeenCalled();
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
