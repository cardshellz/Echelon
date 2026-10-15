import { describe, expect, it } from "vitest";
import { presentOrderEditCodeBreakdown } from "../../application/order-edit-code-presentation";
import {
  priceOrderEditCodes,
  presentOrderEditCodeFinancials,
} from "../../domain/order-edit-code-pricing";
import { buildOrderEditFinancials } from "../../domain/order-edit-financials";
import { orderEditFinancialsSchema } from "@shared/order-edits/order-edit-financials";
import type { OrderEditCodeRule } from "@shared/order-edits/order-edit-codes";
import { serviceHarness } from "../fixtures/order-edit-service.fixture";
import { orderEditResponsePresentation } from "../../application/order-edit-response-presentation";

const rule: OrderEditCodeRule = {
  code: "TEN",
  discountId: "gid://shopify/DiscountCodeNode/1",
  classes: ["ORDER"],
  combinesWith: {
    productDiscounts: true,
    orderDiscounts: true,
    shippingDiscounts: true,
  },
  value: { type: "percentage", percentage: "10" },
  fingerprint: "a".repeat(64),
  redemption: "shopify_coupon",
  usageLimit: null,
  appliesOncePerCustomer: false,
};
function evidence(
  lines = [{ id: "item", quantity: 1, grossCents: 279, productNetCents: 233 }],
  rules = [rule],
) {
  const pricing = priceOrderEditCodes(
    lines.map((line) => ({
      ...line,
      variantId: "gid://shopify/ProductVariant/10",
    })),
    rules,
    rules.map((rule) => rule.code),
  );
  const itemsNetCents = pricing.lines.reduce(
    (sum, line) => sum + line.netCents,
    0,
  );
  const financials = presentOrderEditCodeFinancials(
    buildOrderEditFinancials({
      lines: pricing.lines.map((line) => ({
        id: line.id,
        grossCents: line.retailCents * line.quantity,
        netCents: line.netCents,
      })),
      itemsNetCents,
      itemDiscountLabels: [],
      shippingGrossCents: 549,
      shippingCents: 549,
      shippingDiscountLabels: [],
      taxCents: 46,
      taxesIncluded: false,
      totalCents: itemsNetCents + 549 + 46,
    }),
    pricing,
  );
  return { pricing, financials };
}

describe("order coupon display evidence", () => {
  it("negotiates financial display metadata without mutating amounts, saved evidence, or old tabs", () => {
    const { pricing, financials } = evidence();
    const couponDisplay = presentOrderEditCodeBreakdown(financials, pricing)!;
    const display = { ...couponDisplay, taxLines: [{ title: "State tax", ratePercentage: 6, amountCents: 46 }] };
    const flat = { phase: "preview", financials: display };
    const operation = {
      operationId: "operation",
      financials: { before: null, quoted: display, current: display },
    };
    const before = structuredClone({ flat, operation });
    expect(orderEditResponsePresentation(flat, "v2")).toBe(flat);
    expect(orderEditResponsePresentation(operation, "v2")).toBe(operation);
    expect(orderEditResponsePresentation(flat, "v1").financials).toEqual(couponDisplay);
    expect(orderEditResponsePresentation(operation, "v1").financials).toEqual({ before: null, quoted: couponDisplay, current: couponDisplay });
    expect(orderEditResponsePresentation(flat, undefined)).toEqual({
      ...flat,
      financials,
    });
    expect(orderEditResponsePresentation(operation, undefined)).toEqual({
      ...operation,
      financials: { before: null, quoted: financials, current: financials },
    });
    expect({ flat, operation }).toEqual(before);
    expect(orderEditResponsePresentation({}, undefined)).toEqual({});
  });

  it("exposes the 233-cent club subtotal and 23-cent coupon without changing native net money or persisted proof", () => {
    const { pricing, financials } = evidence();
    const before = structuredClone({ pricing, financials });
    const result = presentOrderEditCodeBreakdown(financials, pricing)!;
    expect(result).toMatchObject({
      itemsNetCents: 210,
      taxCents: 46,
      totalCents: 805,
      orderDiscounts: [
        {
          label: "TEN",
          amountCents: 23,
          value: { type: "percentage", percentage: "10" },
        },
      ],
      lines: [{ id: "item", netCents: 210, productNetCents: 233 }],
    });
    expect({ pricing, financials }).toEqual(before);
    expect(result).not.toBe(financials);
    expect(result.lines[0]).not.toBe(financials.lines[0]);
  });

  it("retains exact item subtotals for stacked percentage/fixed codes across different quantities", () => {
    const { pricing, financials } = evidence(
      [
        { id: "first", quantity: 3, grossCents: 837, productNetCents: 699 },
        { id: "second", quantity: 2, grossCents: 998, productNetCents: 898 },
      ],
      [
        rule,
        {
          ...rule,
          code: "FIXED",
          discountId: "gid://shopify/DiscountCodeNode/2",
          value: { type: "fixed", amountCents: 100 },
        },
      ],
    );
    const result = presentOrderEditCodeBreakdown(financials, pricing)!;
    expect(result.lines.map((line) => line.productNetCents)).toEqual([
      699, 898,
    ]);
    expect(result.orderDiscounts).toHaveLength(2);
    expect(
      result.orderDiscounts!.reduce(
        (sum, discount) => sum + discount.amountCents,
        result.itemsNetCents,
      ),
    ).toBe(1597);
    expect(orderEditFinancialsSchema.parse(result)).toEqual(result);
  });

  it("matches split native rows by identity and preserves zero-valued removed lines", () => {
    const { pricing, financials } = evidence([
      { id: "first", quantity: 3, grossCents: 837, productNetCents: 699 },
    ]);
    pricing.lines = [
      {
        ...pricing.lines[0],
        id: "split-a",
        quantity: 1,
        netCents: 209,
        productNetCents: 233,
      },
      {
        ...pricing.lines[0],
        id: "split-b",
        quantity: 2,
        netCents: 420,
        productNetCents: 466,
      },
    ];
    financials.lines = [
      { id: "split-b", grossCents: 558, discountCents: 138, netCents: 420 },
      { id: "removed", grossCents: 0, discountCents: 0, netCents: 0 },
      { id: "split-a", grossCents: 279, discountCents: 70, netCents: 209 },
    ];
    const result = presentOrderEditCodeBreakdown(financials, pricing)!;
    expect(result.lines.map((line) => line.productNetCents)).toEqual([
      466, 0, 233,
    ]);
    expect(result.itemsNetCents).toBe(629);
    expect(result.orderDiscounts![0].amountCents).toBe(70);
  });

  it.each(["missing", "duplicate", "unknown", "net", "subtotal", "amount"])(
    "rejects %s evidence instead of inventing item prices",
    (kind) => {
      const { pricing, financials } = evidence();
      if (kind === "missing") pricing.lines = [];
      if (kind === "duplicate") pricing.lines.push({ ...pricing.lines[0] });
      if (kind === "unknown") pricing.lines[0].id = "other";
      if (kind === "net") pricing.lines[0].netCents++;
      if (kind === "subtotal") pricing.lines[0].productNetCents++;
      if (kind === "amount") pricing.applications[0].amountCents++;
      expect(() => presentOrderEditCodeBreakdown(financials, pricing)).toThrow(
        "The item prices and order discount could not be verified",
      );
    },
  );

  it("keeps older unclassified evidence unchanged and rejects orphaned subtotal metadata", () => {
    const { financials } = evidence();
    expect(presentOrderEditCodeBreakdown(financials, undefined)).toBe(
      financials,
    );
    expect(presentOrderEditCodeBreakdown(undefined, undefined)).toBeUndefined();
    expect(
      orderEditFinancialsSchema.safeParse({
        ...financials,
        lines: financials.lines.map((line) => ({
          ...line,
          productNetCents: 233,
        })),
      }).success,
    ).toBe(false);
  });

  it("rejects inconsistent evidence for a zero-valued line rather than treating it as removed", () => {
    const { pricing, financials } = evidence(
      [
        { id: "item", quantity: 1, grossCents: 0, productNetCents: 0 },
        { id: "other", quantity: 1, grossCents: 279, productNetCents: 233 },
      ],
    );
    pricing.lines[0].netCents = pricing.lines[0].productNetCents = 1;
    expect(() => presentOrderEditCodeBreakdown(financials, pricing)).toThrow(
      "The item prices and order discount could not be verified",
    );
  });

  it("decorates review, resumed review and reopened order responses without persisting display fields", async () => {
    const h = serviceHarness(2);
    const { pricing, financials } = evidence([
      {
        id: h.quote.lines[0].calculatedLineId,
        quantity: 2,
        grossCents: 2000,
        productNetCents: 2000,
      },
    ]);
    h.input.discountCodes = ["TEN"];
    h.quote.codePricing = pricing;
    h.quote.financials = {
      ...financials,
      shippingGrossCents: 0,
      shippingCents: 0,
      taxCents: 0,
      totalCents: 1800,
    };
    h.quote.totalCents = 1800;
    h.quote.outstandingCents = h.quote.deltaCents = -200;
    h.quote.lines[0].totalCents = 1800;
    h.quote.lines[0].discountedUnitPriceCents = 900;
    const response = await h.service.quote(h.input, "staff");
    expect(response.financials?.quoted?.orderDiscounts?.[0].amountCents).toBe(
      200,
    );
    expect(h.record().quote?.financials?.orderDiscounts).toBeUndefined();
    const resumed = await h.service.get(h.record().id);
    expect(resumed.financials?.quoted?.lines[0].productNetCents).toBe(2000);
    const currentLineId = h.snapshot().lines[0].id;
    h.setCurrent({
      ...h.snapshot(),
      financials: {
        ...h.quote.financials,
        lines: h.quote.financials.lines.map((line) => ({
          ...line,
          id: currentLineId,
        })),
      },
      codePricing: {
        ...pricing,
        lines: pricing.lines.map((line) => ({ ...line, id: currentLineId })),
      },
    });
    const reopened = await h.service.order(4, h.input.omsOrderId);
    expect(reopened.financials?.orderDiscounts?.[0].amountCents).toBe(200);
    expect(h.snapshot().financials?.orderDiscounts).toBeUndefined();
  });
});
