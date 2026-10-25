import { describe, expect, it, vi } from "vitest";
import { verifyRefundedChannelMerchandise } from "../../channel-merchandise-dispatch.service";
import type { ShopifyMerchandiseSnapshot } from "../../infrastructure/shopify-merchandise-snapshot";

const version = "2026-10-24T12:00:00.000Z";
function fixture() {
  const channel = { provider: "shopify" };
  const source = {
    channel_id: 36,
    external_order_id: "1",
    status: "confirmed",
    financial_status: "refunded",
    cancelled_at: null as string | null,
  };
  const line = {
    externalLineItemId: "101",
    paidQuantity: 2,
    authorityFulfillableQuantity: 2,
    channelCurrentQuantity: 2 as number | null,
    channelQuantityUpdatedAt: version as string | null,
  };
  const native: ShopifyMerchandiseSnapshot = {
    orderId: "gid://shopify/Order/1",
    shopDomain: "synthetic.myshopify.com",
    updatedAt: version,
    cancelled: false,
    lines: [
      {
        id: "gid://shopify/LineItem/101",
        quantity: 2,
        currentQuantity: 2,
        unfulfilledQuantity: 2,
      },
    ],
  };
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ rows: [source] })
    .mockResolvedValueOnce({ rows: [channel] })
    .mockResolvedValue({ rows: [line] });
  const readSnapshot = vi.fn(async () => native);
  return {
    channel,
    source,
    line,
    native,
    execute,
    readSnapshot,
    run: (purpose: "dispatch" | "observation" = "dispatch") =>
      verifyRefundedChannelMerchandise({ execute }, 20, purpose, {
        readSnapshot,
      }),
  };
}

describe("refunded money and independent channel dispatch proof", () => {
  it("keeps confirmed, paid merchandise dispatchable after the payment has been fully refunded", async () => {
    const f = fixture();
    await expect(f.run()).resolves.toBe(true);
    expect(f.readSnapshot).toHaveBeenCalledExactlyOnceWith({
      channelId: 36,
      orderId: "1",
    });
  });
  it.each([
    "cancelled",
    "refunded",
    "voided",
    "cancelled_at",
    "unsupported_provider",
    "native_cancelled",
  ])("does not bypass %s protection", async (kind) => {
    const f = fixture();
    if (kind === "cancelled" || kind === "refunded") f.source.status = kind;
    if (kind === "voided") f.source.financial_status = "voided";
    if (kind === "cancelled_at") f.source.cancelled_at = version;
    if (kind === "native_cancelled") f.native.cancelled = true;
    if (kind === "unsupported_provider") f.channel.provider = "ebay";
    await expect(f.run("dispatch")).resolves.toBe(false);
    if (kind !== "native_cancelled")
      expect(f.readSnapshot).not.toHaveBeenCalled();
  });
  it.each(["unknown", "unpaid", "unready", "missing_version", "wrong_order"])(
    "fails closed on %s evidence without writing any data",
    async (kind) => {
      const f = fixture();
      if (kind === "unknown") f.line.channelCurrentQuantity = null;
      if (kind === "unpaid") f.line.paidQuantity = 0;
      if (kind === "unready") f.line.authorityFulfillableQuantity = 0;
      if (kind === "missing_version") f.line.channelQuantityUpdatedAt = null;
      if (kind === "wrong_order") f.native.orderId = "gid://shopify/Order/2";
      await expect(f.run()).rejects.toMatchObject({
        code: "CHANNEL_MERCHANDISE_INGEST_PENDING",
      });
    },
  );
  it("allows observation of already-shipped merchandise without granting permission for another dispatch", async () => {
    const observed = fixture();
    observed.line.authorityFulfillableQuantity = 0;
    observed.native.lines[0].unfulfilledQuantity = 0;
    await expect(observed.run("observation")).resolves.toBe(true);
    const dispatch = fixture();
    dispatch.line.authorityFulfillableQuantity = 0;
    dispatch.native.lines[0].unfulfilledQuantity = 0;
    await expect(dispatch.run()).rejects.toMatchObject({
      code: "CHANNEL_MERCHANDISE_INGEST_PENDING",
    });
  });
});
