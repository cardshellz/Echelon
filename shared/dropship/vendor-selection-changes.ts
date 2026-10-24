import { z } from "zod";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "./catalog-scope";
import {
  DROPSHIP_CATALOG_READ_ERROR_CODES,
  DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON,
  dropshipPageVersionBodySchema,
} from "./vendor-catalog-reads";

/**
 * Route contracts of step 1's one-time picks save (step 1 plan S2-5, PR B;
 * PLAN-B v4.1 §8): `POST /api/dropship/catalog/selection/changes/preview`
 * and `POST /api/dropship/catalog/selection/changes`. The server parses every
 * answer with these schemas before it sends it, and the page parses the same
 * schemas when it reads one, so a field that changes on one side fails on both.
 *
 * Requests are strict: an unknown field is refused (400), never ignored. The
 * page version (`clientVersion`) is read first with a passthrough schema
 * (`selectionChangePageVersionSchema`), so a later page's field never turns
 * into a 400 on this server: a newer page is answered 503 "try again" first.
 * Answers are not strict: a field a later release adds is dropped, never
 * refused, so a page left open across a release keeps working; a field the
 * page needs that is missing still fails (CHK7; review DUX13).
 *
 * A change is the vendor's one press of "Save changes": the sizes to add and
 * the sizes to remove, by catalog size id. Nothing is added by itself later.
 */

/** Ids per side of one change: the selection cap (shared/dropship/catalog-scope.ts). 20,000 ids are about 140 KB. */
export const MAX_SELECTION_CHANGE_IDS = MAX_NAMED_CATALOG_GROUP_ITEMS;
/** The most selected sizes a change may grow the selection to (removing is always allowed, §7.4). */
export const SELECTION_CHANGE_CAP = MAX_NAMED_CATALOG_GROUP_ITEMS;
/** Skipped ids an answer names (the rest are counted). */
export const SELECTION_CHANGE_SKIPPED_SHOWN = 20;

/** Every code the two routes answer with, besides the account codes every catalog route shares (§14). */
export const SELECTION_CHANGE_ERROR_CODES = {
  invalidInput: "DROPSHIP_SELECTION_CHANGE_INVALID_INPUT",
  conflicting: "DROPSHIP_SELECTION_CHANGE_CONFLICTING",
  keyReserved: "DROPSHIP_IDEMPOTENCY_KEY_RESERVED",
  keyConflict: "DROPSHIP_IDEMPOTENCY_CONFLICT",
  revisionConflict: "DROPSHIP_SELECTION_REVISION_CONFLICT",
  effectsChanged: "DROPSHIP_SELECTION_EFFECTS_CHANGED",
  /** 409, transient: the server retried a held gate, a lock wait, a deadlock or a serialization failure, and gave up for now. */
  busy: "PUBLICATION_SELECTION_BUSY",
  tooLarge: "DROPSHIP_SELECTION_TOO_LARGE",
  writesPaused: DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused,
  rulesRetired: DROPSHIP_CATALOG_READ_ERROR_CODES.rulesRetired,
  /** 413 from the bulk body parser (dropship-bulk-json.middleware.ts). */
  requestTooLarge: "DROPSHIP_REQUEST_TOO_LARGE",
  /** 409 from PR C's server only: a B page saving there is told to reload. */
  pageOutdated: "DROPSHIP_SELECTION_PAGE_OUTDATED",
} as const;

/** Why picks writes answer 503 `DROPSHIP_SELECTION_WRITES_PAUSED` (transient; `Retry-After: 5`). */
export const SELECTION_WRITES_PAUSED_REASONS = [
  /** A process of an older catalog code version reported recently, or this version is not yet settled (§10). */
  "older_version_running",
  /** The kill switch DROPSHIP_SELECTION_PICKS_WRITES_DISABLED is "true" (§4.4). */
  "disabled",
  DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON,
] as const;
export type SelectionWritesPausedReason = (typeof SELECTION_WRITES_PAUSED_REASONS)[number];

const id = z.number().int().positive().max(2_147_483_647);
const count = z.number().int().nonnegative();
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const idList = z.array(id).max(MAX_SELECTION_CHANGE_IDS);
const side = z.object({ productVariantIds: idList }).strict();

/** The same bounds as every other dropship request key (dropship-selection-dtos.ts, listing-push-runs.ts). */
export const selectionChangeIdempotencyKeySchema = z.string().trim().min(8).max(200);

/**
 * Only the page version, read before the strict body (§8.1): optional, a whole
 * number ≥ 1; every other field passes through untouched. One schema for every
 * step 1 POST (the acknowledge body reads it too, SAFETY-13).
 */
export const selectionChangePageVersionSchema = dropshipPageVersionBodySchema;

const changeFields = {
  clientVersion: z.number().int().positive().optional(),
  /** The head selection revision the page counted from; null when the vendor never saved one. */
  expectedRevisionId: id.nullable(),
  add: side,
  remove: side,
};

function atLeastOneId(body: { add: { productVariantIds: readonly number[] }; remove: { productVariantIds: readonly number[] } }): boolean {
  return body.add.productVariantIds.length + body.remove.productVariantIds.length > 0;
}
const AT_LEAST_ONE_ID = { message: "A change adds or removes at least one item.", path: ["add"] };

/** `POST …/selection/changes/preview`: what a change would do, written nowhere. */
export const selectionChangePreviewRequestSchema = z.object(changeFields).strict().refine(atLeastOneId, AT_LEAST_ONE_ID);
export type SelectionChangePreviewRequest = z.infer<typeof selectionChangePreviewRequestSchema>;

/**
 * `POST …/selection/changes`: the preview's body, the request key (sent again
 * unchanged on every retry) and the effects the vendor confirmed.
 */
export const selectionChangeRequestSchema = z.object({
  ...changeFields,
  idempotencyKey: selectionChangeIdempotencyKeySchema,
  expectedEffectsHash: sha256Hex,
}).strict().refine(atLeastOneId, AT_LEAST_ONE_ID);
export type SelectionChangeRequest = z.infer<typeof selectionChangeRequestSchema>;

/** What a change does on one of the vendor's stores (PR C adds `ends`). Between PR B and PR C a removal only sets quantity 0. */
export const selectionChangeStoreEffectsSchema = z.object({
  storeConnectionId: id,
  storeName: z.string(),
  platform: z.string(),
  /** Listings that sell now and are set to quantity 0. */
  goesToZero: count,
  /** Listings that get their quantity back shortly after the save. */
  startsSelling: count,
});
export type SelectionChangeStoreEffects = z.infer<typeof selectionChangeStoreEffectsSchema>;

/** Added sizes Card Shellz does not offer now: counted, the first few named. */
export const selectionChangeSkippedSchema = z.object({
  count,
  first: z.array(id).max(SELECTION_CHANGE_SKIPPED_SHOWN),
}).refine((skipped) => skipped.first.length === Math.min(skipped.count, SELECTION_CHANGE_SKIPPED_SHOWN), {
  message: "The named skipped ids are the first of the count.",
});

const plannedFields = {
  /** Sizes this change picks / unpicks. */
  toAdd: count,
  toRemove: count,
  /** Added sizes already picked, and removed sizes not picked: nothing to write for them. */
  alreadySelected: count,
  alreadyNotSelected: count,
  skipped: selectionChangeSkippedSchema,
  /** Selected sizes (picked and offered now) before and after the change. */
  selectedBefore: count,
  selectedAfter: count,
  cap: z.literal(SELECTION_CHANGE_CAP),
  overCapAfter: z.boolean(),
  /** Every store of the vendor, ascending by id, zero counts included. */
  effects: z.array(selectionChangeStoreEffectsSchema),
  effectsHash: sha256Hex,
};

const overCapMatches = (answer: { overCapAfter: boolean; selectedAfter: number; cap: number }) =>
  answer.overCapAfter === answer.selectedAfter > answer.cap;
const OVER_CAP_MATCHES = { message: "overCapAfter must equal selectedAfter > cap." };

/**
 * The preview's answer. `headRevisionId` is the vendor's head selection
 * revision now: when it is not the page's `expectedRevisionId`, the page
 * re-reads before it saves (not an error). `refused: "too_large"` when the
 * change would grow the selection past the cap; the save would answer 422.
 */
export const selectionChangePreviewAnswerSchema = z.object({
  headRevisionId: id.nullable(),
  ...plannedFields,
  refused: z.enum(["too_large"]).nullable(),
}).refine(overCapMatches, OVER_CAP_MATCHES);
export type SelectionChangePreviewAnswer = z.infer<typeof selectionChangePreviewAnswerSchema>;

/**
 * The save's answer, stored with its revision and sent again unchanged for a
 * replay of the same key (200; the first answer is 201). `effects` are the
 * effects recomputed at the save; when they differ from what the vendor
 * confirmed (a change with no adds proceeds, §7.5) `drifted` is true and both
 * hashes are named.
 */
export const selectionChangeAnswerSchema = z.object({
  revisionId: id,
  ...plannedFields,
  confirmedEffectsHash: sha256Hex,
  drifted: z.boolean(),
}).refine(overCapMatches, OVER_CAP_MATCHES).refine((answer) => answer.drifted === (answer.effectsHash !== answer.confirmedEffectsHash), {
  message: "drifted must equal effectsHash !== confirmedEffectsHash.",
});
export type SelectionChangeAnswer = z.infer<typeof selectionChangeAnswerSchema>;
