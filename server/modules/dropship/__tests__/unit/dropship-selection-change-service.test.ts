import { describe, expect, it } from "vitest";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipSelectionChangeService,
  PICKS_WRITES_CODE_VERSION,
  SELECTION_CHANGE_PLAN_MOVED,
  SELECTION_SAVE_ATTEMPTS,
  SELECTION_SAVE_RETRY_DELAYS_MS,
  retryableSaveFailureCode,
  seededJitterSource,
  selectionPicksWritesDisabled,
  selectionSaveRetryDelayMs,
  type DropshipSelectionChangeReads,
  type DropshipSelectionChangeRepository,
  type DropshipSelectionChangeTransaction,
  type SelectionChangePlanFacts,
  type StoredSelectionChangeRevision,
} from "../../application/dropship-selection-change-service";
import { DROPSHIP_CATALOG_CODE_VERSION, NEW_VERSION_SETTLE_MS, OLDER_PROCESS_GRACE_MS } from "../../domain/catalog-code-version";
import { DropshipError } from "../../domain/errors";
import type { DropshipStockSelectionCandidate } from "../../domain/stock-publication-selection";
import type { SelectionEffectsListing } from "../../domain/vendor-selection-effects";
import type { PlannedListingEnd } from "../../domain/vendor-selection-ends";
import { MAX_SELECTION_END_LISTINGS, selectionChangeAnswerSchema } from "../../../../../shared/dropship/vendor-selection-changes";
import { hashSelectionChangeRequest, parseSelectionChangeBody } from "../../application/dropship-selection-change-dtos";
import { B_STORED_ANSWER, bSelectionChangeAnswerSchema } from "../fixtures/vendor-selection-changes-b.fixture";

/**
 * The picks save's service with its transaction stubbed (PLAN-B v4.1 §8.3, §10, §14, §15.1; precedent
 * dropship-listing-price-in-transaction.test.ts): the step order, replay, the writes gate, every refusal, the
 * server retries with seeded jitter, the plan-moved rollback and the no-op save. Sizes on the vendor's one eBay
 * store: 101 picked and live (PR C: a removal ends its listing), 102 offered with a zeroed live listing (an add
 * sells it again), 103 not offered (skipped), 104 already picked, 105 not picked (an already-not-selected removal).
 * Each size is its own product (1_000 + size). PR C's cases (PLAN-C v4.1 §4.7, §13.1): the page version and the
 * echo after the replay (2a), the end writes after the picks writes (9), the pick count with hidden removals.
 */

const NOW = new Date("2026-10-24T12:00:00.000Z");
const VENDOR = 10;
const ACTOR = { actorType: "vendor" as const, actorId: "member-10" };
const KEY = "catalog-selection:00000000-0000-4000-8000-000000000001";

function candidate(productVariantId: number): DropshipStockSelectionCandidate {
  return { productId: 1_000 + productVariantId, productVariantId, productLineIds: [], category: "Supplies", productIsActive: true,
    variantIsActive: true, variantUomType: "pack", requiresShipping: true, trackInventory: true, salesEligibility: "sellable" };
}

function listing(id: number, productVariantId: number, patch: Partial<SelectionEffectsListing> = {}): SelectionEffectsListing {
  return { id, productVariantId, status: "active", externalListingId: `L-${id}`, externalOfferId: `O-${id}`, livePushItemId: null,
    vendorQuantityLimit: null, marketplaceEndedAt: null, marketplaceIssueCodes: [], openEndId: null, openEndState: null,
    pushInFlight: false, ...patch };
}

function facts(patch: Partial<SelectionChangePlanFacts> = {}): SelectionChangePlanFacts {
  return {
    pickedBefore: new Set([101, 104]),
    offered: new Set([101, 102, 104]),
    selectedBefore: 10,
    pickCountBefore: 12,
    siblingPicks: new Set(),
    pendingEnds: [],
    effects: {
      candidates: [101, 102, 103, 104, 105].map(candidate),
      adminRules: [{ id: 1, scopeType: "catalog", action: "include" }],
      overrides: [],
      stores: [{ storeConnectionId: 22, storeName: "Card corner", platform: "ebay", status: "connected", externalAccountId: "seller-22",
        providerEnvironment: "production", config: { listingMode: "live", inventoryMode: "managed_quantity_sync", isActive: true },
        storePaused: false, listings: [listing(501, 101), listing(502, 102)] }],
    },
    ...patch,
  };
}

interface Body {
  clientVersion?: number;
  expectedRevisionId: number | null;
  add: { productVariantIds: number[] };
  remove: { productVariantIds: number[] };
  idempotencyKey: string;
  expectedEffectsHash: string;
  expectedEnds?: { listingIds: number[]; hiddenRemovedIds: number[] };
  expectedOtherEntriesHash?: string;
}

/** A body of this release's page (version 3, PLAN-C v4.1 §4.1); saveBody fills the confirmed hash and the echo. */
function changeBody(patch: Partial<Body> = {}): Body {
  return { clientVersion: DROPSHIP_CATALOG_CODE_VERSION, expectedRevisionId: 41, add: { productVariantIds: [102, 103, 104] },
    remove: { productVariantIds: [101, 105] }, idempotencyKey: KEY, expectedEffectsHash: "0".repeat(64), ...patch };
}

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * A stubbed transaction: every call is logged in order, writes are held until the stub commits, and an error
 * from `work` rolls them back, as the real repository's ROLLBACK does.
 */
class FakeChangeRepository implements DropshipSelectionChangeRepository {
  calls: string[] = [];
  committed: Array<{ op: string; input: unknown }> = [];
  attempts = 0;
  head: number | null = 41;
  stored: StoredSelectionChangeRevision | null = null;
  gate = { olderVersionLive: false, versionSettled: true };
  gateInputs: unknown[] = [];
  factsByAttempt: Array<SelectionChangePlanFacts> = [];
  defaultFacts = facts();
  /** Per attempt (1-based): throw at this call. */
  failAt: Map<number, { call: string; error: unknown }> = new Map();
  preLockResult: ((ids: readonly number[], attempt: number) => number[]) | null = null;
  deleteCount: ((ids: readonly number[], attempt: number) => number) | null = null;
  insertCount: ((ids: readonly number[], attempt: number) => number) | null = null;
  supersedeCount: ((ids: readonly number[], attempt: number) => number) | null = null;
  endInsertCount: ((ends: readonly PlannedListingEnd[], attempt: number) => number) | null = null;
  nextRevisionId = 42;
  previewRuns = 0;

  private readsFor(attempt: number, pending: Array<{ op: string; input: unknown }> | null): DropshipSelectionChangeReads {
    return {
      readHeadRevisionId: async () => { this.log("readHeadRevisionId", attempt); return this.head; },
      readPlanFacts: async (input) => {
        this.log("readPlanFacts", attempt);
        pending?.push({ op: "readPlanFacts", input });
        return this.factsByAttempt[attempt - 1] ?? this.defaultFacts;
      },
    };
  }

  private log(call: string, attempt: number): void {
    this.calls.push(call);
    const failure = this.failAt.get(attempt);
    if (failure && failure.call === call) throw failure.error;
  }

  async runPreview<T>(work: (reads: DropshipSelectionChangeReads) => Promise<T>): Promise<T> {
    this.previewRuns += 1;
    this.calls.push("runPreview");
    return work(this.readsFor(0, null));
  }

  async runChange<T>(input: { vendorId: number }, work: (tx: DropshipSelectionChangeTransaction) => Promise<T>): Promise<T> {
    this.attempts += 1;
    const attempt = this.attempts;
    this.calls.push(`begin+lock:${input.vendorId}`);
    const pending: Array<{ op: string; input: unknown }> = [];
    const tx: DropshipSelectionChangeTransaction = {
      ...this.readsFor(attempt, pending),
      findRevisionByKey: async (lookup) => { this.log("findRevisionByKey", attempt); pending.push({ op: "find", input: lookup }); return this.stored; },
      readWritesGate: async (gateInput) => { this.log("readWritesGate", attempt); this.gateInputs.push(gateInput); return this.gate; },
      insertRevision: async (revision) => { this.log("insertRevision", attempt); pending.push({ op: "insertRevision", input: revision }); return this.nextRevisionId; },
      insertAudit: async (audit) => { this.log("insertAudit", attempt); pending.push({ op: "insertAudit", input: audit }); },
      preLockVariants: async ({ productVariantIds }) => {
        this.log("preLockVariants", attempt);
        return this.preLockResult ? this.preLockResult(productVariantIds, attempt) : [...productVariantIds];
      },
      deletePicks: async (del) => {
        this.log("deletePicks", attempt); pending.push({ op: "deletePicks", input: del });
        return this.deleteCount ? this.deleteCount(del.productVariantIds, attempt) : del.productVariantIds.length;
      },
      insertPicks: async (ins) => {
        this.log("insertPicks", attempt); pending.push({ op: "insertPicks", input: ins });
        return this.insertCount ? this.insertCount(ins.productVariantIds, attempt) : ins.productVariantIds.length;
      },
      supersedeListingEnds: async (sup) => {
        this.log("supersedeListingEnds", attempt); pending.push({ op: "supersedeListingEnds", input: sup });
        const ids = this.supersedeCount ? sup.endIds.slice(0, this.supersedeCount(sup.endIds, attempt)) : sup.endIds;
        return ids.map((id) => ({ id, storeConnectionId: 22, listingId: 900 + id, productVariantId: 102, reason: "size_removed" as const }));
      },
      insertListingEnds: async (ins) => {
        this.log("insertListingEnds", attempt); pending.push({ op: "insertListingEnds", input: ins });
        const ends = this.endInsertCount ? ins.ends.slice(0, this.endInsertCount(ins.ends, attempt)) : ins.ends;
        return ends.map((end, index) => ({ id: 7_000 + index, storeConnectionId: end.storeConnectionId, listingId: end.listingId,
          productVariantId: end.productVariantId, reason: end.reason }));
      },
      insertListingEndAudits: async (audits) => {
        this.log("insertListingEndAudits", attempt); pending.push({ op: "insertListingEndAudits", input: audits });
      },
    };
    try {
      const result = await work(tx);
      this.calls.push("commit");
      this.committed.push(...pending.filter((entry) => !["find", "readPlanFacts"].includes(entry.op)));
      return result;
    } catch (error) {
      this.calls.push("rollback");
      throw error;
    }
  }

  committedOps(): string[] {
    return this.committed.map((entry) => entry.op);
  }

  committedInput<T>(op: string): T {
    const found = this.committed.find((entry) => entry.op === op);
    if (!found) throw new Error(`no committed ${op}`);
    return found.input as T;
  }
}

function setup(options: { disabled?: boolean; seed?: number } = {}) {
  const repository = new FakeChangeRepository();
  const logs: Array<{ level: string } & DropshipLogEvent> = [];
  const sleeps: number[] = [];
  const service = new DropshipSelectionChangeService({
    repository,
    clock: { now: () => NOW },
    logger: {
      debug: (event) => logs.push({ level: "debug", ...event }),
      info: (event) => logs.push({ level: "info", ...event }),
      warn: (event) => logs.push({ level: "warn", ...event }),
      error: (event) => logs.push({ level: "error", ...event }),
    },
    sleep: async (delayMs) => { sleeps.push(delayMs); },
    random: seededJitterSource(options.seed ?? 7),
    picksWritesDisabled: () => options.disabled === true,
  });
  return { repository, service, logs, sleeps };
}

/** What the vendor would confirm for this body (the preview's answer): its effects hash and the ends echo. */
async function confirmed(body: Body, setupFacts?: SelectionChangePlanFacts): Promise<Pick<Body, "expectedEffectsHash" | "expectedEnds"
  | "expectedOtherEntriesHash">> {
  const { service, repository } = setup();
  if (setupFacts) repository.defaultFacts = setupFacts;
  const { idempotencyKey: _key, expectedEffectsHash: _hash, expectedEnds: _ends, expectedOtherEntriesHash: _other, ...previewBody } = body;
  const preview = await service.preview({ vendorId: VENDOR, body: previewBody });
  return { expectedEffectsHash: preview.effectsHash,
    expectedEnds: { listingIds: preview.ends.listingIds, hiddenRemovedIds: preview.ends.hiddenRemovedIds },
    expectedOtherEntriesHash: preview.otherEntriesHash! };
}

function refusalOf(promise: Promise<unknown>): Promise<DropshipError> {
  return promise.then(() => { throw new Error("expected a refusal"); }, (error: unknown) => {
    if (error instanceof DropshipError) return error;
    throw error;
  });
}

async function saveBody(patch: Partial<Body> = {}, setupFacts?: SelectionChangePlanFacts): Promise<Body> {
  const body = changeBody(patch);
  return { ...body, ...await confirmed(body, setupFacts) };
}

describe("the preview (§8.2)", () => {
  it("plans, counts and prices the change in one read-only snapshot, and never opens a save", async () => {
    const { service, repository } = setup();
    const { idempotencyKey: _key, expectedEffectsHash: _hash, ...body } = changeBody();
    const preview = await service.preview({ vendorId: VENDOR, body });

    expect(repository.calls).toEqual(["runPreview", "readHeadRevisionId", "readPlanFacts"]);
    expect(repository.attempts).toBe(0);
    expect(preview).toMatchObject({
      headRevisionId: 41, toAdd: 1, toRemove: 1, alreadySelected: 1, alreadyNotSelected: 1,
      skipped: { count: 1, first: [103] }, selectedBefore: 10, selectedAfter: 10, cap: 10_000, overCapAfter: false, refused: null,
      // PR C: removing 101 ends its eBay listing (B counted it goesToZero).
      effects: [{ storeConnectionId: 22, storeName: "Card corner", platform: "ebay", goesToZero: 0, startsSelling: 1, ends: 1,
        storeConnected: true }],
      ends: { listingIds: [501], hiddenRemovedIds: [], otherSizes: 0, stillEnding: 0, endReview: 0, endedReAdd: 0 },
    });
    expect(preview.effectsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.otherEntriesHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("answers a stale expected revision with the head (the page re-reads), and a growth past the cap as refused", async () => {
    const { service, repository } = setup();
    repository.head = 77;
    repository.defaultFacts = facts({ selectedBefore: 10_000 });
    const preview = await service.preview({ vendorId: VENDOR, body: { expectedRevisionId: 41,
      add: { productVariantIds: [102] }, remove: { productVariantIds: [] } } });
    expect(preview).toMatchObject({ headRevisionId: 77, selectedAfter: 10_001, overCapAfter: true, refused: "too_large" });
  });

  it("refuses a conflicting or invalid body before any read", async () => {
    const { service, repository } = setup();
    await expect(refusalOf(service.preview({ vendorId: VENDOR, body: { expectedRevisionId: null,
      add: { productVariantIds: [5] }, remove: { productVariantIds: [5] } } }))).resolves.toMatchObject({ code: "DROPSHIP_SELECTION_CHANGE_CONFLICTING" });
    await expect(refusalOf(service.preview({ vendorId: VENDOR, body: { expectedRevisionId: null,
      add: { productVariantIds: [] }, remove: { productVariantIds: [] } } }))).resolves.toMatchObject({ code: "DROPSHIP_SELECTION_CHANGE_INVALID_INPUT" });
    expect(repository.calls).toEqual([]);
  });
});

describe("the save's order (§8.3)", () => {
  it("locks, replays, gates, checks the revision, plans, writes the ungated rows, pre-locks, then writes the picks", async () => {
    const { service, repository } = setup();
    const body = await saveBody();
    const { answer, idempotentReplay } = await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });

    expect(idempotentReplay).toBe(false);
    expect(repository.calls).toEqual([
      `begin+lock:${VENDOR}`, "findRevisionByKey", "readWritesGate", "readHeadRevisionId", "readPlanFacts",
      "insertRevision", "insertAudit", "preLockVariants", "deletePicks", "insertPicks",
      // PR C step 9 (FID-2): the end writes after the picks writes.
      "insertListingEnds", "insertListingEndAudits", "commit",
    ]);
    expect(repository.gateInputs).toEqual([{ version: PICKS_WRITES_CODE_VERSION, graceMs: OLDER_PROCESS_GRACE_MS, settleMs: NEW_VERSION_SETTLE_MS }]);
    expect(answer).toMatchObject({ revisionId: 42, toAdd: 1, toRemove: 1, alreadySelected: 1, alreadyNotSelected: 1,
      skipped: { count: 1, first: [103] }, drifted: false, confirmedEffectsHash: body.expectedEffectsHash });
    expect(selectionChangeAnswerSchema.safeParse(answer).success).toBe(true);
    expect(repository.committedInput<{ productVariantIds: number[] }>("deletePicks").productVariantIds).toEqual([101]);
    expect(repository.committedInput<{ productVariantIds: number[]; revisionId: number }>("insertPicks"))
      .toMatchObject({ productVariantIds: [102], revisionId: 42, vendorId: VENDOR, now: NOW });
  });

  it("records the revision (picks_change result, pick count after) and an audit row naming the ids written", async () => {
    const { service, repository } = setup();
    const body = await saveBody();
    const { answer } = await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });
    const revision = repository.committedInput<{ pickCount: number; result: unknown; requestHash: string; idempotencyKey: string }>("insertRevision");
    expect(revision).toMatchObject({ pickCount: 12, idempotencyKey: KEY, actor: ACTOR, now: NOW });
    expect(revision.requestHash).toMatch(/^[a-f0-9]{64}$/);
    // The stored result is the answer without its own id, so a replay sends the same answer.
    expect({ revisionId: 42, ...(revision.result as object) }).toEqual(answer);
    const audit = repository.committedInput<{ payload: Record<string, unknown>; revisionId: number }>("insertAudit");
    expect(audit).toMatchObject({ revisionId: 42, actor: ACTOR, payload: {
      revisionId: 42, idempotencyKey: KEY, addedVariantIds: [102], removedVariantIds: [101], skippedVariantIds: [103],
      alreadySelectedCount: 1, alreadyNotSelectedCount: 1, selectedBefore: 10, selectedAfter: 10,
      effects: answer.effects, effectsHash: answer.effectsHash,
    } });
    expect(audit.payload).not.toHaveProperty("confirmedEffectsHash");
  });

  it("refuses a reserved key before any repository call, and keeps a key that merely contains the words", async () => {
    const { service, repository } = setup();
    await expect(refusalOf(service.applyChange({ vendorId: VENDOR, actor: ACTOR,
      body: changeBody({ idempotencyKey: `legacy-picks-backfill:${VENDOR}:77` }) })))
      .resolves.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_KEY_RESERVED", context: { classification: "permanent", retryable: false } });
    await expect(refusalOf(service.applyChange({ vendorId: VENDOR, actor: ACTOR,
      body: changeBody({ idempotencyKey: "  legacy-picks-followup:10:5" }) }))).resolves.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_KEY_RESERVED" });
    expect(repository.calls).toEqual([]);

    const body = await saveBody({ idempotencyKey: "my-legacy-picks-key" });
    await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });
    expect(repository.committedInput<{ idempotencyKey: string }>("insertRevision").idempotencyKey).toBe("my-legacy-picks-key");
  });

  it("writes no picks and takes no gate for a no-op change: only its revision and audit", async () => {
    const { service, repository } = setup();
    const body = await saveBody({ add: { productVariantIds: [104] }, remove: { productVariantIds: [105] } });
    const { answer } = await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });
    expect(repository.committedOps()).toEqual(["insertRevision", "insertAudit"]);
    expect(repository.calls).not.toContain("preLockVariants");
    expect(answer).toMatchObject({ toAdd: 0, toRemove: 0, alreadySelected: 1, alreadyNotSelected: 1 });
  });
});

describe("replay by key", () => {
  it("answers the stored result byte for byte with the writes gate closed, reading neither the gate nor the plan", async () => {
    const first = setup();
    const body = await saveBody();
    const original = await first.service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });
    const revision = first.repository.committedInput<{ requestHash: string; result: unknown }>("insertRevision");

    const { service, repository } = setup({ disabled: true });
    repository.gate = { olderVersionLive: true, versionSettled: false };
    repository.stored = { revisionId: 42, requestHash: revision.requestHash, requestKind: "picks_change",
      result: JSON.parse(JSON.stringify(revision.result)) };
    const replay = await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });

    expect(replay.idempotentReplay).toBe(true);
    expect(JSON.stringify(selectionChangeAnswerSchema.parse(replay.answer))).toBe(JSON.stringify(selectionChangeAnswerSchema.parse(original.answer)));
    expect(repository.calls).toEqual([`begin+lock:${VENDOR}`, "findRevisionByKey", "commit"]);
    expect(repository.committedOps()).toEqual([]);
  });

  it.each([
    ["another request under the key", { requestHash: "f".repeat(64), requestKind: "picks_change", result: {} }],
    ["a rules save's revision under the key", { requestKind: "rules_replace", result: null }],
  ] as Array<[string, Partial<StoredSelectionChangeRevision>]>)("refuses %s as a key conflict (409, permanent), writing nothing", async (_label, patch) => {
    const { service, repository } = setup();
    const body = await saveBody();
    const reference = setup();
    await reference.service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });
    const hash = reference.repository.committedInput<{ requestHash: string }>("insertRevision").requestHash;
    const stored: StoredSelectionChangeRevision = { revisionId: 30, requestHash: hash, requestKind: "picks_change", result: null };
    repository.stored = { ...stored, ...patch };
    await expect(refusalOf(service.applyChange({ vendorId: VENDOR, actor: ACTOR, body })))
      .resolves.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT", context: { classification: "permanent" } });
    expect(repository.committedOps()).toEqual([]);
    expect(repository.attempts).toBe(1);
  });
});

describe("the writes readiness gate (§10)", () => {
  it.each([
    ["a fresh version-1 heartbeat", { olderVersionLive: true, versionSettled: true }],
    ["version 2 first seen under five minutes ago", { olderVersionLive: false, versionSettled: false }],
  ])("answers %s with 503 older_version_running after the replay check, writing nothing", async (_label, gate) => {
    const { service, repository } = setup();
    repository.gate = gate;
    const error = await refusalOf(service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody() }));
    expect(error).toMatchObject({ code: "DROPSHIP_SELECTION_WRITES_PAUSED",
      context: { reason: "older_version_running", classification: "transient", retryable: true } });
    expect(repository.calls).toEqual([`begin+lock:${VENDOR}`, "findRevisionByKey", "readWritesGate", "rollback"]);
    // Transient for the page (it retries), but never retried inside the request: the gate is minutes, not milliseconds.
    expect(repository.attempts).toBe(1);
  });

  it("opens once no older process is fresh and this version has settled", async () => {
    const { service, repository } = setup();
    repository.gate = { olderVersionLive: false, versionSettled: true };
    await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody() });
    expect(repository.committedOps()).toContain("insertPicks");
  });

  it("closes on the kill switch ('disabled') without reading the heartbeats, and the switch reads exactly \"true\"", async () => {
    const { service, repository } = setup({ disabled: true });
    await expect(refusalOf(service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody() })))
      .resolves.toMatchObject({ code: "DROPSHIP_SELECTION_WRITES_PAUSED", context: { reason: "disabled" } });
    expect(repository.calls).not.toContain("readWritesGate");

    expect(selectionPicksWritesDisabled({})).toBe(false);
    expect(selectionPicksWritesDisabled({ DROPSHIP_SELECTION_PICKS_WRITES_DISABLED: "true" })).toBe(true);
    for (const value of ["TRUE", "1", "yes", " true", ""]) {
      expect(selectionPicksWritesDisabled({ DROPSHIP_SELECTION_PICKS_WRITES_DISABLED: value }), value).toBe(false);
    }
  });
});

describe("refusals inside the transaction (permanent; nothing written)", () => {
  it("refuses a moved head revision (409 REVISION_CONFLICT)", async () => {
    const { service, repository } = setup();
    repository.head = 43;
    await expect(refusalOf(service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody() })))
      .resolves.toMatchObject({ code: "DROPSHIP_SELECTION_REVISION_CONFLICT",
        context: { expectedRevisionId: 41, currentRevisionId: 43, classification: "permanent" } });
    expect(repository.calls).not.toContain("readPlanFacts");
    expect(repository.committedOps()).toEqual([]);
  });

  it("refuses changed effects when the change adds (409 EFFECTS_CHANGED), before any write", async () => {
    const { service, repository } = setup();
    const body = await saveBody();
    repository.defaultFacts = facts({ effects: { ...facts().effects, stores: [{ ...facts().effects.stores[0]!, storePaused: true }] } });
    await expect(refusalOf(service.applyChange({ vendorId: VENDOR, actor: ACTOR, body })))
      .resolves.toMatchObject({ code: "DROPSHIP_SELECTION_EFFECTS_CHANGED", context: { expectedEffectsHash: body.expectedEffectsHash } });
    expect(repository.calls).not.toContain("insertRevision");
  });

  it("lets a removal-only change proceed on drifted effects, with both hashes in its answer and audit", async () => {
    const { service, repository } = setup();
    const body = await saveBody({ add: { productVariantIds: [] }, remove: { productVariantIds: [101] } });
    // The listing ended on eBay between the confirm and the save: the removal no longer sets anything to 0.
    repository.defaultFacts = facts({ effects: { ...facts().effects, stores: [{ ...facts().effects.stores[0]!,
      listings: [listing(501, 101, { status: "ended", marketplaceEndedAt: NOW })] }] } });
    const { answer } = await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });
    expect(answer).toMatchObject({ drifted: true, confirmedEffectsHash: body.expectedEffectsHash, toRemove: 1,
      effects: [{ storeConnectionId: 22, goesToZero: 0, startsSelling: 0 }] });
    expect(answer.effectsHash).not.toBe(body.expectedEffectsHash);
    expect(repository.committedInput<{ payload: Record<string, unknown> }>("insertAudit").payload).toMatchObject({
      drifted: true, confirmedEffectsHash: body.expectedEffectsHash, effectsHash: answer.effectsHash });
  });

  it("refuses growth past the cap (422 TOO_LARGE) and allows a shrinking change while over it", async () => {
    const atCap = facts({ selectedBefore: 10_000 });
    const grow = setup();
    grow.repository.defaultFacts = atCap;
    const growBody = await saveBody({ add: { productVariantIds: [102] }, remove: { productVariantIds: [] } }, atCap);
    await expect(refusalOf(grow.service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: growBody })))
      .resolves.toMatchObject({ code: "DROPSHIP_SELECTION_TOO_LARGE", context: { selectedAfter: 10_001, cap: 10_000 } });
    expect(grow.repository.committedOps()).toEqual([]);

    const over = facts({ selectedBefore: 10_050 });
    const shrink = setup();
    shrink.repository.defaultFacts = over;
    const shrinkBody = await saveBody({ add: { productVariantIds: [102] }, remove: { productVariantIds: [101] } }, over);
    const { answer } = await shrink.service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: shrinkBody });
    expect(answer).toMatchObject({ selectedBefore: 10_050, selectedAfter: 10_050, overCapAfter: true });
  });
});

describe("server retries (§8.3; V22, SAFETY-3, SAFETY-9)", () => {
  it.each([
    ["a held publication gate", pgError("55P03", "PUBLICATION_SELECTION_BUSY"), "insertPicks", "55P03"],
    ["a lock timeout", pgError("55P03", "canceling statement due to lock timeout"), "preLockVariants", "55P03"],
    ["a deadlock", pgError("40P01", "deadlock detected"), "insertPicks", "40P01"],
    ["a serialization failure", pgError("40001", "could not serialize access"), "readPlanFacts", "40001"],
  ])("rolls back %s and succeeds on the next attempt, sleeping the seeded jitter", async (_label, error, call, code) => {
    const { service, repository, sleeps, logs } = setup();
    repository.failAt.set(1, { call, error });
    const { answer } = await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody() });
    expect(repository.attempts).toBe(2);
    expect(repository.calls.filter((entry) => entry === "rollback")).toHaveLength(1);
    expect(repository.committedOps()).toEqual(["insertRevision", "insertAudit", "deletePicks", "insertPicks", "insertListingEnds",
      "insertListingEndAudits"]);
    expect(answer.revisionId).toBe(42);
    expect(sleeps).toEqual([selectionSaveRetryDelayMs(1, seededJitterSource(7))]);
    expect(logs.filter((line) => line.level === "debug")).toEqual([expect.objectContaining({
      code: "dropship.selection.change_retry", context: expect.objectContaining({ error_code: code, attempt: 1,
        vendor_id: VENDOR, expected_revision_id: 41 }) })]);
    expect(logs.filter((line) => line.level === "warn")).toEqual([]);
  });

  it("re-plans after the pre-lock misses a size deleted since the plan: the retry skips it, and the audit names only what was written", async () => {
    const { service, repository } = setup();
    const body = await saveBody({ add: { productVariantIds: [102, 104] }, remove: { productVariantIds: [] } });
    repository.preLockResult = (ids, attempt) => (attempt === 1 ? ids.filter((id) => id !== 102) : [...ids]);
    // After the catalog delete Card Shellz no longer offers 102.
    repository.factsByAttempt = [facts(), facts({ offered: new Set([101, 104]), effects: { ...facts().effects,
      stores: [{ ...facts().effects.stores[0]!, listings: [listing(501, 101)] }] } })];
    // The effects moved with it (a change with adds): the second attempt answers EFFECTS_CHANGED unless the confirm saw the same.
    const error = await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body }).then(() => null, (caught: unknown) => caught);
    expect(repository.attempts).toBe(2);
    expect(repository.calls.slice(0, 9)).toEqual([`begin+lock:${VENDOR}`, "findRevisionByKey", "readWritesGate", "readHeadRevisionId",
      "readPlanFacts", "insertRevision", "insertAudit", "preLockVariants", "rollback"]);
    expect(error).toMatchObject({ code: "DROPSHIP_SELECTION_EFFECTS_CHANGED" });
    expect(repository.committedOps()).toEqual([]);
  });

  it("re-plans after a pre-lock miss and saves the rest when the effects did not move", async () => {
    const { service, repository } = setup();
    // 103's sibling: an offered size with no listing, so losing it changes no effect.
    const noListing = facts({ offered: new Set([101, 102, 104, 106]), effects: { ...facts().effects,
      candidates: [...facts().effects.candidates, candidate(106)] } });
    const body = await saveBody({ add: { productVariantIds: [106, 102] }, remove: { productVariantIds: [] } }, noListing);
    repository.factsByAttempt = [noListing, facts()];
    repository.preLockResult = (ids, attempt) => (attempt === 1 ? ids.filter((id) => id !== 106) : [...ids]);
    const { answer } = await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });
    expect(repository.attempts).toBe(2);
    expect(answer).toMatchObject({ toAdd: 1, skipped: { count: 1, first: [106] } });
    expect(repository.committedInput<{ payload: Record<string, unknown> }>("insertAudit").payload).toMatchObject({
      addedVariantIds: [102], skippedVariantIds: [106] });
    expect(repository.committedInput<{ productVariantIds: number[] }>("insertPicks").productVariantIds).toEqual([102]);
  });

  it.each([
    ["delete", "deleteCount"],
    ["insert", "insertCount"],
  ] as const)("rolls back a %s row count below the plan (PLAN_MOVED), so the audit never claims an unwritten id", async (_label, hook) => {
    const { service, repository } = setup();
    repository[hook] = (ids, attempt) => (attempt === 1 ? ids.length - 1 : ids.length);
    await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody() });
    expect(repository.attempts).toBe(2);
    expect(repository.committed.filter((entry) => entry.op === "insertAudit")).toHaveLength(1);
  });

  it.each([
    ["busy", pgError("55P03", "PUBLICATION_SELECTION_BUSY")],
    ["a lock timeout", pgError("55P03", "canceling statement due to lock timeout")],
    ["a deadlock", pgError("40P01", "deadlock detected")],
    ["a plan that keeps moving", new DropshipError(SELECTION_CHANGE_PLAN_MOVED, "moved", { classification: "transient" })],
  ])("after %s on every attempt answers PUBLICATION_SELECTION_BUSY (transient) with one WARN, never a 500", async (_label, error) => {
    const { service, repository, sleeps, logs } = setup();
    for (let attempt = 1; attempt <= SELECTION_SAVE_ATTEMPTS; attempt += 1) repository.failAt.set(attempt, { call: "insertRevision", error });
    const refusal = await refusalOf(service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody() }));
    expect(refusal).toMatchObject({ code: "PUBLICATION_SELECTION_BUSY",
      message: "A stock update is finishing. Your selection was not saved; retry it in a moment.",
      context: { classification: "transient", retryable: true, attempts: SELECTION_SAVE_ATTEMPTS } });
    expect(JSON.stringify(refusal.context)).not.toContain("deadlock detected");
    expect(repository.attempts).toBe(SELECTION_SAVE_ATTEMPTS);
    expect(sleeps).toHaveLength(SELECTION_SAVE_ATTEMPTS - 1);
    expect(repository.committedOps()).toEqual([]);
    expect(logs.filter((line) => line.level === "warn")).toEqual([expect.objectContaining({ code: "dropship.selection.change_busy",
      context: expect.objectContaining({ vendor_id: VENDOR, expected_revision_id: 41, attempts: SELECTION_SAVE_ATTEMPTS,
        error_class: "transient" }) })]);
    expect(logs.filter((line) => line.level === "info")).toEqual([]);
  });

  it("never retries another failure: a unique violation, a plain error or a refusal is thrown at once", async () => {
    for (const error of [pgError("23505", "duplicate key"), new Error("boom"), new DropshipError("DROPSHIP_X", "no")]) {
      const { service, repository, sleeps } = setup();
      repository.failAt.set(1, { call: "insertAudit", error });
      await expect(service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody() })).rejects.toBe(error);
      expect(repository.attempts).toBe(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("classifies exactly the retried failures", () => {
    expect(retryableSaveFailureCode(pgError("55P03", "x"))).toBe("55P03");
    expect(retryableSaveFailureCode(pgError("40P01", "x"))).toBe("40P01");
    expect(retryableSaveFailureCode(pgError("40001", "x"))).toBe("40001");
    expect(retryableSaveFailureCode(new DropshipError(SELECTION_CHANGE_PLAN_MOVED, "x"))).toBe(SELECTION_CHANGE_PLAN_MOVED);
    for (const other of [pgError("23503", "fk"), pgError("P0001", "DROPSHIP_SELECTION_RULES_RETIRED"), new DropshipError("55P03", "x"),
      null, "55P03", { code: 55 }]) {
      expect(retryableSaveFailureCode(other)).toBeNull();
    }
  });

  it("waits 250, 500 and 1,000 ms ±50% from a seeded source: the same seed gives the same waits", () => {
    expect(SELECTION_SAVE_RETRY_DELAYS_MS).toEqual([250, 500, 1_000]);
    expect(selectionSaveRetryDelayMs(1, () => 0)).toBe(125);
    expect(selectionSaveRetryDelayMs(2, () => 0.5)).toBe(500);
    expect(selectionSaveRetryDelayMs(3, () => 0.999_999)).toBe(1_500);
    const first = seededJitterSource(42);
    const second = seededJitterSource(42);
    const draws = Array.from({ length: 50 }, () => first());
    expect(Array.from({ length: 50 }, () => second())).toEqual(draws);
    expect(draws.every((draw) => draw >= 0 && draw < 1)).toBe(true);
    expect(() => selectionSaveRetryDelayMs(1, () => 1)).toThrow();
  });
});

describe("logging", () => {
  it("logs one INFO per commit with the vendor, the revision and the counts, and a replay as replayed", async () => {
    const { service, logs } = setup();
    await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody() });
    expect(logs).toEqual([expect.objectContaining({ level: "info", code: "dropship.selection.changed", context: expect.objectContaining({
      outcome: "changed", vendor_id: VENDOR, revision_id: 42, added: 1, removed: 1, skipped: 1,
      selected_before: 10, selected_after: 10, before: { selected: 10 }, after: { selected: 10 }, drift: false }) })]);
  });

  it("refuses a malformed service input as the server's own fault (a plain error, 500)", async () => {
    const { service } = setup();
    await expect(service.applyChange({ vendorId: 0, actor: ACTOR, body: changeBody() })).rejects.not.toBeInstanceOf(DropshipError);
    await expect(service.applyChange({ vendorId: VENDOR, actor: { actorType: "admin", actorId: "x" }, body: changeBody() }))
      .rejects.toThrow("Selection change service input failed validation");
  });
});

/**
 * PR C (PLAN-C v4.1 §4.1, §4.6, §4.7, §13.1): the older page after the replay (2a), the echo, the end writes after
 * the picks writes (9), and the pick count with the hidden picks of a wholly removed product (FID-1).
 */
describe("PR C: older pages and the echo (step 2a)", () => {
  it.each([
    ["a version-2 page", 2],
    ["a page that sends no version", undefined],
  ])("refuses %s after the replay with 409 PAGE_OUTDATED, writing nothing", async (_label, clientVersion) => {
    const { service, repository } = setup();
    const body = { ...await saveBody(), clientVersion };
    const error = await refusalOf(service.applyChange({ vendorId: VENDOR, actor: ACTOR, body }));
    expect(error).toMatchObject({ code: "DROPSHIP_SELECTION_PAGE_OUTDATED", message: "This page was updated, so your last changes weren't saved. Reload it and make them again.",
      context: { classification: "permanent", retryable: false, serverVersion: DROPSHIP_CATALOG_CODE_VERSION, clientVersion: clientVersion ?? null } });
    expect(repository.calls).toEqual([`begin+lock:${VENDOR}`, "findRevisionByKey", "rollback"]);
    expect(repository.committedOps()).toEqual([]);
    expect(repository.attempts).toBe(1);
  });

  it("answers a B page's stored answer again (200) before refusing older pages: a save that went through is never told it failed", async () => {
    // B6's red case: the outdated check before the replay would answer this lost answer 409.
    const first = setup();
    // A B page's body: version 2, no echo.
    const bBody = { ...changeBody({ clientVersion: 2 }), expectedEffectsHash: "e".repeat(64) };
    // The B save's own request hash (B's canonical form: no echo fields).
    first.repository.stored = { revisionId: 30, requestHash: hashSelectionChangeRequest(parseSelectionChangeBody(bBody)), requestKind: "picks_change",
      result: { ...B_STORED_ANSWER } };
    const replay = await first.service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: bBody });
    expect(replay.idempotentReplay).toBe(true);
    // A B-shaped stored answer replays through C's schema: the new fields take their defaults.
    expect(replay.answer).toMatchObject({ revisionId: 30, effects: [{ goesToZero: 1, startsSelling: 1, ends: 0, storeConnected: true }],
      ends: { listingIds: [], hiddenRemovedIds: [], otherSizes: 0, stillEnding: 0, endReview: 0, endedReAdd: 0 } });
    expect(replay.answer).not.toHaveProperty("otherEntriesHash");
    expect(first.repository.calls).toEqual([`begin+lock:${VENDOR}`, "findRevisionByKey", "commit"]);
    expect(first.repository.committedOps()).toEqual([]);
  });

  it("a C answer still parses with B's frozen answer schema (a B page replaying on a C dyno, TST-9)", async () => {
    const { service } = setup();
    const { answer } = await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody() });
    const asB = bSelectionChangeAnswerSchema.safeParse(JSON.parse(JSON.stringify(answer)));
    expect(asB.success).toBe(true);
    expect(selectionChangeAnswerSchema.safeParse(B_STORED_ANSWER).success).toBe(false); // no revision id: the stored form
    expect(selectionChangeAnswerSchema.safeParse({ ...B_STORED_ANSWER, revisionId: 30 }).success).toBe(true);
  });

  it("refuses a version-3 body without the echo, or with an echo that is not the confirmed preview, with 400 before the gate", async () => {
    const body = await saveBody();
    for (const [label, patch, reason] of [
      ["no expectedEnds", { expectedEnds: undefined }, "confirmed_ends_missing"],
      ["no expectedOtherEntriesHash", { expectedOtherEntriesHash: undefined }, "confirmed_ends_missing"],
      ["one more end", { expectedEnds: { listingIds: [501, 999], hiddenRemovedIds: [] } }, "confirmed_ends_mismatch"],
      ["a hidden removal", { expectedEnds: { listingIds: [501], hiddenRemovedIds: [106] } }, "confirmed_ends_mismatch"],
      ["another other-entries hash", { expectedOtherEntriesHash: "f".repeat(64) }, "confirmed_ends_mismatch"],
    ] as const) {
      const { service, repository } = setup();
      const error = await refusalOf(service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: { ...body, ...patch } }));
      expect(error, label).toMatchObject({ code: "DROPSHIP_SELECTION_CHANGE_INVALID_INPUT", context: { classification: "permanent", reason } });
      expect(repository.calls, label).toEqual([`begin+lock:${VENDOR}`, "findRevisionByKey", "rollback"]);
    }
  });
});

describe("PR C: the end writes (step 9) and the pick count", () => {
  /** 101 removed (product 1_101); its siblings: 106 hidden (does not ship) and picked, 107 visible, not picked, listed. */
  function productFacts(): SelectionChangePlanFacts {
    const base = facts();
    const sibling = (productVariantId: number, patch: Partial<DropshipStockSelectionCandidate> = {}) =>
      ({ ...candidate(productVariantId), productId: 1_101, ...patch });
    return facts({
      siblingPicks: new Set([106]),
      effects: { ...base.effects,
        candidates: [...base.effects.candidates, sibling(106, { requiresShipping: false }), sibling(107)],
        stores: [{ ...base.effects.stores[0]!, listings: [listing(501, 101), listing(502, 102), listing(506, 106), listing(507, 107)] }] },
    });
  }

  it("deletes the removed and the hidden picks in one statement, ends every listing of the product, and counts the pick rows (FID-1)", async () => {
    const { service, repository } = setup();
    const productAt = productFacts();
    repository.defaultFacts = productAt;
    const body = await saveBody({}, productAt);
    expect(body.expectedEnds).toEqual({ listingIds: [501, 506, 507], hiddenRemovedIds: [106] });
    const { answer } = await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });
    expect(repository.committedInput<{ productVariantIds: number[] }>("deletePicks").productVariantIds).toEqual([101, 106]);
    // pick_count = before + inserts - deletes - hidden: 12 + 1 - 1 - 1.
    expect(repository.committedInput<{ pickCount: number }>("insertRevision").pickCount).toBe(11);
    const ends = repository.committedInput<{ ends: PlannedListingEnd[]; revisionId: number; now: Date }>("insertListingEnds");
    expect(ends).toMatchObject({ revisionId: 42, now: NOW });
    expect(ends.ends.map((end) => [end.listingId, end.productId, end.productVariantId, end.reason])).toEqual([
      [501, 1_101, 101, "size_removed"], [506, 1_101, 106, "product_removed"], [507, 1_101, 107, "product_removed"]]);
    expect(ends.ends[0]!.requestedIdentity).toEqual({ externalListingId: "L-501", externalOfferId: "O-501", externalAccountId: "seller-22",
      providerEnvironment: "production" });
    expect(answer.ends).toEqual({ listingIds: [501, 506, 507], hiddenRemovedIds: [106], otherSizes: 2, stillEnding: 0, endReview: 0, endedReAdd: 0 });
    expect(answer.effects[0]).toMatchObject({ ends: 3, goesToZero: 0, startsSelling: 1 });
  });

  it("writes one audit row per end and one summary row on the revision, and plans the counts in the picks audit", async () => {
    const { service, repository } = setup();
    repository.defaultFacts = productFacts();
    await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody({}, productFacts()) });
    expect(repository.committedInput<{ payload: Record<string, unknown> }>("insertAudit").payload).toMatchObject({
      plannedEnds: { sizeRemoved: 1, productRemoved: 2, hiddenRemoved: 1, superseded: 0 } });
    const audits = repository.committedInput<{ rows: Array<{ eventType: string; entityId: string; storeConnectionId: number | null;
      payload: Record<string, unknown> }>; actor: unknown; now: Date }>("insertListingEndAudits");
    expect(audits).toMatchObject({ actor: ACTOR, now: NOW });
    expect(audits.rows.map((row) => [row.eventType, row.entityId, row.storeConnectionId])).toEqual([
      ["listing_end_requested", "7000", 22], ["listing_end_requested", "7001", 22], ["listing_end_requested", "7002", 22],
      ["vendor_selection_ends_recorded", "42", null]]);
    expect(audits.rows[0]!.payload).toMatchObject({ endRequestId: 7000, listingId: 501, reason: "size_removed", revisionId: 42,
      before: { state: null }, after: { state: "pending" } });
    expect(audits.rows[3]!.payload).toEqual({ revisionId: 42, endRequestIds: { size_removed: [7000], product_removed: [7001, 7002] },
      supersededEndIds: [], hiddenRemovedVariantIds: [106], hiddenRemovedReason: "removed_with_product" });
  });

  it("supersedes the pending end of a re-picked size before inserting, audits it, and the answer counts it selling again", async () => {
    const { service, repository } = setup();
    const repick = facts({ pendingEnds: [{ id: 5, listingId: 502, productId: 1_102, productVariantId: 102, reason: "size_removed" }],
      effects: { ...facts().effects, stores: [{ ...facts().effects.stores[0]!, listings: [listing(501, 101),
        listing(502, 102, { openEndId: 5, openEndState: "pending" })] }] } });
    repository.defaultFacts = repick;
    const { answer } = await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody({}, repick) });
    // Step 9a before the gated picks writes, step 9b after them (review DB-5).
    expect(repository.calls.slice(-7)).toEqual(["supersedeListingEnds", "insertListingEndAudits", "deletePicks", "insertPicks",
      "insertListingEnds", "insertListingEndAudits", "commit"]);
    expect(repository.committedInput<{ endIds: number[]; now: Date }>("supersedeListingEnds")).toMatchObject({ endIds: [5], now: NOW });
    expect(answer.effects[0]).toMatchObject({ startsSelling: 1, ends: 1 });
    const audits = repository.committed.filter((entry) => entry.op === "insertListingEndAudits")
      .map((entry) => (entry.input as { rows: Array<{ eventType: string; payload: Record<string, unknown> }> }).rows);
    expect(audits[0]![0]).toMatchObject({ eventType: "listing_end_superseded", payload: { endRequestId: 5, before: { state: "pending" },
      after: { state: "superseded", code: "DROPSHIP_LISTING_END_SUPERSEDED_BY_SELECTION" } } });
    // The save's summary, written with the new ends after the picks writes, still names the supersede.
    expect(audits.at(-1)!.at(-1)!.payload).toMatchObject({ supersededEndIds: [5] });
  });

  it("takes back pending ends and writes their audit rows before the gated picks writes; only the new ends come after (DB-5)", async () => {
    const { service, repository } = setup();
    const repick = facts({ pendingEnds: [{ id: 5, listingId: 502, productId: 1_102, productVariantId: 102, reason: "size_removed" }],
      effects: { ...facts().effects, stores: [{ ...facts().effects.stores[0]!, listings: [listing(501, 101),
        listing(502, 102, { openEndId: 5, openEndState: "pending" })] }] } });
    repository.defaultFacts = repick;
    await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody({}, repick) });
    const calls = repository.calls;
    // The supersede and its audit rows hold no gate (the end table's trigger is ungated), so they run before step 8.
    expect(calls.indexOf("supersedeListingEnds")).toBeLessThan(calls.indexOf("deletePicks"));
    expect(calls.indexOf("supersedeListingEnds")).toBeLessThan(calls.indexOf("insertPicks"));
    expect(calls.indexOf("insertListingEndAudits")).toBeLessThan(calls.indexOf("deletePicks"));
    // The new ends' FK row locks still come after the picks writes (FID-2), with their audit rows and the save's summary.
    expect(calls.indexOf("insertListingEnds")).toBeGreaterThan(calls.indexOf("insertPicks"));
    expect(calls.lastIndexOf("insertListingEndAudits")).toBeGreaterThan(calls.indexOf("insertListingEnds"));
    const audits = repository.committed.filter((entry) => entry.op === "insertListingEndAudits")
      .map((entry) => (entry.input as { rows: Array<{ eventType: string }> }).rows.map((row) => row.eventType));
    expect(audits).toEqual([["listing_end_superseded"], ["listing_end_requested", "vendor_selection_ends_recorded"]]);
  });

  it.each([
    ["supersede", "supersedeCount"],
    ["end insert", "endInsertCount"],
  ] as const)("rolls back a %s count below the plan (PLAN_MOVED) and saves on the retry", async (_label, hook) => {
    const { service, repository } = setup();
    const repick = facts({ pendingEnds: [{ id: 5, listingId: 502, productId: 1_102, productVariantId: 102, reason: "size_removed" }],
      effects: { ...facts().effects, stores: [{ ...facts().effects.stores[0]!, listings: [listing(501, 101),
        listing(502, 102, { openEndId: 5, openEndState: "pending" })] }] } });
    repository.defaultFacts = repick;
    (repository as unknown as Record<string, unknown>)[hook] = (ids: readonly unknown[], attempt: number) => (attempt === 1 ? ids.length - 1 : ids.length);
    const body = await saveBody({}, repick);
    await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });
    expect(repository.attempts).toBe(2);
    expect(repository.calls.filter((call) => call === "rollback")).toHaveLength(1);
    expect(repository.committed.filter((entry) => entry.op === "insertListingEnds")).toHaveLength(1);
    // One audit statement for the supersede (step 9a) and one for the new ends with the summary (step 9b).
    expect(repository.committed.filter((entry) => entry.op === "insertListingEndAudits")).toHaveLength(2);
  });

  it("a replay of a C save that created ends answers its stored answer and writes no end, supersede or audit row (TST-5)", async () => {
    const first = setup();
    first.repository.defaultFacts = productFacts();
    const body = await saveBody({}, productFacts());
    const original = await first.service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });
    const revision = first.repository.committedInput<{ requestHash: string; result: unknown }>("insertRevision");
    const { service, repository } = setup();
    repository.defaultFacts = productFacts();
    repository.stored = { revisionId: 42, requestHash: revision.requestHash, requestKind: "picks_change", result: JSON.parse(JSON.stringify(revision.result)) };
    const replay = await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body });
    expect(replay).toEqual({ idempotentReplay: true, answer: original.answer });
    expect(repository.calls).toEqual([`begin+lock:${VENDOR}`, "findRevisionByKey", "commit"]);
    expect(repository.committedOps()).toEqual([]);
  });

  it("an adds-only save writes no end row (and so takes no listing key lock)", async () => {
    const { service, repository } = setup();
    await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody({ remove: { productVariantIds: [] } }) });
    expect(repository.calls).not.toContain("insertListingEnds");
    expect(repository.calls).not.toContain("insertListingEndAudits");
  });

  it("refuses a preview and a save that would end more than 30,000 listings with 422 REMOVAL_TOO_LARGE, before any write", async () => {
    const { service, repository } = setup();
    // One product of 30,001 listed sizes: removing its one pick removes the product, so every listing would be ended.
    const sizes = Array.from({ length: MAX_SELECTION_END_LISTINGS + 1 }, (_, index) => 200_001 + index);
    repository.defaultFacts = facts({ pickedBefore: new Set([200_001]), offered: new Set(sizes),
      effects: { ...facts().effects, candidates: sizes.map((id) => ({ ...candidate(id), productId: 9_999 })),
        stores: [{ ...facts().effects.stores[0]!, listings: sizes.map((size) => listing(size, size)) }] } });
    const change = { clientVersion: 3, expectedRevisionId: 41, add: { productVariantIds: [] }, remove: { productVariantIds: [200_001] } };
    await expect(refusalOf(service.preview({ vendorId: VENDOR, body: change })))
      .resolves.toMatchObject({ code: "DROPSHIP_SELECTION_REMOVAL_TOO_LARGE", context: { endListings: 30_001, limit: 30_000,
        classification: "permanent" } });
    // A well-formed echo (it passes 2a), so the save reaches its plan and is refused there.
    const { combineSelectionEffectsHash, selectionEndsHash } = await import("../../domain/vendor-selection-effects");
    const expectedEnds = { listingIds: [], hiddenRemovedIds: [] };
    const other = "a".repeat(64);
    const error = await refusalOf(service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: { ...change, idempotencyKey: KEY,
      expectedEnds, expectedOtherEntriesHash: other, expectedEffectsHash: combineSelectionEffectsHash(selectionEndsHash(expectedEnds), other) } }));
    expect(error).toMatchObject({ code: "DROPSHIP_SELECTION_REMOVAL_TOO_LARGE" });
    expect(repository.calls).not.toContain("insertRevision");
    expect(repository.committedOps()).toEqual([]);
  });

  it("logs the ends, the supersedes and the hidden removals on the changed line", async () => {
    const { service, repository, logs } = setup();
    repository.defaultFacts = productFacts();
    await service.applyChange({ vendorId: VENDOR, actor: ACTOR, body: await saveBody({}, productFacts()) });
    expect(logs).toEqual([expect.objectContaining({ level: "info", code: "dropship.selection.changed",
      context: expect.objectContaining({ ends: 3, superseded: 0, hidden_removed: 1 }) })]);
  });
});
