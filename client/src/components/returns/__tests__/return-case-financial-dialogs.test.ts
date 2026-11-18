import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CustomerRefundReview,
  VendorSettlementReview,
  clearStoredPendingCustomerRefund,
  formatMoney,
  hydrateCustomerRefundCommandState,
  isVerifiedTerminalCustomerRefundRejection,
  readStoredPendingCustomerRefund,
  writeStoredPendingCustomerRefund,
  type StorageLike,
} from "../ReturnCaseFinancialDialogs";
import {
  ReturnCaseAdminApiError,
  type CustomerRefundPreview,
  type VendorSettlementPreview,
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

  it("persists and hydrates pending customer refund command identity across dialog reloads (CDEP-04)", () => {
    const storage = memoryStorage();
    const preview = customerRefundPreview();

    writeStoredPendingCustomerRefund(
      42,
      {
        idempotencyKey: "refund-browser-key-42",
        quoteHash: preview.quoteHash,
        notifyCustomer: false,
        notes: "Hold email notification",
      },
      storage,
    );

    const fromStorage = hydrateCustomerRefundCommandState({
      returnCaseId: 42,
      nextPreview: preview,
      currentPreview: null,
      currentNotifyCustomer: true,
      currentNotes: "",
      currentIdentity: null,
      storage,
    });
    expect(fromStorage).toEqual({
      notifyCustomer: false,
      notes: "Hold email notification",
      commandIdentity: {
        signature: JSON.stringify({
          quoteHash: preview.quoteHash,
          notifyCustomer: false,
          notes: "Hold email notification",
        }),
        idempotencyKey: "refund-browser-key-42",
        lockedByPendingReservation: false,
      },
    });

    const serverHydrated = hydrateCustomerRefundCommandState({
      returnCaseId: 42,
      nextPreview: {
        ...preview,
        pendingCommand: {
          customerRefundId: 401,
          idempotencyKey: "refund-server-key-42",
          quoteHash: preview.quoteHash,
          notifyCustomer: true,
          notes: "Server reserved note",
          requestedAt: "2026-08-23T20:00:00.000Z",
          reconciliationRequired: false,
        },
      },
      currentPreview: null,
      currentNotifyCustomer: false,
      currentNotes: "",
      currentIdentity: null,
      storage,
    });
    expect(serverHydrated).toMatchObject({
      notifyCustomer: true,
      notes: "Server reserved note",
      commandIdentity: {
        idempotencyKey: "refund-server-key-42",
        lockedByPendingReservation: true,
      },
    });
    expect(readStoredPendingCustomerRefund(42, storage)?.idempotencyKey).toBe("refund-server-key-42");

    clearStoredPendingCustomerRefund(42, storage);
    expect(readStoredPendingCustomerRefund(42, storage)).toBeNull();
  });

  it("clears stored refund command identity only on verified terminal rejections (CDEP-04)", () => {
    expect(isVerifiedTerminalCustomerRefundRejection(new Error("network drop"))).toBe(false);
    expect(
      isVerifiedTerminalCustomerRefundRejection(
        new ReturnCaseAdminApiError({
          message: "Unconfirmed",
          status: 503,
          code: "RETURN_CUSTOMER_REFUND_RESULT_UNCONFIRMED",
        }),
      ),
    ).toBe(false);
    expect(
      isVerifiedTerminalCustomerRefundRejection(
        new ReturnCaseAdminApiError({
          message: "Pending exists",
          status: 409,
          code: "RETURN_CUSTOMER_REFUND_PENDING_EXISTS",
        }),
      ),
    ).toBe(false);
    expect(
      isVerifiedTerminalCustomerRefundRejection(
        new ReturnCaseAdminApiError({
          message: "Reconcile first",
          status: 409,
          code: "RETURN_CUSTOMER_REFUND_RECONCILIATION_REQUIRED",
        }),
      ),
    ).toBe(false);
    expect(
      isVerifiedTerminalCustomerRefundRejection(
        new ReturnCaseAdminApiError({
          message: "Rejected",
          status: 409,
          code: "RETURN_CUSTOMER_REFUND_REJECTED",
        }),
      ),
    ).toBe(true);
    expect(
      isVerifiedTerminalCustomerRefundRejection(
        new ReturnCaseAdminApiError({
          message: "Invalid input",
          status: 400,
          code: "RETURN_FINANCIAL_INPUT_INVALID",
        }),
      ),
    ).toBe(true);
  });
});

function memoryStorage(): StorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

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
