import { describe, expect, it, vi } from "vitest";
import { retryPublicationSelectionWrite } from "../../publication-selection-retry";

const busy = () => Object.assign(new Error("PUBLICATION_SELECTION_BUSY"), { code: "55P03" });
describe("atomic publication selection write retries", () => {
  it("retries the entire failed atomic write with bounded backoff", async () => {
    const sleep = vi.fn(async () => undefined);
    const write = vi.fn().mockRejectedValueOnce(busy()).mockRejectedValueOnce({ cause: busy() }).mockResolvedValue("committed");
    expect(await retryPublicationSelectionWrite(write, { sleep })).toBe("committed");
    expect(write).toHaveBeenCalledTimes(3); expect(sleep.mock.calls).toEqual([[50], [150]]);
  });
  it("retains the original busy evidence after the bounded retry budget", async () => {
    const error = busy(); const write = vi.fn().mockRejectedValue(error); const sleep = vi.fn(async () => undefined);
    await expect(retryPublicationSelectionWrite(write, { sleep })).rejects.toBe(error);
    expect(write).toHaveBeenCalledTimes(4); expect(sleep).toHaveBeenCalledTimes(3);
  });
  it.each([{ code: "55P03", message: "another lock" }, { code: "40001", message: "PUBLICATION_SELECTION_BUSY" }, new Error("network")])
    ("does not retry unrelated failures: %j", async error => {
      const write = vi.fn().mockRejectedValue(error); const sleep = vi.fn(async () => undefined);
      await expect(retryPublicationSelectionWrite(write, { sleep })).rejects.toBe(error);
      expect(write).toHaveBeenCalledOnce(); expect(sleep).not.toHaveBeenCalled();
    });
  it("lets a caller widen what counts as retryable", async () => {
    const other = { code: "40001", message: "another lock" }; const sleep = vi.fn(async () => undefined);
    const write = vi.fn().mockRejectedValueOnce(other).mockResolvedValue("committed");
    const isRetryable = (error: unknown) => (error as { code?: string }).code === "40001";
    expect(await retryPublicationSelectionWrite(write, { sleep, isRetryable })).toBe("committed");
    expect(write).toHaveBeenCalledTimes(2); expect(sleep.mock.calls).toEqual([[50]]);
  });
  it("refuses unbounded or invalid retry policies", async () => {
    const write = vi.fn(); await expect(retryPublicationSelectionWrite(write, { delaysMs: [1001] })).rejects.toThrow(TypeError);
    expect(write).not.toHaveBeenCalled();
  });
});
