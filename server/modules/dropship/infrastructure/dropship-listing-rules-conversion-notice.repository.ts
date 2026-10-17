import type { Pool, PoolClient } from "pg";
import { MAX_CONVERSION_ACTOR_ID_LENGTH } from "../../../../shared/dropship/listing-rules-conversion";
import { pool as defaultPool } from "../../../db";
import type {
  ListingRulesConversionNoticeAcknowledgeResult,
  ListingRulesConversionNoticeRepository,
} from "../application/dropship-listing-rules-conversion-notice-service";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { acknowledgeNoticeWithClient } from "./dropship-listing-rule-conversions.writer";
import {
  VENDOR_OWNER_SQL,
  mapListingSettingDatabaseError,
  mapListingSettingWriteError,
  ownerVendorId,
} from "./dropship-listing-setting-writes.repository";

/** Store and vendor ids are int4 keys. */
const MAX_INT4_ID = 2_147_483_647;

/**
 * The one-time notice's [Got it] (Listing settings PR 11e1, plan 9.3): one
 * short READ COMMITTED transaction on a pooled client. It takes the owner
 * rows by member FOR SHARE (the listing writers' own statement, so a vendor
 * or store change waits for it), then `acknowledgeNoticeWithClient`: the
 * guarded UPDATE and its audit row commit together, or neither does. No
 * advisory lock: the UPDATE's row lock serializes two presses, and its WHERE
 * re-checks that the notice is still unseen. COMMIT, or ROLLBACK on any
 * failure (the original failure is the one thrown, mapped once as a listing
 * write's: a connection failure with a SQLSTATE or a deadlock is the
 * transient BUSY, a CHECK or the guard trigger the fatal invariant;
 * node-postgres' code-less "Connection terminated" passes as it is, as on
 * every PR 9 route); the client is released once on
 * every path. Repositories do not log; the service does.
 */
export class PgDropshipListingRulesConversionNoticeRepository implements ListingRulesConversionNoticeRepository {
  constructor(private readonly dbPool: Pick<Pool, "connect"> = defaultPool) {}

  async acknowledgeNotice(input: {
    memberId: string; storeConnectionId: number; conversionId: number; now: Date;
  }): Promise<ListingRulesConversionNoticeAcknowledgeResult> {
    assertAcknowledgeInput(input);
    let client: PoolClient;
    try {
      client = await this.dbPool.connect();
    } catch (error) {
      // No transaction was opened, so nothing to roll back; a pool timeout or a refused connection is retryable.
      throw mapListingSettingDatabaseError(error);
    }
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ vendor_id: unknown }>(VENDOR_OWNER_SQL, [input.memberId, input.storeConnectionId]);
      const vendorId = ownerVendorId(owner.rows[0], input.storeConnectionId);
      const outcome = await acknowledgeNoticeWithClient(client, {
        vendorId, storeConnectionId: input.storeConnectionId, conversionId: input.conversionId, actorId: input.memberId, now: input.now,
      });
      await client.query("COMMIT");
      return { vendorId, outcome };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Deliberate: the original failure is the one reported; a ROLLBACK that fails leaves nothing committed.
      }
      throw mapListingSettingWriteError(error);
    } finally {
      client.release();
    }
  }
}

/** The service builds these; a breach is a programming fault (fatal), before any connection is taken. */
function assertAcknowledgeInput(input: { memberId: string; storeConnectionId: number; conversionId: number; now: Date }): void {
  const invalid = [
    typeof input.memberId === "string" && input.memberId.trim() !== "" && input.memberId.length <= MAX_CONVERSION_ACTOR_ID_LENGTH
      ? null : "memberId",
    Number.isSafeInteger(input.storeConnectionId) && input.storeConnectionId > 0 && input.storeConnectionId <= MAX_INT4_ID
      ? null : "storeConnectionId",
    Number.isSafeInteger(input.conversionId) && input.conversionId > 0 ? null : "conversionId",
    input.now instanceof Date && Number.isFinite(input.now.getTime()) ? null : "now",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) {
    throw listingSettingsInvariantFailed("A conversion notice acknowledge was outside its contract.", { invalid });
  }
}
