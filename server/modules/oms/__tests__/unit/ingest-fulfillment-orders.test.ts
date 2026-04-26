/**
 * Unit tests for `populateShopifyFulfillmentOrderIds` (C22b).
 *
 * Plan: §6 Group E, Decisions D2 + D4 — populate Shopify
 * fulfillment-order line item IDs at OMS ingest time so C22c's
 * `pushShopifyFulfillment` has the IDs cached locally and only needs
 * its Path B query as a fallback.
 *
 * Strategy:
 *   1. Mock the OMS service's `db` argument with chainable .select /
 *      .update builders that return scripted line rows + capture the
 *      UPDATEs the function emits.
 *   2. Mock the Shopify Admin GraphQL client with scripted fulfillment-
 *      orders responses (mirrors the C21 push-shopify-fulfillment test
 *      style — no real fetch).
 *   3. Drive the public service via `createOmsService()` to keep the
 *      contract honest (Rule #4 — depend on the public surface, not
 *      internals).
 *
 * Standards: Rule #9 (happy + edge cases), Rule #6 (idempotency),
 * Rule #8 (observability — summary returned to caller).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOmsService } from "../../oms.service";
import type { ShopifyAdminGraphQLClient } from "../../../shopify/admin-gql-client";

// ─── Fixtures ────────────────────────────────────────────────────────

const OMS_ORDER_ID = 4242;
const SHOPIFY_ORDER_GID = "gid://shopify/Order/123456789";

const FO_777 = "gid://shopify/FulfillmentOrder/777";
const FO_888 = "gid://shopify/FulfillmentOrder/888";

// ─── Mocks ───────────────────────────────────────────────────────────

interface CapturedUpdate {
  table: string;
  set: Record<string, unknown>;
  whereLineId: number | null;
}

interface MockDb {
  db: any;
  selectedLines: Array<{
    id: number;
    sku: string | null;
    quantity: number;
    shopifyFulfillmentOrderLineItemId: string | null;
  }>;
  updates: CapturedUpdate[];
  setSelectRows(rows: any[]): void;
}

/**
 * Build a chainable drizzle-shaped mock that returns a scripted SELECT
 * result (the order's lines) and captures every UPDATE the service
 * emits. Only models the methods `populateShopifyFulfillmentOrderIds`
 * actually exercises.
 */
function makeDb(): MockDb {
  let scriptedSelectRows: any[] = [];
  const updates: CapturedUpdate[] = [];

  function selectChain(_columns?: any) {
    return {
      from(_table: any) {
        return {
          where(_cond: any) {
            // The single SELECT issued by populateShopifyFulfillmentOrderIds.
            return Promise.resolve(scriptedSelectRows);
          },
        };
      },
    };
  }

  function updateChain(table: any) {
    const tableName = (table?.[Symbol.for("drizzle:Name")] as string | undefined)
      ?? "oms.oms_order_lines";
    return {
      set(values: Record<string, unknown>) {
        return {
          where(cond: any) {
            // Drizzle's eq() exposes its right-hand value as `.right.value`
            // in the AST — but to keep the mock tiny we simply remember
            // the WHERE clause object reference so tests can reach into
            // the captured params.
            const whereLineId = extractEqRightInt(cond);
            const captured: CapturedUpdate = {
              table: tableName,
              set: values,
              whereLineId,
            };
            updates.push(captured);
            return {
              returning(_cols?: any) {
                return Promise.resolve([{ id: whereLineId ?? 0 }]);
              },
            };
          },
        };
      },
    };
  }

  return {
    db: {
      select: vi.fn(selectChain),
      update: vi.fn(updateChain),
      // Stubs not exercised by populateShopifyFulfillmentOrderIds but
      // present so unrelated calls would fail loudly rather than silently.
      insert: vi.fn(() => {
        throw new Error("MockDb.insert not expected here");
      }),
      execute: vi.fn(() => {
        throw new Error("MockDb.execute not expected here");
      }),
    },
    get selectedLines() {
      return scriptedSelectRows as any;
    },
    updates,
    setSelectRows(rows) {
      scriptedSelectRows = rows;
    },
  };
}

/**
 * Best-effort extraction of an integer literal out of a drizzle `eq()`
 * AST node. Drizzle returns an SQL object whose `queryChunks` array
 * contains alternating StringChunk and Param entries. The first Param
 * with a numeric `value` is the right-hand side of the equality.
 */
function extractEqRightInt(cond: any): number | null {
  try {
    const chunks = cond?.queryChunks;
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        if (chunk && chunk.constructor?.name === "Param" && typeof chunk.value === "number") {
          return Number.isInteger(chunk.value) ? chunk.value : null;
        }
      }
      // Fallback: any chunk that exposes a numeric .value
      for (const chunk of chunks) {
        if (chunk && typeof chunk.value === "number" && Number.isInteger(chunk.value)) {
          return chunk.value;
        }
      }
    }
    const right = cond?.right;
    const val = right?.value ?? right;
    if (typeof val === "number" && Number.isInteger(val)) return val;
  } catch {
    // ignore
  }
  return null;
}

interface MockClient extends ShopifyAdminGraphQLClient {
  calls: Array<{ query: string; variables?: Record<string, unknown> }>;
}

function makeShopifyClient(responses: Array<unknown | (() => unknown)>): MockClient {
  const remaining = [...responses];
  const calls: MockClient["calls"] = [];
  return {
    calls,
    async request<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
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

function fulfillmentOrdersResponse(
  fos: Array<{
    id: string;
    status?: string;
    items: Array<{ id: string; sku: string | null; remainingQuantity: number }>;
  }>,
) {
  return {
    order: {
      id: SHOPIFY_ORDER_GID,
      fulfillmentOrders: {
        edges: fos.map((fo) => ({
          node: {
            id: fo.id,
            status: fo.status ?? "OPEN",
            lineItems: {
              edges: fo.items.map((it) => ({ node: it })),
            },
          },
        })),
      },
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("populateShopifyFulfillmentOrderIds :: happy path", () => {
  let dbMock: MockDb;
  let client: MockClient;

  beforeEach(() => {
    dbMock = makeDb();
    dbMock.setSelectRows([
      {
        id: 8001,
        sku: "ABC-1",
        quantity: 2,
        shopifyFulfillmentOrderLineItemId: null,
      },
      {
        id: 8002,
        sku: "XYZ-9",
        quantity: 1,
        shopifyFulfillmentOrderLineItemId: null,
      },
    ]);
    client = makeShopifyClient([
      fulfillmentOrdersResponse([
        {
          id: FO_777,
          items: [
            { id: `${FO_777}-li-1`, sku: "ABC-1", remainingQuantity: 2 },
            { id: `${FO_777}-li-2`, sku: "XYZ-9", remainingQuantity: 1 },
          ],
        },
      ]),
    ]);
  });

  it("matches every line and emits an UPDATE per line", async () => {
    const svc = createOmsService(dbMock.db);
    const summary = await svc.populateShopifyFulfillmentOrderIds(
      OMS_ORDER_ID,
      SHOPIFY_ORDER_GID,
      client,
    );

    expect(summary).toEqual({ matched: 2, unmatched: 0, updates: 2 });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].query).toContain("fulfillmentOrders");
    expect(client.calls[0].variables).toEqual({ id: SHOPIFY_ORDER_GID });
    expect(dbMock.updates).toHaveLength(2);

    const byLine = new Map(dbMock.updates.map((u) => [u.whereLineId, u.set]));
    expect(byLine.get(8001)).toMatchObject({
      shopifyFulfillmentOrderId: FO_777,
      shopifyFulfillmentOrderLineItemId: `${FO_777}-li-1`,
    });
    expect(byLine.get(8002)).toMatchObject({
      shopifyFulfillmentOrderId: FO_777,
      shopifyFulfillmentOrderLineItemId: `${FO_777}-li-2`,
    });
  });

  it("spreads matches across multiple FOs (split-shipment / multi-location)", async () => {
    dbMock.setSelectRows([
      { id: 9001, sku: "ABC-1", quantity: 1, shopifyFulfillmentOrderLineItemId: null },
      { id: 9002, sku: "XYZ-9", quantity: 1, shopifyFulfillmentOrderLineItemId: null },
    ]);
    client = makeShopifyClient([
      fulfillmentOrdersResponse([
        {
          id: FO_777,
          items: [{ id: `${FO_777}-li-1`, sku: "ABC-1", remainingQuantity: 1 }],
        },
        {
          id: FO_888,
          items: [{ id: `${FO_888}-li-1`, sku: "XYZ-9", remainingQuantity: 1 }],
        },
      ]),
    ]);

    const svc = createOmsService(dbMock.db);
    const summary = await svc.populateShopifyFulfillmentOrderIds(
      OMS_ORDER_ID,
      SHOPIFY_ORDER_GID,
      client,
    );

    expect(summary).toEqual({ matched: 2, unmatched: 0, updates: 2 });
    const byLine = new Map(dbMock.updates.map((u) => [u.whereLineId, u.set]));
    expect(byLine.get(9001)).toMatchObject({ shopifyFulfillmentOrderId: FO_777 });
    expect(byLine.get(9002)).toMatchObject({ shopifyFulfillmentOrderId: FO_888 });
  });

  it("greedily allocates same-SKU lines to the FO with remaining quantity", async () => {
    // Two OMS lines for the same SKU, qty 2 and qty 3, split across two FOs.
    dbMock.setSelectRows([
      { id: 7001, sku: "DUPE", quantity: 2, shopifyFulfillmentOrderLineItemId: null },
      { id: 7002, sku: "DUPE", quantity: 3, shopifyFulfillmentOrderLineItemId: null },
    ]);
    client = makeShopifyClient([
      fulfillmentOrdersResponse([
        {
          id: FO_777,
          items: [{ id: `${FO_777}-li-A`, sku: "DUPE", remainingQuantity: 2 }],
        },
        {
          id: FO_888,
          items: [{ id: `${FO_888}-li-B`, sku: "DUPE", remainingQuantity: 3 }],
        },
      ]),
    ]);

    const svc = createOmsService(dbMock.db);
    const summary = await svc.populateShopifyFulfillmentOrderIds(
      OMS_ORDER_ID,
      SHOPIFY_ORDER_GID,
      client,
    );

    expect(summary).toEqual({ matched: 2, unmatched: 0, updates: 2 });
    const byLine = new Map(dbMock.updates.map((u) => [u.whereLineId, u.set]));
    expect(byLine.get(7001)).toMatchObject({
      shopifyFulfillmentOrderId: FO_777,
      shopifyFulfillmentOrderLineItemId: `${FO_777}-li-A`,
    });
    expect(byLine.get(7002)).toMatchObject({
      shopifyFulfillmentOrderId: FO_888,
      shopifyFulfillmentOrderLineItemId: `${FO_888}-li-B`,
    });
  });
});

describe("populateShopifyFulfillmentOrderIds :: edge cases", () => {
  it("returns zero counts and emits no UPDATE when the order has no lines", async () => {
    const dbMock = makeDb();
    dbMock.setSelectRows([]);
    const client = makeShopifyClient([]);

    const svc = createOmsService(dbMock.db);
    const summary = await svc.populateShopifyFulfillmentOrderIds(
      OMS_ORDER_ID,
      SHOPIFY_ORDER_GID,
      client,
    );

    expect(summary).toEqual({ matched: 0, unmatched: 0, updates: 0 });
    expect(client.calls).toHaveLength(0); // short-circuited before calling Shopify
    expect(dbMock.updates).toHaveLength(0);
  });

  it("does not throw when Shopify returns no fulfillment orders", async () => {
    const dbMock = makeDb();
    dbMock.setSelectRows([
      { id: 9001, sku: "ABC-1", quantity: 1, shopifyFulfillmentOrderLineItemId: null },
    ]);
    const client = makeShopifyClient([
      { order: { id: SHOPIFY_ORDER_GID, fulfillmentOrders: { edges: [] } } },
    ]);

    const svc = createOmsService(dbMock.db);
    const summary = await svc.populateShopifyFulfillmentOrderIds(
      OMS_ORDER_ID,
      SHOPIFY_ORDER_GID,
      client,
    );

    expect(summary).toEqual({ matched: 0, unmatched: 1, updates: 0 });
    expect(dbMock.updates).toHaveLength(0);
  });

  it("logs and skips a line whose SKU isn't on any FO (Path B fallback will retry)", async () => {
    const dbMock = makeDb();
    dbMock.setSelectRows([
      { id: 9001, sku: "ABC-1", quantity: 1, shopifyFulfillmentOrderLineItemId: null },
      { id: 9002, sku: "MISSING", quantity: 1, shopifyFulfillmentOrderLineItemId: null },
    ]);
    const client = makeShopifyClient([
      fulfillmentOrdersResponse([
        {
          id: FO_777,
          items: [{ id: `${FO_777}-li-1`, sku: "ABC-1", remainingQuantity: 1 }],
        },
      ]),
    ]);

    const svc = createOmsService(dbMock.db);
    const summary = await svc.populateShopifyFulfillmentOrderIds(
      OMS_ORDER_ID,
      SHOPIFY_ORDER_GID,
      client,
    );

    expect(summary).toEqual({ matched: 1, unmatched: 1, updates: 1 });
    expect(dbMock.updates).toHaveLength(1);
    expect(dbMock.updates[0].whereLineId).toBe(9001);
  });

  it("skips closed / cancelled fulfillment orders", async () => {
    const dbMock = makeDb();
    dbMock.setSelectRows([
      { id: 9001, sku: "ABC-1", quantity: 1, shopifyFulfillmentOrderLineItemId: null },
    ]);
    const client = makeShopifyClient([
      fulfillmentOrdersResponse([
        {
          id: FO_777,
          status: "CLOSED",
          items: [{ id: `${FO_777}-li-1`, sku: "ABC-1", remainingQuantity: 1 }],
        },
      ]),
    ]);

    const svc = createOmsService(dbMock.db);
    const summary = await svc.populateShopifyFulfillmentOrderIds(
      OMS_ORDER_ID,
      SHOPIFY_ORDER_GID,
      client,
    );

    expect(summary).toEqual({ matched: 0, unmatched: 1, updates: 0 });
    expect(dbMock.updates).toHaveLength(0);
  });

  it("skips lines without a SKU (no way to match) without throwing", async () => {
    const dbMock = makeDb();
    dbMock.setSelectRows([
      { id: 9001, sku: null, quantity: 1, shopifyFulfillmentOrderLineItemId: null },
      { id: 9002, sku: "ABC-1", quantity: 1, shopifyFulfillmentOrderLineItemId: null },
    ]);
    const client = makeShopifyClient([
      fulfillmentOrdersResponse([
        {
          id: FO_777,
          items: [{ id: `${FO_777}-li-1`, sku: "ABC-1", remainingQuantity: 1 }],
        },
      ]),
    ]);

    const svc = createOmsService(dbMock.db);
    const summary = await svc.populateShopifyFulfillmentOrderIds(
      OMS_ORDER_ID,
      SHOPIFY_ORDER_GID,
      client,
    );

    expect(summary).toEqual({ matched: 1, unmatched: 1, updates: 1 });
    expect(dbMock.updates).toHaveLength(1);
    expect(dbMock.updates[0].whereLineId).toBe(9002);
  });

  it("is idempotent: re-running on lines that already have FO IDs still issues an UPDATE without erroring", async () => {
    // Shopify is authoritative for FO IDs, so re-running should overwrite
    // safely. Test that no exception is thrown and the UPDATE fires with
    // the same target IDs (Rule #6 — idempotent).
    const dbMock = makeDb();
    dbMock.setSelectRows([
      {
        id: 9001,
        sku: "ABC-1",
        quantity: 1,
        shopifyFulfillmentOrderLineItemId: `${FO_777}-li-1`, // already populated
      },
    ]);
    const client = makeShopifyClient([
      fulfillmentOrdersResponse([
        {
          id: FO_777,
          items: [{ id: `${FO_777}-li-1`, sku: "ABC-1", remainingQuantity: 1 }],
        },
      ]),
    ]);

    const svc = createOmsService(dbMock.db);
    const summary = await svc.populateShopifyFulfillmentOrderIds(
      OMS_ORDER_ID,
      SHOPIFY_ORDER_GID,
      client,
    );

    expect(summary).toEqual({ matched: 1, unmatched: 0, updates: 1 });
    expect(dbMock.updates).toHaveLength(1);
    expect(dbMock.updates[0].set).toMatchObject({
      shopifyFulfillmentOrderId: FO_777,
      shopifyFulfillmentOrderLineItemId: `${FO_777}-li-1`,
    });
  });
});
