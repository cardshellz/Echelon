import { describe, expect, it, vi } from "vitest";
import { OrderCancellationService } from "../../application/order-cancellation.service";
import {
  serviceHarness,
  OP,
  KEY,
  START,
} from "../../../order-edits/__tests__/fixtures/order-edit-service.fixture";
import { OrderEditProviderError } from "../../../order-edits/application/order-edit-provider";
import { OrderEditError } from "../../../order-edits/domain/order-edit-error";
import { OrderEditService } from "../../../order-edits/application/order-edit.service";

const actor = "customer:36:8";
function fixture() {
  const h = serviceHarness();
  h.setCurrent({
    transactions: [
      {
        id: "gid://shopify/OrderTransaction/1",
        kind: "SALE",
        status: "SUCCESS",
        parentId: null,
        gateway: "shopify_payments",
        amountCents: h.snapshot().netPaidCents,
        manual: false,
      },
    ],
  });
  const provider = {
    ...h.provider,
    cancelOrder: vi.fn(async () => ({
      jobId: "gid://shopify/OrderCancelJobResult/cancel-1",
      done: false,
    })),
    cancellationJob: vi.fn(async () => ({
      done: true,
      failed: false,
      orderId: h.snapshot().orderId,
    })),
  };
  const warehouse = {
    ...h.warehouse,
    cancellationReleaseProof: vi.fn(async () => ({
      cancelledOrder: true,
      wmsOrderIds: [9],
      shipmentIds: [],
      contentFingerprint: "a".repeat(64),
    })),
  };
  const reviewed = {
    fingerprint: "b".repeat(64),
    returnedPoints: "100.00",
    deductedEarnedPoints: "5.00",
    settled: false,
  };
  const rewards = {
    reviewCancellation: vi.fn(async () => ({ ...reviewed })),
    settleCancellation: vi.fn(async () => ({ ...reviewed, settled: true })),
  };
  const clock = () => new Date(START);
  const service = new OrderCancellationService({
    store: h.store,
    provider,
    warehouse,
    rewards,
    clock,
    uuid: () => OP,
    report: h.report,
  });
  const edits = new OrderEditService(
    h.store,
    provider,
    warehouse,
    clock,
    () => OP,
    h.report,
    undefined,
    undefined,
    undefined,
    service,
  );
  const input = async () => ({
    connectionId: 4,
    omsOrderId: 1,
    expectedRevision: (await service.review(4, 1)).revision,
    requestKey: KEY,
  });
  return {
    ...h,
    provider,
    warehouse,
    rewards,
    reviewed,
    service,
    edits,
    input,
    cancelled: () =>
      h.setCurrent({
        cancelled: true,
        fullyPaid: false,
        netPaidCents: 0,
        outstandingCents: 0,
        capturableCents: 0,
        transactions: [
          ...h.snapshot().transactions,
          {
            ...h.snapshot().transactions[0],
            id: "gid://shopify/OrderTransaction/987",
            kind: "REFUND",
            parentId: h.snapshot().transactions[0].id,
            amountCents: h.snapshot().netPaidCents,
          },
        ],
      }),
  };
}
describe("customer cancellation reuses durable order ownership", () => {
  it("reviews without an operation, hold, order edit, refund or points mutation", async () => {
    const h = fixture();
    h.setCurrent({
      editable: false,
      editableErrors: ["Replacement editing is unavailable"],
    });
    expect(await h.service.review(4, 1)).toMatchObject({
      refundCents: 2000,
      rewards: h.reviewed,
      eligibility: { allowed: true },
    });
    expect(h.record()).toBeNull();
    expect(h.warehouse.acquire).not.toHaveBeenCalled();
    expect(h.provider.cancelOrder).not.toHaveBeenCalled();
    expect(h.rewards.settleCancellation).not.toHaveBeenCalled();
  });
  it("submits Shopify cancellation exactly once and never calls editCommit or refundCreate", async () => {
    const h = fixture(),
      input = await h.input();
    const first = await h.service.submit(input, actor),
      replay = await h.service.submit(input, actor);
    expect(first.operationId).toBe(replay.operationId);
    expect(h.provider.cancelOrder).toHaveBeenCalledTimes(1);
    expect(h.record()).toMatchObject({
      kind: "cancel_order",
      commitKey: KEY,
      quote: null,
      refundIntent: null,
    });
    expect(h.held()).toBe(true);
    expect(h.provider.commit).not.toHaveBeenCalled();
    expect(h.provider.refund).not.toHaveBeenCalled();
    expect(
      h.events.findIndex(
        (event) => event.action === "cancellation_submission_intent",
      ),
    ).toBeLessThan(
      h.events.findIndex((event) => event.action === "cancellation_accepted"),
    );
  });
  it("serializes concurrent confirmations and recovers the same approved request", async () => {
    const h = fixture(),
      input = await h.input();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.provider.cancelOrder.mockImplementationOnce(async () => {
      await wait;
      return { jobId: "gid://shopify/Job/cancel-1", done: false };
    });
    const first = h.service.submit(input, actor);
    await vi.waitFor(() =>
      expect(h.provider.cancelOrder).toHaveBeenCalledTimes(1),
    );
    await expect(h.service.submit(input, actor)).rejects.toMatchObject({
      code: "ORDER_EDIT_BUSY",
    });
    release();
    await first;
    await h.service.submit(input, actor);
    expect(h.provider.cancelOrder).toHaveBeenCalledTimes(1);
  });
  it("rejects a changed review or reward settlement before holding or cancelling", async () => {
    const h = fixture(),
      input = await h.input();
    h.rewards.reviewCancellation.mockResolvedValue({
      ...h.reviewed,
      fingerprint: "c".repeat(64),
    });
    await expect(h.service.submit(input, actor)).rejects.toMatchObject({
      code: "ORDER_CANCELLATION_REVIEW_CHANGED",
    });
    expect(h.warehouse.acquire).not.toHaveBeenCalled();
    expect(h.provider.cancelOrder).not.toHaveBeenCalled();
  });
  it("releases an unchanged cancellation rejected by Shopify without another submission", async () => {
    const h = fixture();
    h.provider.cancelOrder.mockRejectedValueOnce(
      new OrderEditProviderError(
        "ORDER_CANCELLATION_REJECTED",
        "Rejected",
        "rejected",
      ),
    );
    const result = await h.service.submit(await h.input(), actor);
    expect(result.status).toBe("not_submitted");
    expect(h.record().commitStartedAt).toBeNull();
    expect(h.held()).toBe(false);
  });
  it("releases a failed asynchronous cancellation only after unchanged native order proof", async () => {
    const h = fixture();
    await h.service.submit(await h.input(), actor);
    h.provider.cancellationJob.mockResolvedValue({
      done: true,
      failed: true,
      orderId: h.snapshot().orderId,
    });
    await h.service.reconcile(OP);
    expect((await h.service.get(4, 1, KEY, actor)).status).toBe(
      "not_submitted",
    );
    expect(h.held()).toBe(false);
    expect(h.provider.cancelOrder).toHaveBeenCalledTimes(1);
  });
  it("retains ownership when a failed job accompanies a changed order", async () => {
    const h = fixture();
    await h.service.submit(await h.input(), actor);
    h.provider.cancellationJob.mockResolvedValue({
      done: true,
      failed: true,
      orderId: h.snapshot().orderId,
    });
    h.setCurrent({ fingerprint: "f".repeat(64) });
    await h.service.reconcile(OP);
    expect(h.record().status).toBe("review_required");
    expect(h.held()).toBe(true);
  });
  it("does not claim success when an extra capture/refund is hidden by a zero net balance", async () => {
    const h = fixture();
    await h.service.submit(await h.input(), actor);
    h.cancelled();
    h.setCurrent({
      transactions: [
        ...h.snapshot().transactions,
        { ...h.snapshot().transactions[0], id: "extra", amountCents: 100 },
        {
          ...h.snapshot().transactions[0],
          id: "extra-refund",
          parentId: "extra",
          kind: "REFUND",
          amountCents: 100,
        },
      ],
    });
    await h.service.reconcile(OP);
    expect(h.record()).toMatchObject({
      status: "review_required",
      error: { code: "ORDER_CANCELLATION_REFUND_CHANGED" },
    });
    expect((await h.service.get(4, 1, KEY, actor)).refundStatus).toBe("pending");
    expect(h.rewards.settleCancellation).not.toHaveBeenCalled();
    expect(h.held()).toBe(true);
  });
  it("retains ownership after a lost cancellation response and reconciles the actual cancellation", async () => {
    const h = fixture(),
      input = await h.input();
    h.provider.cancelOrder.mockRejectedValueOnce(
      new OrderEditProviderError("SHOPIFY_UNAVAILABLE", "Timeout", "unknown"),
    );
    await h.service.submit(input, actor);
    expect(h.held()).toBe(true);
    h.cancelled();
    await h.service.reconcile(OP);
    expect(await h.service.get(4, 1, KEY, actor)).toMatchObject({
      status: "completed",
      refundStatus: "completed",
      rewards: { settled: true },
    });
    expect(h.held()).toBe(false);
    expect(h.provider.cancelOrder).toHaveBeenCalledTimes(1);
    expect(h.rewards.settleCancellation).toHaveBeenCalledTimes(1);
    await h.service.reconcile(OP);
    expect(h.rewards.settleCancellation).toHaveBeenCalledTimes(1);
  });
  it("keeps holds until the refund settles and never submits a separate refund", async () => {
    const h = fixture();
    await h.service.submit(await h.input(), actor);
    h.setCurrent({ cancelled: true, fullyPaid: false });
    await h.service.reconcile(OP);
    expect((await h.service.get(4, 1, KEY, actor)).status).toBe("refunding");
    expect(h.held()).toBe(true);
    expect(h.rewards.settleCancellation).not.toHaveBeenCalled();
    expect(h.warehouse.cancellationReleaseProof).not.toHaveBeenCalled();
    expect(h.provider.refund).not.toHaveBeenCalled();
  });
  it("retries a rewards outage and a warehouse release without crediting twice", async () => {
    const h = fixture();
    await h.service.submit(await h.input(), actor);
    h.cancelled();
    h.rewards.settleCancellation.mockRejectedValueOnce(
      new OrderEditProviderError(
        "REWARD_ORDER_PROCESSING",
        "Pending",
        "unknown",
      ),
    );
    await h.service.reconcile(OP);
    expect(h.held()).toBe(true);
    h.warehouse.cancellationReleaseProof.mockRejectedValueOnce(
      new OrderEditError("ORDER_CANCELLATION_WAREHOUSE_PENDING", "Pending"),
    );
    await h.service.reconcile(OP);
    expect(h.held()).toBe(true);
    expect(h.rewards.settleCancellation).toHaveBeenCalledTimes(2);
    await h.service.reconcile(OP);
    expect(h.held()).toBe(false);
    expect(h.rewards.settleCancellation).toHaveBeenCalledTimes(2);
  });
  it("does not turn a transient provider read into a permanent review block", async () => {
    const h = fixture();
    await h.service.submit(await h.input(), actor);
    h.provider.readOrder.mockRejectedValueOnce(
      new OrderEditProviderError(
        "SHOPIFY_UNAVAILABLE",
        "Unavailable",
        "rejected",
      ),
    );
    await h.service.reconcile(OP);
    expect(h.record().status).toBe("committing");
    h.cancelled();
    await h.service.reconcile(OP);
    expect(h.record().status).toBe("completed");
  });
  it("retains ownership for changed reward evidence and exposes a staff-review outcome", async () => {
    const h = fixture();
    await h.service.submit(await h.input(), actor);
    h.cancelled();
    h.rewards.settleCancellation.mockResolvedValueOnce({
      ...h.reviewed,
      settled: true,
      fingerprint: "d".repeat(64),
    });
    await h.service.reconcile(OP);
    expect(await h.service.get(4, 1, KEY, actor)).toMatchObject({
      status: "review_required",
      error: { retryable: false },
    });
    expect(h.held()).toBe(true);
  });
  it("cleans an interruption after acquisition but before financial submission", async () => {
    const h = fixture();
    const save = h.store.save.bind(h.store);
    vi.spyOn(h.store, "save").mockImplementation(async (...args) => {
      if (args[3] === "cancellation_submission_intent")
        throw new Error("Interrupted");
      return save(...args);
    });
    await expect(h.service.submit(await h.input(), actor)).rejects.toThrow(
      "Interrupted",
    );
    expect(h.held()).toBe(true);
    await h.service.reconcile(OP);
    expect(h.held()).toBe(false);
    expect(h.record().status).toBe("expired");
    expect(h.provider.cancelOrder).not.toHaveBeenCalled();
  });
  it("retries interrupted cleanup without submitting cancellation", async () => {
    const h = fixture();
    h.warehouse.acquire.mockRejectedValueOnce(
      new Error("Interrupted acquisition"),
    );
    h.warehouse.releaseUnsubmitted.mockRejectedValueOnce(
      new Error("Unavailable cleanup"),
    );
    await h.service.submit(await h.input(), actor);
    expect(h.record().error?.code).toBe("ORDER_CANCELLATION_CLEANUP_PENDING");
    await h.service.reconcile(OP);
    expect(h.record().status).toBe("expired");
    expect(h.provider.cancelOrder).not.toHaveBeenCalled();
  });
  it("keeps status reads observational and rejects other owners or the edit command API", async () => {
    const h = fixture();
    await h.service.submit(await h.input(), actor);
    h.cancelled();
    expect((await h.service.get(4, 1, KEY, actor)).status).toBe("pending");
    expect(h.rewards.settleCancellation).not.toHaveBeenCalled();
    await expect(
      h.service.get(4, 1, KEY, "customer:36:9"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(h.edits.commit(OP, KEY, actor)).rejects.toMatchObject({
      code: "ORDER_CANCELLATION_SEPARATE_FLOW",
    });
    await expect(h.edits.get(OP)).rejects.toMatchObject({
      code: "ORDER_CANCELLATION_SEPARATE_FLOW",
    });
    expect(h.provider.commit).not.toHaveBeenCalled();
  });
  it("uses the normal worker for cancellation recovery", async () => {
    const h = fixture();
    await h.service.submit(await h.input(), actor);
    h.cancelled();
    await h.edits.sweep();
    expect(h.record().status).toBe("completed");
    expect(h.provider.cancelOrder).toHaveBeenCalledTimes(1);
  });
});
