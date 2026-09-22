import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const workerSource = readFileSync(new URL("../../../../public/sw.js", import.meta.url), "utf8");

function workerHarness() {
  const listeners = new Map<string, (event: unknown) => void>();
  const fetch = vi.fn();
  const match = vi.fn().mockResolvedValue({ cached: true });
  runInNewContext(workerSource, {
    URL,
    fetch,
    caches: { match },
    self: { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) },
  });
  function request(path: string): Promise<unknown> {
    let response: Promise<unknown> | undefined;
    listeners.get("fetch")!({
      request: { url: `https://echelon.example${path}` },
      respondWith: (value: Promise<unknown>) => { response = value; },
    });
    if (!response) throw new Error("The worker did not handle the request.");
    return response;
  }
  return { fetch, match, request };
}

describe("admin return preview cache isolation", () => {
  it.each([
    "/returns/portal-preview", "/returns/portal-preview/?scenario=split_delivered",
    "/api/returns/admin/portal-preview", "/api/returns/admin/portal-preview/order",
    "/api/returns/admin/portal-preview/review", "/RETURNS/PORTAL-PREVIEW",
  ])("never restores %s from an earlier session while offline", async (path) => {
    const worker = workerHarness();
    worker.fetch.mockRejectedValue(new Error("Offline"));
    await expect(worker.request(path)).rejects.toThrow("Offline");
    expect(worker.match).not.toHaveBeenCalled();
    expect(worker.fetch).toHaveBeenCalledWith(expect.anything(), { cache: "no-store" });
  });

  it("passes current server denial through without a cache fallback", async () => {
    const worker = workerHarness();
    const denied = { status: 403 };
    worker.fetch.mockResolvedValue(denied);
    await expect(worker.request("/returns/portal-preview")).resolves.toBe(denied);
    expect(worker.match).not.toHaveBeenCalled();
  });

  it("preserves existing offline behavior outside the preview", async () => {
    const worker = workerHarness();
    worker.fetch.mockRejectedValue(new Error("Offline"));
    await expect(worker.request("/picking")).resolves.toEqual({ cached: true });
    expect(worker.match).toHaveBeenCalledOnce();
  });
});
