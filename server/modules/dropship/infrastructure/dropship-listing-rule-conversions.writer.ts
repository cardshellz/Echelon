import type { PoolClient } from "pg";
import type { z } from "zod";
import {
  MAX_CONVERSION_ACTOR_ID_LENGTH,
  listingRuleConversionRecordSchema,
  listingRuleConversionValuesSchema,
  type ListingRuleConversionActorType,
  type ListingRuleConversionRecord,
} from "../../../../shared/dropship/listing-rules-conversion";
import { LISTING_SETTING_KEY_PATTERN } from "../../../../shared/dropship/listing-setting-values";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { listingSettingsIdempotencyConflict } from "./dropship-listing-setting-shared.repository";

/**
 * The conversion record (PR 11, plan section 12, D12): one row per applied
 * move of a store's older group rules, inserted first in the conversion's
 * transaction so it claims the request key. Every function runs on the
 * caller's transaction client and takes no lock: the caller holds the
 * request lock (vendor) and the store lock (both actors), which serialize
 * every use of a key and every conversion of a store. Rows never change
 * except a system row's notice (11e1), so a read needs no row lock; marking
 * a notice seen is one guarded UPDATE whose row lock serializes two presses
 * (acknowledgeNoticeWithClient). Repositories do not log; the services do.
 */

type QueryClient = Pick<PoolClient, "query">;

/** The unique key that makes the insert claim the request key (the migration's name, pinned by the PostgreSQL suite). */
export const LISTING_RULE_CONVERSION_KEY_CONSTRAINT = "dropship_listing_rule_conversion_key_uk";
const UNIQUE_VIOLATION = "23505";
/** Store and vendor ids are int4 keys. */
const MAX_INT4_ID = 2_147_483_647;
/** Issues an error reports: enough to find the fault, small enough to log. */
const MAX_REPORTED_ISSUES = 10;

const RECORD_COLUMNS = `id, vendor_id, store_connection_id, idempotency_key, request_hash, plan_hash, writes_hash, clean,
       changed_size_count, category_count, product_count, pricing_groups_removed, content_groups_removed, ebay_rules_removed,
       actor_type, actor_id, created_at, notice_seen_at, notice_seen_by`;

const INSERT_SQL = `INSERT INTO dropship.dropship_listing_rule_conversions
       (vendor_id, store_connection_id, idempotency_key, request_hash, plan_hash, writes_hash, clean,
        changed_size_count, category_count, product_count, pricing_groups_removed, content_groups_removed, ebay_rules_removed,
        actor_type, actor_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING ${RECORD_COLUMNS}`;

const FIND_BY_KEY_SQL = `SELECT ${RECORD_COLUMNS}
     FROM dropship.dropship_listing_rule_conversions
     WHERE vendor_id = $1 AND idempotency_key = $2`;

/** One row is enough to answer; the (store_connection_id, id) index serves it. */
const HAS_ANY_SQL = `SELECT EXISTS (SELECT 1 FROM dropship.dropship_listing_rule_conversions WHERE store_connection_id = $1) AS found`;

/**
 * The store's latest conversion, when it is the system's and no one has seen
 * its notice (plan 9.3, D19): one statement the (store_connection_id, id)
 * index serves, no lock. A vendor's own conversion never has a notice (the
 * record's CHECK), and one made after the job's (D21: rules added back, then
 * moved by the vendor) ends the job's notice: the vendor saw "Moved over."
 * for his own move, and the job's "Nothing in your listings changed." would
 * no longer be true of the store.
 */
const UNSEEN_SYSTEM_SQL = `SELECT ${RECORD_COLUMNS}
     FROM (SELECT ${RECORD_COLUMNS}
       FROM dropship.dropship_listing_rule_conversions
       WHERE store_connection_id = $1 AND vendor_id = $2
       ORDER BY id DESC
       LIMIT 1) latest
     WHERE actor_type = 'system' AND notice_seen_at IS NULL`;

/**
 * Marks a system conversion's notice seen, once (plan 9.3): the only UPDATE
 * the table's guard trigger allows (the two notice columns from null to
 * values, on a system row). The WHERE re-checks `notice_seen_at IS NULL`
 * after any row lock it waited on, so of two presses exactly one updates.
 */
const NOTICE_SEEN_SQL = `UPDATE dropship.dropship_listing_rule_conversions
     SET notice_seen_at = $4, notice_seen_by = $5
     WHERE id = $1 AND vendor_id = $2 AND store_connection_id = $3 AND actor_type = 'system' AND notice_seen_at IS NULL
     RETURNING id`;

/** Whether the id names a system conversion of this store at all (seen or not): `already_seen`, else 404. */
const SYSTEM_CONVERSION_EXISTS_SQL = `SELECT EXISTS (SELECT 1 FROM dropship.dropship_listing_rule_conversions
       WHERE id = $1 AND vendor_id = $2 AND store_connection_id = $3 AND actor_type = 'system') AS found`;

/** The notice's audit row (plan 9.3, CLAUDE.md §10): the conversion, who saw it, before and after. */
const NOTICE_AUDIT_SQL = `INSERT INTO dropship.dropship_audit_events
       (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_listing_rule_conversion', $3, 'listing_rules_conversion_notice_seen', 'vendor', $4, 'info', $5::jsonb, $6)`;

/** What a press of the notice's [Got it] did: marked it seen now, found it seen already, or found no such system conversion. */
export type ListingRuleConversionNoticeOutcome = "acknowledged" | "already_seen" | "not_found";

/** A press of [Got it] as the notice's transaction passes it: the owner it resolved, the conversion named, who pressed, when. */
export interface ListingRuleConversionNoticeAcknowledge {
  vendorId: number;
  storeConnectionId: number;
  conversionId: number;
  /** The member who pressed it: the row's `notice_seen_by` and the audit row's actor. */
  actorId: string;
  /** The injected clock: the row's `notice_seen_at` and the audit row's time. */
  now: Date;
}

/** A conversion about to be recorded, as the conversion transaction builds it. */
export interface ListingRuleConversionInsert {
  vendorId: number;
  storeConnectionId: number;
  idempotencyKey: string;
  requestHash: string;
  planHash: string;
  writesHash: string;
  clean: boolean;
  changedSizeCount: number;
  categoryCount: number;
  productCount: number;
  pricingGroupsRemoved: number;
  contentGroupsRemoved: number;
  ebayRulesRemoved: number;
  actor: { actorType: ListingRuleConversionActorType; actorId: string };
  /** The injected clock; the row has no DEFAULT now(). */
  now: Date;
}

interface StoredConversionRow {
  id: unknown;
  vendor_id: unknown;
  store_connection_id: unknown;
  idempotency_key: unknown;
  request_hash: unknown;
  plan_hash: unknown;
  writes_hash: unknown;
  clean: unknown;
  changed_size_count: unknown;
  category_count: unknown;
  product_count: unknown;
  pricing_groups_removed: unknown;
  content_groups_removed: unknown;
  ebay_rules_removed: unknown;
  actor_type: unknown;
  actor_id: unknown;
  created_at: unknown;
  notice_seen_at: unknown;
  notice_seen_by: unknown;
}

/**
 * Records the conversion and claims its key. The input is checked against
 * the record's contract before any SQL (a breach is a programming fault,
 * fatal), including plan D1: a system conversion is clean and changed no
 * size. A key this vendor already used is 23505 on the unique key, which is
 * DROPSHIP_IDEMPOTENCY_CONFLICT (permanent): the caller's replay check runs
 * first under the request lock, so this is a backstop. Any other database
 * error is rethrown as it is, for the caller's one mapping after rollback.
 */
export async function insertRuleConversionWithClient(
  client: QueryClient,
  input: ListingRuleConversionInsert,
): Promise<ListingRuleConversionRecord> {
  assertInsert(input);
  let result: { rows: StoredConversionRow[] };
  try {
    result = await client.query<StoredConversionRow>(INSERT_SQL, [
      input.vendorId, input.storeConnectionId, input.idempotencyKey, input.requestHash, input.planHash, input.writesHash,
      input.clean, input.changedSizeCount, input.categoryCount, input.productCount,
      input.pricingGroupsRemoved, input.contentGroupsRemoved, input.ebayRulesRemoved,
      input.actor.actorType, input.actor.actorId, input.now,
    ]);
  } catch (error) {
    if (isKeyViolation(error)) throw listingSettingsIdempotencyConflict({ constraint: LISTING_RULE_CONVERSION_KEY_CONSTRAINT });
    throw error;
  }
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw listingSettingsInvariantFailed("The listing rule conversion insert did not return its one row.", {
      returnedCount: result.rows.length,
    });
  }
  return recordFromRow(row);
}

/** The conversion this vendor recorded under this key, or null; the caller compares its store and request hash (replay). */
export async function findRuleConversionByKeyWithClient(
  client: QueryClient,
  input: { vendorId: number; idempotencyKey: string },
): Promise<ListingRuleConversionRecord | null> {
  const invalid = [
    isInt4Id(input.vendorId) ? null : "vendorId",
    typeof input.idempotencyKey === "string" && LISTING_SETTING_KEY_PATTERN.test(input.idempotencyKey) ? null : "idempotencyKey",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw outsideContract(invalid);
  const result = await client.query<StoredConversionRow>(FIND_BY_KEY_SQL, [input.vendorId, input.idempotencyKey]);
  if (result.rows.length > 1) {
    throw listingSettingsInvariantFailed("A listing rule conversion key named more than one row.", { foundCount: result.rows.length });
  }
  return result.rows[0] ? recordFromRow(result.rows[0]) : null;
}

/** True when any conversion of this store was ever recorded, by either actor (the job converts a store at most once, plan D20). */
export async function hasRuleConversionWithClient(client: QueryClient, input: { storeConnectionId: number }): Promise<boolean> {
  if (!isInt4Id(input.storeConnectionId)) throw outsideContract(["storeConnectionId"]);
  const result = await client.query<{ found: unknown }>(HAS_ANY_SQL, [input.storeConnectionId]);
  const found = result.rows[0]?.found;
  if (typeof found !== "boolean") {
    throw listingSettingsInvariantFailed("The listing rule conversion lookup returned no answer.");
  }
  return found;
}

/**
 * The store's latest conversion when it is a system one whose notice no one
 * has seen, else null (plan 9.3, D19): the notice's read. One indexed
 * statement, no lock: a press that marks it seen at the same time is
 * answered by its own transaction.
 */
export async function findUnseenSystemConversionWithClient(
  client: QueryClient,
  input: { vendorId: number; storeConnectionId: number },
): Promise<ListingRuleConversionRecord | null> {
  const invalid = [
    isInt4Id(input.vendorId) ? null : "vendorId",
    isInt4Id(input.storeConnectionId) ? null : "storeConnectionId",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw outsideContract(invalid);
  const result = await client.query<StoredConversionRow>(UNSEEN_SYSTEM_SQL, [input.storeConnectionId, input.vendorId]);
  const row = result.rows[0];
  if (!row) return null;
  const record = recordFromRow(row);
  // The statement asked for exactly this; another row is a broken contract, never shown as a notice.
  if (record.actorType !== "system" || record.noticeSeenAt !== null || record.vendorId !== input.vendorId
    || record.storeConnectionId !== input.storeConnectionId) {
    throw listingSettingsInvariantFailed("The unseen system conversion read returned another row.", { conversionId: record.id });
  }
  return record;
}

/**
 * [Got it] on a system conversion's notice (plan 9.3), on the caller's
 * transaction client after it resolved the store's owner by member (FOR
 * SHARE): the guarded UPDATE, and for the one row it marks, the audit row in
 * the same transaction; `acknowledged`. When it marks none: `already_seen`
 * when the id names a system conversion of this store (someone saw it
 * first), else `not_found` (the caller's 404). Idempotent by state, so a
 * replayed press writes nothing (CLAUDE.md §7, "status checks"). Inputs are
 * checked before any SQL (a breach is a programming fault, fatal).
 */
export async function acknowledgeNoticeWithClient(
  client: QueryClient,
  input: ListingRuleConversionNoticeAcknowledge,
): Promise<ListingRuleConversionNoticeOutcome> {
  assertNoticeAcknowledge(input);
  const { vendorId, storeConnectionId, conversionId, actorId, now } = input;
  const updated = await client.query<{ id: unknown }>(NOTICE_SEEN_SQL, [conversionId, vendorId, storeConnectionId, now, actorId]);
  if (updated.rows.length > 1) {
    throw listingSettingsInvariantFailed("Marking a conversion notice seen updated more than one row.", { conversionId, updatedCount: updated.rows.length });
  }
  if (updated.rows.length === 1) {
    if (storedNumber(updated.rows[0].id) !== conversionId) {
      throw listingSettingsInvariantFailed("Marking a conversion notice seen updated another row.", { conversionId });
    }
    const seenAt = now.toISOString();
    await client.query(NOTICE_AUDIT_SQL, [vendorId, storeConnectionId, String(conversionId), actorId, JSON.stringify({
      conversionId,
      before: { noticeSeenAt: null, noticeSeenBy: null },
      after: { noticeSeenAt: seenAt, noticeSeenBy: actorId },
    }), now]);
    return "acknowledged";
  }
  const exists = await client.query<{ found: unknown }>(SYSTEM_CONVERSION_EXISTS_SQL, [conversionId, vendorId, storeConnectionId]);
  const found = exists.rows[0]?.found;
  if (typeof found !== "boolean") {
    throw listingSettingsInvariantFailed("The conversion notice lookup returned no answer.", { conversionId });
  }
  return found ? "already_seen" : "not_found";
}

function assertNoticeAcknowledge(input: ListingRuleConversionNoticeAcknowledge): void {
  const invalid = [
    isInt4Id(input.vendorId) ? null : "vendorId",
    isInt4Id(input.storeConnectionId) ? null : "storeConnectionId",
    Number.isSafeInteger(input.conversionId) && input.conversionId > 0 ? null : "conversionId",
    typeof input.actorId === "string" && input.actorId.trim() !== "" && input.actorId.length <= MAX_CONVERSION_ACTOR_ID_LENGTH
      ? null : "actorId",
    input.now instanceof Date && Number.isFinite(input.now.getTime()) ? null : "now",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw outsideContract(invalid);
}

function assertInsert(input: ListingRuleConversionInsert): void {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) throw outsideContract(["now"]);
  const parsed = listingRuleConversionValuesSchema.safeParse({
    vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash, planHash: input.planHash, writesHash: input.writesHash, clean: input.clean,
    changedSizeCount: input.changedSizeCount, categoryCount: input.categoryCount, productCount: input.productCount,
    pricingGroupsRemoved: input.pricingGroupsRemoved, contentGroupsRemoved: input.contentGroupsRemoved,
    ebayRulesRemoved: input.ebayRulesRemoved, actorType: input.actor?.actorType, actorId: input.actor?.actorId,
  });
  if (!parsed.success) {
    throw listingSettingsInvariantFailed("A listing rule conversion breaks the record's contract.", { issues: issueCodes(parsed.error) });
  }
}

/**
 * A stored row through the record's contract: the id is bigint (a string
 * from node-postgres) and the times are timestamps. A row that breaks it is a
 * fault named by its id, never a guess.
 */
function recordFromRow(row: StoredConversionRow): ListingRuleConversionRecord {
  const parsed = listingRuleConversionRecordSchema.safeParse({
    id: storedNumber(row.id),
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    planHash: row.plan_hash,
    writesHash: row.writes_hash,
    clean: row.clean,
    changedSizeCount: row.changed_size_count,
    categoryCount: row.category_count,
    productCount: row.product_count,
    pricingGroupsRemoved: row.pricing_groups_removed,
    contentGroupsRemoved: row.content_groups_removed,
    ebayRulesRemoved: row.ebay_rules_removed,
    actorType: row.actor_type,
    actorId: row.actor_id,
    createdAt: storedTime(row.created_at),
    noticeSeenAt: row.notice_seen_at === null ? null : storedTime(row.notice_seen_at),
    noticeSeenBy: row.notice_seen_by,
  });
  if (parsed.success) return parsed.data;
  throw listingSettingsInvariantFailed("A stored listing rule conversion failed its contract.", {
    conversionId: String(row.id), issues: issueCodes(parsed.error),
  });
}

/** bigint arrives as a decimal string; anything else stays as it is for the schema to refuse. */
function storedNumber(value: unknown): unknown {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
}

function storedTime(value: unknown): unknown {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : value;
}

function isKeyViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const fields = error as { code?: unknown; constraint?: unknown };
  return fields.code === UNIQUE_VIOLATION && fields.constraint === LISTING_RULE_CONVERSION_KEY_CONSTRAINT;
}

function isInt4Id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4_ID;
}

function outsideContract(invalid: string[]) {
  return listingSettingsInvariantFailed("A listing rule conversion call was outside its contract.", { invalid });
}

/** Issue paths and codes only, so no stored or sent text reaches an error. */
function issueCodes(error: z.ZodError): Array<{ path: string; code: string }> {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
}
