import { z } from "zod";
import {
  LISTING_PUSH_RUN_CHUNK_SIZE,
  LISTING_PUSH_RUN_ERROR_CODES,
  LISTING_PUSH_RUN_PROBLEMS_PAGE_SIZE,
  MAX_LISTING_PUSH_RUNS_LISTED,
  createListingPushRunRequestSchema,
  type ListingPushRunCounts,
  type ListingPushRunProblem,
  type ListingPushRunScope,
  type ListingPushRunStatus,
  type ListingPushRunStopReason,
  type ListingPushRunView,
} from "../../../../shared/dropship/listing-push-runs";
import { DropshipError } from "../domain/errors";
import { hashListingPushRunRequest } from "../domain/listing-push-run";
import { LISTING_PUSH_RUN_WORDS } from "../domain/listing-push-run-words";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import { createListingPushRunInputSchema, type CreateListingPushRunInput } from "./dropship-use-case-dtos";

/**
 * Publish runs for the vendor portal (step 1 plan S2-5, PR A, §4.2 and §4.6):
 * create one from the server's snapshot of the selection, list them, read one
 * with its counts and problems, and stop one. Every read is scoped to the
 * member's own vendor: another vendor's run reads as not found. The push sweep
 * carries runs out (dropship-listing-push-run-sweep.ts).
 */

export interface DropshipListingPushRunRecord {
  runId: number;
  vendorId: number;
  storeConnectionId: number;
  scope: ListingPushRunScope;
  status: ListingPushRunStatus;
  stopReason: ListingPushRunStopReason | null;
  selectionRevisionId: number | null;
  idempotencyKey: string;
  requestHash: string;
  targetCount: number;
  chunkSize: number;
  chunkCount: number;
  nextChunkIndex: number;
  chunkAttempts: number;
  actorType: "vendor" | "admin" | "system";
  actorId: string | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface CreateListingPushRunRepositoryInput {
  vendorId: number;
  storeConnectionId: number;
  scope: ListingPushRunScope;
  idempotencyKey: string;
  requestHash: string;
  expectedSelectionRevisionId: number | null;
  chunkSize: number;
  actor: CreateListingPushRunInput["actor"];
  now: Date;
}

export interface DropshipListingPushRunRepository {
  findVendorIdByMemberId(memberId: string): Promise<number | null>;
  /** The vendor's run made under this request key, if any (a read; the create replays under its lock too). */
  findRunByKey(input: { vendorId: number; idempotencyKey: string }): Promise<DropshipListingPushRunRecord | null>;
  /**
   * One transaction under the vendor's selection lock: replay by key, the
   * revision check, the selection snapshot, the scope filter, the run, its
   * targets and the audit row (§4.2 step 2).
   */
  createRun(input: CreateListingPushRunRepositoryInput): Promise<{ run: DropshipListingPushRunRecord; idempotentReplay: boolean }>;
  listRuns(input: { vendorId: number; storeConnectionId: number; limit: number }): Promise<Array<{
    run: DropshipListingPushRunRecord; counts: ListingPushRunCounts;
  }>>;
  getRun(input: { vendorId: number; runId: number; problemsAfter: number; problemsLimit: number; now: Date }): Promise<{
    run: DropshipListingPushRunRecord; counts: ListingPushRunCounts; problems: ListingPushRunProblem[]; hasMoreProblems: boolean;
    /** The paused child job's next attempt, when one waits after `now` (review DUX5). */
    waitingUntil: Date | null;
    /** Completed sizes the store saved as unpublished drafts (review DUX7). */
    drafts: number;
  } | null>;
  /** One transaction: the run's pending targets and its jobs' queued items are cancelled; idempotent by state. */
  stopRun(input: { vendorId: number; runId: number; actor: CreateListingPushRunInput["actor"]; now: Date }): Promise<{
    run: DropshipListingPushRunRecord; counts: ListingPushRunCounts; changed: boolean;
  } | null>;
}

/** The same store and account checks a push job makes (DropshipListingPreviewService.assertListingPushAccess). */
export interface DropshipListingPushAccessCheck {
  assertListingPushAccess(vendorId: number, storeConnectionId: number): Promise<unknown>;
}

export interface DropshipListingPushRunServiceDependencies {
  repository: DropshipListingPushRunRepository;
  pushAccess: DropshipListingPushAccessCheck;
  clock: DropshipClock;
  logger: DropshipLogger;
}

const memberIdSchema = z.string().trim().min(1).max(255);
const runIdSchema = z.number().int().positive().safe();
const storeIdSchema = z.number().int().positive().max(2_147_483_647);
const listInputSchema = z.object({
  storeConnectionId: storeIdSchema,
  limit: z.number().int().min(1).max(MAX_LISTING_PUSH_RUNS_LISTED).default(MAX_LISTING_PUSH_RUNS_LISTED),
}).strict();
const detailInputSchema = z.object({
  runId: runIdSchema,
  problemsAfter: z.number().int().nonnegative().max(2_147_483_647).default(0),
}).strict();

export class DropshipListingPushRunService {
  constructor(private readonly deps: DropshipListingPushRunServiceDependencies) {}

  async createRunForMember(memberId: unknown, body: unknown): Promise<{ run: ListingPushRunView; idempotentReplay: boolean }> {
    const member = parseMember(memberId);
    const request = parseInput(createListingPushRunRequestSchema, body);
    const vendorId = await this.requireVendor(member, request.storeConnectionId);
    const parsed = createListingPushRunInputSchema.parse({
      ...request, vendorId, actor: { actorType: "vendor", actorId: member },
    });
    const requestHash = hashListingPushRunRequest({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      scope: parsed.scope,
      expectedSelectionRevisionId: parsed.expectedSelectionRevisionId,
    });
    // A press sent again with its key gets the run it already made, before the access checks: a store blocked since
    // then must not answer the retry with a refusal for a run that exists (verify V11). It writes nothing.
    const existing = await this.deps.repository.findRunByKey({ vendorId: parsed.vendorId, idempotencyKey: parsed.idempotencyKey });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new DropshipError(LISTING_PUSH_RUN_ERROR_CODES.idempotencyConflict, LISTING_PUSH_RUN_WORDS.keyReused,
          { vendorId: parsed.vendorId, storeConnectionId: parsed.storeConnectionId, classification: "permanent" });
      }
      this.logCreated({ run: existing, idempotentReplay: true }, member);
      return { run: toListingPushRunView(existing), idempotentReplay: true };
    }
    // The same refusals as a push job (inactive account, lapsed membership, store not ready), before anything is written.
    await this.deps.pushAccess.assertListingPushAccess(parsed.vendorId, parsed.storeConnectionId);
    const result = await this.deps.repository.createRun({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      scope: parsed.scope,
      idempotencyKey: parsed.idempotencyKey,
      requestHash,
      expectedSelectionRevisionId: parsed.expectedSelectionRevisionId,
      chunkSize: LISTING_PUSH_RUN_CHUNK_SIZE,
      actor: parsed.actor,
      now: this.deps.clock.now(),
    });
    this.logCreated(result, member);
    return { run: toListingPushRunView(result.run), idempotentReplay: result.idempotentReplay };
  }

  private logCreated(result: { run: DropshipListingPushRunRecord; idempotentReplay: boolean }, member: string): void {
    this.deps.logger.info({
      code: result.idempotentReplay ? "DROPSHIP_LISTING_PUSH_RUN_REPLAYED" : "DROPSHIP_LISTING_PUSH_RUN_CREATED",
      message: result.idempotentReplay
        ? "A publish run create was replayed by its request key."
        : "A publish run was created from the vendor's selection.",
      context: {
        runId: result.run.runId,
        vendorId: result.run.vendorId,
        storeConnectionId: result.run.storeConnectionId,
        scope: result.run.scope,
        targetCount: result.run.targetCount,
        chunkCount: result.run.chunkCount,
        selectionRevisionId: result.run.selectionRevisionId,
        actorId: member,
      },
    });
  }

  async listRunsForMember(memberId: unknown, query: unknown): Promise<{ runs: Array<{ run: ListingPushRunView; counts: ListingPushRunCounts }> }> {
    const member = parseMember(memberId);
    const input = parseInput(listInputSchema, query);
    const vendorId = await this.deps.repository.findVendorIdByMemberId(member);
    if (vendorId === null) return { runs: [] };
    const runs = await this.deps.repository.listRuns({ vendorId, storeConnectionId: input.storeConnectionId, limit: input.limit });
    return { runs: runs.map((row) => ({ run: toListingPushRunView(row.run), counts: row.counts })) };
  }

  async getRunForMember(memberId: unknown, query: unknown): Promise<{
    run: ListingPushRunView; counts: ListingPushRunCounts; problems: { items: ListingPushRunProblem[]; nextCursor: number | null };
    waitingUntil: string | null; drafts: number;
  }> {
    const member = parseMember(memberId);
    const input = parseInput(detailInputSchema, query);
    const vendorId = await this.deps.repository.findVendorIdByMemberId(member);
    const found = vendorId === null ? null : await this.deps.repository.getRun({
      vendorId, runId: input.runId, problemsAfter: input.problemsAfter, problemsLimit: LISTING_PUSH_RUN_PROBLEMS_PAGE_SIZE,
      now: this.deps.clock.now(),
    });
    if (!found) throw runNotFound(input.runId);
    const lastItem = found.problems.at(-1);
    return {
      run: toListingPushRunView(found.run),
      counts: found.counts,
      problems: { items: found.problems, nextCursor: found.hasMoreProblems && lastItem ? lastItem.productVariantId : null },
      waitingUntil: found.waitingUntil ? found.waitingUntil.toISOString() : null,
      drafts: found.drafts,
    };
  }

  async stopRunForMember(memberId: unknown, runId: unknown): Promise<{ run: ListingPushRunView; counts: ListingPushRunCounts }> {
    const member = parseMember(memberId);
    const id = runIdSchema.safeParse(runId);
    if (!id.success) throw invalidInput(id.error.issues);
    const vendorId = await this.deps.repository.findVendorIdByMemberId(member);
    const stopped = vendorId === null ? null : await this.deps.repository.stopRun({
      vendorId, runId: id.data, actor: { actorType: "vendor", actorId: member }, now: this.deps.clock.now(),
    });
    if (!stopped) throw runNotFound(id.data);
    this.deps.logger.info({
      code: stopped.changed ? "DROPSHIP_LISTING_PUSH_RUN_STOP_REQUESTED" : "DROPSHIP_LISTING_PUSH_RUN_STOP_REPLAYED",
      message: stopped.changed
        ? "The vendor stopped a publish run: its pending sizes and queued items were cancelled."
        : "A stop was pressed again for a publish run that was already stopping or finished.",
      context: { runId: stopped.run.runId, vendorId: stopped.run.vendorId, storeConnectionId: stopped.run.storeConnectionId,
        status: stopped.run.status, counts: stopped.counts, actorId: member },
    });
    return { run: toListingPushRunView(stopped.run), counts: stopped.counts };
  }

  /** The member's vendor, or the store refusal a push job gives a member with no vendor. */
  private async requireVendor(memberId: string, storeConnectionId: number): Promise<number> {
    const vendorId = await this.deps.repository.findVendorIdByMemberId(memberId);
    if (vendorId === null) {
      throw new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED",
        "Dropship store connection is required before listing push.", { storeConnectionId, action: "push" });
    }
    return vendorId;
  }
}

export function toListingPushRunView(run: DropshipListingPushRunRecord): ListingPushRunView {
  return {
    runId: run.runId,
    storeConnectionId: run.storeConnectionId,
    scope: run.scope,
    status: run.status,
    stopReason: run.stopReason,
    selectionRevisionId: run.selectionRevisionId,
    targetCount: run.targetCount,
    chunkSize: run.chunkSize,
    chunkCount: run.chunkCount,
    nextChunkIndex: run.nextChunkIndex,
    cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function parseMember(memberId: unknown): string {
  const parsed = memberIdSchema.safeParse(memberId);
  if (!parsed.success) throw new DropshipError("DROPSHIP_AUTH_REQUIRED", "Sign in to publish your listings.");
  return parsed.data;
}

function parseInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidInput(parsed.error.issues);
  return parsed.data;
}

function invalidInput(issues: z.ZodIssue[]): DropshipError {
  return new DropshipError(LISTING_PUSH_RUN_ERROR_CODES.invalidInput, LISTING_PUSH_RUN_WORDS.invalidInput, {
    issues: issues.map((issue) => ({ path: issue.path, code: issue.code })),
    classification: "permanent",
  });
}

function runNotFound(runId: number): DropshipError {
  return new DropshipError(LISTING_PUSH_RUN_ERROR_CODES.notFound, LISTING_PUSH_RUN_WORDS.runNotFound, { runId });
}
