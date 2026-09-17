import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { getQueryFn } from "../queryClient";

afterEach(() => vi.restoreAllMocks());

describe("shared page query cancellation", () => {
  const context = (signal: AbortSignal) => ({
    client: new QueryClient(), queryKey: ["/api/example"], signal, meta: undefined,
  });

  it("passes the query's cancellation signal and credentials to fetch", async () => {
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await expect(getQueryFn({ on401: "throw" })(context(controller.signal))).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith("/api/example", { credentials: "include", signal: controller.signal });
  });

  it("propagates transport failures instead of returning an empty result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unavailable", { status: 503 }));
    await expect(getQueryFn({ on401: "throw" })(context(new AbortController().signal))).rejects.toThrow("503");
  });

  it("preserves the explicit unauthenticated-null contract", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await expect(getQueryFn({ on401: "returnNull" })(context(new AbortController().signal))).resolves.toBeNull();
  });
});
