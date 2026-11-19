import { describe, expect, it, vi } from "vitest";
import { serviceHarness, OP } from "../fixtures/order-edit-service.fixture";

describe("read-only observation of concurrent edit commands", () => {
  it("keeps legacy strict responses unchanged and never prepares a financial action", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    const events = h.events.length;
    expect(await h.service.get(OP, "v1")).not.toHaveProperty(
      "commandInProgress",
    );
    expect(await h.service.get(OP, "v1", "v1")).toMatchObject({
      status: "ready",
      commandInProgress: false,
    });
    expect(h.events).toHaveLength(events);
    expect(h.provider.commit).not.toHaveBeenCalled();
    expect(h.warehouse.acquire).not.toHaveBeenCalled();
  });

  it("reports the command lock even before its first status write; then observes the original payment result", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    let release!: () => void;
    let acquired!: () => void;
    const acquiredGate = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = h.store.withOrderLock(1, async () => {
      acquired();
      await releaseGate;
    });
    await acquiredGate;
    try {
      expect(await h.service.get(OP, "v1", "v1")).toMatchObject({
        status: "ready",
        commandInProgress: true,
      });
      await expect(h.service.commit(OP, OP, "staff")).rejects.toMatchObject({
        code: "ORDER_EDIT_BUSY",
      });
      expect(h.provider.commit).not.toHaveBeenCalled();
    } finally {
      release();
      await owner;
    }

    let finishCommit!: () => void;
    const commit = h.provider.commit.getMockImplementation()!;
    h.provider.commit.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        finishCommit = resolve;
      });
      return commit(...args);
    });
    const pending = h.service.commit(OP, OP, "staff");
    await vi.waitFor(() => expect(h.provider.commit).toHaveBeenCalledOnce());
    try {
      expect(await h.service.get(OP, "v1", "v1")).toMatchObject({
        status: "committing",
        commandInProgress: true,
      });
    } finally {
      finishCommit();
    }
    await pending;
    expect(await h.service.get(OP, "v1", "v1")).toMatchObject({
      status: "awaiting_payment",
      commandInProgress: false,
      balanceDueCents: 1000,
      paymentUrl: "https://test.myshopify.com/pay",
    });
    expect(h.provider.commit).toHaveBeenCalledOnce();
    expect(h.provider.refund).not.toHaveBeenCalled();
  });

  it("does not disguise an observation store failure as a busy command", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    vi.spyOn(h.store, "withOrderLock").mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(h.service.get(OP, "v1", "v1")).rejects.toThrow(
      "database unavailable",
    );
    expect(h.provider.commit).not.toHaveBeenCalled();
  });
});
