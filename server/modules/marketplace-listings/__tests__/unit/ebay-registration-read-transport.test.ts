import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FetchEbayRegistrationReadTransport,
} from "../../infrastructure/providers/ebay/ebay-registration-contracts";

const request = {
  environment: "production" as const,
  path: "/sell/inventory/v1/inventory_item/ARM-ENV-SGL-C750",
  accessToken: "access-token-value",
  marketplaceId: "EBAY_US",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("FetchEbayRegistrationReadTransport bounds", () => {
  it("classifies a provider read timeout and aborts the request", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }));
    const transport = new FetchEbayRegistrationReadTransport(
      fetchFn as typeof fetch,
      { timeoutMs: 25, maxResponseBytes: 1_024 },
    );

    const result = transport.get(request);
    const rejection = expect(result).rejects.toMatchObject({
      code: "EBAY_REGISTRATION_PROVIDER_READ_TIMEOUT",
      context: expect.objectContaining({ timeoutMs: 25 }),
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("rejects a declared response larger than the configured limit", async () => {
    const fetchFn = vi.fn(async () => new Response("ignored", {
      status: 200,
      headers: { "content-length": "1025" },
    }));
    const transport = new FetchEbayRegistrationReadTransport(
      fetchFn as typeof fetch,
      { maxResponseBytes: 1_024 },
    );

    await expect(transport.get(request)).rejects.toMatchObject({
      code: "EBAY_REGISTRATION_PROVIDER_RESPONSE_TOO_LARGE",
      context: expect.objectContaining({ maxResponseBytes: 1_024 }),
    });
  });

  it("rejects a streamed response that crosses the configured limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(400));
        controller.close();
      },
    });
    const fetchFn = vi.fn(async () => new Response(body, { status: 200 }));
    const transport = new FetchEbayRegistrationReadTransport(
      fetchFn as typeof fetch,
      { maxResponseBytes: 1_024 },
    );

    await expect(transport.get(request)).rejects.toMatchObject({
      code: "EBAY_REGISTRATION_PROVIDER_RESPONSE_TOO_LARGE",
    });
  });

  it("rejects invalid bounds before making a provider request", async () => {
    const fetchFn = vi.fn();

    expect(() => new FetchEbayRegistrationReadTransport(
      fetchFn as typeof fetch,
      { timeoutMs: 0 },
    )).toThrowError(expect.objectContaining({
      code: "EBAY_REGISTRATION_TRANSPORT_CONFIG_INVALID",
    }));
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
