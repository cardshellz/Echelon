import type { PoolClient } from "pg";
import type { z } from "zod";
import {
  CATEGORY_LISTING_SETTING_FIELDS,
  LISTING_SETTING_ACTOR_TYPES,
  LISTING_SETTING_KEY_PATTERN,
  categoryListingSettingPatchSchema,
  categoryListingSettingValuesSchema,
  type CategoryListingSettingPatch,
  type CategoryListingSettingRow,
  type CategoryListingSettingValues,
} from "../../../../shared/dropship/listing-setting-values";
import type {
  CategoryListingSettingSaveInput,
  CategoryListingSettingSaveResult,
} from "../application/dropship-listing-setting-writes";
import { DropshipError } from "../domain/errors";
import {
  EMPTY_CATEGORY_LISTING_SETTING_VALUES,
  applyListingSettingPatch,
  changedListingSettingFields,
  listingSettingsInvariantFailed,
} from "../domain/listing-setting-values";
import {
  CATEGORY_LISTING_SETTING_VALUE_COLUMNS,
  LISTING_SETTING_VALUE_COLUMN_TYPES,
  MAX_LISTING_SETTING_ACTOR_ID_LENGTH,
  categoryListingSettingRowFromColumns,
  categoryValuesToColumns,
  listingSettingsIdempotencyConflict,
  type ListingSettingWriteScope,
  type StoredCategoryListingSettingColumns,
  type StoredListingSettingRevisionColumns,
} from "./dropship-listing-setting-shared.repository";

/**
 * A vendor's listing settings for one Card Shellz category (W12, plan PR 8a
 * section 3.8; migration 0737). Keyed by catalog.product_categories.id, never
 * by name: the revision keeps the name at save for the audit trail, readers
 * show the live one (plan D19).
 *
 * Every function takes the caller's transaction client and assumes the caller
 * holds the locks of plan 3.9 (request key, store, owner rows, and the category
 * FOR SHARE through lockCatalog). The only lock taken here is FOR UPDATE on the
 * category's own current row. Repositories do not log; PR 9's services do.
 *
 * Not here (plan D28, D29): price checks and authorization. A category price
 * change goes through W7 (PR 9); "Also clear theirs" is one saveProductsBulk
 * call in the same transaction.
 */

type QueryClient = Pick<PoolClient, "query">;

/** int4 keys (category, revision, store, vendor). */
const MAX_INT4 = 2_147_483_647;
const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/;
/** Issue paths and codes only: a vendor's own text never goes into an error. */
const MAX_REPORTED_ISSUES = 10;

/** The revision's value columns, in table order (0737), as the joined `r.` columns. */
const REVISION_VALUE_COLUMNS_SQL = CATEGORY_LISTING_SETTING_VALUE_COLUMNS.map((column) => `r.${column}`).join(", ");

const REVISION_INSERT_COLUMNS = [
  "vendor_id", "store_connection_id", "category_id", "category_name", "previous_revision_id",
  ...CATEGORY_LISTING_SETTING_VALUE_COLUMNS,
  "idempotency_key", "request_hash", "actor_type", "actor_id", "created_at",
] as const;
type RevisionInsertColumn = (typeof REVISION_INSERT_COLUMNS)[number];

/**
 * A category save is one row, so values go as parameters. jsonb columns take
 * JSON text with a cast: node-postgres would send a JS array as a PostgreSQL
 * array.
 */
const REVISION_INSERT_SQL = `INSERT INTO dropship.dropship_category_listing_setting_revisions
     (${REVISION_INSERT_COLUMNS.join(", ")})
   VALUES (${REVISION_INSERT_COLUMNS.map((column, index) => `$${index + 1}${isJsonbColumn(column) ? "::jsonb" : ""}`).join(", ")})
   RETURNING id`;

type CurrentCategorySettingRow = StoredCategoryListingSettingColumns & StoredListingSettingRevisionColumns & {
  category_id: unknown;
};
type CategorySettingRevisionRow = CurrentCategorySettingRow & {
  store_connection_id: unknown;
  category_name: unknown;
  request_hash: unknown;
};

/**
 * Current rows by category id; a category with no row is absent. Empty ids
 * read nothing. `forUpdate` locks the rows found, and only then does the lock
 * text appear (the listing-settings load is read-only).
 */
export async function readCategoryListingSettings(
  client: QueryClient,
  input: { vendorId: number; storeConnectionId: number; categoryIds: readonly number[]; forUpdate?: boolean },
): Promise<Map<number, CategoryListingSettingRow>> {
  const categoryIds = distinctIds(input.categoryIds, "categoryIds");
  const settings = new Map<number, CategoryListingSettingRow>();
  if (categoryIds.length === 0) return settings;
  const result = await client.query<CurrentCategorySettingRow>(
    `SELECT s.category_id, s.revision_id, ${REVISION_VALUE_COLUMNS_SQL}, r.created_at
     FROM dropship.dropship_category_listing_settings s
     JOIN dropship.dropship_category_listing_setting_revisions r ON r.id = s.revision_id
       AND r.vendor_id = s.vendor_id AND r.store_connection_id = s.store_connection_id AND r.category_id = s.category_id
     WHERE s.vendor_id = $1 AND s.store_connection_id = $2 AND s.category_id = ANY($3::int[])
     ORDER BY s.category_id${input.forUpdate === true ? " FOR UPDATE OF s" : ""}`,
    [input.vendorId, input.storeConnectionId, categoryIds],
  );
  for (const row of result.rows) {
    const setting = categoryListingSettingRowFromColumns(input.storeConnectionId, row);
    settings.set(setting.categoryId, setting);
  }
  return settings;
}

/**
 * One category, compare-and-set on its current revision (W12). Absent key =
 * keep, null = use the store default, value = set. A change that sets what is
 * already stored writes nothing and answers `unchanged` (plan D12).
 */
export async function saveCategoryListingSettingWithClient(
  client: QueryClient,
  scope: ListingSettingWriteScope,
  input: CategoryListingSettingSaveInput,
): Promise<CategoryListingSettingSaveResult> {
  const patch = parseSaveInput(scope, input);

  // 1. Replay the revision this key wrote, never re-evaluate it (the W9 rule).
  const replay = await findRevisionByKey(client, scope);
  if (replay) return replayResult(scope, input, replay);

  // 2. The category as Card Shellz names it now. lockCatalog holds the row FOR
  // SHARE, so a rename waits for this commit and the stored name is the
  // committed one.
  const categoryName = await readCatalogCategoryName(client, input.categoryId);

  // 3. Compare and set before any write.
  const before = (await readCategoryListingSettings(client, {
    vendorId: scope.vendorId, storeConnectionId: scope.storeConnectionId, categoryIds: [input.categoryId], forUpdate: true,
  })).get(input.categoryId) ?? null;
  const actualRevisionId = before?.revisionId ?? null;
  if (actualRevisionId !== input.expectedRevisionId) {
    throw new DropshipError(
      "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT",
      "This category's listing settings changed after you opened them. Reload them before saving again.",
      {
        categoryId: input.categoryId, expectedRevisionId: input.expectedRevisionId, actualRevisionId,
        retryable: false, classification: "permanent",
      },
    );
  }

  // 4. Merge. No row reads as every setting following the store default.
  const after = parseValues(applyListingSettingPatch(before?.values ?? EMPTY_CATEGORY_LISTING_SETTING_VALUES, patch));
  const changedFields = changedListingSettingFields(before?.values ?? null, after, CATEGORY_LISTING_SETTING_FIELDS);
  if (changedFields.length === 0) {
    return { outcome: "unchanged", row: before, before, changedFields: [], categoryName };
  }

  // 5. Revision, current row, audit: one commit or none.
  const revisionId = await insertRevision(client, scope, {
    categoryId: input.categoryId, categoryName, previousRevisionId: actualRevisionId, values: after,
    requestHash: input.requestHash, now: input.now,
  });
  // The coherence trigger (0737) refuses a revision whose predecessor is not the current row.
  await client.query(
    `INSERT INTO dropship.dropship_category_listing_settings (vendor_id, store_connection_id, category_id, revision_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (store_connection_id, category_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`,
    [scope.vendorId, scope.storeConnectionId, input.categoryId, revisionId],
  );
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
       (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_category_listing_setting', $3, 'category_listing_settings_saved', $4, $5, 'info', $6::jsonb, $7)`,
    [scope.vendorId, scope.storeConnectionId, String(input.categoryId), scope.actor.actorType, scope.actor.actorId,
      JSON.stringify({
        requestKey: scope.requestKey, revisionId, previousRevisionId: actualRevisionId, categoryName,
        before: before?.values ?? null, after, changedFields,
      }), input.now],
  );
  return {
    outcome: "changed",
    row: {
      storeConnectionId: scope.storeConnectionId, categoryId: input.categoryId, revisionId,
      updatedAt: input.now.toISOString(), values: after,
    },
    before,
    changedFields,
    categoryName,
  };
}

/** A Card Shellz category that does not exist (anymore): permanent, never retried. */
export function listingSettingsCategoryNotFound(categoryId?: number): DropshipError {
  return new DropshipError("DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", "This Card Shellz category was not found.", {
    ...(categoryId === undefined ? {} : { categoryId }), retryable: false, classification: "permanent",
  });
}

async function findRevisionByKey(client: QueryClient, scope: ListingSettingWriteScope): Promise<CategorySettingRevisionRow | null> {
  const result = await client.query<CategorySettingRevisionRow>(
    `SELECT r.id AS revision_id, r.store_connection_id, r.category_id, r.category_name, r.request_hash,
            ${REVISION_VALUE_COLUMNS_SQL}, r.created_at
     FROM dropship.dropship_category_listing_setting_revisions r
     WHERE r.vendor_id = $1 AND r.idempotency_key = $2`,
    [scope.vendorId, scope.requestKey],
  );
  return result.rows[0] ?? null;
}

/**
 * The stored revision as the row. A replay does not rebuild the first answer's
 * `before` and `changedFields`: the page re-reads after any save (PR 7 D9).
 */
function replayResult(
  scope: ListingSettingWriteScope,
  input: CategoryListingSettingSaveInput,
  replay: CategorySettingRevisionRow,
): CategoryListingSettingSaveResult {
  const mismatched = [
    replay.store_connection_id !== scope.storeConnectionId ? "storeConnectionId" : null,
    replay.category_id !== input.categoryId ? "categoryId" : null,
    replay.request_hash !== input.requestHash ? "requestHash" : null,
  ].filter((field): field is string => field !== null);
  if (mismatched.length > 0) throw listingSettingsIdempotencyConflict({ mismatched });
  const row = categoryListingSettingRowFromColumns(scope.storeConnectionId, replay);
  return {
    outcome: "replayed", row, before: null, changedFields: [],
    categoryName: storedCategoryName(replay.category_name, input.categoryId),
  };
}

async function readCatalogCategoryName(client: QueryClient, categoryId: number): Promise<string> {
  const result = await client.query<{ id: unknown; name: unknown }>(
    "SELECT id, name FROM catalog.product_categories WHERE id = $1",
    [categoryId],
  );
  const category = result.rows[0];
  if (!category) throw listingSettingsCategoryNotFound(categoryId);
  return storedCategoryName(category.name, categoryId);
}

/** The revision's name CHECK refuses a blank name; refusing it here names the category instead of a raw 23514. */
function storedCategoryName(name: unknown, categoryId: number): string {
  if (typeof name === "string" && name.trim() !== "") return name;
  throw listingSettingsInvariantFailed("A Card Shellz category name is blank or not text.", { categoryId });
}

async function insertRevision(
  client: QueryClient,
  scope: ListingSettingWriteScope,
  revision: {
    categoryId: number; categoryName: string; previousRevisionId: number | null; values: CategoryListingSettingValues;
    requestHash: string; now: Date;
  },
): Promise<number> {
  const columns = categoryValuesToColumns(revision.values);
  const values: Record<RevisionInsertColumn, unknown> = {
    vendor_id: scope.vendorId,
    store_connection_id: scope.storeConnectionId,
    category_id: revision.categoryId,
    category_name: revision.categoryName,
    previous_revision_id: revision.previousRevisionId,
    ...columns,
    idempotency_key: scope.requestKey,
    request_hash: revision.requestHash,
    actor_type: scope.actor.actorType,
    actor_id: scope.actor.actorId,
    created_at: revision.now,
  };
  const result = await client.query<{ id: unknown }>(
    REVISION_INSERT_SQL,
    REVISION_INSERT_COLUMNS.map((column) => sqlParameter(column, values[column])),
  );
  const revisionId = result.rows[0]?.id;
  if (typeof revisionId !== "number" || !isId(revisionId)) {
    throw listingSettingsInvariantFailed("The category listing setting revision insert returned no identity.");
  }
  return revisionId;
}

/** SQL NULL stays NULL: JSON.stringify(null) is the jsonb value null, which the all-or-none CHECKs count as set. */
function sqlParameter(column: RevisionInsertColumn, value: unknown): unknown {
  if (value === null || !isJsonbColumn(column)) return value;
  return JSON.stringify(value);
}

function isJsonbColumn(column: string): boolean {
  return (LISTING_SETTING_VALUE_COLUMN_TYPES as Readonly<Record<string, string>>)[column] === "jsonb";
}

/**
 * The writer contract, checked before any SQL. PR 9's routes validate input
 * first, so a breach here is a programming fault (fatal), never the vendor's.
 * The patch is parsed so its texts are normalized as the stored contract says.
 */
function parseSaveInput(scope: ListingSettingWriteScope, input: CategoryListingSettingSaveInput): CategoryListingSettingPatch {
  const invalid = [
    ...scopeProblems(scope),
    isId(input.categoryId) ? null : "categoryId",
    input.expectedRevisionId === null || isId(input.expectedRevisionId) ? null : "expectedRevisionId",
    typeof input.requestHash === "string" && REQUEST_HASH_PATTERN.test(input.requestHash) ? null : "requestHash",
    input.now instanceof Date && Number.isFinite(input.now.getTime()) ? null : "now",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) {
    throw listingSettingsInvariantFailed("A category listing setting save breaks the writer contract.", { invalid });
  }
  const patch = categoryListingSettingPatchSchema.safeParse(input.patch);
  if (!patch.success) {
    throw listingSettingsInvariantFailed("A category listing setting change failed its contract.", { issues: issuesOf(patch.error) });
  }
  return patch.data;
}

/** Stored values and a parsed patch always merge into valid values; parsing again keeps that a checked fact. */
function parseValues(values: CategoryListingSettingValues): CategoryListingSettingValues {
  const parsed = categoryListingSettingValuesSchema.safeParse(values);
  if (parsed.success) return parsed.data;
  throw listingSettingsInvariantFailed("Merged category listing setting values failed their contract.", { issues: issuesOf(parsed.error) });
}

function scopeProblems(scope: ListingSettingWriteScope): Array<string | null> {
  return [
    isId(scope.vendorId) ? null : "vendorId",
    isId(scope.storeConnectionId) ? null : "storeConnectionId",
    typeof scope.requestKey === "string" && LISTING_SETTING_KEY_PATTERN.test(scope.requestKey) ? null : "requestKey",
    (LISTING_SETTING_ACTOR_TYPES as readonly string[]).includes(scope.actor.actorType) ? null : "actorType",
    typeof scope.actor.actorId === "string" && scope.actor.actorId.trim() !== ""
      && scope.actor.actorId.length <= MAX_LISTING_SETTING_ACTOR_ID_LENGTH ? null : "actorId",
  ];
}

/** Distinct positive int4 ids, ascending; anything else is a programming fault. */
function distinctIds(ids: readonly number[], field: string): number[] {
  if (!ids.every(isId)) throw listingSettingsInvariantFailed("Listing setting ids must be positive whole numbers.", { field });
  return [...new Set(ids)].sort((left, right) => left - right);
}

function isId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4;
}

function issuesOf(error: z.ZodError): Array<{ path: string; code: string }> {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
}
