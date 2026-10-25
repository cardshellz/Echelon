import { z } from "zod";
import {
  SELECTION_CHANGE_CAP,
  SELECTION_CHANGE_ERROR_CODES,
  SELECTION_CHANGE_SKIPPED_SHOWN,
  selectionChangeAnswerSchema,
  type SelectionChangeAnswer,
  type SelectionChangePreviewAnswer,
  type SelectionWritesPausedReason,
} from "../../../../shared/dropship/vendor-selection-changes";
import { CATALOG_READ_WORDS } from "../domain/catalog-read-words";
import { NEW_VERSION_SETTLE_MS, OLDER_PROCESS_GRACE_MS } from "../domain/catalog-code-version";
import { DropshipError } from "../domain/errors";
import { isReservedSelectionIdempotencyKey } from "../domain/selection-release";
import {
  planSelectionChange,
  refuseGrowthOverCap,
  selectedCountAfterChange,
  type SelectionChangePlan,
} from "../domain/vendor-selection-change";
import {
  compareSelectionEffects,
  decideSelectionEffects,
  type DecideSelectionEffectsInput,
  type SelectionEffects,
  type SelectionEffectsComparison,
} from "../domain/vendor-selection-effects";
import {
  hashSelectionChangeRequest,
  parseSelectionChangeBody,
  parseSelectionChangePreviewBody,
  type CanonicalSelectionChange,
  type CanonicalSelectionChangeSave,
} from "./dropship-selection-change-dtos";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";

/**
 * Step 1's one-time picks save (step 1 plan S2-5, PR B; PLAN-B v4.1 §8.2,
 * §8.3, §10, §14): the preview of a change and the change itself. The vendor
 * sends the sizes to add and to remove; the server plans the writes from the
 * picks and Card Shellz's offer as they are now, counts what stock
 * publication will do on each of the vendor's stores, and writes the picks
 * in one transaction under the vendor's selection lock.
 *
 * The save's order, each step a call on the transaction so a test can see it
 * (§8.3): the vendor lock (taken by the repository as the transaction's first
 * statement) → replay by key → the writes readiness gate → the head revision
 * → the plan, the cap, the effects and the drift rule (read only) → the
 * revision and audit rows (ungated) → the pre-lock of the sizes to insert →
 * the picks writes (the first takes the publication selection gate, held to
 * COMMIT). A held gate, a lock wait, a deadlock, a serialization failure or a
 * plan that moved under the transaction rolls the whole attempt back and is
 * retried here, up to SELECTION_SAVE_ATTEMPTS times; then the vendor is told
 * "busy" (409, transient) and the page retries with the same key.
 */

/** Attempts of one save in one request (§8.3; V22). */
export const SELECTION_SAVE_ATTEMPTS = 4;
/** The wait before each retry, ±SELECTION_SAVE_RETRY_JITTER, from a seeded source so a test is reproducible. */
export const SELECTION_SAVE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([250, 500, 1_000]);
export const SELECTION_SAVE_RETRY_JITTER = 0.5;
/**
 * The catalog code version that writes picks (PR B). Picks writes stay closed
 * while a process of an older version reported within the grace, and until
 * this version first ran a settle ago (§10; CHK10): an A worker plans stock
 * from the frozen rules, so a picks change it never re-plans would be lost.
 */
export const PICKS_WRITES_CODE_VERSION = 2;
/** The kill switch (§4.4): read as `=== "true"`; anything else keeps writes open by the gate alone. */
export const SELECTION_PICKS_WRITES_DISABLED_ENV = "DROPSHIP_SELECTION_PICKS_WRITES_DISABLED";

/**
 * The internal code of a plan that moved between the read and the write (a
 * size deleted by a catalog delete, a row count off): the attempt rolls back
 * and is planned again. Transient; never answered (§14).
 */
export const SELECTION_CHANGE_PLAN_MOVED = "DROPSHIP_SELECTION_CHANGE_PLAN_MOVED";

/** SQLSTATEs a save retries (V22): lock not available (a held gate or a lock wait), deadlock, serialization failure. */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["55P03", "40P01", "40001"]);

export const SELECTION_CHANGE_WORDS = {
  /** A's busy words (publication-selection-work.ts), so both releases say the same. */
  busy: "A stock update is finishing. Your selection was not saved; retry it in a moment.",
  // PROPOSED (Stage 3/5, step 1 plan S2-5)
  paused: "Saving is paused for a few minutes while Card Shellz updates the site. Your changes are kept, and saving will try again by itself.",
  // PROPOSED (Stage 3/5, step 1 plan S2-5)
  stale: "Your saved choices changed after this page loaded. Review them and save again.",
  // PROPOSED (Stage 3/5, step 1 plan S2-5)
  effectsChanged: "Something on eBay changed while you were deciding. Check the new numbers and save again.",
  // PROPOSED (Stage 3/5, step 1 plan S2-5)
  keyConflict: "This save's request key was already used for a different change. Press Save again.",
  /** §13 overCapAdd, with the count filled in. */
  tooLarge: (after: number) =>
    // PROPOSED (Stage 3/5, step 1 plan S2-5)
    `This would make ${after.toLocaleString("en-US")} selected, over the 10,000 limit. Undo some additions to save.`,
  // PROPOSED (Stage 3/5, step 1 plan S2-5)
  planMoved: "The catalog changed while this save was being written; it is planned again.",
  keyReserved: CATALOG_READ_WORDS.keyReserved,
} as const;

/** The effects facts of the touched sizes (dropship-selection-effects.reader.ts reads them). */
export type SelectionChangeEffectsFacts = Pick<DecideSelectionEffectsInput, "candidates" | "adminRules" | "overrides" | "stores">;

/**
 * Everything a change is planned from. The preview reads it in one snapshot;
 * the save reads it one statement at a time at READ COMMITTED, so
 * `selectedBefore` and `pickCountBefore` count the touched sizes from
 * `pickedBefore` and `offered` (selectedCountBeforeChange), and a catalog
 * change between the reads can never make a count disagree with the plan
 * (SRV-1).
 */
export interface SelectionChangePlanFacts {
  /** The vendor's picks among the touched sizes. */
  pickedBefore: ReadonlySet<number>;
  /** The touched sizes Card Shellz offers now: sellable, exposed by the admin rules, not turned off for the vendor. */
  offered: ReadonlySet<number>;
  /** Selected sizes before the change (picked and offered now), over the vendor's whole selection: never fewer than the touched sizes in both `pickedBefore` and `offered`. */
  selectedBefore: number;
  /** The vendor's pick rows before the change, offered or not (the revision's `pick_count` after it): the touched ones are `pickedBefore`. */
  pickCountBefore: number;
  effects: SelectionChangeEffectsFacts;
}

/** The reads of a preview and of a save, in the caller's snapshot. */
export interface DropshipSelectionChangeReads {
  readHeadRevisionId(input: { vendorId: number }): Promise<number | null>;
  readPlanFacts(input: { vendorId: number; touchedIds: readonly number[]; now: Date }): Promise<SelectionChangePlanFacts>;
}

/** A revision found by the request key. `result` is the stored answer of a picks change (null for any other kind). */
export interface StoredSelectionChangeRevision {
  revisionId: number;
  requestHash: string;
  requestKind: string;
  result: unknown;
}

export interface SelectionChangeRevisionInsert {
  vendorId: number;
  idempotencyKey: string;
  requestHash: string;
  actor: { actorType: "vendor"; actorId: string };
  /** The vendor's pick rows after the change. */
  pickCount: number;
  /** The answer without its revision id (the row's own id), for an exact replay. */
  result: Omit<SelectionChangeAnswer, "revisionId">;
  now: Date;
}

export interface SelectionChangeAuditInsert {
  vendorId: number;
  revisionId: number;
  actor: { actorType: "vendor"; actorId: string };
  payload: Record<string, unknown>;
  now: Date;
}

/** One save's transaction. The repository has already begun it and taken the vendor's selection lock. */
export interface DropshipSelectionChangeTransaction extends DropshipSelectionChangeReads {
  findRevisionByKey(input: { vendorId: number; idempotencyKey: string }): Promise<StoredSelectionChangeRevision | null>;
  /** The release readiness reads (HBR): an older process reported within the grace; this version first ran a settle ago. */
  readWritesGate(input: { version: number; graceMs: number; settleMs: number }): Promise<{
    olderVersionLive: boolean; versionSettled: boolean;
  }>;
  insertRevision(input: SelectionChangeRevisionInsert): Promise<number>;
  insertAudit(input: SelectionChangeAuditInsert): Promise<void>;
  /** `FOR KEY SHARE` on the sizes to insert, ascending: the ids that still exist (a deleted size is missing). */
  preLockVariants(input: { productVariantIds: readonly number[] }): Promise<number[]>;
  /** Gated. Returns the rows deleted. */
  deletePicks(input: { vendorId: number; productVariantIds: readonly number[] }): Promise<number>;
  /** Gated. `source 'vendor'`, ON CONFLICT DO NOTHING. Returns the rows inserted. */
  insertPicks(input: { vendorId: number; revisionId: number; productVariantIds: readonly number[]; now: Date }): Promise<number>;
}

export interface DropshipSelectionChangeRepository {
  /** `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, the reads, `COMMIT` (V38): one snapshot, nothing written. */
  runPreview<T>(work: (reads: DropshipSelectionChangeReads) => Promise<T>): Promise<T>;
  /**
   * `BEGIN`, a short lock timeout, the vendor's selection lock, then `work`,
   * then `COMMIT`; `ROLLBACK` on any error, which is rethrown unchanged.
   */
  runChange<T>(input: { vendorId: number }, work: (tx: DropshipSelectionChangeTransaction) => Promise<T>): Promise<T>;
}

export interface DropshipSelectionChangeServiceDependencies {
  repository: DropshipSelectionChangeRepository;
  clock: DropshipClock;
  logger: DropshipLogger;
  /** Waits between attempts; injected so a test never sleeps. */
  sleep(delayMs: number): Promise<void>;
  /** A seeded source in [0, 1) for the retry jitter (seededJitterSource). */
  random(): number;
  /** The kill switch (selectionPicksWritesDisabled). */
  picksWritesDisabled(): boolean;
}

const vendorIdSchema = z.number().int().positive().max(2_147_483_647);
const previewInputSchema = z.object({ vendorId: vendorIdSchema, body: z.unknown() }).strict();
const changeInputSchema = z.object({
  vendorId: vendorIdSchema,
  actor: z.object({ actorType: z.literal("vendor"), actorId: z.string().trim().min(1).max(255) }).strict(),
  body: z.unknown(),
}).strict();

export class DropshipSelectionChangeService {
  constructor(private readonly deps: DropshipSelectionChangeServiceDependencies) {}

  /** What a change would do now (§8.2). Writes nothing; a stale `expectedRevisionId` is answered, not refused. */
  async preview(input: unknown): Promise<SelectionChangePreviewAnswer> {
    const { vendorId, body } = parseServiceInput(previewInputSchema, input);
    const change = parseSelectionChangePreviewBody(body);
    const now = this.deps.clock.now();
    const { headRevisionId, facts } = await this.deps.repository.runPreview(async (reads) => ({
      headRevisionId: await reads.readHeadRevisionId({ vendorId }),
      facts: await reads.readPlanFacts({ vendorId, touchedIds: touchedIds(change), now }),
    }));
    const planned = planFromFacts(change, facts, now);
    return {
      headRevisionId,
      ...plannedAnswer(planned),
      refused: planned.growsOverCap ? "too_large" : null,
    };
  }

  /**
   * The change (§8.3), retried in this request on a transient failure. A
   * reserved key is refused before any repository call; a replay of the same
   * key and request answers its stored result, even while writes are paused.
   */
  async applyChange(input: unknown): Promise<{ answer: SelectionChangeAnswer; idempotentReplay: boolean }> {
    const { vendorId, actor, body } = parseServiceInput(changeInputSchema, input);
    const change = parseSelectionChangeBody(body);
    // B's release and follow-up write their revisions under this prefix (V8; selection-release.ts).
    if (isReservedSelectionIdempotencyKey(change.idempotencyKey)) {
      throw new DropshipError(SELECTION_CHANGE_ERROR_CODES.keyReserved, SELECTION_CHANGE_WORDS.keyReserved, {
        vendorId, classification: "permanent", retryable: false,
      });
    }
    const requestHash = hashSelectionChangeRequest(change);
    const attemptCodes: string[] = [];
    for (let attempt = 1; attempt <= SELECTION_SAVE_ATTEMPTS; attempt += 1) {
      try {
        const outcome = await this.deps.repository.runChange({ vendorId }, (tx) => this.attempt(tx, {
          vendorId, actor, change, requestHash, now: this.deps.clock.now(),
        }));
        this.logOutcome(vendorId, actor.actorId, outcome, attempt);
        return { answer: outcome.answer, idempotentReplay: outcome.idempotentReplay };
      } catch (error) {
        const retryCode = retryableSaveFailureCode(error);
        if (retryCode === null) throw error;
        attemptCodes.push(retryCode);
        if (attempt === SELECTION_SAVE_ATTEMPTS) break;
        const delayMs = selectionSaveRetryDelayMs(attempt, this.deps.random);
        // Expected under load and retried here: DEBUG, not a repeated WARN (CLAUDE.md §10).
        this.deps.logger.debug?.({
          code: "dropship.selection.change_retry",
          message: "A picks save was rolled back by a transient failure and is tried again.",
          context: { outcome: "retrying", vendor_id: vendorId, expected_revision_id: change.expectedRevisionId, attempt,
            delay_ms: delayMs, error_code: retryCode, error_class: "transient" },
        });
        await this.deps.sleep(delayMs);
      }
    }
    // An anomaly the page recovers from by retrying with the same key (WARN, not ERROR).
    this.deps.logger.warn({
      code: "dropship.selection.change_busy",
      message: "A picks save stayed busy through every server attempt; the page will retry it.",
      context: { outcome: "deferred", vendor_id: vendorId, expected_revision_id: change.expectedRevisionId,
        attempts: SELECTION_SAVE_ATTEMPTS, attempt_error_codes: attemptCodes, error_code: SELECTION_CHANGE_ERROR_CODES.busy,
        error_class: "transient" },
    });
    throw new DropshipError(SELECTION_CHANGE_ERROR_CODES.busy, SELECTION_CHANGE_WORDS.busy, {
      classification: "transient",
      retryable: true,
      attempts: SELECTION_SAVE_ATTEMPTS,
      // The last cause as its code only: never PostgreSQL's diagnostics in an answer (publication-selection-work.ts).
      lastErrorCode: attemptCodes[attemptCodes.length - 1] ?? null,
    });
  }

  /** One attempt, inside the repository's transaction, in the order of §8.3. */
  private async attempt(tx: DropshipSelectionChangeTransaction, input: {
    vendorId: number; actor: { actorType: "vendor"; actorId: string }; change: CanonicalSelectionChangeSave;
    requestHash: string; now: Date;
  }): Promise<AttemptOutcome> {
    const { vendorId, change } = input;
    // Step 2: a replay first, so a lost answer is answered again while writes are paused.
    const stored = await tx.findRevisionByKey({ vendorId, idempotencyKey: change.idempotencyKey });
    if (stored) return { idempotentReplay: true, answer: replayedAnswer(stored, input.requestHash, vendorId) };

    // Step 3: the writes readiness gate (§10).
    if (this.deps.picksWritesDisabled()) throw writesPaused("disabled", vendorId);
    const gate = await tx.readWritesGate({
      version: PICKS_WRITES_CODE_VERSION, graceMs: OLDER_PROCESS_GRACE_MS, settleMs: NEW_VERSION_SETTLE_MS,
    });
    if (gate.olderVersionLive || !gate.versionSettled) throw writesPaused("older_version_running", vendorId, gate);

    // Step 4: the revision the page counted from.
    const headRevisionId = await tx.readHeadRevisionId({ vendorId });
    if (headRevisionId !== change.expectedRevisionId) {
      throw new DropshipError(SELECTION_CHANGE_ERROR_CODES.revisionConflict, SELECTION_CHANGE_WORDS.stale, {
        vendorId, expectedRevisionId: change.expectedRevisionId, currentRevisionId: headRevisionId,
        classification: "permanent", retryable: false,
      });
    }

    // Step 5: read and plan; nothing is written before the plan stands.
    const facts = await tx.readPlanFacts({ vendorId, touchedIds: touchedIds(change), now: input.now });
    const planned = planFromFacts(change, facts, input.now);
    if (planned.growsOverCap) {
      throw new DropshipError(SELECTION_CHANGE_ERROR_CODES.tooLarge, SELECTION_CHANGE_WORDS.tooLarge(planned.selectedAfter), {
        vendorId, selectedBefore: facts.selectedBefore, selectedAfter: planned.selectedAfter, cap: SELECTION_CHANGE_CAP,
        classification: "permanent", retryable: false,
      });
    }
    const comparison = compareSelectionEffects({
      expectedEffectsHash: change.expectedEffectsHash, actualEffectsHash: planned.effects.effectsHash, addIds: change.addIds,
    });
    if (comparison.outcome === "changed") {
      throw new DropshipError(SELECTION_CHANGE_ERROR_CODES.effectsChanged, SELECTION_CHANGE_WORDS.effectsChanged, {
        vendorId, expectedEffectsHash: comparison.expectedEffectsHash, actualEffectsHash: comparison.actualEffectsHash,
        effects: planned.effects.stores, classification: "permanent", retryable: false,
      });
    }
    const result: Omit<SelectionChangeAnswer, "revisionId"> = {
      ...plannedAnswer(planned),
      confirmedEffectsHash: change.expectedEffectsHash,
      drifted: comparison.outcome === "drifted",
    };

    // Step 6: the ungated rows. The audit names the planned writes; step 8 proves every one was written.
    const { insertIds, deleteIds } = planned.plan;
    const revisionId = await tx.insertRevision({
      vendorId, idempotencyKey: change.idempotencyKey, requestHash: input.requestHash, actor: input.actor,
      pickCount: facts.pickCountBefore + insertIds.length - deleteIds.length, result, now: input.now,
    });
    await tx.insertAudit({
      vendorId, revisionId, actor: input.actor, now: input.now,
      payload: auditPayload(change, planned, comparison, facts.selectedBefore, revisionId),
    });

    // Step 7: every wait on a size's row lock happens here, before the gate is held.
    if (insertIds.length > 0) {
      const locked = await tx.preLockVariants({ productVariantIds: insertIds });
      if (locked.length !== insertIds.length) throw planMoved(vendorId, "pre_lock", insertIds.length, locked.length);
    }

    // Step 8: the gated writes. A no-op change writes the revision and audit only and takes no gate.
    if (deleteIds.length > 0) {
      const deleted = await tx.deletePicks({ vendorId, productVariantIds: deleteIds });
      if (deleted !== deleteIds.length) throw planMoved(vendorId, "delete", deleteIds.length, deleted);
    }
    if (insertIds.length > 0) {
      const inserted = await tx.insertPicks({ vendorId, revisionId, productVariantIds: insertIds, now: input.now });
      if (inserted !== insertIds.length) throw planMoved(vendorId, "insert", insertIds.length, inserted);
    }
    return { idempotentReplay: false, answer: { revisionId, ...result } };
  }

  private logOutcome(vendorId: number, actorId: string, outcome: AttemptOutcome, attempt: number): void {
    const { answer } = outcome;
    this.deps.logger.info({
      code: "dropship.selection.changed",
      message: outcome.idempotentReplay
        ? "A picks save was replayed by its request key."
        : "The vendor's picks were changed.",
      context: {
        outcome: outcome.idempotentReplay ? "replayed" : answer.drifted ? "changed_with_drift" : "changed",
        vendor_id: vendorId,
        revision_id: answer.revisionId,
        actor_id: actorId,
        attempt,
        added: answer.toAdd,
        removed: answer.toRemove,
        skipped: answer.skipped.count,
        before: { selected: answer.selectedBefore },
        after: { selected: answer.selectedAfter },
        selected_before: answer.selectedBefore,
        selected_after: answer.selectedAfter,
        effects: answer.effects,
        drift: answer.drifted,
      },
    });
  }
}

interface AttemptOutcome {
  idempotentReplay: boolean;
  answer: SelectionChangeAnswer;
}

interface PlannedChange {
  plan: SelectionChangePlan;
  selectedAfter: number;
  growsOverCap: boolean;
  effects: SelectionEffects;
  selectedBefore: number;
}

/** The pure part shared by the preview and the save: the plan, the counts, the cap and the effects. */
function planFromFacts(change: CanonicalSelectionChange, facts: SelectionChangePlanFacts, now: Date): PlannedChange {
  const plan = planSelectionChange({
    pickedBefore: facts.pickedBefore, add: change.addIds, remove: change.removeIds, offered: facts.offered,
  });
  const selectedAfter = selectedCountAfterChange({ selectedBefore: facts.selectedBefore, plan, offeredDeletes: facts.offered });
  const effects = decideSelectionEffects({
    now, insertIds: plan.insertIds, deleteIds: plan.deleteIds, ...facts.effects,
  });
  return {
    plan,
    selectedAfter,
    growsOverCap: refuseGrowthOverCap({ before: facts.selectedBefore, after: selectedAfter, cap: SELECTION_CHANGE_CAP }),
    effects,
    selectedBefore: facts.selectedBefore,
  };
}

function plannedAnswer(planned: PlannedChange): Omit<SelectionChangePreviewAnswer, "headRevisionId" | "refused"> {
  return {
    toAdd: planned.plan.insertIds.length,
    toRemove: planned.plan.deleteIds.length,
    alreadySelected: planned.plan.alreadySelected.length,
    alreadyNotSelected: planned.plan.alreadyNotSelected.length,
    skipped: {
      count: planned.plan.skipped.length,
      first: planned.plan.skipped.slice(0, SELECTION_CHANGE_SKIPPED_SHOWN).map((skip) => skip.id),
    },
    selectedBefore: planned.selectedBefore,
    selectedAfter: planned.selectedAfter,
    cap: SELECTION_CHANGE_CAP,
    overCapAfter: planned.selectedAfter > SELECTION_CHANGE_CAP,
    effects: planned.effects.stores,
    effectsHash: planned.effects.effectsHash,
  };
}

/** What the audit row records (§8.3 step 6): the ids written, the skipped ids, the counts and the effects by store. */
function auditPayload(change: CanonicalSelectionChangeSave, planned: PlannedChange, comparison: SelectionEffectsComparison,
  selectedBefore: number, revisionId: number): Record<string, unknown> {
  return {
    revisionId,
    idempotencyKey: change.idempotencyKey,
    expectedRevisionId: change.expectedRevisionId,
    addedVariantIds: planned.plan.insertIds,
    removedVariantIds: planned.plan.deleteIds,
    skippedVariantIds: planned.plan.skipped.map((skip) => skip.id),
    alreadySelectedCount: planned.plan.alreadySelected.length,
    alreadyNotSelectedCount: planned.plan.alreadyNotSelected.length,
    selectedBefore,
    selectedAfter: planned.selectedAfter,
    effects: planned.effects.stores,
    effectsHash: planned.effects.effectsHash,
    // Both hashes only when the effects moved since the vendor confirmed them (a removal-only change, §7.5).
    ...(comparison.outcome === "drifted" ? { confirmedEffectsHash: comparison.expectedEffectsHash, drifted: true } : {}),
  };
}

/** The stored answer of the same request, or a key conflict. The stored row is read back through the answer's contract. */
function replayedAnswer(stored: StoredSelectionChangeRevision, requestHash: string, vendorId: number): SelectionChangeAnswer {
  if (stored.requestHash !== requestHash || stored.requestKind !== "picks_change" || stored.result === null) {
    throw new DropshipError(SELECTION_CHANGE_ERROR_CODES.keyConflict, SELECTION_CHANGE_WORDS.keyConflict, {
      vendorId, revisionId: stored.revisionId, classification: "permanent", retryable: false,
    });
  }
  const parsed = selectionChangeAnswerSchema.safeParse({ ...(stored.result as Record<string, unknown>), revisionId: stored.revisionId });
  // A stored answer that fails its own contract is the server's fault: a plain error answers 500 and logs ERROR.
  if (!parsed.success) throw new Error(`Stored picks change result of revision ${stored.revisionId} failed its contract.`);
  return parsed.data;
}

function touchedIds(change: CanonicalSelectionChange): number[] {
  return [...change.addIds, ...change.removeIds].sort((left, right) => left - right);
}

function writesPaused(reason: Exclude<SelectionWritesPausedReason, "page_newer_than_server">, vendorId: number,
  gate?: { olderVersionLive: boolean; versionSettled: boolean }): DropshipError {
  return new DropshipError(SELECTION_CHANGE_ERROR_CODES.writesPaused, SELECTION_CHANGE_WORDS.paused, {
    reason, vendorId, ...(gate ?? {}), classification: "transient", retryable: true,
  });
}

function planMoved(vendorId: number, step: string, planned: number, actual: number): DropshipError {
  return new DropshipError(SELECTION_CHANGE_PLAN_MOVED, SELECTION_CHANGE_WORDS.planMoved, {
    vendorId, step, planned, actual, classification: "transient", retryable: true,
  });
}

/**
 * The code of a failure a save retries, or null: a pg error with a retryable
 * SQLSTATE (a held publication gate and a lock timeout are both 55P03), or a
 * plan that moved. Every other error, every DropshipError refusal included,
 * is not retried.
 */
export function retryableSaveFailureCode(error: unknown): string | null {
  if (error instanceof DropshipError) return error.code === SELECTION_CHANGE_PLAN_MOVED ? SELECTION_CHANGE_PLAN_MOVED : null;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_SQLSTATES.has(code) ? code : null;
}

/** The wait after failed attempt `attempt` (1-based): its base delay ±50%, whole milliseconds. */
export function selectionSaveRetryDelayMs(attempt: number, random: () => number): number {
  const base = SELECTION_SAVE_RETRY_DELAYS_MS[Math.min(attempt, SELECTION_SAVE_RETRY_DELAYS_MS.length) - 1]!;
  const draw = random();
  if (!(draw >= 0 && draw < 1)) throw new Error("The retry jitter source must return a number in [0, 1).");
  return Math.round(base * (1 - SELECTION_SAVE_RETRY_JITTER + 2 * SELECTION_SAVE_RETRY_JITTER * draw));
}

/** A small seeded source in [0, 1) (mulberry32): the same seed gives the same jitter, so a test is reproducible. */
export function seededJitterSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The kill switch (§4.4): closed only by exactly "true". */
export function selectionPicksWritesDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[SELECTION_PICKS_WRITES_DISABLED_ENV] === "true";
}

function parseServiceInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  // The route builds this input from the session; a failure is the server's own fault (500), never the vendor's.
  if (!parsed.success) throw new Error(`Selection change service input failed validation: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  return parsed.data;
}
