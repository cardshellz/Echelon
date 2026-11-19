import { describe, expect, it } from "vitest";
import type { EbayListingInspection } from "../../../marketplace-listings/domain/ebay-listing-inspection";
import {
  DropshipListingEndService,
  listingEndFailedNotificationKey,
  LISTING_END_FAILED_WORDS,
  type DropshipListingEndProvider,
  type DropshipListingEndRepository,
  type ListingEndClaimResult,
  type ListingEndCredential,
  type ListingEndDueEntry,
  type ListingEndFinishResult,
  type ListingEndRow,
  type ListingEndWithdrawResult,
} from "../../application/dropship-listing-end-service";
import { DROPSHIP_NOTIFICATION_EVENTS } from "../../application/dropship-notification-events";
import type { DropshipNotificationSenderInput } from "../../application/dropship-ports";
import type { ListingEndGlobalFacts, ListingEndResolvedIdentity, ListingEndStoreFacts } from "../../domain/listing-end-claims";
import { LISTING_END_CODES, type ListingEndCode, type ListingEndDeferralCode } from "../../domain/listing-end-errors";
import {
  INSPECTION_ACCOUNT,
  INSPECTION_LISTING,
  INSPECTION_OFFER,
  INSPECTION_SKU,
  inspectionWithAccount,
  publishedInspection,
  unpublishedInspection,
} from "../fixtures/listing-end-inspection.fixture";

/**
 * The end worker's service with DI fakes (PLAN-C v4.1 §5.2-§5.7, §13.1): an in-memory repository that applies the
 * real guards (id, state, version; side writes never move the version) and a scripted eBay/inventory provider. No
 * case calls eBay, the network or a database; the clock is fixed.
 */
const NOW = new Date("2026-10-26T09:00:00.000Z");
const C = LISTING_END_CODES;
const VENDOR = 10;
const STORE = 22;

const IDENTITY: ListingEndResolvedIdentity = {
  destinationKind: "dropship_store_connection", connectionId: STORE, channelId: null, vendorId: VENDOR, provider: "ebay",
  accountId: INSPECTION_ACCOUNT, environment: "production", market: "EBAY_US", productId: 20, productVariantId: 101,
  externalSku: INSPECTION_SKU, externalProductId: INSPECTION_LISTING, externalVariantId: INSPECTION_OFFER, externalInventoryItemId: null,
  identityConflict: false,
};

interface StoredRow extends Omit<ListingEndRow, "state"> {
  state: "pending" | "ending" | "ended" | "failed" | "superseded";
  nextAttemptAt: Date | null;
  endedCode?: string | null;
}

function endingRow(overrides: Partial<StoredRow> = {}): StoredRow {
  return { id: 1, vendorId: VENDOR, storeConnectionId: STORE, listingId: 501, productId: 20, productVariantId: 101, reason: "size_removed",
    state: "ending", version: 2, code: null, context: {}, attemptCount: 1, deferralCount: 0, withdrawCallCount: 0,
    withdrawRequestedAt: null, withdrawReturnedAt: null, withdrawOutcome: null, createdAt: NOW, nextAttemptAt: NOW,
    requestedIdentity: { externalListingId: INSPECTION_LISTING, externalOfferId: INSPECTION_OFFER, externalAccountId: INSPECTION_ACCOUNT,
      providerEnvironment: "production" },
    resolvedIdentity: IDENTITY, ...overrides };
}

class MemoryRepository implements DropshipListingEndRepository {
  readonly rows = new Map<number, StoredRow>();
  readonly calls: string[] = [];
  readonly poison: ListingEndDueEntry[] = [];
  olderProcess = false;
  settled = true;
  remoteBusy = false;
  stores: ListingEndStoreFacts[] = [];
  global: ListingEndGlobalFacts = { failuresInWindow: 0, failuresInTwoWindows: 0, newestFailureAt: null, verifiedEndSinceNewestFailure: false,
    callsInWindow: 0, oldestCallInWindowAt: null };
  claimResult: ((row: ListingEndRow) => ListingEndClaimResult) | null = null;
  finishOverride: ListingEndFinishResult | null = null;
  failReads = false;
  /** What the shared-listing re-check before a withdraw answers (WRK-3). */
  sharedWith: "dropship_listing" | "card_shellz_channel" | null = null;
  /** The time each write was stamped with (DB-2/FEN-1); the finish reads its clock inside its transaction. */
  readonly writes: Array<{ call: string; at: Date }> = [];

  constructor(rows: StoredRow[] = []) { for (const row of rows) this.rows.set(row.id, { ...row }); }
  row(id = 1): StoredRow { return this.rows.get(id)!; }

  private guard(row: ListingEndRow): StoredRow | null {
    const stored = this.rows.get(row.id);
    return stored && stored.state === row.state && stored.version === row.version ? stored : null;
  }

  async hasLiveOlderCatalogProcess() { this.calls.push("readiness:older"); return this.olderProcess; }
  async catalogVersionSettled() { this.calls.push("readiness:settled"); return this.settled; }
  async readTickFacts(now: Date) {
    this.calls.push("read");
    if (this.failReads) throw Object.assign(new Error("database unavailable"), { code: "57P01" });
    const due = [...this.rows.values()].filter((row) => (row.state === "pending" || row.state === "ending")
      && row.nextAttemptAt !== null && row.nextAttemptAt.getTime() <= now.getTime())
      .sort((left, right) => left.id - right.id)
      .map((row): ListingEndDueEntry => ({ kind: "row", row: { ...row, state: row.state as "pending" | "ending" } }));
    const stores = this.stores.length ? this.stores : [{ storeConnectionId: STORE, newestDecided: [], hasVerifiedEnd: true, endingCount: 0,
      callsInWindow: 0, oldestCallInWindowAt: null }];
    return { due: [...this.poison, ...due], stores, storeNames: new Map([[STORE, "Card Shop"]]), global: this.global };
  }
  async claim(input: { row: ListingEndRow; now: Date }) {
    this.calls.push(`claim:${input.row.id}`);
    if (!this.claimResult) throw new Error("No claim scripted.");
    const result = this.claimResult(input.row);
    if (result.kind === "decided" && result.decision.outcome === "ending" && result.row) this.rows.set(result.row.id, { ...this.row(result.row.id), ...result.row });
    return result;
  }
  async defer(input: { row: ListingEndRow; code: ListingEndDeferralCode; dueAt: Date; now: Date }) {
    this.calls.push(`defer:${input.code}`);
    this.writes.push({ call: "defer", at: input.now });
    const stored = this.guard(input.row);
    if (!stored) return false;
    Object.assign(stored, { nextAttemptAt: input.dueAt, deferralCount: stored.deferralCount + 1, code: input.code });
    return true;
  }
  async retry(input: { row: ListingEndRow; code: ListingEndCode; attemptCount: number; nextAttemptAt: Date; context: Record<string, unknown>; now: Date }) {
    this.calls.push(`retry:${input.code}`);
    this.writes.push({ call: "retry", at: input.now });
    const stored = this.guard(input.row);
    if (!stored) return false;
    Object.assign(stored, { attemptCount: input.attemptCount, nextAttemptAt: input.nextAttemptAt, code: input.code, context: input.context });
    return true;
  }
  async fail(input: { row: ListingEndRow; code: ListingEndCode; context: Record<string, unknown>; now: Date }) {
    this.calls.push(`fail:${input.code}`);
    this.writes.push({ call: "fail", at: input.now });
    const stored = this.guard(input.row);
    if (!stored) return false;
    Object.assign(stored, { state: "failed", code: input.code, context: input.context, nextAttemptAt: null, version: stored.version + 1 });
    return true;
  }
  async markWithdrawSent(input: { row: ListingEndRow; now: Date }) {
    this.calls.push("withdraw_sent");
    this.writes.push({ call: "withdraw_sent", at: input.now });
    const stored = this.guard(input.row);
    if (!stored || stored.withdrawCallCount >= 3) return false;
    Object.assign(stored, { withdrawRequestedAt: input.now, withdrawReturnedAt: null, withdrawOutcome: null,
      withdrawCallCount: stored.withdrawCallCount + 1 });
    return true;
  }
  async markWithdrawReturned(input: { row: ListingEndRow; outcome: string; sentNothing: boolean; now: Date }) {
    this.calls.push(`withdraw_returned:${input.outcome}`);
    this.writes.push({ call: "withdraw_returned", at: input.now });
    const stored = this.guard(input.row);
    if (!stored || stored.withdrawRequestedAt === null || stored.withdrawReturnedAt !== null) return false;
    Object.assign(stored, { withdrawReturnedAt: input.now, withdrawOutcome: input.outcome,
      withdrawCallCount: stored.withdrawCallCount - (input.sentNothing ? 1 : 0) });
    return true;
  }
  async finish(input: { row: ListingEndRow; identity: ListingEndResolvedIdentity; verified: boolean; clock: () => Date }) {
    this.calls.push(`finish:${input.verified ? "verified" : "not_verified"}`);
    this.writes.push({ call: "finish", at: input.clock() });
    if (this.finishOverride) return this.finishOverride;
    const stored = this.guard(input.row);
    if (!stored) return { kind: "moved" } as const;
    Object.assign(stored, { state: "ended", nextAttemptAt: null, version: stored.version + 1,
      endedCode: input.verified ? null : C.notPublishedOnEbay });
    return { kind: "ended", listingWritten: true } as const;
  }
  async markInvariantBroken(input: { id: number; state: "pending" | "ending"; error: string; now: Date }) {
    this.calls.push(`invariant:${input.id}`);
    const stored = this.rows.get(input.id);
    if (stored && stored.state !== input.state) return null;
    if (stored) Object.assign(stored, { state: "failed", code: C.invariantBroken, nextAttemptAt: null, version: stored.version + 1 });
    return stored ? stored.version : 2;
  }
  async readSharedWith(input: { row: ListingEndRow; identity: ListingEndResolvedIdentity }) {
    this.calls.push(`shared_check:${input.identity.externalVariantId}`);
    return this.sharedWith;
  }
  async withRemoteMemberLock<T>(identity: ListingEndResolvedIdentity, work: () => Promise<T>) {
    this.calls.push(`remote_lock:${identity.externalVariantId}`);
    if (this.remoteBusy) return { acquired: false } as const;
    return { acquired: true, value: await work() } as const;
  }
}

class ScriptedProvider implements DropshipListingEndProvider {
  readonly calls: string[] = [];
  readonly loads: Array<{ rejectedAccessTokenRef?: string }> = [];
  readonly rejections: Array<{ status: number; failureCode: string }> = [];
  inspections: Array<EbayListingInspection | Error> = [];
  reconciles: Array<{ resolved: string[]; unresolved: string[]; busy: boolean } | Error> = [];
  withdrawals: ListingEndWithdrawResult[] = [];
  credential: ListingEndCredential = { externalAccountId: INSPECTION_ACCOUNT, externalAccountVerifiedAt: new Date("2026-10-01T00:00:00Z"),
    environment: "production", accessTokenRef: "dst_ebay_access_1" };
  credentialError: Error | null = null;

  constructor(private readonly log: string[]) {}
  async loadCredential(input: { vendorId: number; storeConnectionId: number; rejectedAccessTokenRef?: string }) {
    this.log.push("credentials");
    this.loads.push({ ...(input.rejectedAccessTokenRef ? { rejectedAccessTokenRef: input.rejectedAccessTokenRef } : {}) });
    if (this.credentialError) throw this.credentialError;
    return this.credential;
  }
  async inspect() {
    this.log.push("inspect");
    const next = this.inspections.shift();
    if (!next) throw new Error("No inspection scripted.");
    if (next instanceof Error) throw next;
    return next;
  }
  async reconcile() {
    this.log.push("reconcile");
    const next = this.reconciles.shift() ?? { resolved: [], unresolved: [], busy: false };
    if (next instanceof Error) throw next;
    return next;
  }
  async withdraw(input: { offerId: string }) {
    this.log.push(`withdraw:${input.offerId}`);
    return this.withdrawals.shift() ?? { outcome: "ok" };
  }
  async recordAccessTokenRejection(input: { status: number; failureCode: string }) {
    this.log.push("record_token_rejection");
    this.rejections.push({ status: input.status, failureCode: input.failureCode });
  }
}

interface Harness {
  service: DropshipListingEndService;
  repository: MemoryRepository;
  provider: ScriptedProvider;
  order: string[];
  logs: Array<{ level: string; action: string; fields: Record<string, unknown> }>;
  sent: DropshipNotificationSenderInput[];
}

function harness(rows: StoredRow[] = [endingRow()], options: { dryRun?: boolean; dedupe?: boolean; clock?: () => Date;
  timer?: () => number } = {}): Harness {
  const order: string[] = [];
  const repository = new MemoryRepository(rows);
  const provider = new ScriptedProvider(order);
  const logs: Harness["logs"] = [];
  const sent: DropshipNotificationSenderInput[] = [];
  const keys = new Set<string>();
  const log = (level: string) => (action: string, fields: Record<string, unknown>) => { logs.push({ level, action, fields }); };
  const service = new DropshipListingEndService({
    repository, provider, clock: { now: options.clock ?? (() => NOW) }, timer: options.timer ?? (() => 0), dryRun: options.dryRun ?? false,
    log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    notificationSender: { send: async (input) => {
      if (options.dedupe && keys.has(input.idempotencyKey)) return { idempotentReplay: true };
      keys.add(input.idempotencyKey);
      sent.push(input);
      return { idempotentReplay: false };
    } },
  });
  return { service, repository, provider, order, logs, sent };
}

function noProviderCall(h: Harness): void {
  expect(h.order).toEqual([]);
}

describe("gates (§5.2; TST-9)", () => {
  it.each([
    ["dry_run", { dryRun: true }, {}],
    ["older_process", {}, { olderProcess: true }],
    ["version_settling", {}, { settled: false }],
  ] as const)("%s: claims nothing and works no ending row", async (gate, options, state) => {
    const h = harness([endingRow(), endingRow({ id: 2, state: "pending", version: 1, resolvedIdentity: null })], options);
    Object.assign(h.repository, state);
    h.repository.claimResult = () => { throw new Error("must not claim"); };
    const result = await h.service.runTick();
    expect(result).toMatchObject({ outcome: "gated", gate, claimed: 0 });
    noProviderCall(h);
    expect(h.repository.calls.filter((call) => call.startsWith("claim") || call === "read")).toEqual([]);
    expect(h.repository.row().state).toBe("ending");
    expect(h.logs.find((line) => line.action === "dropship.listing_end.gate_closed")).toMatchObject({ level: "debug", fields: { gate } });
  });

  it("opens when DRY_RUN is off, no older process reported and version 3 settled", async () => {
    const h = harness();
    h.provider.inspections = [publishedInspection(), unpublishedInspection()];
    expect((await h.service.runTick()).outcome).toBe("completed");
    expect(h.repository.calls.slice(0, 3)).toEqual(["readiness:older", "readiness:settled", "read"]);
  });
});

describe("remote work in order (§5.5)", () => {
  it("credentials → observe → reconcile → withdraw → verify → finish, under the remote-member lock, verified", async () => {
    const h = harness();
    h.provider.inspections = [publishedInspection(), unpublishedInspection()];
    const result = await h.service.runTick();
    expect(h.order).toEqual(["credentials", "inspect", "reconcile", `withdraw:${INSPECTION_OFFER}`, "inspect"]);
    // The shared-listing guard runs again right before the send (WRK-3), on its own short read.
    expect(h.repository.calls).toEqual(["readiness:older", "readiness:settled", "read", `remote_lock:${INSPECTION_OFFER}`,
      `shared_check:${INSPECTION_OFFER}`, "withdraw_sent", "withdraw_returned:ok", "finish:verified"]);
    expect(h.repository.row()).toMatchObject({ state: "ended", endedCode: null, withdrawCallCount: 1, withdrawOutcome: "ok", version: 3 });
    expect(result).toMatchObject({ ended: 1, failed: 0 });
  });

  it("keeps the version through its side writes, so the finish's guard still matches (SAF-11 d)", async () => {
    const h = harness();
    h.provider.inspections = [publishedInspection(), unpublishedInspection()];
    await h.service.runTick();
    // Two side writes (sent, returned) and the finish all matched version 2; only the state change moved it.
    expect(h.repository.row().version).toBe(3);
    expect(h.repository.calls).toContain("finish:verified");
  });

  it("finishes NOT_PUBLISHED_ON_EBAY (not a verified end) when nothing was ever withdrawn and eBay shows it unpublished", async () => {
    const h = harness();
    h.provider.inspections = [unpublishedInspection()];
    await h.service.runTick();
    expect(h.order).toEqual(["credentials", "inspect"]);
    expect(h.repository.row()).toMatchObject({ state: "ended", endedCode: C.notPublishedOnEbay });
  });

  it("verifies before finishing: a withdraw answered ok but still published waits READBACK_PENDING (B12)", async () => {
    const h = harness();
    h.provider.inspections = [publishedInspection(), publishedInspection()];
    await h.service.runTick();
    expect(h.repository.row()).toMatchObject({ state: "ending", code: C.readbackPending, withdrawOutcome: "ok",
      nextAttemptAt: new Date(NOW.getTime() + 60_000) });
    expect(h.repository.calls).not.toContain("finish:verified");
  });

  it("sends a withdraw once: after ok and a READBACK_PENDING the next attempt verifies only (SAF-2, B11)", async () => {
    const h = harness([endingRow({ withdrawCallCount: 1, withdrawRequestedAt: new Date(NOW.getTime() - 120_000),
      withdrawReturnedAt: new Date(NOW.getTime() - 119_000), withdrawOutcome: "ok", code: C.readbackPending, attemptCount: 2 })]);
    h.provider.inspections = [publishedInspection()];
    await h.service.runTick();
    expect(h.order).toEqual(["credentials", "inspect"]);
    expect(h.repository.row()).toMatchObject({ state: "ending", code: C.readbackPending, withdrawCallCount: 1, attemptCount: 3 });
    h.provider.inspections = [unpublishedInspection()];
    h.repository.row().nextAttemptAt = NOW;
    await h.service.runTick();
    expect(h.order.filter((step) => step.startsWith("withdraw"))).toEqual([]);
    expect(h.repository.row()).toMatchObject({ state: "ended", endedCode: null });
  });

  it("starts each new call from a clean result and counts it (the previous refusal's outcome reset)", async () => {
    const h = harness([endingRow({ withdrawCallCount: 1, withdrawRequestedAt: new Date(NOW.getTime() - 600_000),
      withdrawReturnedAt: new Date(NOW.getTime() - 599_000), withdrawOutcome: "rejected_429" })]);
    h.provider.inspections = [publishedInspection(), unpublishedInspection()];
    await h.service.runTick();
    expect(h.repository.row()).toMatchObject({ state: "ended", withdrawCallCount: 2, withdrawOutcome: "ok", withdrawRequestedAt: NOW });
  });

  it("works nothing while the remote-member lock is held elsewhere: REMOTE_BUSY, 30 s", async () => {
    const h = harness();
    h.repository.remoteBusy = true;
    await h.service.runTick();
    noProviderCall(h);
    expect(h.repository.row()).toMatchObject({ state: "ending", code: C.remoteBusy, nextAttemptAt: new Date(NOW.getTime() + 30_000),
      attemptCount: 1, deferralCount: 1 });
  });
});

describe("credentials and accounts (§5.5 step 2; B9)", () => {
  it("fails ACCOUNT_CHANGED when the store's account or environment differs from the resolved identity, before any read", async () => {
    for (const credential of [{ externalAccountId: "seller-other" }, { environment: "sandbox" as const }, { environment: null }]) {
      const h = harness();
      h.provider.credential = { ...h.provider.credential, ...credential };
      await h.service.runTick();
      expect(h.order).toEqual(["credentials"]);
      expect(h.repository.row()).toMatchObject({ state: "failed", code: C.accountChanged, context: { requiresReview: true } });
    }
  });

  it("fails ACCOUNT_CHANGED when eBay answers for another account", async () => {
    const h = harness();
    h.provider.inspections = [inspectionWithAccount("seller-other")];
    await h.service.runTick();
    expect(h.order).toEqual(["credentials", "inspect"]);
    expect(h.repository.row()).toMatchObject({ state: "failed", code: C.accountChanged });
  });

  it("waits 6 h for a store that is not connected or an account that is not verified (no attempt)", async () => {
    const notConnected = harness();
    notConnected.provider.credentialError = Object.assign(new Error("x"), { code: "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED" });
    await notConnected.service.runTick();
    expect(notConnected.repository.row()).toMatchObject({ code: C.storeNotConnected, attemptCount: 1,
      nextAttemptAt: new Date(NOW.getTime() + 21_600_000) });
    const unverified = harness();
    unverified.provider.credential = { ...unverified.provider.credential, externalAccountVerifiedAt: null };
    await unverified.service.runTick();
    expect(unverified.repository.row()).toMatchObject({ code: C.storeAccountUnverified, attemptCount: 1 });
  });

  it("records a 401 on the read as a rejected token, and the next load asks for a fresh one (FID-10)", async () => {
    const h = harness();
    h.provider.inspections = [Object.assign(new Error("401"), { code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", context: { status: 401 } })];
    await h.service.runTick();
    expect(h.provider.rejections).toEqual([{ status: 401, failureCode: C.readFailed }]);
    expect(h.repository.row()).toMatchObject({ code: C.readFailed, attemptCount: 2, context: { rejectedAccessTokenRef: "dst_ebay_access_1" } });
    h.repository.row().nextAttemptAt = NOW;
    h.provider.inspections = [unpublishedInspection()];
    await h.service.runTick();
    expect(h.provider.loads).toEqual([{}, { rejectedAccessTokenRef: "dst_ebay_access_1" }]);
  });

  it("records a 401 on the withdraw, keeps it transient (THROTTLED) and never assumes it went through", async () => {
    const h = harness();
    h.provider.inspections = [publishedInspection()];
    h.provider.withdrawals = [{ outcome: "rejected", rejectionCode: "EBAY_AUTH_REQUIRED", status: 401 }];
    await h.service.runTick();
    expect(h.provider.rejections).toEqual([{ status: 401, failureCode: C.providerThrottled }]);
    expect(h.repository.row()).toMatchObject({ state: "ending", code: C.providerThrottled, withdrawOutcome: "rejected_401",
      withdrawCallCount: 1, context: { rejectedAccessTokenRef: "dst_ebay_access_1" } });
  });
});

describe("unclear withdraws fail for review (SAF-2, SAF-3)", () => {
  it("crash marker (sent, never recorded): observes once, reconciles once, fails WITHDRAW_UNCERTAIN, never calls again", async () => {
    const h = harness([endingRow({ withdrawCallCount: 1, withdrawRequestedAt: new Date(NOW.getTime() - 60_000), withdrawReturnedAt: null })]);
    h.provider.inspections = [unpublishedInspection()];
    h.provider.reconciles = [{ resolved: [], unresolved: ["901"], busy: false }];
    await h.service.runTick();
    expect(h.order).toEqual(["credentials", "inspect", "reconcile"]);
    expect(h.repository.row()).toMatchObject({ state: "failed", code: C.withdrawUncertain,
      context: { evidence: "unpublished", attemptIds: ["901"], attemptIdsKnown: true, requiresReview: true, reason: "withdraw_result_not_recorded" } });
  });

  it.each([
    [{ outcome: "uncertain", status: 500, detail: {} }, "uncertain_500"],
    [{ outcome: "network", detail: { errorName: "TypeError" } }, "network"],
  ] as const)("%j: fails WITHDRAW_UNCERTAIN even when the re-observe reads unpublished", async (withdrawal, outcome) => {
    const h = harness();
    h.provider.inspections = [publishedInspection(), unpublishedInspection()];
    h.provider.reconciles = [{ resolved: [], unresolved: [], busy: false }, { resolved: [], unresolved: ["902"], busy: false }];
    h.provider.withdrawals = [withdrawal as ListingEndWithdrawResult];
    await h.service.runTick();
    expect(h.repository.row()).toMatchObject({ state: "failed", code: C.withdrawUncertain, withdrawOutcome: outcome,
      context: { evidence: "unpublished", attemptIds: ["902"] } });
    expect(h.repository.calls).not.toContain("finish:not_verified");
  });

  it("treats an admission code raised after the call as uncertain, not as nothing sent (D-C4-5)", async () => {
    const h = harness();
    h.provider.inspections = [publishedInspection(), publishedInspection()];
    h.provider.withdrawals = [{ outcome: "admission", code: "PUBLICATION_CONNECTION_CLEANUP_UNCERTAIN", context: {} }];
    await h.service.runTick();
    expect(h.repository.row()).toMatchObject({ state: "failed", code: C.withdrawUncertain, withdrawCallCount: 1,
      context: { admissionCode: "PUBLICATION_CONNECTION_CLEANUP_UNCERTAIN", evidence: "published" } });
  });
});

describe("refusals and limits (§5.5 step 6, §5.6)", () => {
  it.each([
    ["PUBLICATION_SCOPE_BUSY", C.quantityBusy, 60_000],
    ["QUANTITY_PUBLICATION_DRAIN_BUSY", C.quantityBusy, 60_000],
    ["PUBLICATION_ADMISSION_CAPACITY_BUSY", C.quantityBusy, 60_000],
    ["PUBLICATION_GLOBAL_STOP_ACTIVE", C.publicationStopped, 900_000],
    ["QUANTITY_PUBLICATION_SUPPRESSED", C.publicationStopped, 900_000],
    ["PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED", C.storeAccountUnverified, 21_600_000],
  ] as const)("admission %s: deferral, no attempt counted, the call not counted, no email (B18)", async (code, expected, delay) => {
    const h = harness();
    h.provider.inspections = [publishedInspection()];
    h.provider.withdrawals = [{ outcome: "admission", code, context: {} }];
    await h.service.runTick();
    expect(h.repository.row()).toMatchObject({ state: "ending", code: expected, attemptCount: 1, deferralCount: 1, withdrawCallCount: 0,
      withdrawOutcome: `admission_${code}`, nextAttemptAt: new Date(NOW.getTime() + delay) });
    expect(h.sent).toEqual([]);
  });

  it("admission PROVIDER_COOLDOWN waits until eBay's retry time", async () => {
    const h = harness();
    h.provider.inspections = [publishedInspection()];
    h.provider.withdrawals = [{ outcome: "admission", code: "PUBLICATION_PROVIDER_COOLDOWN", context: { retryNotBefore: "2026-10-26T10:30:00.000Z" } }];
    await h.service.runTick();
    expect(h.repository.row()).toMatchObject({ code: C.providerCooldown, attemptCount: 1, nextAttemptAt: new Date("2026-10-26T10:30:00.000Z") });
  });

  it("another writer's unsettled request: PRIOR_QUANTITY_UNRESOLVED, an attempt, with its attempt ids; reconcile busy waits", async () => {
    const unresolved = harness();
    unresolved.provider.inspections = [publishedInspection()];
    unresolved.provider.reconciles = [{ resolved: [], unresolved: ["77"], busy: false }];
    await unresolved.service.runTick();
    expect(unresolved.order).toEqual(["credentials", "inspect", "reconcile"]);
    expect(unresolved.repository.row()).toMatchObject({ code: C.priorQuantityUnresolved, attemptCount: 2, context: { attemptIds: ["77"] } });
    const busy = harness();
    busy.provider.inspections = [publishedInspection()];
    busy.provider.reconciles = [{ resolved: [], unresolved: [], busy: true }];
    await busy.service.runTick();
    expect(busy.repository.row()).toMatchObject({ code: C.quantityBusy, attemptCount: 1, deferralCount: 1 });
  });

  it("a 400 refusal re-observes: unpublished finishes NOT_PUBLISHED_ON_EBAY, else REJECTED", async () => {
    const finished = harness();
    finished.provider.inspections = [publishedInspection(), unpublishedInspection()];
    finished.provider.withdrawals = [{ outcome: "rejected", rejectionCode: "EBAY_QUANTITY_REJECTED", status: 400 }];
    await finished.service.runTick();
    expect(finished.repository.row()).toMatchObject({ state: "ended", endedCode: C.notPublishedOnEbay });
    const rejected = harness();
    rejected.provider.inspections = [publishedInspection(), publishedInspection()];
    rejected.provider.withdrawals = [{ outcome: "rejected", rejectionCode: "EBAY_QUANTITY_REJECTED", status: 400 }];
    await rejected.service.runTick();
    expect(rejected.repository.row()).toMatchObject({ state: "failed", code: C.rejected, context: { rejectionCode: "EBAY_QUANTITY_REJECTED" } });
  });

  it("a third throttled call is the last: the next attempt fails RETRIES_EXHAUSTED (lastCode PROVIDER_THROTTLED)", async () => {
    const h = harness();
    for (let call = 1; call <= 3; call += 1) {
      h.provider.inspections = [publishedInspection()];
      h.provider.withdrawals = [{ outcome: "rejected", rejectionCode: "EBAY_PROVIDER_RATE_LIMITED", status: 429 }];
      h.repository.row().nextAttemptAt = NOW;
      await h.service.runTick();
      expect(h.repository.row()).toMatchObject({ state: "ending", withdrawCallCount: call });
    }
    h.provider.inspections = [publishedInspection()];
    h.repository.row().nextAttemptAt = NOW;
    await h.service.runTick();
    expect(h.order.filter((step) => step.startsWith("withdraw"))).toHaveLength(3);
    expect(h.repository.row()).toMatchObject({ state: "failed", code: C.retriesExhausted, context: { lastCode: C.providerThrottled } });
  });

  it("exhausts on attempt 11: a transient outcome at attempt 10 fails RETRIES_EXHAUSTED with its last code", async () => {
    const h = harness([endingRow({ attemptCount: 10 })]);
    h.provider.inspections = [new Error("socket hang up")];
    await h.service.runTick();
    expect(h.repository.row()).toMatchObject({ state: "failed", code: C.retriesExhausted, context: { lastCode: C.readFailed, requiresReview: true } });
    const earlier = harness([endingRow({ attemptCount: 9 })]);
    earlier.provider.inspections = [new Error("socket hang up")];
    await earlier.service.runTick();
    expect(earlier.repository.row()).toMatchObject({ state: "ending", code: C.readFailed, attemptCount: 10 });
  });

  it("a finish whose listing ids moved fails IDENTITY_MISMATCH and counts as a failure", async () => {
    const h = harness();
    h.provider.inspections = [unpublishedInspection()];
    h.repository.finishOverride = { kind: "identity_moved" };
    const result = await h.service.runTick();
    expect(result).toMatchObject({ failed: 1, ended: 0 });
    expect(h.logs.find((line) => line.action === "dropship.listing_end.failed")?.fields).toMatchObject({ error_code: C.identityMismatch });
    expect(h.sent).toHaveLength(1);
  });

  it("defers LOCK_BUSY when the finish meets a held listing", async () => {
    const h = harness();
    h.provider.inspections = [unpublishedInspection()];
    h.repository.finishOverride = { kind: "lock_busy", causeCode: "55P03" };
    await h.service.runTick();
    expect(h.repository.calls).toContain(`defer:${C.lockBusy}`);
  });
});

describe("breakers, poison rows, claims and the tick (§5.3, §5.4, §5.6)", () => {
  it("defers an ending row that could send while the store's breaker is open, and touches no provider (SAF-6)", async () => {
    const h = harness();
    h.repository.stores = [{ storeConnectionId: STORE, hasVerifiedEnd: true, endingCount: 1, callsInWindow: 0, oldestCallInWindowAt: null,
      newestDecided: [1, 2, 3].map((minutes) => ({ state: "failed" as const, decidedAt: new Date(NOW.getTime() - minutes * 60_000) })) }];
    await h.service.runTick();
    noProviderCall(h);
    expect(h.repository.row()).toMatchObject({ code: C.breakerOpen, attemptCount: 1,
      nextAttemptAt: new Date(NOW.getTime() - 60_000 + 21_600_000) });
  });

  it("moves a poison row to INVARIANT_BROKEN and goes on with the next row (SAF-11 c)", async () => {
    const h = harness([endingRow({ id: 1, resolvedIdentity: { connectionId: STORE } }), endingRow({ id: 2 })]);
    h.repository.poison.push({ kind: "poison", id: 9, state: "pending", vendorId: VENDOR, storeConnectionId: STORE, error: "context: Expected object" });
    h.provider.inspections = [unpublishedInspection()];
    const result = await h.service.runTick();
    expect(h.repository.calls.filter((call) => call.startsWith("invariant"))).toEqual(["invariant:9", "invariant:1"]);
    expect(h.repository.row(1)).toMatchObject({ state: "failed", code: C.invariantBroken });
    expect(h.repository.row(2)).toMatchObject({ state: "ended" });
    expect(result).toMatchObject({ failed: 2, ended: 1 });
  });

  it("claims a pending row and works it in the same tick; a claim that supersedes or defers does nothing remote", async () => {
    const h = harness([endingRow({ id: 1, state: "pending", version: 1, resolvedIdentity: null, attemptCount: 0 })]);
    h.repository.claimResult = (row) => ({ kind: "decided", row: { ...row, state: "ending", version: 2, attemptCount: 1, resolvedIdentity: IDENTITY },
      decision: { outcome: "ending", resolvedIdentity: IDENTITY, context: {} } });
    h.provider.inspections = [unpublishedInspection()];
    expect(await h.service.runTick()).toMatchObject({ claimed: 1, ended: 1 });
    for (const decision of [{ outcome: "superseded", code: C.rePicked }, { outcome: "deferred", code: C.waitingForPush }] as const) {
      const other = harness([endingRow({ id: 1, state: "pending", version: 1, resolvedIdentity: null })]);
      other.repository.claimResult = () => ({ kind: "decided", decision, row: null });
      await other.service.runTick();
      noProviderCall(other);
    }
  });

  it("defers LOCK_BUSY when the claim met a held listing", async () => {
    const h = harness([endingRow({ id: 1, state: "pending", version: 1, resolvedIdentity: null })]);
    h.repository.claimResult = () => ({ kind: "lock_busy", causeCode: "55P03" });
    await h.service.runTick();
    expect(h.repository.row()).toMatchObject({ state: "pending", code: C.lockBusy, nextAttemptAt: new Date(NOW.getTime() + 60_000) });
  });

  it("aborts the tick when its own reads fail (fatal, ERROR tick_failed), and works nothing", async () => {
    const h = harness();
    h.repository.failReads = true;
    expect((await h.service.runTick()).outcome).toBe("failed");
    noProviderCall(h);
    expect(h.logs.find((line) => line.action === "dropship.listing_end.tick_failed")).toMatchObject({ level: "error",
      fields: { error_code: C.tickFailed, error_class: "fatal" } });
  });

  it("logs one ERROR when this tick's third failure opens the store's breaker", async () => {
    const h = harness([endingRow({ id: 1 }), endingRow({ id: 2, listingId: 502 }), endingRow({ id: 3, listingId: 503 })]);
    h.provider.credential = { ...h.provider.credential, externalAccountId: "seller-other" };
    await h.service.runTick();
    expect(h.logs.filter((line) => line.action === "dropship.listing_end.breaker_open")).toEqual([
      { level: "error", action: "dropship.listing_end.breaker_open", fields: { outcome: "breaker_open", scope: "store", store_connection_id: STORE,
        codes: [C.accountChanged, C.accountChanged, C.accountChanged], opened_at: NOW.toISOString() } }]);
  });
});

describe("the vendor notification (§5.7; TST-5)", () => {
  it("sends one critical notification per vendor per tick, keyed by the vendor and its exact failures, with the words of §11", async () => {
    const h = harness([endingRow({ id: 4 }), endingRow({ id: 7, listingId: 507 })]);
    h.provider.credential = { ...h.provider.credential, externalAccountId: "seller-other" };
    await h.service.runTick();
    expect(h.sent).toEqual([expect.objectContaining({
      vendorId: VENDOR, eventType: DROPSHIP_NOTIFICATION_EVENTS.LISTING_END_FAILED, critical: true, channels: ["email", "in_app"],
      title: "Some eBay listings couldn't be ended yet",
      message: "Card Shellz couldn't end 2 eBay listings on Card Shop yet. They stay at quantity 0, so they can't sell. Card Shellz is looking into it.",
      idempotencyKey: listingEndFailedNotificationKey(VENDOR, [{ requestId: 4, decidedVersion: 3 }, { requestId: 7, decidedVersion: 3 }]),
      payload: { vendorId: VENDOR, endRequestIds: [4, 7], stores: [{ storeConnectionId: STORE, count: 2 }], codes: [C.accountChanged] },
    })]);
    // The vendor and a digest of the exact failures (id and the version each failure wrote), in any order (review WRK-8).
    const key = listingEndFailedNotificationKey(VENDOR, [{ requestId: 7, decidedVersion: 3 }, { requestId: 4, decidedVersion: 3 }]);
    expect(key).toMatch(/^listing-end-failed:10:[0-9a-f]{64}$/);
    expect(key).toBe(listingEndFailedNotificationKey(VENDOR, [{ requestId: 4, decidedVersion: 3 }, { requestId: 7, decidedVersion: 3 }]));
    expect(key).not.toBe(listingEndFailedNotificationKey(VENDOR, [{ requestId: 4, decidedVersion: 3 }, { requestId: 7, decidedVersion: 6 }]));
    expect(key).not.toBe(listingEndFailedNotificationKey(11, [{ requestId: 4, decidedVersion: 3 }, { requestId: 7, decidedVersion: 3 }]));
    expect(LISTING_END_FAILED_WORDS.body(1, "Card Shop")).toBe(
      "Card Shellz couldn't end 1 eBay listing on Card Shop yet. It stays at quantity 0, so it can't sell. Card Shellz is looking into it.");
  });

  it("sends nothing new when a retried tick reports the same failed rows (one key)", async () => {
    const h = harness([endingRow({ id: 4 })], { dedupe: true });
    h.provider.credential = { ...h.provider.credential, externalAccountId: "seller-other" };
    await h.service.runTick();
    // A retry of the same tick's report: the rows are failed again in a copy, the key is the same.
    h.repository.rows.set(4, endingRow({ id: 4 }));
    await h.service.runTick();
    expect(h.sent).toHaveLength(1);
  });

  it("sends nothing for deferrals, retries or ends", async () => {
    const h = harness();
    h.repository.remoteBusy = true;
    await h.service.runTick();
    expect(h.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Review round (server): each case below was written first and shown red against b73f62360 (BUILD-NOTES "Review round").
// ---------------------------------------------------------------------------------------------------------------------

describe("review: a recorded withdraw outcome that may have applied is never finished or resent (WRK-2)", () => {
  it.each([
    ["network", unpublishedInspection],
    ["uncertain_500", unpublishedInspection],
    ["admission_PUBLICATION_COMPLETION_CONFLICT", unpublishedInspection],
    ["network", publishedInspection],
  ] as const)("outcome %s recorded before a crash: fails WITHDRAW_UNCERTAIN with the evidence, no finish, no send", async (outcome, inspection) => {
    // The returned marker committed; the process died before failUncertain wrote `failed` (or that write failed).
    const h = harness([endingRow({ withdrawCallCount: 1, withdrawRequestedAt: new Date(NOW.getTime() - 120_000),
      withdrawReturnedAt: new Date(NOW.getTime() - 119_000), withdrawOutcome: outcome, attemptCount: 2 })]);
    h.provider.inspections = [inspection()];
    h.provider.reconciles = [{ resolved: [], unresolved: ["903"], busy: false }];
    await h.service.runTick();
    expect(h.order.filter((step) => step.startsWith("withdraw"))).toEqual([]);
    expect(h.repository.calls.filter((call) => call.startsWith("finish"))).toEqual([]);
    expect(h.repository.row()).toMatchObject({ state: "failed", code: C.withdrawUncertain, withdrawCallCount: 1,
      context: { reason: "withdraw_outcome_uncertain", withdrawOutcome: outcome, attemptIds: ["903"], requiresReview: true,
        evidence: inspection === publishedInspection ? "published" : "unpublished" } });
  });

  it("still lets a refusal eBay applied nothing for finish on an unpublished read (D-C4-1 kept for rejected_*)", async () => {
    const h = harness([endingRow({ withdrawCallCount: 1, withdrawRequestedAt: new Date(NOW.getTime() - 600_000),
      withdrawReturnedAt: new Date(NOW.getTime() - 599_000), withdrawOutcome: "rejected_429" })]);
    h.provider.inspections = [unpublishedInspection()];
    await h.service.runTick();
    expect(h.repository.row()).toMatchObject({ state: "ended", endedCode: C.notPublishedOnEbay });
  });
});

describe("review: the shared-listing guard runs again right before the send (WRK-3)", () => {
  it("fails SHARED_LISTING with no withdraw when another listing took the offer after the claim", async () => {
    const h = harness();
    h.repository.sharedWith = "dropship_listing";
    h.provider.inspections = [publishedInspection()];
    await h.service.runTick();
    expect(h.order).toEqual(["credentials", "inspect", "reconcile"]);
    expect(h.repository.calls).not.toContain("withdraw_sent");
    expect(h.repository.row()).toMatchObject({ state: "failed", code: C.sharedListing, withdrawCallCount: 0,
      context: { sharedWith: "dropship_listing", stage: "before_withdraw", requiresReview: true } });
  });

  it("never re-checks a verify-only row (its withdraw already went through; nothing is sent)", async () => {
    const h = harness([endingRow({ withdrawCallCount: 1, withdrawRequestedAt: new Date(NOW.getTime() - 120_000),
      withdrawReturnedAt: new Date(NOW.getTime() - 119_000), withdrawOutcome: "ok" })]);
    h.repository.sharedWith = "card_shellz_channel";
    h.provider.inspections = [unpublishedInspection()];
    await h.service.runTick();
    expect(h.repository.calls.filter((call) => call.startsWith("shared_check"))).toEqual([]);
    expect(h.repository.row()).toMatchObject({ state: "ended", endedCode: null });
  });
});

describe("review: a withdraw that failed before anything was sent (WRK-4)", () => {
  it("a read refused before the send: READ_FAILED (transient), the call given back, no review, no email", async () => {
    const h = harness();
    h.provider.inspections = [publishedInspection()];
    h.provider.withdrawals = [{ outcome: "not_sent", status: 503, code: null } as unknown as ListingEndWithdrawResult];
    await h.service.runTick();
    expect(h.repository.row()).toMatchObject({ state: "ending", code: C.readFailed, attemptCount: 2, withdrawCallCount: 0,
      withdrawOutcome: "unsent_503" });
    expect(h.sent).toEqual([]);
    expect(h.logs.filter((line) => line.level === "error")).toEqual([]);
  });

  it("a 401 on that read records the token rejection, and a 4xx refusal fails READ_REFUSED (review), never uncertain", async () => {
    const unauthorized = harness();
    unauthorized.provider.inspections = [publishedInspection()];
    unauthorized.provider.withdrawals = [{ outcome: "not_sent", status: 401, code: null } as unknown as ListingEndWithdrawResult];
    await unauthorized.service.runTick();
    expect(unauthorized.provider.rejections).toEqual([{ status: 401, failureCode: C.readFailed }]);
    expect(unauthorized.repository.row()).toMatchObject({ state: "ending", code: C.readFailed, withdrawOutcome: "unsent_401",
      context: { rejectedAccessTokenRef: "dst_ebay_access_1" } });
    const refused = harness();
    refused.provider.inspections = [publishedInspection()];
    refused.provider.withdrawals = [{ outcome: "not_sent", status: 404, code: null } as unknown as ListingEndWithdrawResult];
    await refused.service.runTick();
    expect(refused.repository.row()).toMatchObject({ state: "failed", code: C.readRefused, withdrawCallCount: 0 });
  });
});

describe("review: a credential error eBay or the store setup will not fix is never retried (WRK-5)", () => {
  it.each([
    "DROPSHIP_MARKETPLACE_REGISTRATION_ENVIRONMENT_REQUIRED",
    "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED",
    "DROPSHIP_EBAY_CREDENTIAL_OWNER_MISMATCH",
  ])("%s (retryable: false) fails CREDENTIAL_UNUSABLE for review at once, with no eBay call", async (code) => {
    const h = harness();
    h.provider.credentialError = Object.assign(new Error("x"), { code, context: { retryable: false } });
    await h.service.runTick();
    expect(h.order).toEqual(["credentials"]);
    expect(h.repository.row()).toMatchObject({ state: "failed", code: "DROPSHIP_LISTING_END_CREDENTIAL_UNUSABLE",
      context: { causeCode: code, requiresReview: true } });
  });

  it("a refresh refused because the grant is gone (needs_reauth) waits like a store that is not connected", async () => {
    const h = harness();
    h.provider.credentialError = Object.assign(new Error("x"), { code: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
      context: { retryable: false, status: 400, authFailureStatus: "needs_reauth" } });
    await h.service.runTick();
    expect(h.repository.row()).toMatchObject({ state: "ending", code: C.storeNotConnected, attemptCount: 1, deferralCount: 1 });
  });

  it("a refresh that may pass (retryable: true) still tries again", async () => {
    const h = harness();
    h.provider.credentialError = Object.assign(new Error("x"), { code: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
      context: { retryable: true, status: 503 } });
    await h.service.runTick();
    expect(h.repository.row()).toMatchObject({ state: "ending", code: C.transient, attemptCount: 2 });
  });
});

describe("review: the vendor notification key names each failure, not a range (WRK-8, DB-3)", () => {
  it("emails again when the same end fails again after a staff Retry (same id, a later version)", async () => {
    const h = harness([endingRow({ id: 7 })], { dedupe: true });
    h.provider.credential = { ...h.provider.credential, externalAccountId: "seller-other" };
    await h.service.runTick();
    // Staff Retry (version + 1, pending) and the claim (version + 1, ending): the same end fails again.
    h.repository.rows.set(7, endingRow({ id: 7, version: 5 }));
    await h.service.runTick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]!.idempotencyKey).not.toBe(h.sent[1]!.idempotencyKey);
  });

  it("emails a failure nested inside an earlier range: {10, 20}, then {10, 15, 20} after retries", async () => {
    const h = harness([endingRow({ id: 10 }), endingRow({ id: 20, listingId: 520 })], { dedupe: true });
    h.provider.credential = { ...h.provider.credential, externalAccountId: "seller-other" };
    await h.service.runTick();
    for (const id of [10, 20]) h.repository.rows.set(id, endingRow({ id, listingId: 500 + id, version: 5 }));
    h.repository.rows.set(15, endingRow({ id: 15, listingId: 515 }));
    await h.service.runTick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.payload).toMatchObject({ endRequestIds: [10, 15, 20] });
  });
});

describe("review: every write carries the time it happens, not the tick's start (DB-2, FEN-1)", () => {
  it("stamps the send, the return and the finish (read inside the finish) after the eBay calls they follow", async () => {
    let seconds = 0;
    const clock = () => new Date(NOW.getTime() + (seconds += 10) * 1000);
    const h = harness([endingRow()], { clock });
    const inspectAt: Date[] = [];
    const inspect = h.provider.inspect.bind(h.provider);
    h.provider.inspect = async () => { inspectAt.push(clock()); return inspect(); };
    h.provider.inspections = [publishedInspection(), unpublishedInspection()];
    await h.service.runTick();
    const at = (call: string) => h.repository.writes.find((write) => write.call === call)!.at.getTime();
    expect(h.repository.row().state).toBe("ended");
    // Tick start is NOW + 10 s; the first inspect happened later, the send after it, the finish after the verify read.
    expect(at("withdraw_sent")).toBeGreaterThan(inspectAt[0]!.getTime());
    expect(at("withdraw_returned")).toBeGreaterThan(at("withdraw_sent"));
    expect(at("finish")).toBeGreaterThan(inspectAt[1]!.getTime());
  });

  it("dates a retry's next attempt from the time it is written", async () => {
    let seconds = 0;
    const clock = () => new Date(NOW.getTime() + (seconds += 10) * 1000);
    const h = harness([endingRow()], { clock });
    h.provider.inspections = [publishedInspection(), publishedInspection()];
    await h.service.runTick();
    const retryAt = h.repository.writes.find((write) => write.call === "retry")!.at;
    expect(retryAt.getTime()).toBeGreaterThan(NOW.getTime() + 10_000);
    expect(h.repository.row().nextAttemptAt).toEqual(new Date(retryAt.getTime() + 60_000));
  });
});

describe("review: the tick budget (TST-2)", () => {
  it("starts no row once the injected timer passes 120,000 ms after the tick began", async () => {
    const times = [0, 0, 120_001, 120_001, 120_001];
    const h = harness([endingRow({ id: 1 }), endingRow({ id: 2, listingId: 502 })], { timer: () => times.shift() ?? 120_001 });
    h.provider.inspections = [unpublishedInspection()];
    const result = await h.service.runTick();
    expect(result).toMatchObject({ due: 2, ended: 1 });
    expect(h.repository.row(1).state).toBe("ended");
    expect(h.repository.row(2)).toMatchObject({ state: "ending", version: 2 });
    expect(h.order).toEqual(["credentials", "inspect"]);
  });
});
