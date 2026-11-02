import type { Pool, PoolClient } from "pg";
import { LISTING_WORK_CONCURRENCY } from "../application/listing-work-runner";

// Reserved for listing-execution capacity. The session also owns the listing's
// existing job lock, so a disconnected worker automatically releases both.
const LISTING_WORK_PERMIT_NAMESPACE = 918449;

export async function tryAcquireListingWorkPermit(client: PoolClient): Promise<number | null> {
  for (let slot = 1; slot <= LISTING_WORK_CONCURRENCY; slot += 1) {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1,$2) AS acquired", [LISTING_WORK_PERMIT_NAMESPACE, slot],
    );
    if (result.rows[0]?.acquired === true) return slot;
  }
  return null;
}

export async function releaseListingWorkPermit(client: PoolClient, slot: number): Promise<void> {
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > LISTING_WORK_CONCURRENCY)
    throw new Error("Invalid listing work permit.");
  const result = await client.query<{ released: boolean }>(
    "SELECT pg_advisory_unlock($1,$2) AS released", [LISTING_WORK_PERMIT_NAMESPACE, slot],
  );
  if (result.rows[0]?.released !== true) throw new Error("Listing work permit was not held by this session.");
}

/** Share the same cross-process capacity with read-only recovery inspections.
 * No work starts if both listing slots are occupied. */
export async function withListingWorkPermit<T>(pool: Pick<Pool, "connect">, work: () => Promise<T>):
  Promise<{ available: false } | { available: true; value: T }> {
  const client = await pool.connect();
  let slot: number | null = null;
  let discard = false;
  let failed = false;
  let failure: unknown;
  let result: { available: false } | { available: true; value: T } | undefined;
  try {
    slot = await tryAcquireListingWorkPermit(client);
    result = slot === null ? { available: false } : { available: true, value: await work() };
  } catch (error) {
    failed = true;
    failure = error;
    // An acquisition response can be lost after PostgreSQL took the session
    // lock. Discard that session instead of returning a possible lock to pool.
    if (slot === null) discard = true;
  }
  try {
    if (slot !== null) await releaseListingWorkPermit(client, slot);
  } catch (error) {
    discard = true;
    failure = failed ? new AggregateError([failure, error], "Listing inspection and permit release failed.") : error;
    failed = true;
  }
  try { client.release(discard); }
  catch (error) {
    failure = failed ? new AggregateError([failure, error], "Listing inspection and connection release failed.") : error;
    failed = true;
  }
  if (failed) throw failure;
  return result!;
}
