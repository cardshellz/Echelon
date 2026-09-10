import { parseISO } from "date-fns";

const scheduleDatePattern = /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

/**
 * PO schedule fields use the UTC calendar day of the serialized value. They
 * are dates, unlike recorded-at events, so a viewer's timezone must not move
 * them to the previous day. Date-only values follow the same convention.
 */
export function procurementScheduleDateInput(value: unknown): string {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : "";
  }
  if (typeof value !== "string" || !scheduleDatePattern.test(value)) return "";
  const calendarPart = value.slice(0, 10);
  const calendarDate = parseISO(`${calendarPart}T00:00:00Z`);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== calendarPart) return "";
  const date = value.length === 10 ? calendarDate : parseISO(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

export function formatProcurementScheduleDate(
  value: unknown,
  options: { empty?: string; includeYear?: boolean } = {},
): string {
  if (value === null || value === undefined || value === "") return options.empty ?? "Not recorded";
  const input = procurementScheduleDateInput(value);
  if (!input) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(options.includeYear === false ? {} : { year: "numeric" as const }),
  }).format(new Date(`${input}T00:00:00Z`));
}
