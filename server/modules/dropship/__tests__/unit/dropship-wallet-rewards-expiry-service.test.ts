import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipRewardsExpiryService,
  type DropshipRewardsExpiryAccountOutcome,
  type DropshipRewardsExpiryAccountRef,
  type DropshipRewardsExpiryRepository,
} from "../../application/dropship-wallet-rewards-expiry-service";

const now = new Date("2026-09-25T06:00:00.000Z");

class FakeExpiryRepository implements DropshipRewardsExpiryRepository {
  due: DropshipRewardsExpiryAccountRef[] = [];
  listInputs: Array<{ now: Date; limit: number }> = [];
  expireInputs: Array<DropshipRewardsExpiryAccountRef & { now: Date }> = [];
  outcomes = new Map<number, DropshipRewardsExpiryAccountOutcome | Error>();

  async listWalletAccountsWithDueRewards(input: { now: Date; limit: number }): Promise<DropshipRewardsExpiryAccountRef[]> {
    this.listInputs.push(input);
    return this.due;
  }

  async expireDueRewardsForAccount(input: DropshipRewardsExpiryAccountRef & { now: Date }): Promise<DropshipRewardsExpiryAccountOutcome> {
    this.expireInputs.push(input);
    const outcome = this.outcomes.get(input.walletAccountId);
    if (outcome instanceof Error) throw outcome;
    return outcome ?? { ...input, expiredLots: [], rewardsBalanceBeforeCents: 0, rewardsBalanceAfterCents: 0 };
  }
}

function buildService(repository: FakeExpiryRepository) {
  const logs: Array<DropshipLogEvent & { level: string }> = [];
  const service = new DropshipRewardsExpiryService({
    repository,
    clock: { now: () => now },
    logger: {
      info: (event) => logs.push({ ...event, level: "info" }),
      warn: (event) => logs.push({ ...event, level: "warn" }),
      error: (event) => logs.push({ ...event, level: "error" }),
    },
  });
  return { service, logs };
}

describe("DropshipRewardsExpiryService", () => {
  it("expires each due wallet at the injected clock, tallies what left, and logs each wallet at INFO with before -> after", async () => {
    const repository = new FakeExpiryRepository();
    repository.due = [{ walletAccountId: 5, vendorId: 10 }, { walletAccountId: 8, vendorId: 12 }];
    repository.outcomes.set(5, {
      walletAccountId: 5, vendorId: 10, rewardsBalanceBeforeCents: 90, rewardsBalanceAfterCents: 40,
      expiredLots: [
        { lotId: 12, cents: 30, ledgerEntryId: 201, expiresAt: new Date("2026-08-26T06:00:00.000Z") },
        { lotId: 11, cents: 20, ledgerEntryId: 202, expiresAt: new Date("2026-09-15T06:00:00.000Z") },
      ],
    });
    repository.outcomes.set(8, {
      walletAccountId: 8, vendorId: 12, rewardsBalanceBeforeCents: 5, rewardsBalanceAfterCents: 0,
      expiredLots: [{ lotId: 40, cents: 5, ledgerEntryId: 203, expiresAt: new Date("2026-09-24T06:00:00.000Z") }],
    });
    const { service, logs } = buildService(repository);

    const result = await service.runExpiry({ workerId: "worker-1", limit: 25 });

    expect(repository.listInputs).toEqual([{ now, limit: 25 }]);
    expect(repository.expireInputs).toEqual([
      { walletAccountId: 5, vendorId: 10, now },
      { walletAccountId: 8, vendorId: 12, now },
    ]);
    expect(result).toEqual({ scannedCount: 2, expiredAccountCount: 2, expiredLotCount: 3, expiredCents: 55, failedCount: 0 });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      level: "info",
      code: "DROPSHIP_WALLET_REWARDS_EXPIRED",
      context: {
        workerId: "worker-1", vendorId: 10, walletAccountId: 5, expiredCents: 50,
        before: { rewardsBalanceCents: 90 }, after: { rewardsBalanceCents: 40 },
        lots: [
          { lotId: 12, cents: 30, ledgerEntryId: 201, expiresAt: "2026-08-26T06:00:00.000Z" },
          { lotId: 11, cents: 20, ledgerEntryId: 202, expiresAt: "2026-09-15T06:00:00.000Z" },
        ],
      },
    });
  });

  it("uses the default batch when none is given, and stays quiet when nothing is due", async () => {
    const repository = new FakeExpiryRepository();
    const { service, logs } = buildService(repository);

    const result = await service.runExpiry({ workerId: "worker-1" });

    expect(repository.listInputs).toEqual([{ now, limit: 100 }]);
    expect(result).toEqual({ scannedCount: 0, expiredAccountCount: 0, expiredLotCount: 0, expiredCents: 0, failedCount: 0 });
    expect(logs).toEqual([]);
  });

  it("counts a wallet whose points were used before the lock as scanned, not expired, without a log line", async () => {
    const repository = new FakeExpiryRepository();
    repository.due = [{ walletAccountId: 5, vendorId: 10 }];
    const { service, logs } = buildService(repository);

    const result = await service.runExpiry({ workerId: "worker-1" });

    expect(result).toEqual({ scannedCount: 1, expiredAccountCount: 0, expiredLotCount: 0, expiredCents: 0, failedCount: 0 });
    expect(logs).toEqual([]);
  });

  it("logs a failed wallet at ERROR with its code and classification and carries on with the next", async () => {
    const repository = new FakeExpiryRepository();
    repository.due = [{ walletAccountId: 5, vendorId: 10 }, { walletAccountId: 8, vendorId: 12 }, { walletAccountId: 9, vendorId: 13 }];
    repository.outcomes.set(5, new DropshipError("DROPSHIP_WALLET_REWARDS_LOTS_INVALID", "A rewards lot changed outside the wallet account lock.", { classification: "fatal", lotId: 12 }));
    repository.outcomes.set(8, new Error("connection terminated unexpectedly"));
    repository.outcomes.set(9, {
      walletAccountId: 9, vendorId: 13, rewardsBalanceBeforeCents: 10, rewardsBalanceAfterCents: 0,
      expiredLots: [{ lotId: 50, cents: 10, ledgerEntryId: 204, expiresAt: new Date("2026-09-20T00:00:00.000Z") }],
    });
    const { service, logs } = buildService(repository);

    const result = await service.runExpiry({ workerId: "worker-1" });

    expect(result).toMatchObject({ scannedCount: 3, expiredAccountCount: 1, expiredCents: 10, failedCount: 2 });
    expect(logs.filter((log) => log.level === "error")).toEqual([
      expect.objectContaining({
        code: "DROPSHIP_WALLET_REWARDS_EXPIRY_FAILED",
        context: expect.objectContaining({ walletAccountId: 5, vendorId: 10, errorCode: "DROPSHIP_WALLET_REWARDS_LOTS_INVALID", classification: "fatal" }),
      }),
      expect.objectContaining({
        code: "DROPSHIP_WALLET_REWARDS_EXPIRY_FAILED",
        context: expect.objectContaining({ walletAccountId: 8, errorCode: null, classification: null, errorMessage: "connection terminated unexpectedly" }),
      }),
    ]);
  });

  it("refuses malformed input before reading anything", async () => {
    const repository = new FakeExpiryRepository();
    const { service } = buildService(repository);

    for (const input of [{}, { workerId: "" }, { workerId: "w", limit: 0 }, { workerId: "w", limit: 1_001 }, { workerId: "w", extra: true }]) {
      await expect(service.runExpiry(input)).rejects.toMatchObject({
        code: "DROPSHIP_WALLET_REWARDS_EXPIRY_INVALID_INPUT",
        context: expect.objectContaining({ classification: "permanent" }),
      });
    }
    expect(repository.listInputs).toEqual([]);
  });
});
