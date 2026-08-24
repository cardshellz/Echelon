import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CustomerRefundReview,
  VendorSettlementReview,
  formatMoney,
} from "../ReturnCaseFinancialDialogs";
import type {
  CustomerRefundPreview,
  VendorSettlementPreview,
} from "../return-case-admin-api";

describe("return case financial reviews", () => {
  it("renders a Shopify refund as exact integer-cents evidence", () => {
    const markup = renderToStaticMarkup(createElement(CustomerRefundReview, {
      preview: customerRefundPreview(),
    }));

    expect(markup).toContain("Shopify order");
    expect(markup).toContain("#61694");
    expect(markup).toContain("Shopify ID 1001");
    expect(markup).toContain("gid://shopify/LineItem/2001");
    expect(markup).toContain("USD 4.95");
    expect(markup).toContain("USD 0.30");
    expect(markup).toContain("USD 5.25");
    expect(markup).toContain("Maximum currently refundable");
  });

  it("renders vendor credit and fees separately from the net internal-wallet settlement", () => {
    const markup = renderToStaticMarkup(createElement(VendorSettlementReview, {
      preview: vendorSettlementPreview(),
    }));

    expect(markup).toContain("Vendor #8");
    expect(markup).toContain("Product credit");
    expect(markup).toContain("Original shipping credit");
    expect(markup).toContain("Return shipping fee");
    expect(markup).toContain("USD 25.00");
    expect(markup).toContain("-USD 3.00");
    expect(markup).toContain("USD 22.00");
    expect(markup).toContain("Net wallet settlement");
  });

  it("formats positive, negative, and large amounts deterministically without float conversion", () => {
    expect(formatMoney(0, "USD")).toBe("USD 0.00");
    expect(formatMoney(123_456, "USD")).toBe("USD 1,234.56");
    expect(formatMoney(-300, "USD")).toBe("-USD 3.00");
  });
});

function customerRefundPreview(): CustomerRefundPreview {
  return {
    commandType: "issue_customer_refund",
    caseId: 42,
    caseNumber: "RET-0000000042",
    externalOrderId: "1001",
    externalOrderNumber: "#61694",
    quoteHash: "a".repeat(64),
    quote: {
      provider: "shopify",
      currency: "USD",
      amountCents: 525,
      maximumRefundableCents: 525,
      lines: [{
        returnCaseItemId: 9,
        externalLineItemId: "gid://shopify/LineItem/2001",
        quantity: 1,
        subtotalCents: 495,
        taxCents: 30,
        totalCents: 525,
      }],
      transactions: [{
        position: 0,
        parentTransactionId: "gid://shopify/OrderTransaction/3001",
        gateway: "shopify_payments",
        amountCents: 525,
      }],
    },
  };
}

function vendorSettlementPreview(): VendorSettlementPreview {
  return {
    commandType: "settle_vendor_account",
    caseId: 42,
    caseNumber: "RET-0000000042",
    vendorId: 8,
    quoteHash: "b".repeat(64),
    quote: {
      currency: "USD",
      faultCategory: "vendor",
      returnShippingActualCents: 300,
      settlement: {
        productCreditCents: 2_000,
        originalShippingCreditCents: 500,
        restockingFeeCents: 0,
        processingFeeCents: 0,
        returnShippingFeeCents: 300,
        grossCreditCents: 2_500,
        totalFeeCents: 300,
        netSettlementCents: 2_200,
        creditLedgerType: "return_credit",
        breakdown: {},
      },
      policyFeeIds: {
        restockingFeeId: null,
        processingFeeId: null,
        returnShippingFeeId: 5,
      },
    },
  };
}
