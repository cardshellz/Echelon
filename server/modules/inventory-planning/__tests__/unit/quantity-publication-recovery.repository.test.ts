import type { Pool, PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresQuantityPublicationRecoveryRepository } from "../../infrastructure/quantity-publication-recovery.repository";
import { completionDrain, CUTOVER_COMPLETION_NOW as NOW } from "../fixtures/inventory-cutover-completion.fixture";
import { recoveryRequest, recoveryResult } from "../fixtures/quantity-publication-recovery.fixture";

const { capture, attest } = vi.hoisted(() => ({ capture: vi.fn(), attest: vi.fn() }));
vi.mock("../../infrastructure/quantity-publication-admission.repository", () => ({
  captureQuantityPublicationDrainInsideTransaction: capture, attestQuantityPublicationAttemptInsideTransaction: attest,
}));
function fixture() {
  const client = { query: vi.fn(async (sql: string, _values?: unknown[]) => ({
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
      externalScopeId: "location-1", externalInventoryItemId: "item-1" }]);
    expect(result).not.toHaveProperty("latestAttemptsByScope");
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
