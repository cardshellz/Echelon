/**
 * Unit tests for `reconcileShopifyFulfillment` (void→re-ship heal /
 * Flow Monitor CHANNEL_TRACKING_STALE / order #58910).
 *
 * Behavior under test (the "converge to live" strategy):
 *   - no `shopify_fulfillment_id` on the row → mode `no_fulfillment`,
 *     no Shopify call.
 *   - fulfillment OPEN → `updateShopifyFulfillmentTracking` succeeds →
 *     mode `updated`.
 *   - update fails with a CANCELLED/gone userError → cancel-confirm +
 *     clear the stale id + recreate via `pushShopifyFulfillment` →
 *     mode `recreated`.
 *   - update fails with a TRANSIENT error (network) → RETHROWN, no
 *     recreate (never spawn a duplicate live fulfillment).
 *
 * Mocks: in-memory ShopifyAdminGraphQLClient + a scripted DB mock
 * (reconcile reads the row, may clear the id, and the recreate path
 * delegates to pushShopifyFulfillment which the channel guard
 * short-circuits to a null no-op so this suite stays focused on
 * reconcile's orchestration — full create coverage lives in the
 * fulfillment-create tests).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFulfillmentPushService,
  ShopifyFulfillmentPushError,
  SHOPIFY_TRACKING_UPDATE_NETWORK_ERROR,
} from "../../fulfillment-push.service";
import type { ShopifyAdminGraphQLClient } from "../../../shopify/admin-gql-client";

// ─── Fixtures ────────────────────────────────────────────────────────

const SHIPMENT_ID = 501;
const FULFILLMENT_GID = "gid://shopify/Fulfillment/6282938155167";
const NEW_TRACKING = "1Z16D13WYW76682155";
const CARRIER = "UPS";

function okUpdateResponse(returnedNumber: string = NEW_TRACKING) {
  return {
    fulfillmentTrackingInfoUpdate: {
      fulfillment: {
        id: FULFILLMENT_GID,
        trackingInfo: { number: returnedNumber, company: CARRIER },
      },
      userErrors: [],
    },
  };
}

function cancelledUpdateResponse() {
  return {
    fulfillmentTrackingInfoUpdate: {
      fulfillment: null,
      userErrors: [
        { field: null, message: "Fulfillment has been cancelled and cannot be updated." },
      ],
    },
  };
}

function okCancelResponse() {
  return {
    fulfillmentCancel: {
      fulfillment: { id: FULFILLMENT_GID, status: "CANCELLED" },
      userErrors: [],
    },
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────

interface MockClient extends ShopifyAdminGraphQLClient {
  calls: Array<{ query: string; variables?: Record<string, unknown> }>;
}

function makeShopifyClient(responses: Array<unknown | (() => unknown)>): MockClient {
  const remaining = [...responses];
  const calls: MockClient["calls"] = [];
  return {
    calls,
    async request<T = unknown>(
      query: string,
      variables?: Record<string, unknown>,
    ): Promise<T> {
      calls.push({ query, variables });
      if (remaining.length === 0) {
        throw new Error("MockClient: no scripted response remaining");
      }
      const next = remaining.shift();
      const value = typeof next === "function" ? (next as () => unknown)() : next;
      if (value instanceof Error) throw value;
      return value as T;
    },
  };
}

type ScriptedResponse = { rows: any[] };

function makeDb(scripted: ScriptedResponse[]) {
  const calls: Array<{ sqlText: string }> = [];
  const remaining = [...scripted];
  const execute = vi.fn(async (query: any) => {
    const chunks: unknown[] = query?.queryChunks ?? [];
    const text = chunks
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && Array.isArray((c as any).value)) {
          return (c as any).value.join("");
        }
        return "";
      })
      .join("");
    calls.push({ sqlText: text });
    if (remaining.length === 0) return { rows: [] };
    return remaining.shift()!;
  });
  return { db: { execute } as any, execute, calls, getCallCount: () => calls.length };
}

// ─── Test suite ──────────────────────────────────────────────────────

describe("reconcileShopifyFulfillment", () => {
  let client: MockClient;

  beforeEach(() => {
    client = makeShopifyClient([]);
  });

  it("returns no_fulfillment and makes no Shopify call when the row has no fulfillment id", async () => {
    const mock = makeDb([{ rows: [{ shopify_fulfillment_id: null }] }]);
    const svc = createFulfillmentPushService(mock.db, null);
    svc.setShopifyClient(client);

    const result = await svc.reconcileShopifyFulfillment(SHIPMENT_ID, {
      number: NEW_TRACKING,
      company: CARRIER,
    });

    expect(result).toEqual({ reconciled: false, mode: "no_fulfillment", fulfillmentGid: null });
    expect(client.calls).toHaveLength(0);
    expect(mock.getCallCount()).toBe(1); // just the row read
  });

  it("updates tracking in place when the existing fulfillment is open (mode: updated)", async () => {
    const mock = makeDb([{ rows: [{ shopify_fulfillment_id: FULFILLMENT_GID }] }]);
    client = makeShopifyClient([okUpdateResponse()]);
    const svc = createFulfillmentPushService(mock.db, null);
    svc.setShopifyClient(client);

    const result = await svc.reconcileShopifyFulfillment(SHIPMENT_ID, {
      number: NEW_TRACKING,
      company: CARRIER,
    });

    expect(result).toEqual({
      reconciled: true,
      mode: "updated",
      fulfillmentGid: FULFILLMENT_GID,
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].query).toContain("fulfillmentTrackingInfoUpdate");
    // Update-only: no id-clearing write.
    expect(mock.calls.some((c) => /shopify_fulfillment_id\s*=\s*NULL/i.test(c.sqlText))).toBe(false);
  });

  it("RETHROWS a transient (network) update failure and does NOT recreate", async () => {
    const mock = makeDb([{ rows: [{ shopify_fulfillment_id: FULFILLMENT_GID }] }]);
    client = makeShopifyClient([new Error("ECONNRESET")]);
    const svc = createFulfillmentPushService(mock.db, null);
    svc.setShopifyClient(client);

    await expect(
      svc.reconcileShopifyFulfillment(SHIPMENT_ID, { number: NEW_TRACKING, company: CARRIER }),
    ).rejects.toMatchObject({ context: { code: SHOPIFY_TRACKING_UPDATE_NETWORK_ERROR } });

    // Only the update was attempted — no cancel, no id-clear, no recreate.
    expect(client.calls).toHaveLength(1);
    expect(mock.getCallCount()).toBe(1); // just the initial row read
  });

  it("recreates when the existing fulfillment is cancelled: cancel-confirm + clear id + push (mode: recreated)", async () => {
    const mock = makeDb([
      { rows: [{ shopify_fulfillment_id: FULFILLMENT_GID }] }, // 1. reconcile row read
      { rows: [] },                                            // 2. clear id UPDATE
      { rows: [{ shopify_fulfillment_id: null }] },            // 3. push idempotency read (cleared)
      {                                                        // 4. push load shipment
        rows: [
          {
            id: SHIPMENT_ID,
            order_id: 42,
            channel_id: 7,
            status: "shipped",
            carrier: CARRIER,
            tracking_number: NEW_TRACKING,
            tracking_url: null,
            shopify_fulfillment_id: null,
          },
        ],
      },
      {                                                        // 5. push load WMS order (non-Shopify → clean no-op)
        rows: [
          {
            id: 42,
            channel_id: null,
            source: "ebay",
            external_order_id: "X",
            oms_fulfillment_order_id: null,
            combined_group_id: null,
            combined_role: null,
            ship_from_location_id: null,
          },
        ],
      },
    ]);
    // update → cancelled userError (throws), then cancel → ok.
    client = makeShopifyClient([cancelledUpdateResponse(), okCancelResponse()]);
    const svc = createFulfillmentPushService(mock.db, null);
    svc.setShopifyClient(client);

    const result = await svc.reconcileShopifyFulfillment(SHIPMENT_ID, {
      number: NEW_TRACKING,
      company: CARRIER,
    });

    expect(result.reconciled).toBe(true);
    expect(result.mode).toBe("recreated");
    // update attempted, then cancel-confirm.
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].query).toContain("fulfillmentTrackingInfoUpdate");
    expect(client.calls[1].query).toContain("fulfillmentCancel");
    // The stale handle was cleared before recreate.
    expect(mock.calls.some((c) => /shopify_fulfillment_id\s*=\s*NULL/i.test(c.sqlText))).toBe(true);
  });
});
