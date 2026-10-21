/**
 * Which version of the catalog selection code this process runs (step 1 plan
 * S2-5 §4.9 item 1, D37). Every process writes it with its heartbeat; a later
 * release's gates wait until no process of an older version has reported
 * (B's picks writes, C's end worker), and catalog reads refuse a page newer
 * than the server (§4.8, CHK7).
 *
 * 1 = PR A (rules selection, publish runs), 2 = PR B (one-time picks),
 * 3 = PR C (ending removed listings). Each PR sets its value; a unit test pins it.
 */
export const DROPSHIP_CATALOG_CODE_VERSION = 1;

/**
 * How long after its last heartbeat a process still counts as running: four
 * missed 30 s beats, longer than the time between SIGTERM and SIGKILL
 * (HYPOTHESIS about 30 s, F31; the process keeps working after SIGTERM).
 */
export const OLDER_PROCESS_GRACE_MS = 120_000;

/**
 * How long a version must have been running before its own gates open: it
 * also covers a process too old to write heartbeats at all (CHK10).
 */
export const NEW_VERSION_SETTLE_MS = 300_000;

/**
 * An older process still reporting this long after the newest version first
 * ran needs a human (§3.1: HYPOTHESIS that every web dyno is replaced on a
 * release, so this should never fire).
 */
export const OLDER_PROCESS_ALERT_AFTER_MS = 30 * 60_000;

export type CatalogPageVersionDecision = "current" | "page_newer_than_server";

/**
 * A catalog read from a page built for a newer catalog code version than this
 * server answers "try again" (503), so a B or C page that reaches an older dyno
 * during a release never reads rows with another release's meaning. A page
 * that sends no version is a page of this release or older.
 */
export function decideCatalogPageVersion(
  clientVersion: number | null,
  serverVersion: number = DROPSHIP_CATALOG_CODE_VERSION,
): CatalogPageVersionDecision {
  return clientVersion !== null && clientVersion > serverVersion ? "page_newer_than_server" : "current";
}
