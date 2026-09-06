import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retrySerializableMasterDataTransaction } from "../../infrastructure/serializable-master-data-transaction";

describe("serializable master-data transaction retries", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns success without retrying", async () => {
    const result = { modelId: 1, alreadyApplied: true };
    const transaction = vi.fn().mockResolvedValue(result);
    await expect(retrySerializableMasterDataTransaction("create_transformation_draft", transaction))
      .resolves.toBe(result);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("restarts the full transaction after rollback and preserves the current business conflict", async () => {
    const events: string[] = [];
    const transaction = vi.fn(async () => {
      events.push("begin");
      if (events.length === 1) {
        events.push("write", "rollback");
        throw Object.assign(new Error("serialization"), { code: "40001" });
      }
      events.push("read current head");
      throw { code: "INVENTORY_AVAILABILITY_DRAFT_EXISTS", status: 409 };
    });
    await expect(retrySerializableMasterDataTransaction("create_transformation_draft", transaction))
      .rejects.toMatchObject({ code: "INVENTORY_AVAILABILITY_DRAFT_EXISTS", status: 409 });
    expect(events).toEqual(["begin", "write", "rollback", "begin", "read current head"]);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(JSON.stringify({
      code: "INVENTORY_AVAILABILITY_SERIALIZATION_RETRY",
      operation: "create_transformation_draft", failedAttempt: 1, maxAttempts: 3,
    }));
  });

  it("retries wrapped serialization failures and returns an idempotent receipt", async () => {
    const result = { modelId: 2, alreadyApplied: true };
    const transaction = vi.fn()
      .mockRejectedValueOnce(new Error("query failed", { cause: { code: "40001" } }))
      .mockRejectedValueOnce({ code: "40001" })
      .mockResolvedValueOnce(result);
    await expect(retrySerializableMasterDataTransaction("edit_transformation_draft", transaction))
      .resolves.toBe(result);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("stops after three attempts and preserves the error for HTTP classification", async () => {
    const failure = Object.assign(new Error("serialization"), { code: "40001" });
    const transaction = vi.fn().mockRejectedValue(failure);
    await expect(retrySerializableMasterDataTransaction("refresh_transformation_draft", transaction))
      .rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it.each(["23505", "23503", "40P01", "ECONNRESET", "INVENTORY_AVAILABILITY_DRAFT_STALE"])(
    "never retries non-serialization failures: %s", async (code) => {
      const failure = Object.assign(new Error("failed"), { code });
      const transaction = vi.fn().mockRejectedValue(failure);
      await expect(retrySerializableMasterDataTransaction("create_transformation_draft", transaction))
        .rejects.toBe(failure);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it("terminates when an error cause is cyclic", async () => {
    const failure: { cause?: unknown } = {};
    failure.cause = failure;
    const transaction = vi.fn().mockRejectedValue(failure);
    await expect(retrySerializableMasterDataTransaction("edit_transformation_draft", transaction))
      .rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
