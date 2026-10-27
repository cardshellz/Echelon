import type { ZodType, ZodTypeDef } from "zod";
import {
  LISTING_END_OPS_ERROR_CODES,
  listingEndOpsActionAnswerSchema,
  listingEndOpsListAnswerSchema,
  type ListingEndOpsActionAnswer,
  type ListingEndOpsListAnswer,
  type ListingEndOpsRow,
  type ListingEndRequestState,
  type ListingEndStaffAction,
  type ListingEndStaffOutcome,
} from "../../../../shared/dropship/listing-end-ops";
import { DropshipError } from "../domain/errors";
import {
  decideListingEndStaffAction,
  decideListingEndStaffRecovery,
  listingEndStaffRecoveryCheck,
  type ListingEndRecoveryScope,
} from "../domain/listing-end-staff";
import {
  listListingEndsInputSchema,
  resolveListingEndInputSchema,
  retryListingEndInputSchema,
  type ListListingEndsInput,
  type ListingEndOpsActor,
} from "./dropship-listing-end-ops-dtos";
import type { DropshipClock } from "./dropship-ports";

/**
 * Card Shellz staff's list of listing end requests, with Retry and Mark resolved (PR C, PLAN-C v4.1 §10; D36, DC15,
 * DC27, DC32). Orchestration only: the rules are the domain's (listing-end-staff.ts), the SQL the repository's.
 *
 * Every action is one transaction (the repository's): the vendor's selection lock (the save's and the claim's key), the
 * request `FOR UPDATE`, the decision on the locked row, then the write with its audit row (actor, reason, before →
 * after). Retry first asks inventory planning's published recovery about the SKU's open requests (SAF-3 b), inside the
 * same transaction: recovery is database-only (it never calls eBay) and takes only try-locks of its own, so holding the
 * request's lock meanwhile can make nothing wait on it. Retry then sets the request `pending`: the worker's claim
 * re-runs every check (§5.4), so a size the vendor picked again is superseded, never withdrawn (DC15).
 */

export interface ListingEndOpsLockedRow {
  endRequestId: number;
  vendorId: number;
  storeConnectionId: number;
  listingId: number;
  productVariantId: number;
  state: ListingEndRequestState;
  version: number;
  code: string | null;
  staffAction: ListingEndStaffAction | null;
  staffActionKey: string | null;
  resolvedIdentity: unknown;
  withdrawCallCount: number;
  withdrawRequestedAt: Date | null;
}

/** A staff write on the locked request. Each writes its audit row in the same transaction. */
export interface ListingEndOpsWrite {
  idempotencyKey: string;
  reason: string | null;
  actor: ListingEndOpsActor;
  now: Date;
}

/** The request locked for one staff action, with the writes the action may make on it. */
export interface ListingEndOpsTransaction {
  readonly row: ListingEndOpsLockedRow;
  /** `failed` → `pending`, due now, every count and the withdraw fields cleared (the staff authorization of another withdraw). */
  retry(write: ListingEndOpsWrite): Promise<void>;
  /** The listing becomes `ended` (ids kept, no vendor end time) and the request `ended` ENDED_BY_STAFF (§10, SAF-8). */
  resolveEnded(write: ListingEndOpsWrite): Promise<{ listingWritten: boolean }>;
  /** `failed` → `resolved`: the end is closed; the listing stays as it is on eBay. */
  resolveLeft(write: ListingEndOpsWrite): Promise<void>;
}

export interface DropshipListingEndOpsRepository {
  list(input: ListListingEndsInput): Promise<ListingEndOpsListAnswer>;
  /**
   * Locks the request (vendor lock, then the row `FOR UPDATE`, lock timeout 2 s) and runs `work`; then reads the row as
   * staff see it and commits. A throw rolls everything back. A lock wait past the timeout throws STAFF_BUSY.
   */
  withLockedEndRequest<T>(endRequestId: number, work: (tx: ListingEndOpsTransaction) => Promise<T>):
    Promise<{ found: false } | { found: true; value: T; row: ListingEndOpsRow }>;
}

/** Inventory planning's published response recovery (server/modules/inventory-planning/quantity-publication.ts). */
export interface ListingEndOpsRecoveryPort {
  reconcile(scopes: readonly ListingEndRecoveryScope[]): Promise<{ resolved: string[]; unresolved: string[]; busy: boolean }>;
}

/** Structured lines through the platform logger (CLAUDE.md §10). */
export interface ListingEndOpsLog {
  debug(action: string, fields: Record<string, unknown>): void;
  info(action: string, fields: Record<string, unknown>): void;
}

const CODES = LISTING_END_OPS_ERROR_CODES;

export class DropshipListingEndOpsService {
  constructor(private readonly deps: {
    repository: DropshipListingEndOpsRepository;
    recovery: ListingEndOpsRecoveryPort;
    clock: DropshipClock;
    log: ListingEndOpsLog;
  }) {}

  async list(input: unknown): Promise<ListingEndOpsListAnswer> {
    const parsed = parseInput(listListingEndsInputSchema, input, CODES.listInvalidInput, "The listing end list query failed validation.");
    const answer = listingEndOpsListAnswerSchema.parse(await this.deps.repository.list(parsed));
    this.deps.log.debug("dropship.listing_end_ops.listed", { outcome: "listed", state: parsed.state, vendor_id: parsed.vendorId ?? null,
      store_connection_id: parsed.storeConnectionId ?? null, page: answer.page, limit: answer.limit, total: answer.total });
    return answer;
  }

  async retry(input: unknown): Promise<ListingEndOpsActionAnswer> {
    const parsed = parseInput(retryListingEndInputSchema, input, CODES.actionInvalidInput, "The listing end Retry failed validation.");
    const write = { idempotencyKey: parsed.idempotencyKey, reason: parsed.reason ?? null, actor: parsed.actor, now: this.deps.clock.now() };
    return this.act(parsed.endRequestId, "retry", write, async (tx) => {
      const check = listingEndStaffRecoveryCheck(tx.row);
      if (check.kind === "identity_unreadable") throw recoveryRequired(tx.row, [], "identity_unreadable");
      if (check.kind === "scope") {
        const recovery = decideListingEndStaffRecovery(await this.deps.recovery.reconcile([check.scope]));
        if (recovery.outcome === "busy") throw staffBusy(tx.row, "inventory_recovery_busy");
        if (recovery.outcome === "unresolved") throw recoveryRequired(tx.row, recovery.attemptIds, "unresolved_attempts");
      }
      await tx.retry(write);
      return {};
    });
  }

  async resolve(input: unknown): Promise<ListingEndOpsActionAnswer> {
    const parsed = parseInput(resolveListingEndInputSchema, input, CODES.actionInvalidInput, "The listing end resolve failed validation.");
    const write = { idempotencyKey: parsed.idempotencyKey, reason: parsed.reason, actor: parsed.actor, now: this.deps.clock.now() };
    const action = staffActionOf(parsed.outcome);
    return this.act(parsed.endRequestId, action, write, async (tx) => {
      if (action === "resolve_ended") return { listingWritten: (await tx.resolveEnded(write)).listingWritten };
      await tx.resolveLeft(write);
      return {};
    });
  }

  /** One staff action: lock, decide on the locked row (replay, refusal or apply), apply, answer the row as it now is. */
  private async act(endRequestId: number, action: ListingEndStaffAction, write: ListingEndOpsWrite,
    apply: (tx: ListingEndOpsTransaction) => Promise<{ listingWritten?: boolean }>): Promise<ListingEndOpsActionAnswer> {
    const result = await this.deps.repository.withLockedEndRequest(endRequestId, async (tx) => {
      const decision = decideListingEndStaffAction(tx.row, { action, idempotencyKey: write.idempotencyKey });
      if (decision.outcome === "replay") return { replay: true, before: tx.row, applied: {} };
      if (decision.outcome === "refused") throw staffRefusal(decision.reason, tx.row, action);
      return { replay: false, before: tx.row, applied: await apply(tx) };
    });
    if (!result.found) {
      throw new DropshipError(CODES.notFound, "This listing end request was not found.",
        { endRequestId, classification: "permanent", retryable: false });
    }
    const { replay, before, applied } = result.value;
    const fields = { action, end_request_id: endRequestId, vendor_id: before.vendorId, store_connection_id: before.storeConnectionId,
      listing_id: before.listingId, actor_id: write.actor.actorId, idempotency_key: write.idempotencyKey };
    if (replay) {
      // The same press answered again (a lost answer): expected, nothing written.
      this.deps.log.debug("dropship.listing_end_ops.replayed", { ...fields, outcome: "replayed", state: result.row.state });
    } else {
      this.deps.log.info("dropship.listing_end_ops.applied", { ...fields, outcome: "applied", reason: write.reason,
        before: { state: before.state, code: before.code, version: before.version }, after: { state: result.row.state, code: result.row.code },
        ...(applied.listingWritten !== undefined ? { listing_written: applied.listingWritten } : {}) });
    }
    return listingEndOpsActionAnswerSchema.parse({ endRequest: result.row, action, idempotentReplay: replay });
  }
}

function staffActionOf(outcome: ListingEndStaffOutcome): ListingEndStaffAction {
  return outcome === "ended_on_ebay" ? "resolve_ended" : "resolve_left";
}

function parseInput<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown, code: string, message: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new DropshipError(code, message, {
    classification: "permanent", retryable: false,
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })),
  });
}

function rowContext(row: ListingEndOpsLockedRow): Record<string, unknown> {
  return { endRequestId: row.endRequestId, state: row.state, staffAction: row.staffAction };
}

// PROPOSED (Stage 4, step 1 plan S2-5): staff words of the refusals (the recovery one is §11's staffRecoveryRequired).
function staffRefusal(reason: "key_reused" | "state_invalid", row: ListingEndOpsLockedRow, action: ListingEndStaffAction): DropshipError {
  if (reason === "key_reused") {
    return new DropshipError(CODES.staffKeyReused, "This idempotency key already answered another action on this end request.",
      { ...rowContext(row), action, classification: "permanent", retryable: false });
  }
  return new DropshipError(CODES.staffStateInvalid, "Only an end request that failed can be retried or marked resolved.",
    { ...rowContext(row), action, classification: "permanent", retryable: false });
}

function recoveryRequired(row: ListingEndOpsLockedRow, attemptIds: string[], reason: "unresolved_attempts" | "identity_unreadable"): DropshipError {
  return new DropshipError(CODES.quantityRecoveryRequired,
    "Settle the open inventory request first (Inventory publication recovery), then retry.",
    { ...rowContext(row), reason, attemptIds, classification: "permanent", retryable: false });
}

function staffBusy(row: ListingEndOpsLockedRow, reason: string): DropshipError {
  return new DropshipError(CODES.staffBusy, "Nothing was changed because another update was running. Try again in a moment.",
    { ...rowContext(row), reason, classification: "transient", retryable: true });
}
