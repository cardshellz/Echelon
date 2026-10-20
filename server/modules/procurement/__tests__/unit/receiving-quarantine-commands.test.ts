import { custodyTestResult } from "@shared/procurement/__tests__/receiving-quarantine.fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReceivingCustodyCommands, custodyCommandScope, hashCustodyCommandIdentity, CUSTODY_COMMAND_PRINCIPAL } from "../../receiving-quarantine.commands";
import { ReceivingQuarantineError } from "../../domain/receiving-quarantine";
import type { CustodyTransaction } from "../../receiving-quarantine.repository";
import type { ReceivingQuarantineReceivingPort } from "../../receiving-quarantine-receiving.port";
import type {
  FinancialCommandDescriptor, FinancialCommandRepository, FinancialCommandResult,
} from "../../../../platform/commands/transactional-command.service";

const mocks = vi.hoisted(() => ({ legacy: vi.fn(), execute: vi.fn(), logError: vi.fn() }));
vi.mock("../../receiving-quarantine-command-evidence.repository", () => ({ assertNoLegacyCustodyCommand: mocks.legacy }));
vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: {} }));
vi.mock("../../../../platform/observability", () => ({ logger: { error: mocks.logError } }));
vi.mock("../../receiving-quarantine.service", async importOriginal => ({
  ...await importOriginal<typeof import("../../receiving-quarantine.service")>(),
  executeReceivingCustodyCommand: mocks.execute,
}));

const body = { kind: "unidentified", quantity: 2, unitLabel: "box", description: "Unexpected cartons",
  observedSku: null, condition: "unexpected", holdingLocationId: 3, reason: "Inspected delivery", evidenceReference: "photo:42" };
const descriptor: FinancialCommandDescriptor = {
  ...custodyCommandScope(), actorType: "service", actorId: CUSTODY_COMMAND_PRINCIPAL,
  idempotencyKey: "custody-command-42", requestHash: hashCustodyCommandIdentity({ command: "intake", resourceId: 7, body, actorId: "operator" }), contractVersion: 1,
};
const at = new Date("2026-10-14T12:00:00Z");

function fixture() {
  const tx: CustodyTransaction = { execute: vi.fn() };
  const receiving: ReceivingQuarantineReceivingPort = {
    reviewQuarantineIntakeInTransaction: vi.fn(),
    prepareQuarantineAcceptanceInTransaction: vi.fn(),
    cancelQuarantineAcceptanceInTransaction: vi.fn(),
  };
  let terminal: FinancialCommandResult | null = null;
  const repository: FinancialCommandRepository<CustodyTransaction> = {
    async reserve() {
      return terminal ? { kind: "replay", result: { ...terminal, replayed: true } }
        : { kind: "claimed", claim: { commandId: 42, leaseToken: "lease-42" } };
    },
    async executeClaim(claim, _descriptor, work) {
      const success = await work(tx);
      const result = { commandId: claim.commandId, replayed: false, httpStatus: success.httpStatus,
        body: success.body, terminalState: "succeeded" as const };
      terminal = result;
      return result;
    },
    async rejectClaim(claim, _descriptor, rejection) {
      terminal = { commandId: claim.commandId, replayed: false, httpStatus: rejection.httpStatus,
        body: rejection.body, terminalState: "rejected" };
      return terminal;
    },
    async markRetryable() {},
  };
  const reserve = vi.spyOn(repository, "reserve");
  const reject = vi.spyOn(repository, "rejectClaim");
  const retry = vi.spyOn(repository, "markRetryable");
  const commands = createReceivingCustodyCommands(receiving, repository, () => at);
  const execute = () => commands.execute("intake", 7, body, "operator", descriptor);
  return { execute, reserve, reject, retry, tx, receiving };
}

beforeEach(() => vi.clearAllMocks());

describe("receiving custody command recovery", () => {
  it("recovers a repaired fence with the same key and replays the subsequent success", async () => {
    const { execute, reserve, reject, retry, tx, receiving } = fixture();
    const failure = new ReceivingQuarantineError("RECEIVING_CUSTODY_FENCE_MISSING", "Receiving custody protection is unavailable. Contact an administrator.", 503);
    const completed = custodyTestResult("intake", 7, body, "operator");
    mocks.execute.mockRejectedValueOnce(failure).mockResolvedValue(completed);

    await expect(execute()).rejects.toBe(failure);
    expect(retry).toHaveBeenCalledWith({ commandId: 42, leaseToken: "lease-42" }, descriptor, {
      kind: "retryable", errorCode: failure.code, errorMessage: failure.message,
    });
    expect(reject).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith("receiving.custody.protection_unavailable", { error_code: failure.code });

    await expect(execute()).resolves.toMatchObject({ terminalState: "succeeded", httpStatus: 200, body: completed, replayed: false });
    await expect(execute()).resolves.toMatchObject({ terminalState: "succeeded", body: completed, replayed: true });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute).toHaveBeenLastCalledWith(tx, receiving, {
      command: "intake", resourceId: 7, body, actorId: "operator", at, commandKey: descriptor.idempotencyKey,
    });
    expect(reserve).toHaveBeenCalledTimes(3);
    for (const [reserved] of reserve.mock.calls) expect(reserved).toBe(descriptor);
  });

  it.each([400, 401, 403, 404, 409, 422])("keeps a definitive custody HTTP%s rejection terminal", async statusCode => {
    const { execute, reject, retry } = fixture();
    const failure = new ReceivingQuarantineError("RECEIVING_CUSTODY_REJECTED", "Review the custody evidence.", statusCode);
    mocks.execute.mockRejectedValue(failure);
    await expect(execute()).resolves.toMatchObject({ terminalState: "rejected", httpStatus: statusCode,
      body: { code: failure.code, error: failure.message }, replayed: false });
    await expect(execute()).resolves.toMatchObject({ terminalState: "rejected", replayed: true });
    expect(reject).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
  it("does not publish a false success when returned intake quantity differs", async () => {
    const f = fixture(); const result = custodyTestResult("intake", 7, body, "operator"); result.observation.observedQty++;
    mocks.execute.mockResolvedValue(result);
    await expect(f.execute()).rejects.toMatchObject({ code: "RECEIVING_CUSTODY_RESULT_INVALID" });
    expect(f.retry).toHaveBeenCalledOnce(); expect(f.reject).not.toHaveBeenCalled();
  });
  it("retains unknown legacy evidence as retryable without a terminal rejection proof", async () => {
    const f = fixture(); mocks.legacy.mockRejectedValueOnce(new Error("legacy evidence"));
    await expect(f.execute()).rejects.toThrow("legacy evidence"); expect(mocks.execute).not.toHaveBeenCalled(); expect(f.reject).not.toHaveBeenCalled();
  });

});
