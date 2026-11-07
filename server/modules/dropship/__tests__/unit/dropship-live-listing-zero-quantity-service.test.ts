import { describe, expect, it, vi } from "vitest";
import { DropshipLiveListingZeroQuantityService } from "../../application/dropship-live-listing-zero-quantity-service";
import { DropshipError } from "../../domain/errors";
import { MARKETPLACE_QUANTITY_UNAVAILABLE_BLOCKER } from "../../domain/marketplace-sync-sweep";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const target = { vendorId: 5, storeConnectionId: 7, listingId: 4, productVariantId: 101, sku: "P5" };
const live = { status: "active", externalListingId: "110004", externalOfferId: "OFFER-4" };

function setup() {
  const sendZeroQuantity = vi.fn().mockResolvedValue({ sku: "P5", offerId: "OFFER-4" });
  const settleZeroQuantity = vi.fn().mockResolvedValue({ pushedQuantityBefore: 6, lastPushedAtBefore: new Date("2026-11-01T00:00:00.000Z") });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const service = new DropshipLiveListingZeroQuantityService({
    sender: { sendZeroQuantity }, repository: { settleZeroQuantity }, clock: { now: () => NOW }, logger,
  });
  const input = { target, blockers: [MARKETPLACE_QUANTITY_UNAVAILABLE_BLOCKER], listing: live,
    actorId: "inventory_publication_catchup", reason: "inventory-publication-catchup:3:2" };
  return { service, sendZeroQuantity, settleZeroQuantity, logger, input };
}

describe("DropshipLiveListingZeroQuantityService", () => {
  it("sends 0 to the recorded offer, settles it at 0 and logs one structured INFO line", async () => {
    const context = setup();
    await expect(context.service.publishZeroIfLive(context.input)).resolves.toEqual({ outcome: "sent", externalOfferId: "OFFER-4" });
    expect(context.sendZeroQuantity).toHaveBeenCalledWith({ ...target, externalOfferId: "OFFER-4" });
    expect(context.settleZeroQuantity).toHaveBeenCalledWith({ ...target, externalOfferId: "OFFER-4",
      actorId: "inventory_publication_catchup", reason: "inventory-publication-catchup:3:2", now: NOW });
    expect(context.sendZeroQuantity.mock.invocationCallOrder[0]).toBeLessThan(context.settleZeroQuantity.mock.invocationCallOrder[0]);
    expect(context.logger.info).toHaveBeenCalledOnce();
    expect(context.logger.info.mock.calls[0][0]).toMatchObject({ code: "DROPSHIP_LIVE_LISTING_ZERO_QUANTITY_SENT",
      context: { action: "dropship.listing_quantity.zero_sent", outcome: "sent", listingId: 4, externalOfferId: "OFFER-4",
        before: { pushedQuantity: 6, lastPushedAt: "2026-11-01T00:00:00.000Z" }, after: { pushedQuantity: 0 } } });
    expect(context.logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["another blocker", { blockers: [MARKETPLACE_QUANTITY_UNAVAILABLE_BLOCKER, "variant_not_selected"] }, "other_blockers"],
    ["not live", { listing: { ...live, status: "ended" } }, "not_live"],
    ["no external listing id", { listing: { ...live, externalListingId: null } }, "not_published"],
    ["no offer id", { listing: { ...live, externalOfferId: null } }, "no_offer"],
  ])("refuses (%s) without sending or writing anything", async (_name, override, reason) => {
    const context = setup();
    await expect(context.service.publishZeroIfLive({ ...context.input, ...override })).resolves.toEqual({ outcome: "refused", reason });
    expect(context.sendZeroQuantity).not.toHaveBeenCalled();
    expect(context.settleZeroQuantity).not.toHaveBeenCalled();
    expect(context.logger.info).not.toHaveBeenCalled();
  });

  it("settles nothing when the send fails, and passes the classified failure on", async () => {
    const context = setup();
    const refused = new DropshipError("DROPSHIP_EBAY_ZERO_QUANTITY_OFFER_MISMATCH", "mismatch", { retryable: false });
    context.sendZeroQuantity.mockRejectedValue(refused);
    await expect(context.service.publishZeroIfLive(context.input)).rejects.toBe(refused);
    expect(context.settleZeroQuantity).not.toHaveBeenCalled();
    expect(context.logger.info).not.toHaveBeenCalled();
  });

  it("passes a settlement conflict on (retryable), after the 0 was sent, without logging success", async () => {
    const context = setup();
    const conflict = new DropshipError("DROPSHIP_LISTING_ZERO_QUANTITY_SETTLEMENT_CONFLICT", "changed", { retryable: true });
    context.settleZeroQuantity.mockRejectedValue(conflict);
    await expect(context.service.publishZeroIfLive(context.input)).rejects.toBe(conflict);
    expect(context.sendZeroQuantity).toHaveBeenCalledOnce();
    expect(context.logger.info).not.toHaveBeenCalled();
  });

  it("is idempotent on replay: the same 0 to the same offer, settled at 0 again", async () => {
    const context = setup();
    await context.service.publishZeroIfLive(context.input);
    await context.service.publishZeroIfLive(context.input);
    expect(context.sendZeroQuantity).toHaveBeenCalledTimes(2);
    expect(context.sendZeroQuantity.mock.calls[1]).toEqual(context.sendZeroQuantity.mock.calls[0]);
    expect(context.settleZeroQuantity.mock.calls[1]).toEqual(context.settleZeroQuantity.mock.calls[0]);
  });
});
