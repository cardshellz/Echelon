import { describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import { createDropshipCostChangeRepricePort } from "../../infrastructure/dropship-cost-change-listing-action.factory";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const NOW = new Date("2026-10-13T00:05:00.000Z");

describe("createDropshipCostChangeRepricePort", () => {
  const request = { vendorId: 5, storeConnectionId: 9, productVariantIds: [61, 62], idempotencyKey: "dropship-cost-change-reprice:5:9:abc", actorId: "dropship-cost-changes" };

  it("queues a one-step system push of the current preview under the pass's key", async () => {
    const createListingPushJob = vi.fn(async () => ({
      job: { jobId: 100, vendorId: 5, storeConnectionId: 9, status: "queued", idempotencyKey: request.idempotencyKey, requestHash: "h", createdAt: NOW, updatedAt: NOW },
      items: [
        { itemId: 1, jobId: 100, listingId: 1, productVariantId: 61, status: "queued", previewHash: "p", errorCode: null, errorMessage: null },
        { itemId: 2, jobId: 100, listingId: 2, productVariantId: 62, status: "blocked", previewHash: "p", errorCode: "DROPSHIP_LISTING_PREVIEW_BLOCKED", errorMessage: "tier" },
      ],
      preview: {} as never,
      idempotentReplay: false,
    }));
    const port = createDropshipCostChangeRepricePort({ createListingPushJob });

    await expect(port.queueReprice(request)).resolves.toEqual({
      queued: true, jobId: 100, jobStatus: "queued", idempotentReplay: false,
      items: [{ productVariantId: 61, status: "queued", errorCode: null }, { productVariantId: 62, status: "blocked", errorCode: "DROPSHIP_LISTING_PREVIEW_BLOCKED" }],
    });
    expect(createListingPushJob).toHaveBeenCalledWith({
      vendorId: 5, storeConnectionId: 9, productVariantIds: [61, 62], reviewMode: "current_preview",
      idempotencyKey: request.idempotencyKey, requestedBy: { actorType: "system", actorId: "dropship-cost-changes" },
    });
  });

  it("reports a store that cannot take a push as refused, by the access rule's code", async () => {
    const port = createDropshipCostChangeRepricePort({
      createListingPushJob: vi.fn(async () => {
        throw new DropshipError("DROPSHIP_LISTING_STORE_BLOCKED", "Your store setup isn't finished.", { resolution: "finish_store_setup", action: "push" });
      }),
    });
    await expect(port.queueReprice(request)).resolves.toEqual({ queued: false, code: "DROPSHIP_LISTING_STORE_BLOCKED", message: "Your store setup isn't finished." });
  });

  it("lets every other failure surface, so the vendor's pass is retried", async () => {
    const port = createDropshipCostChangeRepricePort({
      createListingPushJob: vi.fn(async () => { throw new DropshipError("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", "changed while queueing", {}); }),
    });
    await expect(port.queueReprice(request)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT" });
    const crash = createDropshipCostChangeRepricePort({ createListingPushJob: vi.fn(async () => { throw new Error("provider down"); }) });
    await expect(crash.queueReprice(request)).rejects.toThrow("provider down");
  });
});
