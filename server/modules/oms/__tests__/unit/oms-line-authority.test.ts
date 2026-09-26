import { describe, expect, it } from "vitest";

import {
  deriveOmsLineAuthority,
  getOmsLineMaterializableQuantity,
  getOmsLineRemainingMaterializableQuantity,
} from "../../oms-line-authority";

const NOW = new Date("2026-06-25T12:00:00.000Z");

describe("OMS line authority", () => {
  it("records Shopify update-only lines as seen but not WMS-materializable", () => {
    const authority = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:1",
      sourceInboxId: 1,
      financialStatus: "paid",
      quantity: 2,
      fulfillableQuantity: 2,
      now: NOW,
    });

    expect(authority).toEqual({
      channelObservedQuantity: 2,
      paidQuantity: 0,
      authorityFulfillableQuantity: 0,
      authorizationStatus: "seen",
      authorizedAt: null,
      authorizedByEventId: null,
      authoritySourceTopic: "orders/updated",
      authoritySourceInboxId: 1,
    });
    expect(getOmsLineMaterializableQuantity(authority)).toBe(0);
  });

  it("authorizes paid Shopify lines for WMS materialization", () => {
    const authority = deriveOmsLineAuthority({
      sourceTopic: "orders/paid",
      sourceEventId: "webhook_inbox:2",
      sourceInboxId: 2,
      financialStatus: "paid",
      quantity: 3,
      fulfillableQuantity: 2,
      now: NOW,
    });

    expect(authority).toMatchObject({
      channelObservedQuantity: 3,
      paidQuantity: 3,
      authorityFulfillableQuantity: 2,
      authorizationStatus: "authorized",
      authorizedAt: NOW,
      authorizedByEventId: "webhook_inbox:2",
      authoritySourceTopic: "orders/paid",
      authoritySourceInboxId: 2,
    });
    expect(getOmsLineMaterializableQuantity(authority)).toBe(2);
  });

  it("does not let a later non-authorizing update increase prior paid authority", () => {
    const authority = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:3",
      sourceInboxId: 3,
      financialStatus: "paid",
      quantity: 5,
      fulfillableQuantity: 5,
      previous: {
        paidQuantity: 2,
        authorityFulfillableQuantity: 2,
        authorizationStatus: "authorized",
        authorizedAt: NOW,
        authorizedByEventId: "webhook_inbox:2",
      },
      now: new Date("2026-06-25T12:05:00.000Z"),
    });

    expect(authority).toMatchObject({
      channelObservedQuantity: 5,
      paidQuantity: 2,
      authorityFulfillableQuantity: 2,
      authorizationStatus: "authorized",
      authorizedAt: NOW,
      authorizedByEventId: "webhook_inbox:2",
      authoritySourceTopic: "orders/updated",
      authoritySourceInboxId: 3,
    });
  });

  it("unlocks delayed Shopify readiness only within previously paid quantity", () => {
    const authority = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:delayed-ready",
      financialStatus: "paid",
      quantity: 4,
      fulfillableQuantity: 4,
      previous: {
        paidQuantity: 4,
        authorityFulfillableQuantity: 0,
        authorizationStatus: "authorized",
        authorizedAt: NOW,
        authorizedByEventId: "webhook_inbox:paid",
      },
      now: new Date("2026-06-25T13:00:00.000Z"),
    });

    expect(authority).toMatchObject({
      paidQuantity: 4,
      authorityFulfillableQuantity: 4,
      authorizationStatus: "authorized",
      authorizedByEventId: "webhook_inbox:paid",
    });
  });

  it("never turns later Shopify readiness into authority for unpaid quantity", () => {
    const authority = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:edited",
      financialStatus: "paid",
      quantity: 5,
      fulfillableQuantity: 5,
      previous: {
        paidQuantity: 2,
        authorityFulfillableQuantity: 0,
        authorizationStatus: "authorized",
        authorizedAt: NOW,
        authorizedByEventId: "webhook_inbox:paid",
      },
    });

    expect(authority.paidQuantity).toBe(2);
    expect(authority.authorityFulfillableQuantity).toBe(2);
  });

  it("does not unlock delayed readiness for refunded, cancelled, or review lines", () => {
    const protectedStates = [
      {
        cancelledQuantity: 1,
        refundedQuantity: 0,
        authorizationStatus: "authorized",
      },
      {
        cancelledQuantity: 0,
        refundedQuantity: 1,
        authorizationStatus: "authorized",
      },
      {
        cancelledQuantity: 0,
        refundedQuantity: 0,
        authorizationStatus: "review",
      },
    ];

    for (const previous of protectedStates) {
      const authority = deriveOmsLineAuthority({
        sourceTopic: "orders/updated",
        sourceEventId: "webhook_inbox:protected",
        financialStatus: "paid",
        quantity: 4,
        fulfillableQuantity: 4,
        previous: {
          paidQuantity: 4,
          authorityFulfillableQuantity: 0,
          ...previous,
        },
      });

      expect(authority.authorityFulfillableQuantity).toBe(0);
    }
  });

  it("does not unlock delayed readiness after Shopify reports a refunded status", () => {
    const authority = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:refunded",
      financialStatus: "partially_refunded",
      quantity: 4,
      fulfillableQuantity: 4,
      previous: {
        paidQuantity: 4,
        authorityFulfillableQuantity: 0,
        authorizationStatus: "authorized",
      },
    });

    expect(authority.authorityFulfillableQuantity).toBe(0);
  });
  it("clamps existing authority down when the channel observed quantity shrinks", () => {
    const authority = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:4",
      sourceInboxId: 4,
      financialStatus: "paid",
      quantity: 1,
      previous: {
        paidQuantity: 4,
        authorityFulfillableQuantity: 4,
        authorizationStatus: "authorized",
        authorizedAt: NOW,
        authorizedByEventId: "webhook_inbox:2",
      },
    });

    expect(authority).toMatchObject({
      channelObservedQuantity: 1,
      paidQuantity: 1,
      authorityFulfillableQuantity: 1,
      authorizationStatus: "authorized",
      authorizedAt: NOW,
      authorizedByEventId: "webhook_inbox:2",
    });
  });

  it("rejects invalid quantities before authority state can be persisted", () => {
    expect(() =>
      deriveOmsLineAuthority({
        sourceTopic: "orders/paid",
        financialStatus: "paid",
        quantity: -1,
      }),
    ).toThrow(/quantity must be a non-negative integer/);

    expect(() =>
      deriveOmsLineAuthority({
        sourceTopic: "orders/paid",
        financialStatus: "paid",
        quantity: 1.5,
      }),
    ).toThrow(/quantity must be a non-negative integer/);
  });

  it("falls back to legacy raw quantity only when authority columns are absent", () => {
    expect(getOmsLineMaterializableQuantity({ quantity: 7 })).toBe(7);
    expect(
      getOmsLineMaterializableQuantity({
        quantity: 7,
        authorityFulfillableQuantity: 0,
      }),
    ).toBe(0);
  });

  it("subtracts WMS-materialized quantity from remaining authority", () => {
    expect(
      getOmsLineRemainingMaterializableQuantity({
        quantity: 5,
        authorityFulfillableQuantity: 5,
        wmsMaterializedQuantity: 2,
      }),
    ).toBe(3);
    expect(
      getOmsLineRemainingMaterializableQuantity({
        quantity: 5,
        authorityFulfillableQuantity: 2,
        wmsMaterializedQuantity: 5,
      }),
    ).toBe(0);
  });
});

// Shopify's fulfillable_quantity is workflow permission (holds, schedules,
// location moves, fulfillment progress), not demand. Only current_quantity —
// units removed by an order edit or cancellation — may lower what the
// warehouse owes. Regression for order #63275 (2026-09-18): a Global-e
// merchant-of-record hold zeroed fulfillable_quantity for two minutes after
// payment, authority followed it to 0, and the materialized WMS line was
// cancelled and never restored when the hold lifted.
describe("OMS line authority under Shopify fulfillment holds", () => {
  const PAID_15 = {
    paidQuantity: 15,
    authorityFulfillableQuantity: 15,
    authorizationStatus: "authorized",
    authorizedAt: NOW,
    authorizedByEventId: "webhook_inbox:paid",
  } as const;

  function refresh(input: {
    fulfillableQuantity: number | null;
    currentQuantity?: number | null;
    previous: Record<string, unknown>;
    quantity?: number;
  }) {
    return deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:update",
      financialStatus: "paid",
      quantity: input.quantity ?? 15,
      fulfillableQuantity: input.fulfillableQuantity,
      currentQuantity: input.currentQuantity,
      previous: input.previous,
    });
  }

  it("keeps materialized authority when a hold zeroes fulfillable_quantity", () => {
    const authority = refresh({
      fulfillableQuantity: 0,
      currentQuantity: 15,
      previous: PAID_15,
    });

    expect(authority.authorityFulfillableQuantity).toBe(15);
    expect(authority.paidQuantity).toBe(15);
    expect(authority.authorizationStatus).toBe("authorized");
  });

  it("raises authority when a hold that began at payment is released", () => {
    const authority = refresh({
      fulfillableQuantity: 15,
      currentQuantity: 15,
      previous: { ...PAID_15, authorityFulfillableQuantity: 0 },
    });

    expect(authority.authorityFulfillableQuantity).toBe(15);
  });

  it("does not shrink authority as units are fulfilled", () => {
    const authority = refresh({
      fulfillableQuantity: 10,
      currentQuantity: 15,
      previous: PAID_15,
    });

    expect(authority.authorityFulfillableQuantity).toBe(15);
  });

  it("lowers authority to current_quantity when an order edit removes units", () => {
    const authority = refresh({
      fulfillableQuantity: 10,
      currentQuantity: 10,
      previous: PAID_15,
    });

    expect(authority.authorityFulfillableQuantity).toBe(10);
  });

  it("honors an order-edit removal that arrives while the order is on hold", () => {
    const authority = refresh({
      fulfillableQuantity: 0,
      currentQuantity: 10,
      previous: PAID_15,
    });

    expect(authority.authorityFulfillableQuantity).toBe(10);
  });

  it("drops authority to zero when an edit removes the whole line", () => {
    const authority = refresh({
      fulfillableQuantity: 0,
      currentQuantity: 0,
      previous: PAID_15,
    });

    expect(authority.authorityFulfillableQuantity).toBe(0);
  });

  it("never lets a released hold exceed paid quantity", () => {
    const authority = refresh({
      quantity: 20,
      fulfillableQuantity: 20,
      currentQuantity: 20,
      previous: { ...PAID_15, authorityFulfillableQuantity: 0 },
    });

    expect(authority.paidQuantity).toBe(15);
    expect(authority.authorityFulfillableQuantity).toBe(15);
  });

  it("keeps the legacy fulfillable-driven rule when current_quantity is absent", () => {
    // Without current_quantity an edit removal is indistinguishable from a
    // hold; picking units the customer removed is the costlier mistake.
    const authority = refresh({
      fulfillableQuantity: 0,
      currentQuantity: null,
      previous: PAID_15,
    });

    expect(authority.authorityFulfillableQuantity).toBe(0);
  });

  it("replays the #63275 webhook sequence without ever dropping below paid", () => {
    const paid = deriveOmsLineAuthority({
      sourceTopic: "orders/paid",
      sourceEventId: "webhook_inbox:159578",
      financialStatus: "paid",
      quantity: 15,
      fulfillableQuantity: null,
      now: NOW,
    });
    const held = refresh({
      fulfillableQuantity: 0,
      currentQuantity: 15,
      previous: paid,
    });
    const released = refresh({
      fulfillableQuantity: 15,
      currentQuantity: 15,
      previous: held,
    });

    expect([
      paid.authorityFulfillableQuantity,
      held.authorityFulfillableQuantity,
      released.authorityFulfillableQuantity,
    ]).toEqual([15, 15, 15]);
  });

  it("rejects a negative current_quantity before authority can be persisted", () => {
    expect(() =>
      refresh({ fulfillableQuantity: 15, currentQuantity: -1, previous: PAID_15 }),
    ).toThrow(/currentQuantity must be a non-negative integer/);
  });
});
