import {
  matchesOrderEditQuote as matchesQuote,
  isUnpaidRecoveryRestored,
  unchangedOrderEditSnapshot,
} from "../application/order-edit-evidence";
export { isUnpaidRecoveryRestored } from "../application/order-edit-evidence";
import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";
import Decimal from "decimal.js";
import {
  OrderEditProviderError,
  OrderEditCommitNotSentError,
  type OrderEditCredentialStore,
  type OrderEditCredentials,
  type OrderEditProvider,
  type OrderEditSnapshot,
  type OrderEditPlan,
  type OrderEditQuote,
  type OrderEditExpectedLine,
  type OrderEditTransaction,
  type OrderEditRefund,
  type OrderEditRefundIntent,
  type OrderEditRefundResult,
  type OrderEditVariant,
} from "../application/order-edit-provider";
import { buildOrderEditFinancials } from "../domain/order-edit-financials";
import { priceOrderEditDiscounts } from "../domain/order-edit-discount-engine";
import { resolveOrderEditLinePlan } from "../domain/order-edit-line-plan";
import { SHOPIFY_CALCULATED_LINE_ID_PATTERN } from "@shared/order-edits/shopify-edit-identity";
import type { OrderEditDiscount } from "@shared/order-edits/order-edit-discounts";
import type { OrderEditFinancials } from "@shared/order-edits/order-edit-financials";
import * as gql from "./shopify-order-edit.queries";
import {
  orderEditSnapshotSchema,
  orderEditQuoteSchema,
  orderEditRefundIntentSchema,
} from "../application/order-edit-provider.schema";

export const ORDER_EDIT_SHOPIFY_API_VERSION = "2026-10";
const REQUEST_TIMEOUT_MS = 20_000;
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_GRAPHQL_INPUTS = 250;
// The installed pricing function emits this line-discount message. Its registration title is editable and separate.
const MEMBER_PRICING_MESSAGE = "Member discount";
const PAGE = z.object({ hasNextPage: z.boolean() });
const TEXT = z.string().min(1);
const INTEGER = z.number().int().nonnegative().safe();
const MONEY = z.object({ amount: TEXT, currencyCode: z.literal("USD") });
const BAG = z.object({ presentmentMoney: MONEY, shopMoney: MONEY });
const DISCOUNT_VALUE = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("PricingPercentageValue"),
    percentage: z.number().finite().min(0).max(100),
  }),
  MONEY.extend({ __typename: z.literal("MoneyV2") }),
]);
const META = z.object({ value: z.string() }).nullable();
const TRANSACTION = z.object({
  id: TEXT,
  kind: TEXT,
  status: z.enum([
    "SUCCESS",
    "PENDING",
    "AWAITING_RESPONSE",
    "UNKNOWN",
    "FAILURE",
    "ERROR",
  ]),
  gateway: TEXT,
  manualPaymentGateway: z.boolean(),
  parentTransaction: z.object({ id: TEXT }).nullable(),
  amountSet: BAG,
  processedAt: z.string().datetime().nullable(),
});
const REFUND = z.object({
  id: TEXT,
  note: z.string().nullable(),
  totalRefundedSet: BAG,
  transactions: z.object({ nodes: z.array(TRANSACTION), pageInfo: PAGE }),
});
const LINE = z.object({
  id: TEXT,
  title: TEXT,
  variantTitle: z.string().nullable(),
  sku: z.string().nullable(),
  currentQuantity: INTEGER,
  unfulfilledQuantity: INTEGER,
  unfulfilledDiscountedTotalSet: BAG,
  originalUnitPriceSet: BAG,
  discountedUnitPriceSet: BAG,
  priceAfterAllDiscountsBeforeTaxesSet: BAG,
  merchantEditable: z.boolean(),
  requiresShipping: z.boolean(),
  isGiftCard: z.boolean(),
  sellingPlan: z.object({ name: TEXT }).nullable(),
  lineItemGroup: z.object({ id: TEXT }).nullable(),
  variant: z.object({ id: TEXT }).nullable(),
  discountAllocations: z.array(
    z.object({
      allocatedAmountSet: BAG,
      discountApplication: z.object({ index: INTEGER }),
    }),
  ),
});
const DISCOUNT = z.object({
  __typename: TEXT,
  index: INTEGER,
  targetType: TEXT,
  allocationMethod: TEXT,
  targetSelection: TEXT,
  title: z.string().optional(),
  code: z.string().optional(),
});
const DISCOUNT_WITH_VALUE = DISCOUNT.extend({ value: DISCOUNT_VALUE });
const ORDER = z.object({
  id: TEXT,
  name: TEXT,
  updatedAt: z.string().datetime(),
  merchantEditable: z.boolean(),
  merchantEditableErrors: z.array(z.string()),
  cancelledAt: z.string().nullable(),
  closed: z.boolean(),
  fullyPaid: z.boolean(),
  capturable: z.boolean(),
  taxesIncluded: z.boolean(),
  currencyCode: z.literal("USD"),
  presentmentCurrencyCode: z.literal("USD"),
  currentTotalPriceSet: BAG,
  totalOutstandingSet: BAG,
  netPaymentSet: BAG,
  totalCapturableSet: BAG,
  currentShippingPriceSet: BAG,
  currentSubtotalPriceSet: BAG,
  currentTotalTaxSet: BAG,
  paymentCollectionDetails: z.object({
    additionalPaymentCollectionUrl: z.string().url().nullable(),
  }),
  paymentTerms: z.object({ id: TEXT }).nullable(),
  purchasingEntity: z.object({ __typename: TEXT }).nullable(),
  disputes: z.array(z.object({ id: TEXT })),
  customAttributes: z.array(z.object({ key: z.string(), value: z.string() })),
  shippingAddress: z
    .object({
      address1: z.string().nullable(),
      address2: z.string().nullable(),
      city: z.string().nullable(),
      provinceCode: z.string().nullable(),
      zip: z.string().nullable(),
      countryCodeV2: z.string().nullable(),
    })
    .nullable(),
  customer: z
    .object({ id: TEXT, tags: z.array(z.string()), membershipPlan: META })
    .nullable(),
  discountApplications: z.object({
    nodes: z.array(DISCOUNT_WITH_VALUE),
    pageInfo: PAGE,
  }),
  shippingLines: z.object({
    nodes: z.array(
      z.object({
        id: TEXT.nullable(),
        isRemoved: z.boolean(),
        originalPriceSet: BAG,
        currentDiscountedPriceSet: BAG,
      }),
    ),
    pageInfo: PAGE,
  }),
  lineItems: z.object({ nodes: z.array(LINE), pageInfo: PAGE }),
  transactions: z.array(TRANSACTION),
  transactionsCount: z.object({
    count: INTEGER,
    precision: z.literal("EXACT"),
  }),
  refunds: z.array(REFUND),
});
const READ = z.object({
  shop: z.object({
    currencyCode: z.literal("USD"),
    primaryDomain: z.object({ host: TEXT }),
    transformEnabled: META,
  }),
  order: ORDER.nullable(),
});
const VARIANT = z.object({
  id: TEXT,
  displayName: TEXT,
  title: TEXT,
  sku: z.string().nullable(),
  price: TEXT,
  requiresComponents: z.boolean(),
  availableForSale: z.boolean(),
  inventoryPolicy: z.enum(["DENY", "CONTINUE"]),
  sellableOnlineQuantity: z.number().int().safe(),
  inventoryItem: z.object({
    requiresShipping: z.boolean(),
    tracked: z.boolean(),
  }),
  product: z.object({
    status: TEXT,
    isGiftCard: z.boolean(),
    requiresSellingPlan: z.boolean(),
  }),
  membershipVariant: META,
  planPrices: META,
});
const CALCULATED_DISCOUNT = z.object({
  __typename: z.enum([
    "CalculatedDiscountCodeApplication",
    "CalculatedAutomaticDiscountApplication",
    "CalculatedManualDiscountApplication",
    "CalculatedScriptDiscountApplication",
  ]),
  id: TEXT,
  allocationMethod: TEXT,
  appliedTo: z.enum(["LINE", "ORDER"]),
  targetType: TEXT,
  targetSelection: TEXT,
  description: z.string().nullable(),
  code: TEXT.optional(),
  value: DISCOUNT_VALUE,
});
const CALCULATED_LINE = z.object({
  id: TEXT,
  title: TEXT,
  variantTitle: z.string().nullable(),
  quantity: INTEGER,
  editableQuantityBeforeChanges: INTEGER,
  variant: z.object({ id: TEXT }).nullable(),
  editableSubtotalSet: BAG,
  originalUnitPriceSet: BAG,
  discountedUnitPriceSet: BAG,
  calculatedDiscountAllocations: z.array(
    z.object({
      allocatedAmountSet: BAG,
      discountApplication: CALCULATED_DISCOUNT,
    }),
  ),
});
const CALCULATED = z.object({
  id: TEXT,
  originalOrder: z.object({ id: TEXT }),
  totalPriceSet: BAG,
  totalOutstandingSet: BAG,
  subtotalPriceSet: BAG.nullable(),
  taxLines: z.array(z.object({ priceSet: BAG })),
  shippingLines: z.array(
    z.object({ id: z.string().nullable(), price: BAG, stagedStatus: TEXT }),
  ),
  lineItems: z.object({ nodes: z.array(CALCULATED_LINE), pageInfo: PAGE }),
  addedLineItems: z.object({ nodes: z.array(CALCULATED_LINE), pageInfo: PAGE }),
});
type Calculated = z.infer<typeof CALCULATED>;
const USER_ERRORS = z.array(
  z.object({ message: TEXT, field: z.array(z.string()).nullable().optional() }),
);
const MUTATION = z.object({ userErrors: USER_ERRORS }).passthrough();

export class ShopifyOrderEditProvider implements OrderEditProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(
    private readonly options: {
      credentials: OrderEditCredentialStore;
      clock: () => Date;
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0)
      fail("INVALID_CONFIGURATION", "A positive request timeout is required.");
  }

  async readOrder(
    connectionId: number,
    externalOrderId: string,
  ): Promise<OrderEditSnapshot> {
    const credentials = await this.credentials(connectionId);
    const orderId = gid("Order", externalOrderId);
    const raw = parse(
      READ,
      await this.request(credentials, gql.ORDER_QUERY, { id: orderId }),
    );
    if (!raw.order)
      fail(
        "ORDER_NOT_FOUND",
        "The Shopify order is unavailable on this connection.",
      );
    const order = raw.order;
    if (order.id !== orderId)
      fail("ORDER_IDENTITY_MISMATCH", "Shopify returned a different order.");
    complete(order.lineItems);
    complete(order.discountApplications);
    complete(order.shippingLines);
    if (order.transactionsCount.count !== order.transactions.length)
      fail("INCOMPLETE_ORDER", "The complete payment history is required.");
    const transactions = order.transactions.map(transaction);
    const refunds = order.refunds.map(refund);
    const lines = order.lineItems.nodes.map((line) => ({
      id: gid("LineItem", line.id),
      variantId: line.variant ? gid("ProductVariant", line.variant.id) : "",
      title: line.title,
      variantTitle: line.variantTitle,
      sku: line.sku,
      quantity: line.currentQuantity,
      unfulfilledQuantity: line.unfulfilledQuantity,
      originalUnitPriceCents: money(line.originalUnitPriceSet),
      discountedUnitPriceCents: money(line.discountedUnitPriceSet),
      totalCents: money(line.unfulfilledDiscountedTotalSet),
      discountFingerprint: hash(line.discountAllocations),
      unsupported:
        !line.variant ||
        !line.merchantEditable ||
        !line.requiresShipping ||
        line.isGiftCard ||
        Boolean(line.sellingPlan || line.lineItemGroup),
    }));
    unique(
      lines.map((line) => line.id),
      "line identities",
    );
    unique(
      transactions.map((entry) => entry.id),
      "transaction identities",
    );
    const memberPlan = order.customer?.membershipPlan?.value;
    const memberPricingEnabled =
      (raw.shop.transformEnabled?.value === "true" ||
        order.customer?.tags.includes("cardshellz-test") === true) &&
      !order.customAttributes.some(
        (attribute) =>
          attribute.key === "csz_suppress_member_pricing" &&
          attribute.value === "true",
      );
    const evidence = {
      shippingAddressFingerprint: hash(order.shippingAddress),
      countryCode: order.shippingAddress?.countryCodeV2 ?? null,
      // Preserve the existing fingerprint shape so legacy held edits can be cancelled safely.
      discountApplications: order.discountApplications.nodes.map((entry) =>
        DISCOUNT.parse(entry),
      ),
      unsupportedPaymentTerms:
        order.paymentTerms !== null ||
        order.purchasingEntity?.__typename === "PurchasingCompany" ||
        order.disputes.length > 0,
    };
    const contentFingerprint = hash({
      orderId,
      customerId: order.customer?.id ?? null,
      lines,
      shipping: money(order.currentShippingPriceSet),
      total: money(order.currentTotalPriceSet),
      subtotal: money(order.currentSubtotalPriceSet),
      tax: money(order.currentTotalTaxSet),
      cancelled: order.cancelledAt !== null,
      closed: order.closed,
      evidence,
    });
    const snapshot: OrderEditSnapshot = {
      connectionId,
      channelId: credentials.channelId,
      orderId,
      name: order.name,
      customerId: order.customer?.id ?? null,
      currency: "USD",
      updatedAt: order.updatedAt,
      editable: order.merchantEditable,
      editableErrors: order.merchantEditableErrors,
      cancelled: order.cancelledAt !== null,
      closed: order.closed,
      fullyPaid: order.fullyPaid,
      totalCents: money(order.currentTotalPriceSet),
      outstandingCents: money(order.totalOutstandingSet, true),
      subtotalCents: money(order.currentSubtotalPriceSet),
      taxCents: money(order.currentTotalTaxSet),
      netPaidCents: money(order.netPaymentSet),
      capturableCents: money(order.totalCapturableSet),
      shippingCents: money(order.currentShippingPriceSet),
      paymentUrl: paymentUrl(
        order.paymentCollectionDetails.additionalPaymentCollectionUrl,
        credentials.shopDomain,
        raw.shop.primaryDomain.host,
      ),
      memberPlan: memberPlan && memberPlan !== "none" ? memberPlan : null,
      memberPricingEnabled,
      discountsPresent: order.discountApplications.nodes.length > 0,
      lines,
      transactions,
      refunds,
      contentFingerprint,
      fingerprint: "",
      evidence,
      financials: readOrderFinancials(order),
      discountRules: order.discountApplications.nodes.map((entry) => ({
        index: entry.index,
        type: entry.__typename,
        targetType: entry.targetType,
        allocationMethod: entry.allocationMethod,
        targetSelection: entry.targetSelection,
        label: entry.code ?? entry.title ?? "Discount",
        value:
          entry.value.__typename === "PricingPercentageValue"
            ? {
                type: "percentage" as const,
                percentage: entry.value.percentage,
              }
            : {
                type: "fixed" as const,
                amountCents: money({
                  shopMoney: entry.value,
                  presentmentMoney: entry.value,
                }),
              },
      })),
      paymentDates: Object.fromEntries(
        [
          ...order.transactions,
          ...order.refunds.flatMap((entry) => entry.transactions.nodes),
        ].map((entry) => [entry.id, entry.processedAt]),
      ),
    };
    snapshot.fingerprint = hash({
      contentFingerprint,
      transactions,
      refunds,
      outstanding: snapshot.outstandingCents,
      netPaid: snapshot.netPaidCents,
      capturable: snapshot.capturableCents,
      memberPlan: snapshot.memberPlan,
      memberPricingEnabled,
    });
    return parse(orderEditSnapshotSchema, snapshot);
  }

  async searchVariants(
    connectionId: number,
    search: string,
  ): Promise<OrderEditVariant[]> {
    const term = z
      .string()
      .trim()
      .min(2)
      .max(100)
      .parse(search)
      .replace(/[\\"]/g, "\\$&");
    const data = parse(
      z.object({
        shop: z.object({ currencyCode: z.literal("USD") }),
        productVariants: z.object({ nodes: z.array(VARIANT) }),
      }),
      await this.request(
        await this.credentials(connectionId),
        gql.SEARCH_QUERY,
        {
          query: `product_status:active AND (title:"${term}" OR sku:"${term}")`,
        },
      ),
    );
    return data.productVariants.nodes
      .filter(supportedVariant)
      .map((variant) => ({
        id: variant.id,
        title: variant.displayName,
        sku: variant.sku,
        priceCents: cents(variant.price),
        available: stockAvailable(variant, 1),
        availableQuantity: Math.max(0, variant.sellableOnlineQuantity),
      }));
  }

  async quote(
    connectionId: number,
    snapshot: OrderEditSnapshot,
    plan: OrderEditPlan,
    operationId: string,
  ): Promise<OrderEditQuote> {
    parse(orderEditSnapshotSchema, snapshot);
    validateOperation(operationId);
    validatePlan(plan);
    this.bind(connectionId, snapshot);
    const fresh = await this.readOrder(connectionId, snapshot.orderId);
    if (!unchangedOrderEditSnapshot(fresh, snapshot))
      fail(
        "ORDER_CHANGED",
        "The order changed. Refresh it before preparing an edit.",
      );
    assertEditable(fresh);
    if (
      !fresh.fullyPaid ||
      fresh.outstandingCents !== 0 ||
      fresh.netPaidCents !== fresh.totalCents ||
      fresh.capturableCents !== 0 ||
      unresolved(fresh.transactions)
    ) {
      fail(
        "UNSUPPORTED_PAYMENT_STATE",
        "The pilot requires a fully paid order with no payment in progress.",
      );
    }
    if (fresh.refunds.length > 0)
      fail(
        "EXISTING_REFUND_UNSUPPORTED",
        "Orders with previous refunds require staff review before editing.",
      );
    const pricingProvenance = fresh.discountsPresent
      ? await this.verifyExistingPromotions(connectionId, fresh)
      : null;
    const quote = await this.stage(connectionId, fresh, plan, operationId);
    assertRecoveryLineage(quote);
    // Establish financial eligibility while the order is still unchanged. A
    // successful edit must not discover only afterwards that its refund is unsupported.
    const refundPreflight =
      quote.deltaCents < 0
        ? {
            amountCents: -quote.deltaCents,
            ...(await this.refundMethod(
              connectionId,
              fresh,
              -quote.deltaCents,
            )),
          }
        : null;
    return parse(orderEditQuoteSchema, {
      ...quote,
      evidence: { ...quote.evidence, pricingProvenance, refundPreflight },
    });
  }

  private async stage(
    connectionId: number,
    baseline: OrderEditSnapshot,
    plan: OrderEditPlan,
    operationId: string,
  ): Promise<OrderEditQuote> {
    const credentials = await this.credentials(connectionId);
    if (credentials.channelId !== baseline.channelId)
      fail("CONNECTION_MISMATCH", "The connection's channel changed.");
    // Shopify exposes no original LineItem reference on CalculatedLineItem. Do not manufacture one by replacing GID text.
    unique(
      baseline.lines
        .filter((line) => line.quantity > 0)
        .map((line) =>
          canonicalJson([
            line.variantId,
            line.quantity,
            line.originalUnitPriceCents,
            line.discountedUnitPriceCents,
          ]),
        ),
      "original line identities",
    );
    const byId = new Map(baseline.lines.map((line) => [line.id, line]));
    for (const change of plan.changes) {
      const line = byId.get(gid("LineItem", change.lineItemId));
      if (!line || line.unsupported || line.quantity === 0)
        fail(
          "LINE_EDIT_UNSUPPORTED",
          "Only existing, unfulfilled physical lines can be changed.",
        );
    }
    const demand = additionalDemand(baseline, plan);
    const variants = demand.length
      ? parse(
          z.object({ nodes: z.array(VARIANT.nullable()) }),
          await this.request(credentials, gql.VARIANTS_QUERY, {
            ids: demand.map((line) => line.variantId),
          }),
        ).nodes
      : [];
    const prices = new Map<string, number>();
    for (let index = 0; index < variants.length; index++) {
      const variant = variants[index];
      if (
        !variant ||
        variant.id !== demand[index]?.variantId ||
        !supportedVariant(variant)
      )
        fail(
          "VARIANT_UNSUPPORTED",
          "The selected product cannot be added by this pilot.",
        );
      if (!stockAvailable(variant, demand[index].quantity))
        fail(
          "STOCK_UNAVAILABLE",
          "The selected additional quantity is not currently in stock.",
        );
      prices.set(variant.id, memberPrice(variant, baseline));
    }
    if (variants.length !== demand.length)
      fail(
        "INCOMPLETE_VARIANTS",
        "Shopify did not return every selected product.",
      );
    const begin = await this.mutate(
      credentials,
      gql.BEGIN_MUTATION,
      { id: baseline.orderId },
      "orderEditBegin",
    );
    let calculated = readCalculated(begin.calculatedOrder, baseline.orderId);
    const originalShippingLines = structuredClone(calculated.shippingLines);
    const nativeDiscounts = verifyNativeOrderDiscounts(calculated, baseline);
    const initialFinancials = verifyCalculatedFinancials(calculated, baseline);
    if (
      initialFinancials &&
      (initialFinancials.totalCents !== baseline.totalCents ||
        initialFinancials.itemsNetCents !== baseline.subtotalCents ||
        initialFinancials.taxCents !== baseline.taxCents)
    ) {
      fail(
        "QUOTE_BASELINE_MISMATCH",
        "Shopify's edit baseline does not preserve the original discounts, tax, and total.",
      );
    }
    const sessionId = gid(
      "OrderEditSession",
      parse(z.object({ id: TEXT }), begin.orderEditSession).id,
    );
    const originalCalculated = new Map<
      string,
      z.infer<typeof CALCULATED_LINE>
    >();
    for (const line of baseline.lines.filter((entry) => entry.quantity > 0)) {
      const matches = calculated.lineItems.nodes.filter(
        (candidate) =>
          ![...originalCalculated.values()].some(
            (used) => used.id === candidate.id,
          ) &&
          candidate.variant?.id === line.variantId &&
          candidate.quantity === line.quantity &&
          money(candidate.originalUnitPriceSet) ===
            line.originalUnitPriceCents &&
          money(candidate.discountedUnitPriceSet) ===
            line.discountedUnitPriceCents,
      );
      if (
        matches.length !== 1 ||
        matches[0].quantity !== line.quantity ||
        money(matches[0].originalUnitPriceSet) !==
          line.originalUnitPriceCents ||
        money(matches[0].discountedUnitPriceSet) !==
          line.discountedUnitPriceCents
      )
        fail(
          "LINE_IDENTITY_UNPROVEN",
          "The original and calculated order lines cannot be matched safely.",
        );
      originalCalculated.set(line.id, matches[0]);
      if (
        initialFinancials &&
        initialFinancials.lines.find((entry) => entry.id === matches[0].id)
          ?.netCents !==
          baseline.financials?.lines.find((entry) => entry.id === line.id)
            ?.netCents
      ) {
        fail(
          "QUOTE_BASELINE_MISMATCH",
          "Shopify's edit session changed an original item's discount allocation before any requested changes.",
        );
      }
    }
    if (
      calculated.addedLineItems.nodes.length > 0 ||
      calculated.lineItems.nodes.filter((line) => line.quantity > 0).length !==
        originalCalculated.size
    )
      fail(
        "UNEXPECTED_STAGED_LINES",
        "Shopify returned an unexpected edit baseline.",
      );
    const expected: OrderEditExpectedLine[] = [];
    const stagedPlan = resolveOrderEditLinePlan({
      originals: baseline.lines
        .filter((line) => line.quantity > 0)
        .map(({ id, variantId, quantity }) => ({ id, variantId, quantity })),
      changes: plan.changes.map((change) => ({
        ...change,
        lineItemId: gid("LineItem", change.lineItemId),
      })),
      additions: plan.additions.map((addition) => ({
        ...addition,
        variantId: gid("ProductVariant", addition.variantId),
      })),
      protectedLineIds: [...originalCalculated]
        .filter(([, line]) =>
          line.calculatedDiscountAllocations.some(
            (allocation) =>
              allocation.discountApplication.__typename ===
                "CalculatedAutomaticDiscountApplication" &&
              allocation.discountApplication.targetType === "LINE_ITEM",
          ),
        )
        .map(([id]) => id),
    });
    for (const line of baseline.lines.filter((entry) => entry.quantity > 0)) {
      const calcLine = originalCalculated.get(line.id)!;
      const change = stagedPlan.changes.find(
        (entry) => gid("LineItem", entry.lineItemId) === line.id,
      );
      const quantity = change?.quantity ?? line.quantity;
      if (quantity !== line.quantity) {
        calculated = readCalculated(
          (
            await this.mutate(
              credentials,
              gql.QUANTITY_MUTATION,
              { id: calculated.id, lineItemId: calcLine.id, quantity },
              "orderEditSetQuantity",
            )
          ).calculatedOrder,
          baseline.orderId,
        );
      }
      expected.push({
        title: line.title,
        variantTitle: line.variantTitle,
        originalLineId: line.id,
        calculatedLineId: calcLine.id,
        variantId: line.variantId,
        quantity,
        originalUnitPriceCents: line.originalUnitPriceCents,
        discountedUnitPriceCents: line.discountedUnitPriceCents,
        totalCents: prorateExact(line.totalCents, line.quantity, quantity),
      });
    }
    for (const addition of stagedPlan.additions) {
      const variantId = gid("ProductVariant", addition.variantId);
      const result = await this.mutate(
        credentials,
        gql.ADD_MUTATION,
        { id: calculated.id, variantId, quantity: addition.quantity },
        "orderEditAddVariant",
      );
      calculated = readCalculated(result.calculatedOrder, baseline.orderId);
      const calcId = gid(
        "CalculatedLineItem",
        parse(z.object({ id: TEXT }), result.calculatedLineItem).id,
      );
      const line = calculated.addedLineItems.nodes.find(
        (entry) => entry.id === calcId,
      );
      if (
        !line ||
        line.variant?.id !== variantId ||
        line.quantity !== addition.quantity
      )
        fail(
          "ADDED_LINE_UNPROVEN",
          "Shopify did not return the requested added line.",
        );
      const retail = money(line.originalUnitPriceSet);
      const member = prices.get(variantId)!;
      if (member > retail)
        fail(
          "CONTEXTUAL_PRICE_CHANGED",
          "The contextual price differs from the approved product price.",
        );
      if (addition.quantityIncreaseOfLineId) {
        const original = originalCalculated.get(
          addition.quantityIncreaseOfLineId,
        )!;
        const existingMemberDiscount = sum(
          original.calculatedDiscountAllocations
            .filter(
              (allocation) =>
                allocation.discountApplication.__typename ===
                "CalculatedAutomaticDiscountApplication",
            )
            .map((allocation) => money(allocation.allocatedAmountSet)),
        );
        if (
          !baseline.memberPricingEnabled ||
          !baseline.memberPlan ||
          member >= retail ||
          multiply(retail - member, original.quantity) !==
            existingMemberDiscount
        ) {
          fail(
            "MEMBER_PRICE_CHANGED",
            "The current member price cannot reproduce this original item's pricing. No order change was committed.",
          );
        }
      }
      if (member < retail) {
        calculated = readCalculated(
          (
            await this.mutate(
              credentials,
              gql.DISCOUNT_MUTATION,
              {
                id: calculated.id,
                lineItemId: calcId,
                discount: {
                  description: "Echelon member pricing",
                  fixedValue: {
                    amount: decimal(retail - member),
                    currencyCode: "USD",
                  },
                },
              },
              "orderEditAddLineItemDiscount",
            )
          ).calculatedOrder,
          baseline.orderId,
        );
      }
      expected.push({
        title: line.title,
        variantTitle: line.variantTitle,
        originalLineId: null,
        ...(addition.quantityIncreaseOfLineId
          ? { quantityIncreaseOfLineId: addition.quantityIncreaseOfLineId }
          : {}),
        calculatedLineId: calcId,
        variantId,
        quantity: addition.quantity,
        originalUnitPriceCents: retail,
        discountedUnitPriceCents: member,
        totalCents: multiply(member, addition.quantity),
      });
    }
    verifyCalculated(calculated, expected, baseline);
    verifyPreservedMemberAllocations(calculated, originalCalculated, expected);
    if (
      canonicalJson(calculated.shippingLines) !==
      canonicalJson(originalShippingLines)
    ) {
      fail(
        "SHIPPING_CHANGED",
        "The original shipping lines changed during this edit.",
      );
    }
    verifyNativeOrderDiscounts(calculated, baseline, nativeDiscounts);
    const financials = verifyCalculatedFinancials(calculated, baseline, true);
    const totalCents = money(calculated.totalPriceSet);
    return {
      connectionId,
      channelId: baseline.channelId,
      orderId: baseline.orderId,
      operationId,
      calculatedOrderId: calculated.id,
      sessionId,
      baselineFingerprint: baseline.fingerprint,
      baseline,
      plan: structuredClone(plan),
      lines: expected,
      totalCents,
      financials,
      outstandingCents: money(calculated.totalOutstandingSet, true),
      deltaCents: subtract(totalCents, baseline.totalCents),
      shippingCents: baseline.shippingCents,
      createdAt: this.now().toISOString(),
      evidence: {
        calculated,
        memberPricing: {
          plan: baseline.memberPlan,
          enabled: baseline.memberPricingEnabled,
          variants: variants.map(
            (variant) =>
              variant && {
                id: variant.id,
                retail: variant.price,
                planPrices: variant.planPrices?.value ?? null,
              },
          ),
        },
      },
    };
  }

  private async verifyExistingPromotions(
    connectionId: number,
    snapshot: OrderEditSnapshot,
  ): Promise<Record<string, unknown>> {
    const applications = parse(
      z.array(DISCOUNT),
      snapshot.evidence.discountApplications,
    );
    const itemApplications = applications.filter(
      (entry) => entry.targetType === "LINE_ITEM",
    );
    const nativeCodes = itemApplications.filter(
      (entry) => entry.__typename === "DiscountCodeApplication",
    );
    if (
      applications.some(
        (entry) => !["LINE_ITEM", "SHIPPING_LINE"].includes(entry.targetType),
      ) ||
      itemApplications.some(
        (entry) =>
          ![
            "AutomaticDiscountApplication",
            "DiscountCodeApplication",
            "ManualDiscountApplication",
          ].includes(entry.__typename),
      ) ||
      nativeCodes.some((entry) => {
        const rule = snapshot.discountRules?.find(
          (rule) => rule.index === entry.index,
        );
        return (
          !rule ||
          (rule.value.type === "percentage"
            ? rule.value.percentage <= 0
            : rule.value.amountCents <= 0) ||
          rule.targetSelection !== "ALL" ||
          rule.allocationMethod !== "ACROSS"
        );
      })
    ) {
      fail(
        "PROMOTION_PARITY_UNVERIFIED",
        "This promotion needs staff review. Existing order-wide percentage and fixed credits are supported only when their scope and financial allocations can be verified.",
      );
    }
    const automaticItems = itemApplications.filter(
      (entry) => entry.__typename === "AutomaticDiscountApplication",
    );
    if (automaticItems.length === 0)
      return {
        nativeCodes: nativeCodes.map((entry) => entry.code),
        preservedShippingDiscounts: applications
          .filter((entry) => entry.targetType === "SHIPPING_LINE")
          .map((entry) => entry.title ?? entry.code),
      };
    const provenance = parse(
      z.object({
        currentAppInstallation: z.object({ app: z.object({ id: TEXT }) }),
        shopifyFunctions: z.object({
          nodes: z.array(z.object({ id: TEXT, handle: TEXT })),
          pageInfo: PAGE,
        }),
        discountNodes: z.object({
          nodes: z.array(
            z.object({
              id: TEXT,
              discount: z.object({
                __typename: TEXT,
                title: TEXT,
                status: TEXT,
                discountClasses: z.array(TEXT).optional(),
                appDiscountType: z
                  .object({ functionId: TEXT, app: z.object({ id: TEXT }) })
                  .optional(),
              }),
            }),
          ),
          pageInfo: PAGE,
        }),
      }),
      await this.request(
        await this.credentials(connectionId),
        gql.PRICING_PROVENANCE_QUERY,
        {},
      ),
    );
    complete(provenance.shopifyFunctions);
    complete(provenance.discountNodes);
    const functions = provenance.shopifyFunctions.nodes.filter(
      (entry) => entry.handle === "cardshellz-pricing-discount",
    );
    if (functions.length !== 1)
      fail(
        "MEMBER_FUNCTION_UNPROVEN",
        "The installed member-pricing function could not be identified uniquely.",
      );
    const discounts = provenance.discountNodes.nodes.map(
      (entry) => entry.discount,
    );
    const matching = discounts.filter(
      (entry) =>
        entry.__typename === "DiscountAutomaticApp" &&
        entry.status === "ACTIVE" &&
        entry.appDiscountType?.functionId === functions[0].id &&
        entry.appDiscountType.app.id ===
          provenance.currentAppInstallation.app.id &&
        entry.discountClasses?.length === 1 &&
        entry.discountClasses[0] === "PRODUCT",
    );
    if (
      matching.length !== 1 ||
      automaticItems.some(
        (entry) =>
          ![MEMBER_PRICING_MESSAGE, matching[0].title].includes(
            entry.title ?? "",
          ) ||
          entry.allocationMethod !== "ACROSS" ||
          entry.targetSelection !== "ENTITLED",
      ) ||
      discounts.filter((entry) => entry.title === matching[0].title).length !==
        1
    ) {
      fail(
        "PROMOTION_PARITY_UNVERIFIED",
        "The order's promotion cannot be matched uniquely to the installed member-pricing function.",
      );
    }
    return {
      appId: provenance.currentAppInstallation.app.id,
      functionId: functions[0].id,
      handle: functions[0].handle,
      title: matching[0].title,
      orderMessages: automaticItems.map((entry) => entry.title),
      discountIds: provenance.discountNodes.nodes
        .filter((entry) => entry.discount === matching[0])
        .map((entry) => entry.id),
    };
  }

  async commit(
    connectionId: number,
    quote: OrderEditQuote,
    operationId: string,
  ): Promise<OrderEditSnapshot> {
    return this.applyQuote(connectionId, quote, operationId, "edit");
  }

  private async applyQuote(
    connectionId: number,
    quote: OrderEditQuote,
    operationId: string,
    mode: "edit" | "recovery",
  ): Promise<OrderEditSnapshot> {
    let credentials: OrderEditCredentials;
    try {
      credentials = await this.prepareCommit(
        connectionId,
        quote,
        operationId,
        mode,
      );
    } catch (error) {
      // Only this boundary can prove that no commit request was sent. A rejected
      // response or failed readback after mutate must retain its unknown outcome.
      if (mode === "edit" && error instanceof OrderEditProviderError)
        throw new OrderEditCommitNotSentError(
          error.code,
          error.message,
          error.context,
        );
      throw error;
    }
    const result = await this.mutate(
      credentials,
      gql.COMMIT_MUTATION,
      { id: quote.calculatedOrderId, staffNote: marker(operationId) },
      "orderEditCommit",
    );
    if (parse(z.object({ id: TEXT }), result.order, true).id !== quote.orderId)
      fail(
        "COMMIT_UNCONFIRMED",
        "The saved order identity could not be confirmed.",
        "unknown",
      );
    const observed = await this.readAfterMutation(connectionId, quote.orderId);
    if (!matchesQuote(observed, quote))
      fail(
        "COMMIT_UNCONFIRMED",
        "The saved order does not match the accepted edit. Keep fulfillment on hold.",
        "unknown",
      );
    return observed;
  }

  private async prepareCommit(
    connectionId: number,
    quote: OrderEditQuote,
    operationId: string,
    mode: "edit" | "recovery",
  ): Promise<OrderEditCredentials> {
    this.bindQuote(connectionId, quote, operationId);
    const current = await this.readOrder(connectionId, quote.orderId);
    if (!unchangedOrderEditSnapshot(current, quote.baseline))
      fail("ORDER_CHANGED", "The order changed after the quote was prepared.");
    assertEditable(current);
    if (mode === "edit") {
      assertRecoveryLineage(quote);
      if (quote.deltaCents < 0)
        await this.refundMethod(connectionId, current, -quote.deltaCents);
    }
    const demand = additionalDemand(quote.baseline, quote.plan);
    if (demand.length > 0) {
      const stock = parse(
        z.object({ nodes: z.array(VARIANT.nullable()) }),
        await this.request(
          await this.credentials(connectionId),
          gql.VARIANTS_QUERY,
          { ids: demand.map((entry) => entry.variantId) },
        ),
      ).nodes;
      if (
        stock.length !== demand.length ||
        stock.some(
          (entry, index) =>
            !entry ||
            entry.id !== demand[index].variantId ||
            !supportedVariant(entry) ||
            !stockAvailable(entry, demand[index].quantity),
        )
      )
        fail(
          "STOCK_CHANGED",
          "Stock changed after this edit was quoted. Prepare a new quote.",
        );
    }
    return this.credentials(connectionId);
  }

  async reconcileCommit(
    connectionId: number,
    baseline: OrderEditSnapshot,
    quote: OrderEditQuote,
    operationId: string,
  ) {
    parse(orderEditSnapshotSchema, baseline);
    this.bindQuote(connectionId, quote, operationId);
    this.bind(connectionId, baseline);
    const snapshot = await this.readOrder(connectionId, quote.orderId);
    const status = matchesQuote(snapshot, quote)
      ? ("applied" as const)
      : unchangedOrderEditSnapshot(snapshot, baseline)
        ? ("not_applied" as const)
        : ("conflict" as const);
    // A baseline read is not proof an earlier request cannot finish. The service must not blindly re-commit on not_applied.
    return { status, snapshot };
  }

  async prepareRefund(
    connectionId: number,
    snapshot: OrderEditSnapshot,
    operationId: string,
    idempotencyKey: string,
  ): Promise<OrderEditRefundIntent> {
    parse(orderEditSnapshotSchema, snapshot);
    this.bind(connectionId, snapshot);
    validateOperation(operationId);
    validateOperation(idempotencyKey);
    const current = await this.readOrder(connectionId, snapshot.orderId);
    if (!unchangedOrderEditSnapshot(current, snapshot))
      fail(
        "ORDER_CHANGED",
        "The financial state changed before the refund was prepared.",
      );
    if (
      current.outstandingCents >= 0 ||
      current.capturableCents !== 0 ||
      unresolved(current.transactions)
    )
      fail(
        "REFUND_STATE_UNSUPPORTED",
        "A settled, unambiguous overpayment is required.",
      );
    const amountCents = -current.outstandingCents;
    const method = await this.refundMethod(connectionId, current, amountCents);
    return parse(orderEditRefundIntentSchema, {
      connectionId,
      channelId: current.channelId,
      orderId: current.orderId,
      operationId,
      idempotencyKey,
      currency: "USD",
      amountCents,
      ...method,
      note: marker(operationId),
      contentFingerprint: current.contentFingerprint,
    });
  }

  private async refundMethod(
    connectionId: number,
    current: OrderEditSnapshot,
    amountCents: number,
  ): Promise<{ parentTransactionId: string; gateway: string }> {
    if (
      !Number.isSafeInteger(amountCents) ||
      amountCents <= 0 ||
      current.capturableCents !== 0 ||
      unresolved(current.transactions)
    ) {
      fail(
        "REFUND_STATE_UNSUPPORTED",
        "Automatic settlement requires a settled, unambiguous original payment.",
      );
    }
    const data = parse(
      z.object({
        order: z
          .object({
            id: TEXT,
            suggestedRefund: z
              .object({
                maximumRefundableSet: BAG,
                suggestedTransactions: z.array(
                  z.object({
                    kind: TEXT,
                    gateway: z.string().nullable(),
                    parentTransaction: z.object({ id: TEXT }).nullable(),
                    maximumRefundableSet: BAG.nullable(),
                  }),
                ),
              })
              .nullable(),
          })
          .nullable(),
      }),
      await this.request(
        await this.credentials(connectionId),
        gql.REFUND_CAPACITY_QUERY,
        { id: current.orderId },
      ),
    );
    const suggested = data.order?.suggestedRefund;
    if (
      data.order?.id !== current.orderId ||
      !suggested ||
      money(suggested.maximumRefundableSet) < amountCents
    )
      fail(
        "REFUND_CAPACITY_UNPROVEN",
        "Shopify did not confirm enough refundable original payment.",
      );
    const candidates = suggested.suggestedTransactions.filter(
      (entry) =>
        entry.maximumRefundableSet && money(entry.maximumRefundableSet) > 0,
    );
    if (candidates.length !== 1)
      fail(
        "MULTIPLE_REFUND_TENDERS_UNSUPPORTED",
        "The pilot requires one provable original payment method for automatic refunds.",
      );
    const candidate = candidates[0];
    const parent = current.transactions.find(
      (entry) => entry.id === candidate.parentTransaction?.id,
    );
    if (
      candidate.kind !== "SUGGESTED_REFUND" ||
      !candidate.gateway ||
      !candidate.maximumRefundableSet ||
      money(candidate.maximumRefundableSet) < amountCents ||
      !parent ||
      !["SALE", "CAPTURE"].includes(parent.kind) ||
      parent.status !== "SUCCESS" ||
      parent.manual ||
      /gift.?card|store.?credit|manual/i.test(candidate.gateway) ||
      parent.gateway !== candidate.gateway
    )
      fail(
        "REFUND_METHOD_UNSUPPORTED",
        "The original payment method cannot be refunded automatically with verified evidence.",
      );
    return { parentTransactionId: parent.id, gateway: candidate.gateway };
  }

  async refund(
    connectionId: number,
    intent: OrderEditRefundIntent,
    firstAttemptAt: string,
  ): Promise<OrderEditRefundResult> {
    parse(orderEditRefundIntentSchema, intent);
    this.bind(connectionId, intent);
    validateOperation(intent.operationId);
    validateOperation(intent.idempotencyKey);
    if (
      !Number.isSafeInteger(intent.amountCents) ||
      intent.amountCents <= 0 ||
      intent.currency !== "USD" ||
      intent.note !== marker(intent.operationId)
    )
      fail("REFUND_INTENT_INVALID", "The saved refund intent is invalid.");
    const current = await this.readOrder(connectionId, intent.orderId);
    if (current.channelId !== intent.channelId)
      fail(
        "CONNECTION_MISMATCH",
        "The refund's channel does not match the connection.",
      );
    const matches = current.refunds.filter(
      (entry) => entry.note === intent.note,
    );
    if (matches.length > 1)
      fail(
        "REFUND_AMBIGUOUS",
        "Multiple refunds match this command. Manual reconciliation is required.",
        "unknown",
      );
    if (matches.length === 1) return proveRefund(matches[0], intent);
    const started = Date.parse(firstAttemptAt);
    const age = this.now().getTime() - started;
    if (!Number.isFinite(started) || age < 0 || age >= IDEMPOTENCY_RETENTION_MS)
      fail(
        "REFUND_RETRY_WINDOW_EXPIRED",
        "The refund request must be reconciled manually after Shopify's 24-hour deduplication window.",
        "unknown",
      );
    if (
      current.contentFingerprint !== intent.contentFingerprint ||
      current.outstandingCents !== -intent.amountCents ||
      unresolved(current.transactions)
    )
      fail(
        "REFUND_STATE_CHANGED",
        "The saved refund amount no longer matches the order. Reconciliation is required.",
        "unknown",
      );
    const result = await this.mutate(
      await this.credentials(connectionId),
      gql.REFUND_MUTATION,
      {
        idempotencyKey: intent.idempotencyKey,
        input: {
          orderId: intent.orderId,
          currency: "USD",
          allowOverRefunding: false,
          notify: false,
          note: intent.note,
          // Quantities were changed by orderEditCommit. A monetary settlement must not reduce/restock them again.
          transactions: [
            {
              orderId: intent.orderId,
              parentId: intent.parentTransactionId,
              gateway: intent.gateway,
              kind: "REFUND",
              amount: decimal(intent.amountCents),
            },
          ],
        },
      },
      "refundCreate",
    );
    return proveRefund(refund(parse(REFUND, result.refund, true)), intent);
  }

  async recoverUnpaid(
    connectionId: number,
    baseline: OrderEditSnapshot,
    quote: OrderEditQuote,
    operationId: string,
  ): Promise<OrderEditSnapshot> {
    parse(orderEditSnapshotSchema, baseline);
    this.bindQuote(connectionId, quote, quote.operationId);
    validateOperation(operationId);
    if (
      baseline.fingerprint !== quote.baselineFingerprint ||
      quote.deltaCents <= 0
    )
      fail(
        "RECOVERY_INTENT_INVALID",
        "Only an unpaid increase from the saved baseline can expire.",
      );
    const current = await this.readOrder(connectionId, quote.orderId);
    if (
      !matchesQuote(current, quote) ||
      current.outstandingCents !== quote.deltaCents ||
      current.netPaidCents !== baseline.netPaidCents ||
      hash(current.transactions) !== hash(baseline.transactions) ||
      unresolved(current.transactions) ||
      current.capturableCents !== 0 ||
      hash(current.refunds) !== hash(baseline.refunds)
    )
      fail(
        "EXPIRY_CONFLICT",
        "Payment or order state changed. Keep this order on hold for reconciliation.",
        "unknown",
      );
    assertEditable(current);
    const originalIds = new Set(
      baseline.lines.filter((line) => line.quantity > 0).map((line) => line.id),
    );
    const changes = current.lines
      .filter((line) => line.quantity > 0 || originalIds.has(line.id))
      .map((line) => ({
        lineItemId: line.id,
        quantity:
          baseline.lines.find((original) => original.id === line.id)
            ?.quantity ?? 0,
      }));
    // Compensation restores the saved original prices and quantities, not current catalog pricing.
    const restored = await this.stageRecovery(
      connectionId,
      current,
      baseline,
      changes,
      operationId,
    );
    if (restored.totalCents !== baseline.totalCents)
      fail(
        "EXPIRY_PRICING_CONFLICT",
        "The original price cannot be restored exactly. No compensation was committed.",
        "unknown",
      );
    const observed = await this.applyQuote(
      connectionId,
      restored,
      operationId,
      "recovery",
    );
    if (
      observed.outstandingCents !== 0 ||
      observed.netPaidCents !== baseline.netPaidCents ||
      hash(observed.transactions) !== hash(baseline.transactions)
    ) {
      fail(
        "EXPIRY_PAYMENT_RACE",
        "Payment changed while the expired edit was reverted. Keep fulfillment on hold and reconcile the payment.",
        "unknown",
        { orderId: observed.orderId },
      );
    }
    return observed;
  }

  async reconcileRecovery(
    connectionId: number,
    baseline: OrderEditSnapshot,
    operationId: string,
  ) {
    parse(orderEditSnapshotSchema, baseline);
    this.bind(connectionId, baseline);
    validateOperation(operationId);
    const snapshot = await this.readOrder(connectionId, baseline.orderId);
    return {
      status: isUnpaidRecoveryRestored(snapshot, baseline)
        ? ("restored" as const)
        : ("conflict" as const),
      snapshot,
    };
  }

  private async stageRecovery(
    connectionId: number,
    current: OrderEditSnapshot,
    baseline: OrderEditSnapshot,
    changes: OrderEditPlan["changes"],
    operationId: string,
  ): Promise<OrderEditQuote> {
    const credentials = await this.credentials(connectionId);
    const begin = await this.mutate(
      credentials,
      gql.BEGIN_MUTATION,
      { id: current.orderId },
      "orderEditBegin",
    );
    let calculated = readCalculated(begin.calculatedOrder, current.orderId);
    const originalShippingLines = structuredClone(calculated.shippingLines);
    const nativeDiscounts = verifyNativeOrderDiscounts(calculated, current);
    const initialFinancials = verifyCalculatedFinancials(calculated, current);
    if (
      initialFinancials &&
      !sameFinancialEvidence(initialFinancials, current.financials)
    ) {
      fail(
        "EXPIRY_PRICING_CONFLICT",
        "Shopify's recovery session does not preserve the current financial breakdown.",
        "unknown",
      );
    }
    const expected: OrderEditExpectedLine[] = [];
    const used = new Set<string>();
    for (const change of changes) {
      const original = baseline.lines.find(
        (line) => line.id === change.lineItemId,
      );
      const before = current.lines.find(
        (line) => line.id === change.lineItemId,
      )!;
      // Duplicate variants with different prices/quantities can still be ambiguous. Never use array position or invented IDs.
      const matches = calculated.lineItems.nodes.filter(
        (line) =>
          !used.has(line.id) &&
          line.variant?.id === before.variantId &&
          line.quantity === before.quantity &&
          money(line.originalUnitPriceSet) === before.originalUnitPriceCents &&
          money(line.discountedUnitPriceSet) ===
            before.discountedUnitPriceCents,
      );
      if (matches.length !== 1)
        fail(
          "EXPIRY_LINEAGE_CONFLICT",
          "The expired edit's line identity cannot be restored safely.",
          "unknown",
        );
      const matched = matches[0];
      used.add(matched.id);
      if (change.quantity !== matched.quantity)
        calculated = readCalculated(
          (
            await this.mutate(
              credentials,
              gql.QUANTITY_MUTATION,
              {
                id: calculated.id,
                lineItemId: matched.id,
                quantity: change.quantity,
              },
              "orderEditSetQuantity",
            )
          ).calculatedOrder,
          current.orderId,
        );
      expected.push({
        title: before.title,
        variantTitle: before.variantTitle,
        originalLineId: before.id,
        calculatedLineId: matched.id,
        variantId: before.variantId,
        quantity: change.quantity,
        originalUnitPriceCents:
          original?.originalUnitPriceCents ?? before.originalUnitPriceCents,
        discountedUnitPriceCents:
          original?.discountedUnitPriceCents ?? before.discountedUnitPriceCents,
        totalCents: original?.totalCents ?? 0,
      });
    }
    verifyCalculated(calculated, expected, baseline);
    if (
      canonicalJson(calculated.shippingLines) !==
      canonicalJson(originalShippingLines)
    ) {
      fail(
        "SHIPPING_CHANGED",
        "Shipping changed during payment recovery.",
        "unknown",
      );
    }
    verifyNativeOrderDiscounts(calculated, baseline, nativeDiscounts);
    const financials = verifyCalculatedFinancials(calculated, baseline);
    if (
      financials &&
      (!sameFinancialEvidence(financials, baseline.financials) ||
        expected.some((line) => {
          const wanted =
            baseline.financials?.lines.find(
              (entry) => entry.id === line.originalLineId,
            )?.netCents ?? 0;
          return (
            financials.lines.find((entry) => entry.id === line.calculatedLineId)
              ?.netCents !== wanted
          );
        }))
    ) {
      fail(
        "EXPIRY_PRICING_CONFLICT",
        "The original discounts, shipping, and tax cannot be restored exactly.",
        "unknown",
      );
    }
    return {
      connectionId,
      channelId: current.channelId,
      orderId: current.orderId,
      operationId,
      calculatedOrderId: calculated.id,
      sessionId: gid(
        "OrderEditSession",
        parse(z.object({ id: TEXT }), begin.orderEditSession).id,
      ),
      baselineFingerprint: current.fingerprint,
      baseline: current,
      plan: { changes, additions: [] },
      lines: expected,
      totalCents: money(calculated.totalPriceSet),
      outstandingCents: money(calculated.totalOutstandingSet, true),
      deltaCents: subtract(money(calculated.totalPriceSet), current.totalCents),
      shippingCents: baseline.shippingCents,
      financials,
      createdAt: this.now().toISOString(),
      evidence: { calculated, compensationFor: baseline.orderId },
    };
  }

  private async credentials(
    connectionId: number,
  ): Promise<OrderEditCredentials> {
    if (!Number.isSafeInteger(connectionId) || connectionId <= 0)
      fail("CONNECTION_INVALID", "A specific Shopify connection is required.");
    const value = await this.options.credentials.get(connectionId);
    if (
      !value ||
      value.connectionId !== connectionId ||
      !Number.isSafeInteger(value.channelId) ||
      value.channelId <= 0 ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value.shopDomain) ||
      !value.accessToken.trim()
    )
      fail(
        "CONNECTION_INVALID",
        "The Shopify connection credentials are incomplete or incorrectly scoped.",
      );
    return value;
  }

  private async request(
    credentials: OrderEditCredentials,
    query: string,
    variables: Record<string, unknown>,
    mutation = false,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `https://${credentials.shopDomain}/admin/api/${ORDER_EDIT_SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": credentials.accessToken,
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
          redirect: "error",
        },
      );
      if (!response.ok)
        fail(
          "SHOPIFY_HTTP_ERROR",
          `Shopify returned HTTP ${response.status}.`,
          mutation ? "unknown" : "rejected",
          { status: response.status },
        );
      const graph = parse(
        z.object({
          data: z.unknown().optional(),
          errors: z.array(z.unknown()).optional(),
        }),
        await response.json(),
        mutation,
      );
      if (graph.errors?.length || !graph.data)
        fail(
          "SHOPIFY_GRAPHQL_ERROR",
          "Shopify could not complete this operation.",
          mutation ? "unknown" : "rejected",
        );
      return graph.data;
    } catch (error) {
      if (error instanceof OrderEditProviderError) throw error;
      // Never retry a mutation here: the remote operation may have completed after a timeout or body-read failure.
      fail(
        "SHOPIFY_UNAVAILABLE",
        "Shopify did not return a usable response.",
        mutation ? "unknown" : "rejected",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async mutate(
    credentials: OrderEditCredentials,
    query: string,
    variables: Record<string, unknown>,
    name: string,
  ) {
    const graph = parse(
      z.record(z.unknown()),
      await this.request(credentials, query, variables, true),
      true,
    );
    const payload = parse(MUTATION, graph[name], true);
    if (payload.userErrors.length)
      fail(
        "SHOPIFY_MUTATION_REJECTED",
        payload.userErrors.map((entry) => entry.message).join("; "),
        name === "orderEditCommit" || name === "refundCreate"
          ? "unknown"
          : "rejected",
        { fields: payload.userErrors.map((entry) => entry.field ?? null) },
      );
    return payload;
  }

  private async readAfterMutation(connectionId: number, orderId: string) {
    try {
      return await this.readOrder(connectionId, orderId);
    } catch {
      fail(
        "COMMIT_READBACK_UNAVAILABLE",
        "The edit may be saved, but its state could not be read back. Reconcile before any retry.",
        "unknown",
      );
    }
  }
  private now(): Date {
    const result = this.options.clock();
    if (!Number.isFinite(result.getTime()))
      fail("CLOCK_INVALID", "The supplied clock is invalid.");
    return result;
  }
  private bind(connectionId: number, value: { connectionId: number }) {
    if (value.connectionId !== connectionId)
      fail(
        "CONNECTION_MISMATCH",
        "The saved operation belongs to another Shopify connection.",
      );
  }
  private bindQuote(
    connectionId: number,
    quote: OrderEditQuote,
    operationId: string,
  ) {
    parse(orderEditQuoteSchema, quote);
    this.bind(connectionId, quote);
    validateOperation(operationId);
    if (
      quote.operationId !== operationId ||
      quote.orderId !== quote.baseline.orderId ||
      quote.channelId !== quote.baseline.channelId
    )
      fail(
        "QUOTE_IDENTITY_MISMATCH",
        "The saved quote belongs to another operation.",
      );
  }
}

function fail(
  code: string,
  message: string,
  outcome: "rejected" | "unknown" = "rejected",
  context: Record<string, unknown> = {},
): never {
  throw new OrderEditProviderError(code, message, outcome, context);
}
function parse<T>(schema: z.ZodType<T>, value: unknown, ambiguous = false): T {
  const result = schema.safeParse(value);
  if (!result.success)
    fail(
      "SHOPIFY_RESPONSE_INVALID",
      "Shopify returned incomplete or unsupported data.",
      ambiguous ? "unknown" : "rejected",
      { paths: result.error.issues.map((issue) => issue.path.join(".")) },
    );
  return result.data;
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function paymentUrl(
  value: string | null,
  shopDomain: string,
  primaryDomain: string,
): string | null {
  if (value === null) return null;
  const parsed = new URL(value);
  const permitted = [
    shopDomain.toLowerCase(),
    primaryDomain.toLowerCase(),
    "shopify.com",
    "checkout.shopify.com",
  ];
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !permitted.includes(parsed.hostname.toLowerCase())
  ) {
    fail(
      "PAYMENT_URL_INVALID",
      "Shopify returned a payment link outside the verified shop or Shopify checkout hosts.",
    );
  }
  return parsed.href;
}
function gid(resource: string, value: string): string {
  const id = String(value);
  const prefix = `gid://shopify/${resource}/`;
  if (
    resource === "CalculatedLineItem" &&
    SHOPIFY_CALCULATED_LINE_ID_PATTERN.test(id)
  )
    return id;
  if (/^[1-9]\d*$/.test(id)) return `${prefix}${id}`;
  if (id.startsWith(prefix) && /^[1-9]\d*$/.test(id.slice(prefix.length)))
    return id;
  return fail(
    "SHOPIFY_ID_INVALID",
    `A valid Shopify ${resource} identity is required.`,
  );
}
function cents(value: string, signed = false): number {
  if (!(signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(value))
    fail(
      "MONEY_INVALID",
      "The amount cannot be represented exactly in USD cents.",
    );
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const exact =
    (BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))) *
    BigInt(negative ? -1 : 1);
  if (
    exact > BigInt(Number.MAX_SAFE_INTEGER) ||
    exact < BigInt(Number.MIN_SAFE_INTEGER)
  )
    fail("MONEY_OVERFLOW", "The amount exceeds the safe integer-cents range.");
  return Number(exact);
}
function decimal(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0)
    fail("MONEY_INVALID", "A nonnegative integer-cents amount is required.");
  const exact = BigInt(value);
  return `${exact / BigInt(100)}.${String(exact % BigInt(100)).padStart(2, "0")}`;
}
function money(value: z.infer<typeof BAG>, signed = false): number {
  const presentment = cents(value.presentmentMoney.amount, signed);
  const shop = cents(value.shopMoney.amount, signed);
  if (presentment !== shop)
    fail(
      "CURRENCY_CONVERSION_UNSUPPORTED",
      "Shop and presentment amounts must match for this pilot.",
    );
  return presentment;
}
function subtract(left: number, right: number) {
  const result = left - right;
  if (!Number.isSafeInteger(result))
    fail("MONEY_OVERFLOW", "The money delta exceeds the supported range.");
  return result;
}
function multiply(cents: number, quantity: number) {
  const value = BigInt(cents) * BigInt(quantity);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    fail("MONEY_OVERFLOW", "The line amount exceeds the supported range.");
  return Number(value);
}
function prorateExact(
  total: number,
  originalQuantity: number,
  nextQuantity: number,
): number {
  const numerator = BigInt(total) * BigInt(nextQuantity);
  if (
    originalQuantity <= 0 ||
    numerator % BigInt(originalQuantity) !== BigInt(0)
  )
    fail(
      "DISCOUNT_ROUNDING_UNSUPPORTED",
      "This discount cannot be reduced without changing its original per-unit allocation.",
    );
  const value = numerator / BigInt(originalQuantity);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    fail("MONEY_OVERFLOW", "The line amount exceeds the supported range.");
  return Number(value);
}
function sum(values: number[]) {
  return values.reduce((total, value) => {
    const next = total + value;
    if (!Number.isSafeInteger(next))
      fail("MONEY_OVERFLOW", "The money total exceeds the supported range.");
    return next;
  }, 0);
}
function complete(value: { pageInfo: { hasNextPage: boolean } }) {
  if (value.pageInfo.hasNextPage)
    fail(
      "INCOMPLETE_ORDER",
      "The pilot requires a complete order within Shopify's page limit.",
    );
}
function unique(values: string[], field: string) {
  if (new Set(values).size !== values.length)
    fail("AMBIGUOUS_IDENTITY", `Duplicate ${field} cannot be matched safely.`);
}
function validateOperation(value: string) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(value))
    fail("OPERATION_ID_INVALID", "A stable operation identifier is required.");
}
function marker(value: string) {
  return `Echelon order edit ${value}`;
}
function validatePlan(plan: OrderEditPlan) {
  const parsed = z
    .object({
      changes: z.array(z.object({ lineItemId: TEXT, quantity: INTEGER })),
      additions: z.array(
        z.object({ variantId: TEXT, quantity: INTEGER.positive() }),
      ),
    })
    .strict()
    .safeParse(plan);
  if (
    !parsed.success ||
    plan.changes.length + plan.additions.length === 0 ||
    plan.changes.length + plan.additions.length > MAX_GRAPHQL_INPUTS
  )
    fail(
      "EDIT_PLAN_INVALID",
      "Select valid item quantities within the supported edit limit.",
    );
  unique(
    plan.changes.map((line) => gid("LineItem", line.lineItemId)),
    "changed lines",
  );
  unique(
    plan.additions.map((line) => gid("ProductVariant", line.variantId)),
    "added variants",
  );
}
function transaction(raw: z.infer<typeof TRANSACTION>): OrderEditTransaction {
  return {
    id: gid("OrderTransaction", raw.id),
    parentId: raw.parentTransaction?.id ?? null,
    kind: raw.kind,
    status: raw.status,
    gateway: raw.gateway,
    amountCents: money(raw.amountSet),
    manual: raw.manualPaymentGateway,
  };
}
function refund(raw: z.infer<typeof REFUND>): OrderEditRefund {
  complete(raw.transactions);
  return {
    id: gid("Refund", raw.id),
    note: raw.note,
    amountCents: money(raw.totalRefundedSet),
    transactions: raw.transactions.nodes.map(transaction),
  };
}
function unresolved(transactions: OrderEditTransaction[]) {
  return transactions.some((entry) =>
    ["PENDING", "AWAITING_RESPONSE", "UNKNOWN"].includes(entry.status),
  );
}
function assertEditable(snapshot: OrderEditSnapshot) {
  if (
    !snapshot.editable ||
    snapshot.cancelled ||
    snapshot.closed ||
    snapshot.evidence.countryCode !== "US" ||
    snapshot.evidence.unsupportedPaymentTerms ||
    snapshot.lines.some(
      (line) =>
        line.quantity > 0 &&
        (line.unsupported || line.unfulfilledQuantity !== line.quantity),
    )
  )
    fail(
      "ORDER_EDIT_UNSUPPORTED",
      "Only editable, unfulfilled US physical orders with supported payment terms can use this pilot.",
    );
}
function supportedVariant(variant: z.infer<typeof VARIANT>) {
  return (
    !variant.requiresComponents &&
    variant.inventoryItem.requiresShipping &&
    variant.product.status === "ACTIVE" &&
    !variant.product.isGiftCard &&
    !variant.product.requiresSellingPlan &&
    variant.membershipVariant?.value !== "true"
  );
}
function stockAvailable(variant: z.infer<typeof VARIANT>, quantity: number) {
  return (
    variant.availableForSale &&
    variant.inventoryItem.tracked &&
    variant.inventoryPolicy === "DENY" &&
    variant.sellableOnlineQuantity >= quantity
  );
}
function additionalDemand(
  baseline: OrderEditSnapshot,
  plan: OrderEditPlan,
): Array<{ variantId: string; quantity: number }> {
  const totals = new Map<string, number>();
  const add = (variantId: string, quantity: number) => {
    const next = (totals.get(variantId) ?? 0) + quantity;
    if (!Number.isSafeInteger(next))
      fail(
        "QUANTITY_INVALID",
        "The additional quantity exceeds the supported range.",
      );
    totals.set(variantId, next);
  };
  for (const change of plan.changes) {
    const line = baseline.lines.find(
      (entry) => entry.id === gid("LineItem", change.lineItemId),
    );
    if (!line)
      fail(
        "LINE_EDIT_UNSUPPORTED",
        "The changed line does not belong to this order.",
      );
    if (change.quantity > line.quantity)
      add(
        gid("ProductVariant", line.variantId),
        change.quantity - line.quantity,
      );
  }
  for (const addition of plan.additions)
    add(gid("ProductVariant", addition.variantId), addition.quantity);
  return [...totals].map(([variantId, quantity]) => ({ variantId, quantity }));
}
function memberPrice(
  variant: z.infer<typeof VARIANT>,
  snapshot: OrderEditSnapshot,
): number {
  const retail = cents(variant.price);
  if (
    !snapshot.memberPricingEnabled ||
    !snapshot.memberPlan ||
    !variant.planPrices
  )
    return retail;
  let decoded: unknown;
  try {
    decoded = JSON.parse(variant.planPrices.value);
  } catch {
    return fail(
      "MEMBER_PRICE_INVALID",
      "Member pricing is not valid for this product.",
    );
  }
  const values = parse(z.record(z.object({ cents: INTEGER })), decoded);
  const member = values[snapshot.memberPlan]?.cents;
  return member !== undefined && member < retail ? member : retail;
}
function readCalculated(value: unknown, orderId: string): Calculated {
  const result = parse(CALCULATED, value);
  complete(result.lineItems);
  complete(result.addedLineItems);
  if (result.originalOrder.id !== orderId)
    fail(
      "CALCULATED_ORDER_MISMATCH",
      "The edit session belongs to a different order.",
    );
  return result;
}
function verifyCalculated(
  calculated: Calculated,
  expected: OrderEditExpectedLine[],
  baseline: OrderEditSnapshot,
) {
  const lines = [
    ...calculated.lineItems.nodes,
    ...calculated.addedLineItems.nodes,
  ];
  unique(
    lines.map((line) => line.id),
    "calculated line identities",
  );
  for (const wanted of expected) {
    const actual = lines.find((line) => line.id === wanted.calculatedLineId);
    if (
      !actual ||
      actual.variant?.id !== wanted.variantId ||
      actual.quantity !== wanted.quantity ||
      money(actual.originalUnitPriceSet) !== wanted.originalUnitPriceCents ||
      money(actual.editableSubtotalSet) !== wanted.totalCents ||
      (wanted.quantity > 0 &&
        money(actual.discountedUnitPriceSet) !==
          wanted.discountedUnitPriceCents)
    )
      fail(
        "QUOTE_PRICE_MISMATCH",
        "Shopify's quote changed an item or price outside the requested edit.",
      );
  }
  if (
    lines.some(
      (line) =>
        line.quantity > 0 &&
        !expected.some((entry) => entry.calculatedLineId === line.id),
    ) ||
    !expected.some((line) => line.quantity > 0)
  )
    fail(
      "QUOTE_ITEMS_MISMATCH",
      "The quote contains unexpected items or would empty the order.",
    );
  const shippingLinePrice = sum(
    calculated.shippingLines.map((line) => money(line.price)),
  );
  // CalculatedShippingLine.price is before discounts; the order total uses net shipping.
  if (
    shippingLinePrice !==
    (baseline.financials?.shippingGrossCents ?? baseline.shippingCents)
  )
    fail(
      "SHIPPING_CHANGED",
      "The original shipping amount could not be preserved.",
    );
  if (
    money(calculated.totalOutstandingSet, true) !==
    subtract(money(calculated.totalPriceSet), baseline.netPaidCents)
  )
    fail(
      "QUOTE_BALANCE_MISMATCH",
      "The quote's balance does not match the original settled payment.",
    );
}
function readOrderFinancials(
  order: z.infer<typeof ORDER>,
): OrderEditFinancials {
  if (order.taxesIncluded && money(order.currentTotalTaxSet) > 0) {
    fail(
      "TAX_INCLUDED_UNSUPPORTED",
      "Tax-inclusive orders need staff review because current per-line tax allocations cannot be verified by this editor.",
    );
  }
  const shipping = order.shippingLines.nodes.filter((line) => !line.isRemoved);
  const activeDiscountIndexes = new Set(
    order.lineItems.nodes
      .filter((line) => line.currentQuantity > 0)
      .flatMap((line) =>
        line.discountAllocations
          .filter((allocation) => money(allocation.allocatedAmountSet) > 0)
          .map((allocation) => allocation.discountApplication.index),
      ),
  );
  if (
    sum(shipping.map((line) => money(line.currentDiscountedPriceSet))) !==
    money(order.currentShippingPriceSet)
  ) {
    fail(
      "SHIPPING_TOTAL_UNVERIFIED",
      "The current shipping lines do not match the order's shipping total.",
    );
  }
  return buildOrderEditFinancials({
    lines: order.lineItems.nodes.map((line) => ({
      id: line.id,
      grossCents: multiply(
        money(line.originalUnitPriceSet),
        line.currentQuantity,
      ),
      // Unlike discountAllocations, this excludes quantities removed by earlier edits.
      netCents: money(line.priceAfterAllDiscountsBeforeTaxesSet),
    })),
    itemsNetCents: money(order.currentSubtotalPriceSet),
    itemDiscounts: readOrderItemDiscounts(order),
    itemDiscountLabels: order.discountApplications.nodes
      .filter(
        (entry) =>
          entry.targetType === "LINE_ITEM" &&
          activeDiscountIndexes.has(entry.index),
      )
      .map((entry) => entry.code ?? entry.title ?? "Discount"),
    shippingGrossCents: sum(
      shipping.map((line) => money(line.originalPriceSet)),
    ),
    shippingCents: money(order.currentShippingPriceSet),
    shippingDiscountLabels: order.discountApplications.nodes
      .filter((entry) => entry.targetType === "SHIPPING_LINE")
      .map((entry) => entry.code ?? entry.title ?? "Shipping discount"),
    taxCents: money(order.currentTotalTaxSet),
    taxesIncluded: order.taxesIncluded,
    totalCents: money(order.currentTotalPriceSet),
  });
}

function sameFinancialEvidence(
  actual: OrderEditFinancials,
  expected: OrderEditFinancials | undefined,
): boolean {
  if (!expected) return false;
  // Calculated and original line IDs differ; compare allocations separately through their proven lineage.
  const { lines: actualLines, ...actualTotals } = actual;
  const { lines: expectedLines, ...expectedTotals } = expected;
  if (!expected.itemDiscounts) delete actualTotals.itemDiscounts;
  return canonicalJson(actualTotals) === canonicalJson(expectedTotals);
}

function discountKey(label: string): string {
  return `code:${label}`;
}
function sortDiscounts(discounts: OrderEditDiscount[]): OrderEditDiscount[] {
  return [...discounts].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
}
function productDiscount(amountCents: number): OrderEditDiscount {
  return {
    key: "product",
    label: "Product discounts",
    amountCents,
    value: { type: "allocated" },
  };
}
function readOrderItemDiscounts(
  order: z.infer<typeof ORDER>,
): OrderEditDiscount[] | undefined {
  unique(
    order.discountApplications.nodes.map((entry) => String(entry.index)),
    "discount application indexes",
  );
  const applications = new Map(
    order.discountApplications.nodes.map((entry) => [entry.index, entry]),
  );
  const amounts = new Map<number, number>();
  let currentAllocations = true;
  for (const line of order.lineItems.nodes.filter(
    (entry) => entry.currentQuantity > 0,
  )) {
    const allocated = sum(
      line.discountAllocations.map((allocation) =>
        money(allocation.allocatedAmountSet),
      ),
    );
    const gross = multiply(
      money(line.originalUnitPriceSet),
      line.currentQuantity,
    );
    // Shopify can retain the original allocation after a previous edit removes
    // quantity. Only current, per-line reconciled evidence may name credit amounts.
    if (allocated !== gross - money(line.priceAfterAllDiscountsBeforeTaxesSet))
      currentAllocations = false;
    for (const allocation of line.discountAllocations) {
      const application = applications.get(
        allocation.discountApplication.index,
      );
      if (!application || application.targetType !== "LINE_ITEM")
        fail(
          "DISCOUNT_EVIDENCE_CONFLICT",
          "An item discount references an unknown or non-item application.",
        );
      amounts.set(
        application.index,
        sum([
          amounts.get(application.index) ?? 0,
          money(allocation.allocatedAmountSet),
        ]),
      );
    }
  }
  const gross = sum(
    order.lineItems.nodes.map((line) =>
      multiply(money(line.originalUnitPriceSet), line.currentQuantity),
    ),
  );
  // Original allocations can include quantities removed by earlier edits.
  // Keep their labels, but never manufacture a current per-code money amount.
  if (
    !currentAllocations ||
    sum([...amounts.values()]) !== gross - money(order.currentSubtotalPriceSet)
  )
    return undefined;
  const discounts: OrderEditDiscount[] = [];
  let productCents = 0;
  for (const [index, amountCents] of amounts) {
    const application = applications.get(index)!;
    if (
      application.__typename === "DiscountCodeApplication" &&
      application.targetSelection === "ALL" &&
      application.allocationMethod === "ACROSS"
    ) {
      if (!application.code?.trim())
        fail(
          "DISCOUNT_EVIDENCE_CONFLICT",
          "An item discount code is missing its original identity.",
        );
      discounts.push({
        key: discountKey(application.code),
        label: application.code,
        amountCents,
        value:
          application.value.__typename === "PricingPercentageValue"
            ? {
                type: "percentage",
                percentage: new Decimal(application.value.percentage).toFixed(),
              }
            : { type: "fixed", amountCents: cents(application.value.amount) },
      });
    } else productCents = sum([productCents, amountCents]);
  }
  if (productCents > 0) discounts.push(productDiscount(productCents));
  unique(
    discounts.map((discount) => discount.key),
    "discount display identities",
  );
  return sortDiscounts(discounts);
}

/** Shopify reports function PRODUCT allocations as appliedTo ORDER, excluding them from editableSubtotalSet. */
function automaticProductOrderAmounts(
  calculated: Calculated,
  baseline: OrderEditSnapshot,
): Map<string, number> {
  const rules = (baseline.discountRules ?? []).filter(
    (rule) =>
      rule.type === "AutomaticDiscountApplication" &&
      rule.targetType === "LINE_ITEM",
  );
  const amounts = new Map<string, number>();
  for (const line of [
    ...calculated.lineItems.nodes,
    ...calculated.addedLineItems.nodes,
  ].filter((line) => line.quantity > 0)) {
    const automatic = line.calculatedDiscountAllocations.filter(
      (allocation) =>
        allocation.discountApplication.__typename ===
        "CalculatedAutomaticDiscountApplication",
    );
    for (const allocation of automatic) {
      const application = allocation.discountApplication;
      const matches = rules.filter(
        (rule) =>
          rule.label === application.description &&
          rule.allocationMethod === application.allocationMethod &&
          rule.targetSelection === application.targetSelection &&
          rule.targetType === application.targetType &&
          rule.value.type === "fixed" &&
          application.value.__typename === "MoneyV2" &&
          rule.value.amountCents === cents(application.value.amount),
      );
      if (matches.length !== 1)
        fail(
          "PROMOTION_PARITY_UNVERIFIED",
          "The calculated member-pricing discount does not match the original promotion.",
        );
    }
    amounts.set(
      line.id,
      sum(
        automatic
          .filter(
            (allocation) =>
              allocation.discountApplication.appliedTo === "ORDER",
          )
          .map((allocation) => money(allocation.allocatedAmountSet)),
      ),
    );
  }
  return amounts;
}

function verifyPreservedMemberAllocations(
  calculated: Calculated,
  originals: Map<string, z.infer<typeof CALCULATED_LINE>>,
  expected: OrderEditExpectedLine[],
): void {
  const actual = [
    ...calculated.lineItems.nodes,
    ...calculated.addedLineItems.nodes,
  ];
  for (const line of expected.filter((line) => line.quantity > 0)) {
    const before = line.originalLineId
      ? originals.get(line.originalLineId)
      : undefined;
    const automatic = (entry: z.infer<typeof CALCULATED_LINE>) =>
      entry.calculatedDiscountAllocations.filter(
        (allocation) =>
          allocation.discountApplication.__typename ===
          "CalculatedAutomaticDiscountApplication",
      );
    const wanted = before ? automatic(before) : [];
    const observed = automatic(
      actual.find((entry) => entry.id === line.calculatedLineId)!,
    );
    if (
      wanted.length !== observed.length ||
      wanted.some((allocation) => {
        const matching = observed.filter(
          (entry) =>
            canonicalJson(entry.discountApplication) ===
            canonicalJson(allocation.discountApplication),
        );
        return (
          matching.length !== 1 ||
          money(matching[0].allocatedAmountSet) !==
            prorateExact(
              money(allocation.allocatedAmountSet),
              before!.quantity,
              line.quantity,
            )
        );
      })
    )
      fail(
        "PROMOTION_PARITY_UNVERIFIED",
        "Shopify changed an original member-pricing allocation during the edit.",
      );
  }
}

function priceCalculatedOrderDiscounts(
  calculated: Calculated,
  baseline: OrderEditSnapshot,
) {
  const rules = (baseline.discountRules ?? []).filter(
    (rule) =>
      rule.type === "DiscountCodeApplication" &&
      rule.targetType === "LINE_ITEM",
  );
  const lines = [
    ...calculated.lineItems.nodes,
    ...calculated.addedLineItems.nodes,
  ].filter((line) => line.quantity > 0);
  const automaticProducts = automaticProductOrderAmounts(calculated, baseline);
  const observations = lines.flatMap((line) =>
    line.calculatedDiscountAllocations
      .filter(
        (allocation) =>
          allocation.discountApplication.appliedTo === "ORDER" &&
          allocation.discountApplication.__typename !==
            "CalculatedAutomaticDiscountApplication",
      )
      .map((allocation) => {
        const application = allocation.discountApplication;
        if (
          application.__typename !== "CalculatedDiscountCodeApplication" ||
          !application.code
        )
          fail(
            "PROMOTION_PARITY_UNVERIFIED",
            "An unverified order discount appeared in Shopify's edit session.",
          );
        return {
          lineId: line.id,
          ruleKey: discountKey(application.code),
          amountCents: money(allocation.allocatedAmountSet),
        };
      }),
  );
  const result = priceOrderEditDiscounts({
    rules: rules.map((rule) => ({
      key: discountKey(rule.label),
      label: rule.label,
      value:
        rule.value.type === "percentage"
          ? {
              type: "percentage" as const,
              percentage: new Decimal(rule.value.percentage).toFixed(),
            }
          : { type: "fixed" as const, amountCents: rule.value.amountCents },
    })),
    lines: lines.map((line) => ({
      id: line.id,
      subtotalCents: subtract(
        money(line.editableSubtotalSet),
        automaticProducts.get(line.id) ?? 0,
      ),
    })),
    observations,
  });
  if (
    !calculated.subtotalPriceSet ||
    result.subtotalAfterOrderDiscountsCents !==
      money(calculated.subtotalPriceSet)
  )
    fail(
      "ORDER_EDIT_DISCOUNT_SUBTOTAL_MISMATCH",
      "The verified discounts do not reconcile to Shopify's revised item subtotal.",
    );
  const productCents = sum(
    lines.map((line) => {
      const gross = multiply(money(line.originalUnitPriceSet), line.quantity);
      const afterProduct = money(line.editableSubtotalSet);
      const allocations = sum(
        line.calculatedDiscountAllocations
          .filter(
            (allocation) => allocation.discountApplication.appliedTo === "LINE",
          )
          .map((allocation) => money(allocation.allocatedAmountSet)),
      );
      if (afterProduct > gross || gross - afterProduct !== allocations)
        fail(
          "ORDER_EDIT_PRODUCT_DISCOUNT_MISMATCH",
          "The product discount allocations do not match the eligible item subtotal.",
        );
      return sum([allocations, automaticProducts.get(line.id) ?? 0]);
    }),
  );
  return {
    ...result,
    discounts: sortDiscounts([
      ...result.discounts,
      ...(productCents > 0 ? [productDiscount(productCents)] : []),
    ]),
  };
}

function calculatedPromotions(
  calculated: Calculated,
): Array<z.infer<typeof CALCULATED_DISCOUNT>> {
  const applications = new Map<string, z.infer<typeof CALCULATED_DISCOUNT>>();
  for (const line of [
    ...calculated.lineItems.nodes,
    ...calculated.addedLineItems.nodes,
  ]) {
    if (line.quantity === 0) continue;
    for (const allocation of line.calculatedDiscountAllocations) {
      const application = allocation.discountApplication;
      const previous = applications.get(application.id);
      if (previous && canonicalJson(previous) !== canonicalJson(application)) {
        fail(
          "DISCOUNT_EVIDENCE_CONFLICT",
          "Shopify returned contradictory discount evidence.",
        );
      }
      applications.set(application.id, application);
    }
  }
  return [...applications.values()];
}

/** Preserve the original native rule; neither a coupon nor a reward is redeemed twice. */
function verifyNativeOrderDiscounts(
  calculated: Calculated,
  baseline: OrderEditSnapshot,
  expectedIds?: string[],
): string[] {
  const rules = (baseline.discountRules ?? []).filter(
    (rule) =>
      rule.type === "DiscountCodeApplication" &&
      rule.targetType === "LINE_ITEM",
  );
  const applications = calculatedPromotions(calculated);
  const ids = rules.map((rule) => {
    const matching = applications.filter(
      (entry) =>
        entry.__typename === "CalculatedDiscountCodeApplication" &&
        entry.code === rule.label &&
        entry.appliedTo === "ORDER" &&
        entry.targetType === "LINE_ITEM" &&
        entry.targetSelection === "ALL" &&
        entry.allocationMethod === "ACROSS" &&
        (rule.value.type === "percentage"
          ? entry.value.__typename === "PricingPercentageValue" &&
            entry.value.percentage === rule.value.percentage
          : entry.value.__typename === "MoneyV2" &&
            cents(entry.value.amount) === rule.value.amountCents),
    );
    if (matching.length !== 1) {
      fail(
        "PROMOTION_PARITY_UNVERIFIED",
        `Shopify did not preserve the ${rule.label} order discount uniquely.`,
      );
    }
    return matching[0].id;
  });
  unique(ids, "native order discount identities");
  if (expectedIds && canonicalJson(ids) !== canonicalJson(expectedIds)) {
    fail(
      "PROMOTION_PARITY_UNVERIFIED",
      "An order discount changed during the edit.",
    );
  }
  return ids;
}

function verifyCalculatedFinancials(
  calculated: Calculated,
  baseline: OrderEditSnapshot,
  requireSettledFixedCredit = false,
): OrderEditFinancials | undefined {
  // Legacy persisted operations retain their existing proof contract during recovery.
  if (!baseline.financials) return undefined;
  if (!calculated.subtotalPriceSet)
    fail(
      "QUOTE_SUBTOTAL_MISSING",
      "Shopify did not return a complete financial quote.",
    );
  const lines = [
    ...calculated.lineItems.nodes,
    ...calculated.addedLineItems.nodes,
  ];
  const discounts = priceCalculatedOrderDiscounts(calculated, baseline);
  if (requireSettledFixedCredit && discounts.unusedFixedCredits.length > 0)
    fail(
      "ORDER_EDIT_FIXED_CREDIT_SETTLEMENT_REQUIRED",
      "This edit would leave part of a fixed credit unused. Its original redemption must be reconciled before the edit can be applied.",
    );
  // Product allocations and an order-level discount summary have different
  // scopes (shipping is separate). Reconcile every product allocation to
  // subtotalPriceSet, then shipping and tax to totalPriceSet; native discount
  // identity/rule parity is checked separately by verifyNativeOrderDiscounts.
  return buildOrderEditFinancials({
    lines: lines.map((line) => {
      const grossCents = multiply(
        money(line.originalUnitPriceSet),
        line.quantity,
      );
      const discountCents =
        line.quantity === 0
          ? 0
          : sum(
              line.calculatedDiscountAllocations.map((allocation) => {
                if (allocation.discountApplication.targetType !== "LINE_ITEM")
                  fail(
                    "DISCOUNT_TARGET_UNVERIFIED",
                    "Shopify returned a discount on an unexpected target.",
                  );
                return money(allocation.allocatedAmountSet);
              }),
            );
      return { id: line.id, grossCents, netCents: grossCents - discountCents };
    }),
    itemsNetCents: money(calculated.subtotalPriceSet),
    itemDiscounts: discounts.discounts,
    itemDiscountLabels: [
      ...baseline.financials.itemDiscountLabels,
      ...calculatedPromotions(calculated)
        .filter((entry) => entry.description === "Echelon member pricing")
        .map((entry) => entry.description!),
    ],
    shippingGrossCents: baseline.financials.shippingGrossCents,
    shippingCents: baseline.shippingCents,
    shippingDiscountLabels: [...baseline.financials.shippingDiscountLabels],
    taxCents: sum(calculated.taxLines.map((line) => money(line.priceSet))),
    taxesIncluded: baseline.financials.taxesIncluded,
    totalCents: money(calculated.totalPriceSet),
  });
}

function assertRecoveryLineage(quote: OrderEditQuote): void {
  if (quote.deltaCents <= 0) return;
  if (
    quote.lines.some(
      (line) =>
        line.originalLineId !== null &&
        line.quantity === 0 &&
        quote.baseline.lines.some(
          (original) =>
            original.id === line.originalLineId && original.quantity > 0,
        ),
    )
  )
    fail(
      "EXPIRY_LINEAGE_UNSUPPORTED",
      "An unpaid edit cannot completely remove an original item because restoring its original line identity is not proven. Keep at least one unit or complete a separate staff edit.",
    );
  // A new edit session has no original-line reference. Its exact matching key
  // must uniquely identify each line if an unpaid edit later needs compensation.
  const keys = quote.lines.map((line) =>
    JSON.stringify([
      line.variantId,
      line.quantity,
      line.originalUnitPriceCents,
      line.discountedUnitPriceCents,
    ]),
  );
  if (new Set(keys).size !== keys.length) {
    fail(
      "EXPIRY_LINEAGE_UNSUPPORTED",
      "These same-product quantities cannot be distinguished safely if payment expires. Use a different added quantity or ask staff to handle this edit.",
    );
  }
}
function proveRefund(
  actual: OrderEditRefund,
  intent: OrderEditRefundIntent,
): OrderEditRefundResult {
  if (
    actual.note !== intent.note ||
    actual.amountCents !== intent.amountCents ||
    actual.transactions.length !== 1
  )
    fail(
      "REFUND_UNCONFIRMED",
      "The refund record does not match the saved request.",
      "unknown",
    );
  const entry = actual.transactions[0];
  if (
    entry.kind !== "REFUND" ||
    entry.parentId !== intent.parentTransactionId ||
    entry.gateway !== intent.gateway ||
    entry.amountCents !== intent.amountCents
  )
    fail(
      "REFUND_UNCONFIRMED",
      "The refund transaction does not match the saved payment evidence.",
      "unknown",
    );
  if (["FAILURE", "ERROR"].includes(entry.status))
    fail(
      "REFUND_FAILED",
      "Shopify recorded a failed refund. Manual reconciliation is required.",
      "unknown",
      { refundId: actual.id, transactionId: entry.id },
    );
  return {
    status: entry.status === "SUCCESS" ? "succeeded" : "pending",
    refundId: actual.id,
    evidence: actual,
  };
}
