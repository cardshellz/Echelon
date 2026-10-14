import { describe, expect, it, vi } from "vitest";
import { serviceHarness } from "../fixtures/order-edit-service.fixture";
import { priceOrderEditCodes } from "../../domain/order-edit-code-pricing";
import { OrderEditCommitNotSentError } from "../../application/order-edit-provider";
import type { OrderEditCodeRedemptions } from "../../application/order-edit-code-redemptions";

const key = "44444444-4444-4444-8444-444444444444";
function harness(
  quantity = 2,
  source: "unlimited" | "shopify_coupon" = "unlimited",
) {
  const codes = {
    available: (): boolean => true,
    reserve: vi.fn(async () => {}),
    finalize: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  } satisfies OrderEditCodeRedemptions;
  const h = serviceHarness(quantity, undefined, codes);
  h.input.discountCodes = ["TEN"];
  h.quote.codePricing = priceOrderEditCodes(
    [
      {
        id: h.quote.lines[0].calculatedLineId,
        variantId: h.quote.lines[0].variantId,
        quantity,
        grossCents: quantity * 1000,
        productNetCents: quantity * 1000,
      },
    ],
    [
      {
        code: "TEN",
        discountId: "gid://shopify/DiscountCodeNode/1",
        classes: ["ORDER"],
        combinesWith: {
          orderDiscounts: true,
          productDiscounts: true,
          shippingDiscounts: true,
        },
        value: { type: "percentage", percentage: "10" },
        fingerprint: "a".repeat(64),
        redemption: source,
        ...(source === "shopify_coupon"
          ? { usageLimit: null, appliesOncePerCustomer: false }
          : {}),
      },
    ],
    ["TEN"],
  );
  const total = h.quote.codePricing.lines[0].netCents;
  h.quote.totalCents = total;
  h.quote.deltaCents = h.quote.outstandingCents = total - 2000;
  h.quote.lines[0].totalCents = total;
  h.quote.lines[0].discountedUnitPriceCents = 900;
  if (quantity === 2) h.input.changes = [];
  h.quote.plan = {
    changes: h.input.changes,
    additions: h.input.additions,
    discountCodes: h.input.discountCodes,
  };
  h.provider.commit.mockImplementation(
    async (_connection, _quote, _operation, before) => {
      await before?.();
      const current = h.snapshot();
      h.setCurrent({
        ...current,
        totalCents: total,
        subtotalCents: total,
        outstandingCents: total - 2000,
        fullyPaid: total <= 2000,
        fingerprint: "edited",
        contentFingerprint: "contents-edited",
        lines: [
          {
            ...current.lines[0],
            quantity,
            unfulfilledQuantity: quantity,
            totalCents: total,
            discountedUnitPriceCents: 900,
          },
        ],
      });
      return structuredClone(h.snapshot());
    },
  );
  const originalPrepare = h.provider.prepareRefund.getMockImplementation()!;
  h.provider.prepareRefund.mockImplementation(async () => ({
    ...(await originalPrepare()),
    amountCents: 2000 - total,
  }));
  return { ...h, codes };
}
describe("code settlement boundaries in order editing", () => {
  it("applies an unlimited Shopify coupon independently of the rewards service", async () => {
    const h = harness(2, "shopify_coupon");
    h.codes.available = () => false;
    const review = await h.service.quote(h.input, "staff");
    expect(review.codeEntryAvailable).toBe(true);
    const result = await h.service.commit(h.record().id, key, "staff");
    expect(result.status).toBe("completed");
    expect(h.codes.reserve).not.toHaveBeenCalled();
    expect(h.codes.finalize).not.toHaveBeenCalled();
    expect(h.codes.release).not.toHaveBeenCalled();
  });
  it("recovers an unpaid coupon-only adjustment without touching points or reward receipts", async () => {
    const h = harness(3, "shopify_coupon");
    await h.service.quote(h.input, "staff");
    expect((await h.service.commit(h.record().id, key, "staff")).status).toBe(
      "awaiting_payment",
    );
    h.advance(31 * 60_000);
    expect((await h.service.reconcile(h.record().id, "staff")).status).toBe(
      "recovered",
    );
    expect(h.codes.reserve).not.toHaveBeenCalled();
    expect(h.codes.finalize).not.toHaveBeenCalled();
    expect(h.codes.release).not.toHaveBeenCalled();
  });
  it("propagates requested codes and presents the original resumable plan", async () => {
    const h = harness();
    const result = await h.service.quote(h.input, "staff");
    expect(h.provider.quote).toHaveBeenCalledWith(
      4,
      expect.anything(),
      expect.objectContaining({ discountCodes: ["TEN"] }),
      result.operationId,
    );
    expect(result.requestedPlan?.discountCodes).toEqual(["TEN"]);
    expect(result.expectedRevision).toBe("baseline");
  });
  it("reserves before submitting and finalizes before fulfillment release; duplicate confirmation consumes once", async () => {
    const h = harness();
    await h.service.quote(h.input, "staff");
    const result = await h.service.commit(h.record().id, key, "staff");
    expect(result.status).toBe("completed");
    expect(h.codes.reserve).toHaveBeenCalledTimes(1);
    expect(h.codes.finalize).toHaveBeenCalledTimes(1);
    expect(h.codes.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      h.codes.finalize.mock.invocationCallOrder[0],
    );
    expect(h.codes.finalize.mock.invocationCallOrder[0]).toBeLessThan(
      h.warehouse.reconcileAndRelease.mock.invocationCallOrder[0],
    );
    await h.service.commit(h.record().id, key, "staff");
    expect(h.codes.reserve).toHaveBeenCalledTimes(1);
    expect(h.provider.commit).toHaveBeenCalledTimes(1);
  });
  it("keeps fulfillment held if code finalization fails after a successful order commit", async () => {
    const h = harness();
    h.codes.finalize.mockRejectedValueOnce(new Error("Ledger unavailable"));
    await h.service.quote(h.input, "staff");
    const pending = await h.service.commit(h.record().id, key, "staff");
    expect(pending.status).toBe("synchronizing");
    expect(h.warehouse.reconcileAndRelease).not.toHaveBeenCalled();
    const completed = await h.service.reconcile(h.record().id, "staff");
    expect(completed.status).toBe("completed");
    expect(h.provider.commit).toHaveBeenCalledTimes(1);
    expect(h.codes.reserve).toHaveBeenCalledTimes(1);
  });
  it("does not mark a reward used while additional payment is outstanding", async () => {
    const h = harness(3);
    await h.service.quote(h.input, "staff");
    const result = await h.service.commit(h.record().id, key, "staff");
    expect(result.status).toBe("awaiting_payment");
    expect(h.codes.reserve).toHaveBeenCalledTimes(1);
    expect(h.codes.finalize).not.toHaveBeenCalled();
    h.advance(31 * 60_000);
    const recovered = await h.service.reconcile(h.record().id, "staff");
    expect(recovered.status).toBe("recovered");
    expect(h.codes.release).toHaveBeenCalledTimes(1);
    expect(h.codes.release.mock.invocationCallOrder[0]).toBeLessThan(
      h.warehouse.reconcileAndRelease.mock.invocationCallOrder[0],
    );
  });
  it("finalizes only after its exact refund is observed", async () => {
    const h = harness(1);
    await h.service.quote(h.input, "staff");
    const result = await h.service.commit(h.record().id, key, "staff");
    expect(result.status).toBe("completed");
    expect(h.codes.finalize).toHaveBeenCalledTimes(1);
    expect(h.provider.refund.mock.invocationCallOrder[0]).toBeLessThan(
      h.codes.finalize.mock.invocationCallOrder[0],
    );
  });
  it("releases an uncertain code reservation only after a proven unsubmitted cancellation", async () => {
    const h = harness();
    await h.service.quote(h.input, "staff");
    h.provider.commit.mockRejectedValueOnce(
      new OrderEditCommitNotSentError(
        "RESERVE_UNKNOWN",
        "Code disable reply lost",
      ),
    );
    const rejected = await h.service.commit(h.record().id, key, "staff");
    expect(rejected.canAbandon).toBe(true);
    expect(h.codes.release).not.toHaveBeenCalled();
    await h.service.abandon(h.record().id, "staff");
    expect(h.codes.release).toHaveBeenCalledTimes(1);
    expect(h.codes.release.mock.invocationCallOrder[0]).toBeLessThan(
      h.warehouse.releaseUnchanged.mock.invocationCallOrder[0],
    );
  });
  it("does not release a code when the order changed before cancellation", async () => {
    const h = harness();
    await h.service.quote(h.input, "staff");
    h.setCurrent({ fingerprint: "changed" });
    const result = await h.service.abandon(h.record().id, "staff");
    expect(result.status).toBe("review_required");
    expect(h.codes.release).not.toHaveBeenCalled();
  });
});
