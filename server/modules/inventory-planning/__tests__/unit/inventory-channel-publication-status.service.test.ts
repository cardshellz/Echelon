import { describe, expect, it, vi } from "vitest";
import { ChannelPublicationStatusService } from "../../application/inventory-channel-publication-status.service";

const request = { publicationTargetId: 5, productId: 10 };
const response = { ...request, capturedAt: "2026-09-20T12:00:00.000Z", runtimeAuthority: "legacy", targetRevision: "1", rows: [] };

describe("channel publication status boundary", () => {
  it("returns validated recorded evidence without requesting publication or ATP", async () => {
    const reader = { read: vi.fn(async () => response) };
    expect(await new ChannelPublicationStatusService(reader).read(request)).toEqual(response);
    expect(reader.read).toHaveBeenCalledExactlyOnceWith(request);
  });
  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])("rejects invalid ids before reading: %s", async id => {
    const reader = { read: vi.fn() };
    await expect(new ChannelPublicationStatusService(reader).read({ ...request, publicationTargetId: id }))
      .rejects.toMatchObject({ status: 400, code: "PUBLICATION_STATUS_INVALID_REQUEST" });
    expect(reader.read).not.toHaveBeenCalled();
  });
  it("rejects malformed persisted data rather than claiming an empty successful read", async () => {
    const reader = { read: vi.fn(async () => ({ ...response, runtimeAuthority: null })) };
    await expect(new ChannelPublicationStatusService(reader).read(request)).rejects.toThrow();
  });
  it("propagates an unavailable read without a zero fallback", async () => {
    const reader = { read: vi.fn(async () => { throw new Error("database unavailable"); }) };
    await expect(new ChannelPublicationStatusService(reader).read(request)).rejects.toThrow("database unavailable");
  });
});
