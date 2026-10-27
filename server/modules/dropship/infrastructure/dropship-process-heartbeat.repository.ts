import type { PoolClient } from "pg";

/**
 * Process heartbeats with a catalog code version (step 1 plan S2-5 §4.9 item 1,
 * D37). Every time is the database's `clock_timestamp()` on both sides, the
 * precedent of `inventory.opening_capture_worker` (F30): dyno clock skew can
 * neither age a live process out nor keep a dead one in.
 */
type Queryable = Pick<PoolClient, "query">;

export interface ProcessHeartbeatRow {
  processKey: string;
  catalogCodeVersion: number;
  startedAt: Date;
  lastSeenAt: Date;
}

/**
 * One beat: the process's row (created at its first beat, `started_at` kept
 * after), and its version's first-seen time, written once per version and
 * never moved (CHK10). One statement, so both land together or neither does;
 * it is safe on the pooled handle (no session state).
 */
export async function writeProcessHeartbeat(client: Queryable, input: {
  processKey: string;
  catalogCodeVersion: number;
}): Promise<void> {
  await client.query(
    `WITH beat AS (
       INSERT INTO dropship.dropship_process_heartbeats (process_key, catalog_code_version, started_at, last_seen_at)
       VALUES ($1, $2, clock_timestamp(), clock_timestamp())
       ON CONFLICT (process_key) DO UPDATE
         SET last_seen_at = clock_timestamp(), catalog_code_version = EXCLUDED.catalog_code_version
       RETURNING process_key
     )
     INSERT INTO dropship.dropship_catalog_code_versions (catalog_code_version, first_seen_at)
     VALUES ($2, clock_timestamp())
     ON CONFLICT (catalog_code_version) DO NOTHING`,
    [input.processKey, input.catalogCodeVersion],
  );
}

/** Rows not seen for `olderThanMs` are gone processes; the version first-seen rows are never deleted. */
export async function deleteStaleProcessHeartbeats(client: Queryable, input: { olderThanMs: number }): Promise<number> {
  const result = await client.query(
    `DELETE FROM dropship.dropship_process_heartbeats
     WHERE last_seen_at < clock_timestamp() - make_interval(secs => $1::double precision / 1000.0)`,
    [input.olderThanMs],
  );
  return result.rowCount ?? 0;
}

/**
 * Whether a process of an older catalog code version reported within the
 * grace: B's picks writes and C's end worker stay closed while it is true.
 */
export async function hasLiveOlderCatalogProcess(client: Queryable, input: {
  belowVersion: number;
  graceMs: number;
}): Promise<boolean> {
  const result = await client.query<{ live: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM dropship.dropship_process_heartbeats
       WHERE catalog_code_version < $1
         AND last_seen_at > clock_timestamp() - make_interval(secs => $2::double precision / 1000.0)
     ) AS live`,
    [input.belowVersion, input.graceMs],
  );
  return result.rows[0]?.live === true;
}

/**
 * Whether a catalog code version first ran longer ago than `settleMs`. No row
 * (the version never ran) is false. Later heartbeats never move it, so it is
 * one wait per version, not per deploy (CHK10).
 */
export async function catalogVersionSettled(client: Queryable, input: {
  version: number;
  settleMs: number;
}): Promise<boolean> {
  const result = await client.query<{ settled: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM dropship.dropship_catalog_code_versions
       WHERE catalog_code_version = $1
         AND first_seen_at < clock_timestamp() - make_interval(secs => $2::double precision / 1000.0)
     ) AS settled`,
    [input.version, input.settleMs],
  );
  return result.rows[0]?.settled === true;
}

/**
 * Whether a catalog code version at or above `minVersion` first ran longer ago than `settleMs`: picks writes open
 * on any version that writes picks, so a database where only a later version ever ran is not closed for good (review
 * SAV-1). The exact-version check above stays for the end worker, which needs version 3 itself.
 */
export async function catalogVersionAtLeastSettled(client: Queryable, input: {
  minVersion: number;
  settleMs: number;
}): Promise<boolean> {
  const result = await client.query<{ settled: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM dropship.dropship_catalog_code_versions
       WHERE catalog_code_version >= $1
         AND first_seen_at < clock_timestamp() - make_interval(secs => $2::double precision / 1000.0)
     ) AS settled`,
    [input.minVersion, input.settleMs],
  );
  return result.rows[0]?.settled === true;
}

/**
 * Processes of an older version still reporting within the grace although
 * this version first ran more than `alertAfterMs` ago (§3.1). Empty while this
 * version is younger than that, and when no older process is fresh.
 */
export async function listOlderProcessesStillRunning(client: Queryable, input: {
  version: number;
  graceMs: number;
  alertAfterMs: number;
}): Promise<ProcessHeartbeatRow[]> {
  const result = await client.query<{
    process_key: string; catalog_code_version: number; started_at: Date; last_seen_at: Date;
  }>(
    `SELECT h.process_key, h.catalog_code_version, h.started_at, h.last_seen_at
     FROM dropship.dropship_process_heartbeats h
     JOIN dropship.dropship_catalog_code_versions v ON v.catalog_code_version = $1
     WHERE v.first_seen_at < clock_timestamp() - make_interval(secs => $3::double precision / 1000.0)
       AND h.catalog_code_version < $1
       AND h.last_seen_at > clock_timestamp() - make_interval(secs => $2::double precision / 1000.0)
     ORDER BY h.process_key`,
    [input.version, input.graceMs, input.alertAfterMs],
  );
  return result.rows.map((row) => ({
    processKey: row.process_key,
    catalogCodeVersion: row.catalog_code_version,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
  }));
}
