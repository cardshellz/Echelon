import { describe, expect, it, vi } from "vitest";
import type { StockLinkDestination } from "@shared/types/stock-link";
import { StockLinkService, createStockLinkRegistry, type StockLinkTickStore } from "../../../inventory-planning/application/stock-link.service";
import { STOCK_LINK_DECISION_CODES as D } from "../../../inventory-planning/domain/stock-link";
import { STOCK_LINK_ENROLLMENT_CODES as E } from "../../../inventory-planning/domain/stock-link-enrollment";
import type { StockLinkCheckFacts, StockLinkCheckWrite } from "../../../inventory-planning/domain/stock-link-check-outcome";
import type { StockLinkClaimedCheck, StockLinkDestinationState } from "../../../inventory-planning/infrastructure/stock-link-checks.repository";
import { createWalmartStockLinkAdapter } from "../../adapters/walmart/walmart-stock-link.adapter";
import { WalmartStockConnectionService } from "../../adapters/walmart/walmart-stock-connection.service";
import { WalmartApiError } from "../../adapters/walmart/walmart-client";
import type { WalmartChannelService } from "../../adapters/walmart/walmart-channel.service";
import { WalmartStockLinkSource, createWalmartStockLinkWriter } from "../../infrastructure/walmart-stock-link-source";
import type { StockLinkEnrollmentListing } from "../../../inventory-planning/application/stock-link.ports";

// Channels PR4: Walmart on the stock-link engine. The engine's tick, the decision and the row outcomes are the real
// modules; the Walmart adapter and link writer are the real ones over a fake Walmart API, listing guard and inventory
// owner; the source's SQL is replaced by in-memory feeds (its SQL is the PG suite's).

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const TARGET = 2;
const destination: StockLinkDestination = { publicationTargetId: TARGET, destinationKind: "channel_connection", providerKey: "walmart",
  channelId: 36, channelConnectionId: 8, dropshipStoreConnectionId: null, providerScopeType: "location", externalScopeId: "node",
  targetRevision: "3" };
const connection = { channel_id: 36, connection_id: 8, partner_id: "partner-36", ship_node_id: "node", environment: "production", revision: 1 };

type Row = { -readonly [K in keyof StockLinkCheckFacts]: StockLinkCheckFacts[K] } & { revision: number; leaseToken: string | null };

class Harness {
  readonly rows = new Map<number, Row>();
  /** Card Shellz Walmart feeds: variant → SKU (productId 20). */
  readonly feeds = new Map<number, string>();
  /** Sealed links: variant → SKU. */
  readonly linked = new Map<number, string>();
  /** What Walmart holds: SKU → lifecycle/published. */
  readonly items = new Map<string, { lifecycleStatus: string; publishedStatus: string }>();
  readonly connects: Record<string, unknown>[] = [];
  readonly guarded: string[][] = [];
  guard: (skus: readonly string[]) => void = () => undefined;
  connectFailure: unknown = null;
  selectionAction: "publish" | "zero" | "none" = "publish";
  readonly log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  readonly service: StockLinkService;
  readonly channels;
  private seq = 0;

  constructor() {
    const catalogItem = vi.fn(async (sku: string) => {
      const item = this.items.get(sku);
      if (!item) throw new WalmartApiError("WALMART_NOT_FOUND", "missing", false, 404);
      return { sku, title: sku, externalProductId: `WPID-${sku}`, externalVariantId: sku, externalInventoryItemId: sku, ...item };
    });
    const account = async () => ({ partnerId: "partner-36", nodes: [{ shipNode: "node", shipNodeName: "n", nodeType: "VIRTUAL", status: "ACTIVE" }] });
    this.channels = {
      connection: vi.fn(async () => connection), requireRuntime: vi.fn(), api: vi.fn(() => ({ account, catalogItem })),
      withListingWrites: vi.fn(async (_account: unknown, skus: readonly string[], work: () => Promise<unknown>) => {
        this.guarded.push([...skus]);
        this.guard(skus);
        return work();
      }),
      observeListingPresence: vi.fn(async (_a: unknown, sku: string) => ({ sku, state: this.items.has(sku) ? "present" : "missing",
        externalProductId: null, checkedAt: new Date(NOW).toISOString() })),
      repository: { enabledChannels: async () => [36], mappings: async () => [...this.feeds].map(([id, sku]) => ({ product_variant_id: id, channel_sku: sku })) },
    };
    const verifiedStock = { connect: vi.fn(async (input: Record<string, unknown>) => {
      this.connects.push(input);
      if (this.connectFailure) throw this.connectFailure;
      const variant = input.productVariantId as number;
      const already = this.linked.get(variant) === input.sku;
      this.linked.set(variant, input.sku as string);
      return { state: already ? "already_connected" as const : "connected" as const, dryRun: false, receipt: null, quantities: [] };
    }) };
    const source = new WalmartStockLinkSource();
    const sql = this;
    const memorySource = {
      destinationKind: source.destinationKind, providerKey: source.providerKey,
      listCandidates: async (_c: unknown, _d: unknown, after: number, limit: number) => {
        const ids = [...sql.feeds.keys()].filter(id => id > after).sort((a, b) => a - b).slice(0, limit);
        return { candidates: ids.map(id => ({ productVariantId: id, productId: 20 })), nextAfterVariantId: null };
      },
      listRecentlyChanged: async () => [],
      listCarriedSkus: async () => [...sql.feeds].map(([productVariantId, sku]) => ({ productVariantId, sku })),
      readListings: async (_c: unknown, _d: unknown, ids: readonly number[]) => ids.flatMap((id): StockLinkEnrollmentListing[] =>
        sql.feeds.has(id) ? [{ productVariantId: id, productId: 20, listingId: id * 10, vendorId: null, cardShellzSku: sql.feeds.get(id)!,
          recordedOfferId: null, environment: "production", managed: true, skipReason: null, requireRecordedOffer: false }] : []),
    };
    const state: StockLinkDestinationState = { autoLinkEnabled: true, pausedUntil: null, pausedCode: null, pausedSince: null,
      haltedAt: null, haltedCode: null, retiresReleasedAt: null, recentCursor: { raw: null, id: null }, sweepAfterVariantId: 0, deadLetterCursor: null };
    const notUsed = async () => { throw new Error("not used by enrollment"); };
    const store: StockLinkTickStore = {
      readAuthority: async () => "canonical",
      listTargets: async () => [{ publicationTargetId: TARGET, destination, destinationKind: "channel_connection", providerKey: "walmart", heldAt: null }],
      beat: async () => state,
      saveCursors: async () => undefined,
      insertMissingChecks: async (_t, wanted, now) => wanted.flatMap(({ productVariantId, firstVerifyAt }) => {
        if (this.rows.has(productVariantId)) return [];
        const linked = this.linked.has(productVariantId);
        this.rows.set(productVariantId, { status: linked ? "linked" : "waiting", reasonCode: null, attemptCount: 0, firstFailureAt: null,
          busySince: null, nextCheckAt: linked ? firstVerifyAt : now, updatedAt: now, waitingItemId: null, observedSku: null, revision: 1, leaseToken: null });
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
      readHeads: async () => [...this.linked].map(([id, sku]) => ({ productVariantId: id, revision: "2",
        active: { mappingId: id, itemId: sku, externalSku: sku }, draft: null })),
      readSelection: async (_d, _p, ids) => new Map(ids.map(id => [id, { action: this.selectionAction, blockerCodes: [] }])),
      countRecentRetires: notUsed,
      recordOutcomes: async (_t, guards, _now, decide) => guards.flatMap(guard => {
        const row = this.rows.get(guard.productVariantId)!;
        if (row.leaseToken !== guard.leaseToken || String(row.revision) !== guard.revision) return [];
        const write: StockLinkCheckWrite = decide(guard.productVariantId, row);
        Object.assign(row, write, { leaseToken: null, revision: row.revision + 1, updatedAt: new Date(NOW) });
        return [guard.productVariantId];
      }),
      deleteClaimedChecks: async (_t, guards) => guards.map(guard => { this.rows.delete(guard.productVariantId); return guard.productVariantId; }),
      pause: async () => true, clearPause: async () => null, halt: async () => true,
    };
    const channels = this.channels as unknown as WalmartChannelService;
    this.service = new StockLinkService({ store, registry: createStockLinkRegistry([{ kind: "listing_enrollment",
      adapter: createWalmartStockLinkAdapter({ channels, clock: () => new Date(NOW) }), source: memorySource,
      writer: createWalmartStockLinkWriter({ channels, verifiedStock, monotonicNow: () => 0 }), followsSkuChange: true }]),
    runCommand: notUsed, db: { query: async () => ({ rows: [] }) }, clock: () => new Date(NOW), monotonicNow: () => 0,
    random: () => 0.5, newLeaseToken: () => `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`, logger: this.log,
    deadline: () => new AbortController().signal });
  }

  published(sku: string): void { this.items.set(sku, { lifecycleStatus: "ACTIVE", publishedStatus: "PUBLISHED" }); }
  /** The scan's nudge (IP requestStockLinkChecks): the rows are due now, a missing row is added waiting. */
  nudge = async (input: { productVariantIds: number[] }) => input.productVariantIds.map(id => {
    const row = this.rows.get(id);
    if (row) row.nextCheckAt = new Date(NOW);
    else this.rows.set(id, { status: this.linked.has(id) ? "linked" : "waiting", reasonCode: null, attemptCount: 0, firstFailureAt: null,
      busySince: null, nextCheckAt: new Date(NOW), updatedAt: new Date(NOW), waitingItemId: null, observedSku: null, revision: 1, leaseToken: null });
    return id;
  });
}

describe("Walmart on the stock-link engine (channels PR4)", () => {
  it("PUBLISHED → linked within one tick: the scan nudges, the engine reads Walmart and links under the listing guard", async () => {
    const h = new Harness();
    h.feeds.set(101, "P5");
    h.items.set("P5", { lifecycleStatus: "ACTIVE", publishedStatus: "SYSTEM_PROBLEM" });
    await h.service.tick();
    expect(h.connects).toEqual([]);
    expect(h.rows.get(101)).toMatchObject({ status: "waiting", reasonCode: D.notOnSale });
    h.published("P5");
    const scan = new WalmartStockConnectionService(h.channels as unknown as WalmartChannelService,
      { pending: async (_c, _n, ids) => ids.filter(id => !h.linked.has(id)) }, h.nudge, h.log);
    expect(await scan.processDue()).toEqual({ nudged: 1, failed: 0 });
    const summary = await h.service.tick();
    expect(h.connects).toEqual([expect.objectContaining({ channelId: 36, connectionId: 8, accountId: "partner-36", environment: "production",
      externalScopeId: "node", productVariantId: 101, sku: "P5", externalProductId: "WPID-P5", lifecycleStatus: "ACTIVE",
      publishedStatus: "PUBLISHED", observedAt: new Date(NOW).toISOString() })]);
    expect(h.connects[0]).not.toHaveProperty("replacesSku");
    expect(h.guarded).toEqual([["P5"]]);
    expect(h.rows.get(101)).toMatchObject({ status: "linked", reasonCode: null });
    expect(summary).toMatchObject({ links: 1, applies: 1 });
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it("links every size of a multi-size product in one tick, each through its own verified link", async () => {
    const h = new Harness();
    h.feeds.set(101, "P5"); h.feeds.set(102, "P6");
    h.published("P5"); h.published("P6");
    expect(await h.service.tick()).toMatchObject({ links: 2 });
    expect(h.connects.map(input => [input.productVariantId, input.sku])).toEqual([[101, "P5"], [102, "P6"]]);
    expect([...h.rows.values()].map(row => row.status)).toEqual(["linked", "linked"]);
  });

  it.each([
    ["stopped", "LISTING_PUBLICATION_STOPPED"],
    ["missing on Walmart", "LISTING_MISSING_ON_PROVIDER"],
    ["archived in the catalog", "CATALOG_PRODUCT_ARCHIVED"],
  ])("never links a %s listing: the guard refuses, the size waits", async (_label, code) => {
    const h = new Harness();
    h.feeds.set(101, "P5"); h.published("P5");
    h.guard = () => { throw Object.assign(new Error(code), { code }); };
    await h.service.tick();
    expect(h.connects).toEqual([]);
    expect(h.linked.size).toBe(0);
    expect(h.rows.get(101)).toMatchObject({ status: "waiting", reasonCode: E.enrollmentBlocked });
  });

  it("a link during an exclusive retirement (the SKU's guard is held) is paused: busy, no attempt counted, no link", async () => {
    const h = new Harness();
    h.feeds.set(101, "P5"); h.published("P5");
    h.guard = () => { throw new WalmartApiError("LISTING_LIFECYCLE_BUSY", "busy", true, 503); };
    await h.service.tick();
    expect(h.connects).toEqual([]);
    expect(h.rows.get(101)).toMatchObject({ status: "waiting", reasonCode: "LISTING_LIFECYCLE_BUSY", attemptCount: 0, errorClass: "transient" });
    expect(h.rows.get(101)!.busySince).not.toBeNull();
  });

  it("no link before a recreated item's stock receipt: the inventory owner's refusal is busy, not a link", async () => {
    const h = new Harness();
    h.feeds.set(101, "P5"); h.published("P5");
    h.connectFailure = Object.assign(new Error("waiting"), { code: "PUBLICATION_RECREATION_WAITING_FOR_ITEM" });
    await h.service.tick();
    expect(h.linked.size).toBe(0);
    expect(h.rows.get(101)).toMatchObject({ status: "waiting", reasonCode: "PUBLICATION_RECREATION_WAITING_FOR_ITEM", attemptCount: 0 });
  });

  describe("Card Shellz SKU changed on a linked size (PLAN-CH-v3 §3.5)", () => {
    const linkedThenRenamed = () => {
      const h = new Harness();
      h.feeds.set(101, "NEW"); h.linked.set(101, "OLD");
      h.rows.set(101, { status: "linked", reasonCode: null, attemptCount: 0, firstFailureAt: null, busySince: null,
        nextCheckAt: new Date(NOW), updatedAt: new Date(NOW - 86_400_000), waitingItemId: null, observedSku: null, revision: 1, leaseToken: null });
      return h;
    };

    it("one published item with the new SKU → relink (the writer is told the old SKU)", async () => {
      const h = linkedThenRenamed();
      h.published("OLD"); h.published("NEW");
      const summary = await h.service.tick();
      expect(h.connects).toEqual([expect.objectContaining({ productVariantId: 101, sku: "NEW", replacesSku: "OLD", externalProductId: "WPID-NEW" })]);
      expect(h.guarded).toEqual([["NEW"]]);
      expect(h.linked.get(101)).toBe("NEW");
      expect(h.rows.get(101)).toMatchObject({ status: "linked", reasonCode: null });
      expect(summary).toMatchObject({ relinks: 1, links: 0 });
      expect(h.log.info).toHaveBeenCalledWith("inventory_availability.stock_link.relinked", expect.objectContaining({ outcome: "relinked" }));
    });

    it("no published item with the new SKU → the old link is kept and recorded as SKU_CHANGED", async () => {
      const h = linkedThenRenamed();
      h.published("OLD");
      h.items.set("NEW", { lifecycleStatus: "ACTIVE", publishedStatus: "UNPUBLISHED" });
      await h.service.tick();
      expect(h.connects).toEqual([]);
      expect(h.linked.get(101)).toBe("OLD");
      expect(h.rows.get(101)).toMatchObject({ status: "linked", reasonCode: E.skuChanged });
      expect(h.rows.get(101)!.nextCheckAt!.getTime()).toBe(NOW + 86_400_000);
    });

    it("an unchanged SKU is a database-only compare: no Walmart read, no write", async () => {
      const h = linkedThenRenamed();
      h.feeds.set(101, "OLD");
      await h.service.tick();
      expect(h.channels.api).not.toHaveBeenCalled();
      expect(h.connects).toEqual([]);
      expect(h.rows.get(101)).toMatchObject({ status: "linked", reasonCode: null });
    });
  });
});

describe("Walmart engine edge cases (channels PR4)", () => {
  it("a feed of a size the Walmart selection does not carry waits (kept, backed off), never linked or removed", async () => {
    const h = new Harness();
    h.feeds.set(101, "P5"); h.published("P5");
    h.selectionAction = "none";
    await h.service.tick();
    expect(h.connects).toEqual([]);
    expect(h.rows.get(101)).toMatchObject({ status: "waiting", reasonCode: E.notCarried });
  });

  it("a missing Walmart connection at write time is a wait, never a destination halt", async () => {
    const h = new Harness();
    h.feeds.set(101, "P5"); h.published("P5");
    h.channels.connection.mockResolvedValueOnce(connection).mockRejectedValueOnce(
      new WalmartApiError("WALMART_CONNECTION_REQUIRED", "Configure the exact Walmart account connection first", false));
    await h.service.tick();
    expect(h.connects).toEqual([]);
    expect(h.rows.get(101)).toMatchObject({ status: "waiting", reasonCode: E.enrollmentBlocked });
    expect(h.log.error).not.toHaveBeenCalled();
  });
});
