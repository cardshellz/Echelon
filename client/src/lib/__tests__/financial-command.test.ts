import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FINANCIAL_COMMAND_MAX_RETRIES,
  FINANCIAL_COMMAND_MAX_RETRY_AFTER_MS,
  FinancialCommandRequestError,
  createFinancialCommandIntentStore,
  financialCommandFetchJson,
  financialCommandRetryDelay,
  parseRetryAfterMs,
  shouldRetryFinancialCommand,
} from "../financial-command";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("financial command HTTP handling", () => {
  it("preserves structured errors and honors Retry-After seconds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "An identical financial command is already being processed",
      details: {
        code: "FINANCIAL_COMMAND_IN_PROGRESS",
        commandId: 91,
      },
    }), {
      status: 409,
      headers: { "Retry-After": "7" },
    })));

    const request = financialCommandFetchJson("/commands", { method: "POST" });
    const error = await request.catch((caught) => caught);

    expect(error).toBeInstanceOf(FinancialCommandRequestError);
    expect(error).toMatchObject({
      message: "An identical financial command is already being processed",
      status: 409,
      code: "FINANCIAL_COMMAND_IN_PROGRESS",
      details: { code: "FINANCIAL_COMMAND_IN_PROGRESS", commandId: 91 },
      retryAfterMs: 7_000,
      retryable: true,
      ambiguous: true,
    });
    expect(financialCommandRetryDelay(0, error)).toBe(7_000);
  });

  it.each([429, 500, 503])("marks HTTP %s retryable and ambiguous", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: `Failure ${status}`,
    }), { status })));

    const error = await financialCommandFetchJson("/commands", { method: "POST" })
      .catch((caught) => caught);
    expect(error).toMatchObject({ status, retryable: true, ambiguous: true });
  });

  it("treats a non-retryable 4xx as a definitive structured rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "Purchase order changed",
      details: { code: "PO_LINE_COMMAND_PO_CONFLICT" },
    }), { status: 409 })));

    const error = await financialCommandFetchJson("/commands", { method: "POST" })
      .catch((caught) => caught);
    expect(error).toMatchObject({
      message: "Purchase order changed",
      status: 409,
      code: "PO_LINE_COMMAND_PO_CONFLICT",
      retryable: false,
      ambiguous: false,
    });
  });

  it("retries stale ownership because COMMIT may already have succeeded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "Financial command ownership changed before completion",
      details: { code: "FINANCIAL_COMMAND_STALE_OWNER", commandId: 92 },
    }), { status: 409 })));

    const error = await financialCommandFetchJson("/commands", { method: "POST" })
      .catch((caught) => caught);
    expect(error).toMatchObject({
      status: 409,
      code: "FINANCIAL_COMMAND_STALE_OWNER",
      retryable: true,
      ambiguous: true,
    });
  });

  it("retains a dead command intent for operator recovery without retrying automatically", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "Financial command exhausted its retry policy and requires operator review",
      details: { code: "FINANCIAL_COMMAND_DEAD", commandId: 93 },
    }), { status: 409 })));

    const error = await financialCommandFetchJson("/commands", { method: "POST" })
      .catch((caught) => caught);
    expect(error).toMatchObject({
      status: 409,
      code: "FINANCIAL_COMMAND_DEAD",
      retryable: false,
      ambiguous: true,
    });
    expect(shouldRetryFinancialCommand(0, error)).toBe(false);

    let sequence = 0;
    const store = createFinancialCommandIntentStore(() => `dead-intent-${++sequence}`);
    const intent = { method: "POST", body: { invoiceId: 93 } };
    const originalKey = store.acquire(intent);
    store.fail(originalKey, error);
    expect(store.acquire(intent)).toBe(originalKey);
  });

  it("wraps transport failures as retryable ambiguous outcomes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("connection reset")));

    const error = await financialCommandFetchJson("/commands", { method: "POST" })
      .catch((caught) => caught);
    expect(error).toMatchObject({
      status: null,
      code: "FINANCIAL_COMMAND_TRANSPORT_ERROR",
      retryable: true,
      ambiguous: true,
    });
  });

  it("returns successful JSON without reshaping it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 44,
      status: "open",
    }), { status: 201 })));

    await expect(financialCommandFetchJson("/commands", { method: "POST" }))
      .resolves.toEqual({ id: 44, status: "open" });
  });

  it("parses an HTTP-date Retry-After value", () => {
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    expect(parseRetryAfterMs("Tue, 14 Jul 2026 12:00:09 GMT", now)).toBe(9_000);
  });

  it("caps huge Retry-After values and rejects malformed numeric input", () => {
    expect(parseRetryAfterMs("999999999999999999999999999999999999999999"))
      .toBe(FINANCIAL_COMMAND_MAX_RETRY_AFTER_MS);
    expect(parseRetryAfterMs("-1")).toBeNull();
    expect(parseRetryAfterMs("1.5")).toBeNull();
  });

  it("bounds automatic retries while preserving the server delay", () => {
    const error = new FinancialCommandRequestError("retry", {
      status: 503,
      retryable: true,
      ambiguous: true,
      retryAfterMs: 12_345,
    });
    expect(shouldRetryFinancialCommand(0, error)).toBe(true);
    expect(shouldRetryFinancialCommand(FINANCIAL_COMMAND_MAX_RETRIES, error)).toBe(false);
    expect(financialCommandRetryDelay(99, error)).toBe(12_345);
  });
});

describe("financial command intent retention", () => {
  it("reuses an unchanged ambiguous intent and rotates changed or settled intents", () => {
    let sequence = 0;
    const store = createFinancialCommandIntentStore(() => `intent-${++sequence}`);
    const original = { method: "PATCH", body: { quantity: 2, sku: "ABC" } };

    const firstKey = store.acquire(original);
    const ambiguous = new FinancialCommandRequestError("network lost", {
      status: null,
      retryable: true,
      ambiguous: true,
    });
    store.fail(firstKey, ambiguous);

    expect(store.acquire({ body: { sku: "ABC", quantity: 2 }, method: "PATCH" }))
      .toBe(firstKey);

    const changedKey = store.acquire({ method: "PATCH", body: { quantity: 3, sku: "ABC" } });
    expect(changedKey).not.toBe(firstKey);

    const definitive = new FinancialCommandRequestError("version conflict", {
      status: 409,
      retryable: false,
      ambiguous: false,
    });
    store.fail(changedKey, definitive);
    const afterRejection = store.acquire({ method: "PATCH", body: { quantity: 3, sku: "ABC" } });
    expect(afterRejection).not.toBe(changedKey);

    store.complete(afterRejection);
    expect(store.acquire({ method: "PATCH", body: { quantity: 3, sku: "ABC" } }))
      .not.toBe(afterRejection);
  });
});
