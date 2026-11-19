import type { PoolClient } from "pg";

/**
 * The per-vendor selection lock (F1): every write of a vendor's selection
 * takes it, and a publish run takes it to snapshot the selection, so a run's
 * targets always match one selection revision (step 1 plan S2-5, §4.2). The
 * key text is byte-identical to the one PR A's rules save always used
 * (TESTS16): PR B's picks save (dropship-selection-change.repository.ts) and an
 * A dyno's run create during B's release must take one lock, and a different
 * text would hash to a different lock and serialize nothing.
 */
export const DROPSHIP_VENDOR_SELECTION_LOCK_KEY = "dropship_vendor_selection_rules";

/** The lock statement with the key inlined, as PR A's rules save sent it. */
export const DROPSHIP_VENDOR_SELECTION_LOCK_SQL =
  `SELECT pg_advisory_xact_lock(hashtext('${DROPSHIP_VENDOR_SELECTION_LOCK_KEY}'), $1::integer)`;

/** Takes the vendor's selection lock until the caller's transaction ends (never a session lock, CLAUDE.md §9). */
export async function lockVendorSelection(client: Pick<PoolClient, "query">, vendorId: number): Promise<void> {
  await client.query(DROPSHIP_VENDOR_SELECTION_LOCK_SQL, [vendorId]);
}
