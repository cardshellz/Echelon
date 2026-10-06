import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { matchesOrderEditFinancials } from "../domain/order-edit-financials";
import type {
  OrderEditSnapshot,
  OrderEditQuote,
  OrderEditTransaction,
} from "./order-edit-provider";
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function unresolved(transactions: OrderEditTransaction[]): boolean {
  return transactions.some((entry) =>
    ["PENDING", "AWAITING_RESPONSE", "UNKNOWN"].includes(entry.status),
  );
}
/** Extra pricing evidence stays outside the legacy identity hash, but new operations must still compare it. */
export function unchangedOrderEditSnapshot(
  actual: OrderEditSnapshot,
  expected: OrderEditSnapshot,
): boolean {
  return (
    actual.fingerprint === expected.fingerprint &&
    (!expected.financials ||
      (actual.financials !== undefined &&
        canonicalJson(actual.financials) ===
          canonicalJson(expected.financials))) &&
    (!expected.discountRules ||
      (actual.discountRules !== undefined &&
        canonicalJson(actual.discountRules) ===
          canonicalJson(expected.discountRules)))
  );
}
function preservesRecoveryDiscountRules(
  observed: OrderEditSnapshot,
  baseline: OrderEditSnapshot,
): boolean {
  if (!baseline.discountRules) return true;
  if (!observed.discountRules) return false;
  const wanted = new Set(
    baseline.discountRules.map((rule) => canonicalJson(rule)),
  );
  const actual = new Set(
    observed.discountRules.map((rule) => canonicalJson(rule)),
  );
  if ([...wanted].some((rule) => !actual.has(rule))) return false;
  const originalIds = new Set(baseline.lines.map((line) => line.id));
  const historicalAddedLine = observed.lines.some(
    (line) => line.quantity === 0 && !originalIds.has(line.id),
  );
  // A removed added line remains in Shopify, together with its manually applied member discount.
  // Exact active-line amounts and quantities are verified separately before restoration is accepted.
  return observed.discountRules.every(
    (rule) =>
      wanted.has(canonicalJson(rule)) ||
      (historicalAddedLine &&
        rule.type === "ManualDiscountApplication" &&
        rule.targetType === "LINE_ITEM" &&
        rule.label === "Echelon member pricing"),
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
            rule.type === "DiscountCodeApplication" ||
            rule.targetType === "SHIPPING_LINE",
        )
        .some(
          (rule) =>
            !snapshot.discountRules?.some(
              (observed) => canonicalJson(observed) === canonicalJson(rule),
            ),
        )) ||
    snapshot.shippingCents !== quote.shippingCents ||
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
          : !originalIds.has(line.id) && line.variantId === expected.variantId),
    );
    if (candidates.length !== 1) return false;
    const line = candidates[0];
    used.add(line.id);
    if (
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
/** A removed added line remains in Shopify at quantity zero. It must not prevent proving the original order was restored. */
export function isUnpaidRecoveryRestored(
  observed: OrderEditSnapshot,
  baseline: OrderEditSnapshot,
): boolean {
  if (
    observed.orderId !== baseline.orderId ||
    observed.channelId !== baseline.channelId ||
    observed.connectionId !== baseline.connectionId ||
    observed.customerId !== baseline.customerId ||
    observed.totalCents !== baseline.totalCents ||
    observed.shippingCents !== baseline.shippingCents ||
    observed.subtotalCents !== baseline.subtotalCents ||
    observed.taxCents !== baseline.taxCents ||
    !matchesOrderEditFinancials(observed.financials, baseline.financials) ||
    !preservesRecoveryDiscountRules(observed, baseline) ||
    observed.outstandingCents !== 0 ||
    observed.netPaidCents !== baseline.netPaidCents ||
    observed.capturableCents !== 0 ||
    observed.cancelled ||
    observed.closed ||
    unresolved(observed.transactions) ||
    hash(observed.transactions) !== hash(baseline.transactions) ||
    hash(observed.refunds) !== hash(baseline.refunds) ||
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
            entry.discountedUnitPriceCents === line.discountedUnitPriceCents &&
            entry.totalCents === line.totalCents,
        ) &&
        (!baseline.financials ||
          observed.financials?.lines.find((entry) => entry.id === line.id)
            ?.netCents ===
            baseline.financials.lines.find((entry) => entry.id === line.id)
              ?.netCents),
    )
  );
}
