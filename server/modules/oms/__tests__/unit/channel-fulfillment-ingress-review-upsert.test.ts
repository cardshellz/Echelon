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
});
