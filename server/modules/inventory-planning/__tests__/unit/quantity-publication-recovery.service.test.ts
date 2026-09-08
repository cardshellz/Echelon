import { describe, expect, it, vi } from "vitest";
import { pendingQuantityPublicationRecoverySchema, quantityPublicationRecoverySchema, quantityPublicationRecoveryResultSchema } from "@shared/types/inventory-publication-recovery";
import { QuantityPublicationRecoveryService, type QuantityPublicationRecoveryCommand } from "../../application/quantity-publication-recovery.service";
import { CUTOVER_COMPLETION_NOW as NOW } from "../fixtures/inventory-cutover-completion.fixture";
import { pendingRecovery, recoveryRequest, recoveryResult } from "../fixtures/quantity-publication-recovery.fixture";

function fixture(now: () => Date = () => NOW) {
  const store = { pending: vi.fn(async (_run: string | undefined, _now: Date) => pendingRecovery()),
    attest: vi.fn(async (_command: QuantityPublicationRecoveryCommand) => recoveryResult()) };
  return { store, service: new QuantityPublicationRecoveryService(store, { now }) };
}

describe("explicit quantity publication recovery application boundary", () => {
  it("reads immutable attempt history without calling attestation", async () => {
    const { service, store } = fixture();
    await expect(service.pending({ activationRunId: "1" }, " operator ")).resolves.toEqual(pendingRecovery());
    expect(store.pending).toHaveBeenCalledExactlyOnceWith("1", NOW);
    expect(store.pending.mock.calls[0][1]).not.toBe(NOW); expect(store.attest).not.toHaveBeenCalled();
  });

  it("lets the owner resolve the latest persisted run when open status is absent", async () => {
    const { service, store } = fixture();
    store.pending.mockResolvedValueOnce({ ...pendingRecovery(), activationRunId: "9", suppressed: false });
    await expect(service.pending({}, "operator")).resolves.toMatchObject({ activationRunId: "9", suppressed: false });
    expect(store.pending).toHaveBeenCalledExactlyOnceWith(undefined, NOW);
    expect(store.attest).not.toHaveBeenCalled();
  });

  it("sends only the explicit retained evidence and authenticated actor to the owner", async () => {
    const { service, store } = fixture(); const request = recoveryRequest(); const before = JSON.stringify(request);
    await expect(service.attest(request, " operator ")).resolves.toEqual(recoveryResult());
    expect(store.attest).toHaveBeenCalledExactlyOnceWith({ ...request, actor: "operator", now: NOW });
    expect(store.attest.mock.calls[0][0].now).not.toBe(NOW);
    expect(store.pending).not.toHaveBeenCalled(); expect(JSON.stringify(request)).toBe(before);
  });

  it.each([undefined, null, 1, "", " ", "x".repeat(101)])("requires current authentication even on replay: %#", async actor => {
    const { service, store } = fixture(() => { throw new Error("Clock must not run"); });
    await expect(service.pending(null, actor)).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_ACTOR_REQUIRED", status: 401 });
    await expect(service.attest(null, actor)).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_ACTOR_REQUIRED", status: 401 });
    expect(store.pending).not.toHaveBeenCalled(); expect(store.attest).not.toHaveBeenCalled();
  });

  it.each(["abc", "", "0", "01", "-1", "9223372036854775808", 1, null])("rejects malformed run or attempt ID %j without native exceptions", async id => {
    const { service, store } = fixture();
    await expect(service.pending({ activationRunId: id }, "operator")).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_PENDING_REQUEST_INVALID", status: 400 });
    await expect(service.attest({ ...recoveryRequest(), attemptId: id }, "operator")).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_REQUEST_INVALID", status: 400 });
    expect(store.pending).not.toHaveBeenCalled(); expect(store.attest).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "short" }, { evidenceKind: "timeout" }, { terminalOutcome: "probably_finished" }, { evidenceReference: " " },
    { evidenceHash: "abc" }, { evidenceHash: "A".repeat(64) }, { idempotencyKey: "" }, { force: true }, { actor: "admin" },
    { reason: "x".repeat(2001) }, { evidenceReference: "x".repeat(2001) },
  ])("does not infer missing terminal evidence or accept actor/force overrides: %#", async override => {
    const { service, store } = fixture();
    await expect(service.attest({ ...recoveryRequest(), ...override }, "operator")).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_REQUEST_INVALID", status: 400 });
    expect(store.attest).not.toHaveBeenCalled();
  });

  it.each([new Date("invalid"), "2026-09-08", null])("validates clocks before store access: %#", async now => {
    const { service, store } = fixture(() => now as Date);
    await expect(service.pending({ activationRunId: "1" }, "operator")).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_CLOCK_INVALID", status: 500 });
    await expect(service.attest(recoveryRequest(), "operator")).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_CLOCK_INVALID", status: 500 });
    expect(store.pending).not.toHaveBeenCalled(); expect(store.attest).not.toHaveBeenCalled();
  });

  it("does not automatically retry or turn uncertain completion into success", async () => {
    let now = NOW; const { service, store } = fixture(() => now); const error = new Error("Unknown commit outcome");
    store.attest.mockRejectedValueOnce(error);
    await expect(service.attest(recoveryRequest(), "operator")).rejects.toBe(error);
    expect(store.attest).toHaveBeenCalledTimes(1); expect(store.pending).not.toHaveBeenCalled();
    now = new Date(NOW.getTime() + 1000); store.attest.mockResolvedValueOnce({ ...recoveryResult(), replay: true });
    await expect(service.attest(recoveryRequest(), "operator")).resolves.toMatchObject({ replay: true });
    expect(store.attest.mock.calls[1][0]).toEqual({ ...store.attest.mock.calls[0][0], now });
  });

  it("keeps operator attestation distinct from verified provider state", async () => {
    const { service, store } = fixture();
    store.attest.mockResolvedValueOnce({ ...recoveryResult(), basis: "provider_verified" } as never);
    await expect(service.attest(recoveryRequest(), "operator")).rejects.toMatchObject({ name: "ZodError" });
    store.pending.mockResolvedValueOnce({ ...pendingRecovery(), providerWriteAttempted: true } as never);
    await expect(service.pending({ activationRunId: "1" }, "operator")).rejects.toMatchObject({ name: "ZodError" });
  });

  it("rejects well-shaped receipts for different attempts or activation runs", async () => {
    const { service, store } = fixture();
    store.attest.mockResolvedValueOnce({ ...recoveryResult(), attemptId: "21" });
    await expect(service.attest(recoveryRequest(), "operator")).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_RESULT_INVALID", status: 500 });
    store.pending.mockResolvedValueOnce({ ...pendingRecovery(), activationRunId: "2" });
    await expect(service.pending({ activationRunId: "1" }, "operator")).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_RESULT_INVALID", status: 500 });
  });
});

describe("operator recovery wire DTOs", () => {
  it("accepts both retained terminal evidence classes and outcomes, never timeout-only evidence", () => {
    for (const evidenceKind of ["provider_terminal_request_record", "owner_process_and_request_termination_record"]) {
      for (const terminalOutcome of ["completed", "not_sent"]) expect(quantityPublicationRecoverySchema.safeParse({ ...recoveryRequest(), evidenceKind, terminalOutcome }).success).toBe(true);
    }
    expect(quantityPublicationRecoverySchema.safeParse({ ...recoveryRequest(), evidenceKind: "age_threshold" }).success).toBe(false);
  });

  it("allows an empty pending list without claiming provider correctness and rejects duplicate attempts", () => {
    expect(pendingQuantityPublicationRecoverySchema.safeParse({ ...pendingRecovery(), suppressed: false, unresolvedAttempts: [] }).success).toBe(true);
    const row = pendingRecovery().unresolvedAttempts[0];
    expect(pendingQuantityPublicationRecoverySchema.safeParse({ ...pendingRecovery(), unresolvedAttempts: [row, row] }).success).toBe(false);
  });

  it("rejects partial/oversized/malformed owner histories and extra private output fields", () => {
    const row = pendingRecovery().unresolvedAttempts[0];
    for (const override of [{ unresolvedAttempts: Array(1001).fill(row) }, { gateEpoch: "abc" }, { gateEpoch: "9223372036854775808" },
      { pendingCatchupCount: 1.5 }, { extra: true }, { unresolvedAttempts: [{ ...row, state: "resolved" }] },
      { unresolvedAttempts: [{ ...row, connectionId: 2147483648 }] }]) {
      expect(pendingQuantityPublicationRecoverySchema.safeParse({ ...pendingRecovery(), ...override }).success).toBe(false);
    }
    expect(quantityPublicationRecoveryResultSchema.safeParse({ ...recoveryResult(), token: "private" }).success).toBe(false);
  });
});
