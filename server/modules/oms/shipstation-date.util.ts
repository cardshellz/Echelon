import { normalizeShipStationV1Date, ShipStationDateError } from "@shared/utils/shipstation-date";

function assertValidFallback(fallback: Date): Date {
  if (!(fallback instanceof Date) || Number.isNaN(fallback.getTime())) {
    throw new Error("resolveShipStationShipmentTimestamp requires a valid fallback Date");
  }
  return fallback;
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
  try {
    const normalized = normalizeShipStationV1Date(shipDate, "shipDate");
    // This is an explicit application fallback for channel reporting, not an
    // interpretation of a calendar date as a provider occurrence timestamp.
    return normalized.kind === "timestamp" ? new Date(normalized.iso) : validFallback;
  } catch (error) {
    if (!(error instanceof ShipStationDateError)) throw error;
    return validFallback;
  }
}
