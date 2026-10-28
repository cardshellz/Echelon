import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ChannelInventoryApiError,
  ENDPOINTS,
  checkStockLinksAgain,
  continueStockLinking,
  fetchStockLinkStatus,
  setStockLinkSwitch,
  stockLinkStatusReadsAsUnsupported,
} from "../api";
import { stockLinkStatus } from "./fixtures";

type Answer = { status: number; body: string };
function stubFetch(answer: Answer | Error) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return new Response(answer.body, { status: answer.status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}
const json = (status: number, body: unknown): Answer => ({ status, body: JSON.stringify(body) });

afterEach(() => { vi.unstubAllGlobals(); });

describe("stock-link status read (PLAN-CH2 v4.1 §9, TST-14)", () => {
  it("reads the status for one destination with credentials", async () => {
    const calls = stubFetch(json(200, stockLinkStatus()));
    await expect(fetchStockLinkStatus(5)).resolves.toEqual(stockLinkStatus());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ENDPOINTS.stockLinkStatus}?publicationTargetId=5`);
    expect(calls[0].init?.credentials).toBe("include");
  });

  it("passes the server's own unsupported answer through", async () => {
    stubFetch(json(200, { supported: false, publicationTargetId: 5 }));
    await expect(fetchStockLinkStatus(5)).resolves.toEqual({ supported: false, publicationTargetId: 5 });
  });

  it("reads a 404 (an older web process during a deploy, or no such destination) as unsupported", async () => {
    stubFetch(json(404, { error: { code: "STOCK_LINK_DESTINATION_NOT_FOUND", message: "The publication target does not exist." } }));
    await expect(fetchStockLinkStatus(5)).resolves.toEqual({ supported: false, publicationTargetId: 5 });
    stubFetch({ status: 404, body: "<!doctype html><p>Cannot GET</p>" });
    await expect(fetchStockLinkStatus(5)).resolves.toEqual({ supported: false, publicationTargetId: 5 });
  });

  it("reads a network error as unsupported", async () => {
    stubFetch(new TypeError("Failed to fetch"));
    await expect(fetchStockLinkStatus(5)).resolves.toEqual({ supported: false, publicationTargetId: 5 });
  });

  it("reads an unparseable answer as unsupported", async () => {
    for (const answer of [
      { status: 200, body: "<!doctype html><div id=root></div>" },
      json(200, { supported: true }),
      json(200, { ...stockLinkStatus(), counts: { linked: -1, waiting: 0, flagged: 0, error: 0 } }),
      json(200, null),
    ]) {
      stubFetch(answer);
      await expect(fetchStockLinkStatus(5)).resolves.toEqual({ supported: false, publicationTargetId: 5 });
    }
  });

  it("rethrows a real failure so the screen can say the status is unavailable", async () => {
    for (const status of [400, 401, 403, 409, 500, 503]) {
      stubFetch(json(status, { error: { code: `CODE_${status}`, message: "failed" } }));
      await expect(fetchStockLinkStatus(5)).rejects.toMatchObject({ status, code: `CODE_${status}` });
    }
  });

  // Review TST-1: §9 hides the controls only on the first read. A refresh after a supported answer that fails (404,
  // network, unparseable) must throw, so the query keeps the last supported status instead of hiding the switch.
  it("rethrows a failed refresh after a supported answer instead of reading it as unsupported", async () => {
    const previous = stockLinkStatus();
    stubFetch(new TypeError("Failed to fetch"));
    await expect(fetchStockLinkStatus(5, previous)).rejects.toBeInstanceOf(TypeError);
    stubFetch({ status: 404, body: "<!doctype html><p>Cannot GET</p>" });
    await expect(fetchStockLinkStatus(5, previous)).rejects.toMatchObject({ status: 404 });
    stubFetch({ status: 200, body: "<!doctype html><div id=root></div>" });
    await expect(fetchStockLinkStatus(5, previous)).rejects.toBeInstanceOf(z.ZodError);
    stubFetch(json(503, { error: { code: "CODE_503", message: "failed" } }));
    await expect(fetchStockLinkStatus(5, previous)).rejects.toMatchObject({ status: 503 });
    // A good refresh still replaces it, and an earlier unsupported answer still reads a failure as unsupported.
    stubFetch(json(200, stockLinkStatus({ revision: "9" })));
    await expect(fetchStockLinkStatus(5, previous)).resolves.toMatchObject({ supported: true, revision: "9" });
    stubFetch(new TypeError("Failed to fetch"));
    await expect(fetchStockLinkStatus(5, { supported: false, publicationTargetId: 5 })).resolves.toEqual({ supported: false, publicationTargetId: 5 });
  });

  it("classifies errors exactly: only a 404 among HTTP errors is unsupported", () => {
    expect(stockLinkStatusReadsAsUnsupported(new ChannelInventoryApiError(404, "X", "x"))).toBe(true);
    expect(stockLinkStatusReadsAsUnsupported(new ChannelInventoryApiError(503, "X", "x"))).toBe(false);
    expect(stockLinkStatusReadsAsUnsupported(new z.ZodError([]))).toBe(true);
    expect(stockLinkStatusReadsAsUnsupported(new TypeError("Failed to fetch"))).toBe(true);
  });
});

describe("stock-link controls", () => {
  it.each([
    ["switch", () => setStockLinkSwitch({ publicationTargetId: 5, enabled: false, expectedRevision: "4", reason: null }), ENDPOINTS.stockLinkSwitch,
      { publicationTargetId: 5, enabled: false, expectedRevision: "4", reason: null }],
    ["continue", () => continueStockLinking({ publicationTargetId: 5, expectedRevision: "4" }), ENDPOINTS.stockLinkContinue,
      { publicationTargetId: 5, expectedRevision: "4" }],
    ["check again", () => checkStockLinksAgain({ publicationTargetId: 5, expectedRevision: "4" }), ENDPOINTS.stockLinkCheckAgain,
      { publicationTargetId: 5, expectedRevision: "4" }],
  ] as const)("%s POSTs the parsed body and parses the full status it answers", async (_name, call, url, body) => {
    const calls = stubFetch(json(200, stockLinkStatus({ revision: "5" })));
    await expect(call()).resolves.toEqual(stockLinkStatus({ revision: "5" }));
    expect(calls[0].url).toBe(url);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(body);
  });

  it("surfaces 409 codes for the screen to act on", async () => {
    for (const code of ["STOCK_LINK_DESTINATION_STALE", "STOCK_LINK_DESTINATION_BUSY", "STOCK_LINK_DESTINATION_UNSUPPORTED"]) {
      stubFetch(json(409, { error: { code, message: "changed" } }));
      await expect(continueStockLinking({ publicationTargetId: 5, expectedRevision: "4" })).rejects.toMatchObject({ status: 409, code });
    }
  });

  it("refuses a control answer that is not a supported status", async () => {
    stubFetch(json(200, { supported: false, publicationTargetId: 5 }));
    await expect(checkStockLinksAgain({ publicationTargetId: 5, expectedRevision: "4" })).rejects.toBeInstanceOf(z.ZodError);
  });

  it("refuses a malformed request before any request leaves the browser", async () => {
    const calls = stubFetch(json(200, stockLinkStatus()));
    expect(() => setStockLinkSwitch({ publicationTargetId: 5, enabled: true, expectedRevision: "x", reason: null })).toThrow();
    expect(() => continueStockLinking({ publicationTargetId: -1, expectedRevision: "4" })).toThrow();
    expect(calls).toHaveLength(0);
  });
});
