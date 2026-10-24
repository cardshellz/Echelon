import { beforeEach, describe, expect, it, vi } from "vitest";
import { WmsSyncService } from "../../wms-sync.service";
import type { ShopifyMerchandiseSnapshot } from "../../infrastructure/shopify-merchandise-snapshot";

const rows = vi.hoisted(() => ({
  lines: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../../../db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => rows.lines }) }) },
}));

const VERSION = new Date("2026-10-24T12:00:00Z");
function native(): ShopifyMerchandiseSnapshot {
  return {
    orderId: "gid://shopify/Order/1",
    shopDomain: "synthetic.myshopify.com",
    updatedAt: VERSION.toISOString(),
    cancelled: false,
    lines: [
      {
        id: "gid://shopify/LineItem/101",
        quantity: 2,
        currentQuantity: 1,
        unfulfilledQuantity: 1,
      },
    ],
  };
}
function harness(enabled = true) {
  const snapshot = native();
  const read = vi.fn(async () => snapshot);
  const service = new WmsSyncService({
    useChannelMerchandise: () => enabled,
    readChannelMerchandise: read,
  } as unknown as ConstructorParameters<typeof WmsSyncService>[0]);
  const policy = service as unknown as {
    resolveWarehouseStatus(order: Record<string, unknown>): Promise<string>;
    isFinalOrCancelledOmsOrder(
      order: Record<string, unknown>,
    ): Promise<boolean>;
  };
  return {
    read,
    snapshot,
    policy,
    order: {
      id: 20,
      channelId: 36,
      externalOrderId: "1",
      status: "confirmed",
      financialStatus: "refunded",
      cancelledAt: null,
    },
  };
}
describe("scoped WMS merchandise finality", () => {
  it.each(["partially_refunded", "refunded"])("admits still-owed %s merchandise only with native quantity and prior dispatch permission", async financialStatus => {
    const h = harness(); h.order.financialStatus = financialStatus;
    rows.lines = [{ externalLineItemId: "101", paidQuantity: 1, channelCurrentQuantity: 1,
      channelQuantityUpdatedAt: VERSION, authorityFulfillableQuantity: 1 }];
    expect(await h.policy.resolveWarehouseStatus(h.order)).toBe("ready");
    rows.lines[0].authorityFulfillableQuantity = 0;
    await expect(h.policy.resolveWarehouseStatus(h.order)).rejects.toMatchObject({ code: "CHANNEL_MERCHANDISE_INGEST_PENDING" });
    expect(await harness(false).policy.resolveWarehouseStatus(h.order)).toBe("pending");
  });
  beforeEach(() => {
    rows.lines = [
      {
        externalLineItemId: "101",
        paidQuantity: 1,
        channelCurrentQuantity: 1,
        channelQuantityUpdatedAt: VERSION,
        authorityFulfillableQuantity: 1,
      },
    ];
  });
  it("uses a fresh native open order and matching paid merchandise instead of cancelling on its refund status", async () => {
    const h = harness();
    expect(await h.policy.isFinalOrCancelledOmsOrder(h.order)).toBe(false);
    expect(h.read).toHaveBeenCalledWith({ channelId: 36, orderId: "1" });
  });
  it("retains legacy financial finality until explicit activation", async () => {
    const h = harness(false);
    expect(await h.policy.isFinalOrCancelledOmsOrder(h.order)).toBe(true);
    expect(h.read).not.toHaveBeenCalled();
  });
  it("recognizes native cancellation separately and never dispatches open work with voided payment", async () => {
    const h = harness();
    h.snapshot.cancelled = true;
    expect(await h.policy.isFinalOrCancelledOmsOrder(h.order)).toBe(true);
    h.snapshot.cancelled = false;
    h.order.financialStatus = "voided";
    await expect(
      h.policy.isFinalOrCancelledOmsOrder(h.order),
    ).rejects.toMatchObject({ code: "CHANNEL_PAYMENT_REVIEW_REQUIRED" });
  });
  it.each(["unknown", "unpaid", "excess", "missing", "newer"])(
    "requires consistent %s evidence before synchronization",
    async (kind) => {
      const h = harness();
      if (kind === "unknown") rows.lines[0].channelCurrentQuantity = null;
      if (kind === "unpaid") rows.lines[0].paidQuantity = 0;
      if (kind === "excess") rows.lines[0].authorityFulfillableQuantity = 2;
      if (kind === "missing") rows.lines = [];
      if (kind === "newer")
        rows.lines[0].channelQuantityUpdatedAt = new Date(
          VERSION.getTime() + 1000,
        );
      await expect(
        h.policy.isFinalOrCancelledOmsOrder(h.order),
      ).rejects.toMatchObject({ code: "CHANNEL_MERCHANDISE_INGEST_PENDING" });
    },
  );
  it("rejects a wrong-order observation or a failed channel read", async () => {
    const h = harness();
    h.snapshot.orderId = "gid://shopify/Order/2";
    await expect(
      h.policy.isFinalOrCancelledOmsOrder(h.order),
    ).rejects.toThrow();
    h.read.mockRejectedValueOnce(new Error("Channel unavailable"));
    await expect(h.policy.isFinalOrCancelledOmsOrder(h.order)).rejects.toThrow(
      "Channel unavailable",
    );
  });
});
