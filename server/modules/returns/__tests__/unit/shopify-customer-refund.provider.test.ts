import { describe, expect, it, vi } from "vitest";

import {
  CustomerRefundProviderError,
  type CustomerRefundQuote,
  type ReturnFinancialCaseSource,
} from "../../application/return-case-financial.service";
import {
  ShopifyCustomerRefundProvider,
  type ShopifyReturnCredentialStore,
} from "../../infrastructure/shopify-customer-refund.provider";

describe("ShopifyCustomerRefundProvider", () => {
  it("quotes the exact returned lines with NO_RESTOCK and original-payment transaction evidence", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: {
        order: {
          id: "gid://shopify/Order/1001",
          suggestedRefund: {
            amountSet: money("5.25"),
            maximumRefundableSet: money("5.25"),
            refundLineItems: [{
              lineItem: { id: "gid://shopify/LineItem/2001" },
              quantity: 1,
              subtotalSet: money("4.95"),
              totalTaxSet: money("0.30"),
            }],
            suggestedTransactions: [{
              parentTransaction: { id: "gid://shopify/OrderTransaction/3001" },
              gateway: "shopify_payments",
              amountSet: money("5.25"),
            }],
          },
        },
      },
    }));
    const provider = providerWith(fetchMock);

    const quote = await provider.quote({
      source: source(),
      lines: [{ returnCaseItemId: 41, externalLineItemId: "2001", quantity: 1 }],
    });

    expect(quote).toEqual({
      provider: "shopify",
      currency: "USD",
      amountCents: 525,
      maximumRefundableCents: 525,
      lines: [{
        returnCaseItemId: 41,
        externalLineItemId: "2001",
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
    });
    const request = readRequest(fetchMock);
    expect(request.query).toContain("suggestedRefund");
    expect(request.variables).toMatchObject({
      id: "gid://shopify/Order/1001",
      refundLineItems: [{
        lineItemId: "gid://shopify/LineItem/2001",
        quantity: 1,
        restockType: "NO_RESTOCK",
      }],
    });
  });

  it("executes the exact quote with Shopify idempotency and confirms successful transaction evidence", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(refundResponse({ total: "5.25", transactionTotal: "5.25" })));
    const provider = providerWith(fetchMock);

    const result = await provider.execute({
      source: source(),
      quote: quote(),
      idempotencyKey: "return-refund-command-1",
      notifyCustomer: true,
      notes: "approved return",
    });

    expect(result).toMatchObject({
      providerRefundId: "gid://shopify/Refund/4001",
      completedAt: new Date("2026-08-23T13:00:00.000Z"),
      rawResult: { restockType: "NO_RESTOCK" },
    });
    const request = readRequest(fetchMock);
    expect(request.query).toContain("@idempotent(key: $idempotencyKey)");
    expect(request.variables).toMatchObject({
      idempotencyKey: "return-refund-command-1",
      input: {
        orderId: "gid://shopify/Order/1001",
        currency: "USD",
        notify: true,
        note: "approved return",
        refundLineItems: [{
          lineItemId: "gid://shopify/LineItem/2001",
          quantity: 1,
          restockType: "NO_RESTOCK",
        }],
        transactions: [{
          orderId: "gid://shopify/Order/1001",
          parentId: "gid://shopify/OrderTransaction/3001",
          gateway: "shopify_payments",
          kind: "REFUND",
          amount: "5.25",
        }],
      },
    });
  });

  it("treats a returned refund record as created evidence even when Shopify also returns user errors", async () => {
    const response = refundResponse({ total: "5.25", transactionTotal: "5.25" }) as {
      data: { refundCreate: { userErrors: Array<{ field: string[]; message: string }> } };
    };
    response.data.refundCreate.userErrors = [{
      field: ["refundLineItems", "0"],
      message: "Refund was created with a provider warning.",
    }];
    const provider = providerWith(vi.fn(async () => jsonResponse(response)));

    await expect(provider.execute({
      source: source(),
      quote: quote(),
      idempotencyKey: "return-refund-command-mixed",
      notifyCustomer: false,
      notes: null,
    })).resolves.toMatchObject({
      providerRefundId: "gid://shopify/Refund/4001",
      rawResult: {
        userErrors: [{
          field: ["refundLineItems", "0"],
          message: "Refund was created with a provider warning.",
        }],
      },
    });
  });

  it("keeps a created refund reconcilable when returned totals do not match", async () => {
    const provider = providerWith(vi.fn(async () => jsonResponse(
      refundResponse({ total: "4.25", transactionTotal: "4.25" }),
    )));

    await expect(provider.execute({
      source: source(),
      quote: quote(),
      idempotencyKey: "return-refund-command-2",
      notifyCustomer: false,
      notes: null,
    })).rejects.toMatchObject<CustomerRefundProviderError>({
      code: "RETURN_CUSTOMER_REFUND_TOTAL_MISMATCH",
      retryable: true,
      context: {
        expectedCents: 525,
        actualCents: 425,
        reconciliationRequired: true,
      },
    });
  });

  it("classifies a pre-creation Shopify validation rejection as terminal", async () => {
    const provider = providerWith(vi.fn(async () => jsonResponse({
      data: {
        refundCreate: {
          refund: null,
          userErrors: [{ field: ["refundLineItems", "0"], message: "Refund quantity is invalid." }],
        },
      },
    })));

    await expect(provider.execute({
      source: source(),
      quote: quote(),
      idempotencyKey: "return-refund-command-3",
      notifyCustomer: false,
      notes: null,
    })).rejects.toMatchObject<CustomerRefundProviderError>({
      code: "RETURN_CUSTOMER_REFUND_REJECTED",
      retryable: false,
    });
  });
});

function providerWith(fetchMock: ReturnType<typeof vi.fn>): ShopifyCustomerRefundProvider {
  const credentials: ShopifyReturnCredentialStore = {
    load: vi.fn(async () => ({ shopDomain: "cardshellz.myshopify.com", accessToken: "secret-token" })),
  };
  return new ShopifyCustomerRefundProvider(credentials, fetchMock as typeof fetch, 1_000);
}

function source(): ReturnFinancialCaseSource {
  return {
    caseId: 1,
    caseNumber: "RET-0000000001",
    businessContext: "retail",
    channelId: 36,
    channelProvider: "shopify",
    vendorId: null,
    omsOrderId: 653408,
    externalOrderId: "1001",
    externalOrderNumber: "#61694",
    currency: "USD",
    customerRefundStatus: "pending",
    vendorSettlementStatus: "not_applicable",
    policyVersion: 2,
    updatedAt: new Date("2026-08-23T12:00:00.000Z"),
    items: [{ returnCaseItemId: 41, externalLineItemId: "2001", quantity: 1 }],
    actionContext: {} as ReturnFinancialCaseSource["actionContext"],
  };
}

function quote(): CustomerRefundQuote {
  return {
    provider: "shopify",
    currency: "USD",
    amountCents: 525,
    maximumRefundableCents: 525,
    lines: [{
      returnCaseItemId: 41,
      externalLineItemId: "2001",
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
  };
}

function refundResponse(input: { total: string; transactionTotal: string }): unknown {
  return {
    data: {
      refundCreate: {
        refund: {
          id: "gid://shopify/Refund/4001",
          processedAt: "2026-08-23T13:00:00.000Z",
          totalRefundedSet: money(input.total),
          transactions: {
            nodes: [{
              id: "gid://shopify/OrderTransaction/5001",
              status: "SUCCESS",
              gateway: "shopify_payments",
              amountSet: money(input.transactionTotal),
            }],
          },
        },
        userErrors: [],
      },
    },
  };
}

function money(amount: string): { presentmentMoney: { amount: string; currencyCode: string } } {
  return { presentmentMoney: { amount, currencyCode: "USD" } };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function readRequest(fetchMock: ReturnType<typeof vi.fn>): {
  query: string;
  variables: Record<string, unknown>;
} {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
  return JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
}
