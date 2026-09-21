import { describe, expect, it, vi } from "vitest";
import { WalmartOrderPollService } from "../../adapters/walmart/walmart-order-poll.service";
import { WalmartChannelService } from "../../adapters/walmart/walmart-channel.service";
import { parseWalmartOrder } from "../../adapters/walmart/walmart-us-api";
import { walmartOrderFixture } from "./walmart-fixture";

function setup() {
  const receipts = new Map<string, { source_hash: string; status: string; oms_order_id: number | null }>();
  const repository = {
    withLock: vi.fn(async (_id, action) => action()), assertWarehouse: vi.fn(), markPoll: vi.fn(),
    mappings: vi.fn(async () => [{ product_variant_id: 1, channel_sku: "WALMART-SKU" }]),
    receipt: vi.fn(async (_channel, id) => receipts.get(id)), findOrder: vi.fn(async () => null),
    recordReceipt: vi.fn(async (_channel, id, hash, status, orderId) => { receipts.set(id, { source_hash: hash, status, oms_order_id: orderId }); }),
    reconcileOrderState: vi.fn(),
  };
  const api = { orders: vi.fn(async () => ({ orders: [walmartOrderFixture()], nextCursor: null as string | null })),
    acknowledge: vi.fn(async () => parseWalmartOrder(walmartOrderFixture("Acknowledged"))) };
  const channels = { repository, connection: vi.fn(async () => ({ orders_enabled: true, channel_status: "active", ship_node_id: "NODE-1", import_since: new Date("2026-09-19T12:00:00Z"), checkpoint_at: null })),
    api: () => api, requireRuntime: vi.fn() };
  const oms = { ingestOrder: vi.fn(async () => ({ id: 42 })) };
  const sync = vi.fn(async () => 123 as number | null);
  const service = new WalmartOrderPollService(channels as unknown as WalmartChannelService, oms as never, sync, () => new Date("2026-09-21T12:00:00Z"));
  return { repository, api, channels, oms, sync, service };
}
describe("Walmart acknowledgment-aware order polling", () => {
  it("persists observation, confirms acknowledgment, then materializes once", async () => {
    const s = setup();
    await expect(s.service.poll(1)).resolves.toEqual({ observed: 1, processed: 1 });
    expect(s.oms.ingestOrder.mock.calls.map(call => (call as unknown[])[2])).toMatchObject([
      { sourceTopic: "walmart/observed", lineItems: [{ fulfillableQuantity: 0 }] },
      { sourceTopic: "walmart/acknowledged", lineItems: [{ fulfillableQuantity: 1 }] },
    ]);
    expect(s.api.acknowledge).toHaveBeenCalledOnce();
    expect(s.sync).toHaveBeenCalledWith(42);
    s.api.orders.mockResolvedValue({ orders: [walmartOrderFixture("Acknowledged")], nextCursor: null });
    await s.service.poll(1);
    expect(s.sync).toHaveBeenCalledOnce();
    expect(s.repository.recordReceipt).toHaveBeenCalledTimes(3);
  });
  it("retains checkpoint and never materializes when acknowledgment is ambiguous", async () => {
    const s = setup(); s.api.acknowledge.mockRejectedValue(new Error("timeout"));
    await expect(s.service.poll(1)).rejects.toMatchObject({ code: "WALMART_ORDER_PROCESSING_FAILED" });
    expect(s.sync).not.toHaveBeenCalled();
    expect(s.repository.markPoll).not.toHaveBeenCalledWith(1, expect.anything(), { checkpoint: expect.anything() });
    expect(s.repository.recordReceipt).toHaveBeenLastCalledWith(1, "PO-123", expect.any(String), "failed", 42, "WALMART_ORDER_PROCESSING_FAILED", expect.any(Date));
    s.api.orders.mockResolvedValue({ orders: [walmartOrderFixture("Acknowledged")], nextCursor: null });
    await s.service.poll(1);
    expect(s.api.acknowledge).toHaveBeenCalledOnce();
    expect(s.sync).toHaveBeenCalledOnce();
  });
  it("does not acknowledge unmapped or unsupported financial orders", async () => {
    const s = setup(); s.repository.mappings.mockResolvedValue([]);
    await expect(s.service.poll(1)).rejects.toMatchObject({ code: "WALMART_SKU_UNMAPPED" });
    expect(s.api.acknowledge).not.toHaveBeenCalled(); expect(s.oms.ingestOrder).not.toHaveBeenCalled();
  });
  it("rejects cursor loops while retaining the original warehouse scope", async () => {
    const s = setup(); s.api.orders.mockResolvedValue({ orders: [], nextCursor: "?nextCursor=x&shipNode=EVIL" });
    await expect(s.service.poll(1)).rejects.toMatchObject({ code: "WALMART_CURSOR_INVALID" });
    const query = (s.api.orders.mock.calls[1] as unknown as [URLSearchParams])[0];
    expect(query.get("shipNode")).toBe("NODE-1");
  });
  it("blocks paused channels without any provider reads", async () => {
    const s = setup(); s.channels.connection.mockResolvedValue({ orders_enabled: false, channel_status: "active", ship_node_id: "NODE-1", import_since: new Date(), checkpoint_at: null });
    await expect(s.service.poll(1)).rejects.toMatchObject({ code: "WALMART_INTAKE_PAUSED" });
    expect(s.api.orders).not.toHaveBeenCalled();
  });
  it("does not mark incomplete warehouse handoffs completed", async () => {
    const s = setup(); s.sync.mockResolvedValue(null);
    await expect(s.service.poll(1)).rejects.toMatchObject({ code: "WALMART_WMS_SYNC_INCOMPLETE" });
    expect(s.repository.recordReceipt).toHaveBeenLastCalledWith(1, "PO-123", expect.any(String), "failed", 42, "WALMART_WMS_SYNC_INCOMPLETE", expect.any(Date));
  });
});
