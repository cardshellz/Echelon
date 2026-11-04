import { OrderEditProviderError } from "../application/order-edit-provider";
import { parseDecimalCents, MoneyInputError } from "@shared/money-read";

/** Shopify decimals must be exactly representable; never round money while reading it. */
export function cents(value: string, signed = false): number {
  try {
    return parseDecimalCents(value, "Shopify amount", signed);
  } catch (error) {
    if (!(error instanceof MoneyInputError)) throw error;
    throw new OrderEditProviderError(
      error.code === "MONEY_INPUT_OVERFLOW" ? "MONEY_OVERFLOW" : "MONEY_INVALID",
      error.code === "MONEY_INPUT_OVERFLOW"
        ? "The amount exceeds the safe integer-cents range."
        : "The amount cannot be represented exactly in USD cents.",
      "rejected",
    );
  }
}

/** Exact USD bag used by both order commands and saved account facts. */
export function shopifyMoneyBagCents(value: { presentmentMoney: { amount: string; currencyCode: "USD" }; shopMoney: { amount: string; currencyCode: "USD" } }, signed = false): number {
  const presentment = cents(value.presentmentMoney.amount, signed);
  const shop = cents(value.shopMoney.amount, signed);
  if (presentment !== shop) throw new OrderEditProviderError("CURRENCY_CONVERSION_UNSUPPORTED", "Shop and presentment amounts must match for this pilot.", "rejected");
  return presentment;
}
