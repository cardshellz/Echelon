import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  orderEditFinancialsSchema,
  type OrderEditFinancials,
} from "@shared/order-edits/order-edit-financials";
import { OrderEditError } from "../domain/order-edit-error";
import {
  matchesOrderEditFinancials,
  equivalentOrderEditFinancialEvidence,
} from "../domain/order-edit-financials";
import type {
  OrderEditSnapshot,
  OrderEditQuote,
  OrderEditTransaction,
  OrderEditRefund,
} from "./order-edit-provider";
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
/** Shopify renumbers application indexes after an edit. The index binds an
 * allocation within one response; it is not a promotion's durable identity. */
function discountRuleIdentity(
  rule: NonNullable<OrderEditSnapshot["discountRules"]>[number],
): string {
  const { index: _index, ...terms } = rule;
  return canonicalJson(terms);
}
/** A previous edit's removed rows remain in Shopify. They are not part of a
 * new quote; omit only rows proven to carry no gross, discount or net amount.
 * The provider separately verifies that every active native row is expected. */
export function financialsForQuotedLines(
  financials: OrderEditFinancials | undefined,
  lines: OrderEditQuote["lines"],
): OrderEditFinancials | undefined {
  if (!financials) return undefined;
  const expected = new Set(lines.map((line) => line.calculatedLineId));
  if (
    expected.size !== lines.length ||
    financials.lines.some(
      (line) =>
        !expected.has(line.id) &&
        (line.grossCents !== 0 ||
          line.discountCents !== 0 ||
          line.netCents !== 0),
    ) ||
    lines.some(
      (line) =>
        !financials.lines.some((entry) => entry.id === line.calculatedLineId),
    )
  )
    throw new OrderEditError(
      "QUOTE_FINANCIAL_LINE_MISMATCH",
      "The quote contains unexpected item amounts.",
    );
  return orderEditFinancialsSchema.parse({
    ...financials,
    lines: financials.lines.filter((line) => expected.has(line.id)),
  });
}
function matchesShippingService(
  snapshot: OrderEditSnapshot,
  title: string,
): boolean {
  return (
    snapshot.shippingContext?.lines.length === 1 &&
    snapshot.shippingContext.lines[0].title === title
  );
}
function shippingAmounts(snapshot: OrderEditSnapshot) {
  return snapshot.shippingContext?.lines.map(
    ({ title, grossCents, netCents }) => ({ title, grossCents, netCents }),
  );
}
/** Shopify can restore a replaced shipping charge as a custom net fee, with the original benefit retained in the audit record. */
export function recoveryFinancials(
  baseline: OrderEditSnapshot,
  quote?: OrderEditQuote,
) {
  if (!shippingWasReplaced(quote) || !baseline.financials)
    return baseline.financials;
  return {
    ...baseline.financials,
    shippingGrossCents: baseline.shippingCents,
    shippingDiscountCents: 0,
    shippingDiscountLabels: [],
  };
}
export function shippingWasReplaced(quote?: OrderEditQuote): boolean {
  return Boolean(
    quote?.shippingRepricing &&
      quote.baseline.shippingContext?.lines.length === 1 &&
      (quote.shippingCents !== quote.baseline.shippingCents ||
        quote.shippingRepricing.title !==
          quote.baseline.shippingContext.lines[0].title),
  );
}
function unresolved(transactions: OrderEditTransaction[]): boolean {
  return transactions.some((entry) =>
    ["PENDING", "AWAITING_RESPONSE", "UNKNOWN"].includes(entry.status),
  );
}
/** Shopify creates zero-value, transaction-free refund records for an order
 * edit's bookkeeping (observed with shipping replacement). Keep those records
 * in the snapshot/audit, but do not mistake them for payment movement.
 * Existing records must remain identical. New refund intents, any amount, or
 * any transaction (including zero/pending) still prevent unpaid recovery. */
export function unchangedOrderEditRefundPayments(
  actual: OrderEditRefund[],
  baseline: OrderEditRefund[],
): boolean {
  const before = new Map(baseline.map((refund) => [refund.id, refund]));
  const after = new Map(actual.map((refund) => [refund.id, refund]));
  if (before.size !== baseline.length || after.size !== actual.length)
    return false;
  return (
    baseline.every(
      (refund) =>
        after.has(refund.id) &&
        canonicalJson(after.get(refund.id)) === canonicalJson(refund),
    ) &&
    actual.every(
      (refund) =>
        before.has(refund.id) ||
        (refund.note === null &&
          refund.amountCents === 0 &&
          refund.transactions.length === 0),
    )
  );
}
/** Extra pricing evidence stays outside the legacy identity hash, but new operations must still compare it. */
export function unchangedOrderEditSnapshot(
  actual: OrderEditSnapshot,
  expected: OrderEditSnapshot,
): boolean {
  return (
    actual.fingerprint === expected.fingerprint &&
    equivalentOrderEditFinancialEvidence(
      actual.financials,
      expected.financials,
    ) &&
    (!expected.discountRules ||
      (actual.discountRules !== undefined &&
        canonicalJson(actual.discountRules) ===
          canonicalJson(expected.discountRules))) &&
    (!expected.shippingContext ||
      canonicalJson(actual.shippingContext) ===
        canonicalJson(expected.shippingContext))
  );
}
function preservesRecoveryDiscountRules(
  observed: OrderEditSnapshot,
  baseline: OrderEditSnapshot,
  shippingReplaced = false,
  codeRecovery?: OrderEditQuote,
): boolean {
  if (!baseline.discountRules) return true;
  if (!observed.discountRules) return false;
  const wanted = new Set(
    baseline.discountRules
      .filter(
        (rule) =>
          (!shippingReplaced || rule.targetType !== "SHIPPING_LINE") &&
          !(
            codeRecovery?.codePricing &&
            rule.targetType === "LINE_ITEM" &&
            (rule.type === "ManualDiscountApplication" ||
              (rule.type === "AutomaticDiscountApplication" &&
                !codeRecovery.codePricing.lines.some(
                  (line) => line.preserveAutomaticDiscount,
                )))
          ),
      )
      .map(discountRuleIdentity),
  );
  const actual = new Set(observed.discountRules.map(discountRuleIdentity));
  if ([...wanted].some((rule) => !actual.has(rule))) return false;
  const originalIds = new Set(baseline.lines.map((line) => line.id));
  const historicalAddedLine = observed.lines.some(
    (line) => line.quantity === 0 && !originalIds.has(line.id),
  );
  // A removed added line remains in Shopify, together with its manually applied member discount.
  // Exact active-line amounts and quantities are verified separately before restoration is accepted.
  return observed.discountRules.every(
    (rule) =>
      wanted.has(discountRuleIdentity(rule)) ||
      (shippingReplaced &&
        rule.targetType === "SHIPPING_LINE" &&
        baseline.discountRules?.some(
          (original) =>
            discountRuleIdentity(original) === discountRuleIdentity(rule),
        )) ||
      (historicalAddedLine &&
        rule.type === "ManualDiscountApplication" &&
        rule.targetType === "LINE_ITEM" &&
        rule.label === "Echelon member pricing") ||
      (Boolean(codeRecovery?.codePricing) &&
        rule.targetType === "LINE_ITEM" &&
        ((rule.type === "AutomaticDiscountApplication" &&
          baseline.discountRules?.some(
            (original) =>
              discountRuleIdentity(original) === discountRuleIdentity(rule),
          )) ||
          (rule.type === "ManualDiscountApplication" &&
            [
              "Echelon member pricing",
              baseline.codePricing?.description,
              codeRecovery?.codePricing?.description,
            ].includes(rule.label)))),
  );
}

/** Cancelling an unsubmitted edit never rolls back fulfillment performed outside that edit. */
export function unchangedFulfilledOrderEdit(
  current: OrderEditSnapshot,
  baseline: OrderEditSnapshot,
): boolean {
  const active = current.lines.filter((line) => line.quantity > 0);
  if (
    !active.length ||
    active.some((line) => line.unfulfilledQuantity !== 0) ||
    current.cancelled ||
    !current.fullyPaid ||
    current.outstandingCents !== 0 ||
    current.netPaidCents !== current.totalCents ||
    current.capturableCents !== 0 ||
    unresolved(current.transactions)
  )
    return false;
  // Only fulfillment/closure and the legacy unfulfilled-line total may differ.
  // Purchased quantities, prices, discount allocation identities, address, tender,
  // and any new exact financial evidence must still match the original order.
  const identity = (snapshot: OrderEditSnapshot) => ({
    connectionId: snapshot.connectionId,
    channelId: snapshot.channelId,
    orderId: snapshot.orderId,
    customerId: snapshot.customerId,
    currency: snapshot.currency,
    cancelled: snapshot.cancelled,
    totalCents: snapshot.totalCents,
    subtotalCents: snapshot.subtotalCents,
    taxCents: snapshot.taxCents,
    shippingCents: snapshot.shippingCents,
    netPaidCents: snapshot.netPaidCents,
    outstandingCents: snapshot.outstandingCents,
    capturableCents: snapshot.capturableCents,
    fullyPaid: snapshot.fullyPaid,
    memberPlan: snapshot.memberPlan,
    memberPricingEnabled: snapshot.memberPricingEnabled,
    evidence: snapshot.evidence,
    transactions: snapshot.transactions,
    refunds: snapshot.refunds,
    lines: snapshot.lines
      .map(({ unfulfilledQuantity, totalCents, unsupported, ...line }) => line)
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
  return (
    canonicalJson(identity(current)) === canonicalJson(identity(baseline)) &&
    equivalentOrderEditFinancialEvidence(
      current.financials,
      baseline.financials,
    ) &&
    (!baseline.discountRules ||
      (current.discountRules !== undefined &&
        canonicalJson(current.discountRules) ===
          canonicalJson(baseline.discountRules))) &&
    (!baseline.shippingContext ||
      canonicalJson(current.shippingContext) ===
        canonicalJson(baseline.shippingContext))
  );
}

export function matchesOrderEditQuote(
  snapshot: OrderEditSnapshot,
  quote: OrderEditQuote,
): boolean {
  if (
    snapshot.orderId !== quote.orderId ||
    snapshot.channelId !== quote.channelId ||
    snapshot.connectionId !== quote.connectionId ||
    snapshot.customerId !== quote.baseline.customerId ||
    snapshot.cancelled ||
    snapshot.closed ||
    snapshot.totalCents !== quote.totalCents ||
    !matchesOrderEditFinancials(snapshot.financials, quote.financials) ||
    (quote.financials &&
      (quote.baseline.discountRules ?? [])
        .filter(
          (rule) =>
            (!shippingWasReplaced(quote) ||
              rule.targetType !== "SHIPPING_LINE") &&
            (rule.type === "DiscountCodeApplication" ||
              (rule.type === "AutomaticDiscountApplication" &&
                !(
                  rule.targetType === "LINE_ITEM" &&
                  (quote.codePricing ||
                    quote.evidence.codeDiscountRecovery === true) &&
                  !quote.codePricing?.lines.some(
                    (line) => line.preserveAutomaticDiscount,
                  )
                )) ||
              rule.targetType === "SHIPPING_LINE"),
        )
        .some(
          (rule) =>
            !snapshot.discountRules?.some(
              (observed) =>
                discountRuleIdentity(observed) === discountRuleIdentity(rule),
            ),
        )) ||
    snapshot.shippingCents !== quote.shippingCents ||
    (quote.shippingRepricing &&
      quote.baseline.shippingContext &&
      !matchesShippingService(snapshot, quote.shippingRepricing.title)) ||
    snapshot.evidence.shippingAddressFingerprint !==
      quote.baseline.evidence.shippingAddressFingerprint
  )
    return false;
  const originalIds = new Set(quote.baseline.lines.map((line) => line.id));
  const used = new Set<string>();
  for (const expected of quote.lines) {
    const candidates = snapshot.lines.filter(
      (line) =>
        !used.has(line.id) &&
        (expected.originalLineId
          ? line.id === expected.originalLineId
          : !originalIds.has(line.id) &&
            line.variantId === expected.variantId &&
            (!quote.codePricing ||
              (line.quantity === expected.quantity &&
                line.originalUnitPriceCents ===
                  expected.originalUnitPriceCents &&
                line.totalCents === expected.totalCents))),
    );
    if (!candidates.length || (candidates.length !== 1 && !quote.codePricing))
      return false;
    const line = candidates.sort((a, b) => a.id.localeCompare(b.id))[0];
    used.add(line.id);
    const preservedAutomatic = quote.codePricing?.lines.find(
      (entry) => entry.id === expected.calculatedLineId,
    )?.preserveAutomaticDiscount;
    const preservedNative = quote.codePricing?.lines.find(
      (entry) => entry.id === expected.calculatedLineId,
    )?.nativeDiscountCents;
    if (
      (preservedNative &&
        (!expected.originalLineId ||
          !preservesNativeOrderEditLine(
            snapshot,
            quote.baseline,
            expected.originalLineId,
            expected.quantity,
          ))) ||
      (preservedAutomatic &&
        (!expected.originalLineId ||
          !preservesAutomaticOrderEditLine(
            snapshot,
            quote.baseline,
            expected.originalLineId,
            expected.quantity,
          ))) ||
      line.variantId !== expected.variantId ||
      line.title !== expected.title ||
      line.variantTitle !== expected.variantTitle ||
      line.quantity !== expected.quantity ||
      line.originalUnitPriceCents !== expected.originalUnitPriceCents ||
      line.totalCents !== expected.totalCents ||
      (quote.financials &&
        snapshot.financials?.lines.find((entry) => entry.id === line.id)
          ?.netCents !==
          quote.financials.lines.find(
            (entry) => entry.id === expected.calculatedLineId,
          )?.netCents) ||
      (line.quantity > 0 &&
        line.discountedUnitPriceCents !== expected.discountedUnitPriceCents) ||
      line.unfulfilledQuantity !== line.quantity
    )
      return false;
  }
  return !snapshot.lines.some(
    (line) => line.quantity > 0 && !used.has(line.id),
  );
}

/** Bind preserved automatic pricing to the original native line, rule identities and exact allocation. */
export function preservesAutomaticOrderEditLine(
  current: OrderEditSnapshot,
  baseline: OrderEditSnapshot,
  originalId: string,
  quantity: number,
): boolean {
  const original = baseline.lines.find((line) => line.id === originalId);
  const observed = current.lines.find((line) => line.id === originalId);
  const before = baseline.previewProductDiscounts?.find(
    (line) => line.lineId === originalId,
  );
  const after = current.previewProductDiscounts?.find(
    (line) => line.lineId === originalId,
  );
  const rules = baseline.discountRules?.filter(
    (rule) =>
      rule.type === "AutomaticDiscountApplication" &&
      rule.targetType === "LINE_ITEM",
  );
  if (
    !original ||
    !observed ||
    !before ||
    !after ||
    !rules?.length ||
    original.quantity < 1 ||
    before.automaticCents <= 0 ||
    observed.quantity !== quantity
  )
    return false;
  return (
    observed.variantId === original.variantId &&
    observed.originalUnitPriceCents === original.originalUnitPriceCents &&
    BigInt(after.automaticCents) * BigInt(original.quantity) ===
      BigInt(before.automaticCents) * BigInt(quantity) &&
    BigInt(after.amountCents) * BigInt(original.quantity) ===
      BigInt(before.amountCents) * BigInt(quantity) &&
    rules.every((rule) =>
      current.discountRules?.some(
        (entry) => discountRuleIdentity(entry) === discountRuleIdentity(rule),
      ),
    )
  );
}
/** A used checkout reward stays on the same original row at its original allocation. */
export function preservesNativeOrderEditLine(
  current: OrderEditSnapshot,
  baseline: OrderEditSnapshot,
  lineId: string,
  quantity: number,
): boolean {
  const original = baseline.lines.find((line) => line.id === lineId);
  const observed = current.lines.find((line) => line.id === lineId);
  const before =
    baseline.nativeDiscountAllocations?.filter(
      (allocation) => allocation.lineId === lineId,
    ) ?? [];
  const after =
    current.nativeDiscountAllocations?.filter(
      (allocation) => allocation.lineId === lineId,
    ) ?? [];
  if (
    !original ||
    !observed ||
    original.quantity <= 0 ||
    observed.quantity !== quantity ||
    observed.variantId !== original.variantId ||
    observed.originalUnitPriceCents !== original.originalUnitPriceCents ||
    !before.some((allocation) => allocation.amountCents > 0) ||
    new Set(before.map((allocation) => allocation.ruleKey)).size !==
      before.length ||
    new Set(after.map((allocation) => allocation.ruleKey)).size !==
      after.length ||
    before.length !== after.length
  )
    return false;
  return (
    before.every((allocation) =>
      after.some(
        (retained) =>
          retained.ruleKey === allocation.ruleKey &&
          BigInt(retained.amountCents) * BigInt(original.quantity) ===
            BigInt(allocation.amountCents) * BigInt(quantity),
      ),
    ) &&
    (baseline.discountRules ?? [])
      .filter(
        (rule) =>
          rule.type === "DiscountCodeApplication" &&
          rule.targetType === "LINE_ITEM",
      )
      .every((rule) =>
        current.discountRules?.some(
          (entry) => discountRuleIdentity(entry) === discountRuleIdentity(rule),
        ),
      )
  );
}

function recoveredLinePriceMatches(
  current: OrderEditSnapshot,
  baseline: OrderEditSnapshot,
  original: OrderEditSnapshot["lines"][number],
  observed: OrderEditSnapshot["lines"][number],
  quote?: OrderEditQuote,
): boolean {
  const preservedAutomatic = quote?.codePricing?.lines.some(
    (line) => line.sourceId === original.id && line.preserveAutomaticDiscount,
  );
  const preservedNative = quote?.codePricing?.lines.some(
    (line) => line.sourceId === original.id && line.nativeDiscountCents,
  );
  if (!quote?.codePricing || preservedAutomatic || preservedNative)
    return (
      observed.discountedUnitPriceCents === original.discountedUnitPriceCents &&
      observed.totalCents === original.totalCents &&
      (!preservedNative ||
        preservesNativeOrderEditLine(
          current,
          baseline,
          original.id,
          original.quantity,
        )) &&
      (!preservedAutomatic ||
        preservesAutomaticOrderEditLine(
          current,
          baseline,
          original.id,
          original.quantity,
        ))
    );

  // Legacy/manual code edits restore the original net price using a manual
  // adjustment. Preserved automatic lines retain their native raw fields.
  const financial = baseline.financials?.lines.find(
    (line) => line.id === original.id,
  );
  return Boolean(
    financial &&
      BigInt(observed.discountedUnitPriceCents) * BigInt(original.quantity) ===
        BigInt(financial.netCents) &&
      observed.totalCents === financial.netCents,
  );
}

/** A removed added line remains in Shopify at quantity zero. It must not prevent proving the original order was restored. */
export function isUnpaidRecoveryRestored(
  observed: OrderEditSnapshot,
  baseline: OrderEditSnapshot,
  originalQuote?: OrderEditQuote,
): boolean {
  const replaced = shippingWasReplaced(originalQuote);
  const financials = recoveryFinancials(baseline, originalQuote);
  if (
    originalQuote &&
    originalQuote.baselineFingerprint !== baseline.fingerprint
  )
    return false;
  if (
    observed.orderId !== baseline.orderId ||
    observed.channelId !== baseline.channelId ||
    observed.connectionId !== baseline.connectionId ||
    observed.customerId !== baseline.customerId ||
    observed.totalCents !== baseline.totalCents ||
    observed.shippingCents !== baseline.shippingCents ||
    (baseline.shippingContext &&
      canonicalJson(shippingAmounts(observed)) !==
        canonicalJson(
          replaced
            ? baseline.shippingContext.lines.map((line) => ({
                title: line.title,
                grossCents: baseline.shippingCents,
                netCents: baseline.shippingCents,
              }))
            : shippingAmounts(baseline),
        )) ||
    observed.subtotalCents !== baseline.subtotalCents ||
    observed.taxCents !== baseline.taxCents ||
    !matchesOrderEditFinancials(observed.financials, financials) ||
    !preservesRecoveryDiscountRules(
      observed,
      baseline,
      replaced,
      originalQuote?.codePricing ? originalQuote : undefined,
    ) ||
    observed.outstandingCents !== 0 ||
    observed.netPaidCents !== baseline.netPaidCents ||
    observed.capturableCents !== 0 ||
    observed.cancelled ||
    observed.closed ||
    unresolved(observed.transactions) ||
    hash(observed.transactions) !== hash(baseline.transactions) ||
    !unchangedOrderEditRefundPayments(observed.refunds, baseline.refunds) ||
    observed.evidence.shippingAddressFingerprint !==
      baseline.evidence.shippingAddressFingerprint
  )
    return false;
  const wanted = baseline.lines.filter((line) => line.quantity > 0);
  const actual = observed.lines.filter((line) => line.quantity > 0);
  return (
    wanted.length === actual.length &&
    wanted.every(
      (line) =>
        actual.some(
          (entry) =>
            entry.id === line.id &&
            entry.variantId === line.variantId &&
            entry.title === line.title &&
            entry.variantTitle === line.variantTitle &&
            entry.quantity === line.quantity &&
            entry.unfulfilledQuantity === line.unfulfilledQuantity &&
            entry.originalUnitPriceCents === line.originalUnitPriceCents &&
            recoveredLinePriceMatches(
              observed,
              baseline,
              line,
              entry,
              originalQuote,
            ),
        ) &&
        (!baseline.financials ||
          observed.financials?.lines.find((entry) => entry.id === line.id)
            ?.netCents ===
            baseline.financials.lines.find((entry) => entry.id === line.id)
              ?.netCents),
    )
  );
}
