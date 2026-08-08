import { describe, expect, it } from "vitest";
import {
  DropshipNoInspectionWatcherService,
  isLostCarrierStatus,
  type DropshipNoInspectionCandidate,
  type DropshipNoInspectionEvidencePack,
  type DropshipNoInspectionWatcherRepository,
  type DropshipNotificationSenderInput,
  type DropshipReturnTrackingProvider,
  type DropshipReturnTrackingSnapshot,
} from "../../application";

const now = new Date("2026-08-10T12:00:00.000Z");

describe("isLostCarrierStatus", () => {
  it("treats known lost statuses case-insensitively", () => {
    expect(isLostCarrierStatus("lost")).toBe(true);
    expect(isLostCarrierStatus("LOST")).toBe(true);
    expect(isLostCarrierStatus(" Missing ")).toBe(true);
    expect(isLostCarrierStatus("unrecoverable")).toBe(true);
    expect(isLostCarrierStatus("in_transit")).toBe(false);
    expect(isLostCarrierStatus("delivered")).toBe(false);
  });
});

describe("DropshipNoInspectionWatcherService", () => {
  it("queues an RMA when the carrier reports a lost status, with a full evidence pack", async () => {
    const candidate = makeCandidate({
      returnTrackingNumber: "1Z999",
      returnExpectedDeliveryAt: null,
    });
    const repository = new FakeWatcherRepository([candidate]);
    const trackingProvider = new FakeTrackingProvider({
      trackingNumber: "1Z999",
      carrierStatus: "Lost",
      deliveredAt: null,
      events: [
        { status: "label_created", occurredAt: "2026-08-01T10:00:00.000Z", description: "Label created" },
        { status: "lost", occurredAt: "2026-08-09T10:00:00.000Z", description: "Package declared lost" },
      ],
    });
    const notificationSender = new FakeNotificationSender();
    const service = makeService({ repository, trackingProvider, notificationSender });

    const result = await service.runWatcher({ workerId: "watcher-1", limit: 10 });

    expect(result.scannedCount).toBe(1);
    expect(result.queuedCount).toBe(1);
    expect(result.queued[0]).toEqual({ rmaId: 42, trigger: "carrier_lost_status" });
    expect(repository.queued).toHaveLength(1);
    const evidence = repository.queued[0].evidence;
    expect(evidence).toMatchObject({
      version: 1,
      trigger: "carrier_lost_status",
      trackingNumber: "1Z999",
      carrierStatus: "Lost",
      marketplaceCaseRef: "ebay-case-7",
      noInspectionTimeoutDays: 10,
      detectedAt: now.toISOString(),
    });
    expect(evidence.trackingHistory).toHaveLength(2);
    expect(evidence.trackingHistory?.[1].status).toBe("lost");
    // Idempotency key is deterministic per RMA + trigger.
    expect(repository.queued[0].idempotencyKey).toBe("dropship-no-inspection:42:carrier_lost_status");
    // Vendor notification fired.
    expect(notificationSender.sent).toHaveLength(1);
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_rma_no_inspection_review",
      payload: { rmaId: 42, trigger: "carrier_lost_status" },
    });
  });

  it("queues an RMA when expected delivery + timeout passes with no scan (timeout path)", async () => {
    const candidate = makeCandidate({
      returnTrackingNumber: null,
      returnExpectedDeliveryAt: new Date("2026-07-30T00:00:00.000Z"), // 11 days before now, timeout 10
      noInspectionTimeoutDays: 10,
    });
    const repository = new FakeWatcherRepository([candidate]);
    const service = makeService({ repository, trackingProvider: new FakeTrackingProvider(null) });

    const result = await service.runWatcher({ workerId: "watcher-1", limit: 10 });

    expect(result.queuedCount).toBe(1);
    expect(result.queued[0]).toEqual({ rmaId: 42, trigger: "delivery_timeout" });
    const evidence = repository.queued[0].evidence;
    expect(evidence).toMatchObject({
      trigger: "delivery_timeout",
      expectedDeliveryAt: "2026-07-30T00:00:00.000Z",
      noInspectionTimeoutDays: 10,
      carrierStatus: null,
      trackingHistory: null,
    });
  });

  it("honors the policy-version timeout knob over the default", async () => {
    // Expected delivery 6 days ago; default 10 would not fire, knob 5 does.
    const candidate = makeCandidate({
      returnTrackingNumber: null,
      returnExpectedDeliveryAt: new Date("2026-08-04T00:00:00.000Z"),
      noInspectionTimeoutDays: 5,
    });
    const repository = new FakeWatcherRepository([candidate]);
    const service = makeService({ repository, trackingProvider: new FakeTrackingProvider(null) });

    const result = await service.runWatcher({ workerId: "watcher-1", limit: 10 });
    expect(result.queuedCount).toBe(1);
    expect(repository.queued[0].evidence.noInspectionTimeoutDays).toBe(5);
  });

  it("skips an RMA inside the timeout window", async () => {
    const candidate = makeCandidate({
      returnTrackingNumber: null,
      returnExpectedDeliveryAt: new Date("2026-08-05T00:00:00.000Z"), // 5 days ago, timeout 10
      noInspectionTimeoutDays: 10,
    });
    const repository = new FakeWatcherRepository([candidate]);
    const service = makeService({ repository, trackingProvider: new FakeTrackingProvider(null) });

    const result = await service.runWatcher({ workerId: "watcher-1", limit: 10 });
    expect(result.queuedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(repository.queued).toHaveLength(0);
  });

  it("skips when the carrier status is not lost and the timeout has not lapsed", async () => {
    const candidate = makeCandidate({
      returnTrackingNumber: "1Z999",
      returnExpectedDeliveryAt: new Date("2026-08-20T00:00:00.000Z"),
    });
    const repository = new FakeWatcherRepository([candidate]);
    const trackingProvider = new FakeTrackingProvider({
      trackingNumber: "1Z999",
      carrierStatus: "in_transit",
      deliveredAt: null,
      events: [],
    });
    const service = makeService({ repository, trackingProvider });

    const result = await service.runWatcher({ workerId: "watcher-1", limit: 10 });
    expect(result.queuedCount).toBe(0);
    expect(repository.queued).toHaveLength(0);
  });

  it("runs only the timeout path when no tracking provider is configured", async () => {
    const lostCandidate = makeCandidate({
      rmaId: 42,
      returnTrackingNumber: "1Z999",
      returnExpectedDeliveryAt: null,
    });
    const repository = new FakeWatcherRepository([lostCandidate]);
    const service = new DropshipNoInspectionWatcherService({
      repository,
      trackingProvider: undefined,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.runWatcher({ workerId: "watcher-1", limit: 10 });
    // No provider → the lost-status path cannot fire; no expected delivery →
    // the timeout path cannot fire either. Nothing queued.
    expect(result.queuedCount).toBe(0);
  });

  it("does not double-queue when the repository reports the RMA already moved on", async () => {
    const candidate = makeCandidate({
      returnTrackingNumber: null,
      returnExpectedDeliveryAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const repository = new FakeWatcherRepository([candidate], { queueResult: false });
    const notificationSender = new FakeNotificationSender();
    const service = makeService({ repository, trackingProvider: new FakeTrackingProvider(null), notificationSender });

    const result = await service.runWatcher({ workerId: "watcher-1", limit: 10 });
    expect(result.queuedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    // No notification when the queue write was a no-op.
    expect(notificationSender.sent).toHaveLength(0);
  });

  it("rejects invalid input", async () => {
    const repository = new FakeWatcherRepository([]);
    const service = makeService({ repository, trackingProvider: new FakeTrackingProvider(null) });
    await expect(service.runWatcher({ workerId: "", limit: 1 })).rejects.toMatchObject({
      code: "DROPSHIP_NO_INSPECTION_WATCHER_INVALID_INPUT",
    });
  });
});

function makeService(input: {
  repository: FakeWatcherRepository;
  trackingProvider: FakeTrackingProvider;
  notificationSender?: FakeNotificationSender;
}): DropshipNoInspectionWatcherService {
  return new DropshipNoInspectionWatcherService({
    repository: input.repository,
    trackingProvider: input.trackingProvider,
    notificationSender: input.notificationSender,
    clock: { now: () => now },
    logger: noopLogger,
  });
}

function makeCandidate(patch: Partial<DropshipNoInspectionCandidate> = {}): DropshipNoInspectionCandidate {
  return {
    rmaId: patch.rmaId ?? 42,
    vendorId: patch.vendorId ?? 10,
    storeConnectionId: patch.storeConnectionId ?? 22,
    rmaNumber: patch.rmaNumber ?? "RMA-42",
    status: patch.status ?? "in_transit",
    returnTrackingNumber: patch.returnTrackingNumber ?? null,
    returnExpectedDeliveryAt: patch.returnExpectedDeliveryAt ?? null,
    requestedAt: patch.requestedAt ?? new Date("2026-07-28T00:00:00.000Z"),
    policyVersionId: patch.policyVersionId ?? 7,
    noInspectionTimeoutDays: patch.noInspectionTimeoutDays ?? 10,
    marketplaceCaseRef: patch.marketplaceCaseRef ?? "ebay-case-7",
  };
}

class FakeTrackingProvider implements DropshipReturnTrackingProvider {
  constructor(private readonly snapshot: DropshipReturnTrackingSnapshot | null) {}

  async fetchReturnTracking(): Promise<DropshipReturnTrackingSnapshot | null> {
    return this.snapshot;
  }
}

class FakeWatcherRepository implements DropshipNoInspectionWatcherRepository {
  queued: {
    rmaId: number;
    vendorId: number;
    evidence: DropshipNoInspectionEvidencePack;
    policyVersionId: number | null;
    idempotencyKey: string;
    workerId: string;
    now: Date;
  }[] = [];

  constructor(
    private readonly candidates: DropshipNoInspectionCandidate[],
    private readonly options: { queueResult?: boolean } = {},
  ) {}

  async listCandidates(): Promise<DropshipNoInspectionCandidate[]> {
    return this.candidates;
  }

  async queueForReview(input: {
    rmaId: number;
    vendorId: number;
    evidence: DropshipNoInspectionEvidencePack;
    policyVersionId: number | null;
    idempotencyKey: string;
    workerId: string;
    now: Date;
  }): Promise<{ queued: boolean }> {
    if (this.options.queueResult === false) {
      return { queued: false };
    }
    this.queued.push(input);
    return { queued: true };
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
