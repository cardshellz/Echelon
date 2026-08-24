import { describe, expect, it, vi } from "vitest";
import {
  CustomerRefundProviderError,
  ReturnCaseFinancialService,
  hashQuote,
  type CustomerRefundProvider,
  type CustomerRefundQuote,
  type ReturnCaseCustomerRefundStore,
  type ReturnFinancialCaseSource,
  type ReturnCaseFinancialSourceStore,
  type ReturnCaseVendorSettlementStore,
  type StoredCustomerRefund,
  type VendorSettlementQuote,
  type VendorSettlementQuoteProvider,
} from "../../application/return-case-financial.service";
import type { ReturnCaseActionContext } from "../../domain/return-case-actions";

const NOW = new Date("2026-08-23T20:00:00.000Z");

describe("ReturnCaseFinancialService", () => {
  it("quotes and issues an exact Shopify refund without invoking vendor settlement", async () => {
    const harness = financialHarness(retailSource());
    const preview = await harness.service.previewCustomerRefund(42);

    const result = await harness.service.issueCustomerRefund({
      caseId: 42,
      quoteHash: preview.quoteHash,
      idempotencyKey: "refund-command-42",
      notifyCustomer: true,
      notes: "Approved return",
      actor: "user:7",
    });

    expect(preview).toMatchObject({
      commandType: "issue_customer_refund",
      caseId: 42,
      externalOrderId: "gid://shopify/Order/500",
      externalOrderNumber: "#61694",
      quote: { amountCents: 525, currency: "USD" },
    });
    expect(harness.customerProvider.quote).toHaveBeenCalledWith({
      source: expect.objectContaining({ caseId: 42, businessContext: "retail" }),
      lines: [{ returnCaseItemId: 11, externalLineItemId: "gid://shopify/LineItem/700", quantity: 1 }],
    });
    expect(harness.customerStore.reserve).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "refund-command-42",
      quoteHash: preview.quoteHash,
      notifyCustomer: true,
      notes: "Approved return",
      actor: "user:7",
      now: NOW,
    }));
    expect(harness.customerProvider.execute).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "refund-command-42",
      notifyCustomer: true,
      quote: customerQuote(),
    }));
    expect(result).toMatchObject({ commandType: "issue_customer_refund", amountCents: 525, replayed: false });
    expect(harness.vendorQuoteProvider.quote).not.toHaveBeenCalled();
    expect(harness.vendorStore.settle).not.toHaveBeenCalled();
  });

  it("rejects a stale Shopify quote before reserving or calling the provider", async () => {
    const harness = financialHarness(retailSource());

    await expect(harness.service.issueCustomerRefund({
      caseId: 42,
      quoteHash: "a".repeat(64),
      idempotencyKey: "refund-command-stale",
      notifyCustomer: false,
      notes: null,
      actor: "user:7",
    })).rejects.toMatchObject({ code: "RETURN_FINANCIAL_QUOTE_STALE", status: 409 });

    expect(harness.customerStore.reserve).not.toHaveBeenCalled();
    expect(harness.customerProvider.execute).not.toHaveBeenCalled();
  });

  it("keeps an unconfirmed provider result pending and safe for same-key retry", async () => {
    const harness = financialHarness(retailSource());
    const preview = await harness.service.previewCustomerRefund(42);
    vi.mocked(harness.customerProvider.execute).mockRejectedValueOnce(
      new CustomerRefundProviderError(
        "RETURN_CUSTOMER_REFUND_RESULT_UNCONFIRMED",
        "Shopify result is not yet confirmed.",
        true,
      ),
    );

    await expect(harness.service.issueCustomerRefund({
      caseId: 42,
      quoteHash: preview.quoteHash,
      idempotencyKey: "refund-command-retry",
      notifyCustomer: false,
      notes: null,
      actor: "user:7",
    })).rejects.toMatchObject({
      code: "RETURN_CUSTOMER_REFUND_RESULT_UNCONFIRMED",
      status: 503,
    });

    expect(harness.customerStore.fail).not.toHaveBeenCalled();
  });

  it("records a terminal Shopify rejection and requires a corrected new command", async () => {
    const harness = financialHarness(retailSource());
    const preview = await harness.service.previewCustomerRefund(42);
    vi.mocked(harness.customerProvider.execute).mockRejectedValueOnce(
      new CustomerRefundProviderError("RETURN_CUSTOMER_REFUND_REJECTED", "Refund is not permitted.", false),
    );

    await expect(harness.service.issueCustomerRefund({
      caseId: 42,
      quoteHash: preview.quoteHash,
      idempotencyKey: "refund-command-rejected",
      notifyCustomer: false,
      notes: null,
      actor: "user:7",
    })).rejects.toMatchObject({ code: "RETURN_CUSTOMER_REFUND_REJECTED", status: 409 });

    expect(harness.customerStore.fail).toHaveBeenCalledWith(expect.objectContaining({
      code: "RETURN_CUSTOMER_REFUND_REJECTED",
      message: "Refund is not permitted.",
      now: NOW,
    }));
  });

  it("quotes and posts dropship vendor wallet settlement without touching Shopify", async () => {
    const harness = financialHarness(dropshipSource());
    const preview = await harness.service.previewVendorSettlement({ caseId: 42, faultCategory: "vendor" });

    const result = await harness.service.settleVendorAccount({
      caseId: 42,
      faultCategory: "vendor",
      quoteHash: preview.quoteHash,
      idempotencyKey: "vendor-settlement-42",
      notes: "Vendor responsibility confirmed",
      actor: "user:9",
    });

    expect(preview).toMatchObject({
      commandType: "settle_vendor_account",
      vendorId: 22,
      quote: { faultCategory: "vendor", settlement: { grossCreditCents: 1_000, totalFeeCents: 125, netSettlementCents: 875 } },
    });
    expect(harness.vendorStore.settle).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "vendor-settlement-42",
      quoteHash: preview.quoteHash,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      actor: "user:9",
      now: NOW,
    }));
    expect(result).toMatchObject({ commandType: "settle_vendor_account", netSettlementCents: 875 });
    expect(harness.customerProvider.quote).not.toHaveBeenCalled();
    expect(harness.customerProvider.execute).not.toHaveBeenCalled();
  });

  it("rejects a vendor settlement quote in a different currency than the source order", async () => {
    const harness = financialHarness(dropshipSource());
    vi.mocked(harness.vendorQuoteProvider.quote).mockResolvedValue({
      ...vendorQuote(),
      currency: "CAD",
    });

    await expect(harness.service.previewVendorSettlement({ caseId: 42, faultCategory: "vendor" }))
      .rejects.toMatchObject({ code: "RETURN_VENDOR_SETTLEMENT_CURRENCY_MISMATCH", status: 409 });

    expect(harness.vendorStore.settle).not.toHaveBeenCalled();
  });

  it("rejects invalid fee-policy evidence from a vendor settlement quote", async () => {
    const harness = financialHarness(dropshipSource());
    vi.mocked(harness.vendorQuoteProvider.quote).mockResolvedValue({
      ...vendorQuote(),
      policyFeeIds: { ...vendorQuote().policyFeeIds, restockingFeeId: 0 },
    });

    await expect(harness.service.previewVendorSettlement({ caseId: 42, faultCategory: "vendor" }))
      .rejects.toMatchObject({ code: "RETURN_FINANCIAL_EVIDENCE_INVALID", status: 500 });

    expect(harness.vendorStore.settle).not.toHaveBeenCalled();
  });

  it("replays a completed vendor settlement before consulting mutable case state or requoting", async () => {
    const completedSource = dropshipSource();
    completedSource.actionContext.lifecycle.vendorSettlementStatus = "completed";
    const harness = financialHarness(completedSource);
    const replay = {
      commandType: "settle_vendor_account" as const,
      caseId: 42,
      caseNumber: "RET-0000000042",
      vendorSettlementId: 91,
      vendorId: 22,
      currency: "USD",
      grossCreditCents: 1_000,
      totalFeeCents: 125,
      netSettlementCents: 875,
      walletLedgerIds: [501, 502],
      settledAt: NOW.toISOString(),
      replayed: true,
    };
    vi.mocked(harness.vendorStore.findReplay).mockResolvedValueOnce(replay);

    await expect(harness.service.settleVendorAccount({
      caseId: 42,
      faultCategory: "vendor",
      quoteHash: hashQuote(vendorQuote()),
      idempotencyKey: "vendor-settlement-replay",
      notes: "Vendor responsibility confirmed",
      actor: "user:9",
    })).resolves.toEqual(replay);

    expect(harness.sourceStore.loadCase).not.toHaveBeenCalled();
    expect(harness.vendorQuoteProvider.quote).not.toHaveBeenCalled();
    expect(harness.vendorStore.settle).not.toHaveBeenCalled();
  });

  it("fails closed when the financial action does not belong to that business context", async () => {
    const retail = financialHarness(retailSource());
    await expect(retail.service.previewVendorSettlement({ caseId: 42, faultCategory: "vendor" }))
      .rejects.toMatchObject({ code: "RETURN_VENDOR_SETTLEMENT_NOT_APPLICABLE", status: 409 });

    const dropship = financialHarness(dropshipSource());
    await expect(dropship.service.previewCustomerRefund(42))
      .rejects.toMatchObject({ code: "RETURN_CUSTOMER_REFUND_NOT_OWNED", status: 409 });
  });
});

function financialHarness(source: ReturnFinancialCaseSource) {
  const sourceStore: ReturnCaseFinancialSourceStore = {
    loadCase: vi.fn().mockResolvedValue(source),
  };
  const customerProvider: CustomerRefundProvider = {
    quote: vi.fn().mockResolvedValue(customerQuote()),
    execute: vi.fn().mockResolvedValue({
      providerRefundId: "gid://shopify/Refund/900",
      completedAt: NOW,
      rawResult: { refundId: "gid://shopify/Refund/900" },
    }),
  };
  let reservedRequestHash = "";
  const customerStore: ReturnCaseCustomerRefundStore = {
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    reserve: vi.fn(async (input) => {
      reservedRequestHash = input.requestHash;
      return storedRefund(input.idempotencyKey, input.requestHash, input.quoteHash, input.quote, input.notifyCustomer, input.notes);
    }),
    complete: vi.fn(async (input) => ({
      commandType: "issue_customer_refund",
      caseId: source.caseId,
      caseNumber: source.caseNumber,
      customerRefundId: 81,
      provider: "shopify",
      providerRefundId: input.execution.providerRefundId,
      currency: input.source.currency,
      amountCents: customerQuote().amountCents,
      completedAt: input.execution.completedAt.toISOString(),
      replayed: false,
    })),
    fail: vi.fn(),
  };
  const vendorQuoteProvider: VendorSettlementQuoteProvider = {
    quote: vi.fn().mockResolvedValue(vendorQuote()),
  };
  const vendorStore: ReturnCaseVendorSettlementStore = {
    findReplay: vi.fn().mockResolvedValue(null),
    settle: vi.fn().mockResolvedValue({
      commandType: "settle_vendor_account",
      caseId: source.caseId,
      caseNumber: source.caseNumber,
      vendorSettlementId: 91,
      vendorId: source.vendorId ?? 22,
      currency: "USD",
      grossCreditCents: 1_000,
      totalFeeCents: 125,
      netSettlementCents: 875,
      walletLedgerIds: [501, 502],
      settledAt: NOW.toISOString(),
      replayed: false,
    }),
  };
  return {
    service: new ReturnCaseFinancialService(
      sourceStore,
      customerStore,
      customerProvider,
      vendorQuoteProvider,
      vendorStore,
      () => new Date(NOW),
    ),
    sourceStore,
    customerStore,
    customerProvider,
    vendorQuoteProvider,
    vendorStore,
    getReservedRequestHash: () => reservedRequestHash,
  };
}

function retailSource(): ReturnFinancialCaseSource {
  return source("retail", "shopify", null, "pending", "not_applicable");
}

function dropshipSource(): ReturnFinancialCaseSource {
  const result = source("dropship", "ebay", 22, "not_required", "pending");
  result.actionContext.policy = {
    ...result.actionContext.policy!,
    customerRefundAuthority: "marketplace",
    vendorSettlementTrigger: "inspection_approved",
  };
  result.channelId = null;
  result.storeConnectionId = 9;
  result.items[0].externalLineItemId = null;
  return result;
}

function source(
  businessContext: "retail" | "dropship",
  channelProvider: string,
  vendorId: number | null,
  customerRefundStatus: "pending" | "not_required",
  vendorSettlementStatus: "pending" | "not_applicable",
): ReturnFinancialCaseSource {
  return {
    caseId: 42,
    caseNumber: "RET-0000000042",
    businessContext,
    channelProvider,
    channelId: 36,
    vendorId,
    storeConnectionId: null,
    omsOrderId: 500,
    externalOrderId: "gid://shopify/Order/500",
    externalOrderNumber: "#61694",
    currency: "USD",
    policyVersion: 2,
    updatedAt: NOW,
    actionContext: actionContext(businessContext, channelProvider, vendorId, customerRefundStatus, vendorSettlementStatus),
    items: [{
      returnCaseItemId: 11,
      omsOrderLineId: 700,
      externalLineItemId: "gid://shopify/LineItem/700",
      productVariantId: 900,
      quantity: 1,
      sku: "SKU-900",
      title: "Returned item",
    }],
  };
}

function actionContext(
  businessContext: "retail" | "dropship",
  channelProvider: string,
  vendorId: number | null,
  customerRefundStatus: "pending" | "not_required",
  vendorSettlementStatus: "pending" | "not_applicable",
): ReturnCaseActionContext {
  return {
    businessContext,
    channelProvider,
    vendorId,
    lifecycle: {
      caseStatus: "open",
      approvalStatus: "approved",
      logisticsStatus: "received",
      inspectionStatus: "approved",
      customerRefundStatus,
      vendorSettlementStatus,
    },
    policy: {
      id: 6,
      name: "Return policy",
      version: 2,
      scopeKind: "channel_context",
      scopeKey: "context:return:channel:36",
      returnWindowDays: 30,
      returnDestination: "card_shellz",
      approvalAuthority: "card_shellz",
      labelProvider: "shipstation",
      returnShippingPayer: "customer",
      inspectionRequirement: "required",
      inspectionOwner: "card_shellz",
      customerRefundAuthority: "card_shellz",
      vendorSettlementTrigger: "none",
      returnlessRefundAllowed: false,
    },
    receipt: {
      wmsReturnId: 230,
      wmsStatus: "received",
      receivedAt: NOW,
      restocked: false,
      canonicalItemCount: 1,
      items: [{
        returnCaseItemId: 11,
        wmsReturnItemId: 41,
        caseExpectedQuantity: 1,
        wmsExpectedQuantity: 1,
        wmsReceivedQuantity: 1,
        wmsStatus: "received",
      }],
    },
    inspection: {
      inspectionId: 9,
      status: "approved",
      startedAt: new Date("2026-08-23T18:00:00.000Z"),
      startedBy: "user:7",
      completedAt: new Date("2026-08-23T19:00:00.000Z"),
      completedBy: "user:7",
    },
    disposition: {
      recordCount: 1,
      lines: [{
        dispositionItemId: 61,
        dispositionId: 51,
        returnCaseItemId: 11,
        treatment: "restock_sellable",
        quantity: 1,
      }],
    },
    inventoryTreatment: null,
    conditionalInspectionDecision: null,
  };
}

function customerQuote(): CustomerRefundQuote {
  return {
    provider: "shopify",
    currency: "USD",
    amountCents: 525,
    maximumRefundableCents: 525,
    lines: [{
      returnCaseItemId: 11,
      externalLineItemId: "gid://shopify/LineItem/700",
      quantity: 1,
      subtotalCents: 500,
      taxCents: 25,
      totalCents: 525,
    }],
    transactions: [{
      position: 0,
      parentTransactionId: "gid://shopify/OrderTransaction/800",
      gateway: "shopify_payments",
      amountCents: 525,
    }],
  };
}

function vendorQuote(): VendorSettlementQuote {
  return {
    currency: "USD",
    faultCategory: "vendor",
    returnShippingActualCents: 75,
    settlement: {
      productCreditCents: 1_000,
      originalShippingCreditCents: 0,
      restockingFeeCents: 50,
      processingFeeCents: 0,
      returnShippingFeeCents: 75,
      grossCreditCents: 1_000,
      totalFeeCents: 125,
      netSettlementCents: 875,
      creditLedgerType: "return_credit",
      breakdown: { faultCategory: "vendor" },
    },
    policyFeeIds: {
      restockingFeeId: 1,
      processingFeeId: null,
      returnShippingFeeId: 2,
    },
  };
}

function storedRefund(
  idempotencyKey: string,
  requestHash: string,
  quoteHash: string,
  quote: CustomerRefundQuote,
  notifyCustomer: boolean,
  notes: string | null,
): StoredCustomerRefund {
  return {
    customerRefundId: 81,
    caseId: 42,
    caseNumber: "RET-0000000042",
    idempotencyKey,
    requestHash,
    quoteHash,
    notifyCustomer,
    notes,
    status: "pending",
    quote,
    providerRefundId: null,
    requestedAt: NOW,
    completedAt: null,
    failureCode: null,
    failureMessage: null,
  };
}
