import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PICKING_HISTORY_REQUEST_TIMEOUT_MS, PickingHistoryTimeoutError, readPickingHistory } from "../picking-history";

const input = { search: "#62770", provider: "shopify", offset: 0 };
const emptyPage = { orders: [], total: 0, offset: 0, limit: 50 };

describe("picking history reads", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("requests one bounded scope and validates the response", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(emptyPage)));
    vi.stubGlobal("fetch", fetch);
    expect(await readPickingHistory(input, new AbortController().signal)).toEqual(emptyPage);
    expect(fetch).toHaveBeenCalledWith("/api/picking/history?limit=50&offset=0&search=%2362770&provider=shopify", {
      credentials: "include", signal: expect.any(AbortSignal),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new Response("private server detail", { status: 500 }),
    new Response(JSON.stringify({ orders: [], total: -1, offset: 0, limit: 50 })),
  ])("rejects failed or malformed reads instead of inventing an empty page", async response => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(readPickingHistory(input, new AbortController().signal)).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  function stalledFetch(): void {
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    })));
  }

  it("ends a stalled read with an explicit timeout and clears its timer", async () => {
    stalledFetch();
    const request = readPickingHistory(input, new AbortController().signal);
    const rejected = expect(request).rejects.toBeInstanceOf(PickingHistoryTimeoutError);
    await vi.advanceTimersByTimeAsync(PICKING_HISTORY_REQUEST_TIMEOUT_MS);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a superseded search without treating it as a timeout", async () => {
    stalledFetch();
    const controller = new AbortController();
    const request = readPickingHistory(input, controller.signal);
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a request already cancelled by navigation", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(readPickingHistory(input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
