import {
  shopifyDiscountEvidenceSchema,
  type ShopifyDiscountEvidence,
} from "../../../shared/shopify-discount-evidence";

type RecordValue = Record<string, unknown>;
const MAX_ITEMS = 10000;
const MAX_APPLICATIONS = 1000;
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const CENTS_PER_UNIT = BigInt(100);
// This version handles only explicitly supported two-decimal currencies.
const SUPPORTED_CURRENCIES = new Set(["USD", "CAD", "EUR", "GBP"]);
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
function decimalCents(value: unknown): bigint | null {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,2})?$/.test(value)
  )
    return null;
  const [whole, fraction = ""] = value.split(".");
  const cents =
    BigInt(whole) * CENTS_PER_UNIT + BigInt(fraction.padEnd(2, "0"));
  return cents <= MAX_CENTS ? cents : null;
}
function descriptor(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 500
    ? value
    : null;
}

/** Optional original Shopify snapshot evidence. No inferred membership tiers,
 * nominal application values, current prices, refund deductions, or IO. Invalid
 * target allocations suppress that entire target's amounts, avoiding plausible
 * but incomplete discount subtotals. "complete" describes extraction only. */
export function extractShopifyDiscountEvidence(
  rawPayload: unknown,
  orderCurrency: unknown,
): ShopifyDiscountEvidence | undefined {
  if (typeof orderCurrency !== "string" || !/^[A-Z]{3}$/.test(orderCurrency))
    return undefined;
  const envelope = record(rawPayload);
  const raw = record(envelope?.order) ?? envelope;
  const issues = new Set<string>();
  const result: ShopifyDiscountEvidence = {
    version: 1,
    provider: "shopify",
    currency: orderCurrency,
    status: "unavailable",
    grossMerchandiseCents: null,
    merchandiseDiscountCents: null,
    shippingDiscountCents: null,
    applications: [],
    issues: [],
  };
  if (!SUPPORTED_CURRENCIES.has(orderCurrency))
    issues.add("UNSUPPORTED_CURRENCY");
  if (!raw || raw.currency !== orderCurrency)
    issues.add("MISSING_OR_MISMATCHED_CURRENCY");
  if (issues.size)
    return shopifyDiscountEvidenceSchema.parse({
      ...result,
      issues: [...issues],
    });

  const lines =
    Array.isArray(raw!.line_items) && raw!.line_items.length <= MAX_ITEMS
      ? raw!.line_items
      : null;
  if (!lines?.length) issues.add("MISSING_MERCHANDISE_LINES");
  else {
    let gross = BigInt(0);
    let valid = true;
    for (const item of lines) {
      const line = record(item);
      const price = decimalCents(line?.price);
      const quantity = line?.quantity;
      if (
        price === null ||
        typeof quantity !== "number" ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0
      ) {
        valid = false;
        break;
      }
      gross += price * BigInt(quantity);
      if (gross > MAX_CENTS) {
        valid = false;
        break;
      }
    }
    if (valid) result.grossMerchandiseCents = Number(gross);
    else issues.add("INVALID_MERCHANDISE_PRICE_OR_QUANTITY");
  }
  const applications =
    Array.isArray(raw!.discount_applications) &&
    raw!.discount_applications.length <= MAX_APPLICATIONS
      ? raw!.discount_applications
      : null;
  if (!applications) issues.add("MISSING_DISCOUNT_APPLICATIONS");
  const shipping =
    Array.isArray(raw!.shipping_lines) &&
    raw!.shipping_lines.length <= MAX_ITEMS
      ? raw!.shipping_lines
      : null;
  const extractTarget = (
    target: "merchandise" | "shipping",
    rows: unknown[] | null,
  ): number | null => {
    if (!rows || (target === "merchandise" && rows.length === 0)) {
      issues.add(`MISSING_${target.toUpperCase()}_ALLOCATIONS`);
      return null;
    }
    if (!applications) return null;
    const groups = new Map<
      number,
      { cents: bigint; application: RecordValue }
    >();
    let total = BigInt(0);
    let valid = true;
    for (const item of rows) {
      const allocations = record(item)?.discount_allocations;
      if (
        !Array.isArray(allocations) ||
        allocations.length > MAX_APPLICATIONS
      ) {
        valid = false;
        break;
      }
      const seenIndexes = new Set<number>();
      for (const allocationValue of allocations) {
        const allocation = record(allocationValue);
        const amount = decimalCents(allocation?.amount);
        const index = allocation?.discount_application_index;
        const application =
          typeof index === "number" && Number.isSafeInteger(index) && index >= 0
            ? record(applications[index])
            : null;
        const expectedTarget =
          target === "merchandise" ? "line_item" : "shipping_line";
        if (
          amount === null ||
          !application ||
          typeof application.type !== "string" ||
          !application.type.trim() ||
          application.type.length > 80 ||
          application.target_type !== expectedTarget
        ) {
          valid = false;
          break;
        }
        if (
          (application.code != null && descriptor(application.code) === null) ||
          (application.title != null && descriptor(application.title) === null)
        ) {
          valid = false;
          break;
        }
        const numericIndex = index as number;
        if (seenIndexes.has(numericIndex)) {
          valid = false;
          break;
        }
        seenIndexes.add(numericIndex);
        const cents = (groups.get(numericIndex)?.cents ?? BigInt(0)) + amount;
        total += amount;
        if (cents > MAX_CENTS || total > MAX_CENTS) {
          valid = false;
          break;
        }
        groups.set(numericIndex, { cents, application });
      }
      if (!valid) break;
    }
    if (!valid) {
      issues.add(`INVALID_${target.toUpperCase()}_ALLOCATIONS`);
      return null;
    }
    for (const [index, group] of groups)
      result.applications.push({
        key: `${index}:${target}`,
        type: group.application.type as string,
        code: descriptor(group.application.code),
        title: descriptor(group.application.title),
        target,
        amountCents: Number(group.cents),
      });
    return Number(total);
  };
  result.merchandiseDiscountCents = extractTarget("merchandise", lines);
  result.shippingDiscountCents = extractTarget("shipping", shipping);
  if (
    result.grossMerchandiseCents !== null &&
    result.merchandiseDiscountCents !== null &&
    result.merchandiseDiscountCents > result.grossMerchandiseCents
  ) {
    issues.add("MERCHANDISE_DISCOUNT_EXCEEDS_GROSS");
    result.merchandiseDiscountCents = null;
    result.applications = result.applications.filter(
      (application) => application.target !== "merchandise",
    );
  }
  result.issues = [...issues];
  result.status =
    issues.size === 0
      ? "complete"
      : [
            result.grossMerchandiseCents,
            result.merchandiseDiscountCents,
            result.shippingDiscountCents,
          ].some((value) => value !== null)
        ? "partial"
        : "unavailable";
  return shopifyDiscountEvidenceSchema.parse(result);
}
