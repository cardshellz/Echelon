import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
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
    wanted.every((line) =>
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
      ),
    )
  );
}
