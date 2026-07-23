import { describe, expect, it, vi } from "vitest";
import {
  recoverStaleChannelFulfillmentReceipts,
  resolveRecoveredShopifyWritebackDebt,
  runFulfillmentSweep,
} from "../../fulfillment-sweeper.scheduler";

function queryText(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => chunk?.value ?? [])
    .join(" ");
}

function canonicalHandoffResult(options: { retryScheduled?: number } = {}) {
  const retryScheduled = options.retryScheduled ?? 0;
  return {
    materialized: {
      physicalShipmentId: 90001,
      shippingEngineOrderId: 80001,
      channelCommands: [{ id: 70001, pushStatus: "pending" }],
      customerFulfillmentItemCount: 1,
      nonCustomerItemCount: 0,
    },
    dispatch: {
      claimed: 1,
      succeeded: retryScheduled === 0 ? 1 : 0,
      ignored: 0,
      retryScheduled,
      reviewRequired: 0,
      deadLettered: 0,
    },
  };
}

function canonicalAuthority(ensureLegacyShipment: any) {
  return {
    ensureLegacyShipment,
    recordPhysicalPackage: vi.fn(),
    projectPhysicalPackage: vi.fn(),
    runDueBatch: vi.fn(),
  };
}

describe("fulfillment-sweeper.scheduler", () => {
  it("replays stale Shopify and eBay receipts through the original ingress service", async () => {
    const process = vi.fn(async (input: any) => ({
      receiptId: input.sourceProvider === "shopify" ? 501 : 502,
      processingStatus: input.sourceProvider === "shopify" ? "ignored" : "review",
      physicalShipmentId: 90001,
      sourceEcho: input.sourceProvider === "shopify",
      replayed: false,
      inventoryFailures: 0,
      cancellationFailures: 0,
      partialOverlapShipmentIds: [],
    }));
    const execute = vi.fn(async () => ({
      rows: [
        {
          id: 501,
          source_provider: "shopify",
          source_channel_id: 36,
          source_order_id: "12148212400287",
          source_event_id: "webhook_inbox:70825:fulfillment:6312306376863",
          source_inbox_id: 70825,
          event_kind: "reconciled",
          source: "shopify_orders_fulfilled",
          raw_payload: {
            id: "6312306376863",
            order_id: "12148212400287",
            status: "success",
            tracking_number: "1ZE365H56830499454",
            line_items: [{ id: "311001", quantity: 1 }],
          },
          correlation_id: "webhook_inbox:70825",
          causation_id: "webhook_inbox:70825",
        },
        {
          id: 502,
          source_provider: "ebay",
          source_channel_id: 40,
          source_order_id: "07-14878-86923",
          source_event_id: "ebay_reconciler:9400150206217777402897",
          source_inbox_id: null,
          event_kind: "reconciled",
          source: "ebay_fulfillment_reconciler",
          raw_payload: {
            fulfillmentId: "9400150206217777402897",
            shipmentTrackingNumber: "9400150206217777402897",
            lineItems: [{ lineItemId: "1001", quantity: 1 }],
          },
          correlation_id: "ebay_order:07-14878-86923",
          causation_id: "ebay_reconciler:9400150206217777402897",
        },
      ],
    }));

    const result = await recoverStaleChannelFulfillmentReceipts(
      { execute },
      { process } as any,
      { limit: 25, minAgeMinutes: 10, maxAttempts: 8 },
    );

    expect(result).toEqual({
      candidates: 2,
      recovered: 1,
      reviewRequired: 1,
      failed: 0,
    });
    expect(process).toHaveBeenCalledTimes(2);
    expect(process.mock.calls[0][0]).toMatchObject({
      sourceProvider: "shopify",
      sourceChannelId: 36,
      sourceOrderId: "12148212400287",
      sourceFulfillmentId: "6312306376863",
      sourceEventId: "webhook_inbox:70825:fulfillment:6312306376863",
      eventKind: "reconciled",
      source: "shopify_orders_fulfilled",
    });
    expect(process.mock.calls[1][0]).toMatchObject({
      sourceProvider: "ebay",
      sourceChannelId: 40,
      sourceOrderId: "07-14878-86923",
      sourceFulfillmentId: "9400150206217777402897",
      sourceEventId: "ebay_reconciler:9400150206217777402897",
      eventKind: "reconciled",
      source: "ebay_fulfillment_reconciler",
    });
    const query = queryText(execute.mock.calls[0][0]);
    expect(query).toContain("processing_status = 'pending'");
    expect(query).toContain("processing_status = 'processing'");
    expect(query).toContain("lease_expires_at <= NOW()");
    expect(query).toContain("attempt_count <");
  });

  it("isolates a malformed stale receipt and continues recovering later candidates", async () => {
    const process = vi.fn(async () => ({
      receiptId: 602,
      processingStatus: "processed",
      physicalShipmentId: 90002,
      sourceEcho: false,
      replayed: false,
      inventoryFailures: 0,
      cancellationFailures: 0,
      partialOverlapShipmentIds: [],
    }));
    const execute = vi.fn(async () => ({
      rows: [
        {
          id: 601,
          source_provider: "shopify",
          source_order_id: "100",
          event_kind: "reconciled",
          source: "shopify_fulfillment_reconciler",
          raw_payload: { status: "success" },
        },
        {
          id: 602,
          source_provider: "ebay",
          source_order_id: "07-14878-86923",
          event_kind: "reconciled",
          source: "ebay_fulfillment_reconciler",
          raw_payload: {
            fulfillmentId: "200",
            lineItems: [{ lineItemId: "300", quantity: 1 }],
          },
        },
      ],
    }));

    const result = await recoverStaleChannelFulfillmentReceipts(
      { execute },
      { process } as any,
    );

    expect(result).toEqual({
      candidates: 2,
      recovered: 1,
      reviewRequired: 0,
      failed: 1,
    });
    expect(process).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[0][0]).toMatchObject({
      sourceProvider: "ebay",
      sourceFulfillmentId: "200",
    });
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
    };
    const authority = canonicalAuthority(vi.fn());

    await runFulfillmentSweep(db, authority as any, { recover } as any);

    expect(recover).toHaveBeenCalledWith({
      mode: "execute",
      limit: 10,
      minAgeHours: 6,
      maxAgeDays: 30,
    });
  });

  it("reserves sweep capacity for recent failures and historical convergence", async () => {
    const ensureLegacyShipment = vi.fn(async () => canonicalHandoffResult());
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
    const db = { execute };
    const authority = canonicalAuthority(ensureLegacyShipment);

    await runFulfillmentSweep(db, authority as any);

    expect(ensureLegacyShipment).toHaveBeenCalledTimes(2);
    expect(ensureLegacyShipment).toHaveBeenNthCalledWith(1, 101, {
      executeImmediately: true,
      source: "fulfillment_sweeper",
    });
    expect(ensureLegacyShipment).toHaveBeenNthCalledWith(2, 202, {
      executeImmediately: true,
      source: "fulfillment_sweeper",
    });
    const candidateQueries = execute.mock.calls
      .filter(([query]) => queryText(query).includes("FROM shipped_channel_shipments"))
      .map(([query]) => JSON.stringify(query));
    expect(candidateQueries).toHaveLength(2);
    expect(candidateQueries[0]).toContain("make_interval(days");
    expect(candidateQueries[1]).not.toContain("make_interval(days");
  });

  it("repushes a missing split shipment directly, including partially shipped orders", async () => {
    const ensureLegacyShipment = vi.fn(async () => canonicalHandoffResult());
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
    };
    const authority = canonicalAuthority(ensureLegacyShipment);

    await runFulfillmentSweep(db, authority as any);

    expect(ensureLegacyShipment).toHaveBeenCalledWith(42, {
      executeImmediately: true,
      source: "fulfillment_sweeper",
    });
    expect(checkStatus).not.toHaveBeenCalled();
  });

  it("leaves active retries alone but retries dead-lettered historical debt", async () => {
    const ensureLegacyShipment = vi.fn(async () => canonicalHandoffResult());
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
    };
    const authority = canonicalAuthority(ensureLegacyShipment);

    await runFulfillmentSweep(db, authority as any);

    expect(ensureLegacyShipment).toHaveBeenCalledTimes(1);
    expect(ensureLegacyShipment).toHaveBeenCalledWith(44, {
      executeImmediately: true,
      source: "fulfillment_sweeper",
    });
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

  it("leaves transient provider failure in the canonical command retry state", async () => {
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));
    const ensureLegacyShipment = vi.fn(async () =>
      canonicalHandoffResult({ retryScheduled: 1 }));
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
    const db = { execute, insert };
    const authority = canonicalAuthority(ensureLegacyShipment);

    await runFulfillmentSweep(db, authority as any);

    expect(ensureLegacyShipment).toHaveBeenCalledWith(45, {
      executeImmediately: true,
      source: "fulfillment_sweeper",
    });
    expect(insert).not.toHaveBeenCalled();
    expect(values).not.toHaveBeenCalled();
  });

  it("rejects invalid shipment ids before changing retry state", async () => {
    const execute = vi.fn();
    await expect(resolveRecoveredShopifyWritebackDebt({ execute }, 0)).rejects.toThrow(
      /shipmentId must be a positive integer/,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
