import { beforeEach, describe, expect, it } from "vitest";
import type { DropshipVendorStatus } from "../../../../../shared/schema/dropship.schema";
import type { DropshipLogEvent, DropshipNotificationSenderInput } from "../../application/dropship-ports";
import {
  DropshipListingTierService,
  type DropshipListingTierRepository,
  type DropshipListingTierVendorRecord,
  type DropshipListingVariantHoldGate,
  type DropshipListingVariantHoldGateOutcome,
  type DropshipVendorListingTierFundingSnapshot,
  type DropshipVendorListingTierHoldRecord,
} from "../../application/dropship-listing-tier-service";
import {
  resolveEnforcedListingTierMinimums,
  type DropshipEnforcedListingTierMinimums,
  type DropshipListingTier,
  type DropshipListingTierPolicyVersion,
} from "../../domain/listing-tiers";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-09-01T00:00:00.000Z");
const NOW = new Date("2026-09-17T12:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

function policyVersion(input: Partial<DropshipListingTierPolicyVersion> & { version: number; createdAt: Date }): DropshipListingTierPolicyVersion {
  return { packTierMinimumCents: 10_000, caseTierMinimumCents: 50_000, tierChangeGraceDays: 14, ...input };
}

const LAUNCH_MINIMUMS = resolveEnforcedListingTierMinimums([policyVersion({ version: 1, createdAt: T0 })], NOW);

describe("DropshipListingTierService", () => {
  let repository: FakeTierRepository;
  let funding: FakeFundingReader;
  let gate: FakeVariantHoldGate;
  let notificationSender: FakeNotificationSender;
  let minimums: DropshipEnforcedListingTierMinimums;
  let logs: Array<DropshipLogEvent & { level: "info" | "warn" | "error" }>;
  let service: DropshipListingTierService;

  beforeEach(() => {
    repository = new FakeTierRepository();
    funding = new FakeFundingReader();
    gate = new FakeVariantHoldGate();
    notificationSender = new FakeNotificationSender();
    minimums = LAUNCH_MINIMUMS;
    logs = [];
    service = buildService({ variantHolds: gate });
  });

  function buildService(overrides: { variantHolds?: DropshipListingVariantHoldGate; withoutNotifications?: boolean } = {}): DropshipListingTierService {
    return new DropshipListingTierService({
      repository,
      funding,
      policy: { resolveListingTierMinimums: async () => minimums },
      variantHolds: overrides.variantHolds,
      notificationSender: overrides.withoutNotifications ? undefined : notificationSender,
      clock: { now: () => NOW },
      logger: {
        info: (event) => logs.push({ ...event, level: "info" }),
        warn: (event) => logs.push({ ...event, level: "warn" }),
        error: (event) => logs.push({ ...event, level: "error" }),
      },
    });
  }

  describe("resolveForVendor", () => {
    it("answers with the enforced minimums, the vendor's funding and what each tier needs", async () => {
      funding.set(10, { minimumBalanceCents: 10_000, availableBalanceCents: 12_000, pendingBalanceCents: 30_000 });

      const view = await service.resolveForVendor(10);

      expect(view).toMatchObject({
        vendorId: 10,
        minimums: LAUNCH_MINIMUMS,
        funding: { minimumBalanceCents: 10_000, availableBalanceCents: 12_000, pendingBalanceCents: 30_000, currency: "USD" },
        generatedAt: NOW,
      });
      expect(view.eligibility.pack).toMatchObject({ eligible: true, shortfallCents: 0 });
      expect(view.eligibility.case).toMatchObject({ eligible: false, reason: "case_tier_balance_below_minimum", shortfallCents: 8_000 });
      expect(repository.recorded).toHaveLength(0);
      expect(gate.calls).toHaveLength(0);
    });

    it("refuses a vendor id that is not a positive integer", async () => {
      await expect(service.resolveForVendor(0)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_TIER_INVALID_INPUT" });
      await expect(service.resolveForVendor(1.5)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_TIER_INVALID_INPUT" });
    });
  });

  describe("reconcileListingTiers", () => {
    it("takes a vendor's case listings off sale: records the decision, tells them once, holds the case SKUs on every store", async () => {
      repository.seedVendor(10, "active", null, { 77: { pack: [101, 102], case: [201, 202] }, 78: { pack: [101], case: [] } });
      funding.set(10, { minimumBalanceCents: 10_000, availableBalanceCents: 12_000, pendingBalanceCents: 0 });
      gate.blockedByStore.set(77, [9]);

      const result = await service.reconcileListingTiers({ workerId: "worker-1" });

      expect(result).toEqual({
        scannedCount: 1, changedCount: 1, appliedCount: 1, deferredCount: 0, unavailableCount: 0, failedCount: 0, graceNoticeCount: 0,
      });
      expect(repository.get(10)).toMatchObject({ heldTiers: ["case"], revision: 1, applied: true, evaluatedAt: NOW, appliedAt: NOW });
      expect(repository.get(10)?.detail).toBe("held case; planner blocked products 9");
      expect(gate.calls).toEqual([
        { kind: "release", storeConnectionId: 77, productVariantIds: [101, 102], reason: "Dropship vendor 10: pack tier meets minimum (rev 1)", idempotencyKey: expect.stringMatching(/^dropship-listing-tier:10:1:pack:release:77:[0-9a-f]{16}$/) },
        { kind: "hold", storeConnectionId: 77, productVariantIds: [201, 202], reason: "Dropship vendor 10: case tier below minimum (rev 1)", idempotencyKey: expect.stringMatching(/^dropship-listing-tier:10:1:case:hold:77:[0-9a-f]{16}$/) },
        { kind: "release", storeConnectionId: 78, productVariantIds: [101], reason: "Dropship vendor 10: pack tier meets minimum (rev 1)", idempotencyKey: expect.stringMatching(/^dropship-listing-tier:10:1:pack:release:78:[0-9a-f]{16}$/) },
      ]);
      expect(notificationSender.sent).toHaveLength(1);
      expect(notificationSender.sent[0]).toMatchObject({
        vendorId: 10,
        eventType: "dropship_listing_tier_held",
        critical: true,
        channels: ["email", "in_app"],
        title: "Case listings are off sale until your balance reaches USD $500.00",
        idempotencyKey: "dropship-listing-tier:10:case:held:1",
        payload: expect.objectContaining({ tier: "case", revision: 1, minimumCents: 50_000, shortfallCents: 38_000, availableBalanceCents: 12_000 }),
      });
      expect(notificationSender.sent[0].message).toContain("Your wallet has USD $120.00. Case listings need USD $500.00; add USD $380.00");
      expect(notificationSender.sent[0].message).toContain("Pack and inner pack listings are not affected.");
      expect(logs.find((entry) => entry.code === "DROPSHIP_LISTING_TIER_HOLD_CHANGED")).toMatchObject({ level: "info", context: expect.objectContaining({ before: [], after: ["case"], revision: 1 }) });
      expect(logs.find((entry) => entry.code === "DROPSHIP_LISTING_TIER_HOLDS_APPLIED")).toMatchObject({ level: "info" });
      expect(logs.filter((entry) => entry.level === "error")).toHaveLength(0);
    });

    it("mentions pending credits in the notice and counts them for the case gate", async () => {
      repository.seedVendor(10, "active", null, { 77: { pack: [], case: [201] } });
      funding.set(10, { minimumBalanceCents: 50_000, availableBalanceCents: 12_000, pendingBalanceCents: 38_000 });

      const result = await service.reconcileListingTiers({ workerId: "worker-1" });

      expect(result.changedCount).toBe(1);
      expect(repository.get(10)).toMatchObject({ heldTiers: [], revision: 1, applied: true });
      expect(notificationSender.sent).toHaveLength(0);
      expect(gate.calls).toEqual([expect.objectContaining({ kind: "release", storeConnectionId: 77, productVariantIds: [201] })]);
    });

    it("is quiet when nothing changed: refreshes the evaluation, issues no commands, sends nothing", async () => {
      repository.seedVendor(10, "active", hold({ heldTiers: ["case"], revision: 3, applied: true }), { 77: { pack: [101], case: [201] } });
      funding.set(10, { minimumBalanceCents: 10_000, availableBalanceCents: 12_000, pendingBalanceCents: 0 });

      const result = await service.reconcileListingTiers({ workerId: "worker-1" });

      expect(result).toMatchObject({ scannedCount: 1, changedCount: 0, appliedCount: 0, deferredCount: 0 });
      expect(repository.get(10)).toMatchObject({ heldTiers: ["case"], revision: 3, applied: true, evaluatedAt: NOW });
      expect(gate.calls).toHaveLength(0);
      expect(notificationSender.sent).toHaveLength(0);
    });

    it("puts case listings back on sale once the balance reaches the minimum, and says so without alarm", async () => {
      repository.seedVendor(10, "active", hold({ heldTiers: ["case"], revision: 3, applied: true }), { 77: { pack: [101], case: [201] } });
      funding.set(10, { minimumBalanceCents: 50_000, availableBalanceCents: 50_000, pendingBalanceCents: 0 });

      await service.reconcileListingTiers({ workerId: "worker-1" });

      expect(repository.get(10)).toMatchObject({ heldTiers: [], revision: 4, applied: true, detail: "all tiers released" });
      expect(gate.calls.map((call) => [call.kind, call.productVariantIds])).toEqual([["release", [101]], ["release", [201]]]);
      expect(notificationSender.sent).toHaveLength(1);
      expect(notificationSender.sent[0]).toMatchObject({
        eventType: "dropship_listing_tier_released",
        critical: false,
        title: "Case listings are back on sale",
        idempotencyKey: "dropship-listing-tier:10:case:released:4",
      });
    });

    it("takes everything off sale for a vendor who keeps neither the floor nor the balance, one notice per tier", async () => {
      repository.seedVendor(10, "active", null, { 77: { pack: [101], case: [201] } });
      funding.set(10, { minimumBalanceCents: 5_000, availableBalanceCents: 9_000, pendingBalanceCents: 0 });

      await service.reconcileListingTiers({ workerId: "worker-1" });

      expect(repository.get(10)).toMatchObject({ heldTiers: ["pack", "case"], revision: 1, applied: true });
      expect(gate.calls.map((call) => [call.kind, call.productVariantIds])).toEqual([["hold", [101]], ["hold", [201]]]);
      expect(notificationSender.sent.map((notice) => [notice.eventType, notice.idempotencyKey])).toEqual([
        ["dropship_listing_tier_held", "dropship-listing-tier:10:pack:held:1"],
        ["dropship_listing_tier_held", "dropship-listing-tier:10:case:held:1"],
      ]);
      expect(notificationSender.sent[0].title).toBe("Your listings are off sale until your wallet keeps the USD $100.00 minimum");
      expect(notificationSender.sent[0].message).toContain("your auto-reload minimum is USD $50.00 and your wallet has USD $90.00");
      expect(notificationSender.sent[0].message).toContain("Raise your minimum to USD $100.00, or add USD $10.00");
    });

    it("keeps a deferred hold unapplied and retries the same revision under the same keys next tick", async () => {
      repository.seedVendor(10, "active", null, { 77: { pack: [101], case: [201] }, 78: { pack: [], case: [202] } });
      funding.set(10, { minimumBalanceCents: 10_000, availableBalanceCents: 12_000, pendingBalanceCents: 0 });
      gate.deferStores.add(78);

      const first = await service.reconcileListingTiers({ workerId: "worker-1" });

      expect(first).toMatchObject({ changedCount: 1, appliedCount: 0, deferredCount: 1, failedCount: 0 });
      expect(repository.get(10)).toMatchObject({ heldTiers: ["case"], revision: 1, applied: false, appliedAt: null });
      expect(repository.get(10)?.detail).toBe("deferred: INVENTORY_PUBLICATION_TARGET_BUSY (store 78)");
      expect(logs.find((entry) => entry.code === "DROPSHIP_LISTING_TIER_HOLD_DEFERRED")).toMatchObject({ level: "warn" });
      const firstKeys = gate.calls.map((call) => call.idempotencyKey);
      expect(notificationSender.sent).toHaveLength(1);

      gate.deferStores.clear();
      gate.calls.length = 0;
      const second = await service.reconcileListingTiers({ workerId: "worker-1" });

      expect(second).toMatchObject({ changedCount: 0, appliedCount: 1, deferredCount: 0 });
      expect(repository.get(10)).toMatchObject({ heldTiers: ["case"], revision: 1, applied: true, appliedAt: NOW });
      expect(gate.calls.map((call) => call.idempotencyKey)).toEqual(expect.arrayContaining(firstKeys));
      // The vendor was told once; a retried application is not a new event.
      expect(notificationSender.sent).toHaveLength(1);
    });

    it("chunks long SKU lists to the gate's command size, each chunk under its own key", async () => {
      gate.maxVariantsPerCommand = 2;
      repository.seedVendor(10, "active", null, { 77: { pack: [], case: [205, 201, 203, 202, 204] } });
      funding.set(10, { minimumBalanceCents: 10_000, availableBalanceCents: 12_000, pendingBalanceCents: 0 });

      await service.reconcileListingTiers({ workerId: "worker-1" });

      expect(gate.calls.map((call) => call.productVariantIds)).toEqual([[201, 202], [203, 204], [205]]);
      expect(new Set(gate.calls.map((call) => call.idempotencyKey)).size).toBe(3);
    });

    it("records the decision but applies nothing when no publication hold gate is configured", async () => {
      service = buildService({ variantHolds: undefined });
      repository.seedVendor(10, "active", null, { 77: { pack: [101], case: [201] } });
      funding.set(10, { minimumBalanceCents: 10_000, availableBalanceCents: 12_000, pendingBalanceCents: 0 });

      const result = await service.reconcileListingTiers({ workerId: "worker-1" });

      expect(result).toMatchObject({ changedCount: 1, appliedCount: 0, unavailableCount: 1 });
      expect(repository.get(10)).toMatchObject({ heldTiers: ["case"], revision: 1, applied: false, detail: "no publication hold gate configured" });
      expect(logs.find((entry) => entry.code === "DROPSHIP_LISTING_TIER_HOLD_UNAVAILABLE")).toMatchObject({ level: "warn" });
    });

    it("logs a gate failure at ERROR, leaves the revision unapplied, and carries on with the next vendor", async () => {
      repository.seedVendor(10, "active", null, { 77: { pack: [], case: [201] } });
      repository.seedVendor(11, "active", null, { 79: { pack: [], case: [301] } });
      funding.set(10, { minimumBalanceCents: 10_000, availableBalanceCents: 12_000, pendingBalanceCents: 0 });
      funding.set(11, { minimumBalanceCents: 10_000, availableBalanceCents: 12_000, pendingBalanceCents: 0 });
      gate.crashStores.add(77);

      const result = await service.reconcileListingTiers({ workerId: "worker-1" });

      expect(result).toMatchObject({ scannedCount: 2, changedCount: 2, appliedCount: 1, failedCount: 1 });
      expect(repository.get(10)).toMatchObject({ applied: false, detail: "failed: planner exploded" });
      expect(repository.get(11)).toMatchObject({ applied: true });
      expect(logs.find((entry) => entry.code === "DROPSHIP_LISTING_TIER_HOLD_FAILED")).toMatchObject({
        level: "error", context: expect.objectContaining({ vendorId: 10, revision: 1, error: "planner exploded" }),
      });
      // The vendor was still told: the decision stands even though the marketplace lags.
      expect(notificationSender.sent.map((notice) => notice.vendorId)).toEqual([10, 11]);
    });

    it("counts a vendor whose wallet cannot be read as failed and keeps going", async () => {
      repository.seedVendor(10, "active", null, { 77: { pack: [], case: [201] } });
      repository.seedVendor(11, "paused", null, { 79: { pack: [301], case: [] } });
      funding.set(11, { minimumBalanceCents: 10_000, availableBalanceCents: 100, pendingBalanceCents: 0 });

      const result = await service.reconcileListingTiers({ workerId: "worker-1" });

      expect(result).toMatchObject({ scannedCount: 2, changedCount: 1, failedCount: 1 });
      expect(repository.get(10)).toBeUndefined();
      expect(logs.find((entry) => entry.code === "DROPSHIP_LISTING_TIER_RECONCILE_FAILED")).toMatchObject({
        level: "error", context: expect.objectContaining({ vendorId: 10, error: "no wallet for vendor 10" }),
      });
      // A paused vendor is still evaluated: standing holds the whole store, the tiers stay right for the resume.
      expect(repository.get(11)).toMatchObject({ heldTiers: ["case"], applied: true });
    });

    it("announces a raise in grace once per vendor, tier and policy version, only to vendors it would catch", async () => {
      minimums = resolveEnforcedListingTierMinimums([
        policyVersion({ version: 1, createdAt: T0, packTierMinimumCents: 5_000, caseTierMinimumCents: 5_000 }),
        policyVersion({ version: 2, createdAt: at(10), packTierMinimumCents: 10_000, caseTierMinimumCents: 50_000 }),
      ], NOW);
      repository.seedVendor(10, "active", null, { 77: { pack: [101], case: [201] } });
      repository.seedVendor(11, "active", null, { 78: { pack: [102], case: [] } });
      funding.set(10, { minimumBalanceCents: 5_000, availableBalanceCents: 5_000, pendingBalanceCents: 0 });
      funding.set(11, { minimumBalanceCents: 10_000, availableBalanceCents: 60_000, pendingBalanceCents: 0 });

      const first = await service.reconcileListingTiers({ workerId: "worker-1" });

      expect(first.graceNoticeCount).toBe(2);
      expect(repository.get(10)).toMatchObject({ heldTiers: [] });
      expect(notificationSender.sent.map((notice) => [notice.vendorId, notice.eventType, notice.idempotencyKey])).toEqual([
        [10, "dropship_listing_tier_grace_notice", "dropship-listing-tier:10:pack:grace_notice:2"],
        [10, "dropship_listing_tier_grace_notice", "dropship-listing-tier:10:case:grace_notice:2"],
      ]);
      expect(notificationSender.sent[0]).toMatchObject({
        critical: true,
        title: "The pack and inner pack listing minimum rises to USD $100.00 on September 25, 2026",
        payload: expect.objectContaining({ policyVersion: 2, currentMinimumCents: 5_000, upcomingMinimumCents: 10_000, enforcesAt: at(24).toISOString() }),
      });
      expect(notificationSender.sent[0].message).toContain("raise your minimum to USD $100.00 before September 25, 2026");
      expect(notificationSender.sent[1].title).toBe("The case listing minimum rises to USD $500.00 on September 25, 2026");

      // The next tick repeats the send under the same keys; the notification service deduplicates by key.
      const second = await service.reconcileListingTiers({ workerId: "worker-1" });
      expect(second.graceNoticeCount).toBe(2);
      expect(new Set(notificationSender.sent.map((notice) => notice.idempotencyKey)).size).toBe(2);
    });

    it("validates its input and the batch size", async () => {
      await expect(service.reconcileListingTiers({ workerId: "" })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_TIER_INVALID_INPUT" });
      await expect(service.reconcileListingTiers({ workerId: "w", limit: 0 })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_TIER_INVALID_INPUT" });
      await expect(service.reconcileListingTiers({ workerId: "w", extra: true })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_TIER_INVALID_INPUT" });
      repository.seedVendor(10, "active", null, {});
      funding.set(10, { minimumBalanceCents: 10_000, availableBalanceCents: 0, pendingBalanceCents: 0 });
      await service.reconcileListingTiers({ workerId: "w", limit: 1 });
      expect(repository.listLimits).toEqual([1]);
    });
  });
});

function hold(input: Partial<DropshipVendorListingTierHoldRecord> & { heldTiers: DropshipListingTier[]; revision: number; applied: boolean }): DropshipVendorListingTierHoldRecord {
  return {
    vendorId: 10,
    detail: null,
    evaluatedAt: new Date("2026-09-17T11:00:00.000Z"),
    appliedAt: input.applied ? new Date("2026-09-17T11:00:00.000Z") : null,
    ...input,
  };
}

class FakeTierRepository implements DropshipListingTierRepository {
  private readonly vendors = new Map<number, { status: DropshipVendorStatus; stores: Record<number, Record<DropshipListingTier, number[]>> }>();
  private readonly holds = new Map<number, DropshipVendorListingTierHoldRecord>();
  readonly recorded: Array<{ vendorId: number; heldTiers: readonly DropshipListingTier[] }> = [];
  readonly listLimits: number[] = [];

  seedVendor(
    vendorId: number,
    status: DropshipVendorStatus,
    tierHold: DropshipVendorListingTierHoldRecord | null,
    stores: Record<number, Record<DropshipListingTier, number[]>>,
  ): void {
    this.vendors.set(vendorId, { status, stores });
    if (tierHold) this.holds.set(vendorId, { ...tierHold, vendorId });
  }

  get(vendorId: number): DropshipVendorListingTierHoldRecord | undefined {
    return this.holds.get(vendorId);
  }

  async listVendorsForReview(input: { limit: number }): Promise<DropshipListingTierVendorRecord[]> {
    this.listLimits.push(input.limit);
    return [...this.vendors.entries()]
      .sort(([left], [right]) => left - right)
      .slice(0, input.limit)
      .map(([vendorId, vendor]) => ({ vendorId, status: vendor.status, tierHold: this.holds.get(vendorId) ?? null }));
  }

  async listStoreConnectionIds(vendorId: number): Promise<number[]> {
    return Object.keys(this.vendors.get(vendorId)?.stores ?? {}).map(Number).sort((a, b) => a - b);
  }

  async listListingVariantIdsByTier(input: { vendorId: number; storeConnectionId: number }): Promise<Record<DropshipListingTier, number[]>> {
    return this.vendors.get(input.vendorId)?.stores[input.storeConnectionId] ?? { pack: [], case: [] };
  }

  async recordHeldTiers(input: { vendorId: number; heldTiers: readonly DropshipListingTier[]; detail: string | null; now: Date }) {
    this.recorded.push({ vendorId: input.vendorId, heldTiers: input.heldTiers });
    const existing = this.holds.get(input.vendorId);
    if (existing && existing.heldTiers.join(",") === input.heldTiers.join(",")) {
      const record = { ...existing, evaluatedAt: input.now };
      this.holds.set(input.vendorId, record);
      return { changed: false, record };
    }
    const record: DropshipVendorListingTierHoldRecord = {
      vendorId: input.vendorId,
      heldTiers: [...input.heldTiers],
      revision: (existing?.revision ?? 0) + 1,
      applied: false,
      detail: input.detail,
      evaluatedAt: input.now,
      appliedAt: null,
    };
    this.holds.set(input.vendorId, record);
    return { changed: true, record };
  }

  async recordApplied(input: { vendorId: number; revision: number; applied: boolean; detail: string | null; now: Date }): Promise<boolean> {
    const existing = this.holds.get(input.vendorId);
    if (!existing || existing.revision !== input.revision) return false;
    this.holds.set(input.vendorId, { ...existing, applied: input.applied, appliedAt: input.applied ? input.now : null, detail: input.detail });
    return true;
  }
}

class FakeFundingReader {
  private readonly byVendor = new Map<number, DropshipVendorListingTierFundingSnapshot>();

  set(vendorId: number, funding: Omit<DropshipVendorListingTierFundingSnapshot, "currency"> & { currency?: string }): void {
    this.byVendor.set(vendorId, { currency: "USD", ...funding });
  }

  async readTierFunding(vendorId: number): Promise<DropshipVendorListingTierFundingSnapshot> {
    const funding = this.byVendor.get(vendorId);
    if (!funding) throw new Error(`no wallet for vendor ${vendorId}`);
    return funding;
  }
}

class FakeVariantHoldGate implements DropshipListingVariantHoldGate {
  maxVariantsPerCommand = 500;
  readonly calls: Array<{ kind: "hold" | "release"; storeConnectionId: number; productVariantIds: number[]; reason: string; idempotencyKey: string }> = [];
  readonly blockedByStore = new Map<number, number[]>();
  readonly deferStores = new Set<number>();
  readonly crashStores = new Set<number>();

  holdVariants(input: { storeConnectionId: number; productVariantIds: readonly number[]; reason: string; idempotencyKey: string }) {
    return this.apply("hold", input);
  }

  releaseVariants(input: { storeConnectionId: number; productVariantIds: readonly number[]; reason: string; idempotencyKey: string }) {
    return this.apply("release", input);
  }

  private async apply(
    kind: "hold" | "release",
    input: { storeConnectionId: number; productVariantIds: readonly number[]; reason: string; idempotencyKey: string },
  ): Promise<DropshipListingVariantHoldGateOutcome> {
    this.calls.push({ kind, storeConnectionId: input.storeConnectionId, productVariantIds: [...input.productVariantIds], reason: input.reason, idempotencyKey: input.idempotencyKey });
    if (this.crashStores.has(input.storeConnectionId)) throw new Error("planner exploded");
    if (this.deferStores.has(input.storeConnectionId)) {
      return { applied: false, code: "INVENTORY_PUBLICATION_TARGET_BUSY", message: "A provider quantity request is in flight." };
    }
    return {
      applied: true,
      targetCount: 1,
      publicationRows: input.productVariantIds.length,
      changedProductVariantIds: [...input.productVariantIds],
      blockedProductIds: this.blockedByStore.get(input.storeConnectionId) ?? [],
    };
  }
}

class FakeNotificationSender {
  readonly sent: DropshipNotificationSenderInput[] = [];

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
  }
}
