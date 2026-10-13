import { listingSettingsInvariantFailed } from "./listing-setting-values";

/**
 * The first-mark job's run key (plan PR 9, P28, 10.5): one per UTC hour,
 * `category-marks:YYYY-MM-DDTHH`. It names the run as the system actor and in
 * the audit row; it is not what makes a rerun safe (the insert is ON
 * CONFLICT DO NOTHING), so two runs in one hour share a key harmlessly. Pure:
 * the time is the caller's injected clock reading.
 */

const JOB_KEY_PREFIX = "category-marks:";
/** `toISOString()` is always UTC; years 0-9999 print as four digits, so the hour is its first 13 characters. */
const UTC_HOUR_LENGTH = 13;
const UTC_HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

/** An invalid Date, or one outside years 0-9999 (printed with a six-digit year), is a programming fault (fatal). */
export function categoryMarksJobKey(now: Date): string {
  const hour = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString().slice(0, UTC_HOUR_LENGTH) : null;
  if (hour === null || !UTC_HOUR_PATTERN.test(hour)) {
    throw listingSettingsInvariantFailed("The first category mark job was given a time it cannot name an hour by.", {
      now: hour === null ? null : now.toISOString(),
    });
  }
  return `${JOB_KEY_PREFIX}${hour}`;
}
