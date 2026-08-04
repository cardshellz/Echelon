import { afterEach, describe, expect, it, vi } from "vitest";
import { discardRateTableDraft } from "../pricing-programs/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shipping rate draft discard API", () => {
  it("issues a credentialed DELETE for the exact persisted draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: vi.fn(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await discardRateTableDraft(42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/shipping/admin/rate-tables/42",
      { credentials: "include", method: "DELETE" },
    );
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid draft ID %s before making a request",
    async (draftId) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(discardRateTableDraft(draftId)).rejects.toThrow(
        "A valid draft ID is required.",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
