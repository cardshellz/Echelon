import { MAX_ORDER_EDIT_PAYMENT_WINDOW_MINUTES } from "@shared/order-edits/order-edit.contract";

export const ORDER_EDIT_MINUTES_PER_HOUR = 60;
export const MIN_ORDER_EDIT_PAYMENT_WINDOW_HOURS =
  1 / ORDER_EDIT_MINUTES_PER_HOUR;
export const MAX_ORDER_EDIT_PAYMENT_WINDOW_HOURS =
  MAX_ORDER_EDIT_PAYMENT_WINDOW_MINUTES / ORDER_EDIT_MINUTES_PER_HOUR;

// Accept only floating-point representation error, never round a requested duration.
const MINUTE_REPRESENTATION_TOLERANCE = 1e-9;
const DECIMAL_HOURS = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** The existing API stores whole minutes; hours are an admin display/input unit. */
export function parseOrderEditPaymentWindowHours(input: string): number | null {
  const value = input.trim();
  if (!DECIMAL_HOURS.test(value)) return null;
  const minutes = Number(value) * ORDER_EDIT_MINUTES_PER_HOUR;
  if (!Number.isFinite(minutes)) return null;
  const wholeMinutes = Math.round(minutes);
  if (
    wholeMinutes < 1 ||
    wholeMinutes > MAX_ORDER_EDIT_PAYMENT_WINDOW_MINUTES ||
    Math.abs(minutes - wholeMinutes) > MINUTE_REPRESENTATION_TOLERANCE
  ) {
    return null;
  }
  return wholeMinutes;
}

export function orderEditPaymentWindowHoursInput(
  minutes: number | null,
): string {
  if (minutes === null) return "";
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_ORDER_EDIT_PAYMENT_WINDOW_MINUTES
  ) {
    throw new RangeError(
      "The payment window must be a supported whole-minute duration.",
    );
  }
  return String(minutes / ORDER_EDIT_MINUTES_PER_HOUR);
}

export function formatOrderEditPaymentWindowHours(minutes: number): string {
  const hours = orderEditPaymentWindowHoursInput(minutes);
  return `${hours} ${minutes === ORDER_EDIT_MINUTES_PER_HOUR ? "hour" : "hours"}`;
}
