import { projectReplacementForecast, forecastMicros, type PurchaseReplacementForecast } from "@shared/procurement/purchase-replacement-forecast";
import { z } from "zod";
import { inspectPurchaseReceiptSupplyCapture } from "@shared/procurement/purchase-receipt-supply-evidence";
import type { PurchaseSupplyTiming } from "@shared/procurement/purchase-planning-policy";

const DAY_MS = 86_400_000;
const MAX_DATE_DAYS = 3_652_425; // Full four-digit calendar span.
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const scheduleSchema = z.array(z.object({
  purchaseOrderId: integer.refine((value) => value > 0),
  purchaseOrderNumber: z.string().min(1),
  purchaseOrderLineId: integer.refine((value) => value > 0),
  remainingPieces: integer,
  expectedDate: dateOnly.nullable(),
  expectedDateSource: z.enum(["line_promised", "line_expected", "purchase_confirmed", "purchase_expected"]).nullable().optional(),
}).strict()).max(10_000);

function dayNumber(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getTime() / DAY_MS;
}

function shiftedDate(date: string, days: number): string | null {
  if (!Number.isFinite(days) || Math.abs(days) > MAX_DATE_DAYS) return null;
  const shifted = new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
  return dateOnly.safeParse(shifted).success ? shifted : null;
}

/**
 * A timing diagnostic, never a second purchasing quantity authority. Open POs remain
 * committed supply in the main engine; uncertain/late dates require review before
 * another unattended draft can duplicate those commitments. Dates are warehouse
 * arrival estimates from the PO, not proof of receipt or pickable inventory.
 */
export function buildPurchaseSupplyTiming(input: {
  asOfDate: string;
  replacementForecasts?: { productId: number; ranges: PurchaseReplacementForecast[] };
  availablePieces: number;
  dailyPieces: number;
  leadTimeDays: number;
  safetyStockDays: number;
  onOrderPieces: number;
  rawSchedule: unknown;
  rawReceiptEvidence?: unknown;
  forwardDemand?: { pieces: number; captureComplete: boolean; events: Array<{ eventStartDate: string; weightedPieces: number }> };
}): PurchaseSupplyTiming {
  dateOnly.parse(input.asOfDate);
  z.number().finite().parse(input.availablePieces);
  z.number().finite().nonnegative().parse(input.dailyPieces);
  integer.parse(input.leadTimeDays);
  integer.parse(input.safetyStockDays);
  integer.parse(input.onOrderPieces);
  const horizonDays = input.leadTimeDays + input.safetyStockDays;
  const demandBetween = (startDay: number, endDay: number): number => input.replacementForecasts?.ranges.length
    ? projectReplacementForecast({ productId: input.replacementForecasts.productId, fromDate: shiftedDate(input.asOfDate, startDay)!,
      days: endDay - startDay, baselineDailyMicros: forecastMicros(input.dailyPieces), ranges: input.replacementForecasts.ranges }).totalMicros / 1_000_000
    : (endDay - startDay) * input.dailyPieces;
  const gapDate = (startDay: number, endDay: number, available: number): string => {
    let low = startDay + 1, high = endDay;
    while (low < high) { const middle = Math.floor((low + high) / 2); if (demandBetween(startDay, middle) > available) high = middle; else low = middle + 1; }
    return shiftedDate(input.asOfDate, Math.max(startDay, low - 1))!;
  };
  const arrivalDate = shiftedDate(input.asOfDate, input.leadTimeDays);
  if (!arrivalDate) throw new RangeError("Purchase lead time exceeds the supported calendar range");
  const receiptCapture = input.rawReceiptEvidence === undefined ? null : inspectPurchaseReceiptSupplyCapture(input.rawReceiptEvidence, input.onOrderPieces);
  const receiptEvidence = receiptCapture?.evidence;
  const receiptReviewRequired = receiptCapture?.reviewRequired ?? false;
  const parsed = scheduleSchema.safeParse(input.rawSchedule);
  const entries = parsed.success ? parsed.data.filter((entry) => entry.remainingPieces > 0) : [];
  const ids = new Set(entries.map((entry) => entry.purchaseOrderLineId));
  const total = entries.reduce((sum, entry) => sum + entry.remainingPieces, 0);
  const scheduleComplete = !receiptReviewRequired && ((!parsed.success && input.onOrderPieces === 0) || (parsed.success && ids.size === entries.length
    && Number.isSafeInteger(total) && total === input.onOrderPieces));
  const arrivals = scheduleComplete ? [...entries].sort((left, right) =>
    (left.expectedDate ?? "9999").localeCompare(right.expectedDate ?? "9999")
    || left.purchaseOrderLineId - right.purchaseOrderLineId) : [];
  let scheduledWithinCyclePieces = 0;
  let undatedPieces = scheduleComplete ? 0 : input.onOrderPieces;
  let pastDuePieces = 0;
  let beyondCyclePieces = 0;
  const forward = input.forwardDemand;
  const demandSchema = z.array(z.object({ eventStartDate: dateOnly, weightedPieces: integer }));
  const demandParse = demandSchema.safeParse(forward?.events ?? []);
  const demandEvents = demandParse.success ? demandParse.data : [];
  const demandTotal = demandEvents.reduce((sum, event) => sum + event.weightedPieces, 0);
  const demandComplete = !forward || (demandParse.success && Number.isSafeInteger(demandTotal)
    && demandTotal === forward.pieces && (forward.pieces === 0 || forward.captureComplete === true));
  const timeline: Array<{ day: number; kind: "receipt" | "demand"; pieces: number }> = [];
  for (const arrival of arrivals) {
    if (!arrival.expectedDate) { undatedPieces += arrival.remainingPieces; continue; }
    const day = dayNumber(arrival.expectedDate) - dayNumber(input.asOfDate);
    if (day < 0) { pastDuePieces += arrival.remainingPieces; continue; }
    if (day > horizonDays) { beyondCyclePieces += arrival.remainingPieces; continue; }
    scheduledWithinCyclePieces += arrival.remainingPieces;
    timeline.push({ day, kind: "receipt", pieces: arrival.remainingPieces });
  }
  for (const event of demandComplete ? demandEvents : []) {
    const day = Math.max(0, dayNumber(event.eventStartDate) - dayNumber(input.asOfDate));
    if (day <= horizonDays) timeline.push({ day, kind: "demand", pieces: event.weightedPieces });
  }
  timeline.sort((left, right) => left.day - right.day || (left.kind === right.kind ? 0 : left.kind === "receipt" ? -1 : 1));
  let balance = input.availablePieces;
  let previousDay = 0;
  let firstGapDate: string | null = input.availablePieces < 0 ? input.asOfDate : null;
  for (const event of timeline) {
    if (!firstGapDate && balance < demandBetween(previousDay, event.day)) {
      firstGapDate = gapDate(previousDay, event.day, balance);
    }
    balance -= demandBetween(previousDay, event.day);
    if (event.kind === "receipt") balance += event.pieces;
    else {
      if (!firstGapDate && balance < event.pieces) firstGapDate = shiftedDate(input.asOfDate, event.day);
      balance -= event.pieces;
    }
    previousDay = event.day;
  }
  if (!firstGapDate && balance < demandBetween(previousDay, horizonDays)) {
    firstGapDate = gapDate(previousDay, horizonDays, balance);
  }
  // Calculate the same demand path without arrivals for the latest order date.
  // A lumpy event can exhaust stock before the historical daily-rate date.
  let withoutReceiptBalance = input.availablePieces;
  let withoutReceiptDay = 0;
  let stockoutDateWithoutReceipts: string | null = input.availablePieces < 0 ? input.asOfDate : null;
  const noReceiptEvents = [...demandEvents, ...(input.replacementForecasts?.ranges ?? []).flatMap((range) => [
    { eventStartDate: range.startDate, weightedPieces: 0 }, { eventStartDate: shiftedDate(range.endDate, 1)!, weightedPieces: 0 },
  ])].filter((event) => event.eventStartDate >= input.asOfDate || event.weightedPieces > 0)
    .sort((left, right) => left.eventStartDate.localeCompare(right.eventStartDate));
  for (const event of demandComplete ? noReceiptEvents : []) {
    const day = Math.max(0, dayNumber(event.eventStartDate) - dayNumber(input.asOfDate));
    if (stockoutDateWithoutReceipts) break;
    if (withoutReceiptBalance < demandBetween(withoutReceiptDay, day)) {
      stockoutDateWithoutReceipts = gapDate(withoutReceiptDay, day, withoutReceiptBalance);
      break;
    }
    withoutReceiptBalance -= demandBetween(withoutReceiptDay, day);
    if (withoutReceiptBalance < event.weightedPieces) stockoutDateWithoutReceipts = shiftedDate(input.asOfDate, day);
    withoutReceiptBalance -= event.weightedPieces;
    withoutReceiptDay = day;
  }
  if (!stockoutDateWithoutReceipts && input.dailyPieces > 0) stockoutDateWithoutReceipts = shiftedDate(input.asOfDate, withoutReceiptDay + Math.max(0, Math.floor(withoutReceiptBalance / input.dailyPieces)));
  if (!demandComplete) stockoutDateWithoutReceipts = null;
  const uncertain = !scheduleComplete || undatedPieces > 0 || pastDuePieces > 0;
  const signal = receiptReviewRequired ? "unverified_receipts" : !demandComplete ? "unverified_demand_events" : uncertain ? "unverified_schedule" : input.onOrderPieces === 0 ? "no_open_supply"
    : firstGapDate ? "arrival_gap" : "scheduled";
  const detail = signal === "unverified_receipts"
    ? `Receipt quantities need review. ${receiptCapture?.unresolvedPieces == null ? "The open" : receiptCapture.unresolvedPieces + " pieces of"} PO commitment is unresolved; buy/no-buy and arrival coverage are not verified. ${receiptCapture?.detail}`
    : signal === "unverified_demand_events"
    ? "The demand-event total has no complete dated evidence. Review forecast events before relying on arrival coverage."
    : signal === "no_open_supply"
    ? "No open PO supply is included. Dates use the forecast and configured lead time."
    : signal === "unverified_schedule"
      ? `${undatedPieces} inbound pieces have no verified date and ${pastDuePieces} are past due. Confirm the existing POs before placing another order.`
      : signal === "arrival_gap"
        ? `Projected supply can run out on ${firstGapDate} before the scheduled receipts cover demand. Review the existing POs for expediting or additional supply.`
        : "Dated PO supply covers forecast demand through the lead-time and safety cycle. Receipt and putaway still determine availability.";
  return {
    asOfDate: input.asOfDate,
    stockoutDateWithoutReceipts,
    orderByDateWithoutReceipts: stockoutDateWithoutReceipts === null ? null
      : shiftedDate(stockoutDateWithoutReceipts, -input.leadTimeDays - input.safetyStockDays),
    newOrderArrivalDate: arrivalDate,
    reviewRequired: receiptReviewRequired || !demandComplete || uncertain || (input.onOrderPieces > 0 && firstGapDate !== null),
    signal, detail, ...(receiptEvidence ? { receiptEvidence } : {}), firstGapDate, scheduledWithinCyclePieces, undatedPieces, pastDuePieces,
    beyondCyclePieces, scheduleComplete, arrivals,
  };
}
