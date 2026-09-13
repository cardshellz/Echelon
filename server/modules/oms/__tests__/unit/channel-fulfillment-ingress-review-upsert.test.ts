import { describe, expect, it, vi } from "vitest";

import { createChannelFulfillmentIngressRepository } from "../../channel-fulfillment-ingress.repository";

function sqlText(query: any): string {
  const chunks = query?.queryChunks ?? query?.chunks ?? [];
  if (!Array.isArray(chunks)) return String(query ?? "");
  return chunks
    .flatMap((chunk: any) => chunk?.value ?? [String(chunk)])
    .join(" ");
}

describe("channel fulfillment ingress review exception upsert", () => {
  it("matches the reconciliation exception partial unique index", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{
          source_provider: "shopify",
          source_order_id: "12166949798047",
          source_fulfillment_id: "6332219654303",
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const repository = createChannelFulfillmentIngressRepository({ execute });

    await repository.recordReviewException({
      receiptId: 33352,
      rule: "engine_shipment_partial_overlap",
      summary: "A shipping-engine shipment only partially overlaps fulfilled lines",
      details: { shipmentIds: [8802] },
    });

    expect(execute).toHaveBeenCalledTimes(2);
    const statement = sqlText(execute.mock.calls[1]![0]);
    expect(statement).toContain("INSERT INTO wms.reconciliation_exceptions");
    expect(statement).toContain("'manual_review'");
    expect(statement).toMatch(
      /ON CONFLICT \(idempotency_key\)\s+WHERE status IN \('open', 'acknowledged'\)\s+DO UPDATE/,
    );
  });

  it("resolves only this receipt's owned review exceptions after a successful replay", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 33352,
          processing_status: "processing",
          attempt_count: 2,
          lease_token: "lease-2",
          lease_expires_at: new Date("2026-09-13T15:05:00.000Z"),
          last_attempt_at: new Date("2026-09-13T15:00:00.000Z"),
          physical_shipment_id: 701,
          retry_failure_count: 0,
          next_retry_at: null,
          source_provider: "ebay",
          source_order_id: "order-1",
          source_fulfillment_id: "fulfillment-1",
          source_event_id: "event-1",
          event_kind: "created",
          raw_payload: {},
        }],
      })
      .mockResolvedValue({ rows: [] });
    const repository = createChannelFulfillmentIngressRepository({
      transaction: async (work: (tx: { execute: typeof execute }) => Promise<void>) => work({ execute }),
    });

    await repository.completeReceipt({
      receiptId: 33352,
      leaseToken: "lease-2",
      processingStatus: "processed",
      physicalShipmentId: 701,
      completedAt: new Date("2026-09-13T15:01:00.000Z"),
    });

    const statements = execute.mock.calls.map((call) => sqlText(call[0]));
    const resolution = statements.find((statement) => statement.includes("UPDATE wms.reconciliation_exceptions"));
    expect(resolution).toContain("classification = 'safe_auto_repair'");
    expect(resolution).toContain("status = 'resolved'");
    expect(resolution).toContain("resolved_by = 'channel_fulfillment_ingress'");
    expect(resolution).toContain("WHERE LEFT(");
    expect(resolution).not.toContain("LIKE");
    expect(resolution).toContain("AND status IN ('open', 'acknowledged')");
  });
});
