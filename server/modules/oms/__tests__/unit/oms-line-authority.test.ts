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
    expect(getOmsLineMaterializableQuantity({ quantity: 7, authorityFulfillableQuantity: 0 })).toBe(0);
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
