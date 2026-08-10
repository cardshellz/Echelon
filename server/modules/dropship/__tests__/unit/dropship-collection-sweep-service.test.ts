import { describe, expect, it } from "vitest";
import {
  DropshipCollectionSweepService,
  periodStartFor,
  type DropshipCollectionAttemptRecord,
  type DropshipCollectionAttemptStatus,
  type DropshipCollectionConfigRecord,
  type DropshipCollectionFundingCharge,
  type DropshipCollectionFundingProvider,
  type DropshipCollectionSweepRepository,
  type DropshipLogEvent,
  type DropshipNotificationSenderInput,
} from "../../application";
import { DropshipError } from "../../domain/errors";

const now = new Date("2026-08-10T12:00:00.000Z");

const config: DropshipCollectionConfigRecord = {
  configId: 1,
  version: 1,
  graceDays: 7,
  sweepCadenceDays: 7,
  maxConsecutiveFailures: 3,
  effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
  effectiveTo: null,
};

describe("periodStartFor", () => {
  it("maps any instant in the same cadence bucket to the same period start", () => {
    const a = periodStartFor(new Date("2026-08-10T12:00:00.000Z"), 7);
    const b = periodStartFor(new Date("2026-08-11T03:00:00.000Z"), 7);
    expect(a.getTime()).toBe(b.getTime());
    // Buckets align to epoch multiples of the cadence.
    expect(a.getTime() % (7 * 86_400_000)).toBe(0);
  });

  it("rolls to the next bucket after the cadence elapses", () => {
    const a = periodStartFor(new Date("2026-08-10T12:00:00.000Z"), 7);
    const later = periodStartFor(new Date(a.getTime() + 7 * 86_400_000 + 1), 7);
    expect(later.getTime()).toBe(a.getTime() + 7 * 86_400_000);
  });
});

describe("DropshipCollectionSweepService", () => {
  it("charges a past-grace negative balance and records the wallet top-up", async () => {
    const repository = new FakeCollectionSweepRepository({
      vendors: [makeVendor({ availableBalanceCents: -4200 })],
    });
    const fundingProvider = new FakeFundingProvider();
    const service = makeService({ repository, fundingProvider });

    const result = await service.runSweep({ workerId: "worker-1", limit: 10 });

    expect(result.scannedCount).toBe(1);
    expect(result.chargedCount).toBe(1);
    expect(result.attempts[0]).toMatchObject({
      vendorId: 10,
      outcome: "charged",
      amountCents: 4200,
    });
    expect(fundingProvider.charges).toHaveLength(1);
    expect(fundingProvider.charges[0]).toMatchObject({
      vendorId: 10,
      fundingMethodId: 99,
      amountCents: 4200,
      providerCustomerId: "cus_1",
      providerPaymentMethodId: "pm_1",
    });
    expect(repository.successCalls).toHaveLength(1);
    expect(repository.successCalls[0]).toMatchObject({
      vendorId: 10,
      amountCents: 4200,
      providerPaymentIntentId: "pi_coll_1",
    });
    // Stripe charge idempotency key is deterministic per attempt.
    expect(fundingProvider.charges[0].idempotencyKey).toMatch(/^dropship-collection-charge:/);
  });

  it("is idempotent per (vendor, period): a rerun inside the same period does not double-charge", async () => {
    const repository = new FakeCollectionSweepRepository({
      vendors: [makeVendor({ availableBalanceCents: -4200 })],
    });
    const fundingProvider = new FakeFundingProvider();
    const service = makeService({ repository, fundingProvider });

    const first = await service.runSweep({ workerId: "worker-1", limit: 10 });
    expect(first.chargedCount).toBe(1);

    // Second sweep in the same period: the attempt row now exists in a
    // terminal state, so the vendor is not charged again even though the
    // wallet is still negative.
    const second = await service.runSweep({ workerId: "worker-1", limit: 10 });
    expect(second.chargedCount).toBe(0);
    expect(fundingProvider.charges).toHaveLength(1);
    expect(repository.successCalls).toHaveLength(1);
  });

  it("counts consecutive failures and escalates to human review after the configured threshold", async () => {
    const repository = new FakeCollectionSweepRepository({
      vendors: [makeVendor({ availableBalanceCents: -1000 })],
    });
    const fundingProvider = new FakeFundingProvider(
      new DropshipError("DROPSHIP_STRIPE_COLLECTION_CHARGE_FAILED", "card_declined"),
    );
    const notificationSender = new FakeNotificationSender();
    const service = makeService({ repository, fundingProvider, notificationSender });

    // Failure 1 and 2: plain failures, no escalation.
    // NOTE: each run is a new period claim only when the period changes; to
    // simulate consecutive periods we advance the injected clock by cadence.
    let clockNow = now;
    const advancingService = new DropshipCollectionSweepService({
      repository,
      fundingProvider,
      notificationSender,
      clock: { now: () => clockNow },
      logger: noopLogger,
    });

    const r1 = await advancingService.runSweep({ workerId: "w", limit: 10 });
    expect(r1.failedCount).toBe(1);
    expect(r1.escalatedCount).toBe(0);

    clockNow = new Date(now.getTime() + 7 * 86_400_000);
    const r2 = await advancingService.runSweep({ workerId: "w", limit: 10 });
    expect(r2.failedCount).toBe(1);
    expect(r2.escalatedCount).toBe(0);

    clockNow = new Date(now.getTime() + 14 * 86_400_000);
    const r3 = await advancingService.runSweep({ workerId: "w", limit: 10 });
    expect(r3.escalatedCount).toBe(1);
    expect(repository.attemptsFor(10)?.consecutiveFailures).toBe(3);
    expect(repository.attemptsFor(10)?.status).toBe("escalated");
    // Human account-review notification fired exactly once, critical.
    const reviewNotifications = notificationSender.sent.filter(
      (entry) => entry.eventType === "dropship_collection_account_review",
    );
    expect(reviewNotifications).toHaveLength(1);
    expect(reviewNotifications[0]).toMatchObject({
      vendorId: 10,
      critical: true,
      payload: { reviewRequired: true, consecutiveFailures: 3 },
    });
  });

  it("skips vendors within the grace window (repository returns none)", async () => {
    const repository = new FakeCollectionSweepRepository({ vendors: [] });
    const fundingProvider = new FakeFundingProvider();
    const service = makeService({ repository, fundingProvider });

    const result = await service.runSweep({ workerId: "worker-1", limit: 10 });

    expect(result.scannedCount).toBe(0);
    expect(fundingProvider.charges).toHaveLength(0);
    expect(repository.listInput).toMatchObject({ now, graceDays: 7, limit: 10 });
  });

  it("records a failure (not a crash) when the vendor has no funding method", async () => {
    const repository = new FakeCollectionSweepRepository({
      vendors: [makeVendor({ availableBalanceCents: -500 })],
      fundingMethod: null,
    });
    const fundingProvider = new FakeFundingProvider();
    const service = makeService({ repository, fundingProvider });

    const result = await service.runSweep({ workerId: "worker-1", limit: 10 });

    expect(result.chargedCount).toBe(0);
    expect(fundingProvider.charges).toHaveLength(0);
    expect(repository.failureCalls).toHaveLength(1);
    expect(repository.failureCalls[0].failureCode).toBe("no_funding_method");
  });

  it("does nothing when no active collection config exists", async () => {
    const repository = new FakeCollectionSweepRepository({ vendors: [makeVendor({})], config: null });
    const fundingProvider = new FakeFundingProvider();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipCollectionSweepService({
      repository,
      fundingProvider,
      clock: { now: () => now },
      logger: { info: (e) => logs.push(e), warn: (e) => logs.push(e), error: (e) => logs.push(e) },
    });

    const result = await service.runSweep({ workerId: "worker-1", limit: 10 });

    expect(result.scannedCount).toBe(0);
    expect(fundingProvider.charges).toHaveLength(0);
    expect(logs.some((event) => event.code === "DROPSHIP_COLLECTION_CONFIG_MISSING")).toBe(true);
  });

  it("rejects invalid input", async () => {
    const repository = new FakeCollectionSweepRepository({ vendors: [] });
    const service = makeService({ repository, fundingProvider: new FakeFundingProvider() });
    await expect(service.runSweep({ workerId: "", limit: 1 })).rejects.toMatchObject({
      code: "DROPSHIP_COLLECTION_SWEEP_INVALID_INPUT",
    });
  });
});

function makeService(input: {
  repository: FakeCollectionSweepRepository;
  fundingProvider: FakeFundingProvider;
  notificationSender?: FakeNotificationSender;
}): DropshipCollectionSweepService {
  return new DropshipCollectionSweepService({
    repository: input.repository,
    fundingProvider: input.fundingProvider,
    notificationSender: input.notificationSender,
    clock: { now: () => now },
    logger: noopLogger,
  });
}

function makeVendor(patch: Partial<{
  vendorId: number;
  walletAccountId: number;
  availableBalanceCents: number;
  currency: string;
  balanceUpdatedAt: Date;
}> = {}) {
  return {
    vendorId: patch.vendorId ?? 10,
    walletAccountId: patch.walletAccountId ?? 55,
    availableBalanceCents: patch.availableBalanceCents ?? -1000,
    currency: patch.currency ?? "USD",
    balanceUpdatedAt: patch.balanceUpdatedAt ?? new Date("2026-08-01T00:00:00.000Z"),
  };
}

class FakeFundingProvider implements DropshipCollectionFundingProvider {
  charges: Parameters<DropshipCollectionFundingProvider["createStripeCollectionCharge"]>[0][] = [];

  constructor(private readonly error: Error | null = null) {}

  async createStripeCollectionCharge(
    input: Parameters<DropshipCollectionFundingProvider["createStripeCollectionCharge"]>[0],
  ): Promise<DropshipCollectionFundingCharge> {
    this.charges.push(input);
    if (this.error) throw this.error;
    return {
      providerPaymentIntentId: "pi_coll_1",
      status: "settled",
      amountCents: input.amountCents,
      currency: input.currency,
      externalTransactionId: "ch_1",
    };
  }
}

class FakeCollectionSweepRepository implements DropshipCollectionSweepRepository {
  listInput: { now: Date; graceDays: number; limit: number } | null = null;
  successCalls: Parameters<DropshipCollectionSweepRepository["recordChargeSuccess"]>[0][] = [];
  failureCalls: Parameters<DropshipCollectionSweepRepository["recordChargeFailure"]>[0][] = [];
  private attempts = new Map<number, DropshipCollectionAttemptRecord>();
  private nextAttemptId = 1;

  constructor(
    options: {
      vendors: ReturnType<typeof makeVendor>[];
      fundingMethod?: {
        fundingMethodId: number;
        rail: string;
        status: string;
        providerCustomerId: string | null;
        providerPaymentMethodId: string | null;
      } | null;
      config?: DropshipCollectionConfigRecord | null;
    },
  ) {
    this.vendors = options.vendors;
    this.fundingMethod = options.fundingMethod === undefined
      ? {
        fundingMethodId: 99,
        rail: "stripe_card",
        status: "active",
        providerCustomerId: "cus_1",
        providerPaymentMethodId: "pm_1",
      }
      : options.fundingMethod;
    this.activeConfig = options.config === undefined ? config : options.config;
  }

  private readonly vendors: ReturnType<typeof makeVendor>[];
  private readonly fundingMethod: {
    fundingMethodId: number;
    rail: string;
    status: string;
    providerCustomerId: string | null;
    providerPaymentMethodId: string | null;
  } | null;
  private readonly activeConfig: DropshipCollectionConfigRecord | null;

  attemptsFor(vendorId: number): DropshipCollectionAttemptRecord | undefined {
    return this.attempts.get(vendorId);
  }

  async getActiveConfig(): Promise<DropshipCollectionConfigRecord | null> {
    return this.activeConfig;
  }

  async listCollectibleVendors(input: { now: Date; graceDays: number; limit: number }) {
    this.listInput = input;
    return this.vendors;
  }

  async claimAttempt(input: {
    vendorId: number;
    periodStart: Date;
    periodEnd: Date;
    amountCents: number;
    currency: string;
    fundingMethodId: number | null;
    configVersionId: number;
    idempotencyKey: string;
    now: Date;
  }): Promise<{ attempt: DropshipCollectionAttemptRecord; created: boolean }> {
    const existing = this.attempts.get(input.vendorId);
    if (existing && existing.periodStart.getTime() === input.periodStart.getTime()) {
      return { attempt: existing, created: false };
    }
    const attempt: DropshipCollectionAttemptRecord = {
      attemptId: this.nextAttemptId++,
      vendorId: input.vendorId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      amountCents: input.amountCents,
      currency: input.currency,
      fundingMethodId: input.fundingMethodId,
      configVersionId: input.configVersionId,
      status: "pending",
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      lastAttemptAt: null,
      lastFailureCode: null,
      lastFailureMessage: null,
      providerPaymentIntentId: null,
      walletLedgerEntryId: null,
      escalatedAt: null,
    };
    this.attempts.set(input.vendorId, attempt);
    return { attempt, created: true };
  }

  async getDefaultChargeableFundingMethod() {
    return this.fundingMethod;
  }

  async recordChargeSuccess(
    input: Parameters<DropshipCollectionSweepRepository["recordChargeSuccess"]>[0],
  ): Promise<{ walletLedgerEntryId: number }> {
    this.successCalls.push(input);
    const attempt = [...this.attempts.values()].find((entry) => entry.attemptId === input.attemptId);
    if (attempt) {
      attempt.status = "succeeded";
      attempt.consecutiveFailures = 0;
      attempt.walletLedgerEntryId = 777;
    }
    return { walletLedgerEntryId: 777 };
  }

  async recordChargeFailure(
    input: Parameters<DropshipCollectionSweepRepository["recordChargeFailure"]>[0],
  ): Promise<{ consecutiveFailures: number; escalated: boolean }> {
    this.failureCalls.push(input);
    const attempt = [...this.attempts.values()].find((entry) => entry.attemptId === input.attemptId);
    const next = (attempt?.consecutiveFailures ?? 0) + 1;
    if (attempt) {
      attempt.consecutiveFailures = next;
      attempt.status = input.escalate ? "escalated" : "failed";
      if (input.escalate) attempt.escalatedAt = input.now;
    }
    return { consecutiveFailures: next, escalated: input.escalate };
  }

  async carryForwardEscalation(input: {
    attemptId: number;
    now: Date;
  }): Promise<{ consecutiveFailures: number }> {
    const attempt = [...this.attempts.values()].find((entry) => entry.attemptId === input.attemptId);
    if (attempt) {
      attempt.status = "escalated";
      attempt.escalatedAt = attempt.escalatedAt ?? input.now;
      return { consecutiveFailures: attempt.consecutiveFailures };
    }
    return { consecutiveFailures: 0 };
  }
}

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
  }
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
