import { describe, expect, it, vi } from "vitest";
import type { StockLinkDestination, StockLinkOfferLookup } from "@shared/types/stock-link";
import type { DropshipEbayStockReadinessInput, DropshipEbayStockReadinessResult } from "@shared/types/dropship-ebay-stock-readiness";
import type { StockLinkEnrollmentListing, StockLinkEnrollmentSource, StockLinkOfferAdapter } from "../../application/stock-link.ports";
import { STOCK_LINK_TICK_LIMITS, StockLinkService, createStockLinkRegistry, type StockLinkSelectionFact, type StockLinkTickStore } from "../../application/stock-link.service";
import { dropshipEbayStockCommandKey } from "../../domain/dropship-ebay-stock-readiness";
import { STOCK_LINK_ENROLLMENT_CODES as E } from "../../domain/stock-link-enrollment";
import { STOCK_LINK_DECISION_CODES as D } from "../../domain/stock-link";
import type { StockLinkCheckFacts, StockLinkCheckWrite } from "../../domain/stock-link-check-outcome";
import { STOCK_LINK_ERROR_CODES as C, StockLinkError } from "../../domain/stock-link-errors";
import type { StockLinkClaimedCheck, StockLinkDestinationState } from "../../infrastructure/stock-link-checks.repository";

// Channels PR3: the tick's listing-enrollment pass (application/stock-link-enrollment.run.ts) with its database work,
// the eBay adapter and the Dropship writer replaced by in-memory stand-ins. The decision and the row outcomes are the
// real pure modules, so what the tick writes is what production writes.

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const TARGET = 9;
const STORE = 22;
const destination: StockLinkDestination = { publicationTargetId: TARGET, destinationKind: "dropship_store_connection",
  providerKey: "ebay", channelId: 40, channelConnectionId: null, dropshipStoreConnectionId: STORE, providerScopeType: "account",
  externalScopeId: "dropship-seller", targetRevision: "3" };

interface Row extends StockLinkCheckFacts { revision: number; leaseToken: string | null; errorClass: string | null; message: string | null }
type Offer = StockLinkOfferLookup["offers"][number];

class Harness {
  readonly rows = new Map<number, Row>();
  readonly listings = new Map<number, StockLinkEnrollmentListing>();
  readonly selection = new Map<number, StockLinkSelectionFact>();
  readonly linked = new Set<number>();
  readonly offers = new Map<string, Offer[]>();
  readonly lookups: string[] = [];
  readonly links: DropshipEbayStockReadinessInput[] = [];
  readonly halts: string[] = [];
  readonly deleted: number[] = [];
  lookupFailure: Map<string, unknown> = new Map();
  writer: (input: DropshipEbayStockReadinessInput) => Promise<DropshipEbayStockReadinessResult> = async input => {
    this.linked.add(input.variants[0]!.productVariantId);
    return { status: "ready", commandKey: dropshipEbayStockCommandKey(input.storeConnectionId, input.origin), publicationTargetId: TARGET,
      linkedProductVariantIds: [input.variants[0]!.productVariantId], alreadyLinked: false,
      mappingActions: [{ productVariantId: input.variants[0]!.productVariantId, mappingAction: "create" }], preparation: null, fenceHoldMs: 40 };
  };
  readonly log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  readonly service: StockLinkService;
  private seq = 0;

  constructor(options: { withWriter?: boolean } = {}) {
    const source: StockLinkEnrollmentSource = {
      destinationKind: "dropship_store_connection", providerKey: "ebay",
      listCandidates: async (_client, _destination, after, limit) => {
        const ids = [...this.listings.keys()].filter(id => id > after).sort((a, b) => a - b).slice(0, limit);
        return { candidates: ids.map(id => ({ productVariantId: id, productId: this.listings.get(id)!.productId })),
          nextAfterVariantId: ids.length === limit ? ids[ids.length - 1]! : null };
      },
      listRecentlyChanged: async () => [],
      listCarriedSkus: async () => [...this.listings.values()].map(row => ({ productVariantId: row.productVariantId, sku: row.cardShellzSku })),
      readListings: async (_client, _destination, ids) => ids.flatMap(id => this.listings.has(id) ? [this.listings.get(id)!] : []),
    };
    const adapter: StockLinkOfferAdapter = {
      destinationKind: "dropship_store_connection", providerKey: "ebay",
      findOffersBySku: async (_destination, sku) => {
        this.lookups.push(sku);
        const failure = this.lookupFailure.get(sku);
        if (failure) throw failure;
        return { observedAt: new Date(NOW).toISOString(), sku, marketplaceId: "EBAY_US", offers: this.offers.get(sku) ?? [] };
      },
    };
    const state: StockLinkDestinationState = { autoLinkEnabled: true, pausedUntil: null, pausedCode: null, pausedSince: null,
      haltedAt: null, haltedCode: null, retiresReleasedAt: null, recentCursor: { raw: null, id: null }, sweepAfterVariantId: 0, deadLetterCursor: null };
    const notUsed = async () => { throw new Error("not used by enrollment"); };
    const store: StockLinkTickStore = {
      readAuthority: async () => "canonical",
      listTargets: async () => [{ publicationTargetId: TARGET, destination, destinationKind: destination.destinationKind, providerKey: "ebay", heldAt: null }],
      beat: async () => state,
      saveCursors: async () => undefined,
      insertMissingChecks: async (_t, wanted, now) => wanted.flatMap(({ productVariantId }) => {
        if (this.rows.has(productVariantId)) return [];
        this.rows.set(productVariantId, { status: this.linked.has(productVariantId) ? "linked" : "waiting", reasonCode: null, attemptCount: 0,
          firstFailureAt: null, busySince: null, nextCheckAt: now, updatedAt: now, waitingItemId: null, observedSku: null, revision: 1,
          leaseToken: null, errorClass: null, message: null });
        return [productVariantId];
      }),
      wakeChecks: async () => [],
      deleteUncarriedChecks: async () => [],
      listDeadLetterWakes: async () => ({ productVariantIds: [], lastAt: null }),
      claimDue: async (_t, input) => [...this.rows].filter(([, row]) => row.status !== "error" && row.nextCheckAt! <= input.now)
        .sort(([a], [b]) => a - b).map(([id, row]): StockLinkClaimedCheck => {
          row.leaseToken = input.leaseToken; row.revision += 1;
          return { productVariantId: id, leaseToken: input.leaseToken, revision: String(row.revision), status: row.status,
            observedSku: row.observedSku, nextCheckAt: row.nextCheckAt! };
        }),
      readHeads: async () => [...this.linked].map(id => ({ productVariantId: id, revision: "2",
        active: { mappingId: id, itemId: this.listings.get(id)?.cardShellzSku ?? "X", externalSku: null }, draft: null })),
      readSelection: async (_d, _p, ids) => new Map(ids.map(id => [id, this.selection.get(id) ?? { action: "publish", blockerCodes: [] }])),
      countRecentRetires: notUsed,
      recordOutcomes: async (_t, guards, _now, decide) => guards.flatMap(guard => {
        const row = this.rows.get(guard.productVariantId)!;
        if (row.leaseToken !== guard.leaseToken || String(row.revision) !== guard.revision) return [];
        const write: StockLinkCheckWrite = decide(guard.productVariantId, row);
        Object.assign(row, write, { leaseToken: null, revision: row.revision + 1, updatedAt: new Date(NOW) });
        return [guard.productVariantId];
      }),
      deleteClaimedChecks: async (_t, guards) => guards.map(guard => { this.rows.delete(guard.productVariantId); this.deleted.push(guard.productVariantId); return guard.productVariantId; }),
      pause: async () => true,
      clearPause: async () => null,
      halt: async (_t, input) => { this.halts.push(input.code); return true; },
    };
    this.service = new StockLinkService({ store, registry: createStockLinkRegistry([{ kind: "listing_enrollment", adapter, source }]),
      runCommand: notUsed, db: { query: async () => ({ rows: [] }) }, clock: () => new Date(NOW), monotonicNow: () => 0,
      random: () => 0.5, newLeaseToken: () => `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`, logger: this.log,
      deadline: () => new AbortController().signal,
      ...(options.withWriter === false ? {} : { runEnrollment: input => { this.links.push(input); return this.writer(input); } }) });
  }

  listing(productVariantId: number, overrides: Partial<StockLinkEnrollmentListing> = {}): void {
    this.listings.set(productVariantId, { productVariantId, productId: 20, listingId: productVariantId * 10, vendorId: 10,
      cardShellzSku: `S${productVariantId}`, recordedOfferId: `50${productVariantId}`, environment: "production", managed: true, skipReason: null, ...overrides });
  }
  published(sku: string, ...offerIds: string[]): void {
    this.offers.set(sku, offerIds.map(offerId => ({ offerId, sku, status: "PUBLISHED" as const, listingId: `L${offerId}` })));
  }
}

describe("listing enrollment in the stock-link tick (channels PR3)", () => {
  it("links exactly the recorded PUBLISHED offer through the Dropship writer with origin live_listing_enrollment", async () => {
    const h = new Harness();
    h.listing(101);
    h.published("S101", "50101");
    const summary = await h.service.tick();
    expect(h.links).toHaveLength(1);
    const input = h.links[0]!;
    expect(input).toMatchObject({ vendorId: 10, storeConnectionId: STORE, accountId: "dropship-seller", environment: "production",
      productId: 20, purpose: "sync", variants: [{ productVariantId: 101, sku: "S101" }],
      origin: { kind: "live_listing_enrollment", listingId: 1010 } });
    expect(input.origin.kind === "live_listing_enrollment" && input.origin.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(h.rows.get(101)).toMatchObject({ status: "linked", reasonCode: null });
    expect(summary).toMatchObject({ links: 1, applies: 1, lookups: 1, providerCalls: 1, fenceHoldMsTotal: 40 });
    expect(h.log.info).toHaveBeenCalledWith("inventory_availability.stock_link.linked", expect.objectContaining({
      actor: "system:dropship-stock-enrollment", outcome: "linked", origin_kind: "live_listing_enrollment",
      command_key: dropshipEbayStockCommandKey(STORE, input.origin) }));
  });

  it("waits on a listing that is not on sale or not listed, and never links it", async () => {
    const h = new Harness();
    h.listing(101); h.listing(102);
    h.offers.set("S101", [{ offerId: "50101", sku: "S101", status: "UNPUBLISHED", listingId: null }]);
    await h.service.tick();
    expect(h.links).toEqual([]);
    expect(h.rows.get(101)).toMatchObject({ status: "waiting", reasonCode: D.notOnSale });
    expect(h.rows.get(102)).toMatchObject({ status: "waiting", reasonCode: D.notListed });
  });

  it("flags two PUBLISHED offers for one SKU and two sizes with one SKU, with one ERROR each", async () => {
    const h = new Harness();
    h.listing(101); h.listing(102, { cardShellzSku: "SHARED" }); h.listing(103, { cardShellzSku: "SHARED" });
    h.published("S101", "50101", "59999");
    await h.service.tick();
    expect(h.links).toEqual([]);
    expect(h.rows.get(101)).toMatchObject({ status: "flagged", reasonCode: D.skuDuplicate });
    expect(h.rows.get(102)).toMatchObject({ status: "flagged", reasonCode: D.itemShared });
    expect(h.rows.get(103)).toMatchObject({ status: "flagged", reasonCode: D.itemShared });
    expect(h.lookups).toEqual(["S101"]);
    expect(h.log.error).toHaveBeenCalledTimes(3);
  });

  it("skips a listing with an open push job, an unexpanded publish-run chunk or an open end request: no lookup, no link", async () => {
    const h = new Harness();
    h.listing(101, { skipReason: "push_open" }); h.listing(102, { skipReason: "publish_run_open" }); h.listing(103, { skipReason: "end_open" });
    for (const id of [101, 102, 103]) h.published(`S${id}`, `50${id}`);
    await h.service.tick();
    expect(h.lookups).toEqual([]);
    expect(h.links).toEqual([]);
    expect(h.rows.get(101)).toMatchObject({ status: "waiting", reasonCode: E.listingBusy });
    expect(h.rows.get(102)).toMatchObject({ status: "waiting", reasonCode: E.listingBusy });
    expect(h.rows.get(103)).toMatchObject({ status: "waiting", reasonCode: E.listingEnding });
  });

  it("links a removed (zero) size with purpose sync, and removes the row of a size no longer carried", async () => {
    const h = new Harness();
    h.listing(101); h.listing(102);
    h.selection.set(101, { action: "zero", blockerCodes: [] });
    h.selection.set(102, { action: "none", blockerCodes: [] });
    h.published("S101", "50101");
    await h.service.tick();
    expect(h.links.map(input => [input.variants[0]!.productVariantId, input.purpose])).toEqual([[101, "sync"]]);
    expect(h.rows.get(101)).toMatchObject({ status: "linked" });
    expect(h.deleted).toEqual([102]);
  });

  it("keeps an already-linked size without reading eBay or calling the writer", async () => {
    const h = new Harness();
    h.listing(101);
    h.linked.add(101);
    await h.service.tick();
    expect(h.lookups).toEqual([]);
    expect(h.links).toEqual([]);
    expect(h.rows.get(101)).toMatchObject({ status: "linked" });
  });

  it("stops one SKU whose lookup eBay refused (row error) and goes on with the others", async () => {
    const h = new Harness();
    h.listing(101); h.listing(102);
    h.lookupFailure.set("S101", new StockLinkError(C.lookupRejected, "eBay refused the offer lookup (HTTP 400).", {}));
    h.published("S102", "50102");
    await h.service.tick();
    expect(h.rows.get(101)).toMatchObject({ status: "error", reasonCode: C.lookupRejected, errorClass: "permanent", nextCheckAt: null });
    expect(h.rows.get(102)).toMatchObject({ status: "linked" });
    expect(h.halts).toEqual([]);
  });

  it("pauses the reads on a throttled store and releases the unread sizes without an attempt", async () => {
    const h = new Harness();
    h.listing(101); h.listing(102);
    h.lookupFailure.set("S101", new StockLinkError(C.providerThrottled, "throttled", {}, { retryAfterMs: 5_000 }));
    h.published("S102", "50102");
    await h.service.tick();
    expect(h.lookups).toEqual(["S101"]);
    expect(h.links).toEqual([]);
    expect(h.rows.get(101)).toMatchObject({ status: "waiting", reasonCode: C.providerThrottled, attemptCount: 1 });
    expect(h.rows.get(102)).toMatchObject({ status: "waiting", reasonCode: C.providerThrottled, attemptCount: 1 });
  });

  it("records the writer's races and refusals on the row, and halts the store on a fatal writer failure", async () => {
    const busy = new Harness();
    busy.listing(101);
    busy.published("S101", "50101");
    busy.writer = async () => { throw Object.assign(new Error("busy"), { code: "STOCK_MAPPING_PROVIDER_BUSY" }); };
    await busy.service.tick();
    expect(busy.rows.get(101)).toMatchObject({ status: "waiting", reasonCode: "STOCK_MAPPING_PROVIDER_BUSY", attemptCount: 0 });

    const blocked = new Harness();
    blocked.listing(101);
    blocked.published("S101", "50101");
    blocked.writer = async input => ({ status: "blocked", commandKey: dropshipEbayStockCommandKey(STORE, input.origin), publicationTargetId: TARGET,
      targetCount: 1, blockers: [{ code: "STOCK_LISTING_MAPPING_REVIEW_REQUIRED", message: "m", action: "review_mapping", productVariantId: 101 }] });
    await blocked.service.tick();
    expect(blocked.rows.get(101)).toMatchObject({ status: "flagged", reasonCode: E.mappingReview });

    const fatal = new Harness();
    fatal.listing(101);
    fatal.published("S101", "50101");
    fatal.writer = async () => { throw new Error("unknown"); };
    await fatal.service.tick();
    expect(fatal.halts).toEqual([C.unclassified]);
  });

  it("stops linking at the per-tick command budget and leaves the rest busy (no attempt)", async () => {
    const h = new Harness();
    const count = STOCK_LINK_TICK_LIMITS.commandsPerTick + 2;
    for (let id = 101; id < 101 + count; id += 1) { h.listing(id); h.published(`S${id}`, `50${id}`); }
    await h.service.tick();
    expect(h.links).toHaveLength(STOCK_LINK_TICK_LIMITS.commandsPerTick);
    const busy = [...h.rows.values()].filter(row => row.reasonCode === C.fenceBudgetUsed);
    expect(busy).toHaveLength(2);
    expect(busy.every(row => row.attemptCount === 0 && row.status === "waiting")).toBe(true);
  });

  it("halts a destination whose binding has no writer (never a guess)", async () => {
    const h = new Harness({ withWriter: false });
    h.listing(101);
    await h.service.tick();
    expect(h.halts).toEqual([C.policyMissing]);
    expect(h.lookups).toEqual([]);
  });
});
