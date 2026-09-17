import { beforeEach, describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipLogEvent, DropshipNotificationSenderInput } from "../../application/dropship-ports";
import type { DropshipAutoReloadResult } from "../../application/dropship-wallet-service";
import {
  DropshipWalletMaintenanceService,
  walletMaintenanceIdempotencyKeyFor,
  walletMaintenanceRunDateFor,
  type DropshipWalletMaintenanceReloader,
  type DropshipWalletMaintenanceRepository,
  type DropshipWalletMaintenanceRunRecord,
  type RecordDropshipWalletMaintenanceOutcomeInput,
} from "../../application/dropship-wallet-maintenance-service";

const firstTick = new Date("2026-05-01T20:00:00.000Z");
const RUN_DATE = "2026-05-01";

describe("walletMaintenanceRunDateFor", () => {
  it("keys a run on the UTC calendar day, right up to midnight", () => {
    expect(walletMaintenanceRunDateFor(new Date("2026-05-01T00:00:00.000Z"))).toBe("2026-05-01");
    expect(walletMaintenanceRunDateFor(new Date("2026-05-01T23:59:59.999Z"))).toBe("2026-05-01");
    expect(walletMaintenanceRunDateFor(new Date("2026-05-02T00:00:00.000Z"))).toBe("2026-05-02");
    expect(walletMaintenanceIdempotencyKeyFor(10, "2026-05-01")).toBe("wallet-maintenance:10:2026-05-01");
  });
});

describe("DropshipWalletMaintenanceService", () => {
  let repository: FakeMaintenanceRepository;
  let reloader: FakeReloader;
  let notificationSender: FakeNotificationSender;
  let logs: Array<DropshipLogEvent & { level: "info" | "warn" | "error" }>;
  let now: Date;
  let service: DropshipWalletMaintenanceService;

  beforeEach(() => {
    repository = new FakeMaintenanceRepository();
    reloader = new FakeReloader();
    notificationSender = new FakeNotificationSender();
    logs = [];
    now = firstTick;
    service = buildService();
  });

  function buildService(maxAttemptsPerDay?: number): DropshipWalletMaintenanceService {
    return new DropshipWalletMaintenanceService({
      repository,
      reloader,
      notificationSender,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push({ ...event, level: "info" }),
        warn: (event) => logs.push({ ...event, level: "warn" }),
        error: (event) => logs.push({ ...event, level: "error" }),
      },
      maxAttemptsPerDay,
    });
  }

  function run(limit?: number) {
    return service.runMaintenance({ workerId: "worker-1", ...(limit ? { limit } : {}) });
  }

  it("tops every active vendor up once per day through the routine reload and records the run", async () => {
    repository.due = [10, 11];
    reloader.respond = async (input) => fundingCreated(input.vendorId, { amountCents: 4000, cardFeeCents: 120, chargedCents: 4120 });

    const result = await run();

    expect(result).toMatchObject({ runDate: RUN_DATE, scannedCount: 2, reloadedCount: 2, notNeededCount: 0, failedCount: 0 });
    expect(reloader.calls).toEqual([
      { vendorId: 10, reason: "minimum_balance", idempotencyKey: "wallet-maintenance:10:2026-05-01" },
      { vendorId: 11, reason: "minimum_balance", idempotencyKey: "wallet-maintenance:11:2026-05-01" },
    ]);
    expect(repository.runs.map((entry) => [entry.vendorId, entry.status, entry.attemptCount, entry.amountCents, entry.chargedCents])).toEqual([
      [10, "reloaded", 1, 4000, 4120],
      [11, "reloaded", 1, 4000, 4120],
    ]);
    expect(repository.runs[0]).toMatchObject({
      cardFeeCents: 120,
      fundingStatus: "settled",
      walletLedgerEntryId: 501,
      providerPaymentIntentId: "pi_maint_10",
      idempotencyKey: "wallet-maintenance:10:2026-05-01",
    });
    expect(logs.filter((entry) => entry.code === "DROPSHIP_WALLET_MAINTENANCE_RELOADED")).toHaveLength(2);
    expect(logs.at(-1)).toMatchObject({ code: "DROPSHIP_WALLET_MAINTENANCE_COMPLETED", context: expect.objectContaining({ reloadedCount: 2 }) });
    expect(notificationSender.sent).toHaveLength(0);
  });

  it("does not charge again on a later tick the same day, and charges again on the next day", async () => {
    repository.due = [10];
    reloader.respond = async (input) => fundingCreated(input.vendorId);
    await run();

    now = new Date("2026-05-01T22:00:00.000Z");
    const sameDay = await run();
    expect(sameDay.scannedCount).toBe(0);
    expect(reloader.calls).toHaveLength(1);

    now = new Date("2026-05-02T00:30:00.000Z");
    const nextDay = await run();
    expect(nextDay).toMatchObject({ runDate: "2026-05-02", reloadedCount: 1 });
    expect(reloader.calls.at(-1)).toMatchObject({ idempotencyKey: "wallet-maintenance:10:2026-05-02" });
  });

  it("replays a run that is already terminal without touching the wallet", async () => {
    // A race: the vendor was listed before another tick finished the day.
    repository.due = [10];
    repository.alwaysDue = true;
    repository.seedRun({ vendorId: 10, runDate: RUN_DATE, status: "declined", attemptCount: 1 });

    const result = await run();

    expect(result).toMatchObject({ scannedCount: 1, replayedCount: 1, declinedCount: 0 });
    expect(reloader.calls).toHaveLength(0);
    expect(repository.outcomes).toHaveLength(0);
  });

  it("records a wallet that already meets its minimum as not needed and tells nobody", async () => {
    repository.due = [10];
    reloader.respond = async (input) => skipped(input.vendorId, "balance_already_sufficient");

    const result = await run();

    expect(result).toMatchObject({ scannedCount: 1, notNeededCount: 1 });
    expect(repository.runs[0]).toMatchObject({ status: "not_needed", outcomeCode: "balance_already_sufficient", amountCents: null });
    expect(notificationSender.sent).toHaveLength(0);
    expect(logs.filter((entry) => entry.level !== "info")).toHaveLength(0);
    // A quiet fleet produces no completion line at all.
    expect(logs).toHaveLength(0);
  });

  it("retries a provider outage on the next tick under the same idempotency key", async () => {
    repository.due = [10];
    reloader.respond = async () => {
      throw new DropshipError("DROPSHIP_STRIPE_UNREACHABLE", "Stripe could not be reached.", { classification: "transient" });
    };

    const first = await run();
    expect(first).toMatchObject({ retryPendingCount: 1 });
    expect(repository.runs[0]).toMatchObject({ status: "retry_pending", attemptCount: 1, outcomeCode: "DROPSHIP_STRIPE_UNREACHABLE" });
    expect(notificationSender.sent).toHaveLength(0);
    expect(logs.at(-2)).toMatchObject({ level: "warn", code: "DROPSHIP_WALLET_MAINTENANCE_RETRY_SCHEDULED" });

    now = new Date("2026-05-01T21:00:00.000Z");
    reloader.respond = async (input) => fundingCreated(input.vendorId);
    const second = await run();
    expect(second).toMatchObject({ scannedCount: 1, reloadedCount: 1 });
    expect(repository.runs[0]).toMatchObject({ status: "reloaded", attemptCount: 2 });
    expect(reloader.calls.map((call) => call.idempotencyKey)).toEqual([
      "wallet-maintenance:10:2026-05-01",
      "wallet-maintenance:10:2026-05-01",
    ]);
  });

  it("gives up for the day once the retry cap is reached, at ERROR, without another charge attempt", async () => {
    service = buildService(2);
    repository.due = [10];
    reloader.respond = async () => {
      throw new DropshipError("DROPSHIP_STRIPE_RATE_LIMITED", "Too many requests.", { classification: "transient" });
    };

    await run();
    now = new Date("2026-05-01T21:00:00.000Z");
    await run();
    expect(repository.runs[0]).toMatchObject({ status: "retry_pending", attemptCount: 2 });

    now = new Date("2026-05-01T22:00:00.000Z");
    const third = await run();
    expect(third).toMatchObject({ failedCount: 1 });
    expect(reloader.calls).toHaveLength(2);
    expect(repository.runs[0]).toMatchObject({ status: "failed", attemptCount: 2, outcomeCode: "retry_exhausted" });
    expect(logs.filter((entry) => entry.level === "error")).toEqual([
      expect.objectContaining({ code: "DROPSHIP_WALLET_MAINTENANCE_RETRY_EXHAUSTED", context: expect.objectContaining({ attemptCount: 2, maxAttemptsPerDay: 2 }) }),
    ]);
    expect(notificationSender.sent).toHaveLength(0);

    now = new Date("2026-05-01T23:00:00.000Z");
    expect((await run()).scannedCount).toBe(0);
  });

  it("treats an unexpected infrastructure error like an outage: retried, capped, vendor not told", async () => {
    repository.due = [10];
    reloader.respond = async () => {
      throw new Error("connection reset");
    };

    const result = await run();

    expect(result).toMatchObject({ retryPendingCount: 1 });
    expect(repository.runs[0]).toMatchObject({ status: "retry_pending", outcomeCode: "DROPSHIP_WALLET_MAINTENANCE_UNEXPECTED_ERROR", outcomeMessage: "connection reset" });
    expect(notificationSender.sent).toHaveLength(0);
  });

  it("ends the day on a decline, tells the vendor once, and stays quiet on replay", async () => {
    repository.due = [10];
    reloader.respond = async () => {
      throw new DropshipError("DROPSHIP_STRIPE_CARD_DECLINED", "Your card was declined.", {
        classification: "permanent",
        stripeCode: "card_declined",
        stripeDeclineCode: "insufficient_funds",
      });
    };

    const result = await run();

    expect(result).toMatchObject({ declinedCount: 1 });
    expect(repository.runs[0]).toMatchObject({ status: "declined", attemptCount: 1, outcomeCode: "DROPSHIP_STRIPE_CARD_DECLINED" });
    expect(logs.filter((entry) => entry.level === "error")).toHaveLength(0);
    expect(logs.find((entry) => entry.code === "DROPSHIP_WALLET_MAINTENANCE_DECLINED")).toMatchObject({
      level: "warn",
      context: expect.objectContaining({ vendorId: 10, stripeDeclineCode: "insufficient_funds" }),
    });
    expect(notificationSender.sent).toHaveLength(1);
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_auto_reload_failed",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship wallet top-up declined",
      idempotencyKey: "wallet-maintenance:10:2026-05-01:declined",
      payload: expect.objectContaining({
        source: "wallet_maintenance",
        runDate: RUN_DATE,
        status: "declined",
        failureCode: "DROPSHIP_STRIPE_CARD_DECLINED",
        stripeDeclineCode: "insufficient_funds",
      }),
    });
    expect(notificationSender.sent[0].message).toContain("declined (insufficient funds)");
    expect(notificationSender.sent[0].message).toContain("add funds by ACH");

    now = new Date("2026-05-01T21:00:00.000Z");
    expect((await run()).scannedCount).toBe(0);
    expect(reloader.calls).toHaveLength(1);
    expect(notificationSender.sent).toHaveLength(1);
  });

  it("flags a vendor-side gap as attention and tells the vendor what to change", async () => {
    repository.due = [10, 11];
    reloader.respond = async (input) => input.vendorId === 10
      ? skipped(10, "amount_exceeds_max_single_reload")
      : skipped(11, "funding_method_not_active", 99);

    const result = await run();

    expect(result).toMatchObject({ attentionCount: 2 });
    expect(repository.runs.map((entry) => [entry.status, entry.outcomeCode, entry.fundingMethodId])).toEqual([
      ["attention", "amount_exceeds_max_single_reload", null],
      ["attention", "funding_method_not_active", 99],
    ]);
    expect(notificationSender.sent.map((notice) => [notice.vendorId, notice.idempotencyKey])).toEqual([
      [10, "wallet-maintenance:10:2026-05-01:attention"],
      [11, "wallet-maintenance:11:2026-05-01:attention"],
    ]);
    expect(notificationSender.sent[0].message).toContain("single-reload limit");
    expect(notificationSender.sent[1].message).toContain("cannot charge your saved funding method");
    expect(logs.filter((entry) => entry.code === "DROPSHIP_WALLET_MAINTENANCE_NEEDS_VENDOR_ATTENTION")).toHaveLength(2);
  });

  it("records our own misconfiguration as failed at ERROR and never blames the vendor", async () => {
    repository.due = [10, 11];
    reloader.respond = async (input) => {
      if (input.vendorId === 10) return skipped(10, "funding_provider_not_configured");
      throw new DropshipError("DROPSHIP_STRIPE_CREDENTIALS_REJECTED", "Stripe rejected the API key.", { classification: "fatal" });
    };

    const result = await run();

    expect(result).toMatchObject({ failedCount: 2 });
    expect(repository.runs.map((entry) => [entry.status, entry.outcomeCode])).toEqual([
      ["failed", "funding_provider_not_configured"],
      ["failed", "DROPSHIP_STRIPE_CREDENTIALS_REJECTED"],
    ]);
    expect(logs.filter((entry) => entry.level === "error").map((entry) => entry.code)).toEqual([
      "DROPSHIP_WALLET_MAINTENANCE_PROVIDER_UNAVAILABLE",
      "DROPSHIP_WALLET_MAINTENANCE_FAILED",
    ]);
    expect(notificationSender.sent).toHaveLength(0);

    // Terminal for the day: no retry on the next tick.
    now = new Date("2026-05-01T21:00:00.000Z");
    expect((await run()).scannedCount).toBe(0);
  });

  it("treats a permanent provider error that is not a bank decline as ours, not the vendor's", async () => {
    repository.due = [10];
    reloader.respond = async () => {
      throw new DropshipError("DROPSHIP_STRIPE_IDEMPOTENCY_CONFLICT", "Idempotency key reused with different parameters.", {
        classification: "permanent",
      });
    };

    const result = await run();

    expect(result).toMatchObject({ failedCount: 1, declinedCount: 0 });
    expect(repository.runs[0]).toMatchObject({ status: "failed", outcomeCode: "DROPSHIP_STRIPE_IDEMPOTENCY_CONFLICT" });
    expect(logs.at(-2)).toMatchObject({ level: "error", code: "DROPSHIP_WALLET_MAINTENANCE_FAILED" });
    expect(notificationSender.sent).toHaveLength(0);
  });

  it("does not retry a structured error it cannot classify", async () => {
    repository.due = [10];
    reloader.respond = async () => {
      throw new DropshipError("DROPSHIP_STRIPE_AUTO_RELOAD_AMOUNT_MISMATCH", "Stripe charged an amount that does not match the auto-reload quote.");
    };

    const result = await run();

    expect(result).toMatchObject({ failedCount: 1 });
    expect(repository.runs[0]).toMatchObject({ status: "failed", outcomeCode: "DROPSHIP_STRIPE_AUTO_RELOAD_AMOUNT_MISMATCH" });
    expect(logs.at(-2)).toMatchObject({ level: "error", code: "DROPSHIP_WALLET_MAINTENANCE_FAILED" });
    expect(notificationSender.sent).toHaveLength(0);
  });

  it("keeps the run recorded when the vendor notification fails", async () => {
    repository.due = [10];
    notificationSender.error = new Error("email unavailable");
    reloader.respond = async () => {
      throw new DropshipError("DROPSHIP_STRIPE_CARD_DECLINED", "Declined.", { classification: "permanent" });
    };

    const result = await run();

    expect(result).toMatchObject({ declinedCount: 1 });
    expect(repository.runs[0].status).toBe("declined");
    expect(logs.find((entry) => entry.code === "DROPSHIP_WALLET_MAINTENANCE_NOTIFICATION_FAILED")).toBeDefined();
  });

  it("respects the batch limit", async () => {
    repository.due = [10, 11, 12];
    reloader.respond = async (input) => fundingCreated(input.vendorId);

    const result = await run(2);

    expect(result.scannedCount).toBe(2);
    expect(reloader.calls.map((call) => call.vendorId)).toEqual([10, 11]);
  });

  it("refuses invalid input and a misconfigured retry cap", async () => {
    await expect(service.runMaintenance({})).rejects.toMatchObject({ code: "DROPSHIP_WALLET_MAINTENANCE_INVALID_INPUT" });
    await expect(service.runMaintenance({ workerId: "w", limit: 0 })).rejects.toMatchObject({ code: "DROPSHIP_WALLET_MAINTENANCE_INVALID_INPUT" });
    expect(() => buildService(0)).toThrowError(expect.objectContaining({ code: "DROPSHIP_WALLET_MAINTENANCE_MISCONFIGURED" }));
  });
});

function fundingCreated(vendorId: number, overrides: Partial<DropshipAutoReloadResult> = {}): DropshipAutoReloadResult {
  return {
    outcome: "funding_created",
    vendorId,
    fundingMethodId: 99,
    amountCents: 5000,
    cardFeeCents: 150,
    chargedCents: 5150,
    currency: "USD",
    providerPaymentIntentId: `pi_maint_${vendorId}`,
    fundingLedgerEntryId: 501,
    fundingStatus: "settled",
    skipReason: null,
    idempotentReplay: false,
    ...overrides,
  };
}

function skipped(vendorId: number, skipReason: string, fundingMethodId: number | null = null): DropshipAutoReloadResult {
  return {
    outcome: "skipped",
    vendorId,
    fundingMethodId,
    amountCents: 0,
    cardFeeCents: 0,
    chargedCents: 0,
    currency: "USD",
    providerPaymentIntentId: null,
    fundingLedgerEntryId: null,
    fundingStatus: null,
    skipReason,
    idempotentReplay: false,
  };
}

class FakeReloader implements DropshipWalletMaintenanceReloader {
  calls: Array<{ vendorId: number; reason: "minimum_balance"; idempotencyKey: string }> = [];
  respond: (input: { vendorId: number; reason: "minimum_balance"; idempotencyKey: string }) => Promise<DropshipAutoReloadResult> =
    async (input) => fundingCreated(input.vendorId);

  async handleAutoReload(input: { vendorId: number; reason: "minimum_balance"; idempotencyKey: string }): Promise<DropshipAutoReloadResult> {
    this.calls.push({ ...input });
    return this.respond(input);
  }
}

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];
  error: Error | null = null;

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
    if (this.error) throw this.error;
  }
}

class FakeMaintenanceRepository implements DropshipWalletMaintenanceRepository {
  /** Vendor ids that are active with an active wallet. */
  due: number[] = [];
  /** When true, list every due vendor even if the day's run is terminal (simulates a race). */
  alwaysDue = false;
  runs: DropshipWalletMaintenanceRunRecord[] = [];
  outcomes: RecordDropshipWalletMaintenanceOutcomeInput[] = [];
  private nextRunId = 1;

  seedRun(input: Pick<DropshipWalletMaintenanceRunRecord, "vendorId" | "runDate" | "status" | "attemptCount">): void {
    this.runs.push({
      ...emptyRun(this.nextRunId++, input.vendorId, input.runDate, firstTick),
      status: input.status,
      attemptCount: input.attemptCount,
    });
  }

  async listVendorsDue(input: { runDate: string; limit: number }): Promise<Array<{ vendorId: number }>> {
    return this.due
      .filter((vendorId) => {
        if (this.alwaysDue) return true;
        const run = this.runs.find((entry) => entry.vendorId === vendorId && entry.runDate === input.runDate);
        return !run || run.status === "pending" || run.status === "retry_pending";
      })
      .slice(0, input.limit)
      .map((vendorId) => ({ vendorId }));
  }

  async claimRun(input: { vendorId: number; runDate: string; idempotencyKey: string; now: Date }): Promise<{ run: DropshipWalletMaintenanceRunRecord; created: boolean }> {
    const existing = this.runs.find((entry) => entry.vendorId === input.vendorId && entry.runDate === input.runDate);
    if (existing) return { run: existing, created: false };
    const run = { ...emptyRun(this.nextRunId++, input.vendorId, input.runDate, input.now), idempotencyKey: input.idempotencyKey };
    this.runs.push(run);
    return { run, created: true };
  }

  async markAttemptStarted(input: { runId: number; vendorId: number; now: Date }): Promise<DropshipWalletMaintenanceRunRecord> {
    const run = this.requireRun(input.runId);
    return this.replace({ ...run, attemptCount: run.attemptCount + 1, lastAttemptAt: input.now, updatedAt: input.now });
  }

  async recordOutcome(input: RecordDropshipWalletMaintenanceOutcomeInput): Promise<DropshipWalletMaintenanceRunRecord> {
    this.outcomes.push(input);
    const run = this.requireRun(input.runId);
    return this.replace({
      ...run,
      status: input.status,
      amountCents: input.amountCents,
      cardFeeCents: input.cardFeeCents,
      chargedCents: input.chargedCents,
      currency: input.currency ?? run.currency,
      fundingMethodId: input.fundingMethodId,
      fundingStatus: input.fundingStatus,
      walletLedgerEntryId: input.walletLedgerEntryId,
      providerPaymentIntentId: input.providerPaymentIntentId,
      outcomeCode: input.outcomeCode,
      outcomeMessage: input.outcomeMessage,
      updatedAt: input.now,
    });
  }

  private requireRun(runId: number): DropshipWalletMaintenanceRunRecord {
    const run = this.runs.find((entry) => entry.runId === runId);
    if (!run) throw new Error(`run ${runId} missing`);
    return run;
  }

  private replace(run: DropshipWalletMaintenanceRunRecord): DropshipWalletMaintenanceRunRecord {
    this.runs = this.runs.map((entry) => (entry.runId === run.runId ? run : entry));
    return run;
  }
}

function emptyRun(runId: number, vendorId: number, runDate: string, now: Date): DropshipWalletMaintenanceRunRecord {
  return {
    runId,
    vendorId,
    runDate,
    status: "pending",
    attemptCount: 0,
    amountCents: null,
    cardFeeCents: null,
    chargedCents: null,
    currency: "USD",
    fundingMethodId: null,
    fundingStatus: null,
    walletLedgerEntryId: null,
    providerPaymentIntentId: null,
    outcomeCode: null,
    outcomeMessage: null,
    lastAttemptAt: null,
    idempotencyKey: walletMaintenanceIdempotencyKeyFor(vendorId, runDate),
    createdAt: now,
    updatedAt: now,
  };
}
