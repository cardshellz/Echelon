const wholeDollars = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

/** The account contract is USD. Keep even the display conversion exact at the
 * maximum supported integer cents; no floating-point dollars are introduced. */
export function formatAccountUsdCents(totalCents: number): string {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0)
    throw new RangeError("ACCOUNT_DISPLAY_MONEY_INVALID");
  const amount = BigInt(totalCents);
  const centsPerDollar = BigInt(100);
  const dollars = wholeDollars.format(amount / centsPerDollar);
  const fractional = (amount % centsPerDollar).toString().padStart(2, "0");
  return `$${dollars}.${fractional}`;
}
