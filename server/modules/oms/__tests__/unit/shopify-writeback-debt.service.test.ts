import { describe, expect, it, vi } from "vitest";

import { resolveShopifyWritebackDebtForOrder } from "../../shopify-writeback-debt.service";

function queryText(query: any): string {
  return (query?.queryChunks ?? [])
    .map((chunk: any) => {
      if (typeof chunk === "string") return chunk;
      if (Array.isArray(chunk?.value)) return chunk.value.join("");
      return "";
    })
    .join("");
}

function debtRow() {
  return {
    retry_id: 1001,
    source_inbox_id: 2001,
    shipment_id: 101,
    tracking_number: "TRACK101",
    external_order_id: "12001",
  };
}

function itemRow(directEvidenceQuantity: number) {
  return {
    shipment_id: 101,
    legacy_shipment_item_id: 3001,
    wms_order_item_id: 4001,
    channel_order_line_id: "9001",
    quantity_required: 2,
    direct_evidence_quantity: directEvidenceQuantity,
  };
}

describe("resolveShopifyWritebackDebtForOrder", () => {
  it("transactionally closes only proven dead retry debt and its owned review marker", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = queryText(query);
      if (text.includes("FROM oms.webhook_retry_queue retry")) {
        return { rows: [debtRow()] };
      }
      if (text.includes("FROM wms.outbound_shipment_items shipment_item")) {
        return { rows: [itemRow(2)] };
      }
      if (text.includes("UPDATE oms.webhook_retry_queue")) {
        return { rows: [{ id: 1001, source_inbox_id: 2001 }] };
      }
      if (text.includes("UPDATE oms.webhook_inbox")) {
        return { rows: [{ id: 2001 }] };
      }
      if (text.includes("UPDATE wms.outbound_shipments")) {
        return { rows: [{ id: 101 }] };
      }
      if (text.includes("INSERT INTO oms.oms_order_events")) {
        return { rows: [{ id: 9001 }] };
      }
      return { rows: [] };
    });
    const transaction = vi.fn(async (callback: (tx: any) => Promise<any>) =>
      callback({ execute }));

    const result = await resolveShopifyWritebackDebtForOrder({ transaction }, {
      omsOrderId: 5001,
      mode: "direct",
      source: "unit-test",
      resolvedAt: new Date("2026-07-27T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      omsOrderId: 5001,
      candidateShipmentCount: 1,
      resolvedShipmentIds: [101],
      resolvedRetryIds: [1001],
      unresolved: [],
      retryRowsResolved: 1,
      inboxRowsResolved: 1,
      reviewMarkersCleared: 1,
      eventRecorded: true,
    });
    expect(transaction).toHaveBeenCalledTimes(1);

    const retryUpdate = execute.mock.calls
      .map(([query]) => queryText(query))
      .find((text) => text.includes("UPDATE oms.webhook_retry_queue"));
    expect(retryUpdate).toContain("topic = 'shopify_fulfillment_push'");
    expect(retryUpdate).toContain("status = 'dead'");

    const reviewUpdate = execute.mock.calls
      .map(([query]) => queryText(query))
      .find((text) => text.includes("UPDATE wms.outbound_shipments"));
    expect(reviewUpdate).toContain("review_reason LIKE");
    expect(reviewUpdate).toContain("RETURNING id");

    const eventCommand = execute.mock.calls
      .map(([query]) => query)
      .find((query) => queryText(query).includes("INSERT INTO oms.oms_order_events"));
    expect(JSON.stringify(eventCommand)).toContain("retryStatusTransition");
    expect(JSON.stringify(eventCommand)).toContain("originalLastError");
  });

  it("leaves retry, inbox, review, and event state unchanged when evidence is incomplete", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = queryText(query);
      if (text.includes("FROM oms.webhook_retry_queue retry")) {
        return { rows: [debtRow()] };
      }
      if (text.includes("FROM wms.outbound_shipment_items shipment_item")) {
        return { rows: [itemRow(1)] };
      }
      return { rows: [] };
    });
    const transaction = vi.fn(async (callback: (tx: any) => Promise<any>) =>
      callback({ execute }));

    const result = await resolveShopifyWritebackDebtForOrder({ transaction }, {
      omsOrderId: 5001,
      mode: "direct",
      source: "unit-test",
    });

    expect(result.resolvedRetryIds).toEqual([]);
    expect(result.unresolved).toEqual([{
      shipmentId: 101,
      reason: "direct_package_evidence_incomplete",
    }]);
    expect(result.retryRowsResolved).toBe(0);
    const allSql = execute.mock.calls.map(([query]) => queryText(query)).join("\n");
    expect(allSql).not.toContain("UPDATE oms.webhook_retry_queue");
    expect(allSql).not.toContain("UPDATE wms.outbound_shipments");
    expect(allSql).not.toContain("INSERT INTO oms.oms_order_events");
  });

  it("resolves trackingless debt from a complete exact Shopify line snapshot", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = queryText(query);
      if (text.includes("FROM oms.webhook_retry_queue retry")) {
        return { rows: [{ ...debtRow(), tracking_number: null }] };
      }
      if (text.includes("FROM wms.outbound_shipment_items shipment_item")) {
        return { rows: [itemRow(0)] };
      }
      if (text.includes("UPDATE oms.webhook_retry_queue")) {
        return { rows: [{ id: 1001, source_inbox_id: 2001 }] };
      }
      if (text.includes("UPDATE oms.webhook_inbox")) return { rows: [{ id: 2001 }] };
      if (text.includes("UPDATE wms.outbound_shipments")) return { rows: [{ id: 101 }] };
      if (text.includes("INSERT INTO oms.oms_order_events")) return { rows: [{ id: 9001 }] };
      return { rows: [] };
    });
    const transaction = vi.fn(async (callback: (tx: any) => Promise<any>) =>
      callback({ execute }));

    const result = await resolveShopifyWritebackDebtForOrder({ transaction }, {
      omsOrderId: 5001,
      mode: "full_snapshot",
      source: "unit-test-snapshot",
      providerSnapshot: {
        sourceOrderId: "12001",
        observedAt: new Date("2026-07-27T12:00:00.000Z"),
        complete: true,
        packages: [{
          sourceFulfillmentId: "7001",
          trackingNumbers: ["OTHERTRACKING"],
          items: [{
            sourceFulfillmentLineId: "8001",
            channelOrderLineId: "9001",
            quantity: 2,
          }],
        }],
        incompleteReasons: [],
      },
    });

    expect(result.resolvedRetryIds).toEqual([1001]);
    const allSql = execute.mock.calls.map(([query]) => queryText(query)).join("\n");
    expect(allSql).not.toContain("INSERT INTO wms.outbound_shipments");
    expect(allSql).not.toContain("inventory_movements");
    expect(allSql).not.toContain("INSERT INTO oms.channel_fulfillment_receipts");
  });

  it("rejects provider evidence from a different Shopify order before mutation", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = queryText(query);
      if (text.includes("FROM oms.webhook_retry_queue retry")) {
        return { rows: [{ ...debtRow(), tracking_number: null }] };
      }
      return { rows: [] };
    });
    const transaction = vi.fn(async (callback: (tx: any) => Promise<any>) =>
      callback({ execute }));

    await expect(resolveShopifyWritebackDebtForOrder({ transaction }, {
      omsOrderId: 5001,
      mode: "full_snapshot",
      source: "unit-test-wrong-order",
      providerSnapshot: {
        sourceOrderId: "99999",
        observedAt: new Date("2026-07-27T12:00:00.000Z"),
        complete: true,
        packages: [],
        incompleteReasons: [],
      },
    })).rejects.toThrow(/does not belong to the retry order/);

    const allSql = execute.mock.calls.map(([query]) => queryText(query)).join("\n");
    expect(allSql).not.toContain("UPDATE oms.webhook_retry_queue");
    expect(allSql).not.toContain("UPDATE wms.outbound_shipments");
  });

  it("rejects mutation when the database cannot provide a transaction", async () => {
    const execute = vi.fn();

    await expect(resolveShopifyWritebackDebtForOrder({ execute }, {
      omsOrderId: 5001,
      mode: "direct",
      source: "unit-test-no-transaction",
    })).rejects.toThrow(/requires transaction-capable database access/);

    expect(execute).not.toHaveBeenCalled();
  });

  it("evaluates proven evidence in dry-run without mutating any state", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = queryText(query);
      if (text.includes("FROM oms.webhook_retry_queue retry")) {
        return { rows: [debtRow()] };
      }
      if (text.includes("FROM wms.outbound_shipment_items shipment_item")) {
        return { rows: [itemRow(2)] };
      }
      return { rows: [] };
    });
    const transaction = vi.fn(async (callback: (tx: any) => Promise<any>) =>
      callback({ execute }));

    const result = await resolveShopifyWritebackDebtForOrder({ transaction }, {
      omsOrderId: 5001,
      mode: "direct",
      source: "unit-test-dry-run",
      execute: false,
    });

    expect(result.resolvedRetryIds).toEqual([1001]);
    expect(result.retryRowsResolved).toBe(0);
    const allSql = execute.mock.calls.map(([query]) => queryText(query)).join("\n");
    expect(
      execute.mock.calls
        .map(([query]) => queryText(query))
        .some((text) => /^\s*UPDATE /i.test(text)),
    ).toBe(false);
    expect(allSql).not.toContain("INSERT INTO oms.oms_order_events");
  });
});
