import { describe, expect, it } from "vitest";
import {
  canConfirmOrderEditPreview,
  orderEditMatchesInput,
  orderEditNeedsPreparation,
} from "../../order-edit-confirmation";
import type {
  OrderEditOperation,
  OrderEditOrder,
} from "@shared/order-edits/order-edit.contract";
import type { OrderEditPreview } from "@shared/order-edits/order-edit-preview";

const now = Date.parse("2026-10-15T12:00:00Z");
function fixture() {
  const financials = {
    itemsGrossCents: 558,
    itemsDiscountCents: 92,
    itemsNetCents: 466,
    itemDiscountLabels: ["Club"],
    shippingGrossCents: 549,
    shippingDiscountCents: 0,
    shippingCents: 549,
    shippingDiscountLabels: [],
    taxCents: 61,
    taxesIncluded: false,
    totalCents: 1076,
    lines: [
      { id: "preview-line", grossCents: 558, discountCents: 92, netCents: 466 },
    ],
  };
  const settlement = {
    receivedCents: 829,
    refundedCents: 0,
    netPaidCents: 829,
    outstandingCents: 0,
    activity: [],
  };
  const input = {
    connectionId: 4,
    omsOrderId: 1,
    expectedRevision: "revision",
    changes: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 2 }],
    additions: [],
    discountCodes: [],
  };
  const lines = [
    {
      id: "preview-line",
      variantId: "gid://shopify/ProductVariant/10",
      title: "Sleeves",
      variantTitle: "Pack",
      quantity: 2,
      totalCents: 466,
    },
  ];
  const order: OrderEditOrder = {
    connectionId: 4,
    omsOrderId: 1,
    orderNumber: "#64043",
    currency: "USD",
    revision: "revision",
    lines: [],
    totalCents: 829,
    activeOperationId: null,
    customerName: "Test customer",
    customerEmail: null,
    financialStatus: "Paid",
    warehouseStatus: "Ready",
    eligibility: { editable: true, reasons: [] },
    settlement,
  };
  const preview: OrderEditPreview = {
    phase: "preview",
    input,
    financials,
    lines,
    calculatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    shippingRepricing: {
      title: "Standard",
      code: "standard",
      source: "Shopify",
      grossCents: 549,
      discountCents: 0,
      netCents: 549,
      discountLabels: [],
    },
  };
  const operation: OrderEditOperation = {
    operationId: "22222222-2222-4222-8222-222222222222",
    orderNumber: order.orderNumber,
    currency: "USD",
    status: "ready",
    canAbandon: true,
    quoteAvailable: true,
    shippingRepricing: { ...preview.shippingRepricing },
    expectedRevision: input.expectedRevision,
    requestedPlan: { changes: input.changes, additions: [], discountCodes: [] },
    previousTotalCents: 829,
    updatedTotalCents: 1076,
    balanceDueCents: 247,
    refundDueCents: 0,
    settlement,
    lines: [{ ...lines[0], id: "calculated-line" }],
    financials: {
      before: null,
      current: null,
      quoted: {
        ...financials,
        lines: [{ ...financials.lines[0], id: "calculated-line" }],
      },
    },
    warnings: [],
    error: null,
    expiresAt: new Date(now + 300000).toISOString(),
    paymentDeadline: null,
    paymentUrl: null,
  };
  return { order, preview, operation };
}

describe("same-screen order edit confirmation", () => {
  it("only refreshes resumable, unsubmitted interrupted, failed or expired drafts", () => {
    const { operation } = fixture();
    expect(orderEditNeedsPreparation(operation, now)).toBe(false);
    expect(
      orderEditNeedsPreparation({ ...operation, status: "preparing" }, now),
    ).toBe(true);
    expect(
      orderEditNeedsPreparation(
        { ...operation, status: "review_required" },
        now,
      ),
    ).toBe(true);
    expect(
      orderEditNeedsPreparation(operation, Date.parse(operation.expiresAt!)),
    ).toBe(true);
    expect(
      orderEditNeedsPreparation({ ...operation, quoteAvailable: false }, now),
    ).toBe(true);
    for (const status of [
      "awaiting_payment",
      "committing",
      "refunding",
      "recovering",
      "synchronizing",
      "completed",
      "expired",
    ] as const)
      expect(orderEditNeedsPreparation({ ...operation, status }, now)).toBe(
        false,
      );
    expect(
      orderEditNeedsPreparation(
        { ...operation, status: "review_required", canAbandon: false },
        now,
      ),
    ).toBe(false);
    expect(
      orderEditNeedsPreparation(
        { ...operation, status: "review_required", requestedPlan: undefined },
        now,
      ),
    ).toBe(false);
  });
  it("accepts a matching verified quote despite native calculated line IDs", () => {
    const f = fixture();
    expect(
      canConfirmOrderEditPreview(f.order, f.preview, f.operation, now),
    ).toBe(true);
  });
  it("compares the complete displayed breakdown, not just the grand total", () => {
    const f = fixture();
    f.operation.financials!.quoted!.shippingCents += 1;
    f.operation.financials!.quoted!.taxCents -= 1;
    expect(
      canConfirmOrderEditPreview(f.order, f.preview, f.operation, now),
    ).toBe(false);
  });
  it("handles native split lines without treating a new product as the original", () => {
    const f = fixture();
    f.operation.lines = [0, 1].map((index) => ({
      ...f.operation.lines[0],
      id: `line-${index}`,
      quantity: 1,
      totalCents: 233,
    }));
    f.operation.financials!.quoted!.lines = [0, 1].map((index) => ({
      id: `line-${index}`,
      grossCents: 279,
      discountCents: 46,
      netCents: 233,
    }));
    expect(
      canConfirmOrderEditPreview(f.order, f.preview, f.operation, now),
    ).toBe(true);
    f.operation.lines[1].variantId = "gid://shopify/ProductVariant/11";
    expect(
      canConfirmOrderEditPreview(f.order, f.preview, f.operation, now),
    ).toBe(false);
  });
  it.each([
    "price",
    "paid",
    "plan",
    "revision",
    "expired",
    "failure",
    "missing-proof",
    "shipping-method",
  ])("requires explicit reconfirmation after %s changes", (kind) => {
    const f = fixture();
    if (kind === "price") f.operation.updatedTotalCents++;
    if (kind === "paid")
      f.operation.settlement = {
        ...f.operation.settlement!,
        netPaidCents: 800,
      };
    if (kind === "plan")
      f.operation.requestedPlan = {
        ...f.operation.requestedPlan!,
        changes: [],
      };
    if (kind === "revision") f.operation.expectedRevision = "other";
    if (kind === "expired") f.operation.expiresAt = new Date(now).toISOString();
    if (kind === "failure")
      f.operation.error = { code: "FAILED", message: "Unavailable" };
    if (kind === "missing-proof") f.operation.financials = undefined;
    if (kind === "shipping-method")
      f.operation.shippingRepricing!.title = "Different service";
    expect(
      canConfirmOrderEditPreview(f.order, f.preview, f.operation, now),
    ).toBe(false);
  });
  it("invalidates confirmation immediately when the user changes quantity or a code", () => {
    const f = fixture();
    expect(
      orderEditMatchesInput(f.operation, {
        ...f.preview.input,
        changes: [{ ...f.preview.input.changes[0], quantity: 3 }],
      }),
    ).toBe(false);
    expect(
      orderEditMatchesInput(f.operation, {
        ...f.preview.input,
        discountCodes: ["SAVE10"],
      }),
    ).toBe(false);
  });
  it.each([0, 829, 1000, Number.MAX_SAFE_INTEGER])(
    "compares zero, unchanged and positive balances at total %i",
    (total) => {
      const f = fixture();
      for (const financials of [
        f.preview.financials,
        f.operation.financials!.quoted!,
      ]) {
        financials.itemsGrossCents = total;
        financials.itemsDiscountCents = 0;
        financials.itemsNetCents = total;
        financials.shippingGrossCents = 0;
        financials.shippingCents = 0;
        financials.taxCents = 0;
        financials.lines = financials.lines.map((line) => ({
          ...line,
          grossCents: total,
          netCents: total,
          discountCents: 0,
        }));
        financials.totalCents = total;
      }
      f.preview.lines[0].totalCents = total;
      f.operation.lines[0].totalCents = total;
      f.operation.updatedTotalCents = total;
      f.operation.balanceDueCents = Math.max(0, total - 829);
      f.operation.refundDueCents = Math.max(0, 829 - total);
      expect(
        canConfirmOrderEditPreview(f.order, f.preview, f.operation, now),
      ).toBe(true);
    },
  );
});
