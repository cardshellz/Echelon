import type { Pool, PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresQuantityPublicationRecoveryRepository } from "../../infrastructure/quantity-publication-recovery.repository";
import { summarizeRequestTermination } from "../../domain/quantity-publication-provider-answer";
import { completionDrain, CUTOVER_COMPLETION_NOW as NOW } from "../fixtures/inventory-cutover-completion.fixture";
import { recoveryRequest, recoveryResult } from "../fixtures/quantity-publication-recovery.fixture";

const { capture, attest } = vi.hoisted(() => ({ capture: vi.fn(), attest: vi.fn() }));
vi.mock("../../infrastructure/quantity-publication-admission.repository", () => ({
  captureQuantityPublicationDrainInsideTransaction: capture, attestQuantityPublicationAttemptInsideTransaction: attest,
}));
function fixture() {
  // Rows are untyped: each statement the repository issues returns a different shape.
  const client = { query: vi.fn(async (sql: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => ({
    rows: sql.includes("FROM inventory.availability_activation_runs") ? [{ id: "1" }] : [], rowCount: 0,
  })), release: vi.fn() };
  const connectionPool = { connect: vi.fn(async () => client as unknown as PoolClient) };
  return { client, connectionPool, repository: new PostgresQuantityPublicationRecoveryRepository(connectionPool as Pick<Pool, "connect">) };
}
function command() { return { ...recoveryRequest(), actor: "operator", now: NOW }; }

describe("publication recovery bounded owner transaction", () => {
  beforeEach(() => {
    capture.mockReset().mockResolvedValue(completionDrain());
    attest.mockReset().mockResolvedValue({ attemptId: "20", basis: "operator_attestation", replay: false });
  });

  it("captures read-only attempt history within explicit finite transaction limits", async () => {
    const { repository, client } = fixture();
    const result = await repository.pending("1", NOW);
    expect(result).toMatchObject({ activationRunId: "1", capturedAt: NOW.toISOString(), basis: "recorded_attempt_history", providerWriteAttempted: false });
    expect(capture).toHaveBeenCalledExactlyOnceWith(client, "1"); expect(attest).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY", "SET LOCAL lock_timeout = '2s'",
      "SET LOCAL statement_timeout = '10s'", "SET LOCAL idle_in_transaction_session_timeout = '15s'",
      expect.stringContaining("FROM inventory.availability_activation_runs"), "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("resolves the latest existing run without excluding aborted state after reload", async () => {
    const { repository, client } = fixture();
    await expect(repository.pending(undefined, NOW)).resolves.toMatchObject({ activationRunId: "1" });
    const lookup = client.query.mock.calls.find(([sql]) => sql.includes("FROM inventory.availability_activation_runs"))!;
    expect(lookup[0]).toContain("ORDER BY id DESC LIMIT 1"); expect(lookup[0]).not.toContain("state");
    expect(lookup[1]).toEqual([null]); expect(capture).toHaveBeenCalledExactlyOnceWith(client, "1");
  });

  it("does not fabricate empty history when no requested/latest run exists", async () => {
    const { repository, client } = fixture();
    client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(repository.pending(undefined, NOW)).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_RUN_UNAVAILABLE" });
    expect(capture).not.toHaveBeenCalled(); expect(client.query.mock.lastCall![0]).toBe("ROLLBACK");
  });

  it("projects exact unresolved owner scope while omitting internal latest attempt history", async () => {
    const proof = completionDrain();
    proof.unresolvedAttempts = [{ attemptId: "19", owner: "legacy", state: "uncertain", outboxId: null, scope: proof.latestAttemptsByScope[0].scope }];
    capture.mockResolvedValueOnce(proof);
    const result = await fixture().repository.pending("1", NOW);
    expect(result.unresolvedAttempts).toEqual([{ attemptId: "19", owner: "legacy", state: "uncertain", outboxId: null,
      destinationKind: "channel_connection", connectionId: 3, providerKey: "shopify", providerScopeType: "location",
      externalScopeId: "location-1", externalInventoryItemId: "item-1", providerAnswer: null, requestTermination: null }]);
    expect(result).not.toHaveProperty("latestAttemptsByScope");
  });

  it("reads the stored receipts of each unresolved attempt and offers the provider's final refusal as the answer", async () => {
    const proof = completionDrain();
    proof.unresolvedAttempts = [{ attemptId: "19", owner: "legacy", state: "uncertain", outboxId: null, scope: proof.latestAttemptsByScope[0].scope }];
    capture.mockResolvedValueOnce(proof);
    const { repository, client } = fixture();
    // Answers recorded two hours before the capture clock: beyond the 30-second deadline plus the 60-minute margin.
    const startedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000 - 10_000);
    const recordedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const rows = [
      { attempt_id: "19", request_id: "9001", ordinal: 1, method: "PUT", path: "/sell/inventory/v1/inventory_item/SKU", started_at: startedAt,
        outcome: "completed", http_status: 204, response_hash: "a".repeat(64), error_codes: [], recorded_at: recordedAt },
      { attempt_id: "19", request_id: "9002", ordinal: 2, method: "POST", path: "/sell/inventory/v1/offer/77/publish", started_at: startedAt,
        outcome: "uncertain", http_status: 400, response_hash: "b".repeat(64), error_codes: ["25002"], recorded_at: recordedAt },
    ];
    client.query.mockImplementation(async (sql: string) => ({ rowCount: 0, rows:
      sql.includes("FROM inventory.availability_activation_runs") ? [{ id: "1" }]
      : sql.includes("FROM inventory.quantity_provider_requests") ? rows
      : sql.includes("FROM inventory.quantity_publication_attempts") ? [{ id: "19", started_at: startedAt }] : [] }));
    const result = await repository.pending("1", NOW);
    expect(result.unresolvedAttempts[0]?.providerAnswer).toEqual({ requestId: "9002", method: "POST", path: "/sell/inventory/v1/offer/77/publish",
      httpStatus: 400, errorCodes: ["25002"], responseHash: "b".repeat(64), recordedAt: recordedAt.toISOString() });
    expect(result.unresolvedAttempts[0]?.requestTermination).toEqual(summarizeRequestTermination({ attemptId: "19", state: "uncertain", startedAt, now: NOW,
      providerRequestTimeoutMs: 30_000, receipts: rows.map(row => ({ attemptId: row.attempt_id, requestId: row.request_id, ordinal: row.ordinal,
        method: row.method, path: row.path, startedAt: row.started_at, outcome: row.outcome as "completed" | "uncertain", httpStatus: row.http_status,
        responseHash: row.response_hash, errorCodes: row.error_codes, recordedAt: row.recorded_at })) }));
    expect(result.unresolvedAttempts[0]?.requestTermination).toMatchObject({ requestCount: 2, lastActivityAt: recordedAt.toISOString(), providerRequestTimeoutSeconds: 30 });
    const receipts = client.query.mock.calls.find(([sql]) => sql.includes("FROM inventory.quantity_provider_requests"))!;
    expect(receipts[0]).toContain("LEFT JOIN inventory.quantity_provider_request_results"); expect(receipts[0]).toContain("q.started_at");
    expect(receipts[1]).toEqual([["19"]]);
    const timings = client.query.mock.calls.find(([sql]) => sql.includes("FROM inventory.quantity_publication_attempts"))!;
    expect(timings[1]).toEqual([["19"]]);
  });

  it("offers no termination proof for an attempt active within the margin, or without a stored start", async () => {
    const proof = completionDrain();
    proof.unresolvedAttempts = [{ attemptId: "19", owner: "legacy", state: "uncertain", outboxId: null, scope: proof.latestAttemptsByScope[0].scope },
      { attemptId: "21", owner: "legacy", state: "running", outboxId: null, scope: proof.latestAttemptsByScope[0].scope }];
    capture.mockResolvedValueOnce(proof);
    const { repository, client } = fixture();
    const recent = new Date(NOW.getTime() - 10 * 60 * 1000);
    client.query.mockImplementation(async (sql: string) => ({ rowCount: 0, rows:
      sql.includes("FROM inventory.availability_activation_runs") ? [{ id: "1" }]
      : sql.includes("FROM inventory.quantity_provider_requests") ? [
        { attempt_id: "19", request_id: "9001", ordinal: 1, method: "PUT", path: "/sell/inventory/v1/inventory_item/SKU", started_at: recent,
          outcome: null, http_status: null, response_hash: null, error_codes: [], recorded_at: null }]
      : sql.includes("FROM inventory.quantity_publication_attempts") ? [{ id: "19", started_at: recent }] : [] }));
    const result = await repository.pending("1", NOW);
    expect(result.unresolvedAttempts.map(attempt => [attempt.attemptId, attempt.providerAnswer, attempt.requestTermination]))
      .toEqual([["19", null, null], ["21", null, null]]);
  });

  it.each([400, 408])("does not present historical eBay bulk plus HTTP%s as proved provider completion or timeout termination", async status => {
    const proof = completionDrain();
    proof.unresolvedAttempts = [{ attemptId: "19", owner: "legacy", state: "uncertain", outboxId: null,
      scope: { ...proof.latestAttemptsByScope[0].scope, providerKey: "ebay", providerScopeType: "account", externalScopeId: "seller", externalInventoryItemId: "SKU" } }];
    capture.mockResolvedValueOnce(proof);
    const { repository, client } = fixture();
    const at = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const rows = [
      { attempt_id: "19", request_id: "9001", ordinal: 1, method: "POST", path: "/sell/inventory/v1/bulk_update_price_quantity", started_at: at,
        outcome: "completed", http_status: 200, response_hash: "a".repeat(64), error_codes: [], recorded_at: at },
      { attempt_id: "19", request_id: "9002", ordinal: 2, method: "PUT", path: "/sell/inventory/v1/inventory_item/SKU", started_at: at,
        outcome: "uncertain", http_status: status, response_hash: "b".repeat(64), error_codes: ["25002"], recorded_at: at },
    ];
    client.query.mockImplementation(async (sql: string) => ({ rowCount: 0, rows:
      sql.includes("FROM inventory.availability_activation_runs") ? [{ id: "1" }]
      : sql.includes("FROM inventory.quantity_provider_requests") ? rows
      : sql.includes("FROM inventory.quantity_publication_attempts") ? [{ id: "19", started_at: at }] : [] }));
    const result = await repository.pending("1", NOW);
    expect(result.unresolvedAttempts[0]).toMatchObject({ providerKey: "ebay", providerAnswer: null, requestTermination: null });
  });

  it("does not read receipts when nothing is unresolved, and offers no answer for an attempt without one", async () => {
    const { repository, client } = fixture();
    await repository.pending("1", NOW);
    expect(client.query.mock.calls.some(([sql]) => sql.includes("quantity_provider_requests"))).toBe(false);
    const proof = completionDrain();
    proof.unresolvedAttempts = [{ attemptId: "19", owner: "legacy", state: "running", outboxId: null, scope: proof.latestAttemptsByScope[0].scope }];
    capture.mockResolvedValueOnce(proof);
    const result = await fixture().repository.pending("1", NOW);
    expect(result.unresolvedAttempts[0]?.providerAnswer).toBeNull();
    expect(result.unresolvedAttempts[0]?.requestTermination).toBeNull();
  });

  it("passes the exact attestation owner command and commits only strict audited output", async () => {
    const { repository, client } = fixture();
    await expect(repository.attest(command())).resolves.toEqual(recoveryResult());
    expect(attest).toHaveBeenCalledExactlyOnceWith(client, command()); expect(capture).not.toHaveBeenCalled();
    expect(client.query.mock.calls[0][0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED");
    expect(client.query.mock.lastCall![0]).toBe("COMMIT"); expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each(["pending", "attest"] as const)("validates all direct %s inputs before acquiring a connection", async action => {
    const { repository, connectionPool } = fixture();
    const operation = action === "pending" ? repository.pending("abc", NOW) : repository.attest({ ...command(), actor: " " });
    await expect(operation).rejects.toMatchObject({ name: "ZodError" });
    expect(connectionPool.connect).not.toHaveBeenCalled();
  });

  it("rejects invalid timestamps and extra command fields before database access", async () => {
    const { repository, connectionPool } = fixture();
    await expect(repository.pending("1", new Date("invalid"))).rejects.toMatchObject({ name: "ZodError" });
    await expect(repository.attest({ ...command(), now: new Date("invalid") })).rejects.toMatchObject({ name: "ZodError" });
    await expect(repository.attest({ ...command(), force: true } as never)).rejects.toMatchObject({ name: "ZodError" });
    expect(connectionPool.connect).not.toHaveBeenCalled();
  });

  it.each(["pending", "attest"] as const)("rolls back %s owner failures and preserves their identity without retry", async action => {
    const { repository, client } = fixture(); const error = new Error("Owner conflict");
    (action === "pending" ? capture : attest).mockRejectedValueOnce(error);
    await expect(action === "pending" ? repository.pending("1", NOW) : repository.attest(command())).rejects.toBe(error);
    expect(client.query.mock.lastCall![0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("rolls back malformed owner responses instead of reporting success", async () => {
    const { repository, client } = fixture();
    attest.mockResolvedValueOnce({ attemptId: "20", basis: "provider_verified", replay: false });
    await expect(repository.attest(command())).rejects.toMatchObject({ name: "ZodError" });
    expect(client.query.mock.lastCall![0]).toBe("ROLLBACK");
  });

  it("does not auto-retry after an uncertain COMMIT and retains retryable failure", async () => {
    const { repository, client } = fixture(); const error = new Error("Commit connection loss");
    client.query.mockImplementation(async sql => { if (sql === "COMMIT") throw error; return { rows: [], rowCount: 0 }; });
    await expect(repository.attest(command())).rejects.toBe(error);
    expect(attest).toHaveBeenCalledTimes(1); expect(client.query.mock.lastCall![0]).toBe("ROLLBACK");
  });

  it("discards a connection when rollback cannot establish clean transaction state", async () => {
    const { repository, client } = fixture(); const original = new Error("Owner failure"); const rollback = new Error("Rollback failure");
    attest.mockRejectedValueOnce(original);
    client.query.mockImplementation(async sql => { if (sql === "ROLLBACK") throw rollback; return { rows: [], rowCount: 0 }; });
    await expect(repository.attest(command())).rejects.toMatchObject({ name: "AggregateError", errors: [original, rollback] });
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("releases a connection if BEGIN fails and never invokes the owner", async () => {
    const { repository, client } = fixture(); const error = new Error("Begin unavailable"); client.query.mockRejectedValueOnce(error);
    await expect(repository.attest(command())).rejects.toBe(error);
    expect(attest).not.toHaveBeenCalled(); expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
