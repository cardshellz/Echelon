import { OrderEditProviderError } from "../application/order-edit-provider";

/** Shopify decimals must be exactly representable; never round money while reading it. */
export function cents(value: string, signed = false): number {
  if (!(signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(value))
    throw new OrderEditProviderError(
      "MONEY_INVALID",
      "The amount cannot be represented exactly in USD cents.",
      "rejected",
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
    throw new OrderEditProviderError(
      "MONEY_OVERFLOW",
      "The amount exceeds the safe integer-cents range.",
      "rejected",
    );
  return Number(exact);
}
