import { describe, expect, it } from "vitest";
import {
  deriveOmsLineAuthority,
  type OmsLineAuthorityInput,
} from "../../oms-line-authority";

const AUTHORIZED_AT = new Date("2026-09-24T10:00:00.000Z");
const OBSERVED_AT = new Date("2026-09-25T21:00:00.000Z");

describe("OMS disposition survives non-authorizing observations", () => {
  const dispositions = [
    { status: "refunded", cancelled: 0, refunded: 1, remaining: 0 },
    { status: "cancelled", cancelled: 1, refunded: 0, remaining: 0 },
    { status: "partially_refunded", cancelled: 0, refunded: 1, remaining: 2 },
    { status: "partially_cancelled", cancelled: 1, refunded: 0, remaining: 2 },
    { status: "review", cancelled: 0, refunded: 0, remaining: 0 },
  ] as const;

  for (const sourceTopic of ["orders/updated", "shopify/reconcile"]) {
    for (const financialStatus of ["paid", "partially_refunded", "refunded"]) {
      it.each(dispositions)(`${sourceTopic} / ${financialStatus} preserves $status over repeated observations`, (entry) => {
        const quantity = entry.remaining + Math.max(entry.cancelled, entry.refunded, 1);
        const input: OmsLineAuthorityInput = {
          sourceTopic,
          sourceEventId: "observation:1",
          sourceInboxId: 12,
          financialStatus,
          quantity,
          // Deliberately stale provider readiness must not undo local disposition.
          fulfillableQuantity: quantity,
          now: OBSERVED_AT,
          previous: {
            paidQuantity: quantity,
            authorityFulfillableQuantity: entry.remaining,
            cancelledQuantity: entry.cancelled,
            refundedQuantity: entry.refunded,
            authorizationStatus: entry.status,
            authorizedAt: AUTHORIZED_AT,
            authorizedByEventId: "payment:original",
          },
        };
        const before = structuredClone(input);
        const first = deriveOmsLineAuthority(input);
        const second = deriveOmsLineAuthority({
          ...input,
          sourceEventId: "observation:2",
          previous: { ...input.previous, ...first },
        });

        for (const result of [first, second]) {
          expect(result).toMatchObject({
            channelObservedQuantity: quantity,
            paidQuantity: quantity,
            authorityFulfillableQuantity: entry.remaining,
            authorizationStatus: entry.status,
            authorizedAt: AUTHORIZED_AT,
            authorizedByEventId: "payment:original",
            authoritySourceTopic: sourceTopic,
            authoritySourceInboxId: 12,
          });
        }
        expect(input).toEqual(before);
      });
    }
  }

  it("retains refunded disposition when the provider removes the line quantity", () => {
    const result = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      financialStatus: "refunded",
      quantity: 0,
      fulfillableQuantity: 0,
      previous: {
        paidQuantity: 1,
        refundedQuantity: 1,
        authorityFulfillableQuantity: 0,
        authorizationStatus: "refunded",
      },
    });
    expect(result).toMatchObject({
      paidQuantity: 0,
      authorityFulfillableQuantity: 0,
      authorizationStatus: "refunded",
    });
  });

  it("still clamps partial demand when observed quantity shrinks", () => {
    const result = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      financialStatus: "partially_refunded",
      quantity: 1,
      fulfillableQuantity: 1,
      previous: {
        paidQuantity: 4,
        refundedQuantity: 2,
        authorityFulfillableQuantity: 2,
        authorizationStatus: "partially_refunded",
      },
    });
    expect(result).toMatchObject({
      paidQuantity: 1,
      authorityFulfillableQuantity: 1,
      authorizationStatus: "partially_refunded",
    });
  });

  it("does not infer refunded disposition from a header without line evidence", () => {
    const result = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      financialStatus: "partially_refunded",
      quantity: 2,
      previous: {
        paidQuantity: 2,
        authorityFulfillableQuantity: 1,
        authorizationStatus: "authorized",
      },
    });
    expect(result.authorizationStatus).toBe("authorized");
    expect(result.authorityFulfillableQuantity).toBe(1);
  });
});
