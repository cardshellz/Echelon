import { describe, expect, it, vi } from "vitest";
import { serviceHarness, OP } from "../fixtures/order-edit-service.fixture";
import { OrderEditProviderError } from "../../application/order-edit-provider";

async function failedDraft() {
  const h = serviceHarness();
  h.provider.quote.mockRejectedValueOnce(
    new OrderEditProviderError("QUOTE_FAILED", "Quote failed"),
  );
  await h.service.quote(h.input, "customer:36:8");
  return h;
}

describe("resuming an owned unsubmitted order edit", () => {
  it("prepares the saved plan under the same operation without holding fulfillment, preserving its request identity", async () => {
    const h = await failedDraft();
    const original = structuredClone(h.record());
    h.advance(60 * 60_000);
    const resumed = await h.service.resume(OP, original.actorId);
    expect(resumed).toMatchObject({
      operationId: OP,
      status: "ready",
      canAbandon: true,
      quoteAvailable: true,
      error: null,
    });
    expect(h.record()).toMatchObject({
      id: OP,
      requestKey: original.requestKey,
      requestHash: original.requestHash,
      input: original.input,
      commitStartedAt: null,
      refundStartedAt: null,
    });
    expect(Date.parse(h.record().quoteDeadline)).toBeGreaterThan(
      Date.parse(original.quoteDeadline),
    );
    expect(h.provider.quote).toHaveBeenLastCalledWith(
      4,
      original.baseline,
      { changes: h.input.changes, additions: [] },
      OP,
    );
    expect(h.warehouse.acquire).not.toHaveBeenCalled();
    expect(h.events.map((event) => event.action)).toEqual([
      "quote_failed",
      "quote_preparation_resumed",
      "quoted",
    ]);
    await h.service.resume(OP, original.actorId);
    expect(h.provider.quote).toHaveBeenCalledTimes(2);
    expect(h.provider.commit).not.toHaveBeenCalled();
    expect(h.provider.refund).not.toHaveBeenCalled();
    expect(h.warehouse.releaseUnchanged).not.toHaveBeenCalled();
  });

  it("refreshes an expired ready quote without holding or applying it", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "customer:36:8");
    h.advance(60 * 60_000);
    expect(await h.service.resume(OP, "customer:36:8")).toMatchObject({
      operationId: OP,
      status: "ready",
    });
    expect(h.provider.quote).toHaveBeenCalledTimes(2);
    expect(h.provider.commit).not.toHaveBeenCalled();
  });

  it("retains the saved plan without a hold when recalculation fails again", async () => {
    const h = await failedDraft();
    h.provider.quote.mockRejectedValueOnce(
      new OrderEditProviderError("QUOTE_FAILED_AGAIN", "Try again"),
    );
    expect(await h.service.resume(OP, "customer:36:8")).toMatchObject({
      operationId: OP,
      status: "review_required",
      requestedPlan: { changes: h.input.changes },
      error: { code: "QUOTE_FAILED_AGAIN" },
    });
    expect(h.warehouse.releaseUnchanged).not.toHaveBeenCalled();
    expect(h.provider.commit).not.toHaveBeenCalled();
  });

  it("rejects a different actor or a replaced active operation before any preparation", async () => {
    const h = await failedDraft();
    await expect(h.service.resume(OP, "customer:36:9")).rejects.toMatchObject({
      code: "ORDER_EDIT_RESUME_UNAVAILABLE",
    });
    const reference = await h.store.orderReference(4, 1);
    vi.spyOn(h.store, "orderReference").mockResolvedValue({
      ...reference,
      activeOperationId: null,
    });
    await expect(h.service.resume(OP, "customer:36:8")).rejects.toMatchObject({
      code: "ORDER_EDIT_RESUME_UNAVAILABLE",
    });
    expect(h.provider.quote).toHaveBeenCalledTimes(1);
  });

  it("resumes preparation interrupted before a quote was persisted", async () => {
    const h = await failedDraft();
    h.record().status = "preparing";
    h.record().error = null;
    expect(await h.service.resume(OP, "customer:36:8")).toMatchObject({
      status: "ready",
      operationId: OP,
    });
    expect(h.provider.quote).toHaveBeenCalledTimes(2);
    expect(h.provider.commit).not.toHaveBeenCalled();
  });

  it("does not prepare again when a refund intent has been recorded", async () => {
    const h = serviceHarness(1);
    h.provider.quote.mockRejectedValueOnce(
      new OrderEditProviderError("QUOTE_FAILED", "Quote failed"),
    );
    await h.service.quote(h.input, "customer:36:8");
    h.record().refundIntent = await h.provider.prepareRefund();
    const version = h.record().version;
    await h.service.resume(OP, "customer:36:8");
    expect(h.record().version).toBe(version);
    expect(h.provider.quote).toHaveBeenCalledTimes(1);
    expect(h.provider.refund).not.toHaveBeenCalled();
  });

  it("keeps a changed order blocked without overwriting the saved plan", async () => {
    const h = await failedDraft();
    h.setCurrent({ fingerprint: "changed" });
    expect(await h.service.resume(OP, "customer:36:8")).toMatchObject({
      status: "review_required",
      error: { code: "ORDER_EDIT_STALE_ORDER" },
    });
    expect(h.record().input).toEqual(h.input);
    expect(h.provider.quote).toHaveBeenCalledTimes(1);
  });

  it("rechecks the fulfillment cutoff and disabled connection", async () => {
    const h = await failedDraft();
    h.setCurrent({ cancelled: true });
    expect(await h.service.resume(OP, "customer:36:8")).toMatchObject({
      error: { code: "ORDER_EDIT_INELIGIBLE" },
    });
    h.disable();
    await expect(h.service.resume(OP, "customer:36:8")).rejects.toMatchObject({
      code: "ORDER_EDIT_DISABLED",
    });
    expect(h.provider.quote).toHaveBeenCalledTimes(1);
  });

  it.each([
    "commitStartedAt",
    "commitKey",
    "refundStartedAt",
    "recoveryStartedAt",
  ] as const)(
    "never prepares again when %s records a submitted or uncertain command",
    async (field) => {
      const h = await failedDraft();
      // Simulate persisted submission evidence without invoking a provider mutation.
      h.record()[field] = field === "commitKey" ? OP : h.record().createdAt;
      const version = h.record().version;
      await h.service.resume(OP, "customer:36:8");
      expect(h.provider.quote).toHaveBeenCalledTimes(1);
      expect(h.record().version).toBe(version);
      expect(h.provider.commit).not.toHaveBeenCalled();
    },
  );

  it("ignores only an authenticated actor's own hold when presenting order eligibility", async () => {
    const h = await failedDraft();
    await h.service.order(4, 1, "v1", "customer:36:8");
    expect(h.warehouse.inspect).toHaveBeenLastCalledWith(1, OP);
    await h.service.order(4, 1, "v1", "customer:36:9");
    expect(h.warehouse.inspect).toHaveBeenLastCalledWith(1, undefined);
    await h.service.order(4, 1);
    expect(h.warehouse.inspect).toHaveBeenLastCalledWith(1, undefined);
  });
});
