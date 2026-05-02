const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HAS_TIMEZONE_PATTERN = /(Z|[+-]\d{2}:\d{2})$/i;

function assertValidFallback(fallback: Date): Date {
  if (!(fallback instanceof Date) || Number.isNaN(fallback.getTime())) {
    throw new Error("resolveShipStationShipmentTimestamp requires a valid fallback Date");
  }
  return fallback;
}

function parseTimestamp(value: string): Date | null {
  const normalized = HAS_TIMEZONE_PATTERN.test(value) ? value : `${value}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * ShipStation SHIP_NOTIFY exposes `shipDate` as a date-only value for labels
 * created in the UI. Treating that as midnight can predate the eBay order's
 * creation time; eBay returns 201 Created for that payload but does not persist
 * the fulfillment. For date-only values, use the processing timestamp instead.
 */
export function resolveShipStationShipmentTimestamp(
  shipDate: string | null | undefined,
  fallback: Date,
): Date {
  const validFallback = assertValidFallback(fallback);
  const raw = typeof shipDate === "string" ? shipDate.trim() : "";
  if (!raw || DATE_ONLY_PATTERN.test(raw)) {
    return validFallback;
  }

  return parseTimestamp(raw) ?? validFallback;
}
