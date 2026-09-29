import { describe, expect, it, vi } from "vitest";
import { pendingQuantityPublicationRecoverySchema, quantityPublicationRecoverySchema, quantityPublicationRecoveryResultSchema } from "@shared/types/inventory-publication-recovery";
import { QuantityPublicationRecoveryService, type QuantityPublicationRecoveryCommand } from "../../application/quantity-publication-recovery.service";
import { QuantityPublicationAdmissionError } from "../../domain/quantity-publication-admission";
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

describe("one-click confirmation of stored provider answers", () => {
  const answer = { requestId: "9002", method: "POST", path: "/sell/inventory/v1/offer/77/publish", httpStatus: 400,
    errorCodes: ["25002"], responseHash: "b".repeat(64), recordedAt: "2026-09-29T09:30:00.000Z" } as const;
  const termination = { requestCount: 1, lastActivityAt: "2026-09-29T09:30:00.000Z", quiescentSince: "2026-09-29T10:30:30.000Z",
    providerRequestTimeoutSeconds: 30, quiescenceMarginMinutes: 60, evidenceHash: "e".repeat(64) } as const;
  function history() {
    const base = pendingRecovery(); const row = base.unresolvedAttempts[0];
    return { ...base, unresolvedAttempts: [
      { ...row, attemptId: "20", providerAnswer: null, requestTermination: null },
      { ...row, attemptId: "9", providerKey: "ebay" as const, providerAnswer: { ...answer, errorCodes: [...answer.errorCodes] }, requestTermination: null },
      { ...row, attemptId: "100", providerKey: "ebay" as const, providerAnswer: { ...answer, errorCodes: [...answer.errorCodes], responseHash: "c".repeat(64) }, requestTermination: null },
      { ...row, attemptId: "300", providerKey: "ebay" as const, providerAnswer: null, requestTermination: { ...termination } },
    ] };
  }
  function receipt(attemptId: string, replay = false) { return { attemptId, basis: "operator_attestation" as const, replay, providerWriteAttempted: false as const }; }

  it("confirms each listed attempt whose stored answer the operator saw, in ascending attempt order, and reports the rest", async () => {
    const { service, store } = fixture(); store.pending.mockResolvedValue(history());
    store.attest.mockImplementation(async command => receipt(command.attemptId));
    const result = await service.attestProviderAnswers({ activationRunId: "1", confirmations: [
      { attemptId: "100", evidenceHash: "c".repeat(64) }, { attemptId: "20", evidenceHash: "a".repeat(64) }, { attemptId: "300", evidenceHash: "e".repeat(64) },
      { attemptId: "9", evidenceHash: "b".repeat(64) }, { attemptId: "5", evidenceHash: "d".repeat(64) } ] }, " operator ");
    expect(result).toEqual({ basis: "operator_attestation", providerWriteAttempted: false,
      confirmed: [{ attemptId: "9", replay: false }, { attemptId: "100", replay: false }, { attemptId: "300", replay: false }],
      skipped: [{ attemptId: "5", reason: "not_pending" }, { attemptId: "20", reason: "no_evidence" }] });
    expect(store.attest.mock.calls.map(([command]) => command.attemptId)).toEqual(["9", "100", "300"]);
    expect(store.attest.mock.calls[2][0]).toEqual({ attemptId: "300", idempotencyKey: `request-termination:300:${"e".repeat(64)}`, actor: "operator", now: NOW,
      evidenceKind: "owner_process_and_request_termination_record", terminalOutcome: "completed", evidenceHash: "e".repeat(64),
      evidenceReference: "Stored request record of attempt 300: 1 request; last activity at 2026-09-29T09:30:00.000Z; the 30-second provider request deadline and a 60-minute margin passed at 2026-09-29T10:30:30.000Z.",
      reason: "eBay was last contacted for attempt 300 at 2026-09-29T09:30:00.000Z; every request of it has been terminated since 2026-09-29T10:30:30.000Z, so none can still change provider quantities. Catch-up republishes the current quantity." });
    expect(store.attest.mock.calls[0][0]).toEqual({ attemptId: "9", idempotencyKey: `provider-answer:9:${"b".repeat(64)}`, actor: "operator", now: NOW,
      evidenceKind: "provider_terminal_request_record", terminalOutcome: "completed", evidenceHash: "b".repeat(64),
      evidenceReference: "Stored provider request 9002: POST /sell/inventory/v1/offer/77/publish answered HTTP 400 (codes 25002) at 2026-09-29T09:30:00.000Z",
      reason: "eBay answered every request of attempt 9; the last answer was HTTP 400 with codes 25002, a refusal that wrote no quantity." });
    expect(store.pending).toHaveBeenCalledExactlyOnceWith("1", NOW);
  });

  it("skips an attempt whose stored answer no longer matches what the operator saw", async () => {
    const { service, store } = fixture(); store.pending.mockResolvedValue(history());
    const result = await service.attestProviderAnswers({ confirmations: [{ attemptId: "9", evidenceHash: "f".repeat(64) }, { attemptId: "300", evidenceHash: "f".repeat(64) }] }, "operator");
    expect(result).toMatchObject({ confirmed: [], skipped: [{ attemptId: "9", reason: "evidence_changed" }, { attemptId: "300", reason: "evidence_changed" }] });
    expect(store.attest).not.toHaveBeenCalled(); expect(store.pending).toHaveBeenCalledExactlyOnceWith(undefined, NOW);
  });

  it("reports an owner conflict on one attempt and continues with the next", async () => {
    const { service, store } = fixture(); store.pending.mockResolvedValue(history());
    store.attest.mockRejectedValueOnce(new QuantityPublicationAdmissionError("PUBLICATION_RECOVERY_STATE_INVALID", "resolved meanwhile"))
      .mockResolvedValueOnce(receipt("100", true));
    const result = await service.attestProviderAnswers({ confirmations: [
      { attemptId: "9", evidenceHash: "b".repeat(64) }, { attemptId: "100", evidenceHash: "c".repeat(64) }] }, "operator");
    expect(result).toMatchObject({ confirmed: [{ attemptId: "100", replay: true }], skipped: [{ attemptId: "9", reason: "owner_conflict" }] });
    expect(store.attest).toHaveBeenCalledTimes(2);
  });

  it("propagates an unknown owner failure instead of reporting it as skipped", async () => {
    const { service, store } = fixture(); store.pending.mockResolvedValue(history()); const error = new Error("Commit connection loss");
    store.attest.mockResolvedValueOnce(receipt("9")).mockRejectedValueOnce(error);
    await expect(service.attestProviderAnswers({ confirmations: [
      { attemptId: "9", evidenceHash: "b".repeat(64) }, { attemptId: "100", evidenceHash: "c".repeat(64) }] }, "operator")).rejects.toBe(error);
    expect(store.attest).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { confirmations: [] }, { confirmations: [{ attemptId: "abc", evidenceHash: "b".repeat(64) }] },
    { confirmations: [{ attemptId: "9", evidenceHash: "short" }] }, { confirmations: [{ attemptId: "9", evidenceHash: "B".repeat(64) }] },
    { confirmations: [{ attemptId: "9", evidenceHash: "b".repeat(64) }, { attemptId: "9", evidenceHash: "c".repeat(64) }] },
    { confirmations: [{ attemptId: "9", responseHash: "b".repeat(64) }] },
    { confirmations: [{ attemptId: "9", evidenceHash: "b".repeat(64) }], actor: "admin" },
    { confirmations: [{ attemptId: "9", evidenceHash: "b".repeat(64) }], activationRunId: "0" },
  ])("rejects incomplete or overreaching confirmation requests before any store access: %#", async input => {
    const { service, store } = fixture();
    await expect(service.attestProviderAnswers(input, "operator")).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_ANSWERS_REQUEST_INVALID", status: 400 });
    expect(store.pending).not.toHaveBeenCalled(); expect(store.attest).not.toHaveBeenCalled();
  });

  it("requires current authentication before reading history", async () => {
    const { service, store } = fixture(() => { throw new Error("Clock must not run"); });
    await expect(service.attestProviderAnswers({ confirmations: [{ attemptId: "9", evidenceHash: "b".repeat(64) }] }, " "))
      .rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_ACTOR_REQUIRED", status: 401 });
    expect(store.pending).not.toHaveBeenCalled(); expect(store.attest).not.toHaveBeenCalled();
  });

  it("rejects a receipt for a different attempt and history from a different run", async () => {
    const { service, store } = fixture(); store.pending.mockResolvedValue(history());
    store.attest.mockResolvedValueOnce(receipt("21"));
    await expect(service.attestProviderAnswers({ confirmations: [{ attemptId: "9", evidenceHash: "b".repeat(64) }] }, "operator"))
      .rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_RESULT_INVALID", status: 500 });
    store.pending.mockResolvedValueOnce({ ...history(), activationRunId: "2" });
    await expect(service.attestProviderAnswers({ activationRunId: "1", confirmations: [{ attemptId: "9", evidenceHash: "b".repeat(64) }] }, "operator"))
      .rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_RESULT_INVALID", status: 500 });
    expect(store.attest).toHaveBeenCalledTimes(1);
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
