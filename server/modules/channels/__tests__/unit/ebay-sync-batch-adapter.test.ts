import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EbaySyncBatchAdapter } from "../../adapters/ebay/ebay-sync-batch.adapter";
import { savedSyncBatchSchema } from "../../../marketplace-listings/domain/channel-sync-batch";
const destination = {
  channelId: 1,
  provider: "ebay",
  connectionId: 2,
  accountId: "seller",
  environment: "production" as const,
  marketplaceId: "EBAY_US",
};
function fixture(count = 1) {
  const batch = savedSyncBatchSchema.parse({
    id: randomUUID(),
    destination,
    actor: "user:operator",
    createdAt: "2026-10-21T12:00:00.000Z",
    admissionCompletedAt: null,
    admissionError: null,
    members: Array.from({ length: count }, (_, i) => ({
      productId: i + 1,
      name: `Product ${i + 1}`,
      sku: null,
      commandKey: randomUUID(),
    })),
  });
  const sync = vi.fn(async () => ({
    synced: 0,
    errors: 0,
    priceChanges: 0,
    qtyChanges: 0,
    policyChanges: 0,
    pending: 0,
    jobs: [],
    details: [],
  }));
  const select = vi.fn(async () => ({ destination, products: [] }));
  const adapter = new EbaySyncBatchAdapter({
    channelId: 1,
    sync,
    select,
    status: { readCommandStatuses: async () => [] },
  });
  return { batch, sync, adapter, select };
}
describe("thin eBay batch handoff", () => {
  it("explains a confirmed connection refusal before saving a batch", async () => {
    const f = fixture();
    f.select.mockRejectedValue(
      Object.assign(new Error("Connection not verified"), {
        code: "EBAY_SYNC_ACCOUNT_UNVERIFIED",
      }),
    );
    await expect(f.adapter.select(1)).rejects.toMatchObject({
      code: "SYNC_CONNECTION_REQUIRED",
      status: 422,
    });
    expect(f.sync).not.toHaveBeenCalled();
  });
  it("keeps every saved product and key across bounded existing-owner requests", async () => {
    const f = fixture(501);
    await f.adapter.admit(f.batch, f.batch.members);
    expect(f.sync).toHaveBeenCalledTimes(2);
    expect(f.sync).toHaveBeenNthCalledWith(
      1,
      { productIds: Array.from({ length: 500 }, (_, i) => i + 1) },
      "user:operator",
      undefined,
      {
        connectionId: 2,
        accountId: "seller",
        environment: "production",
        marketplaceId: "EBAY_US",
      },
      new Map(
        f.batch.members
          .slice(0, 500)
          .map((member) => [member.productId, member.commandKey]),
      ),
    );
    expect(f.sync).toHaveBeenNthCalledWith(
      2,
      { productIds: [501] },
      "user:operator",
      undefined,
      expect.anything(),
      new Map([[501, f.batch.members[500].commandKey]]),
    );
  });
  it.each([
    "EBAY_SYNC_IDENTITY_CHANGED",
    "EBAY_SYNC_ACCOUNT_UNVERIFIED",
    "EBAY_SYNC_AUTH_REQUIRED",
  ])(
    "translates confirmed %s refusal at the adapter boundary",
    async (code) => {
      const f = fixture();
      f.sync.mockRejectedValue(
        Object.assign(new Error("provider detail"), { code }),
      );
      await expect(
        f.adapter.admit(f.batch, f.batch.members),
      ).rejects.toMatchObject({
        refusal: {
          code:
            code === "EBAY_SYNC_IDENTITY_CHANGED"
              ? "SYNC_DESTINATION_CHANGED"
              : "SYNC_CONNECTION_REQUIRED",
        },
      });
    },
  );
  it("leaves unknown transport and database failures retryable", async () => {
    const f = fixture(),
      error = Object.assign(new Error("Connection lost"), {
        code: "ECONNRESET",
      });
    f.sync.mockRejectedValue(error);
    await expect(f.adapter.admit(f.batch, f.batch.members)).rejects.toBe(error);
  });
});
