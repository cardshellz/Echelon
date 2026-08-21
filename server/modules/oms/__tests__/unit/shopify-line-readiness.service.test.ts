import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordAuthorityEvent } = vi.hoisted(() => ({
  recordAuthorityEvent: vi.fn(),
}));

vi.mock("../../oms-line-authority-ledger", () => ({
  recordOmsLineAuthorityEvent: recordAuthorityEvent,
}));

import { reconcileShopifyLineReadiness } from "../../shopify-line-readiness.service";

const NOW = new Date("2026-08-21T12:00:00.000Z");

function createDb(line: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: async () => [line],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => undefined };
      },
    }),
  };

  return {
    db: {
      transaction: async <T>(
        callback: (transaction: typeof tx) => Promise<T>,
      ) => callback(tx),
    },
    updates,
  };
}

describe("reconcileShopifyLineReadiness", () => {
  beforeEach(() => {
    recordAuthorityEvent.mockReset();
    recordAuthorityEvent.mockResolvedValue(undefined);
  });

  it("advances a paid line when Shopify later makes it fulfillable", async () => {
    const { db, updates } = createDb({
      id: 101,
      orderId: 55,
      externalLineItemId: "9001",
      quantity: 4,
      requiresShipping: true,
      paidQuantity: 4,
      authorityFulfillableQuantity: 0,
      wmsMaterializedQuantity: 0,
      cancelledQuantity: 0,
      refundedQuantity: 0,
      authorizationStatus: "authorized",
      authorizedAt: NOW,
      authorizedByEventId: "webhook_inbox:paid",
    });

    const result = await reconcileShopifyLineReadiness({
      db,
      omsOrderId: 55,
      financialStatus: "paid",
      sourceEventId: "shopify-reconcile:order:version",
      lineItems: [
        { externalLineItemId: "9001", quantity: 4, fulfillableQuantity: 4 },
      ],
      now: NOW,
    });

    expect(result).toMatchObject({
      checkedLines: 1,
      matchedLines: 1,
      advancedLines: 1,
      advancedQuantity: 4,
      wmsSyncRequired: true,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      paidQuantity: 4,
      authorityFulfillableQuantity: 4,
      authorizationStatus: "authorized",
    });
    expect(recordAuthorityEvent).toHaveBeenCalledOnce();
  });

  it("retries WMS materialization without rewriting unchanged authority", async () => {
    const { db, updates } = createDb({
      id: 102,
      orderId: 56,
      externalLineItemId: "9002",
      quantity: 4,
      requiresShipping: true,
      paidQuantity: 4,
      authorityFulfillableQuantity: 4,
      wmsMaterializedQuantity: 0,
      cancelledQuantity: 0,
      refundedQuantity: 0,
      authorizationStatus: "authorized",
      authorizedAt: NOW,
      authorizedByEventId: "webhook_inbox:paid",
    });

    const result = await reconcileShopifyLineReadiness({
      db,
      omsOrderId: 56,
      financialStatus: "paid",
      sourceEventId: "shopify-reconcile:order:retry",
      lineItems: [
        { externalLineItemId: "9002", quantity: 4, fulfillableQuantity: 4 },
      ],
      now: NOW,
    });

    expect(result.advancedLines).toBe(0);
    expect(result.wmsSyncRequired).toBe(true);
    expect(updates).toHaveLength(0);
    expect(recordAuthorityEvent).not.toHaveBeenCalled();
  });

  it("does not advance a line whose paid quantity is not proven", async () => {
    const { db, updates } = createDb({
      id: 103,
      orderId: 57,
      externalLineItemId: "9003",
      quantity: 4,
      requiresShipping: true,
      paidQuantity: 0,
      authorityFulfillableQuantity: 0,
      wmsMaterializedQuantity: 0,
      cancelledQuantity: 0,
      refundedQuantity: 0,
      authorizationStatus: "seen",
    });

    const result = await reconcileShopifyLineReadiness({
      db,
      omsOrderId: 57,
      financialStatus: "paid",
      sourceEventId: "shopify-reconcile:order:unpaid",
      lineItems: [
        { externalLineItemId: "9003", quantity: 4, fulfillableQuantity: 4 },
      ],
      now: NOW,
    });

    expect(result.advancedLines).toBe(0);
    expect(result.wmsSyncRequired).toBe(false);
    expect(updates).toHaveLength(0);
  });
});
