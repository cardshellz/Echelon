import type { Pool, PoolClient } from "pg";
import type { z } from "zod";
import { pool as defaultPool } from "../../../db";
import { contentProfileSchema } from "../../../../shared/dropship/listing-content";
import { ebayCategoryRulesProfileSchema } from "../../../../shared/dropship/ebay-category-rules";
import { isReservedConversionKey } from "../../../../shared/dropship/listing-rules-conversion-keys";
import { LISTING_SETTING_KEY_PATTERN } from "../../../../shared/dropship/listing-setting-values";
import { conversionCategoryNamesToRead } from "../application/dropship-listing-rules-conversion";
import {
  listingRulesConvertedAuditSchema,
  rulesConversionSystemKey,
  type ListingRulesConversionActor,
  type ListingRulesConversionExecuteInput,
  type ListingRulesConversionRepository,
  type ListingRulesConversionTransaction,
} from "../application/dropship-listing-rules-conversion-service";
import {
  RULES_CONVERSION_FAILED_EVENT,
  rulesConversionFailureAuditSchema,
  rulesConversionHeadRevisionsSchema,
  type RulesConversionFailureAudit,
  type RulesConversionFailureRecordOutcome,
  type RulesConversionHeadRevisions,
  type RulesConversionJobRepository,
  type RulesConversionStoreLoad,
} from "../application/dropship-rules-conversion-job-service";
import type { DropshipListingCatalogCandidate } from "../application/dropship-listing-preview-service";
import type { CategoryListingSettingSaveResult } from "../application/dropship-listing-setting-writes";
import { olderGroupRuleCounts } from "../application/dropship-listing-settings-facts";
import { loadSelectedCandidates } from "../application/dropship-selected-catalog";
import { DropshipError } from "../domain/errors";
import { listingConversionChildKey, listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { saveCategoryListingSettingWithClient } from "./dropship-category-listing-settings.repository";
import { saveEbayCategoryRulesProfileWithClient } from "./dropship-ebay-category-rules.repository";
import { saveContentProfileWithClient } from "./dropship-listing-content.repository";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import {
  findRuleConversionByKeyWithClient,
  hasRuleConversionWithClient,
  insertRuleConversionWithClient,
} from "./dropship-listing-rule-conversions.writer";
import { readCatalogCategoriesByName } from "./dropship-listing-setting-layers.reader";
import { MAX_LISTING_SETTING_ACTOR_ID_LENGTH, type ListingSettingWriteScope } from "./dropship-listing-setting-shared.repository";
import {
  CATEGORY_LOCK_SQL,
  LISTING_SELECTION_LOCK_SQL,
  PRODUCT_LOCK_SQL,
  REQUEST_LOCK_SQL,
  STORE_LOCK_SQL,
  SYSTEM_OWNER_SQL,
  VARIANT_LOCK_SQL,
  VENDOR_OWNER_SQL,
  guardedClient,
  mapListingSettingDatabaseError,
  mapListingSettingWriteError,
  ownerVendorId,
  readListingRuleProfiles,
  transactionEnded,
} from "./dropship-listing-setting-writes.repository";
import { loadConversionInputsWithClient, type ListingSettingsCostReadFailureReport } from "./dropship-listing-settings.repository";
import { insertFirstCategoryMarksWithClient } from "./dropship-product-category-marks.repository";
import { saveProductListingSettingsPerProductWithClient } from "./dropship-product-listing-settings.repository";
import { savePricingProfileWithClient } from "./dropship-pricing-profile.writer";
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";

/**
 * The rules conversion's one transaction per store (PR 11, plan 7.B.3, D10,
 * D13), for the vendor (11c2) and the system job (11e2). Its own entry point
 * beside the PR 9 wrapper: it does not widen ListingSettingWriteRepository
 * (seven fakes implement it) and does not touch executeForSystem (pinned to
 * have no writers). It takes the wrapper's own locks, statements and guarded
 * client (dropship-listing-setting-writes.repository.ts), in the wrapper's
 * order:
 * 1. BEGIN, READ COMMITTED: every statement after a lock sees what the lock
 *    holder committed;
 * 2. the request lock (`dropship_listing_settings_request`, member:key), the
 *    vendor only (the system's key is one per store, guarded by step 3);
 * 3. the store lock (`dropship_listing_push_job`), as pg_advisory_xact_lock
 *    inside this transaction (CLAUDE.md §9), shared by every writer of a row
 *    this apply reads or writes, and by queue creation;
 * 4. the owner rows FOR SHARE, by member (vendor) or by store (system);
 * then the body, through the transaction object below, which enforces plan
 * 7.B.3's order of reads and writes, each at most once.
 *
 * The body's end decides the end of the transaction: one that wrote commits
 * its record, every write and its store audit row together (a body that wrote
 * without both is refused and rolled back); one that wrote nothing (a replay,
 * nothing to convert, a store the system leaves alone or finds not clean)
 * rolls back, so no answer without a write can commit one. On any failure:
 * ROLLBACK, the original error mapped once (mapListingSettingWriteError: a
 * CHECK or the record's guard is the fatal invariant, a deadlock or a lost
 * connection the transient BUSY), and the client released exactly once.
 *
 * A writer's version conflict under these locks is a broken contract (plan
 * D24): raised as DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED with the
 * writer's code in `context.causeCode`. Repositories do not log; the service
 * does.
 */

type QueryClient = Pick<PoolClient, "query">;

/** int4 keys (store, category, product, size). */
const MAX_INT4_ID = 2_147_483_647;
const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** The store's audit row (plan 7.B.3 step 16): entity, event and actor as every listing-settings audit row names them. */
const STORE_AUDIT_SQL = `INSERT INTO dropship.dropship_audit_events
       (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_store_connection', $3, 'listing_rules_converted', $4, $5, 'info', $6::jsonb, $7)`;

/**
 * The version conflicts of the five writers the apply runs (plan D24). Under
 * the store lock none can happen: every writer of these rows takes it.
 */
const WRITER_VERSION_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT",
  "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
  "DROPSHIP_PRICING_REVIEW_STALE",
  "DROPSHIP_CONTENT_VERSION_CONFLICT",
  "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT",
]);
/** Of a conflict's context, only ids and revisions follow it into the invariant (its words stay the writer's). */
const CONFLICT_CONTEXT_KEYS = ["categoryId", "productId", "expectedRevisionId", "actualRevisionId", "conflictCount"] as const;
/** The per-product writer names each conflicted product (at most 100, its own cap): these fields of each follow it. */
const CONFLICT_ENTRY_KEYS = ["productId", "expectedRevisionId", "actualRevisionId"] as const;
const MAX_CARRIED_CONFLICTS = 100;

/**
 * The transaction's calls in plan 7.B.3's order (D13). Each runs at most
 * once and only after every call before it that it runs with; any may be
 * skipped, but each needs the calls REQUIRES names.
 */
const CALL_ORDER = [
  "authorize", "findConversionByKey", "hasAnyConversion", "loadOlderGroupRuleCounts", "lockSelection", "listChosenIds",
  "lockCatalog", "loadInputs", "insertConversion", "saveCategories", "saveProducts", "savePricingProfile", "saveContentProfile",
  "saveEbayCategoryRules", "insertFirstCategoryMarks", "insertStoreAudit",
] as const;
type ConversionCall = (typeof CALL_ORDER)[number];
/** The writes (steps 11-16): only these make the transaction commit. */
const WRITE_CALLS: ReadonlySet<ConversionCall> = new Set<ConversionCall>([
  "insertConversion", "saveCategories", "saveProducts", "savePricingProfile", "saveContentProfile", "saveEbayCategoryRules",
  "insertFirstCategoryMarks", "insertStoreAudit",
]);
/**
 * What each call needs to have run first: the gate before anything is read,
 * the selection lock before the chosen sizes and the catalog lock, the
 * catalog lock before the inputs, the inputs before the record, and the
 * record (which claims the key) before every other write.
 */
const REQUIRES: Readonly<Partial<Record<ConversionCall, readonly ConversionCall[]>>> = {
  findConversionByKey: ["authorize"],
  hasAnyConversion: ["authorize"],
  loadOlderGroupRuleCounts: ["authorize"],
  lockSelection: ["authorize"],
  // The chosen sizes name the rules' categories from the profiles the older rules' counts read (step 6, under the store lock).
  listChosenIds: ["loadOlderGroupRuleCounts", "lockSelection"],
  lockCatalog: ["lockSelection"],
  loadInputs: ["lockCatalog"],
  insertConversion: ["loadInputs"],
  saveCategories: ["insertConversion"],
  saveProducts: ["insertConversion"],
  savePricingProfile: ["insertConversion"],
  saveContentProfile: ["insertConversion"],
  saveEbayCategoryRules: ["insertConversion"],
  insertFirstCategoryMarks: ["insertConversion"],
  insertStoreAudit: ["insertConversion"],
};

/**
 * The system job's check (PR 11e2, plan 13.3 step 3): the store's owner by
 * the store alone (the system has no member), with no lock, inside the read
 * snapshot (FOR SHARE is refused in a READ ONLY transaction, and the check
 * must hold up no writer, plan 13.8).
 */
const STORE_OWNER_READ_SQL = "SELECT sc.vendor_id FROM dropship.dropship_store_connections sc WHERE sc.id = $1";
/** One snapshot, no lock, as the dry run's own load opens (dropship-listing-settings.repository.ts). */
const READ_SNAPSHOT_BEGIN_SQL = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

/**
 * A failure record's view of the store (PR 11e2, D20): its vendor and the
 * three profile heads its older rules are read from (the readers' own
 * predicate: the head of this store and its vendor), null for a profile the
 * store never saved.
 */
const STORE_HEADS_SQL = `SELECT sc.vendor_id,
    (SELECT p.revision_id FROM dropship.dropship_pricing_profiles p
      WHERE p.store_connection_id = sc.id AND p.vendor_id = sc.vendor_id) AS pricing_revision_id,
    (SELECT p.revision_id FROM dropship.dropship_content_profiles p
      WHERE p.store_connection_id = sc.id AND p.vendor_id = sc.vendor_id) AS content_revision_id,
    (SELECT p.revision_id FROM dropship.dropship_ebay_category_rule_profiles p
      WHERE p.store_connection_id = sc.id AND p.vendor_id = sc.vendor_id) AS ebay_rules_revision_id
  FROM dropship.dropship_store_connections sc WHERE sc.id = $1`;
/**
 * The store's failure audit row (D20): entity the store (the `(entity_type,
 * entity_id)` index the source's exclusion reads), actor the system's run,
 * severity `error`. Written only when no row of the store already names the
 * same planner version and revisions, so a replayed record writes nothing.
 */
const FAILURE_AUDIT_SQL = `INSERT INTO dropship.dropship_audit_events
       (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     SELECT $1::int, $2::int, 'dropship_store_connection', $3::text, $4::text, 'system', $5::text, 'error', $6::jsonb, $7::timestamptz
     WHERE NOT EXISTS (SELECT 1 FROM dropship.dropship_audit_events a
       WHERE a.entity_type = 'dropship_store_connection' AND a.entity_id = $3::text AND a.event_type = $4::text
         AND a.payload->'plannerVersion' = $6::jsonb->'plannerVersion' AND a.payload->'revisions' = $6::jsonb->'revisions')
     RETURNING id`;

export class PgDropshipListingRulesConversionRepository implements ListingRulesConversionRepository, RulesConversionJobRepository {
  constructor(
    private readonly dbPool: Pick<Pool, "connect"> = defaultPool,
    /** Told when the .ops cost read fails inside the load (it goes on, and the body refuses it). */
    private readonly reportCostReadFailure: ListingSettingsCostReadFailureReport = () => undefined,
  ) {}

  async executeConversion<T>(input: ListingRulesConversionExecuteInput,
    operation: (tx: ListingRulesConversionTransaction) => Promise<T>): Promise<T> {
    const opened = openingOf(input);
    let client: PoolClient;
    try {
      client = await this.dbPool.connect();
    } catch (error) {
      // No transaction was opened, so nothing to roll back; a pool timeout or a refused connection is retryable.
      throw mapListingSettingDatabaseError(error);
    }
    let open = true;
    const isOpen = () => open;
    try {
      await client.query("BEGIN");
      if (opened.memberId !== null) await client.query(REQUEST_LOCK_SQL, [`${opened.memberId}:${opened.requestKey}`]);
      await client.query(STORE_LOCK_SQL, [opened.storeConnectionId]);
      const owner = opened.memberId !== null
        ? await client.query<{ vendor_id: unknown }>(VENDOR_OWNER_SQL, [opened.memberId, opened.storeConnectionId])
        : await client.query<{ vendor_id: unknown }>(SYSTEM_OWNER_SQL, [opened.storeConnectionId]);
      const vendorId = ownerVendorId(owner.rows[0], opened.storeConnectionId);
      const state = new ConversionTransactionState(guardedClient(client, isOpen), isOpen, {
        vendorId, storeConnectionId: opened.storeConnectionId, actor: opened.actor, requestKey: opened.requestKey,
      }, this.reportCostReadFailure);
      const result = await operation(state.transaction()).finally(() => { open = false; });
      if (state.wrote()) {
        state.assertComplete();
        await client.query("COMMIT");
      } else {
        // Nothing to commit: a replay, nothing to convert, or a store the system leaves alone.
        await client.query("ROLLBACK");
      }
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw mapListingSettingWriteError(error);
    } finally {
      client.release();
    }
  }

  /**
   * The system job's check of one store (PR 11e2, plan 9.2 `checkForStore`,
   * 13.3 step 3): the dry run's own load (loadConversionInputsWithClient, as
   * GET …/conversion composes it) in one REPEATABLE READ READ ONLY snapshot,
   * with the owner found by the store and no lock of any kind, so a store
   * that is not clean holds up no writer and no queue (plan 13.8). Null when
   * the store is gone. The plan is the caller's (the job service): this
   * reads only. A failed .ops cost read is reported (the constructor's
   * reporter) and comes back in the load. COMMIT, or ROLLBACK on any failure
   * (the read's own failure is the one thrown, mapped once); a connection
   * whose rollback failed is destroyed, never handed back mid-transaction.
   */
  async loadConversionInputsForStore(input: { storeConnectionId: number; now: Date }): Promise<RulesConversionStoreLoad | null> {
    if (!isInt4Id(input.storeConnectionId) || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
      throw listingSettingsInvariantFailed("The rules conversion job's check was asked outside its contract.", {
        invalid: [isInt4Id(input.storeConnectionId) ? null : "storeConnectionId",
          input.now instanceof Date && Number.isFinite(input.now.getTime()) ? null : "now"].filter((field): field is string => field !== null),
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
      await client.query(READ_SNAPSHOT_BEGIN_SQL);
      const owner = (await client.query<{ vendor_id: unknown }>(STORE_OWNER_READ_SQL, [input.storeConnectionId])).rows[0];
      let result: RulesConversionStoreLoad | null = null;
      if (owner !== undefined) {
        const vendorId = ownerVendorId(owner, input.storeConnectionId);
        result = { vendorId, load: await loadConversionInputsWithClient(client,
          { vendorId, storeConnectionId: input.storeConnectionId, now: input.now }, this.reportCostReadFailure) };
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      rollbackFailure = await rollbackQuietly(client);
      throw mapListingSettingDatabaseError(error);
    } finally {
      client.release(rollbackFailure);
    }
  }

  /**
   * A store the job dead-letters (PR 11e2, plan 9.2, 13.3, D20), in one
   * short READ COMMITTED transaction of its own (the conversion's rolled
   * back): recordRulesConversionFailureWithClient, then COMMIT. ROLLBACK and
   * the original error, mapped once, on any failure; released once.
   */
  async recordFailure(input: { storeConnectionId: number; expectedVendorId: number; payload: RulesConversionFailureAudit; now: Date }):
    Promise<RulesConversionFailureRecordOutcome> {
    let client: PoolClient;
    try {
      client = await this.dbPool.connect();
    } catch (error) {
      throw mapListingSettingDatabaseError(error);
    }
    let rollbackFailure: Error | undefined;
    try {
      await client.query("BEGIN");
      const outcome = await recordRulesConversionFailureWithClient(client, input);
      await client.query("COMMIT");
      return outcome;
    } catch (error) {
      rollbackFailure = await rollbackQuietly(client);
      throw mapListingSettingWriteError(error);
    } finally {
      client.release(rollbackFailure);
    }
  }
}

/**
 * The failure record's two statements on the caller's transaction (PR 11e2,
 * D20): the store's vendor and three head revisions now, then one
 * `listing_rules_conversion_failed` audit row naming the planner version and
 * exactly the revisions the failed check or apply was planned from. A head
 * moves only forward (each profile's coherence trigger requires a new
 * revision to follow the current head, migrations 0659, 0660, 0717), so heads
 * equal to the ones the job's list read are the ones the failure read; when
 * any moved, the store's rules changed since, nothing is written, and the
 * job checks the store again next tick with its new rules (re-armed, as D20
 * asks). Inputs are checked before any statement (fatal on a breach).
 */
export async function recordRulesConversionFailureWithClient(client: QueryClient, input: {
  storeConnectionId: number; expectedVendorId: number; payload: RulesConversionFailureAudit; now: Date;
}): Promise<RulesConversionFailureRecordOutcome> {
  const parsed = rulesConversionFailureAuditSchema.safeParse(input.payload);
  if (!isInt4Id(input.storeConnectionId) || !isInt4Id(input.expectedVendorId) || !parsed.success
    || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw listingSettingsInvariantFailed("A rules conversion failure record was asked outside its contract.", {
      storeConnectionId: isInt4Id(input.storeConnectionId) ? input.storeConnectionId : null,
    });
  }
  const payload = parsed.data;
  const store = (await client.query<{ vendor_id: unknown; pricing_revision_id: unknown; content_revision_id: unknown;
    ebay_rules_revision_id: unknown }>(STORE_HEADS_SQL, [input.storeConnectionId])).rows[0];
  if (store === undefined) return "store_gone";
  const heads = storeHeads(store, input.storeConnectionId);
  if (store.vendor_id !== input.expectedVendorId || !sameHeads(heads, payload.revisions)) return "rules_changed";
  const inserted = await client.query(FAILURE_AUDIT_SQL, [input.expectedVendorId, input.storeConnectionId, String(input.storeConnectionId),
    RULES_CONVERSION_FAILED_EVENT, payload.jobKey, JSON.stringify(payload), input.now]);
  return inserted.rows.length === 1 ? "recorded" : "already_recorded";
}

/** The three heads as stored: positive int4 ids or null; anything else breaks the profiles' schema (fatal). */
function storeHeads(row: { pricing_revision_id: unknown; content_revision_id: unknown; ebay_rules_revision_id: unknown },
  storeConnectionId: number): RulesConversionHeadRevisions {
  const parsed = rulesConversionHeadRevisionsSchema.safeParse({
    pricing: row.pricing_revision_id, content: row.content_revision_id, ebayRules: row.ebay_rules_revision_id,
  });
  if (!parsed.success) {
    throw listingSettingsInvariantFailed("A store's profile heads failed their contract.", { storeConnectionId });
  }
  return parsed.data;
}

function sameHeads(left: RulesConversionHeadRevisions, right: RulesConversionHeadRevisions): boolean {
  return left.pricing === right.pricing && left.content === right.content && left.ebayRules === right.ebayRules;
}

/**
 * The read's or the record's own failure is what the caller rethrows; a
 * failed rollback must not replace it. Its error is returned so the
 * connection is destroyed.
 */
async function rollbackQuietly(client: QueryClient): Promise<Error | undefined> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** The PR 9 writers' scope, with the conversion's two actor types only (no admin converts). */
type ConversionScope = Omit<ListingSettingWriteScope, "actor"> & { actor: ListingRulesConversionActor };

interface Opening {
  storeConnectionId: number;
  actor: ListingRulesConversionActor;
  requestKey: string;
  /** The vendor's member (the request lock's and the owner read's), or null for the system. */
  memberId: string | null;
}

/** The service builds these; a breach is a programming fault (fatal), before any connection is taken. */
function openingOf(input: ListingRulesConversionExecuteInput): Opening {
  const invalid: string[] = [];
  if (!isInt4Id(input.storeConnectionId)) invalid.push("storeConnectionId");
  if (input.actorType === "vendor") {
    if (!isActorId(input.memberId)) invalid.push("memberId");
    // A reserved key is the system job's or a conversion child's (plan D12): the apply's schema refuses it first.
    if (typeof input.idempotencyKey !== "string" || !LISTING_SETTING_KEY_PATTERN.test(input.idempotencyKey)
      || isReservedConversionKey(input.idempotencyKey)) invalid.push("idempotencyKey");
  } else if (input.actorType === "system") {
    if (!isActorId(input.jobKey)) invalid.push("jobKey");
  } else {
    invalid.push("actorType");
  }
  if (invalid.length > 0) {
    throw listingSettingsInvariantFailed("A listing rules conversion was opened outside its contract.", { invalid });
  }
  return input.actorType === "vendor"
    ? { storeConnectionId: input.storeConnectionId, actor: { actorType: "vendor", actorId: input.memberId },
      requestKey: input.idempotencyKey, memberId: input.memberId }
    : { storeConnectionId: input.storeConnectionId, actor: { actorType: "system", actorId: input.jobKey },
      requestKey: rulesConversionSystemKey(input.storeConnectionId), memberId: null };
}

/**
 * One conversion's transaction object: which calls ran, which catalog rows
 * it locked (the only rows its writers may touch) and the record's id (every
 * later write names it).
 */
class ConversionTransactionState {
  private readonly called = new Set<ConversionCall>();
  private lastCall = -1;
  private locked: { categoryIds: ReadonlySet<number>; productIds: ReadonlySet<number> } | null = null;
  private conversionId: number | null = null;
  /** The three profiles step 6 read: under the store lock no writer moves them, so step 7 names the rules' categories from them. */
  private ruleProfiles: Awaited<ReturnType<typeof readListingRuleProfiles>> | null = null;

  constructor(
    private readonly client: QueryClient,
    private readonly isOpen: () => boolean,
    private readonly scope: ConversionScope,
    private readonly reportCostReadFailure: ListingSettingsCostReadFailureReport,
  ) {}

  /** Whether the body wrote anything (any of steps 11-16). */
  wrote(): boolean {
    return [...this.called].some((call) => WRITE_CALLS.has(call));
  }

  /** A body that wrote commits only its record together with the store's audit row (step 16 is the last write). */
  assertComplete(): void {
    if (!this.called.has("insertConversion") || !this.called.has("insertStoreAudit")) {
      throw listingSettingsInvariantFailed("A listing rules conversion wrote without its record and its store audit row.", {
        storeConnectionId: this.scope.storeConnectionId,
        calls: CALL_ORDER.filter((call) => this.called.has(call)),
      });
    }
  }

  transaction(): ListingRulesConversionTransaction {
    const { client, scope } = this;
    const target = { vendorId: scope.vendorId, storeConnectionId: scope.storeConnectionId };
    const profileTarget = { ...target, actorId: scope.actor.actorId, actorType: scope.actor.actorType };
    const childKey = (kind: Parameters<typeof listingConversionChildKey>[1], id: number) =>
      listingConversionChildKey(scope.requestKey, kind, id);
    return {
      vendorId: scope.vendorId,
      storeConnectionId: scope.storeConnectionId,
      actor: { ...scope.actor },
      requestKey: scope.requestKey,
      authorize: async () => {
        this.begin("authorize");
        return PgDropshipListingPreviewRepository.readerForTransaction(client).loadStoreContext(target);
      },
      findConversionByKey: async () => {
        this.begin("findConversionByKey");
        return findRuleConversionByKeyWithClient(client, { vendorId: scope.vendorId, idempotencyKey: scope.requestKey });
      },
      hasAnyConversion: async () => {
        this.begin("hasAnyConversion");
        return hasRuleConversionWithClient(client, { storeConnectionId: scope.storeConnectionId });
      },
      loadOlderGroupRuleCounts: async () => {
        this.begin("loadOlderGroupRuleCounts");
        this.ruleProfiles = await readListingRuleProfiles(client, target);
        return olderGroupRuleCounts(this.ruleProfiles);
      },
      lockSelection: async () => {
        this.begin("lockSelection");
        await client.query(LISTING_SELECTION_LOCK_SQL);
      },
      listChosenIds: async (now) => {
        this.begin("listChosenIds");
        if (this.ruleProfiles === null) throw listingSettingsInvariantFailed("A rules conversion named its chosen sizes before its rules.");
        return listChosenIds(client, target, this.ruleProfiles, now);
      },
      lockCatalog: async (input) => {
        this.begin("lockCatalog");
        const locked = await lockCatalog(client, input);
        this.locked = { categoryIds: new Set(locked.categoryIds), productIds: new Set(locked.productIds) };
        return locked;
      },
      loadInputs: async (now) => {
        this.begin("loadInputs");
        return loadConversionInputsWithClient(client, { ...target, now }, this.reportCostReadFailure);
      },
      insertConversion: async (input) => {
        this.begin("insertConversion");
        const record = await insertRuleConversionWithClient(client, {
          ...input, vendorId: scope.vendorId, storeConnectionId: scope.storeConnectionId, idempotencyKey: scope.requestKey,
          actor: { actorType: scope.actor.actorType, actorId: scope.actor.actorId },
        });
        this.conversionId = record.id;
        return record;
      },
      saveCategories: async (input) => {
        this.begin("saveCategories");
        const categories = [...input.categories].sort((left, right) => left.categoryId - right.categoryId);
        this.assertLocked("categoryIds", categories.map((category) => category.categoryId));
        const results: CategoryListingSettingSaveResult[] = [];
        // Ascending ids, one category at a time: the order a Card Shellz rename and W12 lock them.
        for (const category of categories) {
          results.push(await versionConflictAsInvariant("saveCategories", scope.storeConnectionId, () => saveCategoryListingSettingWithClient(client,
            { ...scope, requestKey: childKey("category", category.categoryId) },
            { categoryId: category.categoryId, expectedRevisionId: category.expectedRevisionId, patch: category.patch,
              requestHash: input.requestHash, now: input.now })));
        }
        return results;
      },
      saveProducts: async (input) => {
        this.begin("saveProducts");
        this.assertLocked("productIds", input.products.map((product) => product.productId));
        return versionConflictAsInvariant("saveProducts", scope.storeConnectionId, () => saveProductListingSettingsPerProductWithClient(client, scope, {
          conversionId: this.recordId(), products: input.products, requestHash: input.requestHash, now: input.now,
        }));
      },
      savePricingProfile: async (input) => {
        this.begin("savePricingProfile");
        return versionConflictAsInvariant("savePricingProfile", scope.storeConnectionId, () => savePricingProfileWithClient(client, profileTarget, {
          expectedRevisionId: input.expectedRevisionId, profile: input.profile, conversionId: this.recordId(), now: input.now,
        }));
      },
      saveContentProfile: async (input) => {
        this.begin("saveContentProfile");
        const profile = parsedProfile("content", contentProfileSchema, input.profile, scope.storeConnectionId);
        assertRequestStamp(input.requestHash, input.now, "saveContentProfile");
        return versionConflictAsInvariant("saveContentProfile", scope.storeConnectionId, () => saveContentProfileWithClient(client,
          profileTarget, {
            expectedRevisionId: input.expectedRevisionId, profile, idempotencyKey: childKey("content_profile", scope.storeConnectionId),
          }, input.requestHash, input.now));
      },
      saveEbayCategoryRules: async (input) => {
        this.begin("saveEbayCategoryRules");
        const profile = parsedProfile("ebay_rules", ebayCategoryRulesProfileSchema, input.profile, scope.storeConnectionId);
        assertRequestStamp(input.requestHash, input.now, "saveEbayCategoryRules");
        return versionConflictAsInvariant("saveEbayCategoryRules", scope.storeConnectionId, () => saveEbayCategoryRulesProfileWithClient(client,
          profileTarget, {
            expectedRevisionId: input.expectedRevisionId, profile, idempotencyKey: childKey("ebay_rules", scope.storeConnectionId),
            requestHash: input.requestHash, now: input.now,
          }));
      },
      insertFirstCategoryMarks: async (input) => {
        this.begin("insertFirstCategoryMarks");
        this.assertLocked("productIds", input.productIds);
        // The marks' audit row names the conversion's key as its job and audits the conversion's actor.
        return insertFirstCategoryMarksWithClient(client, { ...target, actor: scope.actor },
          { productIds: input.productIds, jobKey: scope.requestKey, now: input.now });
      },
      insertStoreAudit: async (input) => {
        this.begin("insertStoreAudit");
        const parsed = listingRulesConvertedAuditSchema.safeParse(input.payload);
        if (!parsed.success || parsed.data.conversionId !== this.recordId() || parsed.data.requestKey !== scope.requestKey) {
          throw listingSettingsInvariantFailed("A listing rules conversion's store audit row breaks its contract.", {
            storeConnectionId: scope.storeConnectionId,
          });
        }
        if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
          throw listingSettingsInvariantFailed("A listing rules conversion's store audit row needs the caller's clock.");
        }
        await client.query(STORE_AUDIT_SQL, [scope.vendorId, scope.storeConnectionId, String(scope.storeConnectionId),
          scope.actor.actorType, scope.actor.actorId, JSON.stringify(parsed.data), input.now]);
      },
    };
  }

  /** Plan 7.B.3's order: open, once, after the calls before it, and after what it needs. */
  private begin(call: ConversionCall): void {
    if (!this.isOpen()) throw transactionEnded();
    const index = CALL_ORDER.indexOf(call);
    if (this.called.has(call)) {
      throw listingSettingsInvariantFailed("Each listing rules conversion call runs at most once per transaction.", { call });
    }
    if (index < this.lastCall) {
      throw listingSettingsInvariantFailed("A listing rules conversion call ran out of plan 7.B.3's order.", {
        call, after: CALL_ORDER[this.lastCall],
      });
    }
    const missing = (REQUIRES[call] ?? []).filter((needed) => !this.called.has(needed));
    if (missing.length > 0) {
      throw listingSettingsInvariantFailed("A listing rules conversion call ran before the calls it needs.", { call, missing });
    }
    this.called.add(call);
    this.lastCall = index;
  }

  /** A write touches only catalog rows lockCatalog locked in this transaction. */
  private assertLocked(kind: "categoryIds" | "productIds", ids: readonly number[]): void {
    const locked = this.locked?.[kind];
    if (locked === undefined || !ids.every((id) => locked.has(id))) {
      throw listingSettingsInvariantFailed("A listing rules conversion writes a catalog row it did not lock.", {
        storeConnectionId: this.scope.storeConnectionId, kind,
      });
    }
  }

  private recordId(): number {
    if (this.conversionId === null) throw listingSettingsInvariantFailed("A listing rules conversion wrote before its record.");
    return this.conversionId;
  }
}

/**
 * The chosen sizes, by the read model's own selection (loadSelectedCandidates,
 * refused above 10,000), their products, and the categories to lock: the
 * chosen products' own and every category a rule names (by exact name,
 * active or not, plan D8), which the plan may write though no chosen product
 * is in it, read from the profiles step 6 read. Run under the selection lock, so the selection cannot move.
 */
async function listChosenIds(client: QueryClient, target: { vendorId: number; storeConnectionId: number },
  ruleProfiles: Parameters<typeof conversionCategoryNamesToRead>[0], now: Date) {
  let candidates: DropshipListingCatalogCandidate[];
  try {
    candidates = await loadSelectedCandidates({ vendorId: target.vendorId, ...selectedCatalogReaderForTransaction(client) }, now,
      "listing_settings");
  } catch (error) {
    if (error instanceof DropshipError && error.code === "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") return { state: "too_large" as const };
    throw error;
  }
  const names = conversionCategoryNamesToRead(ruleProfiles);
  const targets = await readCatalogCategoriesByName(client, names);
  const ascending = (ids: Iterable<number>) => [...new Set(ids)].sort((left, right) => left - right);
  return {
    state: "ok" as const,
    productVariantIds: ascending(candidates.map((candidate) => candidate.productVariantId)),
    productIds: ascending(candidates.map((candidate) => candidate.productId)),
    categoryIds: ascending([
      ...candidates.flatMap((candidate) => candidate.categoryId === null ? [] : [candidate.categoryId]),
      ...[...targets.values()].flatMap((categories) => categories.map((category) => category.id)),
    ]),
  };
}

/**
 * Categories, then products, then sizes FOR SHARE, each ascending (the PR 9
 * wrapper's order and statements): a Card Shellz rename, move or size change
 * waits for this commit. Returns what each read found and locked.
 */
async function lockCatalog(client: QueryClient, input: {
  categoryIds: readonly number[]; productIds: readonly number[]; productVariantIds: readonly number[];
}): Promise<{ categoryIds: number[]; productIds: number[]; productVariantIds: number[] }> {
  const lock = async (sql: string, ids: readonly number[], field: string): Promise<number[]> => {
    const asked = lockIds(ids, field);
    if (asked.length === 0) return [];
    const result = await client.query<{ id: unknown }>(sql, [asked]);
    const found = result.rows.map((row) => row.id);
    if (!found.every(isInt4Id)) throw listingSettingsInvariantFailed("A catalog id locked by a listing rules conversion failed its contract.", { field });
    return [...new Set(found as number[])].sort((left, right) => left - right);
  };
  const categoryIds = await lock(CATEGORY_LOCK_SQL, input.categoryIds, "categoryIds");
  const productIds = await lock(PRODUCT_LOCK_SQL, input.productIds, "productIds");
  const productVariantIds = await lock(VARIANT_LOCK_SQL, input.productVariantIds, "productVariantIds");
  return { categoryIds, productIds, productVariantIds };
}

/**
 * Takes no lock (the store lock is taken once, at BEGIN): a writer's version
 * conflict, which that lock rules out (plan D24), becomes the fatal invariant
 * with the writer's code as `causeCode`, so it is logged ERROR and never
 * answered as a conflict a page would retry forever. The conflict's ids and
 * revisions go with it, the per-product writer's `conflicts` list included,
 * so the ERROR line names what conflicted. Every other error passes unchanged.
 */
async function versionConflictAsInvariant<T>(writer: string, storeConnectionId: number, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DropshipError && WRITER_VERSION_CONFLICT_CODES.has(error.code)) {
      const context = error.context ?? {};
      throw listingSettingsInvariantFailed("A listing rules conversion writer found a version conflict under the store lock.", {
        storeConnectionId, writer, causeCode: error.code,
        ...Object.fromEntries(CONFLICT_CONTEXT_KEYS.filter((key) => key in context).map((key) => [key, context[key]])),
        ...(Array.isArray(context.conflicts) ? { conflicts: carriedConflicts(context.conflicts) } : {}),
      });
    }
    throw error;
  }
}

/** Each conflicted row's id and revisions only, at most MAX_CARRIED_CONFLICTS. */
function carriedConflicts(conflicts: readonly unknown[]): Array<Record<string, unknown>> {
  return conflicts.slice(0, MAX_CARRIED_CONFLICTS).map((entry) => {
    const fields = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return Object.fromEntries(CONFLICT_ENTRY_KEYS.filter((key) => key in fields).map((key) => [key, fields[key]]));
  });
}

/** A profile the conversion writes, checked against its own contract before the writer that stores it as given. */
function parsedProfile<T>(kind: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, storeConnectionId: number): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw listingSettingsInvariantFailed("A listing rules conversion's profile breaks its contract.", { storeConnectionId, kind });
  }
  return parsed.data;
}

function assertRequestStamp(requestHash: unknown, now: unknown, writer: string): void {
  const invalid = [
    typeof requestHash === "string" && REQUEST_HASH_PATTERN.test(requestHash) ? null : "requestHash",
    now instanceof Date && Number.isFinite(now.getTime()) ? null : "now",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) {
    throw listingSettingsInvariantFailed("A listing rules conversion write was called outside its contract.", { writer, invalid });
  }
}

/** Positive int4 ids, distinct and ascending, so rows are locked in one order. */
function lockIds(ids: readonly number[], field: string): number[] {
  if (!Array.isArray(ids) || !ids.every(isInt4Id)) {
    throw listingSettingsInvariantFailed("A listing rules conversion locks positive whole-number ids only.", { field });
  }
  return [...new Set(ids)].sort((left, right) => left - right);
}

/** The actor id is stored in varchar(255) actor_id columns and must not be blank. */
function isActorId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_LISTING_SETTING_ACTOR_ID_LENGTH;
}

function isInt4Id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4_ID;
}
