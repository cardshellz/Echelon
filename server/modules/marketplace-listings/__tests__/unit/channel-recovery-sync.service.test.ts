import { describe, expect, it, vi } from "vitest";
import { ChannelRecoverySyncService } from "../../application/channel-recovery-sync.service";

describe("shared channel recovery decision", () => {
  function fixture() {
    const adapter = { receipt: vi.fn().mockResolvedValue(null), inspect: vi.fn().mockResolvedValue({ hash: "current" }),
      enqueue: vi.fn().mockResolvedValue({ jobId: "saved" }), inspectionFailed: vi.fn() };
    return { adapter, service: new ChannelRecoverySyncService(adapter) };
  }
  it("replays an existing receipt before inspecting or enqueuing", async () => {
    const { adapter, service } = fixture();
    adapter.receipt.mockResolvedValue({ jobId: "prior" });
    expect(await service.check(false)).toEqual({ receipt: { jobId: "prior" } });
    expect(adapter.inspect).not.toHaveBeenCalled();
    expect(adapter.enqueue).not.toHaveBeenCalled();
  });
  it("records current provider evidence without enqueueing", async () => {
    const { adapter, service } = fixture();
    expect(await service.check(false)).toEqual({ verified: { hash: "current" } });
    expect(adapter.enqueue).not.toHaveBeenCalled();
  });
  it("hands a drift or forced recovery to the existing Sync owner", async () => {
    const { adapter, service } = fixture();
    adapter.inspect.mockResolvedValueOnce(null);
    expect(await service.check(false)).toEqual({ receipt: { jobId: "saved" } });
    expect(await service.check(true)).toEqual({ receipt: { jobId: "saved" } });
    expect(adapter.inspect).toHaveBeenCalledTimes(1);
    expect(adapter.enqueue).toHaveBeenCalledTimes(2);
  });
  it("never treats a failed read as a match", async () => {
    const { adapter, service } = fixture();
    const failure = new Error("synthetic read failure");
    adapter.inspect.mockRejectedValue(failure);
    expect(await service.check(false)).toEqual({ receipt: { jobId: "saved" } });
    expect(adapter.inspectionFailed).toHaveBeenCalledWith(failure);
  });
});
