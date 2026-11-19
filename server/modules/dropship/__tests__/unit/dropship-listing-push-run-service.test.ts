import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { emptyListingPushRunCounts } from "../../../../../shared/dropship/listing-push-runs";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipListingPushRunService,
  type CreateListingPushRunRepositoryInput,
  type DropshipListingPushRunRecord,
  type DropshipListingPushRunRepository,
} from "../../application/dropship-listing-push-run-service";
import { DropshipError } from "../../domain/errors";
import { hashListingPushRunRequest } from "../../domain/listing-push-run";

const loadSelectedVariantIds = vi.hoisted(() => vi.fn());
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../application/dropship-selected-catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../application/dropship-selected-catalog")>()),
  loadSelectedVariantIds,
}));

import { PgDropshipListingPushRunRepository } from "../../infrastructure/dropship-listing-push-run.repository";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const HASH = hashListingPushRunRequest({ vendorId: 10, storeConnectionId: 22, scope: "all", expectedSelectionRevisionId: 7 });

function runRecord(overrides: Partial<DropshipListingPushRunRecord> = {}): DropshipListingPushRunRecord {
  return {
    runId: 4, vendorId: 10, storeConnectionId: 22, scope: "all", status: "processing", stopReason: null, selectionRevisionId: 7,
    idempotencyKey: "publish-0001", requestHash: HASH, targetCount: 3, chunkSize: 500, chunkCount: 1, nextChunkIndex: 0,
    chunkAttempts: 0, actorType: "vendor", actorId: "member-10", cancelRequestedAt: null, createdAt: NOW, updatedAt: NOW,
    completedAt: null, ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "4", vendor_id: 10, store_connection_id: 22, scope: "all", status: "processing", stop_reason: null,
    selection_revision_id: 7, idempotency_key: "publish-0001", request_hash: HASH, target_count: 3, chunk_size: 500,
    chunk_count: 1, next_chunk_index: 0, chunk_attempts: 0, actor_type: "vendor", actor_id: "member-10",
    cancel_requested_at: null, created_at: NOW, updated_at: NOW, completed_at: null, ...overrides,
  };
}

describe("DropshipListingPushRunService", () => {
  let repository: FakeRunRepository;
  let assertListingPushAccess: Mock<(vendorId: number, storeConnectionId: number) => Promise<unknown>>;
  let logs: DropshipLogEvent[];
  let service: DropshipListingPushRunService;

  beforeEach(() => {
    repository = new FakeRunRepository();
    assertListingPushAccess = vi.fn(async (_vendorId: number, _storeConnectionId: number): Promise<unknown> => undefined);
    logs = [];
    service = new DropshipListingPushRunService({
      repository,
      pushAccess: { assertListingPushAccess },
      clock: { now: () => NOW },
      logger: { info: (event) => logs.push(event), warn: (event) => logs.push(event), error: (event) => logs.push(event) },
    });
  });

  const body = { storeConnectionId: 22, scope: "all", idempotencyKey: "publish-0001", expectedSelectionRevisionId: 7 };

  it("checks the store like a push, then creates the run from the request's hash, the 500 chunk and the injected clock", async () => {
    const result = await service.createRunForMember("member-10", body);
    expect(assertListingPushAccess).toHaveBeenCalledWith(10, 22);
    expect(repository.created).toEqual([{
      vendorId: 10, storeConnectionId: 22, scope: "all", idempotencyKey: "publish-0001", requestHash: HASH,
      expectedSelectionRevisionId: 7, chunkSize: 500, actor: { actorType: "vendor", actorId: "member-10" }, now: NOW,
    }]);
    expect(result).toEqual({ run: expect.objectContaining({ runId: 4, createdAt: NOW.toISOString(), cancelRequestedAt: null }), idempotentReplay: false });
    expect(logs.map((event) => event.code)).toEqual(["DROPSHIP_LISTING_PUSH_RUN_CREATED"]);
    expect(logs[0].context).toMatchObject({ runId: 4, vendorId: 10, storeConnectionId: 22, targetCount: 3, actorId: "member-10" });
  });

  it("replays a run a retried press already made before the store checks, so a store blocked since then gets its run (verify V11)", async () => {
    repository.existing = runRecord({ status: "processing" });
    assertListingPushAccess.mockRejectedValue(new DropshipError("DROPSHIP_LISTING_STORE_BLOCKED", "blocked since"));
    const result = await service.createRunForMember("member-10", body);
    expect(result).toEqual({ run: expect.objectContaining({ runId: 4 }), idempotentReplay: true });
    expect(repository.keyReads).toEqual([{ vendorId: 10, idempotencyKey: "publish-0001" }]);
    expect(assertListingPushAccess).not.toHaveBeenCalled();
    expect(repository.created).toEqual([]);
    expect(logs.map((event) => event.code)).toEqual(["DROPSHIP_LISTING_PUSH_RUN_REPLAYED"]);
    // The same key for another request is refused for good, before the checks and before anything is written.
    await expect(service.createRunForMember("member-10", { ...body, scope: "not_live" }))
      .rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT", context: { classification: "permanent" } });
    expect(assertListingPushAccess).not.toHaveBeenCalled();
    expect(repository.created).toEqual([]);
    // A new key is checked as always.
    await expect(service.createRunForMember("member-10", { ...body, idempotencyKey: "publish-0002" }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_STORE_BLOCKED" });
    expect(assertListingPushAccess).toHaveBeenCalledTimes(1);
  });

  it("logs a replay as a replay", async () => {
    repository.replay = true;
    expect((await service.createRunForMember("member-10", body)).idempotentReplay).toBe(true);
    expect(logs.map((event) => event.code)).toEqual(["DROPSHIP_LISTING_PUSH_RUN_REPLAYED"]);
  });

  it("refuses a bad body, a member with no vendor and a store the push checks refuse, before anything is written", async () => {
    await expect(service.createRunForMember("member-10", { ...body, scope: "new" })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_INVALID_INPUT" });
    await expect(service.createRunForMember("member-10", { ...body, productVariantIds: [1] })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_INVALID_INPUT" });
    await expect(service.createRunForMember("member-unknown", body)).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    await expect(service.createRunForMember("", body)).rejects.toMatchObject({ code: "DROPSHIP_AUTH_REQUIRED" });
    assertListingPushAccess.mockRejectedValueOnce(new DropshipError("DROPSHIP_LISTING_VENDOR_BLOCKED", "paused"));
    await expect(service.createRunForMember("member-10", body)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_VENDOR_BLOCKED" });
    expect(repository.created).toEqual([]);
  });

  it("lists, reads and stops only the member's own runs", async () => {
    expect(await service.listRunsForMember("member-unknown", { storeConnectionId: 22 })).toEqual({ runs: [] });
    expect((await service.listRunsForMember("member-10", { storeConnectionId: 22 })).runs).toHaveLength(1);
    expect(repository.listInputs).toEqual([{ vendorId: 10, storeConnectionId: 22, limit: 20 }]);
    await expect(service.listRunsForMember("member-10", { storeConnectionId: 22, limit: 21 })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_INVALID_INPUT" });
    await expect(service.listRunsForMember("member-10", { storeConnectionId: Number.NaN })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_INVALID_INPUT" });
    await expect(service.getRunForMember("member-10", { runId: 99 })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_NOT_FOUND" });
    await expect(service.getRunForMember("member-unknown", { runId: 4 })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_NOT_FOUND" });
    await expect(service.stopRunForMember("member-10", 99)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_NOT_FOUND" });
    await expect(service.stopRunForMember("member-10", "4")).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_INVALID_INPUT" });
  });

  it("pages problems by size id and names the next page's cursor", async () => {
    repository.hasMore = true;
    const detail = await service.getRunForMember("member-10", { runId: 4, problemsAfter: 100 });
    expect(repository.getInputs).toEqual([{ vendorId: 10, runId: 4, problemsAfter: 100, problemsLimit: 50, now: NOW }]);
    expect(detail.problems).toEqual({ items: [expect.objectContaining({ productVariantId: 101 })], nextCursor: 101 });
    repository.hasMore = false;
    expect((await service.getRunForMember("member-10", { runId: 4 })).problems.nextCursor).toBeNull();
  });

  it("says when a paused run goes on, at the injected time, and how many sizes became drafts (review DUX5, DUX7)", async () => {
    expect(await service.getRunForMember("member-10", { runId: 4 })).toMatchObject({ waitingUntil: null, drafts: 2 });
    repository.waitingUntil = new Date(NOW.getTime() + 120_000);
    expect((await service.getRunForMember("member-10", { runId: 4 })).waitingUntil).toBe(new Date(NOW.getTime() + 120_000).toISOString());
  });

  it("logs a stop, and a second stop as a replay", async () => {
    await service.stopRunForMember("member-10", 4);
    repository.stopChanged = false;
    await service.stopRunForMember("member-10", 4);
    expect(logs.map((event) => event.code)).toEqual(["DROPSHIP_LISTING_PUSH_RUN_STOP_REQUESTED", "DROPSHIP_LISTING_PUSH_RUN_STOP_REPLAYED"]);
    expect(repository.stopInputs[0]).toEqual({ vendorId: 10, runId: 4, actor: { actorType: "vendor", actorId: "member-10" }, now: NOW });
  });
});

describe("PgDropshipListingPushRunRepository.createRun (one transaction)", () => {
  const input: CreateListingPushRunRepositoryInput = {
    vendorId: 10, storeConnectionId: 22, scope: "all", idempotencyKey: "publish-0001", requestHash: HASH,
    expectedSelectionRevisionId: 7, chunkSize: 500, actor: { actorType: "vendor", actorId: "member-10" }, now: NOW,
  };

  beforeEach(() => {
    loadSelectedVariantIds.mockReset();
    loadSelectedVariantIds.mockResolvedValue([103, 101, 102].sort((left, right) => left - right));
  });

  it("locks the vendor's selection, snapshots it, writes the run, its targets and the audit row, then commits", async () => {
    const client = new ScriptedClient();
    const created = await new PgDropshipListingPushRunRepository(client.pool()).createRun(input);
    expect(created).toMatchObject({ idempotentReplay: false, run: { runId: 4, targetCount: 3 } });
    expect(client.kinds()).toEqual(["BEGIN", "lock_timeout", "vendor_lock", "replay", "head", "active", "insert_run",
      "insert_targets", "audit", "COMMIT"]);
    expect(client.statement("lock_timeout").sql).toBe("SET LOCAL lock_timeout = '5s'");
    expect(client.statement("vendor_lock")).toEqual({
      sql: "SELECT pg_advisory_xact_lock(hashtext('dropship_vendor_selection_rules'), $1::integer)", values: [10] });
    expect(client.statement("insert_run").values).toEqual([10, 22, "all", 7, "publish-0001", HASH, 3, 500, 1, "vendor", "member-10", NOW]);
    expect(client.statement("insert_targets").values).toEqual([4, [101, 102, 103], [0, 0, 0]]);
    const audit = JSON.parse(String(client.statement("audit").values?.[7]));
    expect(audit).toMatchObject({ runId: 4, targetIds: [101, 102, 103], chunkCount: 1, scope: "all", selectionRevisionId: 7 });
    expect(loadSelectedVariantIds).toHaveBeenCalledWith(expect.objectContaining({ vendorId: 10 }), NOW, "listing_push_run");
    expect(client.released).toBe(1);
  });

  it("gives each size its chunk, floor(rank / 500), in id order", async () => {
    loadSelectedVariantIds.mockResolvedValue(Array.from({ length: 1_001 }, (_, index) => 5_000 + index));
    const client = new ScriptedClient({ insertedRun: runRow({ target_count: 1_001, chunk_count: 3 }) });
    await new PgDropshipListingPushRunRepository(client.pool()).createRun(input);
    const [, ids, chunks] = client.statement("insert_targets").values as [number, number[], number[]];
    expect(ids).toHaveLength(1_001);
    expect(chunks.filter((chunk) => chunk === 0)).toHaveLength(500);
    expect(chunks.filter((chunk) => chunk === 1)).toHaveLength(500);
    expect(chunks.filter((chunk) => chunk === 2)).toEqual([2]);
    expect(client.statement("insert_run").values?.[8]).toBe(3);
  });

  it("replays the same key and request with no writes", async () => {
    const client = new ScriptedClient({ replayRow: runRow() });
    const result = await new PgDropshipListingPushRunRepository(client.pool()).createRun(input);
    expect(result.idempotentReplay).toBe(true);
    expect(client.kinds()).toEqual(["BEGIN", "lock_timeout", "vendor_lock", "replay", "COMMIT"]);
    expect(loadSelectedVariantIds).not.toHaveBeenCalled();
  });

  it("refuses a key reused for another request, and a moved revision, writing nothing", async () => {
    const reused = new ScriptedClient({ replayRow: runRow({ request_hash: "b".repeat(64) }) });
    await expect(new PgDropshipListingPushRunRepository(reused.pool()).createRun(input)).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    expect(reused.kinds().at(-1)).toBe("ROLLBACK");
    const moved = new ScriptedClient({ head: 8 });
    await expect(new PgDropshipListingPushRunRepository(moved.pool()).createRun(input)).rejects.toMatchObject({
      code: "DROPSHIP_SELECTION_REVISION_CONFLICT", context: { expectedSelectionRevisionId: 7, currentSelectionRevisionId: 8 } });
    expect(moved.kinds()).toEqual(["BEGIN", "lock_timeout", "vendor_lock", "replay", "head", "ROLLBACK"]);
    expect(loadSelectedVariantIds).not.toHaveBeenCalled();
    const neverSaved = new ScriptedClient({ head: null });
    await expect(new PgDropshipListingPushRunRepository(neverSaved.pool()).createRun({ ...input, expectedSelectionRevisionId: null }))
      .resolves.toMatchObject({ idempotentReplay: false });
  });

  it("'not_live' drops only the live sizes it reads; nothing left answers empty with the live count", async () => {
    const client = new ScriptedClient({ liveIds: [102] });
    await new PgDropshipListingPushRunRepository(client.pool()).createRun({ ...input, scope: "not_live" });
    expect(client.statement("live").values).toEqual([10, 22, [101, 102, 103], ["active", "paused", "drift_detected"]]);
    expect(client.statement("live").sql).toContain("NULLIF(BTRIM(external_listing_id), '') IS NOT NULL");
    expect((client.statement("insert_targets").values as unknown[])[1]).toEqual([101, 103]);

    const allLive = new ScriptedClient({ liveIds: [101, 102, 103] });
    await expect(new PgDropshipListingPushRunRepository(allLive.pool()).createRun({ ...input, scope: "not_live" })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PUSH_RUN_EMPTY", context: { scope: "not_live", liveCount: 3, selectedCount: 3 },
      message: "Everything selected is already on eBay. Use Publish all to re-send it." });
    expect(allLive.kinds().at(-1)).toBe("ROLLBACK");
    loadSelectedVariantIds.mockResolvedValue([]);
    await expect(new PgDropshipListingPushRunRepository(new ScriptedClient().pool()).createRun(input)).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PUSH_RUN_EMPTY", context: { liveCount: 0 }, message: "Choose what to sell in step 1 first." });
  });

  it("refuses more than 10,000 sizes, a second unfinished run and a lock wait past the timeout", async () => {
    loadSelectedVariantIds.mockRejectedValue(new DropshipError("DROPSHIP_LISTING_PUSH_RUN_TOO_LARGE", "too many"));
    await expect(new PgDropshipListingPushRunRepository(new ScriptedClient().pool()).createRun(input)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_TOO_LARGE" });
    loadSelectedVariantIds.mockResolvedValue([101]);
    const active = new ScriptedClient({ activeRunId: "9" });
    await expect(new PgDropshipListingPushRunRepository(active.pool()).createRun(input)).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PUSH_RUN_ACTIVE", context: { runId: 9 } });
    expect(active.kinds()).not.toContain("insert_run");
    const raced = new ScriptedClient({ insertError: Object.assign(new Error("duplicate"), { code: "23505", constraint: "dropship_push_run_one_active_idx" }) });
    await expect(new PgDropshipListingPushRunRepository(raced.pool()).createRun(input)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_ACTIVE" });
    const busy = new ScriptedClient({ lockError: Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }) });
    await expect(new PgDropshipListingPushRunRepository(busy.pool()).createRun(input)).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PUSH_RUN_BUSY", context: { retryable: true } });
    expect(busy.kinds().at(-1)).toBe("ROLLBACK");
    expect(busy.released).toBe(1);
  });
});

class FakeRunRepository implements DropshipListingPushRunRepository {
  created: CreateListingPushRunRepositoryInput[] = [];
  listInputs: unknown[] = [];
  getInputs: unknown[] = [];
  stopInputs: unknown[] = [];
  replay = false;
  hasMore = false;
  stopChanged = true;

  existing: DropshipListingPushRunRecord | null = null;
  keyReads: unknown[] = [];

  async findVendorIdByMemberId(memberId: string) { return memberId === "member-10" ? 10 : null; }
  async findRunByKey(input: { vendorId: number; idempotencyKey: string }) {
    this.keyReads.push(input);
    return this.existing && this.existing.vendorId === input.vendorId && this.existing.idempotencyKey === input.idempotencyKey
      ? this.existing : null;
  }
  async createRun(input: CreateListingPushRunRepositoryInput) {
    if (!this.replay) this.created.push(input);
    return { run: runRecord(), idempotentReplay: this.replay };
  }
  async listRuns(input: { vendorId: number; storeConnectionId: number; limit: number }) {
    this.listInputs.push(input);
    return [{ run: runRecord(), counts: emptyListingPushRunCounts() }];
  }
  waitingUntil: Date | null = null;
  async getRun(input: { vendorId: number; runId: number; problemsAfter: number; problemsLimit: number; now: Date }) {
    this.getInputs.push(input);
    if (input.runId !== 4 || input.vendorId !== 10) return null;
    return { run: runRecord(), counts: emptyListingPushRunCounts(), hasMoreProblems: this.hasMore, problems: [{
      productVariantId: 101, productId: 1, productName: "P", variantName: "S", sku: "X", outcome: "failed" as const,
      code: "C", message: null, retryable: true }], waitingUntil: this.waitingUntil, drafts: 2 };
  }
  async stopRun(input: { vendorId: number; runId: number; actor: CreateListingPushRunRepositoryInput["actor"]; now: Date }) {
    this.stopInputs.push(input);
    if (input.runId !== 4) return null;
    return { run: runRecord({ cancelRequestedAt: NOW, stopReason: "vendor_stop" }), counts: emptyListingPushRunCounts(), changed: this.stopChanged };
  }
}

/** A pg client that answers the run create's statements in order and records each, by kind. */
class ScriptedClient {
  statements: Array<{ kind: string; sql: string; values?: unknown[] }> = [];
  released = 0;

  constructor(private readonly script: {
    replayRow?: Record<string, unknown>; head?: number | null; liveIds?: number[]; activeRunId?: string;
    insertedRun?: Record<string, unknown>; insertError?: Error; lockError?: Error;
  } = {}) {}

  pool() {
    const client = { query: (sql: string, values?: unknown[]) => this.query(sql, values), release: () => { this.released += 1; } };
    return { query: client.query, connect: async () => client } as never;
  }

  kinds(): string[] { return this.statements.map((row) => row.kind); }
  statement(kind: string) {
    const found = this.statements.find((row) => row.kind === kind);
    if (!found) throw new Error(`No ${kind} statement`);
    return { sql: found.sql, values: found.values };
  }

  private async query(sql: string, values?: unknown[]) {
    const kind = classify(sql);
    this.statements.push({ kind, sql, values });
    switch (kind) {
      case "vendor_lock":
        if (this.script.lockError) throw this.script.lockError;
        return { rows: [] };
      case "replay": return { rows: this.script.replayRow ? [this.script.replayRow] : [] };
      case "head": return { rows: [{ id: this.script.head === undefined ? 7 : this.script.head }] };
      case "live": return { rows: (this.script.liveIds ?? []).map((id) => ({ product_variant_id: id })) };
      case "active": return { rows: this.script.activeRunId ? [{ id: this.script.activeRunId }] : [] };
      case "insert_run":
        if (this.script.insertError) throw this.script.insertError;
        return { rows: [this.script.insertedRun ?? runRow()] };
      default: return { rows: [], rowCount: 0 };
    }
  }
}

function classify(sql: string): string {
  if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return sql;
  if (sql.startsWith("SET LOCAL lock_timeout")) return "lock_timeout";
  if (sql.includes("pg_advisory_xact_lock")) return "vendor_lock";
  if (sql.includes("FROM dropship.dropship_listing_push_runs r") && sql.includes("idempotency_key = $2 FOR UPDATE")) return "replay";
  if (sql.includes("max(id)")) return "head";
  if (sql.includes("FROM dropship.dropship_vendor_listings")) return "live";
  if (sql.includes("status = 'processing' ORDER BY id LIMIT 1")) return "active";
  if (sql.includes("INSERT INTO dropship.dropship_listing_push_runs")) return "insert_run";
  if (sql.includes("INSERT INTO dropship.dropship_listing_push_run_targets")) return "insert_targets";
  if (sql.includes("INSERT INTO dropship.dropship_audit_events")) return "audit";
  throw new Error(`Unexpected SQL in the run create: ${sql.slice(0, 80)}`);
}
