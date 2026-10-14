/** Intl supplies currency punctuation; integer cents retain every digit. */
export function formatIntegerCents(
  cents: number,
  currency: string,
  locale = "en-US",
): string {
  if (!Number.isSafeInteger(cents) || !/^[A-Z]{3}$/.test(currency))
    throw new RangeError("Invalid integer currency amount.");
  const amount = BigInt(cents);
  const whole = amount / BigInt(100);
  const fraction = ((amount < BigInt(0) ? -amount : amount) % BigInt(100))
    .toString()
    .padStart(2, "0");
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Negative sub-dollar values need Intl's negative-zero sign convention.
  const displayWhole = whole === BigInt(0) && amount < BigInt(0) ? -0 : whole;
  return formatter
    .formatToParts(displayWhole)
    .map((part) => (part.type === "fraction" ? fraction : part.value))
    .join("");
}
