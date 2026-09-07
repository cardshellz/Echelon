import { z } from "zod";

const DAY_MS = 86_400_000;
// Full four-digit ISO calendar span; arithmetic remains bounded to valid calendar dates.
const MAX_CALENDAR_DAYS = 3_652_425;
const MICROS_PER_PIECE = BigInt(1_000_000);
export const forecastCalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Enter a valid calendar date");

export function forecastDayNumber(value: string): number {
  return new Date(`${forecastCalendarDateSchema.parse(value)}T00:00:00.000Z`).getTime() / DAY_MS;
}

export function shiftForecastDate(value: string, days: number): string {
  if (!Number.isSafeInteger(days) || Math.abs(days) > MAX_CALENDAR_DAYS) throw new RangeError("Forecast date interval is unsupported");
  return forecastCalendarDateSchema.parse(new Date((forecastDayNumber(value) + days) * DAY_MS).toISOString().slice(0, 10));
}

export const purchaseReplacementForecastSchema = z.object({
  productId: z.number().int().positive().max(2_147_483_647),
  startDate: forecastCalendarDateSchema,
  endDate: forecastCalendarDateSchema.refine((value) => value < "9999-12-31", "The exclusive day after this forecast must remain a four-digit calendar date"),
  totalPieces: z.number().int().min(0).max(2_147_483_647),
  reference: z.string().trim().min(1).max(160),
}).strict().refine((value) => {
  const days = forecastDayNumber(value.endDate) - forecastDayNumber(value.startDate) + 1;
  return days > 0 && days <= 730;
}, "A replacement forecast must cover 1 to 730 calendar days");

export const purchaseReplacementForecastsSchema = z.array(purchaseReplacementForecastSchema).max(1_000).superRefine((ranges, context) => {
  const sorted = [...ranges].sort((a, b) => a.productId - b.productId || a.startDate.localeCompare(b.startDate));
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].productId === sorted[index - 1].productId && sorted[index].startDate <= sorted[index - 1].endDate) {
      context.addIssue({ code: "custom", message: `Replacement forecasts overlap for product ${sorted[index].productId}` });
    }
  }
});

export type PurchaseReplacementForecast = z.infer<typeof purchaseReplacementForecastSchema>;
export interface PurchaseReplacementContribution extends PurchaseReplacementForecast {
  intervalStartDate: string;
  intervalEndExclusive: string;
  replacedBaselineMicros: number;
  replacementMicros: number;
}

export function forecastMicros(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("Forecast daily quantity is invalid");
  const micros = Math.round(value * Number(MICROS_PER_PIECE));
  if (!Number.isSafeInteger(micros)) throw new RangeError("Forecast exceeds micro-piece precision");
  return micros;
}

function checked(value: bigint): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Forecast interval exceeds micro-piece precision");
  return Number(value);
}

/** The explicit range total replaces the baseline for those dates only. Partial
 * intervals use cumulative micro-piece allocation, so adjacent periods conserve
 * the recorded total. Growth and additive events must not be applied twice. */
export function projectReplacementForecast(input: {
  productId: number;
  fromDate: string;
  days: number;
  baselineDailyMicros: number;
  ranges: readonly PurchaseReplacementForecast[];
}): { totalMicros: number; contributions: PurchaseReplacementContribution[] } {
  z.number().int().positive().max(2_147_483_647).parse(input.productId);
  z.number().int().nonnegative().safe().parse(input.baselineDailyMicros);
  z.number().int().min(0).max(MAX_CALENDAR_DAYS).parse(input.days);
  const ranges = purchaseReplacementForecastsSchema.parse(input.ranges);
  const from = forecastDayNumber(input.fromDate);
  const through = from + input.days;
  let total = BigInt(input.baselineDailyMicros) * BigInt(input.days);
  const contributions: PurchaseReplacementContribution[] = [];
  for (const range of ranges.filter((range) => range.productId === input.productId)) {
    const rangeStart = forecastDayNumber(range.startDate);
    const rangeEnd = forecastDayNumber(range.endDate) + 1;
    const start = Math.max(from, rangeStart), end = Math.min(through, rangeEnd);
    if (end <= start) continue;
    const source = BigInt(range.totalPieces) * MICROS_PER_PIECE;
    const denominator = BigInt(rangeEnd - rangeStart);
    const replacement = source * BigInt(end - rangeStart) / denominator - source * BigInt(start - rangeStart) / denominator;
    const displaced = BigInt(input.baselineDailyMicros) * BigInt(end - start);
    total += replacement - displaced;
    contributions.push({ ...range, intervalStartDate: shiftForecastDate(input.fromDate, start - from),
      intervalEndExclusive: shiftForecastDate(input.fromDate, end - from),
      replacedBaselineMicros: checked(displaced), replacementMicros: checked(replacement) });
  }
  return { totalMicros: checked(total), contributions };
}
