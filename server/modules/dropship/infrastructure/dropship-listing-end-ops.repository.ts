import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { readCatalogStockSelectionFactsForVariants } from "../../catalog/catalog-stock-selection.reader";
import {
  LISTING_END_OPS_ERROR_CODES,
  LISTING_END_REQUEST_REASONS,
  LISTING_END_REQUEST_STATES,
  LISTING_END_STAFF_ACTIONS,
  type ListingEndOpsListAnswer,
  type ListingEndOpsRow,
  type ListingEndStaffAction,
} from "../../../../shared/dropship/listing-end-ops";
import type {
  DropshipListingEndOpsRepository,
  ListingEndOpsLockedRow,
  ListingEndOpsTransaction,
  ListingEndOpsWrite,
} from "../application/dropship-listing-end-ops-service";
import type { ListListingEndsInput } from "../application/dropship-listing-end-ops-dtos";
import { DropshipError } from "../domain/errors";
import { LISTING_END_CODES, LISTING_END_MESSAGES } from "../domain/listing-end-errors";
import { lockVendorSelection } from "./dropship-vendor-selection-lock";

/**
 * The staff surface's SQL (PR C, PLAN-C v4.1 §10). The list is plain reads (the size's SKU through the catalog's
 * published reader). Every staff action is one short transaction with `lock_timeout` 2 s and `statement_timeout` 10 s:
 * the vendor's selection lock (the key the save and the worker's claim take, so a staff write never interleaves with
 * either), the request `FOR UPDATE`, and for "Ended on eBay" the listing `FOR UPDATE` after it (request → listing, the
 * claim's and the finish's order; the push fence locks the listing before it reads ends and never locks an end). Each
 * write bumps `version`, sets `updated_at`, and writes its `dropship.dropship_audit_events` row with the staff actor,
 * the reason and before → after in the same transaction (CLAUDE.md §8, §10). Rules are the domain's
 * (listing-end-staff.ts); a lock wait past the timeout is STAFF_BUSY (transient: nothing was written).
 */

const AUDIT_ENTITY = "dropship_listing_end_request";
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '2s'";
const STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '10s'";
/** A lock wait past the timeout, a deadlock or the statement timeout: nothing was written; the request may be sent again. */
const BUSY_SQLSTATES: ReadonlySet<string> = new Set(["55P03", "40P01", "57014"]);

const rowId = z.number().int().positive().max(2_147_483_647);
const bigintId = z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number).refine(Number.isSafeInteger);
const count = z.number().int().nonnegative();

const ROW_COLUMNS = `r.id::text AS id, r.vendor_id AS "vendorId", v.member_id AS "memberId", v.business_name AS "businessName",
  v.email, r.store_connection_id AS "storeConnectionId", sc.platform, sc.status AS "storeStatus",
  NULLIF(btrim(sc.external_display_name), '') AS "storeName", r.listing_id AS "listingId", l.status AS "listingStatus",
  l.external_listing_id AS "externalListingId", l.external_offer_id AS "externalOfferId", r.product_id AS "productId",
  r.product_variant_id AS "productVariantId", r.reason, r.state, r.code, r.message, r.context, r.attempt_count AS "attemptCount",
  r.deferral_count AS "deferralCount", r.withdraw_call_count AS "withdrawCallCount", r.withdraw_requested_at AS "withdrawRequestedAt",
  r.withdraw_returned_at AS "withdrawReturnedAt", r.withdraw_outcome AS "withdrawOutcome", r.staff_action AS "staffAction",
  r.decided_at AS "decidedAt", r.created_at AS "createdAt", r.updated_at AS "updatedAt"`;
const ROW_FROM = `FROM dropship.dropship_listing_end_requests r
  INNER JOIN dropship.dropship_vendors v ON v.id = r.vendor_id
  INNER JOIN dropship.dropship_store_connections sc ON sc.id = r.store_connection_id
  INNER JOIN dropship.dropship_vendor_listings l ON l.id = r.listing_id`;

const dbRowSchema = z.object({
  id: bigintId, vendorId: rowId, memberId: z.string(), businessName: z.string().nullable(), email: z.string().nullable(),
  storeConnectionId: rowId, platform: z.string(), storeStatus: z.string(), storeName: z.string().nullable(), listingId: rowId,
  listingStatus: z.string(), externalListingId: z.string().nullable(), externalOfferId: z.string().nullable(), productId: rowId,
  productVariantId: rowId, reason: z.enum(LISTING_END_REQUEST_REASONS), state: z.enum(LISTING_END_REQUEST_STATES),
  code: z.string().nullable(), message: z.string().nullable(), context: z.unknown(), attemptCount: count, deferralCount: count,
  withdrawCallCount: count, withdrawRequestedAt: z.date().nullable(), withdrawReturnedAt: z.date().nullable(),
  withdrawOutcome: z.string().nullable(), staffAction: z.enum(LISTING_END_STAFF_ACTIONS).nullable(), decidedAt: z.date().nullable(),
  createdAt: z.date(), updatedAt: z.date(),
});
type DbRow = z.infer<typeof dbRowSchema>;

const lockedRowSchema = z.object({
  id: bigintId, vendorId: rowId, storeConnectionId: rowId, listingId: rowId, productVariantId: rowId,
  state: z.enum(LISTING_END_REQUEST_STATES), version: z.number().int().positive(), code: z.string().nullable(),
  staffAction: z.enum(LISTING_END_STAFF_ACTIONS).nullable(), staffActionKey: z.string().nullable(), resolvedIdentity: z.unknown(),
  withdrawCallCount: count, withdrawRequestedAt: z.date().nullable(),
  // The before state of the audit row (§10: the old values are the staff authorization's record).
  context: z.unknown(), attemptCount: count, deferralCount: count, withdrawReturnedAt: z.date().nullable(),
  withdrawOutcome: z.string().nullable(), decidedAt: z.date().nullable(),
});
type LockedDbRow = z.infer<typeof lockedRowSchema>;

export class PgDropshipListingEndOpsRepository implements DropshipListingEndOpsRepository {
  constructor(private readonly pool: Pool) {}

  /** One page, newest first, of one state (index `dropship_end_state_idx (state, id)`), with its total. */
  async list(input: ListListingEndsInput): Promise<ListingEndOpsListAnswer> {
    const params: unknown[] = [input.state];
    const clauses = ["r.state = $1"];
    if (input.vendorId !== undefined) clauses.push(`r.vendor_id = $${params.push(input.vendorId)}`);
    if (input.storeConnectionId !== undefined) clauses.push(`r.store_connection_id = $${params.push(input.storeConnectionId)}`);
    const where = `WHERE ${clauses.join(" AND ")}`;
    const total = z.number().int().nonnegative().parse((await this.pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM dropship.dropship_listing_end_requests r ${where}`, params)).rows[0]?.total);
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT ${ROW_COLUMNS} ${ROW_FROM} ${where}
      ORDER BY r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, input.limit, (input.page - 1) * input.limit])).rows.map((row) => dbRowSchema.parse(row));
    const skus = await readSkus(this.pool, rows);
    return { items: rows.map((row) => wireRow(row, skus)), total, page: input.page, limit: input.limit, state: input.state };
  }

  async withLockedEndRequest<T>(endRequestId: number, work: (tx: ListingEndOpsTransaction) => Promise<T>):
    Promise<{ found: false } | { found: true; value: T; row: ListingEndOpsRow }> {
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query(LOCK_TIMEOUT_SQL);
      await client.query(STATEMENT_TIMEOUT_SQL);
      // The vendor id is an identity column (never changes): read it plainly to take the vendor's lock before the row's.
      const owner = (await client.query<{ vendor_id: number }>(
        "SELECT vendor_id FROM dropship.dropship_listing_end_requests WHERE id = $1", [endRequestId])).rows[0];
      if (!owner) {
        await client.query("ROLLBACK");
        return { found: false };
      }
      await lockVendorSelection(client, owner.vendor_id);
      const locked = lockedRowSchema.parse((await client.query(`SELECT r.id::text AS id, r.vendor_id AS "vendorId",
          r.store_connection_id AS "storeConnectionId", r.listing_id AS "listingId", r.product_variant_id AS "productVariantId",
          r.state, r.version, r.code, r.staff_action AS "staffAction", r.staff_action_key AS "staffActionKey",
          r.resolved_identity AS "resolvedIdentity", r.withdraw_call_count AS "withdrawCallCount",
          r.withdraw_requested_at AS "withdrawRequestedAt", r.context, r.attempt_count AS "attemptCount",
          r.deferral_count AS "deferralCount", r.withdraw_returned_at AS "withdrawReturnedAt", r.withdraw_outcome AS "withdrawOutcome",
          r.decided_at AS "decidedAt"
        FROM dropship.dropship_listing_end_requests r WHERE r.id = $1 FOR UPDATE`, [endRequestId])).rows[0]);
      const value = await work(new LockedEndRequest(client, locked));
      const row = dbRowSchema.parse((await client.query(`SELECT ${ROW_COLUMNS} ${ROW_FROM} WHERE r.id = $1`, [endRequestId])).rows[0]);
      const skus = await readSkus(client, [row]);
      await client.query("COMMIT");
      return { found: true, value, row: wireRow(row, skus) };
    } catch (error) {
      if (!(await rollbackQuietly(client))) releaseError = error instanceof Error ? error : new Error(String(error));
      const sqlState = sqlStateOf(error);
      if (sqlState !== null && BUSY_SQLSTATES.has(sqlState)) {
        throw new DropshipError(LISTING_END_OPS_ERROR_CODES.staffBusy,
          // PROPOSED (Stage 4, step 1 plan S2-5): staff words.
          "Nothing was changed because another update was running. Try again in a moment.",
          { endRequestId, causeCode: sqlState, classification: "transient", retryable: true });
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }
}

/** The request locked for one staff action. Every write is guarded by the locked id, state and version. */
class LockedEndRequest implements ListingEndOpsTransaction {
  readonly row: ListingEndOpsLockedRow;

  constructor(private readonly client: PoolClient, private readonly locked: LockedDbRow) {
    this.row = {
      endRequestId: locked.id, vendorId: locked.vendorId, storeConnectionId: locked.storeConnectionId, listingId: locked.listingId,
      productVariantId: locked.productVariantId, state: locked.state, version: locked.version, code: locked.code,
      staffAction: locked.staffAction, staffActionKey: locked.staffActionKey, resolvedIdentity: locked.resolvedIdentity,
      withdrawCallCount: locked.withdrawCallCount, withdrawRequestedAt: locked.withdrawRequestedAt,
    };
  }

  /**
   * `failed` → `pending`, due now (§10): the decision, the code, the context, every count and the withdraw fields are
   * cleared, so the worker's claim starts over and may send one more withdraw; the old values are the audit row's
   * before state (the staff authorization of another withdraw, WD:75-76).
   */
  async retry(write: ListingEndOpsWrite): Promise<void> {
    await this.update(`state = 'pending', next_attempt_at = $3, decided_at = NULL, code = NULL, message = NULL, context = '{}'::jsonb,
      attempt_count = 0, deferral_count = 0, withdraw_call_count = 0, withdraw_requested_at = NULL, withdraw_returned_at = NULL,
      withdraw_outcome = NULL, staff_action = 'retry', staff_action_key = $4, updated_at = $3, version = version + 1`,
    [write.now, write.idempotencyKey]);
    await this.audit("listing_end_retry_requested", write, "retry", { state: "pending", version: this.locked.version + 1,
      nextAttemptAt: write.now.toISOString() });
  }

  /**
   * "Ended on eBay" (§10, SAF-8): the listing gets the finish's write — `status = 'ended'`, its ids kept,
   * `marketplace_ended_at` never written (it means "the vendor ended it") — and the request becomes `ended` with
   * ENDED_BY_STAFF (not a verified end for the canary). Its `ended_at` fences every vendor press queued before it (§6.2).
   * A listing already `ended` is not written again.
   */
  async resolveEnded(write: ListingEndOpsWrite): Promise<{ listingWritten: boolean }> {
    const listing = z.object({ status: z.string(), externalListingId: z.string().nullable(), externalOfferId: z.string().nullable() })
      .parse((await this.client.query(`SELECT status, external_listing_id AS "externalListingId", external_offer_id AS "externalOfferId"
        FROM dropship.dropship_vendor_listings WHERE id = $1 FOR UPDATE`, [this.locked.listingId])).rows[0]);
    const written = await this.client.query(`UPDATE dropship.dropship_vendor_listings SET status = 'ended', updated_at = $2
      WHERE id = $1 AND status <> 'ended'`, [this.locked.listingId, write.now]);
    const code = LISTING_END_CODES.endedByStaff;
    await this.update(`state = 'ended', ended_at = $3, decided_at = $3, next_attempt_at = NULL, code = $5, message = $6,
      staff_action = 'resolve_ended', staff_action_key = $4, updated_at = $3, version = version + 1`,
    [write.now, write.idempotencyKey, code, LISTING_END_MESSAGES[code]]);
    if (written.rowCount === 1) {
      await this.insertAudit({ entityType: "dropship_vendor_listing", entityId: String(this.locked.listingId),
        eventType: "listing_ended_by_card_shellz", write, payload: { listingId: this.locked.listingId, endRequestId: this.locked.id,
          productVariantId: this.locked.productVariantId, externalOfferId: listing.externalOfferId, externalListingId: listing.externalListingId,
          endedBy: "staff", reason: write.reason, before: { status: listing.status }, after: { status: "ended" } } });
    }
    await this.audit("listing_end_resolved", write, "resolve_ended", { state: "ended", code, version: this.locked.version + 1,
      endedAt: write.now.toISOString(), listingWritten: written.rowCount === 1 });
    return { listingWritten: written.rowCount === 1 };
  }

  /** "Left on sale": `failed` → `resolved`; the end is closed, so a re-picked size sells again and sync-back reads it again. */
  async resolveLeft(write: ListingEndOpsWrite): Promise<void> {
    await this.update(`state = 'resolved', decided_at = $3, next_attempt_at = NULL, staff_action = 'resolve_left',
      staff_action_key = $4, updated_at = $3, version = version + 1`, [write.now, write.idempotencyKey]);
    await this.audit("listing_end_resolved", write, "resolve_left", { state: "resolved", version: this.locked.version + 1 });
  }

  /** One guarded state change ($1 id, $2 version; the request is locked, so anything but one row is a broken invariant). */
  private async update(set: string, values: unknown[]): Promise<void> {
    const updated = await this.client.query(`UPDATE dropship.dropship_listing_end_requests SET ${set}
      WHERE id = $1 AND state = 'failed' AND version = $2`, [this.locked.id, this.locked.version, ...values]);
    if (updated.rowCount !== 1) throw new Error("The locked listing end request could not be written.");
  }

  private async audit(eventType: string, write: ListingEndOpsWrite, action: ListingEndStaffAction, after: Record<string, unknown>): Promise<void> {
    const before = this.locked;
    await this.insertAudit({ entityType: AUDIT_ENTITY, entityId: String(before.id), eventType, write, payload: {
      endRequestId: before.id, listingId: before.listingId, productVariantId: before.productVariantId, action,
      idempotencyKey: write.idempotencyKey, reason: write.reason,
      before: { state: before.state, version: before.version, code: before.code, context: before.context, attemptCount: before.attemptCount,
        deferralCount: before.deferralCount, withdrawCallCount: before.withdrawCallCount,
        withdrawRequestedAt: before.withdrawRequestedAt?.toISOString() ?? null, withdrawReturnedAt: before.withdrawReturnedAt?.toISOString() ?? null,
        withdrawOutcome: before.withdrawOutcome, decidedAt: before.decidedAt?.toISOString() ?? null, staffAction: before.staffAction },
      after: { ...after, staffAction: action } } });
  }

  private async insertAudit(input: { entityType: string; entityId: string; eventType: string; write: ListingEndOpsWrite;
    payload: Record<string, unknown> }): Promise<void> {
    await this.client.query(`INSERT INTO dropship.dropship_audit_events
        (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'info', $8::jsonb, $9)`, [this.locked.vendorId, this.locked.storeConnectionId, input.entityType,
      input.entityId, input.eventType, input.write.actor.actorType, input.write.actor.actorId, JSON.stringify(input.payload), input.write.now]);
  }
}

async function readSkus(client: Pick<Pool, "query">, rows: readonly DbRow[]): Promise<Map<number, string | null>> {
  const facts = await readCatalogStockSelectionFactsForVariants(client, rows.map((row) => row.productVariantId));
  return new Map(facts.map(({ variant }) => [variant.id, variant.sku]));
}

/** The row as staff see it (the shared contract's shape): dates as ISO text, the context's staff parts only. */
function wireRow(row: DbRow, skus: ReadonlyMap<number, string | null>): ListingEndOpsRow {
  return {
    endRequestId: row.id,
    vendor: { vendorId: row.vendorId, memberId: row.memberId, businessName: row.businessName, email: row.email },
    store: { storeConnectionId: row.storeConnectionId, platform: row.platform, status: row.storeStatus, displayName: row.storeName },
    listing: { listingId: row.listingId, status: row.listingStatus, externalListingId: row.externalListingId, externalOfferId: row.externalOfferId },
    productId: row.productId,
    productVariantId: row.productVariantId,
    sku: skus.get(row.productVariantId) ?? null,
    reason: row.reason,
    state: row.state,
    code: row.code,
    message: row.message,
    context: staffContext(row.context),
    attemptCount: row.attemptCount,
    deferralCount: row.deferralCount,
    withdraw: { callCount: row.withdrawCallCount, requestedAt: row.withdrawRequestedAt?.toISOString() ?? null,
      returnedAt: row.withdrawReturnedAt?.toISOString() ?? null, outcome: row.withdrawOutcome },
    staffAction: row.staffAction,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The worker's context keys staff act on (§5.5: lastCode, attemptIds, evidence, requiresReview); anything else stays in the row. */
function staffContext(raw: unknown): ListingEndOpsRow["context"] {
  const context = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    lastCode: typeof context.lastCode === "string" ? context.lastCode : null,
    attemptIds: Array.isArray(context.attemptIds) ? context.attemptIds.filter((id): id is string => typeof id === "string") : [],
    evidence: typeof context.evidence === "string" ? context.evidence : null,
    requiresReview: context.requiresReview === true,
  };
}

function sqlStateOf(error: unknown): string | null {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    && /^[0-9A-Z]{5}$/.test((error as { code: string }).code) ? (error as { code: string }).code : null;
}

async function rollbackQuietly(client: PoolClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    // The original error is rethrown; a session whose rollback failed is discarded, never reused.
    return false;
  }
}
