import { dollarsToCents, MoneyInputError } from "@shared/utils/money";

/** Parse decimal input without rounding, coercing blank values, or floating-point arithmetic. */
export function parseExactMoneyInput(raw: string, precision: 2 | 4, allowNegative = false): number {
  const value = raw.trim();
  const sign = allowNegative ? "-?" : "";
  const pattern = new RegExp(`^${sign}(?:\\d+(?:\\.\\d{1,${precision}})?|\\.\\d{1,${precision}})$`);
  if (!pattern.test(value)) {
    throw new Error(`Enter ${allowNegative ? "an" : "a nonnegative"} amount with at most ${precision} decimal places.`);
  }
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const magnitude = BigInt(whole || "0") * BigInt(precision === 2 ? 100 : 10000)
    + BigInt(fraction.padEnd(precision, "0"));
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The amount exceeds the supported limit.");
  return Number(negative ? -magnitude : magnitude);
}

export function exactMoneyAsInput(value: number | bigint, precision: 2 | 4): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Recorded amount is invalid.");
  const amount = BigInt(value);
  const magnitude = amount < BigInt(0) ? -amount : amount;
  const scale = BigInt(precision === 2 ? 100 : 10000);
  return `${amount < BigInt(0) ? "-" : ""}${magnitude / scale}.${String(magnitude % scale).padStart(precision, "0")}`;
}


export type DollarInputResult =
  | { valid: true; cents: number }
  | { valid: false; code: "MONEY_INPUT_INVALID" | "MONEY_INPUT_OVERFLOW"; message: string };

/** Preserve the established dollar-form policy (including signed amounts and
 * truncation), while making its declared RangeError failures safe to display.
 * Unexpected programmer errors still propagate to the caller. */
export function evaluateDollarInput(raw: string): DollarInputResult {
  try {
    return { valid: true, cents: dollarsToCents(raw) };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const code = error instanceof MoneyInputError ? error.code : "MONEY_INPUT_INVALID";
    return {
      valid: false,
      code,
      message: code === "MONEY_INPUT_OVERFLOW"
        ? "The amount exceeds the supported limit. Enter a smaller dollar amount."
        : "Enter a valid dollar amount.",
    };
  }
}
