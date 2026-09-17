import { beforeEach, describe, expect, it } from "vitest";
import type { DropshipListingHoldState, DropshipVendorStandingReason, DropshipVendorStatus } from "../../../../../shared/schema/dropship.schema";
import type { DropshipLogEvent, DropshipNotificationSenderInput } from "../../application/dropship-ports";
import {
  DropshipVendorStandingService,
  type DropshipListingHoldGate,
  type DropshipListingHoldGateOutcome,
  type DropshipVendorStandingRecord,
  type DropshipVendorStandingRepository,
} from "../../application/dropship-vendor-standing-service";
import type { DropshipVendorFundingStanding } from "../../domain/vendor-standing";

const NOW = new Date("2026-09-17T12:00:00.000Z");

describe("DropshipVendorStandingService", () => {
  let repository: FakeStandingRepository;
  let funding: FakeFundingReader;
  let gate: FakeListingHoldGate;
  let notificationSender: FakeNotificationSender;
  let logs: Array<DropshipLogEvent & { level: "info" | "warn" | "error" }>;
  let service: DropshipVendorStandingService;

  beforeEach(() => {
    repository = new FakeStandingRepository();
    funding = new FakeFundingReader();
    gate = new FakeListingHoldGate();
    notificationSender = new FakeNotificationSender();
    logs = [];
    service = buildService({ listingHolds: gate });
  });

  function buildService(overrides: { listingHolds?: DropshipListingHoldGate } = {}): DropshipVendorStandingService {
    return new DropshipVendorStandingService({
      repository,
      funding,
      listingHolds: overrides.listingHolds,
      notificationSender,
      clock: { now: () => NOW },
      logger: {
        info: (event) => logs.push({ ...event, level: "info" }),
        warn: (event) => logs.push({ ...event, level: "warn" }),
        error: (event) => logs.push({ ...event, level: "error" }),
      },
    });
  }

  describe("pauseForFundingFailure", () => {
    it("pauses an active vendor, tells them once, and holds every store connection under revision-keyed commands", async () => {
      repository.seed(standing({ vendorId: 10, status: "active" }), [77, 78]);
      gate.blockedByStore.set(77, [9, 3]);
      gate.blockedByStore.set(78, [3]);

      const result = await service.pauseForFundingFailure({
        vendorId: 10,
        reason: "card_declined",
        evidence: { source: "wallet_maintenance", stripeDeclineCode: "insufficient_funds", amountCents: 4000, currency: "USD" },
      });

      expect(result).toMatchObject({
        outcome: "paused",
        standing: { status: "paused", standingReason: "card_declined", pausedAt: NOW, standingRevision: 1 },
        listingHold: { outcome: "applied", state: "held", storeConnectionIds: [77, 78], blockedProductIds: [3, 9] },
      });
      expect(repository.pauseCalls).toEqual([{ vendorId: 10, reason: "card_declined", evidence: expect.objectContaining({ source: "wallet_maintenance" }), now: NOW }]);
      expect(gate.calls).toEqual([
        { kind: "hold", storeConnectionId: 77, reason: "Dropship vendor 10 paused: card_declined", idempotencyKey: "dropship-vendor-standing:10:1:held:77" },
        { kind: "hold", storeConnectionId: 78, reason: "Dropship vendor 10 paused: card_declined", idempotencyKey: "dropship-vendor-standing:10:1:held:78" },
      ]);
      expect(repository.get(10)).toMatchObject({ listingHoldState: "held", listingHoldReconciledAt: NOW, listingHoldDetail: "held; planner blocked products 3,9" });
      expect(notificationSender.sent).toHaveLength(1);
      expect(notificationSender.sent[0]).toMatchObject({
        vendorId: 10,
        eventType: "dropship_vendor_paused",
        critical: true,
        channels: ["email", "in_app"],
        title: "Selling is paused until your wallet is funded",
        idempotencyKey: "dropship-vendor-standing:10:1:paused",
        payload: expect.objectContaining({ reason: "card_declined", standingRevision: 1, pausedAt: NOW.toISOString(), stripeDeclineCode: "insufficient_funds" }),
      });
      expect(notificationSender.sent[0].message).toContain("Your saved card was declined (insufficient funds) when we tried to top up your wallet by USD $40.00.");
      expect(notificationSender.sent[0].message).toContain("selling resumes on its own once your balance is back to the minimum");
      expect(logs.find((entry) => entry.code === "DROPSHIP_VENDOR_PAUSED")).toMatchObject({ level: "warn", context: expect.objectContaining({ vendorId: 10, standingRevision: 1 }) });
      expect(logs.find((entry) => entry.code === "DROPSHIP_LISTINGS_HELD")).toMatchObject({ level: "info" });
      expect(logs.filter((entry) => entry.level === "error")).toHaveLength(0);
    });

    it("does nothing for a vendor who is not active, and says so", async () => {
      for (const status of ["onboarding", "paused", "lapsed", "suspended", "closed"] as const) {
        repository = new FakeStandingRepository();
        repository.seed(standing({ vendorId: 10, status, standingReason: status === "paused" ? "operator" : null, pausedAt: status === "paused" ? NOW : null }), [77]);
        service = buildService({ listingHolds: gate });

        const result = await service.pauseForFundingFailure({ vendorId: 10, reason: "funding_returned" });

        expect(result.outcome).toBe("unchanged");
        expect(result.standing?.status).toBe(status);
      }
      expect(gate.calls).toEqual([]);
      expect(notificationSender.sent).toEqual([]);
      expect(logs.filter((entry) => entry.code === "DROPSHIP_VENDOR_PAUSE_SKIPPED")).toHaveLength(5);
      // An unknown vendor is reported the same way, not as a crash.
      repository = new FakeStandingRepository();
      service = buildService({ listingHolds: gate });
      await expect(service.pauseForFundingFailure({ vendorId: 404, reason: "funding_returned" })).resolves.toMatchObject({ outcome: "unchanged", standing: null });
    });

    it("records a deferred hold without changing the recorded state, then lands it on the next reconcile with the same keys", async () => {
      repository.seed(standing({ vendorId: 10, status: "active" }), [77, 78]);
      gate.refuse.add(78);

      const paused = await service.pauseForFundingFailure({ vendorId: 10, reason: "funding_returned" });

      expect(paused).toMatchObject({
        outcome: "paused",
        listingHold: { outcome: "deferred", wanted: "held", storeConnectionId: 78, code: "INVENTORY_PUBLICATION_TARGET_HOLD_BUSY" },
      });
      expect(repository.get(10)).toMatchObject({ status: "paused", listingHoldState: "released", listingHoldDetail: "held deferred on store 78: INVENTORY_PUBLICATION_TARGET_HOLD_BUSY" });
      expect(logs.find((entry) => entry.code === "DROPSHIP_LISTING_HOLD_DEFERRED")).toMatchObject({ level: "warn" });
      expect(notificationSender.sent[0].message).toContain("A bank transfer to your wallet was returned by your bank.");

      gate.refuse.clear();
      const reconciled = await service.reconcileStanding({ workerId: "worker-1" });

      expect(reconciled.listingHolds).toEqual({ scannedCount: 1, appliedCount: 1, deferredCount: 0, failedCount: 0, unavailableCount: 0 });
      expect(gate.calls.map((call) => call.idempotencyKey)).toEqual([
        "dropship-vendor-standing:10:1:held:77",
        "dropship-vendor-standing:10:1:held:78",
        "dropship-vendor-standing:10:1:held:77",
        "dropship-vendor-standing:10:1:held:78",
      ]);
      expect(repository.get(10)).toMatchObject({ listingHoldState: "held", listingHoldDetail: null });
      // The pause notice went out once; the reconcile does not repeat it.
      expect(notificationSender.sent).toHaveLength(1);
    });

    it("keeps the pause when the listing hold gate throws, and reports the failure for a human", async () => {
      repository.seed(standing({ vendorId: 10, status: "active" }), [77]);
      gate.crash = new Error("planner unavailable");

      const result = await service.pauseForFundingFailure({ vendorId: 10, reason: "card_declined" });

      expect(result).toMatchObject({ outcome: "paused", listingHold: { outcome: "failed", wanted: "held", error: "planner unavailable" } });
      expect(repository.get(10)).toMatchObject({ status: "paused", listingHoldState: "released", listingHoldDetail: "held failed: planner unavailable" });
      expect(logs.find((entry) => entry.code === "DROPSHIP_LISTING_HOLD_RECONCILE_FAILED")).toMatchObject({ level: "error" });
      expect(notificationSender.sent).toHaveLength(1);
    });

    it("still records and announces the pause when no listing hold gate is configured", async () => {
      service = buildService({});
      repository.seed(standing({ vendorId: 10, status: "active" }), [77]);

      const result = await service.pauseForFundingFailure({ vendorId: 10, reason: "card_declined" });

      expect(result).toMatchObject({ outcome: "paused", listingHold: { outcome: "unavailable", wanted: "held" } });
      expect(repository.get(10)).toMatchObject({ status: "paused", listingHoldState: "released" });
      expect(logs.find((entry) => entry.code === "DROPSHIP_LISTING_HOLD_GATE_UNAVAILABLE")).toMatchObject({ level: "warn" });
      expect(notificationSender.sent).toHaveLength(1);
    });

    it("does not lose the pause when the vendor notice cannot be sent", async () => {
      repository.seed(standing({ vendorId: 10, status: "active" }), [77]);
      notificationSender.error = new Error("email unavailable");

      const result = await service.pauseForFundingFailure({ vendorId: 10, reason: "card_declined" });

      expect(result.outcome).toBe("paused");
      expect(repository.get(10)).toMatchObject({ status: "paused", listingHoldState: "held" });
      expect(logs.find((entry) => entry.code === "DROPSHIP_VENDOR_PAUSED_NOTIFICATION_FAILED")).toBeDefined();
    });
  });

  describe("announcePause", () => {
    it("announces a pause the wallet already recorded and holds the listings", async () => {
      repository.seed(standing({ vendorId: 10, status: "paused", standingReason: "funding_returned", pausedAt: NOW, standingRevision: 3 }), [77]);

      const result = await service.announcePause({ vendorId: 10, evidence: { source: "funding_webhook", ledgerEntryId: 55, amountCents: 4000, currency: "USD" } });

      expect(result).toMatchObject({ outcome: "paused", listingHold: { outcome: "applied", state: "held" } });
      expect(repository.pauseCalls).toEqual([]);
      expect(gate.calls).toEqual([expect.objectContaining({ kind: "hold", idempotencyKey: "dropship-vendor-standing:10:3:held:77" })]);
      expect(notificationSender.sent[0]).toMatchObject({
        eventType: "dropship_vendor_paused",
        idempotencyKey: "dropship-vendor-standing:10:3:paused",
        payload: expect.objectContaining({ reason: "funding_returned", ledgerEntryId: 55 }),
      });
      expect(notificationSender.sent[0].message).toContain("A bank transfer of USD $40.00 to your wallet was returned by your bank.");
    });

    it("announces nothing for a vendor who is active or paused by an operator", async () => {
      repository.seed(standing({ vendorId: 10, status: "active" }), [77]);
      repository.seed(standing({ vendorId: 11, status: "paused", standingReason: "operator", pausedAt: NOW }), [78]);

      await expect(service.announcePause({ vendorId: 10 })).resolves.toMatchObject({ outcome: "unchanged" });
      await expect(service.announcePause({ vendorId: 11 })).resolves.toMatchObject({ outcome: "unchanged" });
      await expect(service.announcePause({ vendorId: 12 })).resolves.toMatchObject({ outcome: "unchanged", standing: null });
      expect(gate.calls).toEqual([]);
      expect(notificationSender.sent).toEqual([]);
      expect(logs.filter((entry) => entry.code === "DROPSHIP_VENDOR_PAUSE_ANNOUNCE_SKIPPED")).toHaveLength(3);
    });
  });

  describe("restoreIfFunded", () => {
    it("leaves an active vendor, or an operator pause, alone without reading the wallet", async () => {
      repository.seed(standing({ vendorId: 10, status: "active" }), [77]);
      repository.seed(standing({ vendorId: 11, status: "paused", standingReason: "operator", pausedAt: NOW }), [78]);

      await expect(service.restoreIfFunded({ vendorId: 10 })).resolves.toMatchObject({ outcome: "unchanged" });
      await expect(service.restoreIfFunded({ vendorId: 11 })).resolves.toMatchObject({ outcome: "unchanged" });
      await expect(service.restoreIfFunded({ vendorId: 12 })).resolves.toMatchObject({ outcome: "unchanged", standing: null });
      expect(funding.reads).toEqual([]);
      expect(repository.resumeCalls).toEqual([]);
    });

    it("keeps the vendor paused while the available balance is below the minimum, by the exact shortfall", async () => {
      repository.seed(standing({ vendorId: 10, status: "paused", standingReason: "card_declined", pausedAt: NOW, listingHoldState: "held" }), [77]);
      funding.respond = () => ({ availableBalanceCents: 4999, minimumBalanceCents: 5000, currency: "USD" });

      const result = await service.restoreIfFunded({ vendorId: 10 });

      expect(result).toMatchObject({ outcome: "still_short", shortfallCents: 1 });
      expect(repository.resumeCalls).toEqual([]);
      expect(gate.calls).toEqual([]);
      expect(logs.find((entry) => entry.code === "DROPSHIP_VENDOR_STILL_SHORT")).toMatchObject({ level: "info", context: expect.objectContaining({ shortfallCents: 1 }) });

      // Without an auto-reload minimum an empty wallet is still not funded.
      funding.respond = () => ({ availableBalanceCents: 0, minimumBalanceCents: null, currency: "USD" });
      await expect(service.restoreIfFunded({ vendorId: 10 })).resolves.toMatchObject({ outcome: "still_short", shortfallCents: 1 });
    });

    it("resumes the vendor once the balance is back to the minimum, tells them, and releases the stores", async () => {
      repository.seed(standing({ vendorId: 10, status: "paused", standingReason: "card_declined", pausedAt: NOW, standingRevision: 1, listingHoldState: "held" }), [77]);
      funding.respond = () => ({ availableBalanceCents: 5000, minimumBalanceCents: 5000, currency: "USD" });

      const result = await service.restoreIfFunded({ vendorId: 10, evidence: { source: "wallet_funding_credit", ledgerEntryId: 9 } });

      expect(result).toMatchObject({
        outcome: "resumed",
        shortfallCents: 0,
        standing: { status: "active", standingReason: null, pausedAt: null, standingRevision: 2 },
        listingHold: { outcome: "applied", state: "released", storeConnectionIds: [77] },
      });
      expect(repository.resumeCalls).toEqual([{
        vendorId: 10,
        evidence: { source: "wallet_funding_credit", ledgerEntryId: 9, availableBalanceCents: 5000, minimumBalanceCents: 5000 },
        now: NOW,
      }]);
      expect(gate.calls).toEqual([{ kind: "release", storeConnectionId: 77, reason: "Dropship vendor 10 resumed", idempotencyKey: "dropship-vendor-standing:10:2:released:77" }]);
      expect(repository.get(10)).toMatchObject({ listingHoldState: "released", listingHoldDetail: null });
      expect(notificationSender.sent[0]).toMatchObject({
        eventType: "dropship_vendor_resumed",
        critical: false,
        title: "Selling has resumed",
        idempotencyKey: "dropship-vendor-standing:10:2:resumed",
        payload: expect.objectContaining({ availableBalanceCents: 5000, minimumBalanceCents: 5000 }),
      });
      expect(notificationSender.sent[0].message).toContain("USD $50.00 available");
      expect(logs.find((entry) => entry.code === "DROPSHIP_VENDOR_RESUMED")).toMatchObject({ level: "info" });
      expect(logs.find((entry) => entry.code === "DROPSHIP_LISTINGS_RELEASED")).toMatchObject({ level: "info" });
    });

    it("clears the funding pause without a resume notice when the membership lapsed meanwhile", async () => {
      repository.seed(standing({ vendorId: 10, status: "paused", standingReason: "card_declined", pausedAt: NOW, standingRevision: 1, listingHoldState: "held" }), [77]);
      repository.resumeInto = "lapsed";
      funding.respond = () => ({ availableBalanceCents: 5000, minimumBalanceCents: 5000, currency: "USD" });

      const result = await service.restoreIfFunded({ vendorId: 10 });

      expect(result).toMatchObject({ outcome: "resumed", standing: { status: "lapsed", standingReason: null }, listingHold: { outcome: "applied", state: "released" } });
      expect(notificationSender.sent).toEqual([]);
      expect(logs.find((entry) => entry.code === "DROPSHIP_VENDOR_RESUMED")).toMatchObject({ context: expect.objectContaining({ status: "lapsed" }) });
    });

    it("reports unchanged when the guarded resume finds the vendor already changed underneath it", async () => {
      repository.seed(standing({ vendorId: 10, status: "paused", standingReason: "card_declined", pausedAt: NOW }), [77]);
      funding.respond = () => ({ availableBalanceCents: 9000, minimumBalanceCents: 5000, currency: "USD" });
      repository.raceOnResume = true;

      await expect(service.restoreIfFunded({ vendorId: 10 })).resolves.toMatchObject({ outcome: "unchanged" });
      expect(gate.calls).toEqual([]);
      expect(notificationSender.sent).toEqual([]);
    });
  });

  describe("reconcileStanding", () => {
    it("resumes funded vendors, leaves short ones paused, retries mismatched holds, and keeps going past a failure", async () => {
      repository.seed(standing({ vendorId: 10, status: "paused", standingReason: "card_declined", pausedAt: NOW, standingRevision: 1, listingHoldState: "held" }), [77]);
      repository.seed(standing({ vendorId: 11, status: "paused", standingReason: "funding_returned", pausedAt: NOW, standingRevision: 1, listingHoldState: "held" }), [78]);
      repository.seed(standing({ vendorId: 12, status: "paused", standingReason: "funding_returned", pausedAt: NOW, standingRevision: 1, listingHoldState: "held" }), [79]);
      repository.seed(standing({ vendorId: 13, status: "active", standingRevision: 4, listingHoldState: "held" }), [80]);
      funding.respond = (vendorId) => {
        if (vendorId === 10) return { availableBalanceCents: 6000, minimumBalanceCents: 5000, currency: "USD" };
        if (vendorId === 11) return { availableBalanceCents: 100, minimumBalanceCents: 5000, currency: "USD" };
        throw new Error("wallet read failed");
      };

      const result = await service.reconcileStanding({ workerId: "worker-1", limit: 50 });

      expect(result).toEqual({
        restore: { scannedCount: 3, resumedCount: 1, stillShortCount: 1, failedCount: 1 },
        listingHolds: { scannedCount: 1, appliedCount: 1, deferredCount: 0, failedCount: 0, unavailableCount: 0 },
      });
      expect(repository.get(10)).toMatchObject({ status: "active", listingHoldState: "released" });
      expect(repository.get(11)).toMatchObject({ status: "paused", listingHoldState: "held" });
      expect(repository.get(12)).toMatchObject({ status: "paused", listingHoldState: "held" });
      expect(repository.get(13)).toMatchObject({ status: "active", listingHoldState: "released" });
      expect(gate.calls.map((call) => call.idempotencyKey)).toEqual([
        "dropship-vendor-standing:10:2:released:77",
        "dropship-vendor-standing:13:4:released:80",
      ]);
      expect(logs.find((entry) => entry.code === "DROPSHIP_VENDOR_RESTORE_CHECK_FAILED")).toMatchObject({
        level: "error",
        context: expect.objectContaining({ vendorId: 12, error: "wallet read failed" }),
      });
      expect(logs.find((entry) => entry.code === "DROPSHIP_VENDOR_STANDING_RECONCILE_COMPLETED")).toMatchObject({ level: "info" });
      expect(repository.limits).toEqual([50, 50]);
    });

    it("is silent when there is nothing to reconcile", async () => {
      await expect(service.reconcileStanding({ workerId: "worker-1" })).resolves.toEqual({
        restore: { scannedCount: 0, resumedCount: 0, stillShortCount: 0, failedCount: 0 },
        listingHolds: { scannedCount: 0, appliedCount: 0, deferredCount: 0, failedCount: 0, unavailableCount: 0 },
      });
      expect(repository.limits).toEqual([100, 100]);
      expect(logs).toEqual([]);
    });
  });

  it("rejects malformed input before touching anything", async () => {
    await expect(service.pauseForFundingFailure({ vendorId: 0, reason: "card_declined" })).rejects.toMatchObject({ code: "DROPSHIP_VENDOR_STANDING_PAUSE_INVALID_INPUT" });
    await expect(service.pauseForFundingFailure({ vendorId: 10, reason: "operator" })).rejects.toMatchObject({ code: "DROPSHIP_VENDOR_STANDING_PAUSE_INVALID_INPUT" });
    await expect(service.announcePause({ vendorId: "10" })).rejects.toMatchObject({ code: "DROPSHIP_VENDOR_STANDING_ANNOUNCE_INVALID_INPUT" });
    await expect(service.restoreIfFunded({})).rejects.toMatchObject({ code: "DROPSHIP_VENDOR_STANDING_RESTORE_INVALID_INPUT" });
    await expect(service.reconcileStanding({ workerId: "worker-1", limit: 1001 })).rejects.toMatchObject({ code: "DROPSHIP_VENDOR_STANDING_RECONCILE_INVALID_INPUT" });
    await expect(service.reconcileStanding({ workerId: " " })).rejects.toMatchObject({ code: "DROPSHIP_VENDOR_STANDING_RECONCILE_INVALID_INPUT" });
    expect(repository.pauseCalls).toEqual([]);
    expect(repository.resumeCalls).toEqual([]);
    expect(gate.calls).toEqual([]);
  });
});

function standing(overrides: Partial<DropshipVendorStandingRecord> & { vendorId: number; status: DropshipVendorStatus }): DropshipVendorStandingRecord {
  return {
    standingReason: null,
    pausedAt: null,
    standingRevision: 0,
    listingHoldState: "released",
    listingHoldReconciledAt: null,
    listingHoldDetail: null,
    ...overrides,
  };
}

class FakeStandingRepository implements DropshipVendorStandingRepository {
  private readonly records = new Map<number, DropshipVendorStandingRecord>();
  private readonly storeConnections = new Map<number, number[]>();
  pauseCalls: unknown[] = [];
  resumeCalls: unknown[] = [];
  limits: number[] = [];
  /** Simulates another writer changing the row between the read and the guarded update. */
  raceOnResume = false;
  /** The status the membership implies when the pause clears (the real repository resolves it from entitlement_status). */
  resumeInto: DropshipVendorStatus = "active";

  seed(record: DropshipVendorStandingRecord, storeConnectionIds: number[]): void {
    this.records.set(record.vendorId, record);
    this.storeConnections.set(record.vendorId, storeConnectionIds);
  }

  get(vendorId: number): DropshipVendorStandingRecord | undefined {
    return this.records.get(vendorId);
  }

  async getStanding(vendorId: number): Promise<DropshipVendorStandingRecord | null> {
    return this.records.get(vendorId) ?? null;
  }

  async pauseVendor(input: { vendorId: number; reason: DropshipVendorStandingReason; evidence: Record<string, unknown>; now: Date }) {
    this.pauseCalls.push(input);
    const current = this.records.get(input.vendorId);
    if (!current || current.status !== "active") {
      return { changed: false, standing: current ?? null };
    }
    const next: DropshipVendorStandingRecord = {
      ...current,
      status: "paused",
      standingReason: input.reason,
      pausedAt: input.now,
      standingRevision: current.standingRevision + 1,
    };
    this.records.set(input.vendorId, next);
    return { changed: true, standing: next };
  }

  async resumeVendor(input: { vendorId: number; evidence: Record<string, unknown>; now: Date }) {
    this.resumeCalls.push(input);
    const current = this.records.get(input.vendorId);
    if (this.raceOnResume || !current || current.status !== "paused"
      || (current.standingReason !== "card_declined" && current.standingReason !== "funding_returned")) {
      return { changed: false, standing: current ?? null };
    }
    const next: DropshipVendorStandingRecord = {
      ...current,
      status: this.resumeInto,
      standingReason: null,
      pausedAt: null,
      standingRevision: current.standingRevision + 1,
    };
    this.records.set(input.vendorId, next);
    return { changed: true, standing: next };
  }

  async listStoreConnectionIds(vendorId: number): Promise<number[]> {
    return this.storeConnections.get(vendorId) ?? [];
  }

  async listPausedForFunding(input: { limit: number }): Promise<DropshipVendorStandingRecord[]> {
    this.limits.push(input.limit);
    return [...this.records.values()]
      .filter((record) => record.status === "paused" && (record.standingReason === "card_declined" || record.standingReason === "funding_returned"))
      .slice(0, input.limit);
  }

  async listListingHoldMismatches(input: { limit: number }): Promise<DropshipVendorStandingRecord[]> {
    this.limits.push(input.limit);
    return [...this.records.values()]
      .filter((record) => (record.status === "paused") !== (record.listingHoldState === "held"))
      .slice(0, input.limit);
  }

  async recordListingHoldState(input: { vendorId: number; state: DropshipListingHoldState; detail: string | null; now: Date }): Promise<void> {
    const current = this.records.get(input.vendorId);
    if (!current) throw new Error(`vendor ${input.vendorId} missing`);
    this.records.set(input.vendorId, { ...current, listingHoldState: input.state, listingHoldDetail: input.detail, listingHoldReconciledAt: input.now });
  }
}

class FakeFundingReader {
  reads: number[] = [];
  respond: (vendorId: number) => DropshipVendorFundingStanding = () => ({ availableBalanceCents: 0, minimumBalanceCents: 5000, currency: "USD" });

  async readFundingStanding(vendorId: number): Promise<DropshipVendorFundingStanding> {
    this.reads.push(vendorId);
    return this.respond(vendorId);
  }
}

class FakeListingHoldGate implements DropshipListingHoldGate {
  calls: Array<{ kind: "hold" | "release"; storeConnectionId: number; reason: string; idempotencyKey: string }> = [];
  refuse = new Set<number>();
  blockedByStore = new Map<number, number[]>();
  crash: Error | null = null;

  hold(input: { storeConnectionId: number; reason: string; idempotencyKey: string }): Promise<DropshipListingHoldGateOutcome> {
    return this.apply("hold", input);
  }

  release(input: { storeConnectionId: number; reason: string; idempotencyKey: string }): Promise<DropshipListingHoldGateOutcome> {
    return this.apply("release", input);
  }

  private async apply(kind: "hold" | "release", input: { storeConnectionId: number; reason: string; idempotencyKey: string }): Promise<DropshipListingHoldGateOutcome> {
    this.calls.push({ kind, ...input });
    if (this.crash) throw this.crash;
    if (this.refuse.has(input.storeConnectionId)) {
      return { applied: false, code: "INVENTORY_PUBLICATION_TARGET_HOLD_BUSY", message: "A quantity request is in flight." };
    }
    return { applied: true, targetCount: 1, publicationRows: 1, blockedProductIds: this.blockedByStore.get(input.storeConnectionId) ?? [] };
  }
}

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];
  error: Error | null = null;

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    if (this.error) throw this.error;
    this.sent.push(input);
  }
}
