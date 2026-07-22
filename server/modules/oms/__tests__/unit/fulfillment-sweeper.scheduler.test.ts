import { describe, expect, it, vi } from "vitest";
import {
  enqueueRepairedShipNotifyRetries,
  resolveRecoveredShopifyWritebackDebt,
  runFulfillmentSweep,
} from "../../fulfillment-sweeper.scheduler";

function queryText(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => chunk?.value ?? [])
    .join(" ");
}

describe("fulfillment-sweeper.scheduler", () => {
  it("requeues every distinct dead SHIP_NOTIFY callback repaired by the split fix", async () => {
    const execute = vi.fn(async () => ({ rows: [{ enqueued: 37 }] }));

    const result = await enqueueRepairedShipNotifyRetries({ execute }, 500);

    expect(result).toEqual({ enqueued: 37 });
    const query = execute.mock.calls[0]?.[0];
    const text = queryText(query);
    expect(text).toContain("q.provider = 'shipstation'");
    expect(text).toContain("q.topic = 'SHIP_NOTIFY'");
    expect(text).toContain("q.status = 'dead'");
    expect(text).toContain("q.last_error NOT LIKE 'repair_enqueued:%'");
    expect(JSON.stringify(query)).toContain(
      "wms_outbound_shipment_items_qty_positive_chk",
    );
    expect(text).toContain("DISTINCT ON (q.payload->>'resource_url')");
    expect(text).toContain("ON CONFLICT DO NOTHING");
    expect(text).toContain("'pending'");
    expect(text).toContain("SET last_error = 'repair_enqueued:");
  });

  it("rejects unbounded repaired callback scans", async () => {
    const execute = vi.fn();

    await expect(enqueueRepairedShipNotifyRetries({ execute }, 2_001)).rejects.toThrow(
      /limit must be an integer from 1 through 2000/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs bounded physical-package recovery before the ordinary writeback scan", async () => {
    const recover = vi.fn(async () => ({
      candidates: 1,
      matchedPackages: 1,
      enqueueRequests: 1,
      noMatch: 0,
      errors: 0,
    }));
    const db = {
      execute: vi.fn(async () => ({ rows: [] })),
      __shipStationPhysicalRecovery: { recover },
    };

    await runFulfillmentSweep(db);

    expect(recover).toHaveBeenCalledWith({
      mode: "execute",
      limit: 100,
      minAgeHours: 6,
      maxAgeDays: 30,
    });
  });

  it("reserves sweep capacity for recent failures and historical convergence", async () => {
    const pushShopifyFulfillment = vi.fn(async () => ({
      shopifyFulfillmentId: "gid://shopify/Fulfillment/42",
      alreadyPushed: false,
      writebackComplete: true,
    }));
    let candidateQueryCount = 0;
    const execute = vi.fn(async (query: any) => {
      const text = queryText(query);
      if (!text.includes("FROM shipped_channel_shipments")) {
        return { rows: [] };
      }
      candidateQueryCount += 1;
      if (candidateQueryCount === 1) {
        return {
          rows: [{
            shipment_id: 101,
            order_number: "#recent",
            oms_order_id: 201,
            provider: "shopify",
            pending_retry: false,
            dead_retry: false,
          }],
        };
      }
      return {
        rows: [{
          shipment_id: 202,
          order_number: "#historical",
          oms_order_id: 302,
          provider: "shopify",
          pending_retry: false,
          dead_retry: false,
        }],
      };
    });
    const db = {
      execute,
      __fulfillmentPush: { pushShopifyFulfillment },
    };

    await runFulfillmentSweep(db);

    expect(pushShopifyFulfillment).toHaveBeenCalledTimes(2);
    expect(pushShopifyFulfillment).toHaveBeenNthCalledWith(1, 101);
    expect(pushShopifyFulfillment).toHaveBeenNthCalledWith(2, 202);
    const candidateQueries = execute.mock.calls
      .filter(([query]) => queryText(query).includes("FROM shipped_channel_shipments"))
      .map(([query]) => JSON.stringify(query));
    expect(candidateQueries).toHaveLength(2);
    expect(candidateQueries[0]).toContain("make_interval(days");
    expect(candidateQueries[1]).not.toContain("make_interval(days");
  });

  it("repushes a missing split shipment directly, including partially shipped orders", async () => {
    const pushShopifyFulfillment = vi.fn(async () => ({
      shopifyFulfillmentId: "gid://shopify/Fulfillment/42",
      alreadyPushed: false,
      writebackComplete: true,
    }));
    const checkStatus = vi.fn();
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM shipped_channel_shipments")) {
          return {
            rows: [{
              shipment_id: 42,
              order_number: "#split",
              oms_order_id: 200,
              provider: "shopify",
              pending_retry: false,
              dead_retry: false,
            }],
          };
        }
        return { rows: [] };
      }),
      __fulfillmentPush: { pushShopifyFulfillment, checkStatus },
    };

    await runFulfillmentSweep(db);

    expect(pushShopifyFulfillment).toHaveBeenCalledWith(42);
    expect(checkStatus).not.toHaveBeenCalled();
  });

  it("leaves active retries alone but retries dead-lettered historical debt", async () => {
    const pushShopifyFulfillment = vi.fn(async () => ({
      shopifyFulfillmentId: null,
      alreadyPushed: false,
      alreadySatisfied: true,
      writebackComplete: true,
    }));
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM shipped_channel_shipments")) {
          return {
            rows: [
              { shipment_id: 43, provider: "shopify", pending_retry: true, dead_retry: false },
              { shipment_id: 44, provider: "shopify", pending_retry: false, dead_retry: true },
            ],
          };
        }
        return { rows: [] };
      }),
      __fulfillmentPush: { pushShopifyFulfillment },
    };

    await runFulfillmentSweep(db);

    expect(pushShopifyFulfillment).toHaveBeenCalledTimes(1);
    expect(pushShopifyFulfillment).toHaveBeenCalledWith(44);
  });

  it("marks only Shopify fulfillment retry debt and its owned review marker resolved", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = queryText(query);
      if (text.includes("WITH resolved_retry")) {
        return { rows: [{ retry_rows_resolved: 2, inbox_rows_resolved: 1 }] };
      }
      if (text.includes("UPDATE wms.outbound_shipments")) {
        return { rows: [{ id: 44 }] };
      }
      return { rows: [] };
    });
    const transaction = vi.fn(async (callback: (tx: any) => Promise<any>) => callback({ execute }));

    const result = await resolveRecoveredShopifyWritebackDebt({ transaction }, 44);

    expect(result).toEqual({
      retryRowsResolved: 2,
      inboxRowsResolved: 1,
      reviewMarkersCleared: 1,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(queryText(execute.mock.calls[0][0])).toContain("topic = 'shopify_fulfillment_push'");
    expect(queryText(execute.mock.calls[1][0])).toContain(
      "review_reason LIKE 'permanent_fulfillment_push_failure:%'",
    );
  });

  it("durably enqueues a new Shopify retry when an unqueued sweep candidate fails", async () => {
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));
    const execute = vi.fn(async (query: any) => {
      const text = queryText(query);
      if (text.includes("FROM shipped_channel_shipments")) {
        return {
          rows: [{
            shipment_id: 45,
            order_number: "#retry",
            oms_order_id: 201,
            provider: "shopify",
            pending_retry: false,
            dead_retry: false,
          }],
        };
      }
      return { rows: [] };
    });
    const pushError = new Error("temporary Shopify failure");
    const db = {
      execute,
      insert,
      __fulfillmentPush: {
        pushShopifyFulfillment: vi.fn(async () => {
          throw pushError;
        }),
      },
    };

    await runFulfillmentSweep(db);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      provider: "internal",
      topic: "shopify_fulfillment_push",
      payload: { shipmentId: 45 },
      status: "pending",
      lastError: "temporary Shopify failure",
    }));
  });

  it("rejects invalid shipment ids before changing retry state", async () => {
    const execute = vi.fn();
    await expect(resolveRecoveredShopifyWritebackDebt({ execute }, 0)).rejects.toThrow(
      /shipmentId must be a positive integer/,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
