import { pool } from "../../../db";
import {
  CustomerRefundProviderError,
  type CustomerRefundProvider,
  type CustomerRefundQuote,
  type ReturnFinancialCaseSource,
  type ShopifyRefundExecution,
} from "../application/return-case-financial.service";

const SHOPIFY_RETURNS_API_VERSION = "2026-07";
const REQUEST_TIMEOUT_MS = 20_000;

interface ShopifyCredentials {
  shopDomain: string;
  accessToken: string;
}

export interface ShopifyReturnCredentialStore {
  load(channelId: number): Promise<ShopifyCredentials | null>;
}

export class PostgresShopifyReturnCredentialStore implements ShopifyReturnCredentialStore {
  async load(channelId: number): Promise<ShopifyCredentials | null> {
    const result = await pool.query<{ shop_domain: string | null; access_token: string | null }>(
      `SELECT shop_domain, access_token
       FROM channels.channel_connections
       WHERE channel_id = $1
         AND shop_domain IS NOT NULL
         AND access_token IS NOT NULL
       ORDER BY id DESC
       LIMIT 1`,
      [channelId],
    );
    const row = result.rows[0];
    if (!row?.shop_domain || !row.access_token) return null;
    return {
      shopDomain: normalizeShopDomain(row.shop_domain),
      accessToken: requiredText(row.access_token, "Shopify access token"),
    };
  }
}

interface MoneyValue { amount: unknown; currencyCode: unknown }
interface MoneyBag { presentmentMoney: MoneyValue }
interface SuggestedRefundLine {
  lineItem: { id: unknown };
  quantity: unknown;
  subtotalSet: MoneyBag;
  totalTaxSet: MoneyBag;
}
interface SuggestedTransaction {
  parentTransaction: { id: unknown } | null;
  gateway: unknown;
  amountSet: MoneyBag;
}
interface SuggestedRefundData {
  order: {
    id: unknown;
    suggestedRefund: {
      amountSet: MoneyBag;
      maximumRefundableSet: MoneyBag;
      refundLineItems: SuggestedRefundLine[];
      suggestedTransactions: SuggestedTransaction[];
    } | null;
  } | null;
}
interface RefundCreateData {
  refundCreate: {
    refund: {
      id: unknown;
      processedAt: unknown;
      totalRefundedSet: MoneyBag;
      transactions: {
        nodes: Array<{
          id: unknown;
          status: unknown;
          gateway: unknown;
          amountSet: MoneyBag;
        }>;
      };
    } | null;
    userErrors: Array<{ field?: unknown; message?: unknown }>;
  };
}

export class ShopifyCustomerRefundProvider implements CustomerRefundProvider {
  constructor(
    private readonly credentials: ShopifyReturnCredentialStore = new PostgresShopifyReturnCredentialStore(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  async quote(input: {
    source: ReturnFinancialCaseSource;
    lines: Array<{ returnCaseItemId: number; externalLineItemId: string; quantity: number }>;
  }): Promise<CustomerRefundQuote> {
    const variables = {
      id: shopifyGid("Order", input.source.externalOrderId),
      refundLineItems: input.lines.map((line) => ({
        lineItemId: shopifyGid("LineItem", line.externalLineItemId),
        quantity: line.quantity,
        restockType: "NO_RESTOCK",
      })),
    };
    const data = await this.graphql<SuggestedRefundData>(shopifyChannelId(input.source), {
      query: `query ReturnCaseSuggestedRefund($id: ID!, $refundLineItems: [RefundLineItemInput!]) {
        order(id: $id) {
          id
          suggestedRefund(refundLineItems: $refundLineItems) {
            amountSet { presentmentMoney { amount currencyCode } }
            maximumRefundableSet { presentmentMoney { amount currencyCode } }
            refundLineItems {
              lineItem { id }
              quantity
              subtotalSet { presentmentMoney { amount currencyCode } }
              totalTaxSet { presentmentMoney { amount currencyCode } }
            }
            suggestedTransactions {
              parentTransaction { id }
              gateway
              amountSet { presentmentMoney { amount currencyCode } }
            }
          }
        }
      }`,
      variables,
    });
    const suggested = data.order?.suggestedRefund;
    if (!suggested) {
      throw providerError("RETURN_CUSTOMER_REFUND_QUOTE_UNAVAILABLE", "Shopify did not return a suggested refund for this order.", false);
    }
    const amount = readMoney(suggested.amountSet.presentmentMoney, "suggested refund amount");
    const maximum = readMoney(suggested.maximumRefundableSet.presentmentMoney, "maximum refundable amount");
    requireCurrency(amount.currency, input.source.currency);
    requireCurrency(maximum.currency, input.source.currency);

    const requestedByGid = new Map(input.lines.map((line) => [
      shopifyGid("LineItem", line.externalLineItemId),
      line,
    ]));
    const lines = suggested.refundLineItems.map((line) => {
      const externalLineItemId = requiredText(line.lineItem.id, "Shopify refund line item id");
      const requested = requestedByGid.get(externalLineItemId);
      if (!requested) {
        throw providerError("RETURN_CUSTOMER_REFUND_QUOTE_INVALID", "Shopify returned an unexpected refund line item.", false);
      }
      const quantity = positiveInteger(line.quantity, "Shopify refund line quantity");
      const subtotal = readMoney(line.subtotalSet.presentmentMoney, "refund line subtotal");
      const tax = readMoney(line.totalTaxSet.presentmentMoney, "refund line tax");
      requireCurrency(subtotal.currency, input.source.currency);
      requireCurrency(tax.currency, input.source.currency);
      return {
        returnCaseItemId: requested.returnCaseItemId,
        externalLineItemId: requested.externalLineItemId,
        quantity,
        subtotalCents: subtotal.cents,
        taxCents: tax.cents,
        totalCents: checkedAdd(subtotal.cents, tax.cents),
      };
    });

    const transactions = suggested.suggestedTransactions
      .map((transaction, position) => {
        const money = readMoney(transaction.amountSet.presentmentMoney, "suggested transaction amount");
        requireCurrency(money.currency, input.source.currency);
        if (money.cents === 0) return null;
        if (!transaction.parentTransaction) {
          throw providerError(
            "RETURN_CUSTOMER_REFUND_METHOD_UNSUPPORTED",
            "Shopify did not identify an original payment transaction for this refund.",
            false,
          );
        }
        return {
          position,
          parentTransactionId: requiredText(transaction.parentTransaction.id, "Shopify parent transaction id"),
          gateway: requiredText(transaction.gateway, "Shopify refund gateway"),
          amountCents: positiveInteger(money.cents, "suggested transaction amount"),
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);
    if (transactions.length === 0) {
      throw providerError(
        "RETURN_CUSTOMER_REFUND_METHOD_UNSUPPORTED",
        "This Shopify order does not have an original-payment refund transaction that Echelon can confirm safely.",
        false,
      );
    }
    return {
      provider: "shopify",
      currency: input.source.currency,
      amountCents: amount.cents,
      maximumRefundableCents: maximum.cents,
      lines,
      transactions,
    };
  }

  async execute(input: {
    source: ReturnFinancialCaseSource;
    quote: CustomerRefundQuote;
    idempotencyKey: string;
    notifyCustomer: boolean;
    notes: string | null;
  }): Promise<ShopifyRefundExecution> {
    const orderId = shopifyGid("Order", input.source.externalOrderId);
    const refundLineItems = input.quote.lines.map((line) => ({
      lineItemId: shopifyGid("LineItem", line.externalLineItemId),
      quantity: line.quantity,
      restockType: "NO_RESTOCK",
    }));
    const transactions = input.quote.transactions.map((transaction) => ({
      orderId,
      parentId: transaction.parentTransactionId,
      gateway: transaction.gateway,
      kind: "REFUND",
      amount: centsToMoney(transaction.amountCents),
    }));
    const data = await this.graphql<RefundCreateData>(shopifyChannelId(input.source), {
      query: `mutation IssueReturnCaseCustomerRefund($input: RefundInput!, $idempotencyKey: String!) {
        refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
          refund {
            id
            processedAt
            totalRefundedSet { presentmentMoney { amount currencyCode } }
            transactions(first: 50) {
              nodes {
                id
                status
                gateway
                amountSet { presentmentMoney { amount currencyCode } }
              }
            }
          }
          userErrors { field message }
        }
      }`,
      variables: {
        idempotencyKey: input.idempotencyKey,
        input: {
          orderId,
          currency: input.quote.currency,
          notify: input.notifyCustomer,
          note: input.notes ?? `Return Case ${input.source.caseNumber}`,
          refundLineItems,
          transactions,
        },
      },
    });
    const refund = data.refundCreate.refund;
    const userErrors = data.refundCreate.userErrors ?? [];
    if (refund) {
      try {
        return readCreatedRefundExecution(refund, input.quote, userErrors);
      } catch (error) {
        if (error instanceof CustomerRefundProviderError) {
          throw providerError(error.code, error.message, true, {
            ...error.context,
            reconciliationRequired: true,
          });
        }
        throw providerError(
          "RETURN_CUSTOMER_REFUND_RESULT_UNCONFIRMED",
          "Shopify created a refund record, but Echelon could not confirm its final evidence. Reconcile or retry with the same idempotency key.",
          true,
          { reconciliationRequired: true, error: error instanceof Error ? error.message : String(error) },
        );
      }
    }
    if (userErrors.length > 0) {
      const message = userErrors.map((error) => requiredText(error.message, "Shopify user error")).join("; ");
      const retryable = /concurrent|try again|temporar/i.test(message);
      throw providerError(
        retryable ? "RETURN_CUSTOMER_REFUND_PROVIDER_BUSY" : "RETURN_CUSTOMER_REFUND_REJECTED",
        message,
        retryable,
        { fields: userErrors.map((error) => error.field ?? null) },
      );
    }
    throw providerError("RETURN_CUSTOMER_REFUND_RESULT_UNCONFIRMED", "Shopify did not return the created refund.", true);
  }

  private async graphql<T>(channelId: number, payload: { query: string; variables: Record<string, unknown> }): Promise<T> {
    const credentials = await this.credentials.load(channelId);
    if (!credentials) {
      throw providerError("RETURN_CUSTOMER_REFUND_CREDENTIALS_MISSING", "Shopify credentials are not configured for this return case channel.", false, { channelId });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://${credentials.shopDomain}/admin/api/${SHOPIFY_RETURNS_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": credentials.accessToken,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw providerError(
        "RETURN_CUSTOMER_REFUND_PROVIDER_UNAVAILABLE",
        "Shopify could not be reached.",
        true,
        { error: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      clearTimeout(timer);
    }
    const body = await readJson(response);
    if (!response.ok) {
      throw providerError(
        "RETURN_CUSTOMER_REFUND_PROVIDER_HTTP_ERROR",
        `Shopify returned HTTP ${response.status}.`,
        response.status >= 429 || response.status >= 500,
        { status: response.status },
      );
    }
    const graph = body as { data?: T; errors?: Array<{ message?: unknown; extensions?: unknown }> };
    if (graph.errors?.length) {
      const messages = graph.errors.map((error) => requiredText(error.message, "Shopify GraphQL error"));
      const retryable = messages.some((message) => /concurrent|thrott|temporar|try again/i.test(message));
      throw providerError(
        retryable ? "RETURN_CUSTOMER_REFUND_PROVIDER_BUSY" : "RETURN_CUSTOMER_REFUND_PROVIDER_GRAPHQL_ERROR",
        messages.join("; "),
        retryable,
      );
    }
    if (!graph.data) throw providerError("RETURN_CUSTOMER_REFUND_PROVIDER_RESPONSE_INVALID", "Shopify returned no GraphQL data.", true);
    return graph.data;
  }
}

function readCreatedRefundExecution(
  refund: NonNullable<RefundCreateData["refundCreate"]["refund"]>,
  quote: CustomerRefundQuote,
  userErrors: RefundCreateData["refundCreate"]["userErrors"],
): ShopifyRefundExecution {
  const total = readMoney(refund.totalRefundedSet.presentmentMoney, "created refund total");
  requireCurrency(total.currency, quote.currency);
  if (total.cents !== quote.amountCents) {
    throw providerError(
      "RETURN_CUSTOMER_REFUND_TOTAL_MISMATCH",
      "Shopify created a refund with a different total than the approved quote.",
      false,
      { expectedCents: quote.amountCents, actualCents: total.cents },
    );
  }
  const transactionEvidence = refund.transactions.nodes.map((transaction) => ({
    id: requiredText(transaction.id, "Shopify refund transaction id"),
    status: requiredText(transaction.status, "Shopify refund transaction status"),
    gateway: requiredText(transaction.gateway, "Shopify refund transaction gateway"),
    money: readMoney(transaction.amountSet.presentmentMoney, "Shopify refund transaction amount"),
  }));
  if (transactionEvidence.length === 0 || transactionEvidence.some((transaction) => transaction.status !== "SUCCESS")) {
    throw providerError(
      "RETURN_CUSTOMER_REFUND_RESULT_UNCONFIRMED",
      "Shopify created the refund record, but successful payment transaction evidence is not yet complete. Reconcile or retry with the same idempotency key.",
      true,
      { transactions: transactionEvidence.map(({ id, status, gateway }) => ({ id, status, gateway })) },
    );
  }
  const transactionTotal = transactionEvidence.reduce((sum, transaction) => {
    requireCurrency(transaction.money.currency, quote.currency);
    return checkedAdd(sum, transaction.money.cents);
  }, 0);
  if (transactionTotal !== quote.amountCents) {
    throw providerError(
      "RETURN_CUSTOMER_REFUND_TRANSACTION_TOTAL_MISMATCH",
      "Shopify refund transaction evidence does not match the approved refund total.",
      false,
      { expectedCents: quote.amountCents, actualCents: transactionTotal },
    );
  }
  return {
    providerRefundId: requiredText(refund.id, "Shopify refund id"),
    completedAt: validDate(refund.processedAt, "Shopify refund processed timestamp"),
    rawResult: {
      refundId: refund.id,
      processedAt: refund.processedAt,
      totalRefunded: { amountCents: total.cents, currency: total.currency },
      transactions: transactionEvidence.map((transaction) => ({
        id: transaction.id,
        status: transaction.status,
        gateway: transaction.gateway,
        amountCents: transaction.money.cents,
        currency: transaction.money.currency,
      })),
      userErrors: userErrors.map((error) => ({
        field: error.field ?? null,
        message: typeof error.message === "string" ? error.message : null,
      })),
      restockType: "NO_RESTOCK",
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw providerError("RETURN_CUSTOMER_REFUND_PROVIDER_RESPONSE_INVALID", "Shopify returned an unreadable response.", response.status >= 500);
  }
}

function readMoney(value: MoneyValue, field: string): { cents: number; currency: string } {
  return {
    cents: decimalToCents(value.amount, field),
    currency: currencyCode(value.currencyCode, `${field} currency`),
  };
}

function decimalToCents(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw providerError("RETURN_CUSTOMER_REFUND_PROVIDER_RESPONSE_INVALID", `${field} is not a valid money amount.`, false);
  }
  const [whole, fractional = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw providerError("RETURN_CUSTOMER_REFUND_PROVIDER_RESPONSE_INVALID", `${field} exceeds the supported integer-cents range.`, false);
  }
  return cents;
}

function centsToMoney(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw providerError("RETURN_CUSTOMER_REFUND_QUOTE_INVALID", "Refund transaction amount is invalid.", false);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function shopifyGid(resource: "Order" | "LineItem", value: string): string {
  const trimmed = requiredText(value, `Shopify ${resource} id`);
  const prefix = `gid://shopify/${resource}/`;
  if (trimmed.startsWith(prefix) && /^\d+$/.test(trimmed.slice(prefix.length))) return trimmed;
  if (/^\d+$/.test(trimmed)) return `${prefix}${trimmed}`;
  throw providerError("RETURN_CUSTOMER_REFUND_PROVIDER_REFERENCE_INVALID", `The Shopify ${resource} id is invalid.`, false, { resource });
}

function shopifyChannelId(source: ReturnFinancialCaseSource): number {
  if (source.channelId === null || !Number.isSafeInteger(source.channelId) || source.channelId <= 0) {
    throw providerError(
      "RETURN_CUSTOMER_REFUND_CHANNEL_MISSING",
      "The Shopify return case has no valid source sales channel.",
      false,
    );
  }
  return source.channelId;
}

function normalizeShopDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalized)) {
    throw providerError("RETURN_CUSTOMER_REFUND_CREDENTIALS_INVALID", "The configured Shopify shop domain is invalid.", false);
  }
  return normalized;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw providerError("RETURN_CUSTOMER_REFUND_PROVIDER_RESPONSE_INVALID", `${field} is missing.`, false);
  }
  return value.trim();
}

function currencyCode(value: unknown, field: string): string {
  const currency = requiredText(value, field);
  if (!/^[A-Z]{3}$/.test(currency)) throw providerError("RETURN_CUSTOMER_REFUND_PROVIDER_RESPONSE_INVALID", `${field} is invalid.`, false);
  return currency;
}

function requireCurrency(actual: string, expected: string): void {
  if (actual !== expected) {
    throw providerError("RETURN_CUSTOMER_REFUND_CURRENCY_MISMATCH", "Shopify returned a different presentment currency than the source order.", false, { expected, actual });
  }
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw providerError("RETURN_CUSTOMER_REFUND_PROVIDER_RESPONSE_INVALID", `${field} is invalid.`, false);
  }
  return parsed;
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw providerError("RETURN_CUSTOMER_REFUND_PROVIDER_RESPONSE_INVALID", "Refund total exceeds the supported integer-cents range.", false);
  return result;
}

function validDate(value: unknown, field: string): Date {
  const result = typeof value === "string" ? new Date(value) : null;
  if (!result || Number.isNaN(result.getTime())) throw providerError("RETURN_CUSTOMER_REFUND_PROVIDER_RESPONSE_INVALID", `${field} is invalid.`, true);
  return result;
}

function providerError(
  code: string,
  message: string,
  retryable: boolean,
  context?: Record<string, unknown>,
): CustomerRefundProviderError {
  return new CustomerRefundProviderError(code, message, retryable, context);
}
