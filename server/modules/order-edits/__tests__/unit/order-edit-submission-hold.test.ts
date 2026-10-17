import { describe, expect, it, vi } from "vitest";
import { serviceHarness, OP } from "../fixtures/order-edit-service.fixture";
import { OrderEditError } from "../../domain/order-edit-error";
import {
  OrderEditCommitNotSentError,
  OrderEditProviderError,
} from "../../application/order-edit-provider";

describe("submission-only warehouse holds", () => {
  it.each([false, true])(
    "never holds a draft, including quote failure=%s",
    async (fails) => {
      const h = serviceHarness();
      if (fails)
        h.provider.quote.mockRejectedValueOnce(
          new OrderEditProviderError("QUOTE_FAILED", "Try again"),
        );
      await h.service.quote(h.input, "staff");
      expect(h.warehouse.acquire).not.toHaveBeenCalled();
      expect(h.warehouse.assertHeld).not.toHaveBeenCalled();
      await h.service.resume(OP, "staff");
      expect(h.warehouse.acquire).not.toHaveBeenCalled();
      expect(h.provider.commit).not.toHaveBeenCalled();
    },
  );

  it("persists approval before acquiring and prevents submission if picking won", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    h.warehouse.acquire.mockImplementationOnce(async () => {
      expect(h.record()).toMatchObject({
        status: "committing",
        commitStartedAt: null,
      });
      throw new OrderEditError("ORDER_EDIT_PICKING_CUTOFF", "Picking started");
    });
    expect(await h.service.commit(OP, OP, "staff")).toMatchObject({
      status: "review_required",
      canAbandon: true,
      error: { code: "ORDER_EDIT_PICKING_CUTOFF" },
    });
    expect(h.provider.commit).not.toHaveBeenCalled();
    expect(h.held()).toBe(false);
  });

  it("waits for acquisition before sending and keeps the order locked against concurrent cancellation", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    let finish!: () => void;
    h.warehouse.acquire.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.service.commit(OP, OP, "staff");
    await vi.waitFor(() => expect(h.warehouse.acquire).toHaveBeenCalledOnce());
    expect(h.provider.commit).not.toHaveBeenCalled();
    await expect(h.service.abandon(OP, "staff")).rejects.toMatchObject({
      code: "ORDER_EDIT_BUSY",
    });
    finish();
    expect((await pending).status).toBe("awaiting_payment");
  });

  it.each(["acquisition", "fresh read", "changed order", "provider pre-send"])(
    "releases its hold after a confirmed pre-submission failure: %s",
    async (phase) => {
      const h = serviceHarness();
      await h.service.quote(h.input, "staff");
      if (phase === "acquisition")
        h.warehouse.acquire.mockImplementationOnce(async () => {
          h.setHeld(true);
          throw new Error("provider hold response lost");
        });
      if (phase === "fresh read")
        h.provider.readOrder.mockRejectedValueOnce(
          new Error("read unavailable"),
        );
      if (phase === "changed order") h.setCurrent({ fingerprint: "changed" });
      if (phase === "provider pre-send")
        h.provider.commit.mockRejectedValueOnce(
          new OrderEditCommitNotSentError("STOCK_CHANGED", "Stock changed"),
        );
      const result = await h.service.commit(OP, OP, "staff");
      expect(result).toMatchObject({
        status: "review_required",
        canAbandon: true,
      });
      expect(h.record()).toMatchObject({
        commitKey: null,
        commitStartedAt: null,
      });
      expect(h.held()).toBe(false);
      expect(h.events.at(-1)?.action).toBe("unsubmitted_hold_released");
      expect(h.provider.refund).not.toHaveBeenCalled();
      expect(h.report).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: OP,
          phase:
            phase === "acquisition"
              ? "warehouse_acquisition"
              : phase === "provider pre-send"
                ? "shopify_commit"
                : "shopify_revalidation",
          error: expect.any(Object),
          actorFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      );
    },
  );

  it.each(["preparing", "ready", "review_required", "committing"] as const)(
    "cleans up an old or interrupted unsubmitted %s hold through the worker",
    async (status) => {
      const h = serviceHarness();
      await h.service.quote(h.input, "staff");
      h.record().status = status;
      h.setHeld(true);
      await h.service.sweep();
      expect(h.held()).toBe(false);
      expect(h.provider.commit).not.toHaveBeenCalled();
      expect(h.provider.quote).toHaveBeenCalledOnce();
      if (status === "committing")
        expect(h.record().error?.code).toBe(
          "ORDER_EDIT_SUBMISSION_INTERRUPTED",
        );
      await h.service.sweep();
      expect(
        h.events.filter(
          (event) => event.action === "unsubmitted_hold_released",
        ),
      ).toHaveLength(1);
    },
  );

  it("retries failed cleanup without reacquiring a hold or resending submission", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    h.provider.commit.mockRejectedValueOnce(
      new OrderEditCommitNotSentError("STOCK_CHANGED", "Stock changed"),
    );
    h.warehouse.releaseUnsubmitted.mockRejectedValueOnce(
      new Error("ShipStation down"),
    );
    expect(await h.service.commit(OP, OP, "staff")).toMatchObject({
      error: { code: "ORDER_EDIT_HOLD_RELEASE_PENDING" },
    });
    expect(h.held()).toBe(true);
    await h.service.sweep();
    expect(h.held()).toBe(false);
    expect(h.warehouse.acquire).toHaveBeenCalledOnce();
    expect(h.provider.commit).toHaveBeenCalledOnce();
  });

  it("does not release a possibly submitted command after response loss", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    h.provider.commit.mockRejectedValueOnce(new Error("response lost"));
    await h.service.commit(OP, OP, "staff");
    h.provider.reconcileCommit.mockResolvedValueOnce({
      status: "not_applied",
      snapshot: h.snapshot(),
    });
    await h.service.sweep();
    expect(h.held()).toBe(true);
    expect(h.warehouse.releaseUnsubmitted).not.toHaveBeenCalled();
    expect(h.record().commitStartedAt).not.toBeNull();
    expect(h.provider.commit).toHaveBeenCalledOnce();
  });
});
