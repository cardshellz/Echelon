import {
  STOCK_LINK_LOOKUP_SKUS_MAX, STOCK_LINK_OBSERVE_ITEMS_MAX,
  type StockLinkDestination, type StockLinkItemObservation, type StockLinkSkuLookup, type StockLinkStoreItem,
} from "@shared/types/stock-link";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import { logger as platformLogger } from "../../../platform/observability/logger";
import { FENCE_HOLD_WARN_MS } from "../domain/dropship-ebay-stock-readiness";
import {
  STOCK_LINK_ACTOR, STOCK_LINK_DECISION_CODES, normalizeStockLinkSku, planStockLinkBatch, planStockLinkReads, stockLinkFirstVerifyDelayMs, stockLinkPauseDelayMs,
  stockLinkRetireWindowStart, type StockLinkBatchPlan, type StockLinkBatchReads, type StockLinkRandom, type StockLinkSelectionAction,
  type StockLinkSizeDecision, type StockLinkSizeFacts,
} from "../domain/stock-link";
import {
  stockLinkCheckAfterDecision, stockLinkCheckAfterFailure, type StockLinkCheckFacts, type StockLinkCheckWrite,
} from "../domain/stock-link-check-outcome";
import {
  STOCK_LINK_ERROR_CODES, classifyStockLinkFailure, stockLinkTickFailureAction,
  type StockLinkFailureClassification, type StockLinkTickFailureAction,
} from "../domain/stock-link-errors";
import type {
  StockLinkClaimedCheck, StockLinkCheckGuard, StockLinkCursorUpdate, StockLinkDestinationState, StockLinkHeadRead,
  StockLinkTargetRow,
} from "../infrastructure/stock-link-checks.repository";
import type { StockLinkCommandRequest, StockLinkCommandResult } from "../infrastructure/stock-link-shopify-command";
import type { DropshipEbayStockReadinessInput, DropshipEbayStockReadinessResult } from "@shared/types/dropship-ebay-stock-readiness";
import {
  isStockLinkEnrollmentBinding, type StockLinkBinding, type StockLinkEnrollmentBinding, type StockLinkPolicyBinding,
  type StockLinkRegistry, type StockLinkSource,
} from "./stock-link.ports";
import { runStockLinkEnrollment } from "./stock-link-enrollment.run";
import { productSyncLinkScopeSchema, type ProductSyncLinkScope } from "@shared/types/inventory-product-sync-workflow";

/**
 * The stock-link engine's background tick (channels PR2, PLAN-CH2 v4.1 §7.2): one cluster-wide runner
 * (infrastructure/stock-link-runner.ts, advisory lock STOCK_LINK_LOCK_ID) calls `tick()` every 60 s. For each live, Echelon-managed
 * destination with a policy (today: Card Shellz's own Shopify stores) whose switch is on, it
 * 1. writes the heartbeat (also for a paused or halted destination, which then stops; TST-9);
 * 2. discovers sizes from the database only: changed feeds by the raw cursor (SAF-6, TST-8), one sweep page, the
 *    destination's dead letters; it adds missing check rows, wakes changed ones, deletes rows of sizes no longer carried;
 * 3. claims up to 500 due rows (5-minute lease);
 * 4. reads the store outside any transaction, at most 20 calls (one kept for the control read, SAF-7);
 * 5. decides the batch with the pure rules (domain/stock-link.ts) and applies one command per product within the
 *    fence budget (≤ 10 commands, 3 s cumulative hold, one hold > 2 s stops it);
 * 6. records every other outcome guarded by the claim, wakes holders (SAF-5), pauses or clears a pause.
 * No new work after 30 s; provider calls stop at 45 s (injected monotonic clock). A lost database stops the tick and
 * writes nothing more; a permanent or fatal failure halts the destination with one ERROR (never retried); a pause
 * leaves the claimed rows to expire. The tick never throws.
 */

export type StockLinkLogger = Pick<typeof platformLogger, "debug" | "info" | "warn" | "error">;

/** The selection the decision needs per size (readPublicationStockSelection): action and blocker codes. */
export interface StockLinkSelectionFact {
  readonly action: StockLinkSelectionAction;
  readonly blockerCodes: readonly string[];
}

/** The tick's database work (infrastructure/stock-link-checks.repository.ts; composed in stock-link.factory.ts). */
export interface StockLinkTickStore {
  readAuthority(): Promise<"legacy" | "canonical">;
  listTargets(): Promise<readonly StockLinkTargetRow[]>;
  beat(publicationTargetId: number, now: Date): Promise<StockLinkDestinationState>;
  saveCursors(publicationTargetId: number, update: StockLinkCursorUpdate): Promise<void>;
  insertMissingChecks(publicationTargetId: number, rows: readonly { productVariantId: number; firstVerifyAt: Date }[],
    now: Date, productId?: number): Promise<number[]>;
  wakeChecks(publicationTargetId: number, productVariantIds: readonly number[], now: Date): Promise<number[]>;
  deleteUncarriedChecks(publicationTargetId: number, range: { afterVariantId: number; throughVariantId: number | null },
    carriedVariantIds: readonly number[], now: Date): Promise<number[]>;
  listDeadLetterWakes(publicationTargetId: number, after: string | null, limit: number):
    Promise<{ productVariantIds: number[]; lastAt: string | null }>;
  claimDue(publicationTargetId: number, input: { now: Date; leaseToken: string; leaseMs: number; limit: number;
    productId?: number; productVariantIds?: readonly number[] }):
    Promise<StockLinkClaimedCheck[]>;
  readHeads(publicationTargetId: number): Promise<readonly StockLinkHeadRead[]>;
  readSelection(destination: StockLinkDestination, productId: number, productVariantIds: readonly number[]):
    Promise<ReadonlyMap<number, StockLinkSelectionFact>>;
  countRecentRetires(publicationTargetId: number, windowStart: Date): Promise<number>;
  recordOutcomes(publicationTargetId: number, guards: readonly StockLinkCheckGuard[], now: Date,
    decide: (productVariantId: number, previous: StockLinkCheckFacts) => StockLinkCheckWrite): Promise<number[]>;
  deleteClaimedChecks(publicationTargetId: number, guards: readonly StockLinkCheckGuard[]): Promise<number[]>;
  pause(publicationTargetId: number, input: { code: string; now: Date; until: Date }): Promise<boolean>;
  clearPause(publicationTargetId: number, codes: readonly string[], now: Date): Promise<string | null>;
  halt(publicationTargetId: number, input: { code: string; now: Date }): Promise<boolean>;
}

/** Runs one command with the destination's own source (infrastructure/stock-link-shopify-command.ts). */
export type StockLinkCommandRunner = (request: StockLinkCommandRequest, source: StockLinkSource) => Promise<StockLinkCommandResult>;

export interface StockLinkServiceDeps {
  readonly store: StockLinkTickStore;
  readonly registry: StockLinkRegistry;
  readonly runCommand: StockLinkCommandRunner;
  /** The client the destinations' sources read on outside any transaction (the application pool). */
  readonly db: StockSelectionQueryClient;
  readonly clock: () => Date;
  /** Monotonic milliseconds for the tick's own time budget (never the wall clock). */
  readonly monotonicNow: () => number;
  readonly random: StockLinkRandom;
  readonly newLeaseToken: () => string;
  readonly logger?: StockLinkLogger;
  /** A signal that aborts after `ms` (the provider calls' hard stop); tests pass their own. */
  readonly deadline?: (ms: number) => AbortSignal;
  /**
   * Channels PR3: the Dropship eBay link writer for listing enrollment (ensureDropshipEbayStockReady bound to the pool,
   * actor system:dropship-stock-enrollment, the injected clock). Absent: an enrollment destination halts with
   * STOCK_LINK_POLICY_MISSING (never a guess).
   */
  readonly runEnrollment?: StockLinkEnrollmentRunner;
}

/** One Dropship eBay enrollment link (the existing writer; channels PR3). */
export type StockLinkEnrollmentRunner = (input: DropshipEbayStockReadinessInput) => Promise<DropshipEbayStockReadinessResult>;

/** The tick's bounds (§4.7, §7.2; C27). */
export const STOCK_LINK_TICK_LIMITS = Object.freeze({
  /** No new work (destination, provider call, command) after 30 s. */
  softStopMs: 30_000,
  /** Provider calls in flight are aborted at 45 s (the runner ticks every 60 s). */
  hardStopMs: 45_000,
  claimLimit: 500,
  leaseMs: 5 * 60_000,
  recentLimit: 500,
  /** Changed feeds acted on per tick, oldest first; the cursor moves only past those (SAF-6). */
  recentWakeLimit: 200,
  sweepLimit: 500,
  deadLetterLimit: 500,
  /** Provider calls per destination per tick, the control read included: one call is kept for it (SAF-7). */
  callsPerDestination: 20,
  /** Commands that take the cutover fence per tick, across destinations (§4.7). */
  commandsPerTick: 10,
  fenceHoldTotalMs: 3_000,
  fenceHoldSingleMs: FENCE_HOLD_WARN_MS,
});

const L = STOCK_LINK_TICK_LIMITS;
const C = STOCK_LINK_ERROR_CODES;
const ACTION = "inventory_availability.stock_link.tick";
/** Pauses that a successful store read lifts (the login works again, the store answers). */
const PROVIDER_PAUSE_CODES: readonly string[] = [C.storeAuthRefused, C.storeUnavailable];

export interface StockLinkTickSummary {
  readonly outcome: "completed" | "legacy_authority" | "database_unavailable" | "failed";
  readonly destinations: number;
  readonly claimed: number;
  readonly providerCalls: number;
  readonly observations: number;
  readonly lookups: number;
  readonly applies: number;
  readonly links: number;
  readonly relinks: number;
  readonly retires: number;
  readonly flags: number;
  readonly fenceHoldMsTotal: number;
  readonly fenceHoldMsMax: number;
  readonly elapsedMs: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** One tick's counters and budgets (explicit, per-call state; nothing survives the tick). */
export class TickRun {
  readonly summary: Mutable<StockLinkTickSummary> = { outcome: "completed", destinations: 0, claimed: 0, providerCalls: 0,
    observations: 0, lookups: 0, applies: 0, links: 0, relinks: 0, retires: 0, flags: 0, fenceHoldMsTotal: 0,
    fenceHoldMsMax: 0, elapsedMs: 0 };
  private fencedCommands = 0;
  private fenceExhausted = false;
  readonly signal: AbortSignal;
  private readonly startedAt: number;
  constructor(private readonly monotonicNow: () => number, deadline: (ms: number) => AbortSignal) {
    this.startedAt = monotonicNow();
    this.signal = deadline(L.hardStopMs);
  }
  elapsedMs(): number { return Math.max(0, this.monotonicNow() - this.startedAt); }
  timeUp(): boolean { return this.elapsedMs() >= L.softStopMs || this.signal.aborted; }
  /** Why the next command may not start (§4.7), or null. */
  commandBudgetCode(): string | null {
    if (this.timeUp()) return C.callBudgetUsed;
    if (this.fenceExhausted || this.fencedCommands >= L.commandsPerTick) return C.fenceBudgetUsed;
    return null;
  }
  recordFenceHold(holdMs: number | null): void {
    // A command that settled on its fast path took no fence and does not count against the fence budget.
    if (holdMs === null) return;
    this.fencedCommands += 1;
    this.summary.fenceHoldMsTotal += holdMs;
    this.summary.fenceHoldMsMax = Math.max(this.summary.fenceHoldMsMax, holdMs);
    if (holdMs > L.fenceHoldSingleMs || this.summary.fenceHoldMsTotal >= L.fenceHoldTotalMs) this.fenceExhausted = true;
  }
}

/** One destination's tick context. */
export interface DestinationRun<B extends StockLinkBinding = StockLinkPolicyBinding> {
  readonly tick: TickRun;
  readonly destination: StockLinkDestination;
  readonly binding: B;
  readonly state: StockLinkDestinationState;
  readonly correlation: Readonly<Record<string, unknown>>;
  /** Explicit command scope. Background runs omit it and retain normal discovery. */
  readonly productScope?: { productId: number; productVariantIds: readonly number[] };
}

export type StepResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: StockLinkFailureClassification; readonly action: StockLinkTickFailureAction;
      readonly message: string };

export type Flow = "continue" | "stop_tick";

/** The reads one destination's tick made (§7.2 step 5). */
interface StoreReads {
  readonly lookups: StockLinkSkuLookup[];
  readonly observations: StockLinkItemObservation[];
  /** Why the reads stopped before every size was read (busy or transient), or null. */
  stoppedBy: StepResult<never> & { ok: false } | null;
  callsUsed: number;
}

export class StockLinkService {
  private readonly log: StockLinkLogger;
  private readonly deadline: (ms: number) => AbortSignal;

  constructor(private readonly deps: StockLinkServiceDeps) {
    this.log = deps.logger ?? platformLogger;
    this.deadline = deps.deadline ?? (ms => AbortSignal.timeout(ms));
  }

  /** One tick. Never throws: every failure is classified, logged and handled here. */
  async tick(): Promise<StockLinkTickSummary> {
    return (await this.runTick()).summary;
  }

  /** Uses the same policies, leases, fences and budgets as the background engine.
   * A manual product request never advances global cursors or claims another product. */
  async checkProduct(input: ProductSyncLinkScope): Promise<{ summary: StockLinkTickSummary; skippedTargets: number[] }> {
    return this.runTick(productSyncLinkScopeSchema.parse(input));
  }

  private async runTick(scope?: ProductSyncLinkScope): Promise<{ summary: StockLinkTickSummary; skippedTargets: number[] }> {
    const tick = new TickRun(this.deps.monotonicNow, this.deadline);
    const skippedTargets: number[] = [];
    try {
      await this.run(tick, scope, skippedTargets);
    } catch (error) {
      // A failure no step routed (a bug): one ERROR, the tick ends; the next tick starts afresh.
      const failure = classifyStockLinkFailure(error);
      tick.summary.outcome = failure.kind === "database_unavailable" ? "database_unavailable" : "failed";
      const log = failure.kind === "database_unavailable" ? this.log.warn : this.log.error;
      log(ACTION, { outcome: tick.summary.outcome, error_code: failure.code, error_class: failure.errorClass,
        cause_code: failure.causeCode, actor: STOCK_LINK_ACTOR });
    }
    tick.summary.elapsedMs = tick.elapsedMs();
    const s = tick.summary;
    this.log.info(ACTION, { outcome: s.outcome, actor: STOCK_LINK_ACTOR, destinations: s.destinations, claimed: s.claimed,
      provider_calls: s.providerCalls, observations: s.observations, lookups: s.lookups, applies: s.applies, links: s.links,
      relinks: s.relinks, retires: s.retires, flags: s.flags, fence_hold_ms_total: s.fenceHoldMsTotal,
      fence_hold_ms_max: s.fenceHoldMsMax, elapsed_ms: s.elapsedMs });
    return { summary: { ...s }, skippedTargets };
  }

  /** A failure of the runner around the tick (its lock pool, the server), handed over by the runner. */
  recordTickFailure(error: unknown, extra: Readonly<Record<string, unknown>> = {}): void {
    const failure = classifyStockLinkFailure(error);
    const log = failure.kind === "database_unavailable" ? this.log.warn : this.log.error;
    log(ACTION, { ...extra, outcome: "tick_failed", error_code: failure.code, error_class: failure.errorClass,
      cause_code: failure.causeCode, actor: STOCK_LINK_ACTOR });
  }

  private now(): Date {
    const now = this.deps.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw Object.assign(new Error("The stock-link clock returned an invalid time."), { code: C.stateInvalid });
    }
    return now;
  }

  private async step<T>(work: () => Promise<T>): Promise<StepResult<T>> {
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      const failure = classifyStockLinkFailure(error);
      return { ok: false, failure, action: stockLinkTickFailureAction(failure),
        message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async run(tick: TickRun, scope?: ProductSyncLinkScope, skippedTargets: number[] = []): Promise<void> {
    const authority = await this.step(() => this.deps.store.readAuthority());
    if (!authority.ok) return this.tickLevelFailure(tick, authority);
    if (authority.value === "legacy") {
      tick.summary.outcome = "legacy_authority";
      this.log.debug(ACTION, { outcome: "skipped", reason: "legacy_authority", actor: STOCK_LINK_ACTOR });
      return;
    }
    const targets = await this.step(() => this.deps.store.listTargets());
    if (!targets.ok) return this.tickLevelFailure(tick, targets);

    // Every supported destination beats first, so a long tick never leaves a later one looking stalled (TST-9).
    const beaten: { target: StockLinkTargetRow; binding: StockLinkBinding; state: StockLinkDestinationState }[] = [];
    for (const target of targets.value) {
      if (scope && !scope.targets.some(selected => selected.publicationTargetId === target.publicationTargetId)) continue;
      const binding = target.destination === null ? null
        : this.deps.registry.resolve(target.destination.destinationKind, target.destination.providerKey);
      if (target.destination === null || binding === null) {
        skippedTargets.push(target.publicationTargetId);
        this.log.debug(ACTION, { outcome: "skipped", reason: "no_policy", publication_target_id: target.publicationTargetId,
          destination_kind: target.destinationKind, provider_key: target.providerKey, actor: STOCK_LINK_ACTOR });
        continue;
      }
      const state = await this.step(() => this.deps.store.beat(target.publicationTargetId, this.now()));
      if (!state.ok) {
        if (state.action === "stop_tick") return this.tickLevelFailure(tick, state);
        // A lock held elsewhere (busy) is an anomaly that the next tick recovers from; anything else needs a person.
        (state.action === "halt" ? this.log.error : this.log.warn)(ACTION, { outcome: "heartbeat_failed",
          publication_target_id: target.publicationTargetId, error_code: state.failure.code, error_class: state.failure.errorClass,
          cause_code: state.failure.causeCode, actor: STOCK_LINK_ACTOR });
        continue;
      }
      beaten.push({ target, binding, state: state.value });
    }
    for (const { target, binding, state } of beaten) {
      const destination = target.destination!;
      const selected = scope?.targets.find(candidate => candidate.publicationTargetId === destination.publicationTargetId);
      const run: DestinationRun<StockLinkBinding> = { tick, destination, binding, state, correlation: {
        publication_target_id: destination.publicationTargetId, destination_kind: destination.destinationKind,
        provider_key: destination.providerKey, connection_id: destination.channelConnectionId ?? destination.dropshipStoreConnectionId,
        actor: STOCK_LINK_ACTOR }, ...(selected && scope ? { productScope: { productId: scope.productId,
          productVariantIds: selected.productVariantIds } } : {}) };
      const skip = skipReason(target, state, this.now(), tick);
      if (skip !== null) {
        // Budget exhaustion is pending work, not a destination refusal.
        if (skip !== "time_budget_used" && skip !== "paused") skippedTargets.push(target.publicationTargetId);
        this.log.debug(ACTION, { ...run.correlation, outcome: "skipped", reason: skip });
        continue;
      }
      tick.summary.destinations += 1;
      const flow = isStockLinkEnrollmentBinding(binding)
        ? await runStockLinkEnrollment(this.enrollmentContext(), { ...run, binding })
        : await this.processDestination({ ...run, binding });
      if (flow === "stop_tick") {
        tick.summary.outcome = "database_unavailable";
        return;
      }
    }
  }

  private tickLevelFailure(tick: TickRun, result: StepResult<unknown> & { ok: false }): void {
    tick.summary.outcome = result.action === "stop_tick" ? "database_unavailable" : "failed";
    const log = result.action === "stop_tick" ? this.log.warn : this.log.error;
    log(ACTION, { outcome: tick.summary.outcome, error_code: result.failure.code, error_class: result.failure.errorClass,
      cause_code: result.failure.causeCode, actor: STOCK_LINK_ACTOR });
  }

  /**
   * A destination-level failure: a halt (one ERROR, never retried), a pause (the claimed rows expire), or the end of
   * the tick. Busy and transient failures here only end this destination's tick (its rows were released by the caller).
   */
  private async failDestination(run: DestinationRun<StockLinkBinding>, result: StepResult<unknown> & { ok: false }, phase: string): Promise<Flow> {
    const { failure } = result;
    const targetId = run.destination.publicationTargetId;
    const event = { ...run.correlation, phase, error_code: failure.code, error_class: failure.errorClass, cause_code: failure.causeCode };
    if (result.action === "stop_tick") {
      this.log.warn(ACTION, { ...event, outcome: "database_unavailable" });
      return "stop_tick";
    }
    if (result.action === "halt") {
      const halted = await this.step(() => this.deps.store.halt(targetId, { code: failure.code, now: this.now() }));
      if (!halted.ok) return this.writeFailed(run, halted, "halt");
      // One ERROR per halt: the destination stays halted until a person presses Check again (HALTED on Ops Health).
      if (halted.value) this.log.error(ACTION, { ...event, outcome: "halted" });
      return "continue";
    }
    if (result.action === "pause") {
      const now = this.now();
      const until = new Date(now.getTime() + stockLinkPauseDelayMs(run.state.pausedSince, now));
      const paused = await this.step(() => this.deps.store.pause(targetId, { code: failure.code, now, until }));
      if (!paused.ok) return this.writeFailed(run, paused, "pause");
      (paused.value ? this.log.warn : this.log.debug)(ACTION, { ...event, outcome: "paused", paused_until: until.toISOString() });
      return "continue";
    }
    this.log.debug(ACTION, { ...event, outcome: result.action === "release_busy" ? "busy" : "retry_scheduled" });
    return "continue";
  }

  /** A pause, halt or record write that itself failed: the database is gone, or this destination waits for next tick. */
  private writeFailed(run: DestinationRun<StockLinkBinding>, result: StepResult<unknown> & { ok: false }, phase: string): Flow {
    const event = { ...run.correlation, phase, error_code: result.failure.code, error_class: result.failure.errorClass,
      cause_code: result.failure.causeCode };
    if (result.action === "stop_tick") {
      this.log.warn(ACTION, { ...event, outcome: "database_unavailable" });
      return "stop_tick";
    }
    // Nothing more is written for this destination this tick; its claimed rows expire and are read again.
    (result.action === "halt" ? this.log.error : this.log.warn)(ACTION, { ...event, outcome: "write_failed" });
    return "continue";
  }

  private async processDestination(run: DestinationRun): Promise<Flow> {
    const { store } = this.deps;
    const targetId = run.destination.publicationTargetId;
    const discovered = await this.step(() => this.discover(run));
    if (!discovered.ok) {
      // Busy or transient discovery (a lock held elsewhere, a timeout) skips only discovery; due rows are still claimed.
      if (discovered.action === "halt" || discovered.action === "pause" || discovered.action === "stop_tick")
        return this.failDestination(run, discovered, "discovery");
      this.log.debug(ACTION, { ...run.correlation, phase: "discovery", outcome: "busy", error_code: discovered.failure.code });
    }
    if (run.tick.timeUp()) return "continue";
    const leaseToken = this.deps.newLeaseToken();
    const claimed = await this.step(() => store.claimDue(targetId, { now: this.now(), leaseToken, leaseMs: L.leaseMs,
      limit: L.claimLimit, ...run.productScope }));
    if (!claimed.ok) return this.failDestination(run, claimed, "claim");
    const claims = claimed.value;
    run.tick.summary.claimed += claims.length;
    if (claims.length === 0) return "continue";
    const claimRun: DestinationRun = { ...run, correlation: { ...run.correlation, lease_token: leaseToken } };

    const facts = await this.step(() => this.readFacts(claimRun, claims));
    if (!facts.ok) return this.releaseAndFail(claimRun, claims, facts, "facts");
    const { sizes, heads, carried, recentRetireCount } = facts.value;

    const reads = await this.readStore(claimRun, sizes, carried);
    if (reads.kind === "flow") return reads.flow;
    const baseInput = { sizes, carriedSkus: carried, recentRetireCount,
      destinationHeads: heads.map(head => ({ productVariantId: head.productVariantId, activeItemId: head.active?.itemId ?? null,
        draftItemId: head.draft?.itemId ?? null })) };
    let batchReads: StockLinkBatchReads = batchReadsOf(reads.value, false);
    const planned = await this.step(async () => planStockLinkBatch({ ...baseInput, reads: batchReads }));
    if (!planned.ok) return this.releaseAndFail(claimRun, claims, planned, "decision");
    let plan = planned.value;
    if (plan.control.status === "needs_read" && reads.value.stoppedBy === null && !claimRun.tick.timeUp()
      && reads.value.callsUsed < L.callsPerDestination) {
      // SAF-7: one extra read of a few linked items outside the retiring set, with the call kept for it.
      const controlIds = plan.control.itemIds;
      const control = await this.providerCall(claimRun, reads.value, () => claimRun.binding.adapter.observeItems(
        claimRun.destination, controlIds, { signal: claimRun.tick.signal }));
      if (!control.ok) {
        if (control.action === "halt" || control.action === "pause" || control.action === "stop_tick")
          return this.failDestination(claimRun, control, "control_read");
      } else {
        reads.value.observations.push(control.value);
        batchReads = batchReadsOf(reads.value, true);
        const replanned = await this.step(async () => planStockLinkBatch({ ...baseInput, reads: batchReads }));
        if (!replanned.ok) return this.releaseAndFail(claimRun, claims, replanned, "decision");
        plan = replanned.value;
      }
    }

    const evidence = await this.step(() => this.evidenceOf(claimRun, reads.value));
    if (!evidence.ok) return this.releaseAndFail(claimRun, claims, evidence, "evidence");
    const commands = await this.applyCommands(claimRun, plan, claims, evidence.value);
    if (commands.flow !== "continue" || commands.stopped) return commands.flow;
    const recorded = await this.recordDecisions(claimRun, plan, claims, heads, reads.value, commands.notRun);
    if (recorded !== "continue") return recorded;
    return this.afterBatch(claimRun, plan, reads.value);
  }

  /** §7.2 steps 2-3, database only. */
  private async discover(run: DestinationRun<StockLinkBinding>): Promise<void> {
    // Acceptance inserted/woke these exact checks transactionally with its durable request.
    if (run.productScope) {
      const now = this.now();
      await this.deps.store.insertMissingChecks(run.destination.publicationTargetId,
        run.productScope.productVariantIds.map(productVariantId => ({ productVariantId, firstVerifyAt: now })), now, run.productScope.productId);
      return;
    }
    const { store, db, random } = this.deps;
    const { destination, state } = run;
    const source = run.binding.source;
    const targetId = destination.publicationTargetId;
    const now = this.now();
    const changes = await source.listRecentlyChanged(db, destination, state.recentCursor, L.recentLimit);
    // Only a change after the cursor wakes a row; the overlap behind it adds missing rows only, so the same rows are
    // never re-checked every tick while no new feed changes (BUILD-NOTES D-P7-1).
    const fresh = changes.filter(change => change.fresh).slice(0, L.recentWakeLimit);
    const overlap = changes.filter(change => !change.fresh);
    const page = await source.listCandidates(db, destination, state.sweepAfterVariantId, L.sweepLimit);
    const wanted = new Set<number>([...fresh, ...overlap].filter(change => change.carried).map(change => change.productVariantId));
    for (const candidate of page.candidates) wanted.add(candidate.productVariantId);
    const inserted = await store.insertMissingChecks(targetId, [...wanted].sort((a, b) => a - b).map(productVariantId => ({
      productVariantId, firstVerifyAt: new Date(now.getTime() + stockLinkFirstVerifyDelayMs(random)) })), now);
    const woken = await store.wakeChecks(targetId, fresh.map(change => change.productVariantId), now);
    const deleted = await store.deleteUncarriedChecks(targetId, { afterVariantId: state.sweepAfterVariantId,
      throughVariantId: page.nextAfterVariantId }, page.candidates.map(candidate => candidate.productVariantId), now);
    const deadLetters = await store.listDeadLetterWakes(targetId, state.deadLetterCursor, L.deadLetterLimit);
    const verified = await store.wakeChecks(targetId, deadLetters.productVariantIds, now);
    const last = fresh[fresh.length - 1];
    await store.saveCursors(targetId, { sweepAfterVariantId: page.nextAfterVariantId,
      ...(last ? { recent: { raw: last.changedAtRaw, id: last.feedId } } : {}),
      ...(deadLetters.lastAt ? { deadLetterAt: deadLetters.lastAt } : {}) });
    this.log.debug(ACTION, { ...run.correlation, phase: "discovery", outcome: "completed", changed: fresh.length,
      inserted: inserted.length, woken: woken.length, deleted: deleted.length, dead_letter_woken: verified.length,
      sweep_after_variant_id: page.nextAfterVariantId });
  }

  /** What the decision reads besides the store (§4.2 inputs): SKUs, hints, selection, heads, N6, the retire count. */
  private async readFacts(run: DestinationRun, claims: readonly StockLinkClaimedCheck[]) {
    const { store, db } = this.deps;
    const { destination, binding, state } = run;
    const ids = claims.map(claim => claim.productVariantId);
    const skuRows = new Map((await binding.source.readSkus(db, destination, ids)).map(row => [row.productVariantId, row]));
    const carried = await binding.source.listCarriedSkus(db, destination);
    const heads = await store.readHeads(destination.publicationTargetId);
    const headByVariant = new Map(heads.map(head => [head.productVariantId, head]));
    const byProduct = new Map<number, number[]>();
    for (const id of ids) {
      const row = skuRows.get(id);
      if (row) byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), id]);
    }
    const selection = new Map<number, StockLinkSelectionFact>();
    for (const [productId, variantIds] of [...byProduct].sort(([a], [b]) => a - b)) {
      for (const [id, fact] of await store.readSelection(destination, productId, variantIds)) selection.set(id, fact);
    }
    const recentRetireCount = await store.countRecentRetires(destination.publicationTargetId,
      stockLinkRetireWindowStart(this.now(), state.retiresReleasedAt));
    // In claim order (oldest next check first), so the reads serve the longest-waiting sizes first (TST-12). A size whose
    // catalog row is gone has no facts: its row went with it.
    const sizes: StockLinkSizeFacts[] = claims.flatMap(claim => {
      const row = skuRows.get(claim.productVariantId);
      const choice = selection.get(claim.productVariantId);
      if (!row || !choice) return [];
      const head = headByVariant.get(claim.productVariantId) ?? null;
      return [{ productVariantId: claim.productVariantId, productId: row.productId, cardShellzSku: row.cardShellzSku,
        selection: { action: choice.action, blockerCodes: [...choice.blockerCodes] },
        head: head === null ? null : { revision: head.revision, active: head.active, draft: head.draft },
        observedSku: claim.observedSku, feedHintItemId: row.feedHintItemId }];
    });
    return { sizes, heads, carried, recentRetireCount };
  }

  /**
   * §7.2 step 5: lookups (50 SKUs a call) and observations (100 items a call), batched in claim order and called in
   * the order of the earliest size each serves, within the call budget less the one kept for the control read.
   */
  private async readStore(run: DestinationRun, sizes: readonly StockLinkSizeFacts[], carried: readonly { productVariantId: number; sku: string | null }[]):
    Promise<{ kind: "reads"; value: StoreReads } | { kind: "flow"; flow: Flow }> {
    const position = new Map(sizes.map((size, index) => [size.productVariantId, index]));
    const needs = planStockLinkReads({ sizes, carriedSkus: carried })
      .sort((a, b) => position.get(a.productVariantId)! - position.get(b.productVariantId)!);
    type Batch = { kind: "lookup" | "observe"; first: number; values: string[] };
    const batches: Batch[] = [];
    const seenSkus = new Set<string>();
    const seenItems = new Set<string>();
    let lookup: Batch | null = null;
    let observe: Batch | null = null;
    needs.forEach((need, index) => {
      const key = need.lookupSku === null ? null : normalizeStockLinkSku(need.lookupSku);
      if (key?.kind === "sku" && !seenSkus.has(key.key)) {
        seenSkus.add(key.key);
        if (lookup === null || lookup.values.length >= STOCK_LINK_LOOKUP_SKUS_MAX) {
          lookup = { kind: "lookup", first: index, values: [] };
          batches.push(lookup);
        }
        lookup.values.push(key.value);
      }
      for (const itemId of need.observeItemIds) {
        if (seenItems.has(itemId)) continue;
        seenItems.add(itemId);
        if (observe === null || observe.values.length >= STOCK_LINK_OBSERVE_ITEMS_MAX) {
          observe = { kind: "observe", first: index, values: [] };
          batches.push(observe);
        }
        observe.values.push(itemId);
      }
    });
    batches.sort((a, b) => a.first - b.first || (a.kind === b.kind ? 0 : a.kind === "observe" ? -1 : 1));
    const reads: StoreReads = { lookups: [], observations: [], stoppedBy: null, callsUsed: 0 };
    const signal = run.tick.signal;
    for (const batch of batches) {
      if (reads.callsUsed >= L.callsPerDestination - 1 || run.tick.timeUp()) break;
      const result = batch.kind === "lookup"
        ? await this.providerCall(run, reads, () => run.binding.adapter.findItemsBySku(run.destination, batch.values, { signal }))
        : await this.providerCall(run, reads, () => run.binding.adapter.observeItems(run.destination, batch.values, { signal }));
      if (!result.ok) {
        if (result.action === "halt" || result.action === "pause" || result.action === "stop_tick")
          return { kind: "flow", flow: await this.failDestination(run, result, "store_read") };
        // Throttled, a cost floor, a 5xx: the destination's reads stop for the tick (§7.2 step 5).
        reads.stoppedBy = result;
        break;
      }
      if ("skus" in result.value) {
        reads.lookups.push(result.value);
        run.tick.summary.lookups += result.value.skus.length;
      } else {
        reads.observations.push(result.value);
      }
    }
    return { kind: "reads", value: reads };
  }

  private async providerCall<T extends StockLinkSkuLookup | StockLinkItemObservation>(run: DestinationRun, reads: StoreReads,
    call: () => Promise<T>): Promise<StepResult<T>> {
    reads.callsUsed += 1;
    run.tick.summary.providerCalls += 1;
    const result = await this.step(call);
    if (result.ok && "observations" in result.value) run.tick.summary.observations += result.value.observations.length;
    return result;
  }

  /** What the commands are decided on (§4.3 step 0, §6.1): the oldest read and the one login every read was made with. */
  private async evidenceOf(run: DestinationRun, reads: StoreReads): Promise<StockLinkCommandRequest["evidence"]> {
    const all = [...reads.lookups, ...reads.observations];
    if (all.length === 0) {
      // Nothing was read (every decision came from the database alone): the login as stored now.
      return { observedAt: this.now().toISOString(),
        readFingerprint: await run.binding.source.readFingerprint(this.deps.db, run.destination) };
    }
    const fingerprints = new Set(all.map(read => read.readFingerprint));
    if (fingerprints.size !== 1) {
      throw Object.assign(new Error("The store's login changed while it was being read; it is read again."),
        { code: C.connectionChanged });
    }
    const observedAt = all.map(read => read.observedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
    return { observedAt, readFingerprint: [...fingerprints][0]! };
  }

  /** §7.2 step 7: one command per product, within the fence and time budgets; members not run are released busy. */
  private async applyCommands(run: DestinationRun, plan: StockLinkBatchPlan, claims: readonly StockLinkClaimedCheck[],
    evidence: StockLinkCommandRequest["evidence"]): Promise<{ flow: Flow; stopped: boolean; notRun: Map<number, string> }> {
    const notRun = new Map<number, string>();
    const claimByVariant = new Map(claims.map(claim => [claim.productVariantId, claim]));
    for (const command of plan.commands) {
      const budget = run.tick.commandBudgetCode();
      if (budget !== null) {
        for (const member of command.members) notRun.set(member.productVariantId, budget);
        continue;
      }
      const request: StockLinkCommandRequest = { destination: run.destination, command, evidence,
        claims: command.members.map(member => {
          const claim = claimByVariant.get(member.productVariantId)!;
          return { productVariantId: claim.productVariantId, leaseToken: claim.leaseToken, revision: claim.revision };
        }) };
      const ran = await this.step(() => this.deps.runCommand(request, run.binding.source));
      if (!ran.ok) {
        // The command records its own rows and throws only when that recording failed.
        if (ran.action === "stop_tick" || ran.action === "halt" || ran.action === "pause")
          return { flow: await this.failDestination(run, ran, "command"), stopped: true, notRun };
        this.log.warn(ACTION, { ...run.correlation, phase: "command", outcome: "record_failed", product_id: command.productId,
          error_code: ran.failure.code, error_class: ran.failure.errorClass });
        continue;
      }
      const result = ran.value;
      run.tick.recordFenceHold(result.fenceHoldMs);
      if (result.status === "applied") {
        run.tick.summary.applies += 1;
        for (const member of command.members) {
          if (member.change === "link") run.tick.summary.links += 1;
          else if (member.change === "relink") run.tick.summary.relinks += 1;
          else if (member.change === "retire") run.tick.summary.retires += 1;
        }
      } else if (result.status === "stopped") {
        // The switch was turned off or the destination halted under the command (PG 21): nothing more this tick.
        this.log.debug(ACTION, { ...run.correlation, phase: "command", outcome: "stopped", reason: result.reason });
        return { flow: "continue", stopped: true, notRun };
      } else if (result.status === "failed" && result.failure.scope !== "row") {
        const routed = { ok: false as const, failure: result.failure, action: stockLinkTickFailureAction(result.failure),
          message: result.message };
        return { flow: await this.failDestination(run, routed, "command"), stopped: true, notRun };
      }
    }
    return { flow: "continue", stopped: false, notRun };
  }

  /** §7.2 step 8: every claimed size outside a run command, guarded by the claim (lease token and revision). */
  private async recordDecisions(run: DestinationRun, plan: StockLinkBatchPlan, claims: readonly StockLinkClaimedCheck[],
    heads: readonly StockLinkHeadRead[], reads: StoreReads, notRun: ReadonlyMap<number, string>): Promise<Flow> {
    const decisions = new Map(plan.decisions.map(decision => [decision.productVariantId, decision]));
    const ran = new Set(plan.commands.flatMap(command => command.members.map(member => member.productVariantId))
      .filter(variantId => !notRun.has(variantId)));
    const linked = new Set(heads.filter(head => head.active !== null).map(head => head.productVariantId));
    const guards = claims.filter(claim => decisions.has(claim.productVariantId) && !ran.has(claim.productVariantId))
      .map(claim => ({ productVariantId: claim.productVariantId, leaseToken: claim.leaseToken, revision: claim.revision }));
    // Background discovery removes sizes it no longer carries (D-P6-10).
    // An explicit product check retains its definitive exclusion so the durable
    // workflow can distinguish it from work that has not been processed yet.
    const uncarried = run.productScope !== undefined ? [] : guards.filter(guard => {
      const decision = decisions.get(guard.productVariantId)!;
      return decision.change === "none" && decision.status === "waiting" && decision.code === STOCK_LINK_DECISION_CODES.selectionBlocked
        && decision.selectionAction !== "publish" && decision.selectionAction !== "zero" && !linked.has(guard.productVariantId);
    });
    const deleted = await this.step(() => this.deps.store.deleteClaimedChecks(run.destination.publicationTargetId, uncarried));
    if (!deleted.ok) return this.writeFailed(run, deleted, "record");
    const removed = new Set(deleted.value);
    const now = this.now();
    const flagged: StockLinkSizeDecision[] = [];
    const firstTransient: number[] = [];
    const readFailure = reads.stoppedBy?.failure ?? null;
    const recorded = await this.step(() => this.deps.store.recordOutcomes(run.destination.publicationTargetId,
      guards.filter(guard => !removed.has(guard.productVariantId)), now, (variantId, previous) => {
        const budget = notRun.get(variantId);
        if (budget !== undefined) return stockLinkCheckAfterFailure({ kind: "busy", code: budget, retryAfterMs: null }, null, previous, now, this.deps.random);
        const decision = decisions.get(variantId)!;
        if (decision.rule === "unread" && readFailure !== null) {
          if (readFailure.kind === "transient" && previous.attemptCount === 0) firstTransient.push(variantId);
          return stockLinkCheckAfterFailure(readFailure, reads.stoppedBy!.message, previous, now, this.deps.random);
        }
        if (decision.status === "flagged" && (previous.status !== "flagged" || previous.reasonCode !== decision.code)) flagged.push(decision);
        if (decision.retry === "transient" && previous.attemptCount === 0) firstTransient.push(variantId);
        return stockLinkCheckAfterDecision(decision, previous, now, this.deps.random);
      }));
    if (!recorded.ok) return this.writeFailed(run, recorded, "record");
    run.tick.summary.flags += plan.decisions.filter(decision => decision.status === "flagged").length;
    // §10: ERROR on entering `flagged` (a person must fix a SKU), once per reason; WARN on the first transient of a streak.
    for (const decision of flagged) {
      this.log.error("inventory_availability.stock_link.flagged", { ...run.correlation, outcome: "flagged",
        product_id: decision.productId, product_variant_ids: [decision.productVariantId], error_code: decision.code, rule: decision.rule });
    }
    if (firstTransient.length > 0) {
      this.log.warn(ACTION, { ...run.correlation, phase: "record", outcome: "retry_scheduled",
        product_variant_ids: firstTransient.sort((a, b) => a - b), error_code: readFailure?.code ?? C.lookupMissed });
    }
    return "continue";
  }

  /** §7.2 step 6 tail and the destination's pause state (SAF-5 holders, SAF-7 pause, a working login lifts its pause). */
  private async afterBatch(run: DestinationRun, plan: StockLinkBatchPlan, reads: StoreReads): Promise<Flow> {
    const { store } = this.deps;
    const targetId = run.destination.publicationTargetId;
    const now = this.now();
    if (plan.wakeVariantIds.length > 0) {
      const woken = await this.step(() => store.wakeChecks(targetId, plan.wakeVariantIds, now));
      if (!woken.ok) return this.writeFailed(run, woken, "wake");
    }
    if (plan.retiresHeld > 0) {
      this.log.warn(ACTION, { ...run.correlation, phase: "decision", outcome: "retires_held", error_code: STOCK_LINK_DECISION_CODES.retiresHeld,
        held: plan.retiresHeld });
    }
    // A control the plan could not get (no call or time left) is not proof the store stopped answering: no pause then.
    if (plan.pause === "set" && plan.control.status !== "needs_read") {
      const until = new Date(now.getTime() + stockLinkPauseDelayMs(run.state.pausedSince, now));
      const paused = await this.step(() => store.pause(targetId, { code: C.storeNotAnswering, now, until }));
      if (!paused.ok) return this.writeFailed(run, paused, "pause");
      (paused.value ? this.log.warn : this.log.debug)(ACTION, { ...run.correlation, phase: "decision", outcome: "paused",
        error_code: C.storeNotAnswering, paused_until: until.toISOString() });
      return "continue";
    }
    const lift = [...(plan.pause === "clear" ? [C.storeNotAnswering] : []),
      ...(reads.lookups.length + reads.observations.length > 0 ? PROVIDER_PAUSE_CODES : [])];
    if (run.state.pausedCode !== null && lift.includes(run.state.pausedCode)) {
      const cleared = await this.step(() => store.clearPause(targetId, lift, now));
      if (!cleared.ok) return this.writeFailed(run, cleared, "pause");
      if (cleared.value !== null) this.log.info(ACTION, { ...run.correlation, phase: "decision", outcome: "resumed", error_code: cleared.value });
    }
    return "continue";
  }

  /**
   * What the listing-enrollment pass (stock-link-enrollment.run.ts) shares with the store-item pass: the steps, the
   * destination failures and the discovery, never a second copy of them.
   */
  private enrollmentContext() {
    return {
      deps: this.deps, log: this.log, now: () => this.now(), limits: L, providerPauseCodes: PROVIDER_PAUSE_CODES,
      step: <T>(work: () => Promise<T>) => this.step(work),
      discover: (run: DestinationRun<StockLinkBinding>) => this.discover(run),
      failDestination: (run: DestinationRun<StockLinkBinding>, result: StepResult<unknown> & { ok: false }, phase: string) =>
        this.failDestination(run, result, phase),
      writeFailed: (run: DestinationRun<StockLinkBinding>, result: StepResult<unknown> & { ok: false }, phase: string) =>
        this.writeFailed(run, result, phase),
      releaseAndFail: (run: DestinationRun<StockLinkBinding>, claims: readonly StockLinkClaimedCheck[],
        result: StepResult<unknown> & { ok: false }, phase: string) => this.releaseAndFail(run, claims, result, phase),
    };
  }

  /** A failure after the claim and before any decision: the claimed rows are released (busy or transient), or left
   * to expire under a pause or halt. */
  private async releaseAndFail(run: DestinationRun<StockLinkBinding>, claims: readonly StockLinkClaimedCheck[],
    result: StepResult<unknown> & { ok: false }, phase: string): Promise<Flow> {
    if (result.action === "release_busy" || result.action === "release_transient") {
      const now = this.now();
      const guards = claims.map(claim => ({ productVariantId: claim.productVariantId, leaseToken: claim.leaseToken, revision: claim.revision }));
      const released = await this.step(() => this.deps.store.recordOutcomes(run.destination.publicationTargetId, guards, now,
        (_variantId, previous) => stockLinkCheckAfterFailure(result.failure, result.message, previous, now, this.deps.random)));
      if (!released.ok) return this.writeFailed(run, released, phase);
    }
    return this.failDestination(run, result, phase);
  }
}

function skipReason(target: StockLinkTargetRow, state: StockLinkDestinationState, now: Date, tick: TickRun): string | null {
  if (!state.autoLinkEnabled) return "switch_off";
  if (state.haltedAt !== null) return "halted";
  if (state.pausedUntil !== null && state.pausedUntil > now) return "paused";
  // Nothing publishes to a held target, so nothing is linked for it either (BUILD-NOTES D-P7-2).
  if (target.heldAt !== null) return "target_held";
  if (tick.timeUp()) return "time_budget_used";
  return null;
}

function batchReadsOf(reads: StoreReads, controlReadDone: boolean): StockLinkBatchReads {
  const lookupItems: StockLinkStoreItem[] = reads.lookups.flatMap(lookup => lookup.items);
  return {
    lookedUpSkus: reads.lookups.flatMap(lookup => lookup.skus),
    lookupItems,
    observations: reads.observations.flatMap(observation => observation.observations),
    controlReadDone,
  };
}

/** The destinations' bindings by kind and provider (one per pair). */
export function createStockLinkRegistry(bindings: readonly StockLinkBinding[]): StockLinkRegistry {
  const byKey = new Map<string, StockLinkBinding>();
  for (const binding of bindings) {
    const { adapter, source } = binding;
    if (adapter.destinationKind !== source.destinationKind || adapter.providerKey !== source.providerKey) {
      throw new Error("A stock-link binding pairs an adapter and a source of different destinations.");
    }
    const key = `${adapter.destinationKind}:${adapter.providerKey}`;
    if (byKey.has(key)) throw new Error(`A stock-link binding for ${key} is registered twice.`);
    byKey.set(key, binding);
  }
  return { resolve: (destinationKind, providerKey) => byKey.get(`${destinationKind}:${providerKey}`) ?? null };
}
