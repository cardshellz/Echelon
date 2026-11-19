import { describe, expect, it } from "vitest";
import {
  decideDueRowAction,
  decideGlobalBreaker,
  decideListingEndClaim,
  decideStoreBreaker,
  decideWithdrawCap,
  endingRowSendsNothing,
  LISTING_END_CLAIMS_PER_TICK,
  LISTING_END_IDENTITY_ISSUE_CODES,
  LISTING_END_MAX_PER_HOUR,
  LISTING_END_MAX_PER_STORE_PER_HOUR,
  LISTING_END_STORE_BREAKER_COOLDOWN_MS,
  listingEndQuantityScope,
  parseListingEndResolvedIdentity,
  type ListingEndClaimFacts,
  type ListingEndDueRowFacts,
  type ListingEndGlobalFacts,
  type ListingEndStoreFacts,
  type ListingEndTickCounters,
} from "../../domain/listing-end-claims";
import { LISTING_END_CODES } from "../../domain/listing-end-errors";
import { quantityPublicationScopeSchema } from "../../../inventory-planning/domain/quantity-publication-admission";

/** The end worker's pure gates and the claim's table (PLAN-C v4.1 §5.3, §5.4; D42, SAF-4, SAF-6, SAF-7). */
const NOW = new Date("2026-10-26T09:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const C = LISTING_END_CODES;

function store(overrides: Partial<ListingEndStoreFacts> = {}): ListingEndStoreFacts {
  return { storeConnectionId: 22, newestDecided: [], hasVerifiedEnd: true, endingCount: 0, callsInWindow: 0, oldestCallInWindowAt: null,
    ...overrides };
}
function global(overrides: Partial<ListingEndGlobalFacts> = {}): ListingEndGlobalFacts {
  return { failuresInWindow: 0, failuresInTwoWindows: 0, newestFailureAt: null, verifiedEndSinceNewestFailure: false, callsInWindow: 0,
    oldestCallInWindowAt: null, ...overrides };
}
function counters(overrides: Partial<ListingEndTickCounters> = {}): ListingEndTickCounters {
  return { claims: 0, claimsByStore: new Map(), endingByStore: new Map(), verifiedStores: new Set(), callsByStore: new Map(), calls: 0,
    ...overrides };
}
function row(overrides: Partial<ListingEndDueRowFacts> = {}): ListingEndDueRowFacts {
  return { storeConnectionId: 22, state: "pending", withdrawOutcome: null, withdrawRequestedAt: null, withdrawReturnedAt: null, ...overrides };
}
const failed = (at: Date) => ({ state: "failed" as const, decidedAt: at });
const ended = (at: Date) => ({ state: "ended" as const, decidedAt: at });

describe("store breaker (§5.3)", () => {
  it("opens after three failures in a row, the newest younger than 6 h, until 6 h after it", () => {
    expect(decideStoreBreaker(store({ newestDecided: [failed(ago(1_000)), failed(ago(2_000)), failed(ago(3_000))] }), NOW))
      .toEqual({ state: "open", until: new Date(ago(1_000).getTime() + LISTING_END_STORE_BREAKER_COOLDOWN_MS) });
  });

  it("half-opens once the newest of the three is 6 h old, and closes after a verified end", () => {
    const old = [failed(ago(6 * HOUR)), failed(ago(7 * HOUR)), failed(ago(8 * HOUR))];
    expect(decideStoreBreaker(store({ newestDecided: old }), NOW)).toEqual({ state: "half_open" });
    expect(decideStoreBreaker(store({ newestDecided: [ended(ago(10)), ...old].slice(0, 3) }), NOW)).toEqual({ state: "closed" });
  });

  it("stays closed with fewer than three decided ends or an end among them, and reopens on three new failures", () => {
    expect(decideStoreBreaker(store({ newestDecided: [failed(ago(1)), failed(ago(2))] }), NOW)).toEqual({ state: "closed" });
    expect(decideStoreBreaker(store({ newestDecided: [failed(ago(1)), ended(ago(2)), failed(ago(3))] }), NOW)).toEqual({ state: "closed" });
    expect(decideStoreBreaker(store({ newestDecided: [failed(ago(1)), failed(ago(2)), failed(ago(3)), ended(ago(4))] }), NOW).state).toBe("open");
  });
});

describe("global breaker (§5.3; D-C4-3)", () => {
  it("opens at 10 failures in the last hour, until an hour after the newest", () => {
    expect(decideGlobalBreaker(global({ failuresInWindow: 10, failuresInTwoWindows: 10, newestFailureAt: ago(60_000) }), NOW))
      .toEqual({ state: "open", until: new Date(ago(60_000).getTime() + HOUR) });
    expect(decideGlobalBreaker(global({ failuresInWindow: 9, failuresInTwoWindows: 9, newestFailureAt: ago(60_000) }), NOW))
      .toEqual({ state: "closed" });
  });

  it("then half-opens until a verified end or until those failures are two hours old", () => {
    expect(decideGlobalBreaker(global({ failuresInWindow: 0, failuresInTwoWindows: 12, newestFailureAt: ago(HOUR + 1) }), NOW))
      .toEqual({ state: "half_open" });
    expect(decideGlobalBreaker(global({ failuresInWindow: 0, failuresInTwoWindows: 12, newestFailureAt: ago(HOUR + 1),
      verifiedEndSinceNewestFailure: true }), NOW)).toEqual({ state: "closed" });
    expect(decideGlobalBreaker(global({ failuresInWindow: 0, failuresInTwoWindows: 0, newestFailureAt: null }), NOW)).toEqual({ state: "closed" });
  });
});

describe("decideDueRowAction (§5.3; SAF-6)", () => {
  const openStore = store({ newestDecided: [failed(ago(1)), failed(ago(2)), failed(ago(3))] });
  const openGlobal = global({ failuresInWindow: 10, failuresInTwoWindows: 10, newestFailureAt: ago(1) });

  it("claims a pending row when nothing stops it", () => {
    expect(decideDueRowAction({ row: row(), store: store(), global: global(), counters: counters(), now: NOW })).toEqual({ action: "claim" });
  });

  it("claims nothing while the store's or the global breaker is open", () => {
    expect(decideDueRowAction({ row: row(), store: openStore, global: global(), counters: counters(), now: NOW }))
      .toEqual({ action: "skip", reason: "breaker_open" });
    expect(decideDueRowAction({ row: row(), store: store(), global: openGlobal, counters: counters(), now: NOW }))
      .toEqual({ action: "skip", reason: "breaker_open" });
  });

  it("defers an ending row that could send to the breaker's half-open time, and lets a verify-only row through", () => {
    const couldSend = row({ state: "ending" });
    expect(decideDueRowAction({ row: couldSend, store: openStore, global: global(), counters: counters(), now: NOW }))
      .toEqual({ action: "defer", code: C.breakerOpen, until: new Date(ago(1).getTime() + LISTING_END_STORE_BREAKER_COOLDOWN_MS) });
    expect(decideDueRowAction({ row: couldSend, store: store(), global: openGlobal, counters: counters(), now: NOW }))
      .toEqual({ action: "defer", code: C.breakerOpen, until: new Date(ago(1).getTime() + HOUR) });
    // The later of the two breakers wins.
    expect(decideDueRowAction({ row: couldSend, store: openStore, global: openGlobal, counters: counters(), now: NOW }))
      .toMatchObject({ until: new Date(ago(1).getTime() + LISTING_END_STORE_BREAKER_COOLDOWN_MS) });
    const verifyOnly = row({ state: "ending", withdrawOutcome: "ok", withdrawRequestedAt: ago(100), withdrawReturnedAt: ago(90) });
    const crashCheck = row({ state: "ending", withdrawRequestedAt: ago(100), withdrawReturnedAt: null });
    for (const sendsNothing of [verifyOnly, crashCheck]) {
      expect(endingRowSendsNothing(sendsNothing)).toBe(true);
      expect(decideDueRowAction({ row: sendsNothing, store: openStore, global: openGlobal, counters: counters(), now: NOW }))
        .toEqual({ action: "work" });
    }
    expect(endingRowSendsNothing(row({ state: "ending", withdrawOutcome: "rejected_429", withdrawRequestedAt: ago(9), withdrawReturnedAt: ago(8) })))
      .toBe(false);
  });

  it("works an ending row while a breaker is only half-open", () => {
    const halfOpen = store({ newestDecided: [failed(ago(7 * HOUR)), failed(ago(8 * HOUR)), failed(ago(9 * HOUR))] });
    expect(decideDueRowAction({ row: row({ state: "ending" }), store: halfOpen, global: global(), counters: counters(), now: NOW }))
      .toEqual({ action: "work" });
  });

  it("runs a canary: a store with no verified end claims one at a time until its first verified end", () => {
    const canary = store({ hasVerifiedEnd: false });
    expect(decideDueRowAction({ row: row(), store: canary, global: global(), counters: counters(), now: NOW })).toEqual({ action: "claim" });
    expect(decideDueRowAction({ row: row(), store: canary, global: global(), now: NOW,
      counters: counters({ claimsByStore: new Map([[22, 1]]) }) })).toEqual({ action: "skip", reason: "one_at_a_time" });
    expect(decideDueRowAction({ row: row(), store: { ...canary, endingCount: 1 }, global: global(), counters: counters(), now: NOW }))
      .toEqual({ action: "skip", reason: "one_at_a_time" });
    // The tick's own counters win over the facts it read: the ending row finished.
    expect(decideDueRowAction({ row: row(), store: { ...canary, endingCount: 1 }, global: global(), now: NOW,
      counters: counters({ endingByStore: new Map([[22, 0]]) }) })).toEqual({ action: "claim" });
    // A verified end this tick closes the canary: several claims may follow.
    expect(decideDueRowAction({ row: row(), store: canary, global: global(), now: NOW,
      counters: counters({ claimsByStore: new Map([[22, 1]]), endingByStore: new Map([[22, 0]]), verifiedStores: new Set([22]) }) }))
      .toEqual({ action: "claim" });
  });

  it("half-open store: one at a time while it has an ending row; half-open global: one claim a tick in all", () => {
    const halfOpen = store({ newestDecided: [failed(ago(7 * HOUR)), failed(ago(8 * HOUR)), failed(ago(9 * HOUR))] });
    expect(decideDueRowAction({ row: row(), store: { ...halfOpen, endingCount: 1 }, global: global(), counters: counters(), now: NOW }))
      .toEqual({ action: "skip", reason: "one_at_a_time" });
    const halfOpenGlobal = global({ failuresInTwoWindows: 10, newestFailureAt: ago(HOUR + 1) });
    expect(decideDueRowAction({ row: row(), store: store(), global: halfOpenGlobal, counters: counters(), now: NOW })).toEqual({ action: "claim" });
    expect(decideDueRowAction({ row: row({ storeConnectionId: 23 }), store: store({ storeConnectionId: 23 }), global: halfOpenGlobal, now: NOW,
      counters: counters({ claims: 1 }) })).toEqual({ action: "skip", reason: "one_at_a_time" });
  });

  it("claims at most 25 a tick, and none when the store's or the global hourly calls are used up", () => {
    expect(decideDueRowAction({ row: row(), store: store(), global: global(), counters: counters({ claims: LISTING_END_CLAIMS_PER_TICK }), now: NOW }))
      .toEqual({ action: "skip", reason: "claims_per_tick" });
    expect(decideDueRowAction({ row: row(), store: store({ callsInWindow: LISTING_END_MAX_PER_STORE_PER_HOUR }), global: global(),
      counters: counters(), now: NOW })).toEqual({ action: "skip", reason: "cap" });
    expect(decideDueRowAction({ row: row(), store: store({ callsInWindow: LISTING_END_MAX_PER_STORE_PER_HOUR - 1 }), global: global(),
      counters: counters({ callsByStore: new Map([[22, 1]]) }), now: NOW })).toEqual({ action: "skip", reason: "cap" });
    expect(decideDueRowAction({ row: row(), store: store(), global: global({ callsInWindow: LISTING_END_MAX_PER_HOUR }),
      counters: counters(), now: NOW })).toEqual({ action: "skip", reason: "cap" });
  });
});

describe("decideWithdrawCap (§5.3; D-C4-4)", () => {
  const full = store({ callsInWindow: LISTING_END_MAX_PER_STORE_PER_HOUR, oldestCallInWindowAt: ago(HOUR - 60_000) });

  it("sends when there is room, or when the row's newest call already counts", () => {
    expect(decideWithdrawCap({ row: row({ state: "ending" }), store: store(), global: global(), counters: counters(), now: NOW }))
      .toEqual({ outcome: "send" });
    expect(decideWithdrawCap({ row: row({ state: "ending", withdrawRequestedAt: ago(60_000), withdrawOutcome: "rejected_429" }), store: full,
      global: global(), counters: counters(), now: NOW })).toEqual({ outcome: "send" });
  });

  it("waits CAP_REACHED until the oldest counted call leaves the window; an admission refusal or an old call never counts", () => {
    expect(decideWithdrawCap({ row: row({ state: "ending" }), store: full, global: global(), counters: counters(), now: NOW }))
      .toEqual({ outcome: "defer", code: C.capReached, until: new Date(NOW.getTime() + 60_000) });
    expect(decideWithdrawCap({ row: row({ state: "ending", withdrawRequestedAt: ago(60_000), withdrawOutcome: "admission_PUBLICATION_SCOPE_BUSY" }),
      store: full, global: global(), counters: counters(), now: NOW }).outcome).toBe("defer");
    expect(decideWithdrawCap({ row: row({ state: "ending", withdrawRequestedAt: ago(HOUR + 1), withdrawOutcome: "rejected_429" }),
      store: full, global: global(), counters: counters(), now: NOW }).outcome).toBe("defer");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The claim (§5.4 a-k)

const IDS = { vendorId: 10, storeConnectionId: 22, productId: 20, productVariantId: 101 };
function facts(overrides: Partial<Extract<ListingEndClaimFacts, { archived: false }>> = {}): ListingEndClaimFacts {
  return {
    archived: false, reason: "size_removed", ids: IDS, rePicked: false,
    listing: { status: "active", marketplaceEndedAt: null, externalOfferId: "OFFER-101", externalListingId: "110000000101", marketplaceIssueCodes: [] },
    pushProcessing: false, unsettledPushAttempt: false, staleRecoveredItem: false,
    store: { platform: "ebay", status: "connected", externalAccountId: "seller-22", externalAccountVerifiedAt: ago(HOUR), providerEnvironment: "production" },
    intent: { sku: "CS-TOP-101", marketplaceId: "EBAY_US" },
    requested: { externalListingId: "110000000101", externalOfferId: "OFFER-101", externalAccountId: "seller-22", providerEnvironment: "production" },
    sharedWith: null,
    ...overrides,
  };
}

function codeOf(decision: ReturnType<typeof decideListingEndClaim>): string | null {
  return "code" in decision ? decision.code : null;
}

describe("decideListingEndClaim (§5.4 a-k, first match wins)", () => {
  it("(a) supersedes an archived size: retirement owns it", () => {
    expect(decideListingEndClaim({ archived: true })).toEqual({ outcome: "superseded", code: C.archived });
  });

  it("(b) supersedes a re-picked size or product", () => {
    expect(decideListingEndClaim(facts({ rePicked: true }))).toEqual({ outcome: "superseded", code: C.rePicked });
    expect(decideListingEndClaim(facts({ reason: "product_removed", rePicked: true }))).toEqual({ outcome: "superseded", code: C.rePicked });
  });

  it("(c) supersedes a listing that already ended (the vendor's end stands)", () => {
    const base = (facts() as Extract<ListingEndClaimFacts, { archived: false }>).listing;
    expect(decideListingEndClaim(facts({ listing: { ...base, status: "ended" } }))).toEqual({ outcome: "superseded", code: C.alreadyEnded });
    expect(decideListingEndClaim(facts({ listing: { ...base, marketplaceEndedAt: ago(1) } }))).toEqual({ outcome: "superseded", code: C.alreadyEnded });
  });

  it("(d) waits for a push being sent (processing only; queued items meet the fence)", () => {
    expect(decideListingEndClaim(facts({ pushProcessing: true }))).toEqual({ outcome: "deferred", code: C.waitingForPush });
  });

  it("(e) no ids: fails for review when a send may have reached eBay, else supersedes NOTHING_LISTED (SAF-7)", () => {
    const base = (facts() as Extract<ListingEndClaimFacts, { archived: false }>).listing;
    const noIds = { ...base, externalOfferId: null, externalListingId: "  " };
    expect(decideListingEndClaim(facts({ listing: noIds }))).toEqual({ outcome: "superseded", code: C.nothingListed });
    expect(decideListingEndClaim(facts({ listing: noIds, unsettledPushAttempt: true })))
      .toEqual({ outcome: "failed", code: C.identityMissing, context: { reason: "unsettled_push_attempt" } });
    expect(decideListingEndClaim(facts({ listing: noIds, staleRecoveredItem: true })))
      .toEqual({ outcome: "failed", code: C.identityMissing, context: { reason: "stale_recovered_push" } });
  });

  it("(f, f2) waits for a store that is not connected, then for an unverified account (6 h deferrals)", () => {
    const base = (facts() as Extract<ListingEndClaimFacts, { archived: false }>).store;
    expect(decideListingEndClaim(facts({ store: { ...base, status: "needs_reauth" } }))).toEqual({ outcome: "deferred", code: C.storeNotConnected });
    expect(decideListingEndClaim(facts({ store: { ...base, externalAccountVerifiedAt: null } })))
      .toEqual({ outcome: "deferred", code: C.storeAccountUnverified });
  });

  it("(g) fails IDENTITY_MISSING without an offer id, a push SKU or a store account", () => {
    const base = facts() as Extract<ListingEndClaimFacts, { archived: false }>;
    for (const [overrides, reason] of [
      [{ listing: { ...base.listing, externalOfferId: null } }, "offer_id_missing"],
      [{ intent: null }, "sku_missing"],
      [{ intent: { sku: null, marketplaceId: "EBAY_US" } }, "sku_missing"],
      [{ store: { ...base.store, externalAccountId: " " } }, "account_missing"],
      [{ store: { ...base.store, platform: "shopify" } }, "not_an_ebay_store"],
      [{ store: { ...base.store, providerEnvironment: "staging" } }, "environment_invalid"],
    ] as const) {
      expect(decideListingEndClaim(facts(overrides as never))).toEqual({ outcome: "failed", code: C.identityMissing, context: { reason } });
    }
  });

  it.each(LISTING_END_IDENTITY_ISSUE_CODES)("(h) fails IDENTITY_MISMATCH for the listing issue %s", (issue) => {
    const base = (facts() as Extract<ListingEndClaimFacts, { archived: false }>).listing;
    expect(decideListingEndClaim(facts({ listing: { ...base, marketplaceIssueCodes: ["ended_out_of_stock", issue] } })))
      .toEqual({ outcome: "failed", code: C.identityMismatch, context: { issueCodes: [issue] } });
  });

  it("(h) names every identity issue sync-back raises, and no other", () => {
    expect([...LISTING_END_IDENTITY_ISSUE_CODES]).toEqual(["sku_changed", "offer_missing", "variation_listing_unsupported",
      "observation_unreadable", "sync_requires_review"]);
    const base = (facts() as Extract<ListingEndClaimFacts, { archived: false }>).listing;
    expect(decideListingEndClaim(facts({ listing: { ...base, marketplaceIssueCodes: ["ended_out_of_stock", "relisted_after_end"] } })).outcome)
      .toBe("ending");
  });

  it("(i) fails ACCOUNT_CHANGED when the store's account or recorded environment moved since the save", () => {
    const base = facts() as Extract<ListingEndClaimFacts, { archived: false }>;
    const changed = { outcome: "failed", code: C.accountChanged, context: { reason: "store_account_changed_since_save" } };
    expect(decideListingEndClaim(facts({ requested: { ...base.requested, externalAccountId: "seller-other" } }))).toEqual(changed);
    expect(decideListingEndClaim(facts({ requested: { ...base.requested, externalAccountId: null } }))).toEqual(changed);
    expect(decideListingEndClaim(facts({ requested: { ...base.requested, providerEnvironment: "sandbox" } }))).toEqual(changed);
    // A save that recorded no environment compares none.
    expect(decideListingEndClaim(facts({ requested: { ...base.requested, providerEnvironment: null } })).outcome).toBe("ending");
  });

  it("(j) fails SHARED_LISTING, Dropship-wide or with a Card Shellz channel (SAF-4)", () => {
    expect(decideListingEndClaim(facts({ sharedWith: "dropship_listing" })))
      .toEqual({ outcome: "failed", code: C.sharedListing, context: { sharedWith: "dropship_listing" } });
    expect(decideListingEndClaim(facts({ sharedWith: "card_shellz_channel" })))
      .toEqual({ outcome: "failed", code: C.sharedListing, context: { sharedWith: "card_shellz_channel" } });
  });

  it("(k) starts the end with the retirement view's Dropship identity", () => {
    expect(decideListingEndClaim(facts())).toEqual({ outcome: "ending", context: {}, resolvedIdentity: {
      destinationKind: "dropship_store_connection", connectionId: 22, channelId: null, vendorId: 10, provider: "ebay",
      accountId: "seller-22", environment: "production", market: "EBAY_US", productId: 20, productVariantId: 101,
      externalSku: "CS-TOP-101", externalProductId: "110000000101", externalVariantId: "OFFER-101", externalInventoryItemId: null,
      identityConflict: false } });
  });

  it("(k) defaults the market to EBAY_US and says so; a NULL environment is production; an offer without a listing id is fine", () => {
    const base = facts() as Extract<ListingEndClaimFacts, { archived: false }>;
    const decided = decideListingEndClaim(facts({ intent: { sku: "CS-TOP-101", marketplaceId: null },
      store: { ...base.store, providerEnvironment: null }, requested: { ...base.requested, providerEnvironment: null },
      listing: { ...base.listing, externalListingId: null } }));
    expect(decided).toMatchObject({ outcome: "ending", context: { marketDefaulted: true },
      resolvedIdentity: { market: "EBAY_US", environment: "production", externalProductId: null } });
  });

  it("checks in table order: a re-picked ended size is RE_PICKED; a processing push waits before a missing account fails", () => {
    const base = facts() as Extract<ListingEndClaimFacts, { archived: false }>;
    expect(codeOf(decideListingEndClaim(facts({ rePicked: true, listing: { ...base.listing, status: "ended" } })))).toBe(C.rePicked);
    expect(codeOf(decideListingEndClaim(facts({ pushProcessing: true, store: { ...base.store, externalAccountId: null } })))).toBe(C.waitingForPush);
    expect(codeOf(decideListingEndClaim(facts({ store: { ...base.store, status: "paused", externalAccountId: null } })))).toBe(C.storeNotConnected);
    expect(codeOf(decideListingEndClaim(facts({ sharedWith: "dropship_listing", requested: { ...base.requested, externalAccountId: "x" } }))))
      .toBe(C.accountChanged);
  });
});

describe("review: claim order and send-nothing rows (DB-1, WRK-2, WRK-4)", () => {
  it("waits for a push being sent before any state change: a re-picked or already-ended size with a processing item defers (DB-1)", () => {
    // A state change while the claim holds the listing re-plans the product (the end table's trigger), so it must never
    // happen while a push completion of that listing holds the product's work row and waits for the listing.
    const base = facts() as Extract<ListingEndClaimFacts, { archived: false }>;
    expect(decideListingEndClaim(facts({ pushProcessing: true, rePicked: true }))).toEqual({ outcome: "deferred", code: C.waitingForPush });
    expect(decideListingEndClaim(facts({ pushProcessing: true, listing: { ...base.listing, status: "ended" } })))
      .toEqual({ outcome: "deferred", code: C.waitingForPush });
    // (a) is read before the listing lock, so an archived size is still superseded at once.
    expect(decideListingEndClaim({ archived: true })).toEqual({ outcome: "superseded", code: C.archived });
    // With nothing processing, the order of (b) and (c) is as before.
    expect(codeOf(decideListingEndClaim(facts({ rePicked: true, listing: { ...base.listing, status: "ended" } })))).toBe(C.rePicked);
  });

  it("lets an ending row whose recorded outcome may have applied through an open breaker: it fails without sending (WRK-2)", () => {
    const openStore = store({ newestDecided: [failed(ago(1)), failed(ago(2)), failed(ago(3))] });
    for (const outcome of ["network", "uncertain_500", "admission_PUBLICATION_COMPLETION_CONFLICT"]) {
      const recorded = row({ state: "ending", withdrawOutcome: outcome, withdrawRequestedAt: ago(100), withdrawReturnedAt: ago(90) });
      expect(endingRowSendsNothing(recorded), outcome).toBe(true);
      expect(decideDueRowAction({ row: recorded, store: openStore, global: global(), counters: counters(), now: NOW })).toEqual({ action: "work" });
    }
    for (const outcome of ["rejected_429", "admission_PUBLICATION_SCOPE_BUSY", "unsent_503"]) {
      expect(endingRowSendsNothing(row({ state: "ending", withdrawOutcome: outcome, withdrawRequestedAt: ago(100), withdrawReturnedAt: ago(90) })),
        outcome).toBe(false);
    }
  });

  it("never counts a call that sent nothing against the hourly caps (WRK-4)", () => {
    const full = store({ callsInWindow: LISTING_END_MAX_PER_STORE_PER_HOUR, oldestCallInWindowAt: ago(HOUR - 60_000) });
    expect(decideWithdrawCap({ row: row({ state: "ending", withdrawRequestedAt: ago(60_000), withdrawOutcome: "unsent_503" }),
      store: full, global: global(), counters: counters(), now: NOW }).outcome).toBe("defer");
  });
});

describe("the resolved identity and its reconcile scope", () => {
  it("parses only a complete Dropship eBay identity", () => {
    const resolved = (decideListingEndClaim(facts()) as { resolvedIdentity: unknown }).resolvedIdentity;
    expect(parseListingEndResolvedIdentity(resolved)).toEqual(resolved);
    for (const broken of [{ destinationKind: "channel_connection" }, { externalVariantId: null }, { externalSku: null }, { vendorId: null },
      { accountId: null }, { identityConflict: true }, { extra: 1 }]) {
      expect(() => parseListingEndResolvedIdentity({ ...(resolved as object), ...broken })).toThrow();
    }
  });

  it("is the admission's own scope under the strict schema (productId and productVariantId null, FID-8)", () => {
    const resolved = parseListingEndResolvedIdentity((decideListingEndClaim(facts()) as { resolvedIdentity: unknown }).resolvedIdentity);
    const scope = listingEndQuantityScope(resolved);
    expect(quantityPublicationScopeSchema.parse(scope)).toEqual({ destinationKind: "dropship_store_connection", connectionId: 22,
      providerKey: "ebay", providerScopeType: "account", externalScopeId: "seller-22", externalInventoryItemId: "CS-TOP-101",
      productId: null, productVariantId: null });
  });
});
