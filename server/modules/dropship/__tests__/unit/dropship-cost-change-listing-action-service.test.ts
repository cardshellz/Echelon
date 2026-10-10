import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DROPSHIP_COST_CHANGE_POLICY, type DropshipCostChangePolicySettings } from "../../../../../shared/dropship/cost-change-policy";
import type { PricingProfileState } from "../../../../../shared/dropship/pricing-rules";
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
  type NewCostChangeListingHold,
} from "../../application/dropship-cost-change-listing-action-service";
import type { DropshipPricingPolicyRecord } from "../../application/dropship-listing-preview-service";
import type { DropshipLogEvent, DropshipNotificationSenderInput } from "../../application/dropship-ports";
import { costChangeRepriceIdempotencyKey, idSetHash } from "../../domain/cost-change-listing-action";

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
    listingId, storeConnectionId: 9, productVariantId, status: "active", vendorRetailPriceCents: 1099, platform: "shopify",
    variantSku: `SKU-${productVariantId}`, variantName: `Variant ${productVariantId}`, productName: "Armor Envelope", ...patch,
  };
}

function candidate(productVariantId: number) {
  return { productVariantId, productId: 1, category: null, productLineIds: [], defaultRetailPriceCents: 899 };
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
    const facts = this.facts.get(input.vendorId) ?? { listings: [], savedPrices: [], profiles: new Map(), candidates: new Map(), pricingPolicies: [] };
    return { ...facts, listings: facts.listings.filter((row) => input.productVariantIds.includes(row.productVariantId)) };
  }
  async recordEntryActions(input: { vendorId: number; entries: readonly CostChangeEntryActionRecord[]; listingActions: readonly CostChangeListingActionRecord[]; holds: readonly NewCostChangeListingHold[] }) {
    if (this.failRecording) throw new Error("record failed");
    this.recorded.push({ vendorId: input.vendorId, entries: [...input.entries], listingActions: [...input.listingActions], holds: [...input.holds] });
    return { entriesRecorded: input.entries.length, listingActionsRecorded: input.listingActions.length, holdsRecorded: input.holds.length };
  }
  async listActiveHolds(input: { limit: number }) { return this.activeHolds.slice(0, input.limit); }
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
    expect(result).toMatchObject({ vendorsProcessed: 0, entriesDecided: 0, holds: { reviewed: 0 } });
    expect(repository.reads).toEqual([{ now: NOW, limit: DEFAULT_COST_LISTING_ACTION_ENTRIES_PER_PASS }]);
    expect(logs).toEqual([]);
  });

  it("pages listing actions newest first before a cursor, one more than the page telling whether more exist", async () => {
    const view = (actionId: number): DropshipCostChangeListingActionView => ({
      actionId, entryId: 11, listingId: 1, storeConnectionId: 9, platform: "shopify", productVariantId: 61, variantSku: "SKU-61", variantName: "Variant 61",
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
      repository.facts.set(5, vendorFacts({ listings: [listing(2, 62, { vendorRetailPriceCents: 1099 })], candidates: new Map([[62, candidate(62)]]) }));
      repository.costs.set(62, 999);
      gate.heldBy.set(62, COST_CHANGE_HOLD_ACTOR_ID);

      const result = await service.runListingActionPass({ workerId: "w-1" });

      expect(result.holds).toEqual({ reviewed: 1, released: 1, reasserted: 0, deferred: 0, vendorsFailed: 0, noticesSent: 1 });
      expect(gate.calls.map((call) => call.command)).toEqual(["list", "release"]);
      expect(gate.calls[1]!.input).toMatchObject({ storeConnectionId: 9, productVariantIds: [62], idempotencyKey: `dropship-cost-change-release:9:${idSetHash([1])}` });
      expect(repository.released).toEqual([{ holdIds: [1], reason: "price_covers_cost", detail: "released", releasedAt: NOW, releaseIdempotencyKey: `dropship-cost-change-release:9:${idSetHash([1])}` }]);
      expect(sender.sent.map((notice) => [notice.eventType, notice.idempotencyKey])).toEqual([
        ["dropship_cost_change_listings_resumed", `dropship-cost-change-listings:5:resumed:${idSetHash([1])}`],
      ]);
    });

    it("never takes a hold another actor now owns, and needs no command for one already gone", async () => {
      repository.activeHolds = [hold(1, 2, 62), hold(2, 5, 65)];
      repository.facts.set(5, vendorFacts({
        listings: [listing(2, 62, { vendorRetailPriceCents: 1099 }), listing(5, 65, { status: "ended" })],
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

    it("keeps a hold when the cost in force is unknown, and counts a deferred release for the next pass", async () => {
      repository.activeHolds = [hold(1, 2, 62), hold(2, 5, 65)];
      repository.facts.set(5, vendorFacts({
        listings: [listing(2, 62, { vendorRetailPriceCents: 1099 }), listing(5, 65, { vendorRetailPriceCents: 1099 })],
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
  });
});

describe("classifyListing", () => {
  it("prices a rule-priced listing at the cost being judged, not at what it sold for", () => {
    const facts: CostActionVendorFacts = {
      listings: [], savedPrices: [{ storeConnectionId: 9, productVariantId: 61, overridePriceCents: null, pricingMode: "rules" }],
      profiles: new Map([[9, costRules]]), candidates: new Map([[61, candidate(61)]]), pricingPolicies: [],
    };
    expect(classifyListing(facts, listing(1, 61), 999)).toEqual({ source: "rules_cost", priceCents: 1399, followsCost: true });
    expect(classifyListing({ ...facts, profiles: new Map() }, listing(1, 61), 999)).toEqual({ source: "unavailable", priceCents: null, followsCost: false });
  });

  it("puts an inherit listing on its retail price when a blocking Card Shellz limit refuses the rule price at the new cost (L1)", () => {
    const ceiling = (mode: DropshipPricingPolicyRecord["mode"]): DropshipPricingPolicyRecord => ({ id: 3, scopeType: "catalog",
      productLineId: null, productId: null, productVariantId: null, category: null, mode, floorPriceCents: null, ceilingPriceCents: 1200 });
    const facts: CostActionVendorFacts = {
      listings: [], savedPrices: [{ storeConnectionId: 9, productVariantId: 61, overridePriceCents: null, pricingMode: "inherit" }],
      profiles: new Map([[9, costRules]]), candidates: new Map([[61, candidate(61)]]), pricingPolicies: [ceiling("block_listing_push")],
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
