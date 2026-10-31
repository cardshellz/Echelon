import { describe, expect, it } from "vitest";
import {
  complexHistory,
  complexProvider,
} from "../../../returns/__tests__/support/complex-return-scenario";
import {
  deriveSalesChannelDeliveryEvidence,
  latestSalesChannelDeliveryEvidence,
  mergeDeliveryStatus,
} from "../../sales-channel-delivery.domain";

function fixture() {
  const snapshot = complexProvider();
  return {
    snapshot,
    history: complexHistory(snapshot),
    now: new Date(snapshot.observedAt),
  };
}
describe("historical shipping evidence retains source identity and physical meaning", () => {
  it("uses an explicit delivered timestamp on the unique physical fulfillment, never membership fulfillment alone", () => {
    const s = fixture();
    const evidence = deriveSalesChannelDeliveryEvidence(
      s.history,
      "901",
      s.snapshot,
      s.now,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      canonicalStatus: "delivered",
      source: "shopify_fulfillment",
      fulfillmentId: "601",
      providerReference: "901",
    });
    s.snapshot.fulfillments[0].displayStatus = "FULFILLED";
    s.snapshot.fulfillments[0].deliveredAt = null;
    expect(
      deriveSalesChannelDeliveryEvidence(s.history, "901", s.snapshot, s.now),
    ).toEqual([]);
  });
  it.each(["channel", "connection", "shop", "order", "customer"])(
    "rejects substituted %s ownership",
    (field) => {
      const s = fixture();
      if (field === "channel") s.snapshot.shop.channelId++;
      if (field === "connection") s.snapshot.shop.connectionId++;
      if (field === "shop") s.snapshot.shop.shopDomain = "other.myshopify.com";
      if (field === "order") s.snapshot.order.id = "gid://shopify/Order/999";
      if (field === "customer")
        s.snapshot.order.customerId = "gid://shopify/Customer/999";
      expect(() =>
        deriveSalesChannelDeliveryEvidence(s.history, "901", s.snapshot, s.now),
      ).toThrow("OWNER_MISMATCH");
    },
  );
  it("rejects changed fulfillment contents and missing exact fulfillment identity", () => {
    const s = fixture();
    s.snapshot.fulfillments[0].lines[0].quantity++;
    expect(() =>
      deriveSalesChannelDeliveryEvidence(s.history, "901", s.snapshot, s.now),
    ).toThrow("CONTENTS_CHANGED");
    s.snapshot.fulfillments.shift();
    expect(() =>
      deriveSalesChannelDeliveryEvidence(s.history, "901", s.snapshot, s.now),
    ).toThrow("FULFILLMENT_CHANGED");
  });
  it("does not spread a fulfillment event across ambiguous boxes or substituted tracking", () => {
    for (const mutation of [
      "two_trackers",
      "other_tracker",
      "cancelled",
      "two_packages",
    ]) {
      const s = fixture();
      if (mutation === "two_trackers")
        s.snapshot.fulfillments[0].tracking.push({
          number: "OTHER",
          company: "UPS",
        });
      if (mutation === "other_tracker")
        s.snapshot.fulfillments[0].tracking[0].number = "OTHER";
      if (mutation === "cancelled")
        s.snapshot.fulfillments[0].status = "CANCELLED";
      if (mutation === "two_packages")
        s.history.packages.push({
          ...s.history.packages[0],
          providerShipmentId: "9901",
        });
      expect(
        deriveSalesChannelDeliveryEvidence(s.history, "901", s.snapshot, s.now),
      ).toEqual([]);
    }
  });
  it("keeps future events out, retains real event IDs and resolves equal-time issues deterministically", () => {
    const s = fixture(),
      when = s.snapshot.fulfillments[0].deliveredAt!;
    s.snapshot.fulfillments[0].events = [
      {
        id: "gid://shopify/FulfillmentEvent/1",
        status: "DELIVERED",
        happenedAt: when,
      },
      {
        id: "gid://shopify/FulfillmentEvent/2",
        status: "DELAYED",
        happenedAt: when,
      },
      {
        id: "gid://shopify/FulfillmentEvent/3",
        status: "IN_TRANSIT",
        happenedAt: new Date(s.now.getTime() + 1000).toISOString(),
      },
    ];
    const events = deriveSalesChannelDeliveryEvidence(
      s.history,
      "901",
      s.snapshot,
      s.now,
    );
    expect(events).toHaveLength(2);
    expect(latestSalesChannelDeliveryEvidence(events)?.canonicalStatus).toBe(
      "exception",
    );
    expect(latestSalesChannelDeliveryEvidence([...events].reverse())).toEqual(
      latestSalesChannelDeliveryEvidence(events),
    );
  });
  it("does not use a future snapshot", () => {
    const s = fixture();
    s.snapshot.observedAt = new Date(s.now.getTime() + 1).toISOString();
    expect(() =>
      deriveSalesChannelDeliveryEvidence(s.history, "901", s.snapshot, s.now),
    ).toThrow("OWNER_MISMATCH");
  });
  it("does not let unknown or older tracking erase delivered evidence; a newer or equally dated issue wins", () => {
    const old = new Date("2025-12-29T00:00:00Z"),
      deliveredAt = new Date("2025-12-30T00:00:00Z"),
      newer = new Date("2026-01-01T00:00:00Z");
    const channel = { status: "delivered" as const, occurredAt: deliveredAt };
    expect(
      mergeDeliveryStatus({ status: "unknown", occurredAt: newer }, channel),
    ).toBe("delivered");
    expect(
      mergeDeliveryStatus({ status: "in_transit", occurredAt: old }, channel),
    ).toBe("delivered");
    expect(
      mergeDeliveryStatus({ status: "exception", occurredAt: newer }, channel),
    ).toBe("exception");
    expect(
      mergeDeliveryStatus(
        { status: "exception", occurredAt: deliveredAt },
        channel,
      ),
    ).toBe("exception");
    expect(
      mergeDeliveryStatus(
        { status: "delivered", occurredAt: deliveredAt },
        { status: "exception", occurredAt: deliveredAt },
      ),
    ).toBe("exception");
    expect(
      mergeDeliveryStatus({ status: "exception", occurredAt: null }, channel),
    ).toBe("exception");
  });
});
