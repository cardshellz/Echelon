import { createHash } from "node:crypto";
import type { ReturnBusinessContext } from "@shared/schema";
import {
  deriveReturnCaseActionPlan,
  type ReturnCaseActionContext,
} from "../domain/return-case-actions";
import type {
  DropshipReturnEngineFaultCategory,
  DropshipReturnSettlement,
} from "../../dropship/domain/return-fee-engine";

const MAX_IDEMPOTENCY_KEY_LENGTH = 160;
const MAX_NOTES_LENGTH = 2_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHOPIFY_IDEMPOTENCY_RETRY_WINDOW_MS = 23 * 60 * 60 * 1_000;

export interface ReturnFinancialCaseItem {
  returnCaseItemId: number;
  omsOrderLineId: number | null;
  externalLineItemId: string | null;
  productVariantId: number | null;
  quantity: number;
  sku: string | null;
  title: string | null;
}

export interface ReturnFinancialCaseSource {
  caseId: number;
  caseNumber: string;
  businessContext: ReturnBusinessContext;
  channelProvider: string | null;
  channelId: number | null;
  vendorId: number | null;
  storeConnectionId: number | null;
  omsOrderId: number;
  externalOrderId: string;
  externalOrderNumber: string | null;
  currency: string;
  policyVersion: number;
  updatedAt: Date;
  actionContext: ReturnCaseActionContext;
  items: ReturnFinancialCaseItem[];
}

export interface ReturnCaseFinancialSourceStore {
  loadCase(caseId: number): Promise<ReturnFinancialCaseSource | null>;
}

export interface CustomerRefundQuoteLine {
  returnCaseItemId: number;
  externalLineItemId: string;
  quantity: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export interface CustomerRefundQuoteTransaction {
  position: number;
  parentTransactionId: string;
  gateway: string;
  amountCents: number;
}

export interface CustomerRefundQuote {
  provider: "shopify";
  currency: string;
  amountCents: number;
  maximumRefundableCents: number;
  lines: CustomerRefundQuoteLine[];
  transactions: CustomerRefundQuoteTransaction[];
}

export interface CustomerRefundPreview {
  commandType: "issue_customer_refund";
  caseId: number;
  caseNumber: string;
  externalOrderId: string;
  externalOrderNumber: string | null;
  quoteHash: string;
  quote: CustomerRefundQuote;
}

export interface ShopifyRefundExecution {
  providerRefundId: string;
  completedAt: Date;
  rawResult: Record<string, unknown>;
}

export interface CustomerRefundProvider {
  quote(input: {
    source: ReturnFinancialCaseSource;
    lines: Array<{
      returnCaseItemId: number;
      externalLineItemId: string;
      quantity: number;
    }>;
  }): Promise<CustomerRefundQuote>;
  execute(input: {
    source: ReturnFinancialCaseSource;
    quote: CustomerRefundQuote;
    idempotencyKey: string;
    notifyCustomer: boolean;
    notes: string | null;
  }): Promise<ShopifyRefundExecution>;
}

export interface IssueCustomerRefundInput {
  caseId: number;
  quoteHash: string;
  idempotencyKey: string;
  notifyCustomer: boolean;
  notes: string | null;
  actor: string;
}

export interface IssueCustomerRefundResult {
  commandType: "issue_customer_refund";
  caseId: number;
  caseNumber: string;
  customerRefundId: number;
  provider: "shopify";
  providerRefundId: string;
  currency: string;
  amountCents: number;
  completedAt: string;
  replayed: boolean;
}

export interface StoredCustomerRefund {
  customerRefundId: number;
  caseId: number;
  caseNumber: string;
  idempotencyKey: string;
  requestHash: string;
  quoteHash: string;
  notifyCustomer: boolean;
  notes: string | null;
  status: "pending" | "completed" | "failed";
  quote: CustomerRefundQuote;
  providerRefundId: string | null;
  requestedAt: Date;
  completedAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface ReserveCustomerRefundInput {
  source: ReturnFinancialCaseSource;
  idempotencyKey: string;
  requestHash: string;
  quoteHash: string;
  notifyCustomer: boolean;
  notes: string | null;
  actor: string;
  quote: CustomerRefundQuote;
  now: Date;
}

export interface ReturnCaseCustomerRefundStore {
  findByIdempotencyKey(idempotencyKey: string): Promise<StoredCustomerRefund | null>;
  reserve(input: ReserveCustomerRefundInput): Promise<StoredCustomerRefund>;
  complete(input: {
    customerRefundId: number;
    source: ReturnFinancialCaseSource;
    execution: ShopifyRefundExecution;
    actor: string;
    now: Date;
  }): Promise<IssueCustomerRefundResult>;
  fail(input: {
    customerRefundId: number;
    source: ReturnFinancialCaseSource;
    code: string;
    message: string;
    actor: string;
    now: Date;
  }): Promise<void>;
}

export interface VendorSettlementQuote {
  currency: string;
  faultCategory: DropshipReturnEngineFaultCategory;
  returnShippingActualCents: number | null;
  settlement: DropshipReturnSettlement;
  policyFeeIds: {
    restockingFeeId: number | null;
    processingFeeId: number | null;
    returnShippingFeeId: number | null;
  };
}

export interface VendorSettlementPreview {
  commandType: "settle_vendor_account";
  caseId: number;
  caseNumber: string;
  vendorId: number;
  quoteHash: string;
  quote: VendorSettlementQuote;
}

export interface VendorSettlementQuoteProvider {
  quote(input: {
    source: ReturnFinancialCaseSource;
    faultCategory: DropshipReturnEngineFaultCategory;
    at: Date;
  }): Promise<VendorSettlementQuote>;
}

export interface SettleVendorAccountInput {
  caseId: number;
  faultCategory: DropshipReturnEngineFaultCategory;
  quoteHash: string;
  idempotencyKey: string;
  notes: string | null;
  actor: string;
}

export interface SettleVendorAccountResult {
  commandType: "settle_vendor_account";
  caseId: number;
  caseNumber: string;
  vendorSettlementId: number;
  vendorId: number;
  currency: string;
  grossCreditCents: number;
  totalFeeCents: number;
  netSettlementCents: number;
  walletLedgerIds: number[];
  settledAt: string;
  replayed: boolean;
}

export interface ReturnCaseVendorSettlementStore {
  findReplay(
    idempotencyKey: string,
    requestHash: string,
  ): Promise<SettleVendorAccountResult | null>;
  settle(input: {
    source: ReturnFinancialCaseSource;
    quote: VendorSettlementQuote;
    quoteHash: string;
    requestHash: string;
    idempotencyKey: string;
    notes: string | null;
    actor: string;
    now: Date;
  }): Promise<SettleVendorAccountResult>;
}

export class ReturnCaseFinancialError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReturnCaseFinancialError";
  }
}

export class CustomerRefundProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CustomerRefundProviderError";
  }
}

export class ReturnCaseFinancialService {
  constructor(
    private readonly sourceStore: ReturnCaseFinancialSourceStore,
    private readonly customerRefundStore: ReturnCaseCustomerRefundStore,
    private readonly customerRefundProvider: CustomerRefundProvider,
    private readonly vendorSettlementQuoteProvider: VendorSettlementQuoteProvider,
    private readonly vendorSettlementStore: ReturnCaseVendorSettlementStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async previewCustomerRefund(rawCaseId: number): Promise<CustomerRefundPreview> {
    const caseId = positiveSafeInteger(rawCaseId, "caseId");
    return (await this.quoteCustomerRefund(caseId)).preview;
  }

  private async quoteCustomerRefund(caseId: number): Promise<{
    source: ReturnFinancialCaseSource;
    preview: CustomerRefundPreview;
  }> {
    const source = await this.loadCase(caseId);
    requireActionAvailable(source, "issue_customer_refund");
    if (source.channelId === null) {
      throw new ReturnCaseFinancialError(
        "RETURN_CUSTOMER_REFUND_CHANNEL_MISSING",
        "The Shopify return case has no source sales channel.",
        409,
        { caseId },
      );
    }
    const lines = source.items.map((item) => {
      if (!item.externalLineItemId) {
        throw new ReturnCaseFinancialError(
          "RETURN_CUSTOMER_REFUND_LINE_REFERENCE_MISSING",
          "A returned item is missing its Shopify line item reference.",
          409,
          { caseId, returnCaseItemId: item.returnCaseItemId },
        );
      }
      return {
        returnCaseItemId: item.returnCaseItemId,
        externalLineItemId: item.externalLineItemId,
        quantity: item.quantity,
      };
    });
    const quote = validateCustomerRefundQuote(
      await this.customerRefundProvider.quote({ source, lines }),
      source,
      lines,
    );
    return { source, preview: {
      commandType: "issue_customer_refund",
      caseId,
      caseNumber: source.caseNumber,
      externalOrderId: source.externalOrderId,
      externalOrderNumber: source.externalOrderNumber,
      quoteHash: hashQuote(quote),
      quote,
    } };
  }

  async issueCustomerRefund(rawInput: IssueCustomerRefundInput): Promise<IssueCustomerRefundResult> {
    const input = normalizeCustomerRefundInput(rawInput);
    const requestHash = hashRequest("issue_customer_refund", input);
    const stored = await this.customerRefundStore.findByIdempotencyKey(input.idempotencyKey);
    if (stored) return this.resumeCustomerRefund(stored, input, requestHash);

    const quoted = await this.quoteCustomerRefund(input.caseId);
    const { preview, source } = quoted;
    if (preview.quoteHash !== input.quoteHash) {
      throw staleQuote("customer refund", input.quoteHash, preview.quoteHash, input.caseId);
    }
    const reserved = await this.customerRefundStore.reserve({
      source,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      quoteHash: input.quoteHash,
      notifyCustomer: input.notifyCustomer,
      notes: input.notes,
      actor: input.actor,
      quote: preview.quote,
      now: checkedClock(this.clock),
    });
    return this.resumeCustomerRefund(reserved, input, requestHash, source);
  }

  async previewVendorSettlement(input: {
    caseId: number;
    faultCategory: DropshipReturnEngineFaultCategory;
  }): Promise<VendorSettlementPreview> {
    const caseId = positiveSafeInteger(input.caseId, "caseId");
    const faultCategory = readFaultCategory(input.faultCategory);
    return (await this.quoteVendorSettlement(caseId, faultCategory)).preview;
  }

  private async quoteVendorSettlement(
    caseId: number,
    faultCategory: DropshipReturnEngineFaultCategory,
  ): Promise<{ source: ReturnFinancialCaseSource; preview: VendorSettlementPreview }> {
    const source = await this.loadCase(caseId);
    requireActionAvailable(source, "settle_vendor_account");
    if (source.vendorId === null) {
      throw new ReturnCaseFinancialError(
        "RETURN_VENDOR_ID_MISSING",
        "The dropship return case has no vendor identity.",
        409,
        { caseId },
      );
    }
    const quote = validateVendorSettlementQuote(
      await this.vendorSettlementQuoteProvider.quote({
        source,
        faultCategory,
        at: checkedClock(this.clock),
      }),
      source,
      faultCategory,
    );
    return { source, preview: {
      commandType: "settle_vendor_account",
      caseId,
      caseNumber: source.caseNumber,
      vendorId: source.vendorId,
      quoteHash: hashQuote(quote),
      quote,
    } };
  }

  async settleVendorAccount(rawInput: SettleVendorAccountInput): Promise<SettleVendorAccountResult> {
    const input = normalizeVendorSettlementInput(rawInput);
    const requestHash = hashRequest("settle_vendor_account", input);
    const replay = await this.vendorSettlementStore.findReplay(input.idempotencyKey, requestHash);
    if (replay) return replay;

    const quoted = await this.quoteVendorSettlement(input.caseId, input.faultCategory);
    const { preview, source } = quoted;
    if (preview.quoteHash !== input.quoteHash) {
      throw staleQuote("vendor settlement", input.quoteHash, preview.quoteHash, input.caseId);
    }
    return this.vendorSettlementStore.settle({
      source,
      quote: preview.quote,
      quoteHash: input.quoteHash,
      requestHash,
      idempotencyKey: input.idempotencyKey,
      notes: input.notes,
      actor: input.actor,
      now: checkedClock(this.clock),
    });
  }

  private async resumeCustomerRefund(
    stored: StoredCustomerRefund,
    input: ReturnType<typeof normalizeCustomerRefundInput>,
    requestHash: string,
    knownSource?: ReturnFinancialCaseSource,
  ): Promise<IssueCustomerRefundResult> {
    if (stored.caseId !== input.caseId || stored.requestHash !== requestHash) {
      throw new ReturnCaseFinancialError(
        "RETURN_FINANCIAL_IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different customer refund request.",
        409,
        { caseId: input.caseId, idempotencyKey: input.idempotencyKey },
      );
    }
    if (stored.status === "completed") {
      if (!stored.providerRefundId || !stored.completedAt) {
        throw storedEvidenceInvalid("Completed customer refund evidence is incomplete.");
      }
      return {
        commandType: "issue_customer_refund",
        caseId: stored.caseId,
        caseNumber: stored.caseNumber,
        customerRefundId: stored.customerRefundId,
        provider: "shopify",
        providerRefundId: stored.providerRefundId,
        currency: stored.quote.currency,
        amountCents: stored.quote.amountCents,
        completedAt: stored.completedAt.toISOString(),
        replayed: true,
      };
    }
    if (stored.status === "failed") {
      throw new ReturnCaseFinancialError(
        stored.failureCode ?? "RETURN_CUSTOMER_REFUND_FAILED",
        stored.failureMessage ?? "The stored customer refund attempt failed. Use a new idempotency key after correcting the issue.",
        409,
        { caseId: stored.caseId, customerRefundId: stored.customerRefundId },
      );
    }
    const retryAt = checkedClock(this.clock);
    const reservationAgeMs = retryAt.getTime() - stored.requestedAt.getTime();
    if (!Number.isFinite(reservationAgeMs) || reservationAgeMs < 0) {
      throw storedEvidenceInvalid("Customer refund reservation timestamp is invalid.");
    }
    if (reservationAgeMs >= SHOPIFY_IDEMPOTENCY_RETRY_WINDOW_MS) {
      throw new ReturnCaseFinancialError(
        "RETURN_CUSTOMER_REFUND_RECONCILIATION_REQUIRED",
        "The Shopify refund result is still unresolved outside the safe automatic retry window. Reconcile the provider result before retrying.",
        409,
        {
          caseId: stored.caseId,
          customerRefundId: stored.customerRefundId,
          requestedAt: stored.requestedAt.toISOString(),
        },
      );
    }
    const source = knownSource ?? await this.loadCase(input.caseId);
    try {
      const execution = await this.customerRefundProvider.execute({
        source,
        quote: stored.quote,
        idempotencyKey: input.idempotencyKey,
        notifyCustomer: input.notifyCustomer,
        notes: input.notes,
      });
      return await this.customerRefundStore.complete({
        customerRefundId: stored.customerRefundId,
        source,
        execution,
        actor: input.actor,
        now: checkedClock(this.clock),
      });
    } catch (error) {
      if (error instanceof CustomerRefundProviderError && !error.retryable) {
        await this.customerRefundStore.fail({
          customerRefundId: stored.customerRefundId,
          source,
          code: error.code,
          message: error.message,
          actor: input.actor,
          now: checkedClock(this.clock),
        });
        throw new ReturnCaseFinancialError(error.code, error.message, 409, error.context);
      }
      if (error instanceof ReturnCaseFinancialError) throw error;
      throw new ReturnCaseFinancialError(
        error instanceof CustomerRefundProviderError
          ? error.code
          : "RETURN_CUSTOMER_REFUND_PROVIDER_UNAVAILABLE",
        "The Shopify refund result is not yet confirmed. Retrying with the same idempotency key is safe.",
        503,
        {
          caseId: input.caseId,
          customerRefundId: stored.customerRefundId,
          providerMessage: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private async loadCase(caseId: number): Promise<ReturnFinancialCaseSource> {
    const source = await this.sourceStore.loadCase(caseId);
    if (!source) {
      throw new ReturnCaseFinancialError(
        "RETURN_CASE_NOT_FOUND",
        "Return case was not found.",
        404,
        { caseId },
      );
    }
    return validateSource(source);
  }
}

function requireActionAvailable(
  source: ReturnFinancialCaseSource,
  kind: "issue_customer_refund" | "settle_vendor_account",
): void {
  const action = deriveReturnCaseActionPlan(source.actionContext).actions.find(
    (candidate) => candidate.kind === kind,
  );
  if (!action || action.state !== "available") {
    throw new ReturnCaseFinancialError(
      action?.reasonCode ?? "RETURN_FINANCIAL_ACTION_UNAVAILABLE",
      `${action?.label ?? "The requested financial action"} is not available for this return case.`,
      409,
      { caseId: source.caseId, actionKind: kind, actionState: action?.state ?? null },
    );
  }
}

function normalizeCustomerRefundInput(input: IssueCustomerRefundInput) {
  if (typeof input.notifyCustomer !== "boolean") {
    throw new ReturnCaseFinancialError(
      "RETURN_FINANCIAL_INPUT_INVALID",
      "notifyCustomer must be a boolean.",
      400,
      { field: "notifyCustomer" },
    );
  }
  return {
    caseId: positiveSafeInteger(input.caseId, "caseId"),
    quoteHash: requiredHash(input.quoteHash, "quoteHash"),
    idempotencyKey: requiredText(input.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_LENGTH),
    notifyCustomer: input.notifyCustomer,
    notes: optionalText(input.notes, "notes", MAX_NOTES_LENGTH),
    actor: requiredText(input.actor, "actor", 255),
  };
}

function normalizeVendorSettlementInput(input: SettleVendorAccountInput) {
  return {
    caseId: positiveSafeInteger(input.caseId, "caseId"),
    faultCategory: readFaultCategory(input.faultCategory),
    quoteHash: requiredHash(input.quoteHash, "quoteHash"),
    idempotencyKey: requiredText(input.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_LENGTH),
    notes: optionalText(input.notes, "notes", MAX_NOTES_LENGTH),
    actor: requiredText(input.actor, "actor", 255),
  };
}

function validateSource(source: ReturnFinancialCaseSource): ReturnFinancialCaseSource {
  positiveSafeInteger(source.caseId, "source.caseId");
  positiveSafeInteger(source.omsOrderId, "source.omsOrderId");
  positiveSafeInteger(source.policyVersion, "source.policyVersion");
  if (source.channelId !== null) positiveSafeInteger(source.channelId, "source.channelId");
  if (source.channelProvider !== null) {
    requiredText(source.channelProvider, "source.channelProvider", 40);
  }
  requiredText(source.caseNumber, "source.caseNumber", 32);
  requiredText(source.externalOrderId, "source.externalOrderId", 100);
  if (source.externalOrderNumber !== null) {
    requiredText(source.externalOrderNumber, "source.externalOrderNumber", 50);
  }
  currencyCode(source.currency, "source.currency");
  if (!(source.updatedAt instanceof Date) || Number.isNaN(source.updatedAt.getTime())) {
    throw storedEvidenceInvalid("Return case updated timestamp is invalid.");
  }
  if (source.items.length === 0) throw storedEvidenceInvalid("Return case has no items.");
  const itemIds = new Set<number>();
  for (const item of source.items) {
    positiveSafeInteger(item.returnCaseItemId, "source.returnCaseItemId");
    positiveSafeInteger(item.quantity, "source.quantity");
    if (itemIds.has(item.returnCaseItemId)) {
      throw storedEvidenceInvalid("Return case contains duplicate item evidence.");
    }
    itemIds.add(item.returnCaseItemId);
  }
  return source;
}

function validateCustomerRefundQuote(
  quote: CustomerRefundQuote,
  source: ReturnFinancialCaseSource,
  requestedLines: Array<{ returnCaseItemId: number; externalLineItemId: string; quantity: number }>,
): CustomerRefundQuote {
  if (quote.provider !== "shopify") throw storedEvidenceInvalid("Customer refund provider is invalid.");
  if (currencyCode(quote.currency, "quote.currency") !== source.currency) {
    throw new ReturnCaseFinancialError(
      "RETURN_CUSTOMER_REFUND_CURRENCY_MISMATCH",
      "Shopify returned a refund quote in a different currency.",
      409,
      { caseId: source.caseId, orderCurrency: source.currency, quoteCurrency: quote.currency },
    );
  }
  nonNegativeSafeInteger(quote.amountCents, "quote.amountCents");
  nonNegativeSafeInteger(quote.maximumRefundableCents, "quote.maximumRefundableCents");
  if (quote.amountCents <= 0 || quote.amountCents > quote.maximumRefundableCents) {
    throw new ReturnCaseFinancialError(
      "RETURN_CUSTOMER_REFUND_QUOTE_INVALID",
      "Shopify returned an invalid or zero refund amount.",
      409,
      { caseId: source.caseId, amountCents: quote.amountCents, maximumRefundableCents: quote.maximumRefundableCents },
    );
  }
  if (quote.lines.length !== requestedLines.length) {
    throw storedEvidenceInvalid("Shopify refund quote line count does not match the return case.");
  }
  const requestedById = new Map(requestedLines.map((line) => [line.returnCaseItemId, line]));
  let lineTotal = 0;
  const seen = new Set<number>();
  for (const line of quote.lines) {
    const requested = requestedById.get(line.returnCaseItemId);
    if (!requested || seen.has(line.returnCaseItemId)
      || requested.externalLineItemId !== line.externalLineItemId
      || requested.quantity !== line.quantity) {
      throw storedEvidenceInvalid("Shopify refund quote lines do not match the return case.");
    }
    seen.add(line.returnCaseItemId);
    nonNegativeSafeInteger(line.subtotalCents, "quote.line.subtotalCents");
    nonNegativeSafeInteger(line.taxCents, "quote.line.taxCents");
    nonNegativeSafeInteger(line.totalCents, "quote.line.totalCents");
    if (line.totalCents !== line.subtotalCents + line.taxCents) {
      throw storedEvidenceInvalid("Shopify refund quote line totals are inconsistent.");
    }
    lineTotal = checkedAdd(lineTotal, line.totalCents, "refund quote line total");
  }
  let transactionTotal = 0;
  const positions = new Set<number>();
  const parentTransactionIds = new Set<string>();
  for (const transaction of quote.transactions) {
    nonNegativeSafeInteger(transaction.position, "quote.transaction.position");
    const parentTransactionId = requiredText(transaction.parentTransactionId, "quote.transaction.parentTransactionId", 160);
    requiredText(transaction.gateway, "quote.transaction.gateway", 160);
    positiveSafeInteger(transaction.amountCents, "quote.transaction.amountCents");
    if (positions.has(transaction.position) || parentTransactionIds.has(parentTransactionId)) {
      throw storedEvidenceInvalid("Shopify refund transaction evidence is duplicated.");
    }
    positions.add(transaction.position);
    parentTransactionIds.add(parentTransactionId);
    transactionTotal = checkedAdd(transactionTotal, transaction.amountCents, "refund quote transaction total");
  }
  if (quote.transactions.length === 0 || transactionTotal !== quote.amountCents || lineTotal !== quote.amountCents) {
    throw storedEvidenceInvalid("Shopify refund quote totals are inconsistent.");
  }
  return quote;
}

function validateVendorSettlementQuote(
  quote: VendorSettlementQuote,
  source: ReturnFinancialCaseSource,
  faultCategory: DropshipReturnEngineFaultCategory,
): VendorSettlementQuote {
  const quoteCurrency = currencyCode(quote.currency, "quote.currency");
  if (quoteCurrency !== source.currency) {
    throw new ReturnCaseFinancialError(
      "RETURN_VENDOR_SETTLEMENT_CURRENCY_MISMATCH",
      "The vendor settlement quote uses a different currency than the source order.",
      409,
      { caseId: source.caseId, sourceCurrency: source.currency, quoteCurrency },
    );
  }
  if (quote.faultCategory !== faultCategory) throw storedEvidenceInvalid("Vendor settlement fault category changed while quoting.");
  if (quote.returnShippingActualCents !== null) {
    nonNegativeSafeInteger(quote.returnShippingActualCents, "quote.returnShippingActualCents");
  }
  for (const [field, value] of Object.entries(quote.policyFeeIds)) {
    if (value !== null) positiveEvidenceInteger(value, `quote.policyFeeIds.${field}`);
  }
  const settlement = quote.settlement;
  const moneyFields: Array<[string, number]> = [
    ["productCreditCents", settlement.productCreditCents],
    ["originalShippingCreditCents", settlement.originalShippingCreditCents],
    ["restockingFeeCents", settlement.restockingFeeCents],
    ["processingFeeCents", settlement.processingFeeCents],
    ["returnShippingFeeCents", settlement.returnShippingFeeCents],
    ["grossCreditCents", settlement.grossCreditCents],
    ["totalFeeCents", settlement.totalFeeCents],
  ];
  for (const [field, value] of moneyFields) nonNegativeSafeInteger(value, `quote.${field}`);
  const expectedGrossCredit = checkedAdd(
    settlement.productCreditCents,
    settlement.originalShippingCreditCents,
    "vendor gross credit",
  );
  const expectedTotalFees = checkedAdd(
    checkedAdd(settlement.restockingFeeCents, settlement.processingFeeCents, "vendor total fees"),
    settlement.returnShippingFeeCents,
    "vendor total fees",
  );
  const expectedNetSettlement = checkedAdd(expectedGrossCredit, -expectedTotalFees, "vendor net settlement");
  if (!Number.isSafeInteger(settlement.netSettlementCents)
    || settlement.grossCreditCents !== expectedGrossCredit
    || settlement.totalFeeCents !== expectedTotalFees
    || settlement.netSettlementCents !== expectedNetSettlement
    || (settlement.creditLedgerType !== "return_credit" && settlement.creditLedgerType !== "insurance_pool_credit")
    || !isObject(settlement.breakdown)) {
    throw storedEvidenceInvalid("Vendor settlement quote totals are inconsistent.");
  }
  return quote;
}

function readFaultCategory(value: unknown): DropshipReturnEngineFaultCategory {
  if (value === "card_shellz" || value === "vendor" || value === "customer"
    || value === "marketplace" || value === "carrier") return value;
  throw new ReturnCaseFinancialError(
    "RETURN_VENDOR_SETTLEMENT_INPUT_INVALID",
    "Vendor settlement fault category is invalid.",
    400,
    { faultCategory: value },
  );
}

function hashRequest(commandType: string, input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ commandType, ...input })).digest("hex");
}

export function hashQuote(quote: CustomerRefundQuote | VendorSettlementQuote): string {
  return createHash("sha256").update(JSON.stringify(quote)).digest("hex");
}

function staleQuote(label: string, expectedQuoteHash: string, actualQuoteHash: string, caseId: number) {
  return new ReturnCaseFinancialError(
    "RETURN_FINANCIAL_QUOTE_STALE",
    `The ${label} changed after review. Refresh the quote before continuing.`,
    409,
    { caseId, expectedQuoteHash, actualQuoteHash },
  );
}

function storedEvidenceInvalid(message: string): ReturnCaseFinancialError {
  return new ReturnCaseFinancialError("RETURN_FINANCIAL_EVIDENCE_INVALID", message, 500);
}

function checkedClock(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ReturnCaseFinancialError("RETURN_FINANCIAL_CLOCK_INVALID", "Return financial command clock is invalid.", 500);
  }
  return new Date(now.getTime());
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ReturnCaseFinancialError("RETURN_FINANCIAL_INPUT_INVALID", `${field} must be a positive integer.`, 400, { field });
  }
  return value as number;
}

function positiveEvidenceInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw storedEvidenceInvalid(`${field} must be a positive integer.`);
  }
  return value as number;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw storedEvidenceInvalid(`${field} must be a non-negative integer.`);
  }
  return value as number;
}

function requiredHash(value: unknown, field: string): string {
  const text = requiredText(value, field, 64);
  if (!SHA256_PATTERN.test(text)) {
    throw new ReturnCaseFinancialError("RETURN_FINANCIAL_INPUT_INVALID", `${field} must be a SHA-256 hash.`, 400, { field });
  }
  return text;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ReturnCaseFinancialError("RETURN_FINANCIAL_INPUT_INVALID", `${field} is invalid.`, 400, { field });
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, field, maxLength);
}

function currencyCode(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    throw storedEvidenceInvalid(`${field} must be an uppercase ISO currency code.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkedAdd(left: number, right: number, field: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw storedEvidenceInvalid(`${field} exceeds safe integer range.`);
  return total;
}
