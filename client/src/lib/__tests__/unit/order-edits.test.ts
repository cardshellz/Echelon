import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createOrderEditTransport,
  formatOrderEditMoney,
  orderEditOperationFromSearch,
  orderEditRequest,
  orderEditCanCommit,
  safeOrderEditPaymentUrl,
  savePendingOrderEditQuote,
  loadPendingOrderEditQuote,
  clearPendingOrderEditQuote,
  matchingOrderEditPreview,
} from "../../order-edits";
import type {
  OrderEditOperation,
  OrderEditQuoteInput,
} from "@shared/order-edits/order-edit.contract";

const key = "7862fe7b-a70b-42e8-9ae7-4e2fb16448d0";
const schema = z.object({ status: z.literal("ready") });
const quote: OrderEditQuoteInput = {
  connectionId: 3,
  omsOrderId: 51,
  expectedRevision: "order-revision-7",
  requestKey: key,
  changes: [{ lineItemId: "gid://shopify/LineItem/123", quantity: 2 }],
  additions: [],
};
const operation: OrderEditOperation = {
  operationId: key,
  orderNumber: "#60000",
  currency: "USD",
  previousTotalCents: 1000,
  updatedTotalCents: 2000,
  balanceDueCents: 1000,
  refundDueCents: 0,
  lines: [
    {
      id: "gid://shopify/CalculatedLineItem/123",
      title: "Binder",
      variantTitle: null,
      quantity: 2,
      totalCents: 2000,
    },
  ],
  warnings: [],
  expiresAt: "2026-10-06T00:00:00.000Z",
  paymentDeadline: null,
  status: "ready",
  paymentUrl: null,
  error: null,
  canAbandon: true,
};
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value));

describe("order edit transport", () => {
  it("forwards staff cookies, abort signals and an explicit idempotency key without retries", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: "ready" })));
    const signal = new AbortController().signal;
    await orderEditRequest(
      "/operations/test/commit",
      schema,
      { method: "POST", key, body: {}, signal },
      request,
    );
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("/api/order-edits/admin/operations/test/commit");
    expect(options).toMatchObject({
      method: "POST",
      credentials: "include",
      cache: "no-store",
      signal,
      body: "{}",
    });
    expect(new Headers(options?.headers).get("Idempotency-Key")).toBe(key);
  });

  it("classifies an ambiguous commit without sending a second command", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("network disconnected"));
    await expect(
      orderEditRequest(
        "/operations/test/commit",
        schema,
        { method: "POST", key },
        request,
      ),
    ).rejects.toMatchObject({
      code: "ORDER_EDIT_CONNECTION_FAILED",
      uncertain: true,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed success responses instead of presenting an unverified quote", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: "invented" })));
    await expect(
      orderEditRequest(
        "/quotes",
        schema,
        { method: "POST", body: {} },
        request,
      ),
    ).rejects.toMatchObject({
      code: "ORDER_EDIT_RESPONSE_INVALID",
      uncertain: true,
    });
  });

  it("surfaces structured eligibility errors and distinguishes them from uncertain execution", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "ORDER_PICKING_STARTED",
            message: "Picking has started. This order cannot be edited.",
          },
        }),
        { status: 409 },
      ),
    );
    await expect(
      orderEditRequest("/quotes", schema, { method: "POST" }, request),
    ).rejects.toMatchObject({
      message: "Picking has started. This order cannot be edited.",
      code: "ORDER_PICKING_STARTED",
      uncertain: false,
    });
  });

  it("preserves read cancellation", async () => {
    const aborted = new DOMException("Stopped", "AbortError");
    const request = vi.fn<typeof fetch>().mockRejectedValue(aborted);
    await expect(orderEditRequest("/state", schema, {}, request)).rejects.toBe(
      aborted,
    );
  });

  it("rejects malformed command keys before contacting the server", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      orderEditRequest(
        "/quotes",
        schema,
        { method: "POST", key: "bad" },
        request,
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("sends verified quote intent with its revision and stable request key", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(operation));
    const api = createOrderEditTransport(request);
    await api.quote(quote);
    await api.quote(quote);
    for (const [url, options] of request.mock.calls) {
      expect(url).toBe("/api/order-edits/admin/quotes");
      expect(JSON.parse(String(options?.body))).toEqual(quote);
      expect(new Headers(options?.headers).get("Idempotency-Key")).toBe(key);
    }
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate changes, unchecked prices and invalid quantities before staging", () => {
    const request = vi.fn<typeof fetch>();
    const api = createOrderEditTransport(request);
    expect(() =>
      api.quote({ ...quote, changes: [...quote.changes, ...quote.changes] }),
    ).toThrow();
    expect(() =>
      api.quote({ ...quote, changes: [{ ...quote.changes[0], quantity: -1 }] }),
    ).toThrow();
    expect(() =>
      api.quote({ ...quote, priceCents: 1 } as OrderEditQuoteInput),
    ).toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("validates settings readback belongs to the same connection", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        connectionId: 9,
        channelId: 5,
        name: "Other shop",
        shopDomain: "other.myshopify.com",
        paymentWindowMinutes: 60,
        enabled: true,
      }),
    );
    await expect(
      createOrderEditTransport(request).saveSettings(
        3,
        { paymentWindowMinutes: 60, enabled: true },
        key,
      ),
    ).rejects.toMatchObject({
      code: "ORDER_EDIT_IDENTITY_MISMATCH",
      uncertain: true,
    });
  });

  it("refuses an operation response from another edit", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ...operation,
        operationId: "25e85982-537a-42c6-86eb-27dcc940b518",
      }),
    );
    await expect(
      createOrderEditTransport(request).commit(key),
    ).rejects.toMatchObject({
      code: "ORDER_EDIT_IDENTITY_MISMATCH",
      uncertain: true,
    });
  });

  it("keeps action command identity stable and forwards read cancellation", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(operation));
    const api = createOrderEditTransport(request);
    const signal = new AbortController().signal;
    await api.commit(key);
    await api.reconcile(key);
    await api.abandon(key);
    await api.operation(key, signal);
    expect(request.mock.calls.slice(0, 3).map((call) => call[0])).toEqual(
      ["commit", "reconcile", "abandon"].map(
        (action) => `/api/order-edits/admin/operations/${key}/${action}`,
      ),
    );
    for (const [, options] of request.mock.calls.slice(0, 3))
      expect(new Headers(options?.headers).get("Idempotency-Key")).toBe(key);
    expect(request.mock.calls[3][1]).toMatchObject({ method: "GET", signal });
  });

  it("rejects fractional monetary readback and a customer-enabled pilot", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ ...operation, updatedTotalCents: 2.5 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ connections: [], customerAccess: true }),
      );
    const api = createOrderEditTransport(request);
    await expect(api.operation(key)).rejects.toMatchObject({
      code: "ORDER_EDIT_RESPONSE_INVALID",
    });
    await expect(api.state()).rejects.toMatchObject({
      code: "ORDER_EDIT_RESPONSE_INVALID",
    });
  });

  it("requires explicit cancellation authority instead of inferring it from status", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ...operation, canAbandon: undefined }));
    await expect(
      createOrderEditTransport(request).operation(key),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_RESPONSE_INVALID" });
  });

  it("preserves the server's active edit reference when searching orders", async () => {
    const orders = [
      {
        omsOrderId: 51,
        orderNumber: "#60000",
        customerName: "Test Customer",
        customerEmail: null,
        activeOperationId: key,
      },
      {
        omsOrderId: 52,
        orderNumber: "#60001",
        customerName: "Other Customer",
        customerEmail: null,
        activeOperationId: null,
      },
    ];
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ orders }));
    expect(await createOrderEditTransport(request).orders(3, "6000")).toEqual({
      orders,
    });
  });

  it.each([undefined, "not-an-operation-id"])(
    "rejects an unverifiable active edit reference %s",
    async (activeOperationId) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          orders: [
            {
              omsOrderId: 51,
              orderNumber: "#60000",
              customerName: "Test Customer",
              customerEmail: null,
              activeOperationId,
            },
          ],
        }),
      );
      await expect(
        createOrderEditTransport(request).orders(3, "60000"),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_RESPONSE_INVALID" });
    },
  );
});

describe("order editor presentation boundaries", () => {
  it.each(["operationId=bad", `operationId=${key}&operationId=${key}`, ""])(
    "rejects ambiguous operation link %s",
    (query) => {
      expect(orderEditOperationFromSearch(query)).toBeNull();
    },
  );
  it("resumes a single exact operation ID", () => {
    expect(orderEditOperationFromSearch(`operationId=${key}`)).toBe(key);
  });
  it("formats only safe integer monetary values", () => {
    expect(formatOrderEditMoney(1999, "USD")).toBe("$19.99");
    expect(formatOrderEditMoney(0, "USD")).toBe("$0.00");
    expect(formatOrderEditMoney(-100, "USD")).toBe("-$1.00");
    expect(formatOrderEditMoney(-1, "USD")).toBe("-$0.01");
    expect(formatOrderEditMoney(Number.MAX_SAFE_INTEGER, "USD")).toBe(
      "$90,071,992,547,409.91",
    );
    expect(formatOrderEditMoney(-Number.MAX_SAFE_INTEGER, "USD")).toBe(
      "-$90,071,992,547,409.91",
    );
    expect(formatOrderEditMoney(100, "bad")).toBe("Unavailable");
    expect(formatOrderEditMoney(1.5, "USD")).toBe("Unavailable");
    expect(formatOrderEditMoney(Number.MAX_SAFE_INTEGER + 1, "USD")).toBe(
      "Unavailable",
    );
  });

  it.each([
    "javascript:alert(1)",
    "http://shop.example/pay",
    "https://user:password@shop.example/pay",
    "not a URL",
  ])("rejects unsafe payment link %s", (url) => {
    expect(safeOrderEditPaymentUrl(url)).toBeNull();
  });
  it("preserves a verified HTTPS payment link", () => {
    expect(
      safeOrderEditPaymentUrl("https://shop.example/pay?token=example"),
    ).toBe("https://shop.example/pay?token=example");
  });
  it("permits commit only for an authoritative ready, unexpired, error-free quote", () => {
    const now = Date.parse("2026-10-05T00:00:00.000Z");
    expect(orderEditCanCommit(operation, now)).toBe(true);
    expect(
      orderEditCanCommit({ ...operation, status: "committing" }, now),
    ).toBe(false);
    expect(
      orderEditCanCommit(
        { ...operation, error: { code: "STALE", message: "Order changed" } },
        now,
      ),
    ).toBe(false);
    expect(
      orderEditCanCommit(operation, Date.parse(operation.expiresAt!)),
    ).toBe(false);
    expect(orderEditCanCommit(operation, Number.NaN)).toBe(false);
  });
});

describe("interrupted quote recovery", () => {
  function storage() {
    const entries = new Map<string, string>();
    return {
      getItem: (name: string) => entries.get(name) ?? null,
      setItem: (name: string, value: string) => {
        entries.set(name, value);
      },
      removeItem: (name: string) => {
        entries.delete(name);
      },
    };
  }
  it("restores exact intent and key after refresh, scoped to the signed-in staff member", () => {
    const session = storage();
    savePendingOrderEditQuote("staff-1", quote, session);
    expect(loadPendingOrderEditQuote("staff-1", session)).toEqual(quote);
    expect(loadPendingOrderEditQuote("staff-2", session)).toBeNull();
    clearPendingOrderEditQuote("staff-1", session);
    expect(loadPendingOrderEditQuote("staff-1", session)).toBeNull();
  });
  it("fails closed when the browser cannot persist the operation reference", () => {
    const session = {
      ...storage(),
      setItem: () => {
        throw new Error("Storage disabled");
      },
    };
    expect(() => savePendingOrderEditQuote("staff-1", quote, session)).toThrow(
      "could not save the request reference",
    );
  });
  it("does not discard a corrupted saved request and allow a duplicate quote", () => {
    const removeItem = vi.fn();
    expect(() =>
      loadPendingOrderEditQuote("staff-1", {
        getItem: () => "{broken",
        setItem: vi.fn(),
        removeItem,
      }),
    ).toThrow("could not be verified");
    expect(removeItem).not.toHaveBeenCalled();
  });
});

const previewInput = {
  connectionId: 3,
  omsOrderId: 51,
  expectedRevision: "revision-7",
  changes: [{ lineItemId: "gid://shopify/LineItem/123", quantity: 2 }],
  additions: [],
};
const previewResult = () => ({
  phase: "preview" as const,
  input: previewInput,
  calculatedAt: "2026-10-09T12:00:00.000Z",
  expiresAt: "2026-10-09T12:01:00.000Z",
  financials: {
    itemsGrossCents: 2000,
    itemsDiscountCents: 0,
    itemsNetCents: 2000,
    itemDiscountLabels: [],
    shippingGrossCents: 550,
    shippingDiscountCents: 0,
    shippingCents: 550,
    shippingDiscountLabels: [],
    taxCents: 60,
    taxesIncluded: false,
    totalCents: 2610,
    lines: [{ id: "line", grossCents: 2000, discountCents: 0, netCents: 2000 }],
  },
  shippingRepricing: {
    title: "Standard",
    code: "standard",
    source: "Echelon",
    grossCents: 550,
    discountCents: 0,
    netCents: 550,
    discountLabels: [],
  },
  lines: [
    {
      id: "line",
      title: "Binder",
      variantTitle: null,
      quantity: 2,
      totalCents: 2000,
    },
  ],
});
describe("calculation-only preview transport", () => {
  it("cannot classify edit commands or keyed requests as read-only calculations", async () => {
    const request = vi.fn<typeof fetch>();
    for (const options of [
      { path: "/quotes", method: "POST" as const },
      { path: "/operations/id/commit", method: "POST" as const },
      { path: "/previews", method: "PUT" as const },
      { path: "/previews", method: "POST" as const, key },
    ]) {
      await expect(
        orderEditRequest(
          options.path,
          schema,
          { ...options, calculationOnly: true },
          request,
        ),
      ).rejects.toMatchObject({
        code: "ORDER_EDIT_PREVIEW_ENDPOINT_INVALID",
        uncertain: false,
      });
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("sends abortable private calculations without a financial command key or saved operation", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(previewResult()));
    const signal = new AbortController().signal;
    await createOrderEditTransport(request).preview(previewInput, signal);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("/api/order-edits/admin/previews");
    expect(options).toMatchObject({
      method: "POST",
      signal,
      credentials: "include",
      cache: "no-store",
    });
    expect(new Headers(options?.headers).get("Idempotency-Key")).toBeNull();
    expect(JSON.parse(String(options?.body))).toEqual(previewInput);
  });
  it("rejects mismatched cart/revision/shop identities and incomplete success responses", async () => {
    for (const change of [
      { omsOrderId: 999 },
      { expectedRevision: "stale" },
      { connectionId: 7 },
      { changes: [{ lineItemId: "gid://shopify/LineItem/123", quantity: 3 }] },
    ]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse({
            ...previewResult(),
            input: { ...previewInput, ...change },
          }),
        );
      await expect(
        createOrderEditTransport(request).preview(previewInput),
      ).rejects.toMatchObject({
        code: "ORDER_EDIT_IDENTITY_MISMATCH",
        uncertain: false,
      });
    }
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(operation));
    await expect(
      createOrderEditTransport(request).preview(previewInput),
    ).rejects.toMatchObject({
      code: "ORDER_EDIT_RESPONSE_INVALID",
      uncertain: false,
    });
  });
  it("treats preview cancellation/disconnection as read-only; financial mutation uncertainty remains unchanged", async () => {
    const aborted = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(
      createOrderEditTransport(aborted).preview(previewInput),
    ).rejects.toMatchObject({ name: "AbortError" });
    const disconnected = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("disconnected"));
    await expect(
      createOrderEditTransport(disconnected).preview(previewInput),
    ).rejects.toMatchObject({ uncertain: false });
    await expect(
      createOrderEditTransport(disconnected).quote(quote),
    ).rejects.toMatchObject({ uncertain: true });
  });
  it("accepts a preview only for the exact current intent and before its expiry", () => {
    const now = Date.parse("2026-10-09T12:00:30.000Z");
    expect(
      matchingOrderEditPreview(previewResult(), previewInput, now),
    ).not.toBeNull();
    expect(
      matchingOrderEditPreview(
        previewResult(),
        { ...previewInput, changes: [] },
        now,
      ),
    ).toBeNull();
    expect(
      matchingOrderEditPreview(
        previewResult(),
        { ...previewInput, expectedRevision: "new" },
        now,
      ),
    ).toBeNull();
    expect(
      matchingOrderEditPreview(
        previewResult(),
        previewInput,
        Date.parse("2026-10-09T12:01:00.000Z"),
      ),
    ).toBeNull();
    expect(
      matchingOrderEditPreview(previewResult(), previewInput, Number.NaN),
    ).toBeNull();
  });
});
