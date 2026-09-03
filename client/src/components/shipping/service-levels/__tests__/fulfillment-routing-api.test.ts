import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFulfillmentRouting } from "../api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fulfillment routing catalog API", () => {
  it("loads the live provider catalog without browser caching", async () => {
    const responseBody = {
      profile: { revision: 0, methods: [] },
      catalog: {
        status: "available",
        fetchedAt: "2026-09-03T17:00:00.000Z",
        connections: [],
        methods: [],
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadFulfillmentRouting(17)).resolves.toEqual(responseBody);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/shipping/admin/service-levels/17/fulfillment-routing",
      { credentials: "include", cache: "no-store" },
    );
  });
});
