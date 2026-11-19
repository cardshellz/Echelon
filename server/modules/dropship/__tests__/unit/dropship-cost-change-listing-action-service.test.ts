import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DROPSHIP_COST_CHANGE_POLICY, type DropshipCostChangePolicySettings } from "../../../../../shared/dropship/cost-change-policy";
import type { PricingProfileState, PricingRecipe } from "../../../../../shared/dropship/pricing-rules";
import {
  COST_CHANGE_HOLD_ACTOR_ID,
  COST_LISTING_NOTICE_LISTED,
  DEFAULT_COST_LISTING_ACTION_ENTRIES_PER_PASS,
  DEFAULT_COST_LISTING_HOLDS_PER_PASS,
  DropshipCostChangeListingActionService,
  buildCostChangeListingNotice,
  classifyListing,
  type ActiveCostChangeListingHold,
  type CostActionListing,
  type CostActionVendorFacts,
  type CostChangeEntryActionRecord,
  type CostChangeListingActionRecord,
  type CostChangeRepriceOutcome,
  type DropshipCostChangeListingActionView,
  type DropshipCostChangeHoldGate,
  type DropshipCostChangeListingActionRepository,
  type DropshipCostChangeRepricePort,
  type EffectiveCostIncrease,
  type CostChangeListingRecheckRecord,
  type NewCostChangeListingHold,
  type RestoredCostChangeListingHold,
  type SkippedListingRecheckCandidate,
} from "../../application/dropship-cost-change-listing-action-service";
import type { DropshipPricingPolicyRecord } from "../../application/dropship-listing-preview-service";
import type { ListingSettingLayers } from "../../application/dropship-listing-setting-layers";
import type { DropshipLogEvent, DropshipNotificationSenderInput } from "../../application/dropship-ports";
import {
  costChangeListingFollowUpNoticeIdempotencyKey,
  costChangeRecheckHoldIdempotencyKey,
  costChangeRecheckRepriceIdempotencyKey,
  costChangeRepriceIdempotencyKey,
  idSetHash,
} from "../../domain/cost-change-listing-action";

const NOW = new Date("2026-10-13T00:05:00.000Z");
const EFFECTIVE = new Date("2026-10-13T00:00:00.000Z");

const costRules: PricingProfileState = {
  revisionId: 7, updatedAt: "2026-09-01T00:00:00.000Z",
  profile: { defaultRecipe: { basis: "product_cost", markupBps: 4000, flatCents: 0, rounding: "cent" }, groups: [] },
};
const retailRules: PricingProfileState = {
  revisionId: 8, updatedAt: "2026-09-01T00:00:00.000Z",
  profile: { defaultRecipe: { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" }, groups: [] },
};

function increase(entryId: number, productVariantId: number, patch: Partial<EffectiveCostIncrease> = {}): EffectiveCostIncrease {
  return { entryId, vendorId: 5, productVariantId, fromCents: 809, unitCostCents: 999, effectiveAt: EFFECTIVE, policyId: 3, inForceEntryId: entryId, ...patch };
}

function listing(listingId: number, productVariantId: number, patch: Partial<CostActionListing> = {}): CostActionListing {
  return {
    listingId, storeConnectionId: 9, productVariantId, status: "active", externalListingId: null, vendorRetailPriceCents: 1099, publishedPriceCents: null,
    platform: "shopify",
    variantSku: `SKU-${productVariantId}`, variantName: `Variant ${productVariantId}`, productName: "Armor Envelope", ...patch,
  };
}

function candidate(productVariantId: number) {
  return { productVariantId, productId: 1, category: null, categoryId: null, productLineIds: [], defaultRetailPriceCents: 899 };
}

class FakeRepository implements DropshipCostChangeListingActionRepository {
  entries: EffectiveCostIncrease[] = [];
  facts = new Map<number, CostActionVendorFacts>();
  recorded: Array<{ vendorId: number; entries: CostChangeEntryActionRecord[]; listingActions: CostChangeListingActionRecord[]; holds: NewCostChangeListingHold[] }> = [];
  failRecording = false;
  activeHolds: ActiveCostChangeListingHold[] = [];
  costs = new Map<number, number>();
  released: Array<Record<string, unknown>> = [];
  views: DropshipCostChangeListingActionView[] = [];
  reads: unknown[] = [];

  async listVendorListingActions(input: { vendorId: number; since: Date; limit: number }) { this.reads.push(input); return this.views; }
  async listListingActions(input: { limit: number; beforeId: number | null }) { this.reads.push(input); return this.views.slice(0, input.limit); }
  async listEffectiveIncreasesWithoutAction(input: { now: Date; limit: number }) { this.reads.push(input); return this.entries.slice(0, input.limit); }
  async loadVendorFacts(input: { vendorId: number; productVariantIds: readonly number[] }) {
    this.reads.push(input);
    const facts = this.facts.get(input.vendorId)
      ?? { listings: [], savedPrices: [], profiles: new Map(), layersByStore: new Map(), candidates: new Map(), pricingPolicies: [] };
    return { ...facts, listings: facts.listings.filter((row) => input.productVariantIds.includes(row.productVariantId)) };
  }
  async recordEntryActions(input: { vendorId: number; entries: readonly CostChangeEntryActionRecord[]; listingActions: readonly CostChangeListingActionRecord[]; holds: readonly NewCostChangeListingHold[] }) {
    if (this.failRecording) throw new Error("record failed");
    this.recorded.push({ vendorId: input.vendorId, entries: [...input.entries], listingActions: [...input.listingActions], holds: [...input.holds] });
    return { entriesRecorded: input.entries.length, listingActionsRecorded: input.listingActions.length, holdsRecorded: input.holds.length };
  }
  async listActiveHolds(input: { limit: number }) { this.order.push("listActiveHolds"); return this.activeHolds.slice(0, input.limit); }
  restoredHolds: RestoredCostChangeListingHold[] = [];
  restoreError: Error | null = null;
  restoreCalls: Array<{ now: Date; workerId: string; limit: number }> = [];
  order: string[] = [];
  async restoreHoldsReleasedWhileListingDemoted(input: { now: Date; workerId: string; limit: number }) {
    this.order.push("restore");
    this.restoreCalls.push(input);
    if (this.restoreError) throw this.restoreError;
    // A restored hold is live and reviewed in the same pass, like any other.
    for (const restored of this.restoredHolds) {
      this.activeHolds.push({ holdId: restored.holdId, vendorId: restored.vendorId, storeConnectionId: restored.storeConnectionId,
        productVariantId: restored.productVariantId, listingId: restored.listingId, entryId: restored.entryId,
        listingPriceCents: 899, unitCostCents: 999, heldAt: input.now });
    }
    return this.restoredHolds;
  }
  rechecks: SkippedListingRecheckCandidate[] = [];
  recordedRechecks: Array<{ vendorId: number; workerId: string; rechecks: CostChangeListingRecheckRecord[]; holds: NewCostChangeListingHold[] }> = [];
  failRecheckRecording = false;
  async listSkippedListingRechecks(input: { now: Date; limit: number }) { this.reads.push({ rechecks: input }); return this.rechecks.slice(0, input.limit); }
  async recordListingRechecks(input: { vendorId: number; workerId: string; rechecks: readonly CostChangeListingRecheckRecord[]; holds: readonly NewCostChangeListingHold[] }) {
    if (this.failRecheckRecording) throw new Error("recheck record failed");
    this.recordedRechecks.push({ vendorId: input.vendorId, workerId: input.workerId, rechecks: [...input.rechecks], holds: [...input.holds] });
    // Recorded rechecks are never selected again.
    this.rechecks = this.rechecks.filter((candidate) => !input.rechecks.some((recheck) => recheck.actionId === candidate.actionId));
    return { rechecksRecorded: input.rechecks.length, holdsRecorded: input.holds.length };
  }
  async costInForce(input: { vendorId: number; productVariantIds: readonly number[] }) {
    return new Map([...this.costs].filter(([id]) => input.productVariantIds.includes(id)));
  }
  async releaseHolds(input: { holdIds: readonly number[]; reason: string; detail: string; releasedAt: Date; releaseIdempotencyKey: string }) {
    this.released.push({ ...input, holdIds: [...input.holdIds] });
    return input.holdIds.length;
  }
}

class FakeReprice implements DropshipCostChangeRepricePort {
  calls: Array<Record<string, unknown>> = [];
  refuse: { code: string; message: string } | null = null;
  replay = false;
  nextJobId = 100;
  async queueReprice(input: { vendorId: number; storeConnectionId: number; productVariantIds: readonly number[]; idempotencyKey: string; actorId: string }): Promise<CostChangeRepriceOutcome> {
    this.calls.push({ ...input, productVariantIds: [...input.productVariantIds] });
    if (this.refuse) return { queued: false, ...this.refuse };
    const jobId = this.nextJobId++;
    return { queued: true, jobId, jobStatus: "queued", idempotentReplay: this.replay, items: input.productVariantIds.map((id) => ({ productVariantId: id, status: "queued", errorCode: null })) };
  }
}

class FakeGate implements DropshipCostChangeHoldGate {
  maxVariantsPerCommand = 2;
  calls: Array<{ command: string; input: Record<string, unknown> }> = [];
  defer = false;
  heldBy = new Map<number, string>();
  async holdVariants(input: { storeConnectionId: number; productVariantIds: readonly number[]; reason: string; idempotencyKey: string }) {
    this.calls.push({ command: "hold", input: { ...input, productVariantIds: [...input.productVariantIds] } });
    if (this.defer) return { applied: false as const, code: "INVENTORY_PUBLICATION_TARGET_BUSY", message: "busy" };
    return { applied: true as const, targetCount: 1, publicationRows: input.productVariantIds.length, changedProductVariantIds: [...input.productVariantIds], blockedProductIds: [] };
  }
  async releaseVariants(input: { storeConnectionId: number; productVariantIds: readonly number[]; reason: string; idempotencyKey: string }) {
    this.calls.push({ command: "release", input: { ...input, productVariantIds: [...input.productVariantIds] } });
    if (this.defer) return { applied: false as const, code: "INVENTORY_PUBLICATION_TARGET_BUSY", message: "busy" };
    return { applied: true as const, targetCount: 1, publicationRows: input.productVariantIds.length, changedProductVariantIds: [...input.productVariantIds], blockedProductIds: [] };
  }
  async listHeldVariants(input: { storeConnectionId: number; productVariantIds: readonly number[] }) {
    this.calls.push({ command: "list", input: { ...input, productVariantIds: [...input.productVariantIds] } });
    return new Map([...this.heldBy].filter(([id]) => input.productVariantIds.includes(id)).map(([id, heldBy]) => [id, { heldBy }]));
  }
}

class FakeSender {
  sent: DropshipNotificationSenderInput[] = [];
  async send(input: DropshipNotificationSenderInput) { this.sent.push(input); }
}

describe("DropshipCostChangeListingActionService", () => {
  let repository: FakeRepository;
  let reprice: FakeReprice;
  let gate: FakeGate;
  let sender: FakeSender;
  let settings: DropshipCostChangePolicySettings;
  let logs: Array<DropshipLogEvent & { level: string }>;
  let service: DropshipCostChangeListingActionService;

  beforeEach(() => {
    repository = new FakeRepository();
    reprice = new FakeReprice();
    gate = new FakeGate();
    sender = new FakeSender();
    settings = { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY };
    logs = [];
    service = new DropshipCostChangeListingActionService({
      repository,
      policy: { resolvePolicy: async () => ({ policyId: 3, settings }) },
      reprice,
      holdGate: gate,
      notificationSender: sender,
      clock: { now: () => NOW },
      logger: {
        info: (event) => logs.push({ ...event, level: "info" }),
        warn: (event) => logs.push({ ...event, level: "warn" }),
        error: (event) => logs.push({ ...event, level: "error" }),
      },
    });
  });

  function vendorFacts(patch: Partial<CostActionVendorFacts> = {}): CostActionVendorFacts {
    const listings = patch.listings ?? [
      listing(1, 61),
      listing(2, 62, { vendorRetailPriceCents: 899 }),
      listing(3, 63, { vendorRetailPriceCents: 1500 }),
      listing(4, 64, { status: "ended" }),
    ];
    return {
      listings,
      // Listing 61 follows the store's rules. Every other listing carries a
      // typed price at its listed amount, the only price the rules leave alone.
      savedPrices: patch.savedPrices ?? [
        { storeConnectionId: 9, productVariantId: 61, overridePriceCents: null, pricingMode: "rules" },
        ...listings.filter((row) => row.productVariantId !== 61 && row.vendorRetailPriceCents !== null)
          .map((row) => ({ storeConnectionId: 9, productVariantId: row.productVariantId, overridePriceCents: row.vendorRetailPriceCents, pricingMode: "fixed" as const })),
      ],
      profiles: patch.profiles ?? new Map([[9, costRules]]),
      layersByStore: patch.layersByStore ?? new Map(),
      candidates: patch.candidates ?? new Map([61, 62, 63, 64].map((id) => [id, candidate(id)])),
      pricingPolicies: patch.pricingPolicies ?? [],
    };
  }

  it("decides every live listing of an increase in force, queues the reprice, tells the vendor once per kind, and records it all", async () => {
    repository.entries = [increase(11, 61), increase(12, 62), increase(13, 63), increase(14, 64)];
    repository.facts.set(5, vendorFacts());

    const result = await service.runListingActionPass({ workerId: "w-1" });

    expect(result).toMatchObject({
      vendorsProcessed: 1, vendorsFailed: 0, entriesDecided: 4, entriesSuperseded: 0, listingsDecided: 4, repriceJobsQueued: 1, holdsPlaced: 0, noticesSent: 2,
      actions: { reprice_queued: 1, below_cost_warned: 1, price_covers_cost: 1, skipped_inactive_listing: 1 },
    });
    expect(reprice.calls).toEqual([{
      vendorId: 5, storeConnectionId: 9, productVariantIds: [61], actorId: "dropship-cost-changes",
      idempotencyKey: costChangeRepriceIdempotencyKey({ vendorId: 5, storeConnectionId: 9, entryIds: [11] }),
    }]);
    expect(sender.sent.map((notice) => [notice.eventType, notice.idempotencyKey, notice.channels, notice.critical])).toEqual([
      ["dropship_cost_change_listings_repriced", `dropship-cost-change-listings:5:repriced:${idSetHash([11])}`, ["email", "in_app"], false],
      ["dropship_cost_change_listings_below_cost", `dropship-cost-change-listings:5:below_cost:${idSetHash([12])}`, ["email", "in_app"], false],
    ]);
    expect(sender.sent[1]!.message).toContain("- SKU-62 (Armor Envelope): listed at USD $8.99, cost now USD $9.99");
    const recorded = repository.recorded[0]!;
    expect(recorded.vendorId).toBe(5);
    expect(recorded.entries.map((entry) => [entry.entryId, entry.listingCount, entry.actionCounts, entry.supersededByEntryId])).toEqual([
      [11, 1, { reprice_queued: 1 }, null], [12, 1, { below_cost_warned: 1 }, null], [13, 1, { price_covers_cost: 1 }, null], [14, 1, { skipped_inactive_listing: 1 }, null],
    ]);
    expect(recorded.listingActions.map((action) => [action.listingId, action.priceSource, action.listingPriceCents, action.action, action.pushJobId, action.detail])).toEqual([
      [1, "rules_cost", 1399, "reprice_queued", 100, null],
      [2, "fixed", 899, "below_cost_warned", null, null],
      [3, "fixed", 1500, "price_covers_cost", null, null],
      [4, "fixed", 1099, "skipped_inactive_listing", null, null],
    ]);
    expect(recorded.listingActions[0]).toMatchObject({ entryId: 11, unitCostCents: 999, policyId: 3, decidedAt: NOW, holdKey: null });
    expect(recorded.holds).toEqual([]);
    expect(logs.find((log) => log.level === "info" && log.code === "DROPSHIP_COST_CHANGE_LISTING_ACTION_PASS_COMPLETED")).toBeDefined();
  });

  it("marks an increase a later one overtook as superseded, judging no listing against it", async () => {
    repository.entries = [increase(11, 61, { inForceEntryId: 15 })];
    repository.facts.set(5, vendorFacts());

    const result = await service.runListingActionPass({ workerId: "w-1" });

    expect(result).toMatchObject({ entriesDecided: 0, entriesSuperseded: 1, listingsDecided: 0, noticesSent: 0 });
    expect(repository.reads.filter((read) => (read as { vendorId?: number }).vendorId === 5)).toEqual([]);
    expect(repository.recorded[0]!.entries).toEqual([{ entryId: 11, productVariantId: 61, listingCount: 0, actionCounts: {}, supersededByEntryId: 15, policyId: 3, decidedAt: NOW }]);
  });

  it("leaves a rule-priced listing for the vendor's review when the policy says so, and asks for the review", async () => {
    settings.rulePricedListings = "wait_for_review";
    repository.entries = [increase(11, 61)];
    repository.facts.set(5, vendorFacts());

    const result = await service.runListingActionPass({ workerId: "w-1" });

    expect(result.actions.awaiting_review).toBe(1);
    expect(reprice.calls).toEqual([]);
    expect(sender.sent.map((notice) => notice.eventType)).toEqual(["dropship_cost_change_listings_review_needed"]);
    expect(sender.sent[0]!.message).toContain("Queue these listings from the Catalog page");
  });

  it("treats rules priced from retail like a typed price: judged against the cost, never repriced", async () => {
    repository.entries = [increase(12, 62)];
    repository.facts.set(5, vendorFacts({
      savedPrices: [{ storeConnectionId: 9, productVariantId: 62, overridePriceCents: null, pricingMode: "rules" }],
      profiles: new Map([[9, retailRules]]),
    }));

    await service.runListingActionPass({ workerId: "w-1" });

    expect(repository.recorded[0]!.listingActions[0]).toMatchObject({ priceSource: "rules_retail", listingPriceCents: 899, action: "below_cost_warned" });
    expect(reprice.calls).toEqual([]);
  });

  it("records an under-water price without a notice when the policy takes no action", async () => {
    settings.belowCostFixedListings = "no_action";
    repository.entries = [increase(12, 62)];
    repository.facts.set(5, vendorFacts());

    const result = await service.runListingActionPass({ workerId: "w-1" });

    expect(result.actions.below_cost_recorded).toBe(1);
    expect(sender.sent).toEqual([]);
  });

  it("pauses under-water listings through the hold gate in command-sized chunks, records the holds, and tells the vendor", async () => {
    settings.belowCostFixedListings = "pause_listing";
    repository.entries = [increase(12, 62), increase(15, 65), increase(16, 66)];
    repository.facts.set(5, vendorFacts({
      listings: [listing(2, 62, { vendorRetailPriceCents: 899 }), listing(5, 65, { vendorRetailPriceCents: 700 }), listing(6, 66, { vendorRetailPriceCents: 500 })],
      candidates: new Map([62, 65, 66].map((id) => [id, candidate(id)])),
    }));

    const result = await service.runListingActionPass({ workerId: "w-1" });

    expect(result).toMatchObject({ holdsPlaced: 3, actions: { below_cost_paused: 3 }, noticesSent: 1 });
    expect(gate.calls.map((call) => [call.command, call.input.productVariantIds, call.input.idempotencyKey])).toEqual([
      ["hold", [62, 65], `dropship-cost-change-hold:9:${idSetHash([12, 15])}:${idSetHash([62, 65])}`],
      ["hold", [66], `dropship-cost-change-hold:9:${idSetHash([16])}:${idSetHash([66])}`],
    ]);
    expect(gate.calls[0]!.input.reason).toBe("Dropship cost change: listing price under the .ops cost");
    const recorded = repository.recorded[0]!;
    expect(recorded.holds.map((hold) => [hold.listingId, hold.listingPriceCents, hold.unitCostCents, hold.holdIdempotencyKey, hold.heldAt])).toEqual([
      [2, 899, 999, `dropship-cost-change-hold:9:${idSetHash([12, 15])}:${idSetHash([62, 65])}`, NOW],
      [5, 700, 999, `dropship-cost-change-hold:9:${idSetHash([12, 15])}:${idSetHash([62, 65])}`, NOW],
      [6, 500, 999, `dropship-cost-change-hold:9:${idSetHash([16])}:${idSetHash([66])}`, NOW],
    ]);
    expect(recorded.listingActions.map((action) => [action.action, action.holdKey])).toEqual([
      ["below_cost_paused", { storeConnectionId: 9, productVariantId: 62 }],
      ["below_cost_paused", { storeConnectionId: 9, productVariantId: 65 }],
      ["below_cost_paused", { storeConnectionId: 9, productVariantId: 66 }],
    ]);
    expect(sender.sent.map((notice) => notice.eventType)).toEqual(["dropship_cost_change_listings_paused"]);
    expect(sender.sent[0]!.title).toBe("3 listings paused: priced under the .ops cost");
  });

  it("retries the whole vendor next pass when inventory planning defers a pause, recording nothing", async () => {
    settings.belowCostFixedListings = "pause_listing";
    gate.defer = true;
    repository.entries = [increase(12, 62)];
    repository.facts.set(5, vendorFacts());

    const result = await service.runListingActionPass({ workerId: "w-1" });

    expect(result).toMatchObject({ vendorsProcessed: 0, vendorsFailed: 1 });
    expect(repository.recorded).toEqual([]);
    expect(sender.sent).toEqual([]);
    expect(logs.find((log) => log.level === "warn")).toMatchObject({
      code: "DROPSHIP_COST_CHANGE_LISTING_ACTION_VENDOR_FAILED",
      context: { vendorId: 5, classification: "transient", errorCode: "DROPSHIP_COST_CHANGE_HOLD_DEFERRED", entryIds: [12] },
    });
  });

  it("refuses to pause without a hold gate rather than pretend", async () => {
    settings.belowCostFixedListings = "pause_listing";
    const ungated = new DropshipCostChangeListingActionService({
      repository, policy: { resolvePolicy: async () => ({ policyId: 3, settings }) }, reprice, notificationSender: sender,
      clock: { now: () => NOW }, logger: { info: () => undefined, warn: (event) => logs.push({ ...event, level: "warn" }), error: () => undefined },
    });
    repository.entries = [increase(12, 62)];
    repository.facts.set(5, vendorFacts());

    const result = await ungated.runListingActionPass({ workerId: "w-1" });

    expect(result.vendorsFailed).toBe(1);
    expect(logs[0]?.context).toMatchObject({ errorCode: "DROPSHIP_COST_CHANGE_HOLD_GATE_MISSING", classification: "fatal" });
  });

  it("records a reprice the store cannot take as refused, with the reason, and sends no reprice notice", async () => {
    reprice.refuse = { code: "DROPSHIP_LISTING_STORE_BLOCKED", message: "Your store setup isn't finished." };
    repository.entries = [increase(11, 61)];
    repository.facts.set(5, vendorFacts());

    const result = await service.runListingActionPass({ workerId: "w-1" });

    expect(result).toMatchObject({ actions: { reprice_refused: 1, reprice_queued: 0 }, repriceJobsQueued: 0, noticesSent: 0 });
    expect(repository.recorded[0]!.listingActions[0]).toMatchObject({ action: "reprice_refused", detail: "DROPSHIP_LISTING_STORE_BLOCKED", pushJobId: null });
    expect(repository.recorded[0]!.entries[0]!.actionCounts).toEqual({ reprice_refused: 1 });
  });

  it("counts a replayed reprice job as nothing new, and still names it on the action", async () => {
    reprice.replay = true;
    repository.entries = [increase(11, 61)];
    repository.facts.set(5, vendorFacts());

    const result = await service.runListingActionPass({ workerId: "w-1" });

    expect(result.repriceJobsQueued).toBe(0);
    expect(repository.recorded[0]!.listingActions[0]).toMatchObject({ action: "reprice_queued", pushJobId: 100 });
  });

  it("sends nothing when the policy sends on no channel, and still records the actions", async () => {
    settings.notifyByEmail = false;
    settings.notifyInPortal = false;
    repository.entries = [increase(11, 61), increase(12, 62)];
    repository.facts.set(5, vendorFacts());

    const result = await service.runListingActionPass({ workerId: "w-1" });

    expect(result.noticesSent).toBe(0);
    expect(sender.sent).toEqual([]);
    expect(repository.recorded[0]!.listingActions).toHaveLength(2);
  });

  it("fails a vendor whose notice cannot be sent because no sender is wired", async () => {
    const silent = new DropshipCostChangeListingActionService({
      repository, policy: { resolvePolicy: async () => ({ policyId: 3, settings }) }, reprice, holdGate: gate,
      clock: { now: () => NOW }, logger: { info: () => undefined, warn: (event) => logs.push({ ...event, level: "warn" }), error: () => undefined },
    });
    repository.entries = [increase(11, 61)];
    repository.facts.set(5, vendorFacts());

    const result = await silent.runListingActionPass({ workerId: "w-1" });

    expect(result.vendorsFailed).toBe(1);
    expect(repository.recorded).toEqual([]);
    expect(logs[0]?.context).toMatchObject({ errorCode: "DROPSHIP_COST_CHANGE_NOTICE_SENDER_MISSING" });
  });

  it("keeps one vendor's failure from the others", async () => {
    repository.entries = [increase(11, 61), { ...increase(21, 71), vendorId: 6 }];
    repository.facts.set(5, vendorFacts());
    repository.facts.set(6, vendorFacts({ listings: [listing(7, 71, { vendorRetailPriceCents: 1500 })], candidates: new Map([[71, candidate(71)]]) }));
    reprice.refuse = null;
    repository.failRecording = false;
    // Vendor 5's reprice port throws (transient outage); vendor 6 needs no push.
    reprice.queueReprice = async () => { throw new Error("preview provider down"); };

    const result = await service.runListingActionPass({ workerId: "w-1" });

    expect(result).toMatchObject({ vendorsProcessed: 1, vendorsFailed: 1 });
    expect(repository.recorded.map((record) => record.vendorId)).toEqual([6]);
  });

  it("does nothing, quietly, when no increase is waiting and no hold is live", async () => {
    const result = await service.runListingActionPass({ workerId: "w-1" });
    expect(result).toMatchObject({ vendorsProcessed: 0, entriesDecided: 0, holds: { reviewed: 0 }, rechecks: { rechecked: 0 } });
    // The recheck reads first, bounded like the increases.
    expect(repository.reads).toEqual([
      { rechecks: { now: NOW, limit: DEFAULT_COST_LISTING_ACTION_ENTRIES_PER_PASS } },
      { now: NOW, limit: DEFAULT_COST_LISTING_ACTION_ENTRIES_PER_PASS },
    ]);
    expect(logs).toEqual([]);
  });

  it("pages listing actions newest first before a cursor, one more than the page telling whether more exist", async () => {
    const view = (actionId: number): DropshipCostChangeListingActionView => ({
      actionId, entryId: 11, listingId: 1, storeConnectionId: 9, platform: "shopify", productVariantId: 61, productId: 1, variantSku: "SKU-61", variantName: "Variant 61",
      productName: "Armor Envelope", action: "reprice_queued", detail: null, listingPriceCents: 1399, unitCostCents: 999, pushJobId: 100, decidedAt: NOW,
      holdReleasedAt: null, holdReleaseReason: null, vendorId: 5, vendorBusinessName: "Shellz Vendor", listingStatus: "active", priceSource: "rules_cost", policyId: 3,
    });
    repository.views = [view(33), view(32), view(31)];

    const page = await service.listListingActions({ limit: 2, beforeId: 40 });

    expect(repository.reads).toEqual([{ limit: 3, beforeId: 40 }]);
    expect(page).toEqual({ items: [view(33), view(32)], nextBeforeId: 32, generatedAt: NOW });
    expect((await service.listListingActions({ limit: 3 })).nextBeforeId).toBeNull();
    await expect(service.listListingActions({ limit: 0 })).rejects.toMatchObject({ code: "DROPSHIP_COST_CHANGE_INVALID_INPUT" });
  });

  it("refuses input outside its contract", async () => {
    await expect(service.runListingActionPass({ workerId: "" })).rejects.toMatchObject({ code: "DROPSHIP_COST_CHANGE_INVALID_INPUT" });
    await expect(service.runListingActionPass({ workerId: "w-1", entriesPerPass: 501 })).rejects.toMatchObject({ code: "DROPSHIP_COST_CHANGE_INVALID_INPUT" });
    await expect(service.runListingActionPass({ workerId: "w-1", extra: 1 })).rejects.toMatchObject({ code: "DROPSHIP_COST_CHANGE_INVALID_INPUT" });
  });

  describe("hold review", () => {
    function hold(holdId: number, listingId: number, productVariantId: number): ActiveCostChangeListingHold {
      return { holdId, vendorId: 5, storeConnectionId: 9, productVariantId, listingId, entryId: 10 + holdId, listingPriceCents: 899, unitCostCents: 999, heldAt: EFFECTIVE };
    }

    it("releases a hold of ours once the price covers the cost in force, and tells the vendor the listing sells again", async () => {
      repository.activeHolds = [hold(1, 2, 62)];
      repository.facts.set(5, vendorFacts({ listings: [listing(2, 62, { vendorRetailPriceCents: 1099, publishedPriceCents: 1099 })], candidates: new Map([[62, candidate(62)]]) }));
      repository.costs.set(62, 999);
      gate.heldBy.set(62, COST_CHANGE_HOLD_ACTOR_ID);

      const result = await service.runListingActionPass({ workerId: "w-1" });

      expect(result.holds).toEqual({ restored: 0, reviewed: 1, released: 1, reasserted: 0, deferred: 0, vendorsFailed: 0, noticesSent: 1 });
      expect(gate.calls.map((call) => call.command)).toEqual(["list", "release"]);
      expect(gate.calls[1]!.input).toMatchObject({ storeConnectionId: 9, productVariantIds: [62], idempotencyKey: `dropship-cost-change-release:9:${idSetHash([1])}` });
      expect(repository.released).toEqual([{ holdIds: [1], reason: "price_covers_cost", detail: "released", releasedAt: NOW, releaseIdempotencyKey: `dropship-cost-change-release:9:${idSetHash([1])}` }]);
      expect(sender.sent.map((notice) => [notice.eventType, notice.idempotencyKey])).toEqual([
        ["dropship_cost_change_listings_resumed", `dropship-cost-change-listings:5:resumed:${idSetHash([1])}`],
      ]);
    });

    it("puts back a pause released while a push had demoted a live listing, before the review judges it", async () => {
      repository.restoredHolds = [{ holdId: 7, releasedHoldId: 3, vendorId: 5, storeConnectionId: 9, productVariantId: 62, listingId: 2,
        entryId: 13, releasedAt: EFFECTIVE, basisJobItemId: 40, demotingJobItemId: 41 }];
      repository.facts.set(5, vendorFacts({ listings: [listing(2, 62, { vendorRetailPriceCents: 899 })], candidates: new Map([[62, candidate(62)]]) }));
      repository.costs.set(62, 999);

      const result = await service.runListingActionPass({ workerId: "w-1" });

      expect(repository.order).toEqual(["restore", "listActiveHolds"]);
      expect(repository.restoreCalls).toEqual([{ now: NOW, workerId: "w-1", limit: expect.any(Number) }]);
      // Still under water: kept, and re-asserted at inventory planning because the wrongful release removed it there.
      expect(result.holds).toMatchObject({ restored: 1, reviewed: 1, released: 0, reasserted: 1 });
      expect(gate.calls.map((call) => call.command)).toEqual(["list", "hold"]);
      // Kept, so the vendor is told the listing is paused again (once, keyed by the put-back hold).
      expect(sender.sent.map((notice) => [notice.eventType, notice.idempotencyKey, notice.payload?.holdIds])).toEqual([
        ["dropship_cost_change_listings_paused", costChangeListingFollowUpNoticeIdempotencyKey({ vendorId: 5, kind: "paused", basis: "restored_hold", ids: [7] }), [7]],
      ]);
      expect(result.holds.noticesSent).toBe(1);
      expect(logs.find((event) => event.code === "DROPSHIP_COST_CHANGE_HOLD_RESTORED")).toMatchObject({
        level: "warn",
        context: { holdId: 7, releasedHoldId: 3, listingId: 2, basisJobItemId: 40, demotingJobItemId: 41,
          before: { holdId: null }, after: { holdId: 7 }, outcome: "restored" },
      });
    });

    it("still reviews the live holds when putting pauses back fails, and logs the failure for a human", async () => {
      repository.restoreError = new Error("database unavailable");
      repository.activeHolds = [hold(1, 2, 62)];
      repository.facts.set(5, vendorFacts({ listings: [listing(2, 62, { vendorRetailPriceCents: 1099, publishedPriceCents: 1099 })], candidates: new Map([[62, candidate(62)]]) }));
      repository.costs.set(62, 999);
      gate.heldBy.set(62, COST_CHANGE_HOLD_ACTOR_ID);

      const result = await service.runListingActionPass({ workerId: "w-1" });

      expect(result.holds).toMatchObject({ restored: 0, reviewed: 1, released: 1 });
      expect(logs.find((event) => event.code === "DROPSHIP_COST_CHANGE_HOLD_RESTORE_FAILED")).toMatchObject({
        level: "error", context: { outcome: "failed", error: "database unavailable" },
      });
    });

    it("never takes a hold another actor now owns, and needs no command for one already gone", async () => {
      repository.activeHolds = [hold(1, 2, 62), hold(2, 5, 65)];
      repository.facts.set(5, vendorFacts({
        listings: [listing(2, 62, { vendorRetailPriceCents: 1099, publishedPriceCents: 1099 }), listing(5, 65, { status: "ended" })],
        candidates: new Map([[62, candidate(62)], [65, candidate(65)]]),
      }));
      repository.costs.set(62, 999);
      gate.heldBy.set(62, "dropship-listing-tiers");

      const result = await service.runListingActionPass({ workerId: "w-1" });

      expect(result.holds).toMatchObject({ reviewed: 2, released: 2, deferred: 0 });
      expect(gate.calls.map((call) => call.command)).toEqual(["list"]);
      expect(repository.released.map((release) => [release.holdIds, release.reason, release.detail])).toEqual([
        [[1], "price_covers_cost", "held_by_other"],
        [[2], "listing_inactive", "not_held"],
      ]);
    });

    it("keeps a hold whose price is still under water, and puts it back when inventory planning no longer carries it", async () => {
      repository.activeHolds = [hold(1, 2, 62)];
      repository.facts.set(5, vendorFacts({ listings: [listing(2, 62, { vendorRetailPriceCents: 899 })], candidates: new Map([[62, candidate(62)]]) }));
      repository.costs.set(62, 999);

      const result = await service.runListingActionPass({ workerId: "w-1" });

      expect(result.holds).toMatchObject({ reviewed: 1, released: 0, reasserted: 1 });
      expect(gate.calls.map((call) => call.command)).toEqual(["list", "hold"]);
      expect(gate.calls[1]!.input.idempotencyKey).toBe(`dropship-cost-change-hold:9:reassert:${idSetHash([1])}:${NOW.toISOString()}`);
      expect(repository.released).toEqual([]);
      expect(sender.sent).toEqual([]);
    });

    it("keeps a below-cost hold while a publish run re-sends the listing that eBay still lists (review MC1)", async () => {
      // A run queued the listing (status `queued`) and kept its eBay id: orders are accepted on it, so it stays held.
      repository.activeHolds = [hold(1, 2, 62)];
      repository.facts.set(5, vendorFacts({
        listings: [listing(2, 62, { status: "queued", externalListingId: "v1|62|0", vendorRetailPriceCents: 899 })],
        candidates: new Map([[62, candidate(62)]]),
      }));
      repository.costs.set(62, 999);
      gate.heldBy.set(62, COST_CHANGE_HOLD_ACTOR_ID);

      const result = await service.runListingActionPass({ workerId: "w-1" });

      expect(result.holds).toMatchObject({ reviewed: 1, released: 0, deferred: 0 });
      expect(gate.calls.map((call) => call.command)).toEqual(["list"]);
      expect(repository.released).toEqual([]);
    });

    it("keeps the hold while the re-sent listing's covering price has not reached eBay, and releases it once a push completes (review round 2 MC2)", async () => {
      // The vendor raised the price to $10 and pressed Publish: the queue wrote 1000 into the listing row, but the push
      // has not completed, so eBay may still sell at the old price below the $9.99 cost. The row reads `queued` with its
      // eBay id, as rows written before PR 1b's guards do (since them a queue, a failure, a Stop and the breaker keep a
      // live listing's status; a listing that stays `active` keeps its hold through the published-price check).
      repository.activeHolds = [hold(1, 2, 62)];
      repository.facts.set(5, vendorFacts({
        // eBay still shows the price its last completed push published, below the cost (PR 1b's published price).
        listings: [listing(2, 62, { status: "queued", externalListingId: "v1|62|0", vendorRetailPriceCents: 1000, publishedPriceCents: 899 })],
        candidates: new Map([[62, candidate(62)]]),
      }));
      repository.costs.set(62, 999);
      gate.heldBy.set(62, COST_CHANGE_HOLD_ACTOR_ID);

      const held = await service.runListingActionPass({ workerId: "w-1" });
      expect(held.holds).toMatchObject({ reviewed: 1, released: 0 });
      expect(gate.calls.map((call) => call.command)).toEqual(["list"]);
      expect(repository.released).toEqual([]);

      // The push completed: the listing is active at the price eBay accepted, which covers the cost. Since PR 1b a
      // release needs that published price too (completeItem writes it on the listing_push_completed sync event).
      repository.facts.set(5, vendorFacts({
        listings: [listing(2, 62, { status: "active", externalListingId: "v1|62|0", vendorRetailPriceCents: 1000, publishedPriceCents: 1000 })],
        candidates: new Map([[62, candidate(62)]]),
      }));
      const released = await service.runListingActionPass({ workerId: "w-1" });
      expect(released.holds).toMatchObject({ reviewed: 1, released: 1 });
    });

    it("keeps a hold when the cost in force is unknown, and counts a deferred release for the next pass", async () => {
      repository.activeHolds = [hold(1, 2, 62), hold(2, 5, 65)];
      repository.facts.set(5, vendorFacts({
        listings: [listing(2, 62, { vendorRetailPriceCents: 1099, publishedPriceCents: 1099 }), listing(5, 65, { vendorRetailPriceCents: 1099, publishedPriceCents: 1099 })],
        candidates: new Map([[62, candidate(62)], [65, candidate(65)]]),
      }));
      repository.costs.set(62, 999);
      gate.heldBy.set(62, COST_CHANGE_HOLD_ACTOR_ID);
      gate.heldBy.set(65, COST_CHANGE_HOLD_ACTOR_ID);
      gate.defer = true;

      const result = await service.runListingActionPass({ workerId: "w-1" });

      expect(result.holds).toMatchObject({ reviewed: 2, released: 0, deferred: 1, reasserted: 0 });
      expect(repository.released).toEqual([]);
    });

    it("reads holds bounded by the pass size", async () => {
      repository.activeHolds = Array.from({ length: DEFAULT_COST_LISTING_HOLDS_PER_PASS + 1 }, (_, index) => hold(index + 1, index + 1, 1000 + index));
      repository.facts.set(5, vendorFacts({ listings: [], candidates: new Map() }));
      const result = await service.runListingActionPass({ workerId: "w-1", holdsPerPass: 3 });
      expect(result.holds.reviewed).toBe(3);
    });

    it("keeps a pause while the price that covers the cost is saved but not yet published, and releases it once it is", async () => {
      repository.activeHolds = [hold(1, 2, 62)];
      // The vendor saved $15 and queued it; the push failed, so eBay still shows $8.99 (part A keeps the listing active).
      repository.facts.set(5, vendorFacts({ listings: [listing(2, 62, { vendorRetailPriceCents: 1500, publishedPriceCents: 899 })], candidates: new Map([[62, candidate(62)]]) }));
      repository.costs.set(62, 999);
      gate.heldBy.set(62, COST_CHANGE_HOLD_ACTOR_ID);

      const kept = await service.runListingActionPass({ workerId: "w-1" });
      expect(kept.holds).toMatchObject({ reviewed: 1, released: 0 });
      expect(repository.released).toEqual([]);

      repository.facts.set(5, vendorFacts({ listings: [listing(2, 62, { vendorRetailPriceCents: 1500, publishedPriceCents: 1500 })], candidates: new Map([[62, candidate(62)]]) }));
      const released = await service.runListingActionPass({ workerId: "w-1" });
      expect(released.holds).toMatchObject({ reviewed: 1, released: 1 });
      // The resumed notice names the price buyers see.
      expect(sender.sent.find((notice) => notice.eventType === "dropship_cost_change_listings_resumed")!.message).toContain("listed at USD $15.00");
    });

    it("keeps a pause when a lower price is queued to replace a published one that covers the cost, or when no published price is on record", async () => {
      repository.activeHolds = [hold(1, 2, 62), hold(2, 5, 65)];
      repository.facts.set(5, vendorFacts({
        listings: [listing(2, 62, { vendorRetailPriceCents: 899, publishedPriceCents: 1500 }), listing(5, 65, { vendorRetailPriceCents: 1500, publishedPriceCents: null })],
        candidates: new Map([[62, candidate(62)], [65, candidate(65)]]),
      }));
      repository.costs.set(62, 999);
      repository.costs.set(65, 999);
      gate.heldBy.set(62, COST_CHANGE_HOLD_ACTOR_ID);
      gate.heldBy.set(65, COST_CHANGE_HOLD_ACTOR_ID);

      const result = await service.runListingActionPass({ workerId: "w-1" });

      expect(result.holds).toMatchObject({ reviewed: 2, released: 0 });
      expect(repository.released).toEqual([]);
    });
  });

  describe("judged at the published price", () => {
    it("judges a live listing at the lower of its settings price and the price its last push published", async () => {
      settings = { ...settings, belowCostFixedListings: "pause_listing" };
      repository.entries = [increase(12, 62), increase(13, 63)];
      repository.facts.set(5, vendorFacts({
        listings: [
          // A raise to $15 is saved and queued but its push failed: eBay shows $8.99, so it is under water now.
          listing(2, 62, { vendorRetailPriceCents: 1500, publishedPriceCents: 899 }),
          // Nothing published on record: judged at its settings price, as before.
          listing(3, 63, { vendorRetailPriceCents: 1500, publishedPriceCents: null }),
        ],
        candidates: new Map([[62, candidate(62)], [63, candidate(63)]]),
      }));

      const result = await service.runListingActionPass({ workerId: "w-1" });

      expect(result.actions).toMatchObject({ below_cost_paused: 1, price_covers_cost: 1 });
      expect(repository.recorded[0]!.listingActions.map((action) => [action.listingId, action.action, action.listingPriceCents])).toEqual([
        [2, "below_cost_paused", 899], [3, "price_covers_cost", 1500],
      ]);
      expect(repository.recorded[0]!.holds.map((row) => [row.listingId, row.listingPriceCents, row.unitCostCents])).toEqual([[2, 899, 999]]);
    });
  });

  describe("recheck of increases skipped while a live listing read as not live", () => {
    function skipped(actionId: number, listingId: number, productVariantId: number, patch: Partial<SkippedListingRecheckCandidate> = {}): SkippedListingRecheckCandidate {
      return { actionId, skippedListingStatus: "failed", listingId, storeConnectionId: 9, increase: increase(20 + actionId, productVariantId), ...patch };
    }

    it("judges each once through the first decision's paths, keyed by the skipped actions, and records it with its holds", async () => {
      settings = { ...settings, belowCostFixedListings: "pause_listing" };
      repository.rechecks = [skipped(1, 1, 61), skipped(2, 2, 62), skipped(3, 3, 63)];
      repository.facts.set(5, vendorFacts({
        listings: [listing(1, 61), listing(2, 62, { vendorRetailPriceCents: 899, publishedPriceCents: 899 }), listing(3, 63, { vendorRetailPriceCents: 1500, publishedPriceCents: 1500 })],
      }));

      const result = await service.runListingActionPass({ workerId: "w-1" });

      expect(result.rechecks).toEqual({ rechecked: 3, vendorsFailed: 0, repriceJobsQueued: 1, holdsPlaced: 1, noticesSent: 2 });
      expect(reprice.calls).toEqual([{ vendorId: 5, storeConnectionId: 9, productVariantIds: [61], actorId: "dropship-cost-changes",
        idempotencyKey: costChangeRecheckRepriceIdempotencyKey({ vendorId: 5, storeConnectionId: 9, actionIds: [1] }) }]);
      expect(gate.calls.filter((call) => call.command === "hold").map((call) => call.input.idempotencyKey))
        .toEqual([costChangeRecheckHoldIdempotencyKey({ storeConnectionId: 9, actionIds: [2], productVariantIds: [62] })]);
      expect(sender.sent.map((notice) => [notice.eventType, notice.idempotencyKey])).toEqual([
        ["dropship_cost_change_listings_repriced", costChangeListingFollowUpNoticeIdempotencyKey({ vendorId: 5, kind: "repriced", basis: "recheck", ids: [1] })],
        ["dropship_cost_change_listings_paused", costChangeListingFollowUpNoticeIdempotencyKey({ vendorId: 5, kind: "paused", basis: "recheck", ids: [2] })],
      ]);
      expect(sender.sent[1]!.payload).toMatchObject({ entryIds: [22], recheckedActionIds: [2] });
      const recorded = repository.recordedRechecks[0]!;
      expect(recorded.rechecks.map((row) => [row.actionId, row.entryId, row.skippedListingStatus, row.listingStatus, row.action, row.listingPriceCents,
        row.pushJobId, row.holdKey])).toEqual([
        [1, 21, "failed", "active", "reprice_queued", 1399, 100, null],
        [2, 22, "failed", "active", "below_cost_paused", 899, null, { storeConnectionId: 9, productVariantId: 62 }],
        [3, 23, "failed", "active", "price_covers_cost", 1500, null, null],
      ]);
      expect(recorded.holds.map((row) => [row.listingId, row.entryId, row.listingPriceCents, row.unitCostCents, row.holdIdempotencyKey]))
        .toEqual([[2, 22, 899, 999, costChangeRecheckHoldIdempotencyKey({ storeConnectionId: 9, actionIds: [2], productVariantIds: [62] })]]);
      expect(logs.filter((event) => event.code === "DROPSHIP_COST_CHANGE_LISTING_RECHECKED").map((event) => [event.level, event.context?.actionId,
        event.context?.before, event.context?.after])).toEqual([
        ["warn", 1, { action: "skipped_inactive_listing", listingStatus: "failed" }, { action: "reprice_queued", listingStatus: "active" }],
        ["warn", 2, { action: "skipped_inactive_listing", listingStatus: "failed" }, { action: "below_cost_paused", listingStatus: "active" }],
        ["warn", 3, { action: "skipped_inactive_listing", listingStatus: "failed" }, { action: "price_covers_cost", listingStatus: "active" }],
      ]);

      // Recorded rechecks are not selected again.
      const rerun = await service.runListingActionPass({ workerId: "w-1" });
      expect(rerun.rechecks.rechecked).toBe(0);
    });

    it("leaves a listing that is no longer active for a later pass, and keeps one vendor's failure from the others", async () => {
      repository.rechecks = [skipped(1, 2, 62), skipped(2, 7, 71, { increase: increase(30, 71, { vendorId: 6 }) })];
      repository.facts.set(5, vendorFacts({ listings: [listing(2, 62, { status: "queued" })] }));
      repository.facts.set(6, vendorFacts({ listings: [listing(7, 71, { vendorRetailPriceCents: 899, publishedPriceCents: 899 })], candidates: new Map([[71, candidate(71)]]) }));
      repository.failRecheckRecording = true;

      const result = await service.runListingActionPass({ workerId: "w-1" });

      expect(result.rechecks).toMatchObject({ rechecked: 0, vendorsFailed: 1 });
      expect(logs.find((event) => event.code === "DROPSHIP_COST_CHANGE_RECHECK_VENDOR_FAILED")).toMatchObject({
        level: "warn", context: { vendorId: 6, actionIds: [2], error: "recheck record failed" },
      });
      // Vendor 5's listing is queued again now: nothing recorded, so it is judged once it is live.
      expect(repository.recordedRechecks).toEqual([]);
      expect(repository.rechecks.map((candidate) => candidate.actionId)).toEqual([1, 2]);
    });
  });
});

describe("classifyListing", () => {
  it("prices a rule-priced listing at the cost being judged, not at what it sold for", () => {
    const facts: CostActionVendorFacts = {
      listings: [], savedPrices: [{ storeConnectionId: 9, productVariantId: 61, overridePriceCents: null, pricingMode: "rules" }],
      profiles: new Map([[9, costRules]]), layersByStore: new Map(), candidates: new Map([[61, candidate(61)]]), pricingPolicies: [],
    };
    expect(classifyListing(facts, listing(1, 61), 999)).toEqual({ source: "rules_cost", priceCents: 1399, followsCost: true });
    expect(classifyListing({ ...facts, profiles: new Map() }, listing(1, 61), 999)).toEqual({ source: "unavailable", priceCents: null, followsCost: false });
  });

  it("puts an inherit listing on its retail price when a blocking Card Shellz limit refuses the rule price at the new cost (L1)", () => {
    const ceiling = (mode: DropshipPricingPolicyRecord["mode"]): DropshipPricingPolicyRecord => ({ id: 3, scopeType: "catalog",
      productLineId: null, productId: null, productVariantId: null, category: null, mode, floorPriceCents: null, ceilingPriceCents: 1200 });
    const facts: CostActionVendorFacts = {
      listings: [], savedPrices: [{ storeConnectionId: 9, productVariantId: 61, overridePriceCents: null, pricingMode: "inherit" }],
      profiles: new Map([[9, costRules]]), layersByStore: new Map(), candidates: new Map([[61, candidate(61)]]),
      pricingPolicies: [ceiling("block_listing_push")],
    };
    // $13.99 at the new cost is above the $12.00 maximum, so the listing is priced, and judged, at its $8.99 retail price.
    expect(classifyListing(facts, listing(1, 61), 999)).toEqual({ source: "catalog_default", priceCents: 899, followsCost: false });
    // A warn-only limit does not stop the rule price; a "rules" listing keeps it whatever the limit.
    expect(classifyListing({ ...facts, pricingPolicies: [ceiling("warn_only")] }, listing(1, 61), 999))
      .toEqual({ source: "rules_cost", priceCents: 1399, followsCost: true });
    expect(classifyListing({ ...facts, savedPrices: [{ ...facts.savedPrices[0], pricingMode: "rules" }] }, listing(1, 61), 999))
      .toEqual({ source: "rules_cost", priceCents: 1399, followsCost: true });
    // Below the maximum the rule price is usable again.
    expect(classifyListing(facts, listing(1, 61), 800)).toEqual({ source: "rules_cost", priceCents: 1120, followsCost: true });
  });

  /** One product's own price, or with `categoryId` that category's, as the listing settings layers hold it (no other setting). */
  function priceLayers(productId: number, price: PricingRecipe, categoryId?: number): ListingSettingLayers {
    const values = { price, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
      textAbove: null, textBelow: null };
    return {
      products: categoryId === undefined
        ? new Map([[productId, { storeConnectionId: 9, productId, revisionId: 1, updatedAt: EFFECTIVE.toISOString(), values: { ...values, mainText: null } }]])
        : new Map(),
      categories: categoryId === undefined
        ? new Map()
        : new Map([[categoryId, { storeConnectionId: 9, categoryId, revisionId: 1, updatedAt: EFFECTIVE.toISOString(), values }]]),
    };
  }

  it("classifies a listing in a store with no pricing rules on its product's own price, following the cost when that price does", () => {
    const facts: CostActionVendorFacts = {
      listings: [], savedPrices: [{ storeConnectionId: 9, productVariantId: 61, overridePriceCents: null, pricingMode: "rules" }],
      profiles: new Map(), candidates: new Map([[61, candidate(61)]]), pricingPolicies: [],
      layersByStore: new Map([[9, priceLayers(1, { basis: "product_cost", markupBps: 5000, flatCents: 0, rounding: "cent" })]]),
    };
    // $9.99 + 50% = $14.985, rounded half-up.
    expect(classifyListing(facts, listing(1, 61), 999)).toEqual({ source: "rules_cost", priceCents: 1499, followsCost: true });
    // Without the product's price the store has no rules at all.
    expect(classifyListing({ ...facts, layersByStore: new Map() }, listing(1, 61), 999))
      .toEqual({ source: "unavailable", priceCents: null, followsCost: false });
    // Another store's settings never price this store's listing.
    expect(classifyListing({ ...facts, layersByStore: new Map([[10, facts.layersByStore.get(9)!]]) }, listing(1, 61), 999))
      .toEqual({ source: "unavailable", priceCents: null, followsCost: false });
  });

  it("classifies a category's retail-based price as not following the cost, and the product's own price beats the store's rules", () => {
    const retailCategory = priceLayers(1, { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" }, 4);
    const inCategory = { ...candidate(61), categoryId: 4 };
    const facts: CostActionVendorFacts = {
      listings: [], savedPrices: [{ storeConnectionId: 9, productVariantId: 61, overridePriceCents: null, pricingMode: "rules" }],
      profiles: new Map(), candidates: new Map([[61, inCategory]]), pricingPolicies: [], layersByStore: new Map([[9, retailCategory]]),
    };
    expect(classifyListing(facts, listing(1, 61), 999)).toEqual({ source: "rules_retail", priceCents: 899, followsCost: false });
    // A size with no Card Shellz category ignores the category's price.
    expect(classifyListing({ ...facts, candidates: new Map([[61, candidate(61)]]) }, listing(1, 61), 999))
      .toEqual({ source: "unavailable", priceCents: null, followsCost: false });
    const ownPrice = priceLayers(1, { basis: "catalog_retail", markupBps: 1000, flatCents: 0, rounding: "cent" });
    expect(classifyListing({ ...facts, profiles: new Map([[9, costRules]]), layersByStore: new Map([[9, ownPrice]]) }, listing(1, 61), 999))
      .toEqual({ source: "rules_retail", priceCents: 989, followsCost: false });
  });
});

describe("buildCostChangeListingNotice", () => {
  it("lists the first listings and counts the rest", () => {
    const rows = Array.from({ length: COST_LISTING_NOTICE_LISTED + 2 }, (_, index) => ({ listing: listing(index + 1, 60 + index), listingPriceCents: 899, unitCostCents: 999 }));
    const notice = buildCostChangeListingNotice({ kind: "below_cost", listings: rows });
    expect(notice.title).toBe(`${COST_LISTING_NOTICE_LISTED + 2} listings priced under the new .ops cost`);
    expect(notice.message.split("\n").filter((line) => line.startsWith("- SKU-"))).toHaveLength(COST_LISTING_NOTICE_LISTED);
    expect(notice.message).toContain("- and 2 more");
    expect((notice.payload.listings as unknown[])).toHaveLength(COST_LISTING_NOTICE_LISTED + 2);
    expect(() => buildCostChangeListingNotice({ kind: "paused", listings: [] })).toThrow(RangeError);
  });
});
