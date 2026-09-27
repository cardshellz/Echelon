import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiRequest } from "@/lib/queryClient";
import { publicationRequest } from "../api";

vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe("publication response boundary", () => {
  it("rejects malformed responses instead of rendering an invented success state", async () => {
    vi.mocked(apiRequest).mockResolvedValue(
      new Response(JSON.stringify({ state: "live" })),
    );
    await expect(
      publicationRequest(
        "GET",
        "/test",
        z.object({ state: z.literal("processing") }),
      ),
    ).rejects.toThrow("unexpected channel response");
  });
  it("keeps actionable server conflict messages without raw JSON", async () => {
    vi.mocked(apiRequest).mockRejectedValue(
      new Error(
        '409: {"code":"STALE_DRAFT","message":"The draft changed. Reload its saved revision."}',
      ),
    );
    await expect(
      publicationRequest("PUT", "/test", z.object({}), {}),
    ).rejects.toThrow("The draft changed. Reload its saved revision.");
  });
  it("does not expose an upstream HTML error page", async () => {
    vi.mocked(apiRequest).mockRejectedValue(
      new Error("502: <html>upstream proxy diagnostics</html>"),
    );
    await expect(
      publicationRequest("POST", "/test", z.object({}), {}),
    ).rejects.toThrow(
      "The channel request failed. Refresh its status and try again.",
    );
  });
});
