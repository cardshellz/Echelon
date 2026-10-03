import { describe, expect, it } from "vitest";

import {
  DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC,
  canSourceTopicAuthorizeOmsLine,
  deriveOmsLineAuthority,
  getOmsLineDropshipStagingQuantity,
  getOmsLineRemainingDropshipStagingQuantity,
} from "../../oms-line-authority";
import {
  omsLineQuantityToMaterialize,
  omsLineRemainingQuantityToMaterialize,
} from "../../wms-sync.service";

const ACCEPTED_AT = new Date("2026-10-03T15:42:09.000Z");

// Order 22039 (intake 43) as acceptance staged it: one line, one unit, and the
// authority columns at their migration 106 defaults.
const STAGED_DROPSHIP_LINE = {
  quantity: 1,
  authorityFulfillableQuantity: 0,
  wmsMaterializedQuantity: 0,
};

describe("dropship acceptance staging quantity", () => {
  it("stages the ordered quantity of a line that has no OMS authority yet", () => {
    expect(getOmsLineDropshipStagingQuantity(STAGED_DROPSHIP_LINE)).toBe(1);
    expect(omsLineQuantityToMaterialize(STAGED_DROPSHIP_LINE, "dropship_acceptance_claim")).toBe(1);
    expect(omsLineRemainingQuantityToMaterialize(STAGED_DROPSHIP_LINE, "dropship_acceptance_claim")).toBe(1);
  });

  it("keeps paid syncs on OMS authority, so they still skip the unpaid line", () => {
    expect(omsLineQuantityToMaterialize(STAGED_DROPSHIP_LINE, "standard")).toBe(0);
    expect(omsLineRemainingQuantityToMaterialize(STAGED_DROPSHIP_LINE, "standard")).toBe(0);
    expect(omsLineQuantityToMaterialize(STAGED_DROPSHIP_LINE, "terminal_residual_recovery")).toBe(0);
  });

  it("stages only what WMS does not hold yet, and never a negative quantity", () => {
    const line = { quantity: 3, authorityFulfillableQuantity: 0, wmsMaterializedQuantity: 1 };
    expect(getOmsLineRemainingDropshipStagingQuantity(line)).toBe(2);
    expect(getOmsLineRemainingDropshipStagingQuantity({ ...line, wmsMaterializedQuantity: 3 })).toBe(0);
    expect(getOmsLineRemainingDropshipStagingQuantity({ ...line, wmsMaterializedQuantity: 5 })).toBe(0);
  });

  it("stages nothing for a zero-quantity line", () => {
    expect(getOmsLineDropshipStagingQuantity({ quantity: 0 })).toBe(0);
    expect(omsLineQuantityToMaterialize({ quantity: 0, authorityFulfillableQuantity: 0 }, "dropship_acceptance_claim")).toBe(0);
  });

  it.each([
    { label: "negative", quantity: -1 },
    { label: "fractional", quantity: 1.5 },
    { label: "not a number", quantity: Number.NaN },
  ])("rejects a $label ordered quantity", ({ quantity }) => {
    expect(() => getOmsLineDropshipStagingQuantity({ quantity })).toThrow(/non-negative integer/);
  });

  it("rejects an invalid materialized counter", () => {
    expect(() => getOmsLineRemainingDropshipStagingQuantity({ quantity: 1, wmsMaterializedQuantity: -1 }))
      .toThrow(/non-negative integer/);
  });
});

describe("dropship acceptance authority topic", () => {
  it("authorizes the full quantity of a paid dropship line", () => {
    expect(canSourceTopicAuthorizeOmsLine(DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC)).toBe(true);
    const authority = deriveOmsLineAuthority({
      sourceTopic: DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC,
      sourceEventId: "dropship-acceptance:intake:43",
      financialStatus: "paid",
      quantity: 1,
      fulfillableQuantity: 1,
      previous: { paidQuantity: 0, authorityFulfillableQuantity: 0, authorizationStatus: "authorized" },
      now: ACCEPTED_AT,
    });

    expect(authority).toEqual({
      channelObservedQuantity: 1,
      paidQuantity: 1,
      authorityFulfillableQuantity: 1,
      authorizationStatus: "authorized",
      authorizedAt: ACCEPTED_AT,
      authorizedByEventId: "dropship-acceptance:intake:43",
      authoritySourceTopic: DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC,
      authoritySourceInboxId: null,
    });
    expect(omsLineQuantityToMaterialize(authority, "standard")).toBe(1);
  });

  it("grants nothing while the dropship order is unpaid", () => {
    const authority = deriveOmsLineAuthority({
      sourceTopic: DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC,
      sourceEventId: "dropship-acceptance:intake:43",
      financialStatus: "pending",
      quantity: 1,
      fulfillableQuantity: 1,
      now: ACCEPTED_AT,
    });

    expect(authority.paidQuantity).toBe(0);
    expect(authority.authorityFulfillableQuantity).toBe(0);
    expect(authority.authorizationStatus).toBe("seen");
  });
});
