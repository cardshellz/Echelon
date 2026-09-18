/**
 * Provider-boundary date conversion. V1 responses use Pacific local time;
 * tracking occurred_at uses UTC. Neither is the application host's timezone.
 * https://www.shipstation.com/docs/api/requirements/#datetime-format-and-time-zone
 * https://docs.shipstation.com/tracking
 *
 * The original provider payload remains audit evidence. Instants are represented
 * at JavaScript/PostgreSQL-adapter millisecond precision; extra fractional digits
 * are truncated, never rounded into a later event. Equal canonical times must not
 * be used to invent an ordering. Calendar dates remain dates, not midnight events.
 */
export const SHIPSTATION_V1_TIME_ZONE = "America/Los_Angeles";
const MILLISECONDS_PER_SECOND = 1_000;
const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_DAY = 86_400_000;
const MAX_DATE_TEXT_LENGTH = 80;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})?)?$/;

type UnqualifiedTimeZone = typeof SHIPSTATION_V1_TIME_ZONE | "UTC";
export type NormalizedShipStationDate =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "date"; date: string }>
  | Readonly<{ kind: "timestamp"; iso: string; sourceTimeZone: UnqualifiedTimeZone | "explicit_offset" }>;

export class ShipStationDateError extends Error {
  readonly code = "SHIPSTATION_DATE_INVALID";
  readonly context: Readonly<{ field: string; reason: string }>;

  constructor(field: string, reason: string) {
    super(`ShipStation ${field}: ${reason}`);
    this.name = "ShipStationDateError";
    this.context = Object.freeze({ field, reason });
  }
}

const pacificFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: SHIPSTATION_V1_TIME_ZONE,
  calendar: "iso8601",
  numberingSystem: "latn",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function utcEpoch(year: number, month: number, day: number, hour: number, minute: number, second: number, millis = 0): number {
  const date = new Date(0);
  // setUTCFullYear avoids Date.UTC's special interpretation of years 00-99.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  return date.getTime();
}

function pacificWallEpoch(instant: number): number {
  const parts: Record<string, number> = {};
  for (const part of pacificFormatter.formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return utcEpoch(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
}

function pacificInstant(wallEpoch: number, field: string): number {
  // Sample both sides of any nearby DST transition, then round-trip candidates.
  // Do not hard-code a UTC offset or silently select one of two fall-back times.
  const offsets = new Set([-1, 0, 1].map((day) => {
    const sample = wallEpoch + day * MILLISECONDS_PER_DAY;
    return pacificWallEpoch(sample) - Math.floor(sample / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND;
  }));
  const wallSecond = Math.floor(wallEpoch / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND;
  const candidates = [...offsets].map((offset) => wallEpoch - offset)
    .filter((candidate) => pacificWallEpoch(candidate) === wallSecond);
  if (candidates.length !== 1) {
    throw new ShipStationDateError(field, candidates.length === 0
      ? "nonexistent Pacific local time" : "ambiguous Pacific local time; an explicit offset is required");
  }
  return candidates[0];
}

/** Shared parser; the caller selects the documented contract of its endpoint. */
export function normalizeShipStationDate(
  value: unknown,
  field: string,
  unqualifiedTimeZone: UnqualifiedTimeZone,
): NormalizedShipStationDate {
  if (value === undefined || value === null || value === "") return Object.freeze({ kind: "missing" });
  if (typeof value !== "string" || value.length > MAX_DATE_TEXT_LENGTH) {
    throw new ShipStationDateError(field, "expected a bounded provider date string");
  }
  const raw = value.trim();
  if (!raw) return Object.freeze({ kind: "missing" });
  const match = DATE_PATTERN.exec(raw);
  if (!match) throw new ShipStationDateError(field, "unsupported date representation");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", offset] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText ?? 0), minute = Number(minuteText ?? 0), second = Number(secondText ?? 0);
  const millis = Number(fraction.padEnd(3, "0").slice(0, 3));
  const wallEpoch = utcEpoch(year, month, day, hour, minute, second, millis);
  const calendar = new Date(wallEpoch);
  if (year < 1 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    throw new ShipStationDateError(field, "invalid calendar date or time");
  }
  if (hourText === undefined) return Object.freeze({ kind: "date", date: raw });

  let instant = wallEpoch;
  if (offset && offset !== "Z") {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) throw new ShipStationDateError(field, "invalid UTC offset");
    const direction = offset[0] === "+" ? 1 : -1;
    instant -= direction * (offsetHours * 60 + offsetMinutes) * MILLISECONDS_PER_MINUTE;
  } else if (!offset && unqualifiedTimeZone === SHIPSTATION_V1_TIME_ZONE) {
    instant = pacificInstant(wallEpoch, field);
  }
  const canonical = new Date(instant);
  if (canonical.getUTCFullYear() < 1 || canonical.getUTCFullYear() > 9999) {
    throw new ShipStationDateError(field, "UTC instant is outside the four-digit calendar range");
  }
  return Object.freeze({
    kind: "timestamp", iso: canonical.toISOString(),
    sourceTimeZone: offset ? "explicit_offset" : unqualifiedTimeZone,
  });
}

export function normalizeShipStationV1Date(value: unknown, field: string): NormalizedShipStationDate {
  return normalizeShipStationDate(value, field, SHIPSTATION_V1_TIME_ZONE);
}

/** Date-only/missing evidence cannot establish an instant. */
export function shipStationV1Instant(value: unknown, field: string): Date | null {
  const normalized = normalizeShipStationV1Date(value, field);
  return normalized.kind === "timestamp" ? new Date(normalized.iso) : null;
}
