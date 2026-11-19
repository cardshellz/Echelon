import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type { CategoryMarksJobSource, CategoryMarksStore } from "../application/dropship-category-marks-job-service";
import { loadSelectedProductIds } from "../application/dropship-selected-catalog";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { mapListingSettingDatabaseError } from "./dropship-listing-setting-writes.repository";
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";

/**
 * The first-mark job's reads (plan PR 9, P28, 10.5), outside any write
 * transaction and lock: they decide only which products to offer the
 * system transaction, whose insert is idempotent, so nothing read here needs
 * to hold until the insert. Neither read writes.
 */

/**
 * The stores the job marks: P28's lists, the same as the write gate's store
 * and vendor allow-lists (dropship-listing-setting-write-support.ts), eBay
 * only. No entitlement filter (P28 names none): marks feed a notice only, and
 * a vendor's "Got it" still passes the write gate.
 */
const MARKABLE_STORES_SQL = `SELECT sc.vendor_id, sc.id AS store_connection_id
  FROM dropship.dropship_store_connections sc
  JOIN dropship.dropship_vendors v ON v.id = sc.vendor_id
  WHERE sc.platform = 'ebay'
    AND sc.status IN ('connected', 'needs_reauth', 'refresh_failed')
    AND v.status IN ('active', 'onboarding')
  ORDER BY sc.vendor_id, sc.id`;
/** One snapshot, no lock, as the listing-settings read load opens (dropship-listing-settings.repository.ts). */
const SNAPSHOT_BEGIN_SQL = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
const MAX_INT4_ID = 2_147_483_647;

export class PgDropshipCategoryMarksJobSource implements CategoryMarksJobSource {
  constructor(private readonly dbPool: Pick<Pool, "query" | "connect"> = defaultPool) {}

  async listMarkableStores(): Promise<CategoryMarksStore[]> {
    let rows: Array<{ vendor_id: unknown; store_connection_id: unknown }>;
    try {
      rows = (await this.dbPool.query<{ vendor_id: unknown; store_connection_id: unknown }>(MARKABLE_STORES_SQL)).rows;
    } catch (error) {
      throw mapListingSettingDatabaseError(error);
    }
    return parseStores(rows);
  }

  /** Ids only, with no 10,000 cap (plan 10.8 #2), in a read-only snapshot on its own connection. */
  async listSelectedProductIds(vendorId: number, now: Date): Promise<number[]> {
    if (!isInt4Id(vendorId) || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw listingSettingsInvariantFailed("The first category mark job's catalog scan was asked outside its contract.", {
        invalid: [isInt4Id(vendorId) ? null : "vendorId", now instanceof Date && Number.isFinite(now.getTime()) ? null : "now"]
          .filter((field): field is string => field !== null),
      });
    }
    let client: PoolClient;
    try {
      client = await this.dbPool.connect();
    } catch (error) {
      throw mapListingSettingDatabaseError(error);
    }
    let rollbackFailure: Error | undefined;
    try {
      await client.query(SNAPSHOT_BEGIN_SQL);
      const productIds = await loadSelectedProductIds(selectedCatalogReaderForTransaction(client, vendorId), now);
      await client.query("COMMIT");
      return productIds;
    } catch (error) {
      rollbackFailure = await rollbackQuietly(client);
      throw mapListingSettingDatabaseError(error);
    } finally {
      // A connection whose rollback failed is destroyed, never handed back to the pool mid-transaction.
      client.release(rollbackFailure);
    }
  }
}

/** Every row checked: int4 ids, each store once, in the statement's order. A breach is a broken contract (fatal for the tick). */
function parseStores(rows: ReadonlyArray<{ vendor_id: unknown; store_connection_id: unknown }>): CategoryMarksStore[] {
  const seen = new Set<number>();
  return rows.map((row) => {
    const { vendor_id: vendorId, store_connection_id: storeConnectionId } = row;
    if (!isInt4Id(vendorId) || !isInt4Id(storeConnectionId) || seen.has(storeConnectionId)) {
      throw listingSettingsInvariantFailed("A store the first category mark job listed failed its contract.", {
        storeConnectionId: String(storeConnectionId),
      });
    }
    seen.add(storeConnectionId);
    return { vendorId, storeConnectionId };
  });
}

/**
 * The scan's own failure is what the caller rethrows; a failed rollback must
 * not replace it. Its error is returned so the connection is destroyed.
 */
async function rollbackQuietly(client: Pick<PoolClient, "query">): Promise<Error | undefined> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function isInt4Id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4_ID;
}
