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
import { NEW_VERSION_SETTLE_MS, OLDER_PROCESS_GRACE_MS } from "../../domain/catalog-code-version";
import { DropshipError } from "../../domain/errors";
import type { DropshipStockSelectionCandidate } from "../../domain/stock-publication-selection";
import type { SelectionEffectsListing } from "../../domain/vendor-selection-effects";
import { selectionChangeAnswerSchema } from "../../../../../shared/dropship/vendor-selection-changes";

/**
 * The picks save's service with its transaction stubbed (PLAN-B v4.1 §8.3, §10, §14, §15.1; precedent
 * dropship-listing-price-in-transaction.test.ts): the step order, replay, the writes gate, every refusal, the
 * server retries with seeded jitter, the plan-moved rollback and the no-op save. Sizes on the vendor's one store:
 * 101 picked and live (a removal sets it to 0), 102 offered with a zeroed live listing (an add sells it again),
 * 103 not offered (skipped), 104 already picked, 105 not picked (an already-not-selected removal).
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
    vendorQuantityLimit: null, marketplaceEndedAt: null, marketplaceIssueCodes: [], ...patch };
}

function facts(patch: Partial<SelectionChangePlanFacts> = {}): SelectionChangePlanFacts {
  return {
    pickedBefore: new Set([101, 104]),
    offered: new Set([101, 102, 104]),
    selectedBefore: 10,
    pickCountBefore: 12,
    effects: {
      candidates: [101, 102, 103, 104, 105].map(candidate),
      adminRules: [{ id: 1, scopeType: "catalog", action: "include" }],
      overrides: [],
      stores: [{ storeConnectionId: 22, storeName: "Card corner", platform: "ebay",
        config: { listingMode: "live", inventoryMode: "managed_quantity_sync", isActive: true }, storePaused: false,
        listings: [listing(501, 101), listing(502, 102)] }],
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
}

function changeBody(patch: Partial<Body> = {}): Body {
  return { expectedRevisionId: 41, add: { productVariantIds: [102, 103, 104] }, remove: { productVariantIds: [101, 105] },
    idempotencyKey: KEY, expectedEffectsHash: "0".repeat(64), ...patch };
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

/** The effects hash the vendor would confirm for this body (the preview's answer). */
async function confirmedHash(body: Body, setupFacts?: SelectionChangePlanFacts): Promise<string> {
  const { service, repository } = setup();
  if (setupFacts) repository.defaultFacts = setupFacts;
  const { idempotencyKey: _key, expectedEffectsHash: _hash, ...previewBody } = body;
  const preview = await service.preview({ vendorId: VENDOR, body: previewBody });
  return preview.effectsHash;
}

function refusalOf(promise: Promise<unknown>): Promise<DropshipError> {
  return promise.then(() => { throw new Error("expected a refusal"); }, (error: unknown) => {
    if (error instanceof DropshipError) return error;
    throw error;
  });
}

async function saveBody(patch: Partial<Body> = {}, setupFacts?: SelectionChangePlanFacts): Promise<Body> {
  const body = changeBody(patch);
  return { ...body, expectedEffectsHash: await confirmedHash(body, setupFacts) };
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
      effects: [{ storeConnectionId: 22, storeName: "Card corner", platform: "ebay", goesToZero: 1, startsSelling: 1 }],
    });
    expect(preview.effectsHash).toMatch(/^[a-f0-9]{64}$/);
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
      "insertRevision", "insertAudit", "preLockVariants", "deletePicks", "insertPicks", "commit",
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
    expect(repository.committedOps()).toEqual(["insertRevision", "insertAudit", "deletePicks", "insertPicks"]);
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
