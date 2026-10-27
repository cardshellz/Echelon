import { z } from "zod";

/**
 * PR B's step 1 answer schemas, frozen as they were at origin/main 1ddaf0470
 * (shared/dropship/vendor-selection-changes.ts there, the answers only), so a
 * test can prove what a B page still reads (PLAN-C v4.1 §4.8, TST-9): a B page
 * that replays on a C dyno parses C's answer with these, and a C dyno replays
 * an answer B stored through C's schemas. Never edit this file to follow a
 * later release: it is the old page's contract.
 */

const id = z.number().int().positive().max(2_147_483_647);
const count = z.number().int().nonnegative();
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const B_SELECTION_CHANGE_CAP = 10_000;
const B_SELECTION_CHANGE_SKIPPED_SHOWN = 20;

const storeEffectsSchema = z.object({
  storeConnectionId: id,
  storeName: z.string(),
  platform: z.string(),
  goesToZero: count,
  startsSelling: count,
});

const skippedSchema = z.object({
  count,
  first: z.array(id).max(B_SELECTION_CHANGE_SKIPPED_SHOWN),
}).refine((skipped) => skipped.first.length === Math.min(skipped.count, B_SELECTION_CHANGE_SKIPPED_SHOWN), {
  message: "The named skipped ids are the first of the count.",
});

const plannedFields = {
  toAdd: count,
  toRemove: count,
  alreadySelected: count,
  alreadyNotSelected: count,
  skipped: skippedSchema,
  selectedBefore: count,
  selectedAfter: count,
  cap: z.literal(B_SELECTION_CHANGE_CAP),
  overCapAfter: z.boolean(),
  effects: z.array(storeEffectsSchema),
  effectsHash: sha256Hex,
};

const overCapMatches = (answer: { overCapAfter: boolean; selectedAfter: number; cap: number }) =>
  answer.overCapAfter === answer.selectedAfter > answer.cap;
const OVER_CAP_MATCHES = { message: "overCapAfter must equal selectedAfter > cap." };

export const bSelectionChangePreviewAnswerSchema = z.object({
  headRevisionId: id.nullable(),
  ...plannedFields,
  refused: z.enum(["too_large"]).nullable(),
}).refine(overCapMatches, OVER_CAP_MATCHES);

export const bSelectionChangeAnswerSchema = z.object({
  revisionId: id,
  ...plannedFields,
  confirmedEffectsHash: sha256Hex,
  drifted: z.boolean(),
}).refine(overCapMatches, OVER_CAP_MATCHES).refine((answer) => answer.drifted === (answer.effectsHash !== answer.confirmedEffectsHash), {
  message: "drifted must equal effectsHash !== confirmedEffectsHash.",
});

/** An answer exactly as a B dyno stored it in `result` (no revision id, no PR C field). */
export const B_STORED_ANSWER = Object.freeze({
  toAdd: 1, toRemove: 1, alreadySelected: 1, alreadyNotSelected: 1, skipped: { count: 1, first: [103] },
  selectedBefore: 10, selectedAfter: 10, cap: 10_000, overCapAfter: false,
  effects: [{ storeConnectionId: 22, storeName: "Card corner", platform: "ebay", goesToZero: 1, startsSelling: 1 }],
  effectsHash: "e".repeat(64), confirmedEffectsHash: "e".repeat(64), drifted: false,
});
