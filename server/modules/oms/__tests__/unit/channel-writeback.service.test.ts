import { describe, expect, it, vi } from "vitest";
import {
  findChannelWritebackCandidates,
  getChannelWritebackHealth,
} from "../../channel-writeback.service";

function queryText(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => chunk?.value ?? [])
    .join(" ");
}

describe("channel-writeback.service", () => {
  it("reports writeback per physical shipment and exposes masked split shipments", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            provider: "shopify",
            shipped: 3,
            complete: 1,
            missing: 2,
            masked: 1,
            partial_orders: 1,
            retrying: 1,
            dead: 0,
          },
          {
            provider: "ebay",
            shipped: 1,
            complete: 1,
            missing: 0,
            masked: 0,
            partial_orders: 0,
            retrying: 0,
            dead: 0,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            shipment_id: 42,
            wms_order_id: 100,
            oms_order_id: 200,
            order_number: "#split",
            provider: "shopify",
            oms_status: "partially_shipped",
            shipped_at: "2026-07-10T12:00:00.000Z",
            tracking_number: "1ZTEST",
            carrier: "UPS",
            shopify_fulfillment_id: null,
            has_per_shipment_success: false,
            has_order_level_success: true,
            pending_retry: true,
            dead_retry: false,
            state: "retrying",
          },
        ],
      });

    const health = await getChannelWritebackHealth({ execute }, { windowDays: 14, sampleLimit: 10 });

    expect(health.shipped).toBe(4);
    expect(health.complete).toBe(2);
    expect(health.missing).toBe(2);
    expect(health.masked).toBe(1);
    expect(health.partialOrders).toBe(1);
    expect(health.retrying).toBe(1);
    expect(health.byProvider).toEqual([
      expect.objectContaining({ provider: "shopify", missing: 2, masked: 1 }),
      expect.objectContaining({ provider: "ebay", complete: 1 }),
    ]);
    expect(health.exceptions).toEqual([expect.objectContaining({ shipment_id: 42, state: "retrying" })]);

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("returns only missing physical shipment candidates", async () => {
    const execute = vi.fn(async (query: any) => {
      expect(queryText(query)).toContain("FROM shipped_channel_shipments");
      return {
        rows: [
          {
            shipment_id: 77,
            provider: "shopify",
            pending_retry: false,
            dead_retry: false,
            has_per_shipment_success: false,
          },
        ],
      };
    });

    const candidates = await findChannelWritebackCandidates({ execute }, {
      minAgeMinutes: 60,
      maxAgeDays: 7,
      limit: 25,
      excludeRetryStates: true,
    });

    expect(candidates).toEqual([expect.objectContaining({ shipment_id: 77, provider: "shopify" })]);
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("pending_retry = false");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
