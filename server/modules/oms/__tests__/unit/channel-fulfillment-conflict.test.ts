import { describe, expect, it, vi } from "vitest";
import {
  buildEbayTrackingConflictIdempotencyKey,
  EbayTrackingConflictError,
  isEbayTrackingConflictError,
  recordEbayTrackingConflict,
} from "../../channel-fulfillment-conflict";

const INPUT = {
  omsOrderId: 244780,
  wmsOrderId: 205216,
  wmsShipmentId: 8802,
  externalOrderId: "07-14878-86923",
  priorEventId: 193001,
  priorFulfillmentId: "9400150206217770309995",
  priorTrackingNumber: "9400150206217770309995",
  currentTrackingNumber: "9400150206217777402897",
};

function sqlText(query: any): string {
  const chunks = query?.queryChunks ?? query?.chunks ?? [];
  if (!Array.isArray(chunks)) return String(query ?? "");
  return chunks
    .flatMap((chunk: any) => chunk?.value ?? [String(chunk)])
    .join(" ");
}

describe("eBay tracking conflict reconciliation", () => {
  it("builds a stable key scoped to the WMS shipment and both tracking values", () => {
    expect(buildEbayTrackingConflictIdempotencyKey(INPUT)).toBe(
      "channel_writeback:ebay_tracking_changed_after_fulfillment:" +
        "shipment:8802:prior:9400150206217770309995:" +
        "current:9400150206217777402897",
    );
  });

  it("persists a manual-review exception without mutating fulfillment", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));

    await recordEbayTrackingConflict({ execute }, INPUT);

    expect(execute).toHaveBeenCalledTimes(1);
    const statement = sqlText(execute.mock.calls[0]![0]);
    expect(statement).toContain("INSERT INTO wms.reconciliation_exceptions");
    expect(statement).toContain("ON CONFLICT (idempotency_key)");
    expect(statement).not.toContain("UPDATE wms.outbound_shipments");
    expect(statement).not.toContain("UPDATE oms.oms_orders");
  });

  it("exposes a structured non-retryable error code", () => {
    const error = new EbayTrackingConflictError(INPUT);

    expect(isEbayTrackingConflictError(error)).toBe(true);
    expect(error.context).toMatchObject({
      code: "ebay_tracking_conflict",
      shipmentId: 8802,
      priorTrackingNumber: INPUT.priorTrackingNumber,
      currentTrackingNumber: INPUT.currentTrackingNumber,
    });
  });
});
