import { describe, expect, it } from "vitest";
import {
  DropshipNoInspectionReviewService,
  type DropshipNoInspectionReviewRecord,
  type DropshipNoInspectionReviewRepository,
  type DropshipNotificationSenderInput,
} from "../../application";
import { DropshipError } from "../../domain/errors";

const now = new Date("2026-08-10T12:00:00.000Z");

const reviewRma: DropshipNoInspectionReviewRecord = {
  rmaId: 42,
  rmaNumber: "RMA-42",
  vendorId: 10,
  status: "no_inspection_review",
  noInspectionEvidence: {
    version: 1,
    trigger: "delivery_timeout",
    trackingNumber: "1Z999",
    carrierStatus: null,
    trackingHistory: null,
    marketplaceCaseRef: "ebay-case-7",
    expectedDeliveryAt: "2026-07-28T00:00:00.000Z",
    noInspectionTimeoutDays: 10,
    detectedAt: "2026-08-09T12:00:00.000Z",
    workerId: "watcher-1",
  },
  policyVersionId: 7,
};

describe("DropshipNoInspectionReviewService", () => {
  it("approve credits the vendor from the pool and records the pool payout", async () => {
    const repository = new FakeReviewRepository({ rma: reviewRma });
    const notificationSender = new FakeNotificationSender();
    const service = makeService({ repository, notificationSender });

    const result = await service.review({
      rmaId: 42,
      decision: "approve",
      idempotencyKey: "review-key-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.decision).toBe("approve");
    expect(result.status).toBe("credited");
    // Credit basis: wholesale 2×1500 + shipping 899 = 3899.
    expect(result.creditCents).toBe(3899);
    expect(result.walletLedgerEntryId).toBe(9001);
    expect(result.poolLedgerEntryId).toBe(8001);
    expect(result.idempotentReplay).toBe(false);
    expect(repository.approveCalls).toHaveLength(1);
    expect(repository.approveCalls[0]).toMatchObject({
      rmaId: 42,
      vendorId: 10,
      creditCents: 3899,
      currency: "USD",
      policyVersionId: 7,
    });
    // Vendor notified of the pool credit.
    expect(notificationSender.sent).toHaveLength(1);
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_return_credit_posted",
      payload: { rmaId: 42, creditCents: 3899, source: "insurance_pool" },
    });
  });

  it("double-approve replays: one credit, one pool payout", async () => {
    const repository = new FakeReviewRepository({ rma: reviewRma });
    const service = makeService({ repository });

    const first = await service.review({
      rmaId: 42,
      decision: "approve",
      idempotencyKey: "review-key-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
    // Second approve: the RMA is now credited, so the service-layer status
    // guard rejects — the one-time credit is enforced at two layers (service
    // status guard + repository credit idempotency key).
    await expect(service.review({
      rmaId: 42,
      decision: "approve",
      idempotencyKey: "review-key-2",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toMatchObject({ code: "DROPSHIP_RMA_NOT_IN_NO_INSPECTION_REVIEW" });

    expect(first.idempotentReplay).toBe(false);
    expect(repository.approveCalls).toHaveLength(1);

    // Direct repository-level replay (same RMA, credit key already exists)
    // returns the existing ids without a second credit.
    const replay = await repository.approveReview({
      rmaId: 42,
      vendorId: 10,
      creditCents: 3899,
      currency: "USD",
      reason: null,
      policyVersionId: 7,
      idempotencyKey: "review-key-3",
      requestHash: "hash",
      actor: { actorType: "admin", actorId: "admin-1" },
      now,
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.walletLedgerEntryId).toBe(9001);
    expect(repository.creditInsertCount).toBe(1);
  });

  it("deny closes the RMA with a reason and posts no credit", async () => {
    const repository = new FakeReviewRepository({ rma: reviewRma });
    const notificationSender = new FakeNotificationSender();
    const service = makeService({ repository, notificationSender });

    const result = await service.review({
      rmaId: 42,
      decision: "deny",
      reason: "Tracking shows delivered to a different address; not lost.",
      idempotencyKey: "review-key-deny",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.decision).toBe("deny");
    expect(result.status).toBe("closed");
    expect(result.creditCents).toBe(0);
    expect(result.walletLedgerEntryId).toBeNull();
    expect(repository.denyCalls).toHaveLength(1);
    expect(repository.denyCalls[0]).toMatchObject({
      rmaId: 42,
      reason: "Tracking shows delivered to a different address; not lost.",
    });
    expect(repository.approveCalls).toHaveLength(0);
    expect(notificationSender.sent).toHaveLength(0);
  });

  it("deny requires a reason", async () => {
    const repository = new FakeReviewRepository({ rma: reviewRma });
    const service = makeService({ repository });

    // Whitespace-only reason fails input validation.
    await expect(service.review({
      rmaId: 42,
      decision: "deny",
      reason: "  ",
      idempotencyKey: "review-key-deny",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toMatchObject({ code: "DROPSHIP_NO_INSPECTION_REVIEW_INVALID_INPUT" });

    // Missing reason hits the service-level guard.
    await expect(service.review({
      rmaId: 42,
      decision: "deny",
      reason: null,
      idempotencyKey: "review-key-deny-2",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toMatchObject({ code: "DROPSHIP_NO_INSPECTION_REASON_REQUIRED" });
    expect(repository.denyCalls).toHaveLength(0);
  });

  it("rejects review of an RMA that is not in no_inspection_review", async () => {
    const repository = new FakeReviewRepository({
      rma: { ...reviewRma, status: "in_transit" },
    });
    const service = makeService({ repository });

    await expect(service.review({
      rmaId: 42,
      decision: "approve",
      idempotencyKey: "review-key-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toMatchObject({ code: "DROPSHIP_RMA_NOT_IN_NO_INSPECTION_REVIEW" });
    expect(repository.approveCalls).toHaveLength(0);
  });

  it("approve fails closed when the credit basis is missing", async () => {
    const repository = new FakeReviewRepository({ rma: reviewRma, creditBasis: null });
    const service = makeService({ repository });

    await expect(service.review({
      rmaId: 42,
      decision: "approve",
      idempotencyKey: "review-key-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toMatchObject({ code: "DROPSHIP_NO_INSPECTION_CREDIT_BASIS_MISSING" });
    expect(repository.approveCalls).toHaveLength(0);
  });

  it("claim replenishment credits the pool only — never the vendor wallet", async () => {
    const repository = new FakeReviewRepository({ rma: reviewRma });
    const service = makeService({ repository });

    const result = await service.recordClaimReplenishment({
      carrierClaimId: 555,
      amountCents: 3899,
      currency: "USD",
      providerPayoutReference: "carrier-payout-abc",
      idempotencyKey: "replenish-key-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.idempotentReplay).toBe(false);
    expect(result.poolLedgerEntryId).toBe(8101);
    expect(repository.replenishmentCalls).toHaveLength(1);
    expect(repository.replenishmentCalls[0]).toMatchObject({
      carrierClaimId: 555,
      amountCents: 3899,
      providerPayoutReference: "carrier-payout-abc",
    });
    // No vendor wallet movement on the replenishment path.
    expect(repository.approveCalls).toHaveLength(0);
    expect(repository.creditInsertCount).toBe(0);
  });

  it("claim replenishment is idempotent per claim (no double-count into the pool)", async () => {
    const repository = new FakeReviewRepository({ rma: reviewRma });
    const service = makeService({ repository });

    const first = await service.recordClaimReplenishment({
      carrierClaimId: 555,
      amountCents: 3899,
      currency: "USD",
      providerPayoutReference: "carrier-payout-abc",
      idempotencyKey: "replenish-key-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
    const second = await service.recordClaimReplenishment({
      carrierClaimId: 555,
      amountCents: 3899,
      currency: "USD",
      providerPayoutReference: "carrier-payout-abc",
      idempotencyKey: "replenish-key-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.poolLedgerEntryId).toBe(first.poolLedgerEntryId);
    expect(repository.replenishmentInsertCount).toBe(1);
  });
});

function makeService(input: {
  repository: FakeReviewRepository;
  notificationSender?: FakeNotificationSender;
}): DropshipNoInspectionReviewService {
  return new DropshipNoInspectionReviewService({
    repository: input.repository,
    notificationSender: input.notificationSender,
    clock: { now: () => now },
    logger: noopLogger,
  });
}

class FakeReviewRepository implements DropshipNoInspectionReviewRepository {
  approveCalls: Parameters<DropshipNoInspectionReviewRepository["approveReview"]>[0][] = [];
  denyCalls: Parameters<DropshipNoInspectionReviewRepository["denyReview"]>[0][] = [];
  replenishmentCalls: Parameters<DropshipNoInspectionReviewRepository["recordClaimReplenishment"]>[0][] = [];
  creditInsertCount = 0;
  replenishmentInsertCount = 0;
  private rmaStatus: string;
  private creditedWalletEntryId: number | null = null;
  private poolPayoutEntryId: number | null = null;
  private replenishmentByKey = new Map<string, number>();
  private nextPoolId = 8101;

  constructor(
    private readonly options: {
      rma: DropshipNoInspectionReviewRecord;
      creditBasis?: {
        wholesaleProductCents: number;
        allocatedShippingCents: number;
        currency: string;
      } | null;
    },
  ) {
    this.rmaStatus = options.rma.status;
  }

  async getRmaForReview(): Promise<DropshipNoInspectionReviewRecord | null> {
    return { ...this.options.rma, status: this.rmaStatus };
  }

  async getPoolCreditBasis() {
    if (this.options.creditBasis !== undefined) return this.options.creditBasis;
    return {
      wholesaleProductCents: 3000, // 2 units × 1500
      allocatedShippingCents: 899,
      currency: "USD",
    };
  }

  async approveReview(
    input: Parameters<DropshipNoInspectionReviewRepository["approveReview"]>[0],
  ) {
    // Repository-level one-time enforcement: the deterministic credit key.
    if (this.creditedWalletEntryId !== null) {
      return {
        status: this.rmaStatus,
        walletLedgerEntryId: this.creditedWalletEntryId,
        poolLedgerEntryId: this.poolPayoutEntryId,
        idempotentReplay: true,
      };
    }
    if (this.rmaStatus !== "no_inspection_review") {
      throw new DropshipError(
        "DROPSHIP_RMA_NOT_IN_NO_INSPECTION_REVIEW",
        "Dropship RMA is not queued for no-inspection review.",
        { rmaId: input.rmaId, status: this.rmaStatus },
      );
    }
    this.approveCalls.push(input);
    this.creditInsertCount += 1;
    this.creditedWalletEntryId = 9001;
    this.poolPayoutEntryId = 8001;
    this.rmaStatus = "credited";
    return {
      status: "credited",
      walletLedgerEntryId: 9001,
      poolLedgerEntryId: 8001,
      idempotentReplay: false,
    };
  }

  async denyReview(
    input: Parameters<DropshipNoInspectionReviewRepository["denyReview"]>[0],
  ) {
    if (this.rmaStatus === "closed") {
      return { status: "closed", idempotentReplay: true };
    }
    this.denyCalls.push(input);
    this.rmaStatus = "closed";
    return { status: "closed", idempotentReplay: false };
  }

  async recordClaimReplenishment(
    input: Parameters<DropshipNoInspectionReviewRepository["recordClaimReplenishment"]>[0],
  ) {
    this.replenishmentCalls.push(input);
    const existing = this.replenishmentByKey.get(input.idempotencyKey);
    if (existing !== undefined) {
      return { poolLedgerEntryId: existing, idempotentReplay: true };
    }
    this.replenishmentInsertCount += 1;
    const id = this.nextPoolId++;
    this.replenishmentByKey.set(input.idempotencyKey, id);
    return { poolLedgerEntryId: id, idempotentReplay: false };
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
