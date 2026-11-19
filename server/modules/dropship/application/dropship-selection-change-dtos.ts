import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  SELECTION_CHANGE_ERROR_CODES,
  selectionChangePageVersionSchema,
  selectionChangePreviewRequestSchema,
  selectionChangeRequestSchema,
} from "../../../../shared/dropship/vendor-selection-changes";
import { DropshipError } from "../domain/errors";

/**
 * The server side of the picks save's request contract (PLAN-B v4.1 §8;
 * shared/dropship/vendor-selection-changes.ts): the page version read before
 * the strict body, the strict bodies with their refusals as structured
 * errors, the canonical form of a change (ids unique and ascending) and its
 * request hash. Pure: no clock, no database.
 */

/** Words of the refusals parsed here (PROPOSED; the page shows its own words for these codes). */
export const SELECTION_CHANGE_DTO_WORDS = {
  // PROPOSED (Stage 3/5, step 1 plan S2-5)
  invalidInput: "This save was not valid. Reload the page and try again.",
  // PROPOSED (Stage 3/5, step 1 plan S2-5)
  conflicting: "An item can't be added and removed in the same save.",
} as const;

/** How many conflicting ids a refusal names (the answer and the log line stay small). */
const CONFLICT_IDS_IN_CONTEXT = 20;

/** A change in canonical form: each side's ids unique and ascending, no id on both sides. */
export interface CanonicalSelectionChange {
  clientVersion: number | null;
  expectedRevisionId: number | null;
  addIds: number[];
  removeIds: number[];
}

export interface CanonicalSelectionChangeSave extends CanonicalSelectionChange {
  idempotencyKey: string;
  expectedEffectsHash: string;
  /**
   * PR C (PLAN-C v4.1 §4.6): the preview's end sets, each unique and ascending, and its other entries' hash, as the
   * page echoed them; null when absent (a B page's body, which the save refuses after its replay lookup).
   */
  expectedEnds: { listingIds: number[]; hiddenRemovedIds: number[] } | null;
  expectedOtherEntriesHash: string | null;
}

/**
 * The body's page version, read before the strict schema (§8.1), so a later
 * page's new field never turns into a 400 here. Absent → null. A body that
 * is not an object, or a malformed version, is refused as invalid input.
 */
export function readSelectionChangeClientVersion(body: unknown): number | null {
  const parsed = selectionChangePageVersionSchema.safeParse(body);
  if (!parsed.success) throw invalidInput(parsed.error);
  return parsed.data.clientVersion ?? null;
}

/** The preview's body, strict, in canonical form. */
export function parseSelectionChangePreviewBody(body: unknown): CanonicalSelectionChange {
  const parsed = selectionChangePreviewRequestSchema.safeParse(body);
  if (!parsed.success) throw invalidInput(parsed.error);
  return canonical(parsed.data);
}

/** The save's body, strict, in canonical form; the key is trimmed by its schema. */
export function parseSelectionChangeBody(body: unknown): CanonicalSelectionChangeSave {
  const parsed = selectionChangeRequestSchema.safeParse(body);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { expectedEnds, expectedOtherEntriesHash } = parsed.data;
  return {
    ...canonical(parsed.data),
    idempotencyKey: parsed.data.idempotencyKey,
    expectedEffectsHash: parsed.data.expectedEffectsHash,
    expectedEnds: expectedEnds === undefined ? null : {
      listingIds: uniqueAscending(expectedEnds.listingIds), hiddenRemovedIds: uniqueAscending(expectedEnds.hiddenRemovedIds),
    },
    expectedOtherEntriesHash: expectedOtherEntriesHash ?? null,
  };
}

/**
 * sha256 of the change's canonical form: what makes two sends of one key the
 * same request. The ids are unique and ascending first, so a resend in
 * another order or with a duplicate is the same request; the confirmed
 * effects are part of it, so a key sent again after a new confirm is a
 * conflict, never a silent replay. The page version is not: it says which
 * page sent it, not what it asks. PR C's echo (§4.6) is part of it only when
 * present, so a B body hashes exactly as B stored it.
 */
export function hashSelectionChangeRequest(change: CanonicalSelectionChangeSave): string {
  const canonicalForm = {
    kind: "picks_change",
    expectedRevisionId: change.expectedRevisionId,
    addIds: change.addIds,
    removeIds: change.removeIds,
    expectedEffectsHash: change.expectedEffectsHash,
    ...(change.expectedEnds === null ? {} : { expectedEnds: change.expectedEnds }),
    ...(change.expectedOtherEntriesHash === null ? {} : { expectedOtherEntriesHash: change.expectedOtherEntriesHash }),
  };
  return createHash("sha256").update(JSON.stringify(canonicalForm)).digest("hex");
}

function canonical(body: {
  clientVersion?: number; expectedRevisionId: number | null;
  add: { productVariantIds: readonly number[] }; remove: { productVariantIds: readonly number[] };
}): CanonicalSelectionChange {
  const addIds = uniqueAscending(body.add.productVariantIds);
  const removeIds = uniqueAscending(body.remove.productVariantIds);
  const removed = new Set(removeIds);
  const conflicting = addIds.filter((productVariantId) => removed.has(productVariantId));
  if (conflicting.length > 0) {
    throw new DropshipError(SELECTION_CHANGE_ERROR_CODES.conflicting, SELECTION_CHANGE_DTO_WORDS.conflicting, {
      classification: "permanent",
      retryable: false,
      conflictingCount: conflicting.length,
      productVariantIds: conflicting.slice(0, CONFLICT_IDS_IN_CONTEXT),
    });
  }
  return { clientVersion: body.clientVersion ?? null, expectedRevisionId: body.expectedRevisionId, addIds, removeIds };
}

function uniqueAscending(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

function invalidInput(error: z.ZodError): DropshipError {
  return new DropshipError(SELECTION_CHANGE_ERROR_CODES.invalidInput, SELECTION_CHANGE_DTO_WORDS.invalidInput, {
    classification: "permanent",
    retryable: false,
    // Paths and messages only: the body itself (up to 20,000 ids) is never echoed.
    issues: error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}
