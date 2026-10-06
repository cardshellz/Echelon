import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OrderEditOperation,
  OrderEditOrder,
} from "@shared/order-edits/order-edit.contract";
import OrderEdits, {
  ConnectionSettings,
  OrderDraft,
  OrderEditOperationView,
} from "../../OrderEdits";
import { createOrderEditTransport } from "@/lib/order-edits";

const state = vi.hoisted(() => ({
  canEdit: true,
  canConfigure: false,
  operation: undefined as unknown,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "staff-1" },
    hasPermission: (resource: string, action: string) =>
      action === "edit" &&
      (resource === "orders"
        ? state.canEdit
        : resource === "settings" && state.canConfigure),
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn((options: { queryKey: unknown[] }) => ({
    data: options.queryKey.includes("operation") ? state.operation : undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  })),
  useQueryClient: vi.fn(() => ({
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  })),
}));
const id = "7862fe7b-a70b-42e8-9ae7-4e2fb16448d0";
const now = Date.parse("2026-10-05T00:00:00.000Z");
const operation: OrderEditOperation = {
  operationId: id,
  orderNumber: "#60000",
  currency: "USD",
  previousTotalCents: 1000,
  updatedTotalCents: 2000,
  balanceDueCents: 1000,
  refundDueCents: 0,
  lines: [
    {
      id: "line-1",
      title: "Binder",
      variantTitle: "Black",
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
const order: OrderEditOrder = {
  connectionId: 3,
  omsOrderId: 51,
  orderNumber: "#60000",
  customerName: "Test Customer",
  customerEmail: "test@example.com",
  activeOperationId: null,
  currency: "USD",
  revision: "revision-7",
  eligibility: { editable: true, reasons: [] },
  totalCents: 1000,
  financialStatus: "paid",
  warehouseStatus: "not_started",
  lines: [
    {
      lineItemId: "gid://shopify/LineItem/123",
      variantId: "gid://shopify/ProductVariant/345",
      title: "Binder",
      variantTitle: "Black",
      sku: "BINDER-BLACK",
      quantity: 1,
      unitPriceCents: 1000,
      totalCents: 1000,
    },
  ],
};
function renderPage(search = "") {
  return renderToStaticMarkup(
    createElement(Router, {
      ssrPath: "/order-edits",
      ssrSearch: search,
      children: createElement(OrderEdits),
    }),
  );
}
function renderOperation(
  value: OrderEditOperation,
  overrides: { isUncertain?: boolean; busy?: boolean; now?: number } = {},
) {
  return renderToStaticMarkup(
    createElement(OrderEditOperationView, {
      operation: value,
      now,
      busy: false,
      isUncertain: false,
      error: null,
      onCommit: vi.fn(),
      onRefresh: vi.fn(),
      onAbandon: vi.fn(),
      ...overrides,
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  state.canEdit = true;
  state.canConfigure = false;
  state.operation = undefined;
});
afterEach(() => vi.unstubAllGlobals());

describe("staff order editor access and resume", () => {
  it("opens unconfigured connection settings and requires an explicit payment window", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionSettings, {
        connection: {
          connectionId: 3,
          channelId: 8,
          name: "Fixture shop",
          shopDomain: "fixture.myshopify.com",
          paymentWindowMinutes: null,
          enabled: false,
        },
        api: createOrderEditTransport(vi.fn()),
        onSaved: vi.fn(),
      }),
    );
    expect(html).toMatch(/<details[^>]+open=""/);
    expect(html).toContain(
      "Applies only to Fixture shop (fixture.myshopify.com)",
    );
    expect(html).toContain(
      "Enter a payment window before enabling staff edits.",
    );
    expect(html).toMatch(/<input[^>]+id="edit-payment-window"[^>]+value=""/);
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Save settings/);
  });
  it("blocks every read and hides cached order information without edit permission", async () => {
    state.canEdit = false;
    state.operation = operation;
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const html = renderPage(`operationId=${id}`);
    expect(html).toContain("Order editing permission is required");
    expect(html).not.toContain("#60000");
    for (const [query] of vi.mocked(useQuery).mock.calls) {
      expect(query.enabled).toBe(false);
      expect(() =>
        (query.queryFn as Function)({ signal: new AbortController().signal }),
      ).toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("resumes exactly the linked operation with a cancellable authenticated read", async () => {
    state.operation = operation;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(operation)));
    vi.stubGlobal("fetch", request);
    const html = renderPage(`operationId=${id}`);
    expect(html).toContain("#60000");
    expect(html).toContain("Staff only");
    const query = vi
      .mocked(useQuery)
      .mock.calls.find(([options]) =>
        options.queryKey?.includes("operation"),
      )![0];
    expect(query.enabled).toBe(true);
    expect(query.queryKey).toContain("staff-1");
    const signal = new AbortController().signal;
    await (query.queryFn as Function)({ signal });
    expect(request).toHaveBeenCalledWith(
      `/api/order-edits/admin/operations/${id}`,
      expect.objectContaining({ credentials: "include", signal }),
    );
  });
  it("does not offer a new edit through a malformed resume link", () => {
    const html = renderPage("operationId=bad");
    expect(html).toContain("operation link is invalid");
    expect(html).not.toContain("Find an order");
    const query = vi
      .mocked(useQuery)
      .mock.calls.find(([options]) =>
        options.queryKey?.includes("operation"),
      )![0];
    expect(query.enabled).toBe(false);
  });
});

describe("verified order edit review", () => {
  it("shows the additional amount and a commit action only at ready", () => {
    const html = renderOperation(operation);
    expect(html).toContain("$10.00 payment due");
    expect(html).toContain("Original total");
    expect(html).toContain("Quoted total");
    expect(html).not.toContain("Open Shopify payment");
    expect(html).not.toContain("<input");
  });
  it.each([
    "committing",
    "awaiting_payment",
    "refunding",
    "synchronizing",
    "recovering",
    "completed",
    "recovered",
    "review_required",
    "failed",
    "expired",
  ] as const)("does not offer a second commit while %s", (status) => {
    const html = renderOperation({ ...operation, status, canAbandon: false });
    expect(html).not.toContain("Apply changes");
    expect(html).not.toContain("Change items");
    expect(html).not.toContain("Cancel edit");
  });
  it("offers cancellation for a rejected, unsubmitted quote when the server permits it", () => {
    const html = renderOperation({
      ...operation,
      status: "review_required",
      canAbandon: true,
      error: {
        code: "QUOTE_REJECTED",
        message: "The proposed price could not be verified.",
      },
    });
    expect(html).toContain("Cancel edit");
    expect(html).toContain("unsubmitted edit");
    expect(html).not.toContain("Apply changes");
    expect(html).toContain("The proposed price could not be verified.");
  });
  it("does not infer cancellation authority even for a ready quote", () => {
    expect(renderOperation({ ...operation, canAbandon: false })).not.toContain(
      "Change items",
    );
  });
  it("requires status verification before cancelling a rejected quote with an uncertain action", () => {
    const html = renderOperation(
      { ...operation, status: "review_required", canAbandon: true },
      { isUncertain: true },
    );
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Cancel edit/);
  });
  it("blocks commit and changing items after an ambiguous request", () => {
    const html = renderOperation(operation, { isUncertain: true });
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Apply changes/);
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Change items/);
    expect(html).toContain("last request may have completed");
    expect(html).toContain("Check status");
  });
  it("blocks a quote that expires while the page remains open", () => {
    const html = renderOperation(operation, {
      now: Date.parse(operation.expiresAt!),
    });
    expect(html).toContain("This quote has expired");
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Apply changes/);
  });
  it("shows payment only when due and retains the configured deadline", () => {
    const paymentDeadline = "2026-10-06T12:30:00.000Z";
    const html = renderOperation({
      ...operation,
      status: "awaiting_payment",
      paymentDeadline,
      paymentUrl: "https://shop.example/pay",
    });
    expect(html).toContain('href="https://shop.example/pay"');
    expect(html).toContain(`dateTime="${paymentDeadline}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(
      renderOperation({
        ...operation,
        status: "awaiting_payment",
        paymentUrl: "javascript:alert(1)",
      }),
    ).not.toContain("Open Shopify payment");
  });
  it("makes a reduction refund explicit before apply without claiming refund completion", () => {
    const html = renderOperation({
      ...operation,
      updatedTotalCents: 500,
      balanceDueCents: 0,
      refundDueCents: 500,
    });
    expect(html).toContain("Apply changes and refund $5.00");
    expect(html).toContain("Refund difference");
    const pending = renderOperation({
      ...operation,
      status: "refunding",
      updatedTotalCents: 500,
      balanceDueCents: 0,
      refundDueCents: 500,
    });
    expect(pending).toContain("Completion has not yet been confirmed");
  });
  it("reports recovery separately from confirmed restoration", () => {
    expect(renderOperation({ ...operation, status: "recovering" })).toContain(
      "has not yet been confirmed restored",
    );
    expect(renderOperation({ ...operation, status: "recovered" })).toContain(
      "Original order restored",
    );
  });
  it("keeps an ineligible order inspectable without enabling quantity edits", () => {
    const html = renderToStaticMarkup(
      createElement(OrderDraft, {
        order: {
          ...order,
          eligibility: { editable: false, reasons: ["Picking has started."] },
        },
        api: createOrderEditTransport(vi.fn()),
        enabled: true,
        staffId: "staff-1",
        onQuote: vi.fn(),
        onLock: vi.fn(),
      }),
    );
    expect(html).toContain("Picking has started.");
    expect(html).toContain("Binder");
    expect(html).toMatch(/<input[^>]+disabled=""/);
    expect(html).not.toContain("Add products");
    expect(html).toContain(
      "Shipping address changes are not supported in this pilot",
    );
  });
  it("shows both missing enablement and order eligibility blockers without a configuration action for non-admins", () => {
    const html = renderToStaticMarkup(
      createElement(OrderDraft, {
        order: {
          ...order,
          eligibility: { editable: false, reasons: ["Picking has started."] },
        },
        api: createOrderEditTransport(vi.fn()),
        enabled: false,
        staffId: "staff-1",
        onQuote: vi.fn(),
        onLock: vi.fn(),
      }),
    );
    expect(html).toContain("Staff order editing is disabled");
    expect(html).toContain("Ask an administrator with settings permission");
    expect(html).toContain("Picking has started.");
    expect(html).not.toContain("Configure staff editing</button>");
    expect(html).toMatch(/<input[^>]+disabled=""/);
  });
});
