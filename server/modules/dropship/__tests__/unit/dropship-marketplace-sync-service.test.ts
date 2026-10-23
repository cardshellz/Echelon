import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../domain/marketplace-listing-observation";
import {
  DropshipMarketplaceSyncService,
  type MarketplaceListingSyncWrite,
  type MarketplaceListingSyncWriteResult,
  type MarketplaceLiveListingRaw,
  type MarketplacePushSentFields,
  type MarketplaceQuantityDecisionWrite,
  type MarketplaceSyncListing,
  type MarketplaceSyncNoticeBatchRecord,
  type MarketplaceSyncPolicyCheckWrite,
  type MarketplaceSyncPreviewRow,
  type MarketplaceSyncRepository,
  type MarketplaceSyncStore,
} from "../../application/dropship-marketplace-sync-service";
import { DROPSHIP_NOTIFICATION_EVENTS } from "../../application/dropship-notification-events";
import type { DropshipNotificationSenderInput } from "../../application/dropship-ports";
import { DropshipError } from "../../domain/errors";
import type { QuantityBaseline } from "../../domain/marketplace-quantity-decision";
import { marketplaceSyncError, MARKETPLACE_SYNC_CODES } from "../../domain/marketplace-sync-errors";
import { marketplaceQuantityRestoreJobKey } from "../../domain/marketplace-sync-keys";
import { rawInventoryItem, rawOffer, READ_LISTING_ID, READ_OFFER_ID, READ_SKU } from "../fixtures/ebay-sync-back-reads.fixture";

/**
 * eBay sync-back's scheduled job (plan v4 §6, owner rules 1, 4, 5, 7) over DI
 * fakes: the real pure decisions, a scripted eBay read, a recording
 * repository. No database, no network.
 */
const LEDGER = new Date("2026-10-22T08:00:00.000Z");
const PUSHED = new Date("2026-10-22T09:00:00.000Z");
const T = new Date("2026-10-22T12:00:00.000Z");
const COVERED = new Date("2026-10-22T13:00:00.000Z");
const VENDOR_TITLE = "Vendor's own eBay title";

function store(overrides: Partial<MarketplaceSyncStore> = {}): MarketplaceSyncStore {
  return { vendorId: 10, storeConnectionId: 22, marketplaceId: "EBAY_US", liveListingCount: 1, salesLedgerSince: LEDGER,
    lastOrderSyncAt: COVERED, ...overrides };
}

/** A listing Card Shellz pushed at 09:00 with 11.00, F-1/R-1/P-1 and 10 units. */
function listing(overrides: Partial<MarketplaceSyncListing> = {}): MarketplaceSyncListing {
  return {
    listingId: 77, vendorId: 10, storeConnectionId: 22, productVariantId: 101, status: "active", externalListingId: READ_LISTING_ID,
    externalOfferId: READ_OFFER_ID, pushedQuantity: 10, lastPushedAt: PUSHED, issueCodes: [], marketplaceEndedAt: null,
    vendorQuantityLimit: null, quantityBaseline: null, observedQuantity: null, hasOpenPushItem: false, pushAttemptUnsettled: false,
    events: [{ id: 500, eventType: "listing_push_completed", createdAt: PUSHED,
      payload: { priceCents: 1100, fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1" } }],
    storedIntent: { sku: READ_SKU, title: "Card Shellz Toploaders 3x4 (100)", description: "<p>Card Shellz toploaders.</p>", priceCents: 1100 },
    ...overrides,
  };
}

function row(overrides: Partial<MarketplaceSyncPreviewRow> = {}): MarketplaceSyncPreviewRow {
  return {
    productVariantId: 101, sku: READ_SKU, title: "Toploaders 3x4", priceCents: 1100, priceSettingRevisionId: 5, marketplaceQuantity: 10,
    businessPolicySelection: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1", overriddenFields: [] },
    economics: { currency: "USD", basis: "one_sellable_variant", unitsPerVariant: 100, referenceRetailPriceCents: 1200, listingPriceCents: 1100,
      vendorProductCostCents: 700, channelDiscountPercent: null, productCostStatus: "available", issues: [] },
    ...overrides,
  };
}

function quantityRead(offerQuantity: number, overrides: Record<string, unknown> = {}): MarketplaceLiveListingRaw {
  return { kind: "read", offer: rawOffer({ availableQuantity: offerQuantity, ...overrides }),
    inventoryItem: rawInventoryItem({ availability: { shipToLocationAvailability: { quantity: offerQuantity } } }) };
}

class FakeRepository implements MarketplaceSyncRepository {
  stores: MarketplaceSyncStore[] = [store()];
  listings = new Map<number, MarketplaceSyncListing>([[77, listing()]]);
  syncWrites: MarketplaceListingSyncWrite[] = [];
  quantityWrites: MarketplaceQuantityDecisionWrite[] = [];
  attempts: number[] = [];
  due: number[] = [];
  deadLettered: Array<{ listingId: number; failureCode: string }> = [];
  policyChecks: MarketplaceSyncPolicyCheckWrite[] = [];
  policies: Array<{ fulfillmentPolicyId: string; listingCount: number }> = [];
  policyNotified = false;
  batches: MarketplaceSyncNoticeBatchRecord[] = [];
  sent: string[] = [];
  deadLetteredBatches: Array<{ batchKey: string; failureCode: string }> = [];
  sales = { all: 0, live: 0 };
  price: MarketplaceListingSyncWriteResult["price"] = "adopted";
  applyError: Error | null = null;

  pushAttempts: Array<{ listingId: number; jobId: number; jobItemId: number; sent: MarketplacePushSentFields; at: Date }> = [];
  loadOptions: Array<{ excludeJobItemId?: number | null } | undefined> = [];

  async listSweepStores() { return this.stores; }
  async loadStore(storeConnectionId: number) { return this.stores.find((entry) => entry.storeConnectionId === storeConnectionId) ?? null; }
  async recordPushAttempt(input: { listingId: number; jobId: number; jobItemId: number; sent: MarketplacePushSentFields; at: Date }) {
    this.pushAttempts.push(input);
  }
  async listObservedListingIds(input: { storeConnectionId: number }) {
    return [...this.listings.values()].filter((entry) => entry.storeConnectionId === input.storeConnectionId && entry.observedQuantity)
      .map((entry) => entry.listingId);
  }
  async listDueListingIds(input: { storeConnectionId: number; limit: number }) {
    return [...this.listings.values()].filter((entry) => entry.storeConnectionId === input.storeConnectionId && !entry.observedQuantity
      && !entry.issueCodes.includes("sync_requires_review")).map((entry) => entry.listingId).slice(0, input.limit);
  }
  async loadListing(listingId: number, options?: { excludeJobItemId?: number | null }) {
    this.loadOptions.push(options);
    return this.listings.get(listingId) ?? null;
  }
  async recordAttempt(listingId: number) { this.attempts.push(listingId); }
  async markListingsDue(listingIds: readonly number[]) { this.due.push(...listingIds); }
  async applyListingSync(input: MarketplaceListingSyncWrite): Promise<MarketplaceListingSyncWriteResult> {
    if (this.applyError) throw this.applyError;
    this.syncWrites.push(input);
    const current = this.listings.get(input.listingId)!;
    this.listings.set(input.listingId, { ...current, issueCodes: input.decision.issues.after,
      observedQuantity: input.saveObservation ?? current.observedQuantity });
    // As the real repository: a quantity decided on this read is applied in the same transaction once its observation is saved.
    const quantityApplied = input.saveObservation !== null && input.quantity ? (await this.applyQuantityDecision(input.quantity)).applied : null;
    return {
      quantityApplied,
      price: input.price ? this.price : "none", policies: input.policies ? "saved" : "none", observationSaved: input.saveObservation !== null,
      syncedEventId: input.decision.syncedBaseline ? 901 : null, noticesWritten: input.decision.notices.length,
      status: { ended: input.decision.status.endListing, reactivated: input.decision.status.reactivate, relinked: input.decision.status.relink !== null },
      decision: input.decision,
    };
  }
  async applyQuantityDecision(input: MarketplaceQuantityDecisionWrite) {
    this.quantityWrites.push(input);
    const current = this.listings.get(input.listingId)!;
    this.listings.set(input.listingId, { ...current, observedQuantity: null,
      vendorQuantityLimit: input.writes.limitChange === null ? current.vendorQuantityLimit
        : input.writes.limitChange.kind === "set" ? input.writes.limitChange.limit : null });
    return { applied: true };
  }
  async sumSales() { return this.sales; }
  async deadLetterListing(input: { listingId: number; failureCode: string }) {
    this.deadLettered.push(input);
    // As the real writer: the listing carries sync_requires_review, which the sweep's selection excludes.
    const current = this.listings.get(input.listingId);
    if (current) this.listings.set(input.listingId, { ...current, issueCodes: [...current.issueCodes, "sync_requires_review"] });
  }
  async listObservedPolicies() { return this.policies; }
  async applyPolicyCheck(input: MarketplaceSyncPolicyCheckWrite) { this.policyChecks.push(input); return { notified: this.policyNotified }; }
  async claimNoticeBatches() { return this.batches.length; }
  async listUnsentNoticeBatches() { return this.batches.filter((batch) => !this.sent.includes(batch.batchKey)
    && !this.deadLetteredBatches.some((entry) => entry.batchKey === batch.batchKey)); }
  async markNoticeBatchSent(input: { batchKey: string }) { this.sent.push(input.batchKey); return 1; }
  async deadLetterNoticeBatch(input: { batchKey: string; failureCode: string }) { this.deadLetteredBatches.push(input); return 1; }
}

function harness(options: {
  reads?: Record<string, MarketplaceLiveListingRaw | Error>;
  rows?: MarketplaceSyncPreviewRow[];
  baselines?: Record<number, QuantityBaseline | null>;
  previewError?: Error;
  sendError?: Error;
  guardError?: Error;
  tickBudgetMs?: number;
  stepMs?: number;
} = {}) {
  const repository = new FakeRepository();
  let now = T.getTime();
  const reads: string[] = [];
  const readSkus: string[] = [];
  const restores: Array<{ productVariantIds: number[]; idempotencyKey: string }> = [];
  const sent: DropshipNotificationSenderInput[] = [];
  const lines: Array<{ level: string; action: string; data: Record<string, unknown> }> = [];
  const log = (level: string) => (action: string, data: Record<string, unknown> = {}) => { lines.push({ level, action, data }); };
  const service = new DropshipMarketplaceSyncService({
    repository,
    reader: {
      async readLiveListing(input) {
        reads.push(input.offerId);
        readSkus.push(input.sku);
        now += options.stepMs ?? 0;
        const answer = options.reads?.[input.offerId] ?? { kind: "read", offer: rawOffer(), inventoryItem: rawInventoryItem() };
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    previews: {
      async generatePreview() {
        if (options.previewError) throw options.previewError;
        return { rows: options.rows ?? [row()] };
      },
    },
    restores: { async queueRestore(input) { restores.push(input); return { queued: true, jobId: 3000 + restores.length, idempotentReplay: false }; } },
    baselines: {
      async readPublishBaselines(input) {
        return new Map(input.listings.map((entry) => [entry.listingId,
          options.baselines?.[entry.listingId] !== undefined ? options.baselines[entry.listingId]! : { quantity: 10, at: PUSHED, settled: true }]));
      },
    },
    policyGuard: {
      async evaluateForStoreConnection(input) {
        if (options.guardError) throw options.guardError;
        return { compatible: false, fulfillmentPolicyId: input.fulfillmentPolicyId, capabilityEvidenceHash: "h", originWarehouseId: 1,
          issues: [{ code: "local_pickup_unsupported", message: "pickup" }] } as never;
      },
    },
    notifications: { async send(input) { if (options.sendError) throw options.sendError; sent.push(input); return {}; } },
    clock: { now: () => new Date(now) },
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    tickBudgetMs: options.tickBudgetMs,
  });
  return { service, repository, reads, readSkus, restores, sent, lines };
}

describe("the sweep keeps what the vendor owns on eBay (owner rule 4)", () => {
  it("adopts a vendor's price through W9 against the preview's price revision, and their policies into the size's row", async () => {
    const { service, repository } = harness({ reads: { [READ_OFFER_ID]: { kind: "read", inventoryItem: rawInventoryItem(),
      offer: rawOffer({ pricingSummary: { price: { value: "14.00", currency: "USD" } },
        listingPolicies: { fulfillmentPolicyId: "F-9", returnPolicyId: "R-1", paymentPolicyId: "P-1" } }) } } });

    const result = await service.runSweepTick();

    expect(repository.syncWrites).toHaveLength(1);
    expect(repository.syncWrites[0]).toMatchObject({ listingId: 77, observedAt: T, expectedNewestEventId: 500, oursPriceBaseline: 1100,
      price: { priceCents: 1400, expectedRevisionId: 5 }, policies: { fulfillmentPolicyId: "F-9" },
      observed: { priceCents: 1400, fulfillmentPolicyId: "F-9" } });
    expect(result).toMatchObject({ reads: 1, priceAdoptions: 1, policyAdoptions: 1 });
  });

  it("warns the vendor once when the price they set is below what Card Shellz charges (rule 7a)", async () => {
    const { service, repository } = harness({ reads: { [READ_OFFER_ID]: { kind: "read", inventoryItem: rawInventoryItem(),
      offer: rawOffer({ pricingSummary: { price: { value: "6.50", currency: "USD" } } }) } } });
    await service.runSweepTick();
    expect(repository.syncWrites[0]!.decision.notices).toEqual([expect.objectContaining({ kind: "price_below_cost",
      payload: expect.objectContaining({ priceCents: 650, unitCostCents: 700, itemLabel: `Toploaders 3x4 (SKU ${READ_SKU})` }) })]);
  });

  it("never takes in a vendor's title or description: an edit of only those writes no adoption and carries none of their text (rule 2)", async () => {
    const { service, repository } = harness({ reads: { [READ_OFFER_ID]: { kind: "read", offer: rawOffer({ listingDescription: "<p>Theirs</p>" }),
      inventoryItem: rawInventoryItem({}, { title: VENDOR_TITLE, description: "<p>Theirs</p>" }) } } });

    await service.runSweepTick();

    const write = repository.syncWrites[0]!;
    expect(write).toMatchObject({ price: null, policies: null });
    expect(write.decision.syncedBaseline).toBeNull();
    expect(write.decision.push).toBeNull();
    expect(JSON.stringify(write)).not.toContain(VENDOR_TITLE);
    expect(JSON.stringify(write)).not.toContain("Theirs");
  });

  it("reads the inventory item by the SKU Card Shellz last pushed, else the catalog's", async () => {
    const pushed = harness();
    pushed.repository.listings.set(77, listing({ storedIntent: { sku: "CS-PUSHED", priceCents: 1100 } }));
    await pushed.service.runSweepTick();
    expect(pushed.readSkus).toEqual(["CS-PUSHED"]);
    const catalog = harness();
    catalog.repository.listings.set(77, listing({ storedIntent: null }));
    await catalog.service.runSweepTick();
    expect(catalog.readSkus).toEqual([READ_SKU]);
  });

  it("does not read a listing Card Shellz has no preview row for, and moves it to the back of the line", async () => {
    const { service, repository, reads } = harness({ rows: [] });
    await service.runSweepTick();
    expect(reads).toEqual([]);
    expect(repository.attempts).toEqual([77]);
  });
});

describe("quantity (owner rule 1)", () => {
  it("keeps a lower number sales cannot explain as the listing's vendor limit; no push, no notice", async () => {
    const { service, repository, restores, sent } = harness({ reads: { [READ_OFFER_ID]: quantityRead(4) } });

    await service.runSweepTick();

    expect(repository.syncWrites[0]!.saveObservation).toEqual({ quantity: 4, at: T });
    expect(repository.quantityWrites).toHaveLength(1);
    expect(repository.quantityWrites[0]).toMatchObject({ listingId: 77, observation: { quantity: 4, at: T }, expectedLimit: null,
      idempotencyKey: `ebay-sync:qty-limit:77:${T.getTime()}:4`,
      writes: { limitChange: { kind: "set", limit: 4 }, baseline: { quantity: 4, at: T }, restore: "none" } });
    expect(restores).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("clears the limit when the vendor sets ATP or more, and puts ATP back with one restore push (FF: S1 set it back and kept the limit)", async () => {
    const { service, repository, restores } = harness({ reads: { [READ_OFFER_ID]: quantityRead(25) }, rows: [row({ marketplaceQuantity: 20 })],
      baselines: { 77: { quantity: 5, at: PUSHED, settled: true } } });
    repository.listings.set(77, listing({ vendorQuantityLimit: 5, pushedQuantity: 5 }));

    await service.runSweepTick();

    expect(repository.quantityWrites[0]!.writes).toMatchObject({ limitChange: { kind: "clear" }, restore: "queue" });
    expect(restores).toEqual([{ vendorId: 10, storeConnectionId: 22, productVariantIds: [101],
      idempotencyKey: marketplaceQuantityRestoreJobKey({ storeConnectionId: 22, listingIds: [77], maxEventId: 500 }) }]);
  });

  it("takes a number between the old limit and ATP as the new limit, with nothing to push", async () => {
    const { service, repository, restores } = harness({ reads: { [READ_OFFER_ID]: quantityRead(12) }, rows: [row({ marketplaceQuantity: 20 })],
      baselines: { 77: { quantity: 5, at: PUSHED, settled: true } } });
    repository.listings.set(77, listing({ vendorQuantityLimit: 5, pushedQuantity: 5 }));

    await service.runSweepTick();

    expect(repository.quantityWrites[0]!.writes).toMatchObject({ limitChange: { kind: "set", limit: 12 }, restore: "none" });
    expect(restores).toEqual([]);
  });

  it("keeps a 0 as a limit of 0 and keeps the listing; eBay's own out-of-stock end after Card Shellz published 0 is no limit", async () => {
    const zero = harness({ reads: { [READ_OFFER_ID]: quantityRead(0, { listing: { listingId: READ_LISTING_ID, listingStatus: "OUT_OF_STOCK" } }) } });
    await zero.service.runSweepTick();
    expect(zero.repository.quantityWrites[0]!.writes).toMatchObject({ limitChange: { kind: "set", limit: 0 } });

    const ebayEnd = harness({ reads: { [READ_OFFER_ID]: quantityRead(0, { listing: { listingId: READ_LISTING_ID, listingStatus: "ENDED" } }) },
      rows: [row({ marketplaceQuantity: 0 })], baselines: { 77: { quantity: 0, at: PUSHED, settled: true } } });
    ebayEnd.repository.listings.set(77, listing({ pushedQuantity: 0 }));
    await ebayEnd.service.runSweepTick();
    expect(ebayEnd.repository.syncWrites[0]!.decision.issues.after).toEqual(["ended_out_of_stock"]);
    expect(ebayEnd.repository.quantityWrites[0]!.writes).toMatchObject({ limitChange: null, clearObservation: true, restore: "none" });
  });

  it("waits for the order poll before keeping a lower number, and decides it next tick without reading eBay again", async () => {
    const { service, repository, reads } = harness({ reads: { [READ_OFFER_ID]: quantityRead(4) } });
    repository.stores = [store({ lastOrderSyncAt: T })];

    await service.runSweepTick();
    expect(repository.quantityWrites).toEqual([]);
    expect(repository.listings.get(77)!.observedQuantity).toEqual({ quantity: 4, at: T });

    repository.stores = [store()];
    await service.runSweepTick();
    expect(reads).toEqual([READ_OFFER_ID]);
    expect(repository.quantityWrites[0]!.writes).toMatchObject({ limitChange: { kind: "set", limit: 4 } });
  });

  it("flags a restore to 0 for staff only: no push job, no vendor notice, a WARN with the code", async () => {
    const { service, repository, restores, lines } = harness({ reads: { [READ_OFFER_ID]: quantityRead(5) }, rows: [row({ marketplaceQuantity: 0 })],
      baselines: { 77: { quantity: 3, at: PUSHED, settled: true } } });

    await service.runSweepTick();

    expect(repository.quantityWrites[0]!.writes).toMatchObject({ restore: "blocked", issues: { add: ["quantity_restore_blocked"] } });
    expect(restores).toEqual([]);
    expect(repository.syncWrites[0]!.decision.notices).toEqual([]);
    expect(lines).toContainEqual(expect.objectContaining({ level: "warn", action: "dropship.marketplace_sync.quantity_decided",
      data: expect.objectContaining({ error_code: "DROPSHIP_LISTING_QUANTITY_RESTORE_BLOCKED", outcome: "restore_blocked" }) }));
  });

  it("saves no quantity while a push of the listing is queued or running", async () => {
    const { service, repository } = harness({ reads: { [READ_OFFER_ID]: quantityRead(4) } });
    repository.listings.set(77, listing({ hasOpenPushItem: true }));
    await service.runSweepTick();
    expect(repository.syncWrites[0]!.saveObservation).toBeNull();
    expect(repository.quantityWrites).toEqual([]);
  });

  it("drops an observation it cannot judge without Echelon's preview row, so the listing is read again", async () => {
    const { service, repository, reads } = harness({ rows: [] });
    repository.listings.set(77, listing({ observedQuantity: { quantity: 4, at: T } }));
    await service.runSweepTick();
    expect(reads).toEqual([]);
    expect(repository.quantityWrites[0]!.writes).toMatchObject({ limitChange: null, clearObservation: true });
  });
});

describe("one adoption transaction (plan v4 §6.5, FF-17 DI)", () => {
  it("commits the quantity this read decides with the read's price and policy adoptions, not in a later transaction", async () => {
    const { service, repository } = harness({ reads: { [READ_OFFER_ID]: { kind: "read",
      offer: rawOffer({ availableQuantity: 25, pricingSummary: { price: { value: "14.00", currency: "USD" } } }),
      inventoryItem: rawInventoryItem({ availability: { shipToLocationAvailability: { quantity: 25 } } }) } },
    rows: [row({ marketplaceQuantity: 20 })], baselines: { 77: { quantity: 5, at: PUSHED, settled: true } } });
    repository.listings.set(77, listing({ vendorQuantityLimit: 5, pushedQuantity: 5 }));

    await service.runSweepTick();

    expect(repository.syncWrites).toHaveLength(1);
    expect(repository.syncWrites[0]).toMatchObject({ price: { priceCents: 1400 }, saveObservation: { quantity: 25, at: T },
      quantity: { listingId: 77, observation: { quantity: 25, at: T }, expectedLimit: 5,
        idempotencyKey: `ebay-sync:qty-limit:77:${T.getTime()}:25`, writes: { limitChange: { kind: "clear" }, restore: "queue" } } });
    // The fake records the carried decision when it applies it inside applyListingSync: one write, nothing after it.
    expect(repository.quantityWrites).toEqual([repository.syncWrites[0]!.quantity]);
  });

  it("carries no quantity decision while the order poll has not covered a lower number; it waits saved", async () => {
    const { service, repository } = harness({ reads: { [READ_OFFER_ID]: quantityRead(4) } });
    repository.stores = [store({ lastOrderSyncAt: T })];
    await service.runSweepTick();
    expect(repository.syncWrites[0]).toMatchObject({ saveObservation: { quantity: 4, at: T }, quantity: null });
    expect(repository.quantityWrites).toEqual([]);
  });
});

describe("the push pre-read (plan v4 §5 step 2)", () => {
  const PUSH_INPUT = { vendorId: 10, storeConnectionId: 22, listingId: 77, productVariantId: 101, jobId: 30, jobItemId: 5,
    relistAllowed: false };

  it("adopts what the vendor owns, then answers the ids, the guard and what the push carries; their edited title goes back as is", async () => {
    const { service, repository, lines } = harness({ reads: { [READ_OFFER_ID]: { kind: "read",
      offer: rawOffer({ pricingSummary: { price: { value: "14.00", currency: "USD" } }, listing: { listingId: "110000000777", listingStatus: "ACTIVE" } }),
      inventoryItem: rawInventoryItem({}, { title: VENDOR_TITLE }) } } });

    const answer = await service.syncListingBeforePush(PUSH_INPUT);

    expect(repository.loadOptions).toEqual([{ excludeJobItemId: 5 }]);
    expect(repository.syncWrites[0]).toMatchObject({ trigger: "push", excludeJobItemId: 5, price: { priceCents: 1400 } });
    // SB6: eBay relisted it under a new item number; the push goes to that one.
    expect(answer).toMatchObject({ externalListingId: "110000000777", externalOfferId: READ_OFFER_ID, liveFulfillmentPolicyId: "F-1",
      guard: { offerId: READ_OFFER_ID, listingId: "110000000777", priceCents: 1400, availableQuantity: 10 },
      passthrough: { title: VENDOR_TITLE, description: null, bestOfferTerms: null } });
    const checked = lines.find((line) => line.action === "dropship.marketplace_sync.push_checked")!;
    expect(checked.data).toMatchObject({ trigger: "push", job_id: 30, job_item_id: 5, kept_vendor_title: true, kept_vendor_description: false });
    expect(JSON.stringify(lines)).not.toContain(VENDOR_TITLE);
  });

  it("sends Card Shellz's own text when eBay shows exactly what it last sent (rule 2)", async () => {
    const { service } = harness();
    const answer = await service.syncListingBeforePush(PUSH_INPUT);
    expect(answer.passthrough).toEqual({ bestOfferTerms: null, title: null, description: null,
      carriedFingerprints: { title: null, description: null } });
  });

  // Review OR-1: the push sends a refreshed intent, so "what Card Shellz last sent" is what that push wrote (its
  // fingerprint on listing_push_completed), never the text the item was queued with.
  it("takes text a push wrote from its refreshed intent as Card Shellz's own, so a later Card Shellz fix still reaches the listing", async () => {
    const written = harness({ reads: { [READ_OFFER_ID]: { kind: "read", offer: rawOffer(),
      inventoryItem: rawInventoryItem({}, { title: "T2 refreshed by Card Shellz" }) } } });
    written.repository.listings.set(77, listing({ storedIntent: { sku: READ_SKU, title: "T1 queued", description: "<p>Card Shellz toploaders.</p>",
      priceCents: 1100 }, events: [{ id: 500, eventType: "listing_push_completed", createdAt: PUSHED,
      payload: { priceCents: 1100, fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1",
        titleHash: sha256Hex("T2 refreshed by Card Shellz"), descriptionHash: sha256Hex("<p>Card Shellz toploaders.</p>") } }] }));
    expect((await written.service.syncListingBeforePush(PUSH_INPUT)).passthrough).toMatchObject({ title: null, description: null });

    // The vendor's own edit after that is still kept, carrying Card Shellz's fingerprint forward.
    const edited = harness({ reads: { [READ_OFFER_ID]: { kind: "read", offer: rawOffer(), inventoryItem: rawInventoryItem({}, { title: VENDOR_TITLE }) } } });
    edited.repository.listings.set(77, written.repository.listings.get(77)!);
    expect((await edited.service.syncListingBeforePush(PUSH_INPUT)).passthrough).toMatchObject({ title: VENDOR_TITLE,
      carriedFingerprints: { title: sha256Hex("T2 refreshed by Card Shellz"), description: null } });
  });

  it("FF-12b: pauses on a lower number the order poll has not covered, with the observation saved and the listing due; decides it first next time", async () => {
    const { service, repository, reads } = harness({ reads: { [READ_OFFER_ID]: quantityRead(4) } });
    repository.stores = [store({ lastOrderSyncAt: T })];

    await expect(service.syncListingBeforePush(PUSH_INPUT)).rejects.toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_QUANTITY_PENDING",
      context: expect.objectContaining({ classification: "transient", retryable: true }) });
    expect(repository.listings.get(77)!.observedQuantity).toEqual({ quantity: 4, at: T });
    expect(repository.due).toEqual([77]);
    expect(repository.quantityWrites).toEqual([]);

    // The poll has covered the read: the saved observation is decided before eBay is read again, and the push goes on.
    repository.stores = [store()];
    await expect(service.syncListingBeforePush(PUSH_INPUT)).resolves.toMatchObject({ externalOfferId: READ_OFFER_ID });
    expect(repository.quantityWrites[0]).toMatchObject({ observation: { quantity: 4, at: T }, writes: { limitChange: { kind: "set", limit: 4 } } });
    expect(repository.listings.get(77)!.vendorQuantityLimit).toBe(4);
    expect(reads).toEqual([READ_OFFER_ID, READ_OFFER_ID]);
  });

  it("FF-12b: a vendor raise to ATP clears the limit at once, in the read's own transaction, and queues no restore job (the push is it)", async () => {
    const { service, repository, restores } = harness({ reads: { [READ_OFFER_ID]: quantityRead(20) }, rows: [row({ marketplaceQuantity: 20 })],
      baselines: { 77: { quantity: 5, at: PUSHED, settled: true } } });
    repository.listings.set(77, listing({ vendorQuantityLimit: 5, pushedQuantity: 5 }));
    repository.stores = [store({ lastOrderSyncAt: T })];

    await service.syncListingBeforePush(PUSH_INPUT);

    expect(repository.syncWrites[0]!.quantity).toMatchObject({ expectedLimit: 5, writes: { limitChange: { kind: "clear" } } });
    expect(repository.listings.get(77)!.vendorQuantityLimit).toBeNull();
    expect(restores).toEqual([]);
  });

  it("stops for good, after marking it ended, a listing the vendor ended that this item may not relist; the vendor's own press may", async () => {
    const ended = { [READ_OFFER_ID]: quantityRead(6, { listing: { listingId: READ_LISTING_ID, listingStatus: "ENDED" } }) };
    const automatic = harness({ reads: ended });
    await expect(automatic.service.syncListingBeforePush(PUSH_INPUT)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_ENDED_ON_EBAY",
      context: expect.objectContaining({ classification: "permanent" }) });
    expect(automatic.repository.syncWrites[0]!.decision.status).toMatchObject({ endListing: true });

    const vendor = harness({ reads: ended });
    await expect(vendor.service.syncListingBeforePush({ ...PUSH_INPUT, relistAllowed: true })).resolves.toMatchObject({ externalOfferId: READ_OFFER_ID });
  });

  it("stops quietly a push without relist permission at a not-live listing whose 0 is not Card Shellz's own; the vendor's press may", async () => {
    const reads = { [READ_OFFER_ID]: quantityRead(0, { listing: { listingId: READ_LISTING_ID, listingStatus: "ENDED" } }) };
    const automatic = harness({ reads });
    await expect(automatic.service.syncListingBeforePush(PUSH_INPUT)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_ENDED_ON_EBAY" });
    const ours = harness({ reads, baselines: { 77: { quantity: 0, at: PUSHED, settled: true } } });
    ours.repository.listings.set(77, listing({ pushedQuantity: 0 }));
    await expect(ours.service.syncListingBeforePush(PUSH_INPUT)).resolves.toMatchObject({ externalOfferId: READ_OFFER_ID });
    const vendor = harness({ reads });
    await expect(vendor.service.syncListingBeforePush({ ...PUSH_INPUT, relistAllowed: true })).resolves.toMatchObject({ externalOfferId: READ_OFFER_ID });
  });

  it("stops for good a listing it cannot prove is Card Shellz's, with the vendor told (rule 7c)", async () => {
    const { service, repository } = harness({ reads: { [READ_OFFER_ID]: { kind: "offer_missing" } } });
    await expect(service.syncListingBeforePush(PUSH_INPUT)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_MARKETPLACE_IDENTITY_UNPROVEN" });
    expect(repository.syncWrites[0]!.decision.notices).toEqual([expect.objectContaining({ kind: "offer_missing", critical: true })]);
  });

  it("pauses as ADOPTION_RETRY when the adoption lost a race, and leaves eBay's own refusals their codes", async () => {
    const raced = harness();
    raced.repository.applyError = marketplaceSyncError(MARKETPLACE_SYNC_CODES.observationChanged, "moved", "transient");
    await expect(raced.service.syncListingBeforePush(PUSH_INPUT)).rejects.toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_ADOPTION_RETRY",
      context: expect.objectContaining({ causeCode: "DROPSHIP_MARKETPLACE_SYNC_OBSERVATION_CHANGED", jobItemId: 5 }) });

    const throttled = new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "429", { status: 429, method: "GET" });
    const ebay = harness({ reads: { [READ_OFFER_ID]: throttled } });
    await expect(ebay.service.syncListingBeforePush(PUSH_INPUT)).rejects.toBe(throttled);
  });

  it.each([
    ["the store is not launch-ready", (repository: FakeRepository) => { repository.stores = []; }, "DROPSHIP_MARKETPLACE_SYNC_STORE_UNAVAILABLE"],
    ["the listing is no longer the one queued", (repository: FakeRepository) => {
      repository.listings.set(77, listing({ productVariantId: 999 })); }, "DROPSHIP_MARKETPLACE_SYNC_LISTING_NOT_FOUND"],
    ["it has no SKU to read by", (repository: FakeRepository) => { repository.listings.set(77, listing({ storedIntent: null })); },
      "DROPSHIP_MARKETPLACE_SYNC_NOTHING_TO_COMPARE"],
  ])("refuses, reading nothing, when %s", async (_name, change, code) => {
    const { service, repository, reads } = harness({ rows: [row({ sku: null })] });
    if (code !== "DROPSHIP_MARKETPLACE_SYNC_NOTHING_TO_COMPARE") repository.listings.set(77, listing());
    change(repository);
    await expect(service.syncListingBeforePush(PUSH_INPUT)).rejects.toMatchObject({ code });
    expect(reads).toEqual([]);
  });

  it("refuses for good, reading nothing, a listing the sweep dead-lettered, until a person clears it (CLAUDE.md §6)", async () => {
    const { service, repository, reads } = harness();
    repository.listings.set(77, listing({ issueCodes: ["sync_requires_review"] }));
    await expect(service.syncListingBeforePush(PUSH_INPUT)).rejects.toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_REQUIRES_REVIEW",
      context: expect.objectContaining({ classification: "permanent", retryable: false }) });
    expect(reads).toEqual([]);
    expect(repository.syncWrites).toEqual([]);
  });

  it("dead-letters the listing once on a permanent failure of Card Shellz's own, and fails the push for good instead of retrying it", async () => {
    const { service, repository, lines } = harness();
    repository.applyError = Object.assign(new Error("violates check constraint"), { code: "23514" });
    await expect(service.syncListingBeforePush(PUSH_INPUT)).rejects.toMatchObject({ code: "DROPSHIP_MARKETPLACE_SYNC_REQUIRES_REVIEW",
      context: expect.objectContaining({ classification: "permanent", retryable: false, causeCode: "23514" }) });
    expect(repository.deadLettered).toEqual([{ listingId: 77, failureCode: "23514", at: T }]);
    expect(lines).toContainEqual(expect.objectContaining({ level: "error", action: "dropship.marketplace_sync.listing_dead_lettered",
      data: expect.objectContaining({ trigger: "push", job_item_id: 5, outcome: "requires_review", error_class: "permanent" }) }));
  });

  it("leaves eBay's own refusal of the read to the worker, with its code, and dead-letters nothing", async () => {
    const refused = new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "400", { status: 400, method: "GET" });
    const { service, repository } = harness({ reads: { [READ_OFFER_ID]: refused } });
    await expect(service.syncListingBeforePush(PUSH_INPUT)).rejects.toBe(refused);
    expect(repository.deadLettered).toEqual([]);
  });

  it("records the attempt with what the push is about to write, at the clock's time", async () => {
    const { service, repository } = harness();
    const sent = { priceCents: 1400, currency: "USD", sku: READ_SKU, fulfillmentPolicyId: "F-9", returnPolicyId: "R-1", paymentPolicyId: "P-1",
      titleHash: "a".repeat(64), descriptionHash: "b".repeat(64) };
    await service.recordPushAttempt({ listingId: 77, jobId: 30, jobItemId: 5, sent });
    expect(repository.pushAttempts).toEqual([{ listingId: 77, jobId: 30, jobItemId: 5, sent, at: T }]);
  });
});

describe("errors nothing classifies (review MS4)", () => {
  it("dead-letters a listing whose sync meets a code defect once, and does not read it again on the next tick", async () => {
    const { service, repository, reads, lines } = harness({ reads: { [READ_OFFER_ID]: new TypeError("Cannot read properties of undefined") } });
    const first = await service.runSweepTick();
    expect(first).toMatchObject({ deadLettered: 1, readFailures: 0 });
    expect(repository.deadLettered).toEqual([expect.objectContaining({ listingId: 77, failureCode: "UNEXPECTED_ERROR" })]);
    expect(lines).toContainEqual(expect.objectContaining({ level: "error", action: "dropship.marketplace_sync.listing_dead_lettered" }));

    await service.runSweepTick();
    expect(reads).toEqual([READ_OFFER_ID]);
    expect(repository.deadLettered).toHaveLength(1);
  });
});

describe("ended and relisted listings (owner rule 5)", () => {
  it("brings back a listing eBay ended for lack of stock once Echelon has stock, in the store's restore push", async () => {
    const { service, restores, repository } = harness({ reads: { [READ_OFFER_ID]: quantityRead(0,
      { listing: { listingId: READ_LISTING_ID, listingStatus: "ENDED" } }) }, baselines: { 77: { quantity: 0, at: PUSHED, settled: true } } });
    repository.listings.set(77, listing({ pushedQuantity: 0 }));
    await service.runSweepTick();
    expect(repository.syncWrites[0]!.decision.issues.after).toEqual(["ended_out_of_stock"]);
    expect(restores.map((entry) => entry.productVariantIds)).toEqual([[101]]);
  });

  // Review MS2: only Card Shellz's own settled 0 proves eBay ended it for lack of stock; any other 0 may be the vendor's end.
  it.each([
    ["the vendor set 0 before the store's sales ledger started (the read is not decided)", { salesLedgerSince: null }],
    ["the vendor ended it at 0 and the read is decided as their limit of 0", {}],
  ])("never relists a not-live listing at 0 Card Shellz did not publish 0 to: %s", async (_name, storeOverrides) => {
    const { service, restores, repository } = harness({ reads: { [READ_OFFER_ID]: quantityRead(0,
      { listing: { listingId: READ_LISTING_ID, listingStatus: "ENDED" } }) } });
    repository.stores = [store(storeOverrides)];
    await service.runSweepTick();
    expect(repository.syncWrites[0]!.decision.issues.after).toEqual(["ended_out_of_stock"]);
    expect(restores).toEqual([]);
  });


  it("saves no quantity for a listing the vendor ended, even at 0 (Echelon publishes nothing to it, so 0 is no limit)", async () => {
    const { service, repository } = harness({ reads: { [READ_OFFER_ID]: quantityRead(0, { listing: { listingId: READ_LISTING_ID, listingStatus: "ENDED" } }) } });
    repository.listings.set(77, listing({ status: "ended", marketplaceEndedAt: PUSHED }));
    await service.runSweepTick();
    expect(repository.syncWrites[0]!.saveObservation).toBeNull();
    expect(repository.quantityWrites).toEqual([]);
  });

  it("marks a listing the vendor ended (eBay not live with stock) as ended, and saves no quantity", async () => {
    const { service, repository } = harness({ reads: { [READ_OFFER_ID]: quantityRead(6, { listing: { listingId: READ_LISTING_ID, listingStatus: "ENDED" } }) } });
    await service.runSweepTick();
    expect(repository.syncWrites[0]!.decision.status).toMatchObject({ endListing: true });
    expect(repository.syncWrites[0]!.saveObservation).toBeNull();
  });
});

describe("errors (CLAUDE.md §6)", () => {
  it("stops a store eBay throttles for the tick, and still reads the next store", async () => {
    const { service, repository, reads } = harness({ reads: {
      [READ_OFFER_ID]: new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "429", { status: 429, method: "GET" }),
    } });
    repository.listings.set(78, listing({ listingId: 78, externalOfferId: "OFFER-78", productVariantId: 101 }));
    repository.listings.set(79, listing({ listingId: 79, storeConnectionId: 23, vendorId: 11, externalOfferId: "OFFER-79" }));
    repository.stores = [store(), store({ vendorId: 11, storeConnectionId: 23 })];

    const result = await service.runSweepTick();

    expect(reads).toEqual([READ_OFFER_ID, "OFFER-79"]);
    expect(result).toMatchObject({ stores: 2, storesStopped: 1 });
  });

  it("skips only a listing whose read got no answer, leaving it first in line", async () => {
    const { service, repository, reads } = harness({ reads: {
      [READ_OFFER_ID]: new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "503", { status: 503, method: "GET" }),
    } });
    repository.listings.set(78, listing({ listingId: 78, externalOfferId: "OFFER-78" }));
    const result = await service.runSweepTick();
    expect(reads).toEqual([READ_OFFER_ID, "OFFER-78"]);
    expect(result.readFailures).toBe(1);
    expect(repository.attempts).toEqual([]);
  });

  it("reads a listing again first next tick when it lost a race, never writing from a stale decision", async () => {
    const { service, repository } = harness();
    repository.applyError = marketplaceSyncError(MARKETPLACE_SYNC_CODES.observationChanged, "moved", "transient");
    await service.runSweepTick();
    expect(repository.due).toEqual([77]);
  });

  it("dead-letters a listing on a permanent failure of its own, once, at ERROR, and never reads it again", async () => {
    const { service, repository, lines, reads } = harness();
    repository.applyError = Object.assign(new Error("violates check constraint"), { code: "23514" });
    await service.runSweepTick();
    expect(repository.deadLettered).toEqual([{ listingId: 77, failureCode: "23514", at: T }]);
    expect(lines).toContainEqual(expect.objectContaining({ level: "error", action: "dropship.marketplace_sync.listing_dead_lettered",
      data: expect.objectContaining({ outcome: "requires_review", error_class: "permanent" }) }));
    repository.listings.set(77, { ...repository.listings.get(77)!, issueCodes: ["sync_requires_review"] });
    await service.runSweepTick();
    expect(reads).toEqual([READ_OFFER_ID]);
  });

  it("aborts the tick on a broken invariant", async () => {
    const { service, repository } = harness();
    repository.applyError = marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "broken", "fatal");
    await expect(service.runSweepTick()).rejects.toMatchObject({ code: MARKETPLACE_SYNC_CODES.invariantFailed });
  });

  it("skips a store the preview refuses for its own access rule, at DEBUG, reading nothing", async () => {
    const { service, reads, lines } = harness({ previewError: new DropshipError("DROPSHIP_LISTING_VENDOR_BLOCKED", "blocked",
      { resolution: "reactivate" }) });
    await service.runSweepTick();
    expect(reads).toEqual([]);
    expect(lines).toContainEqual(expect.objectContaining({ level: "debug", action: "dropship.marketplace_sync.store_preview_failed" }));
  });

  it("starts nothing new once the tick's time budget is spent", async () => {
    const { service, repository, reads } = harness({ tickBudgetMs: 1_000, stepMs: 2_000 });
    repository.listings.set(78, listing({ listingId: 78, externalOfferId: "OFFER-78" }));
    const result = await service.runSweepTick();
    expect(reads).toEqual([READ_OFFER_ID]);
    expect(result.budgetExhausted).toBe(true);
  });
});

describe("shipping policies and vendor notices (owner rule 7)", () => {
  it("checks each live policy fresh, and tells staff when one is newly incompatible", async () => {
    const { service, repository, lines } = harness();
    repository.policies = [{ fulfillmentPolicyId: "F-1", listingCount: 3 }];
    repository.policyNotified = true;
    await service.runSweepTick();
    expect(repository.policyChecks).toEqual([expect.objectContaining({ fulfillmentPolicyId: "F-1", compatible: false,
      issueCodes: ["local_pickup_unsupported"], listingCount: 3, checkedAt: T })]);
    expect(lines).toContainEqual(expect.objectContaining({ level: "warn", action: "dropship.marketplace_sync.policy_incompatible",
      data: expect.objectContaining({ error_code: "DROPSHIP_LISTING_POLICY_INCOMPATIBLE" }) }));
  });

  it("keeps the previous verdict when a check gets no answer", async () => {
    const { service, repository } = harness({ guardError: new DropshipError("X", "down", { status: 503 }) });
    repository.policies = [{ fulfillmentPolicyId: "F-1", listingCount: 3 }];
    await service.runSweepTick();
    expect(repository.policyChecks).toEqual([]);
  });

  it("sends each batch with its key as the notification's idempotency key, critical kinds as action needed", async () => {
    const { service, repository, sent } = harness();
    repository.batches = [
      { batchKey: "ebay-sync:offer_missing:22:1-1", vendorId: 10, storeConnectionId: 22, kind: "offer_missing", critical: true,
        payloads: [{ listingId: 77, itemLabel: "Toploaders" }] },
      { batchKey: "ebay-sync:price_below_cost:22:2-2", vendorId: 10, storeConnectionId: 22, kind: "price_below_cost", critical: false,
        payloads: [{ listingId: 77, itemLabel: "Toploaders", priceCents: 650, unitCostCents: 700 }] },
    ];
    const result = await service.runSweepTick();
    expect(sent).toEqual([
      expect.objectContaining({ vendorId: 10, eventType: DROPSHIP_NOTIFICATION_EVENTS.EBAY_LISTING_ACTION_NEEDED, critical: true,
        idempotencyKey: "ebay-sync:offer_missing:22:1-1", title: "We can't find an eBay listing",
        payload: { kind: "offer_missing", storeConnectionId: 22, noticeCount: 1, listingIds: [77] } }),
      expect.objectContaining({ eventType: DROPSHIP_NOTIFICATION_EVENTS.EBAY_LISTING_WARNING, critical: false,
        idempotencyKey: "ebay-sync:price_below_cost:22:2-2" }),
    ]);
    expect(repository.sent).toEqual(["ebay-sync:offer_missing:22:1-1", "ebay-sync:price_below_cost:22:2-2"]);
    expect(result.noticesSent).toBe(2);
  });

  it("ARCH-8: sends order and wallet notices under the order event types, never the listing ones", async () => {
    const { service, repository, sent } = harness();
    repository.batches = [
      { batchKey: "ebay-sync:order_cancel_not_stopped:22:4-4", vendorId: 10, storeConnectionId: 22, kind: "order_cancel_not_stopped", critical: true,
        payloads: [{ intakeId: 41, externalOrderNumber: "5001" }] },
      { batchKey: "ebay-sync:order_cancel_refunded:22:5-5", vendorId: 10, storeConnectionId: 22, kind: "order_cancel_refunded", critical: false,
        payloads: [{ intakeId: 42, cashRefundCents: 1200 }] },
      { batchKey: "ebay-sync:unknown_item_number:22:6-6", vendorId: 10, storeConnectionId: 22, kind: "unknown_item_number", critical: false,
        payloads: [{ externalListingId: "555", sku: "SKU-1" }] },
    ];
    await service.runSweepTick();
    expect(sent.map((entry) => [entry.eventType, entry.critical])).toEqual([
      ["dropship_ebay_order_action_needed", true],
      ["dropship_ebay_order_update", false],
      ["dropship_ebay_order_update", false],
    ]);
  });

  it("marks a batch the notification service already holds as sent, dead-letters one it refuses for good, and keeps one that failed in passing", async () => {
    const batch = { batchKey: "ebay-sync:sku_changed:22:3-3", vendorId: 10, storeConnectionId: 22, kind: "sku_changed" as const, critical: true,
      payloads: [{ listingId: 77 }] };
    const conflict = harness({ sendError: new DropshipError("DROPSHIP_NOTIFICATION_IDEMPOTENCY_CONFLICT", "reused") });
    conflict.repository.batches = [batch];
    await conflict.service.runSweepTick();
    expect(conflict.repository.sent).toEqual([batch.batchKey]);

    const refused = harness({ sendError: new DropshipError("DROPSHIP_NOTIFICATION_INVALID_SEND", "invalid") });
    refused.repository.batches = [batch];
    await refused.service.runSweepTick();
    expect(refused.repository.deadLetteredBatches).toEqual([{ batchKey: batch.batchKey, failureCode: "DROPSHIP_NOTIFICATION_INVALID_SEND", at: T }]);
    await refused.service.runSweepTick();
    expect(refused.repository.deadLetteredBatches).toHaveLength(1);

    const passing = harness({ sendError: Object.assign(new Error("connection reset"), { code: "08006" }) });
    passing.repository.batches = [batch];
    await passing.service.runSweepTick();
    expect(passing.repository.sent).toEqual([]);
    expect(passing.repository.deadLetteredBatches).toEqual([]);
  });
});
