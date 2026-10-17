import type { PoolClient } from "pg";
import type { z } from "zod";
import {
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
 * except a system row's notice (11e), so a read needs no row lock.
 * Repositories do not log; the conversion service does.
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
