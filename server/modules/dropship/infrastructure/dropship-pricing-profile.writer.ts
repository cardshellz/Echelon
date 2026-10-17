import type { PoolClient } from "pg";
import type { z } from "zod";
import {
  LISTING_RULE_CONVERSION_ACTOR_TYPES,
  type ListingRuleConversionActorType,
} from "../../../../shared/dropship/listing-rules-conversion";
import {
  pricingProfileSchema,
  pricingProfileStateSchema,
  type PricingProfile,
  type PricingProfileState,
} from "../../../../shared/dropship/pricing-rules";
import { DropshipError } from "../domain/errors";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { MAX_LISTING_SETTING_ACTOR_ID_LENGTH } from "./dropship-listing-setting-shared.repository";

/**
 * The store's pricing profile written on its own (PR 11, plan 7.A.2 row 7,
 * D11): a new revision, the head moved to it and one audit row, all on the
 * caller's transaction client, and **no per-size row**. W1's apply
 * (dropship-pricing-rules.repository.ts, applyReview) also re-saves every
 * reviewed size as `rules`; a conversion only empties the groups, so a size's
 * own price row must stay exactly as it is (plan D6). The caller holds the
 * store lock and the owner rows (plan D13); this takes no lock but FOR
 * UPDATE on the head row. Repositories do not log; the conversion does.
 */

type QueryClient = Pick<PoolClient, "query">;

/** Store and vendor ids are int4 keys. */
const MAX_INT4_ID = 2_147_483_647;
/** Issues an error reports: enough to find the fault, small enough to log. */
const MAX_REPORTED_ISSUES = 10;

/** The head and its revision, locked: no other writer can move the head until this transaction ends. */
const HEAD_FOR_UPDATE_SQL = `SELECT r.id, r.profile, r.created_at FROM dropship.dropship_pricing_profiles p
     JOIN dropship.dropship_pricing_profile_revisions r ON r.id = p.revision_id
       AND r.vendor_id = p.vendor_id AND r.store_connection_id = p.store_connection_id
     WHERE p.store_connection_id = $1 AND p.vendor_id = $2
     FOR UPDATE OF p`;
/**
 * A profile revision ($1 vendor, $2 store, $3 previous revision, $4 profile,
 * $5 actor, $6 time) and the head moved to it ($1 vendor, $2 store, $3
 * revision): the only two statements that write a pricing profile, shared
 * with W1's apply (dropship-pricing-rules.repository.ts, applyReview).
 */
export const PRICING_PROFILE_REVISION_INSERT_SQL = `INSERT INTO dropship.dropship_pricing_profile_revisions
       (vendor_id, store_connection_id, previous_revision_id, profile, actor_id, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id`;
export const PRICING_PROFILE_HEAD_UPSERT_SQL = `INSERT INTO dropship.dropship_pricing_profiles (vendor_id, store_connection_id, revision_id)
     VALUES ($1, $2, $3) ON CONFLICT (store_connection_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`;
const AUDIT_SQL = `INSERT INTO dropship.dropship_audit_events
       (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_pricing_profile', $3, 'pricing_profile_saved', $4, $5, 'info', $6::jsonb, $7)`;

/** Whose profile is written, and who writes it; the audit row takes `actorType` (default vendor), the revision only the id. */
export interface PricingProfileWriteTarget {
  vendorId: number;
  storeConnectionId: number;
  actorId: string;
  actorType?: ListingRuleConversionActorType;
}

export interface PricingProfileSaveInput {
  /** The revision the caller's plan read; null when the store has no profile yet. */
  expectedRevisionId: number | null;
  profile: PricingProfile;
  /** The conversion record this save belongs to (the audit row names it). */
  conversionId: number;
  /** The injected clock. */
  now: Date;
}

/**
 * Compare-and-set on the head:
 * 1. the target and input are checked before any SQL (the profile with its
 *    own contract); a breach is a programming fault (fatal);
 * 2. the head FOR UPDATE must be the revision the caller read, else
 *    DROPSHIP_PRICING_REVIEW_STALE (W1's 409, permanent) before any INSERT,
 *    so a stale caller never reaches the coherence trigger's 23514;
 * 3. the revision (its predecessor is the head read), the head, then the
 *    audit row `pricing_profile_saved` with before and after, whose entity
 *    id is the new revision's, as W1's `pricing_rules_applied` rows are
 *    (one id space under `dropship_pricing_profile`; the store is its own
 *    column).
 */
export async function savePricingProfileWithClient(
  client: QueryClient,
  target: PricingProfileWriteTarget,
  input: PricingProfileSaveInput,
): Promise<{ revisionId: number; previousRevisionId: number | null }> {
  const actorType = assertTarget(target);
  const profile = parseInput(input);

  const head = await client.query<{ id: unknown; profile: unknown; created_at: unknown }>(HEAD_FOR_UPDATE_SQL,
    [target.storeConnectionId, target.vendorId]);
  const before = storedHead(head.rows);
  if (before.revisionId !== input.expectedRevisionId) {
    throw new DropshipError("DROPSHIP_PRICING_REVIEW_STALE",
      "Prices, rules, costs, or selected listings changed. Review the current impact before applying.", {
        storeConnectionId: target.storeConnectionId, expectedRevisionId: input.expectedRevisionId,
        actualRevisionId: before.revisionId, retryable: false, classification: "permanent",
      });
  }

  const inserted = await client.query<{ id: unknown }>(PRICING_PROFILE_REVISION_INSERT_SQL, [
    target.vendorId, target.storeConnectionId, before.revisionId, JSON.stringify(profile), target.actorId, input.now,
  ]);
  const revisionId = inserted.rows[0]?.id;
  if (inserted.rows.length !== 1 || !isInt4Id(revisionId)) {
    throw listingSettingsInvariantFailed("The pricing profile revision insert did not return one identity.");
  }
  await client.query(PRICING_PROFILE_HEAD_UPSERT_SQL, [target.vendorId, target.storeConnectionId, revisionId]);
  await client.query(AUDIT_SQL, [
    target.vendorId, target.storeConnectionId, String(revisionId), actorType, target.actorId,
    JSON.stringify({
      conversionId: input.conversionId, revisionId, previousRevisionId: before.revisionId,
      // Both profiles whole: at most 100 groups each (the profile contract), and the store default kept or not.
      before: before.profile, after: profile,
    }),
    input.now,
  ]);
  return { revisionId, previousRevisionId: before.revisionId };
}

function assertTarget(target: PricingProfileWriteTarget): ListingRuleConversionActorType {
  const actorType = target.actorType ?? "vendor";
  const invalid = [
    isInt4Id(target.vendorId) ? null : "vendorId",
    isInt4Id(target.storeConnectionId) ? null : "storeConnectionId",
    (LISTING_RULE_CONVERSION_ACTOR_TYPES as readonly string[]).includes(actorType) ? null : "actorType",
    typeof target.actorId === "string" && target.actorId.trim() !== "" && target.actorId.length <= MAX_LISTING_SETTING_ACTOR_ID_LENGTH
      ? null : "actorId",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw outsideContract(invalid);
  return actorType;
}

function parseInput(input: PricingProfileSaveInput): PricingProfile {
  const invalid = [
    input.expectedRevisionId === null || isInt4Id(input.expectedRevisionId) ? null : "expectedRevisionId",
    typeof input.conversionId === "number" && Number.isSafeInteger(input.conversionId) && input.conversionId > 0 ? null : "conversionId",
    input.now instanceof Date && Number.isFinite(input.now.getTime()) ? null : "now",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw outsideContract(invalid);
  const parsed = pricingProfileSchema.safeParse(input.profile);
  if (!parsed.success) {
    throw listingSettingsInvariantFailed("A pricing profile save failed the profile's contract.", { issues: issueCodes(parsed.error) });
  }
  return parsed.data;
}

/** No row: the store has no profile yet. A stored profile that breaks its contract is a fault, never a guess. */
function storedHead(rows: ReadonlyArray<{ id: unknown; profile: unknown; created_at: unknown }>): PricingProfileState {
  if (rows.length > 1) throw listingSettingsInvariantFailed("A store has more than one pricing profile head.", { foundCount: rows.length });
  const row = rows[0];
  const parsed = pricingProfileStateSchema.safeParse(row
    ? { revisionId: row.id, profile: row.profile, updatedAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at }
    : { revisionId: null, profile: null, updatedAt: null });
  if (parsed.success) return parsed.data;
  throw listingSettingsInvariantFailed("A stored pricing profile failed its contract.", { issues: issueCodes(parsed.error) });
}

function isInt4Id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4_ID;
}

function outsideContract(invalid: string[]): DropshipError {
  return listingSettingsInvariantFailed("A pricing profile save was called outside its contract.", { invalid });
}

function issueCodes(error: z.ZodError): Array<{ path: string; code: string }> {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
}
