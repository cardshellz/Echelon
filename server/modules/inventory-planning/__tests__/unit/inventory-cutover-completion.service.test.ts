import { describe, expect, it, vi } from "vitest";
import { finishInventoryCutoverRequestSchema, finishInventoryCutoverResultSchema, inventoryCutoverVerificationSchema } from "@shared/types/inventory-cutover-completion";
import { InventoryCutoverCompletionService, type FinishInventoryCutoverCommand } from "../../application/inventory-cutover-completion.service";
import { CUTOVER_COMPLETION_NOW as NOW, CUTOVER_COMPLETION_REQUEST as REQUEST,
  completionResult, completionVerification } from "../fixtures/inventory-cutover-completion.fixture";

function fixture(now: () => Date = () => NOW) {
  const store = { verify: vi.fn(async (_runId: string, _now: Date) => completionVerification()),
    finish: vi.fn(async (_command: FinishInventoryCutoverCommand) => completionResult()) };
  return { store, service: new InventoryCutoverCompletionService(store, { now }) };
}

describe("cutover completion application boundary", () => {
  it("verifies only the requested run using cloned injected time and no mutation call", async () => {
    const { store, service } = fixture();
    await expect(service.verify({ activationRunId: "1" }, " operator-1 ")).resolves.toEqual(completionVerification());
    expect(store.verify).toHaveBeenCalledExactlyOnceWith("1", NOW);
    expect(store.verify.mock.calls[0][1]).not.toBe(NOW);
    expect(store.finish).not.toHaveBeenCalled();
  });

  it("sends a single explicit finish owner command with session actor, verification hash and cloned clock", async () => {
    const { store, service } = fixture();
    await expect(service.finish(REQUEST, " operator-1 ")).resolves.toEqual(completionResult());
    expect(store.finish).toHaveBeenCalledExactlyOnceWith({ ...REQUEST, actor: "operator-1", occurredAt: NOW,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(store.finish.mock.calls[0][0].occurredAt).not.toBe(NOW);
    expect(store.verify).not.toHaveBeenCalled();
  });

  it("keeps retry identity independent of time but bound to actor and every semantic request field", async () => {
    let now = NOW; const { store, service } = fixture(() => now);
    await service.finish(REQUEST, "operator-1");
    now = new Date(NOW.getTime() + 1000); await service.finish(REQUEST, "operator-1");
    const original = store.finish.mock.calls[0][0].requestHash;
    expect(store.finish.mock.calls[1][0].requestHash).toBe(original);
    expect(store.finish.mock.calls[0][0].occurredAt).not.toEqual(store.finish.mock.calls[1][0].occurredAt);
    for (const override of [{ activationRunId: "2" }, { expectedVerificationHash: "b".repeat(64) },
      { reason: "A different reviewed reason" }, { idempotencyKey: "another-key" }]) {
      store.finish.mockImplementationOnce(async command => ({ ...completionResult(), activationRunId: command.activationRunId, verificationHash: command.expectedVerificationHash }));
      await service.finish({ ...REQUEST, ...override }, "operator-1");
      expect(store.finish.mock.lastCall![0].requestHash).not.toBe(original);
    }
    await service.finish(REQUEST, "operator-2");
    expect(store.finish.mock.lastCall![0].requestHash).not.toBe(original);
  });

  it("normalizes boundary whitespace deterministically without changing the caller request", async () => {
    const { store, service } = fixture();
    const request = { ...REQUEST, reason: ` ${REQUEST.reason} `, idempotencyKey: ` ${REQUEST.idempotencyKey} ` };
    const before = JSON.stringify(request);
    await service.finish(request, " operator-1 "); await service.finish(REQUEST, "operator-1");
    expect(store.finish.mock.calls[0][0].requestHash).toBe(store.finish.mock.calls[1][0].requestHash);
    expect(JSON.stringify(request)).toBe(before);
  });

  it.each([undefined, null, 1, "", " ", "x".repeat(101)])("requires an actor before any validation/store/replay work: %#", async actor => {
    const { store, service } = fixture(() => { throw new Error("Clock must not run"); });
    await expect(service.verify(null, actor)).rejects.toMatchObject({ code: "CUTOVER_ACTOR_REQUIRED", status: 401 });
    await expect(service.finish(null, actor)).rejects.toMatchObject({ code: "CUTOVER_ACTOR_REQUIRED", status: 401 });
    expect(store.verify).not.toHaveBeenCalled(); expect(store.finish).not.toHaveBeenCalled();
  });

  it.each(["", "abc", "1.5", "0", "01", "-1", "9223372036854775808", 1, null])(
    "rejects malformed run IDs %j before store access", async activationRunId => {
      const { store, service } = fixture();
      await expect(service.verify({ activationRunId }, "operator-1")).rejects.toMatchObject({ code: "CUTOVER_VERIFICATION_REQUEST_INVALID", status: 400 });
      await expect(service.finish({ ...REQUEST, activationRunId }, "operator-1")).rejects.toMatchObject({ code: "CUTOVER_FINISH_REQUEST_INVALID", status: 400 });
      expect(store.verify).not.toHaveBeenCalled(); expect(store.finish).not.toHaveBeenCalled();
    },
  );

  it.each([{ ...REQUEST, reason: " " }, { ...REQUEST, idempotencyKey: "" }, { ...REQUEST, expectedVerificationHash: "ABC" },
    { ...REQUEST, actor: "admin" }, { ...REQUEST, unexpected: true }, { ...REQUEST, reason: "x".repeat(1001) },
  ])("rejects malformed or overridden finish intent: %#", async request => {
    const { store, service } = fixture();
    await expect(service.finish(request, "operator-1")).rejects.toMatchObject({ code: "CUTOVER_FINISH_REQUEST_INVALID", status: 400 });
    expect(store.finish).not.toHaveBeenCalled();
  });

  it.each([new Date("invalid"), "2026-09-08", null, undefined])("rejects malformed clocks before store access: %#", async now => {
    const { store, service } = fixture(() => now as Date);
    await expect(service.verify({ activationRunId: "1" }, "operator-1")).rejects.toMatchObject({ code: "CUTOVER_CLOCK_INVALID", status: 500 });
    await expect(service.finish(REQUEST, "operator-1")).rejects.toMatchObject({ code: "CUTOVER_CLOCK_INVALID", status: 500 });
    expect(store.verify).not.toHaveBeenCalled(); expect(store.finish).not.toHaveBeenCalled();
  });

  it("does not retry or rewrite an uncertain owner failure as successful completion", async () => {
    const { store, service } = fixture();
    const error = Object.assign(new Error("Connection lost after commit"), { code: "08006" });
    store.finish.mockRejectedValueOnce(error);
    await expect(service.finish(REQUEST, "operator-1")).rejects.toBe(error);
    expect(store.finish).toHaveBeenCalledTimes(1); expect(store.verify).not.toHaveBeenCalled();
    const first = store.finish.mock.calls[0][0];
    store.finish.mockResolvedValueOnce({ ...completionResult(), alreadyApplied: true });
    await expect(service.finish(REQUEST, "operator-1")).resolves.toMatchObject({ alreadyApplied: true });
    expect(store.finish.mock.calls[1][0].requestHash).toBe(first.requestHash);
  });

  it("rejects unvalidated store output, including misleading ready evidence", async () => {
    const { store, service } = fixture();
    store.verify.mockResolvedValueOnce({ ...completionVerification(), verifiedPublicationRows: 0, publicationRows: [] });
    await expect(service.verify({ activationRunId: "1" }, "operator-1")).rejects.toMatchObject({ name: "ZodError" });
    store.finish.mockResolvedValueOnce({ ...completionResult(), runtimeAuthority: "legacy", private: "secret" } as never);
    await expect(service.finish(REQUEST, "operator-1")).rejects.toMatchObject({ name: "ZodError" });
  });

  it("binds well-shaped store results to this requested run and verification evidence", async () => {
    const { store, service } = fixture();
    store.verify.mockResolvedValueOnce({ ...completionVerification(), activationRunId: "2" });
    await expect(service.verify({ activationRunId: "1" }, "operator-1")).rejects.toMatchObject({ code: "CUTOVER_VERIFICATION_RESULT_INVALID", status: 500 });
    for (const override of [{ activationRunId: "2" }, { verificationHash: "b".repeat(64) }]) {
      store.finish.mockResolvedValueOnce({ ...completionResult(), ...override });
      await expect(service.finish(REQUEST, "operator-1")).rejects.toMatchObject({ code: "CUTOVER_FINISH_RESULT_INVALID", status: 500 });
    }
  });
});

describe("completion wire contract consistency", () => {
  it.each([
    { ready: false }, { verifiedPublicationRows: 0 }, { publicationRows: [] }, { expectedPublicationRows: 2 },
    { configurationFreezeOpen: false }, { providerWriteAttempted: true }, { operationalWriteAttempted: true },
    { blockers: [{ code: "BLOCKED", subject: "publications", message: "Uncertain" }] },
    { publicationRows: [{ ...completionVerification().publicationRows[0], observedQuantity: "4" }] },
    { publicationRows: [{ ...completionVerification().publicationRows[0], state: "acknowledged" }] },
  ])("rejects internally contradictory or non-read-only evidence: %#", override => {
    expect(inventoryCutoverVerificationSchema.safeParse({ ...completionVerification(), ...override }).success).toBe(false);
  });

  it("allows incomplete rows only with explicit blockers, never a ready claim", () => {
    const value = { ...completionVerification(), ready: false, verifiedPublicationRows: 0, publicationRows: [],
      blockers: [{ code: "MISSING", subject: "1:2", message: "Missing full readback" }] };
    expect(inventoryCutoverVerificationSchema.safeParse(value).success).toBe(true);
    expect(inventoryCutoverVerificationSchema.safeParse({ ...value, verifiedPublicationRows: 1 }).success).toBe(false);
  });

  it("retains a completed receipt as historical evidence with matching counts and no reopened freeze", () => {
    const historical = { ...completionVerification(), ready: false, completedAt: NOW.toISOString(), configurationFreezeOpen: false, publicationRows: [] };
    expect(inventoryCutoverVerificationSchema.safeParse(historical).success).toBe(true);
    for (const override of [{ verifiedPublicationRows: 0 }, { ready: true }, { configurationFreezeOpen: true },
      { blockers: [{ code: "NEW", subject: "publications", message: "Not a historical receipt" }] }]) {
      expect(inventoryCutoverVerificationSchema.safeParse({ ...historical, ...override }).success).toBe(false);
    }
  });

  it("permits explicit zero-target completion while rejecting duplicate or oversized counts", () => {
    expect(inventoryCutoverVerificationSchema.safeParse({ ...completionVerification(), expectedPublicationRows: 0, verifiedPublicationRows: 0, publicationRows: [] }).success).toBe(true);
    const row = completionVerification().publicationRows[0];
    expect(inventoryCutoverVerificationSchema.safeParse({ ...completionVerification(), expectedPublicationRows: 2, verifiedPublicationRows: 2, publicationRows: [row, row] }).success).toBe(false);
    expect(inventoryCutoverVerificationSchema.safeParse({ ...completionVerification(), expectedPublicationRows: 100001 }).success).toBe(false);
  });

  it.each(["abc", "0", "01", "9223372036854775808", 1])("bounds SQL bigint IDs %j across requests/results", activationRunId => {
    expect(finishInventoryCutoverRequestSchema.safeParse({ ...REQUEST, activationRunId }).success).toBe(false);
    expect(finishInventoryCutoverResultSchema.safeParse({ ...completionResult(), activationRunId }).success).toBe(false);
  });

  it("accepts exact maximum quantities but rejects overflow and extra response fields", () => {
    const row = { ...completionVerification().publicationRows[0], desiredQuantity: "9223372036854775807", observedQuantity: "9223372036854775807" };
    expect(inventoryCutoverVerificationSchema.safeParse({ ...completionVerification(), publicationRows: [row] }).success).toBe(true);
    expect(inventoryCutoverVerificationSchema.safeParse({ ...completionVerification(), publicationRows: [{ ...row, observedQuantity: "9223372036854775808" }] }).success).toBe(false);
    expect(finishInventoryCutoverResultSchema.safeParse({ ...completionResult(), extra: true }).success).toBe(false);
  });
});
