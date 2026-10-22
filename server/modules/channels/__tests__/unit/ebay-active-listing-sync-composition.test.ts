import { beforeEach, describe, expect, it, vi } from "vitest";
import { storedEbayListingSyncJobSchema } from "../../ebay-listing-sync.domain";
import { ebayListingSyncJobSchema } from "@shared/types/ebay-listing-sync";

const fixture = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queued: [] as unknown[],
  failures: [] as Array<Record<string, unknown>>,
  products: [] as Array<{ id: number; name: string }>,
  saved: new Map<string, { actor: string; job: unknown; requestedOperation?: "sync" | "publish" | "withdraw" }>(),
  rejections: new Map<string, unknown>(),
}));
vi.mock("../../../../db", () => ({
  pool: {},
  db: { select: (selection?: Record<string, unknown>) => {
    const query = {
      from: () => query, innerJoin: () => query, leftJoin: () => query, where: () => query,
      limit: async () => [{ id: 12, metadata: { marketplaceId: "EBAY_US" } }],
      orderBy: async () => fixture.rows,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(selection?.id ? fixture.products : []).then(resolve),
    };
    return query;
  } },
}));
vi.mock("../../infrastructure/ebay-api-runtime", () => ({ EBAY_CHANNEL_ID: 67,
  getAuthService: () => ({ getVerifiedProviderAccount: async () => ({ externalAccountId: "seller" }) }),
  atpService: {}, ebayListingPhotoResolver: {},
}));
vi.mock("../../infrastructure/ebay-listing-sync.repository", () => ({ PostgresEbayListingSyncRepository: class {} }));
vi.mock("../../../inventory-planning/quantity-publication", () => ({ quantityProviderResponseRecovery: {},
  automaticEbayPublicationRecovery: {}, ebayPublicationReconciliationRepository: {},
  ebayPublicationRejectionReader: { read: vi.fn() },
  EbayPublicationContentRefreshRejectedError: class extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  },
}));
vi.mock("../../ebay-listing-sync.service", async importOriginal => {
  const actual = await importOriginal<typeof import("../../ebay-listing-sync.service")>();
  return { ...actual, EbayListingSyncService: class {
    async enqueue(identity: { productId: number }, actor: string, key: string) {
      fixture.queued.push({ identity, actor, key });
      const job = storedEbayListingSyncJobSchema.parse({ id: key, productId: identity.productId, state: "queued", kind: "sync", code: null, message: null,
        nextAttemptAt: "2026-10-09T20:00:00.000Z", updatedAt: "2026-10-09T20:00:00.000Z", identity,
        revision: "1", claimedRevision: null, ownerToken: null, attempts: 0, result: null, verificationIntentHash: null, verificationRevision: null });
      fixture.saved.set(key, { actor, job, requestedOperation: "sync" });
      return job;
    }
    async getByCommand(key: string, _channelId: number, expectedActor?: string, expectedOperation?: "sync" | "publish" | "withdraw") {
      const saved = fixture.saved.get(key);
      if (saved && expectedActor !== undefined && saved.actor !== expectedActor)
        throw Object.assign(new Error("Different requester"), { code: "EBAY_SYNC_REPLAY_CONFLICT" });
      if (saved && expectedOperation !== undefined && saved.requestedOperation !== expectedOperation)
        throw Object.assign(new Error("Different requested operation"), { code: "EBAY_SYNC_REPLAY_CONFLICT" });
      return saved ? storedEbayListingSyncJobSchema.parse(saved.job) : null;
    }
    async getAdmission(key: string) {
      const saved = fixture.rejections.get(key);
      return saved ? ebayListingSyncJobSchema.parse(saved) : null;
    }
    async recordAdmissionFailure(failure: Record<string, unknown>) {
      fixture.failures.push(failure);
      return ebayListingSyncJobSchema.parse({ id: failure.commandKey, productId: failure.productId, kind: "admission", state: "needs_attention",
        code: failure.code, message: failure.message, nextAttemptAt: "2026-10-09T20:00:00.000Z", updatedAt: "2026-10-09T20:00:00.000Z" });
    }
  } };
});
import { syncActiveListings, refreshRecoveredEbayListing } from "../../infrastructure/ebay-active-listing-sync";

function rows(productId: number, catalog: string, external: string, invalid = false) {
  return ["PACK", "CASE"].map((unit, index) => ({ product_id: productId, product_name: `Toploader ${productId}`, product_sku: catalog,
    product_is_active: true, variant_is_active: true, variant_sales_eligibility: "sellable", listing_sync_status: "synced",
    variant_id: productId * 10 + index, variant_sku: invalid ? null : `${catalog}-${unit}`, external_sku: `${external}-${unit}`,
    external_variant_id: `offer-${productId}-${index}`, external_product_id: `listing-${productId}` }));
}
beforeEach(() => {
  fixture.rows = [];
  fixture.queued = [];
  fixture.failures = [];
  fixture.products = [];
  fixture.saved.clear();
  fixture.rejections.clear();
});

describe("active existing-listing selection to admission composition", () => {
  it("returns a normal Sync's accepted publication receipt after a lost acknowledgement and mapping changes", async () => {
    fixture.rows = rows(3, "CAT-3", "EBAY-3");
    const commandKey = "00000000-0000-4000-8000-000000000003";
    await syncActiveListings({ productIds: [3] }, "operator", commandKey);
    const saved = fixture.saved.get(commandKey)!;
    const job = storedEbayListingSyncJobSchema.parse(saved.job);
    saved.job = { ...job, operation: "publish" };
    fixture.rows = rows(3, "RENAMED", "EBAY-3").map(row => ({ ...row, external_product_id: "newly-published-listing" }));
    expect(await syncActiveListings({ productIds: [3] }, "operator", commandKey))
      .toMatchObject({ pending: 1, errors: 0, jobs: [{ id: commandKey, operation: "publish" }] });
    expect(fixture.queued).toHaveLength(1);
    expect(fixture.failures).toEqual([]);
  });
  it("bulk Sync admits pending saved offers and retains their excluded or ended identity members", async () => {
    fixture.rows = rows(3, "CAT-3", "EBAY-3").map((row, index) => ({ ...row,
      external_product_id: null, listing_sync_status: index === 0 ? "pending" : "ended", variant_excluded: index === 1 }));
    const result = await syncActiveListings(null, "operator");
    expect(result).toMatchObject({ pending: 1, errors: 0 });
    expect(fixture.queued).toEqual([expect.objectContaining({ identity: expect.objectContaining({ productId: 3,
      variants: [expect.objectContaining({ offerId: "offer-3-0", listingId: null, contentSyncEnabled: true }),
        expect.objectContaining({ offerId: "offer-3-1", listingId: null, contentSyncEnabled: false })] }) })]);
  });

  it("bulk Sync excludes ended, deleted, excluded, inactive and SKU-only products without publishing new selections", async () => {
    fixture.rows = [
      ...rows(1, "ACTIVE", "ACTIVE"),
      ...rows(2, "ENDED", "ENDED").map(row => ({ ...row, listing_sync_status: "ended" })),
      ...rows(3, "DELETED", "DELETED").map(row => ({ ...row, listing_sync_status: "deleted" })),
      ...rows(4, "EXCLUDED", "EXCLUDED").map(row => ({ ...row, product_excluded: true })),
      ...rows(5, "INACTIVE", "INACTIVE").map(row => ({ ...row, variant_is_active: false })),
      ...rows(6, "SKU-ONLY", "SKU-ONLY").map(row => ({ ...row, external_product_id: null, external_variant_id: null })),
    ];
    const result = await syncActiveListings(null, "operator");
    expect(result).toMatchObject({ pending: 1, errors: 0 });
    expect(result.jobs.map(job => job.productId)).toEqual([1]);
    expect(fixture.queued).toHaveLength(1);
    expect(fixture.failures).toEqual([]);
  });

  it.each(["ended", "deleted"])("explicit Sync inspects a retained %s identity without inventing a replacement", async status => {
    fixture.rows = rows(3, "CAT-3", "EBAY-3").map(row => ({ ...row, listing_sync_status: status }));
    const result = await syncActiveListings({ productIds: [3] }, "operator", undefined, undefined, undefined, { inspectRetainedIdentity: true });
    expect(result).toMatchObject({ pending: 1, errors: 0 });
    expect(fixture.queued).toEqual([expect.objectContaining({ identity: expect.objectContaining({
      variants: [expect.objectContaining({ listingId: "listing-3", offerId: "offer-3-0" }), expect.objectContaining({ listingId: "listing-3", offerId: "offer-3-1" })],
    }) })]);
  });
  it("queues recovery content through normal Sync with the exact account and stable command", async () => {
    fixture.rows = rows(3, "CAT-3", "EBAY-3");
    const commandKey = "00000000-0000-4000-8000-000000000003";
    expect(await refreshRecoveredEbayListing({ productId: 3, connectionId: 12, accountId: "seller", commandKey }))
      .toEqual({ jobId: commandKey });
    expect(fixture.queued).toEqual([expect.objectContaining({ actor: "system:ebay-recovery-reconciliation", key: commandKey,
      identity: expect.objectContaining({ productId: 3, connectionId: 12, accountId: "seller" }) })]);
  });
  it("recovers a consumed command before recapturing changed catalog selection after a lost acknowledgement", async () => {
    fixture.rows = rows(3, "CAT-3", "EBAY-3");
    const request = { productId: 3, connectionId: 12, accountId: "seller", commandKey: "00000000-0000-4000-8000-000000000003" };
    const first = await refreshRecoveredEbayListing(request);
    fixture.rows = rows(3, "RENAMED", "EBAY-3").map(row => ({ ...row, variant_is_active: false }));
    expect(await refreshRecoveredEbayListing(request)).toEqual(first);
    expect(fixture.queued).toHaveLength(1);
    expect(fixture.failures).toEqual([]);
  });
  it.each([
    { productId: 4 }, { connectionId: 13 }, { accountId: "another-seller" }, { operation: "publish" },
  ])("does not reuse a recovery command for another saved destination or operation: %j", async changes => {
    fixture.rows = rows(3, "CAT-3", "EBAY-3");
    const request = { productId: 3, connectionId: 12, accountId: "seller", commandKey: "00000000-0000-4000-8000-000000000003" };
    await refreshRecoveredEbayListing(request);
    const saved = fixture.saved.get(request.commandKey)!;
    const job = storedEbayListingSyncJobSchema.parse(saved.job);
    saved.job = { ...job, ...changes, identity: { ...job.identity, ...changes } };
    if ("operation" in changes) {
      saved.job = { ...job, operation: changes.operation };
      saved.requestedOperation = "publish";
    }
    await expect(refreshRecoveredEbayListing(request)).rejects.toMatchObject({ code: "EBAY_SYNC_REPLAY_CONFLICT" });
    expect(fixture.queued).toHaveLength(1);
  });
  it("replays the original Sync receipt when recovery joined a saved publication", async () => {
    fixture.rows = rows(3, "CAT-3", "EBAY-3");
    const request = { productId: 3, connectionId: 12, accountId: "seller", commandKey: "00000000-0000-4000-8000-000000000003" };
    const first = await refreshRecoveredEbayListing(request);
    const saved = fixture.saved.get(request.commandKey)!;
    const job = storedEbayListingSyncJobSchema.parse(saved.job);
    saved.job = { ...job, operation: "publish" };
    fixture.rows = rows(3, "RENAMED", "EBAY-3");
    expect(await refreshRecoveredEbayListing(request)).toEqual(first);
    expect(fixture.queued).toHaveLength(1);
    expect(fixture.failures).toEqual([]);
  });
  it("consumes a saved admission rejection without trying to reuse its key after catalog changes", async () => {
    const request = { productId: 3, connectionId: 12, accountId: "seller", commandKey: "00000000-0000-4000-8000-000000000003" };
    fixture.rejections.set(request.commandKey, { id: request.commandKey, productId: 3, operation: "sync", kind: "admission", state: "needs_attention",
      code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE", message: "The saved selection was excluded.",
      nextAttemptAt: "2026-10-09T20:00:00.000Z", updatedAt: "2026-10-09T20:00:00.000Z" });
    fixture.rows = rows(3, "NOW-INCLUDED", "EBAY-3");
    await expect(refreshRecoveredEbayListing(request)).rejects.toMatchObject({ code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE" });
    expect(fixture.queued).toEqual([]);
    expect(fixture.failures).toEqual([]);
  });
  it("rejects a command owned by another requester before fresh admission", async () => {
    fixture.rows = rows(3, "CAT-3", "EBAY-3");
    const request = { productId: 3, connectionId: 12, accountId: "seller", commandKey: "00000000-0000-4000-8000-000000000003" };
    await refreshRecoveredEbayListing(request);
    fixture.saved.get(request.commandKey)!.actor = "another-requester";
    await expect(refreshRecoveredEbayListing(request)).rejects.toMatchObject({ code: "EBAY_SYNC_REPLAY_CONFLICT" });
    expect(fixture.queued).toHaveLength(1);
  });
  it.each([{ connectionId: 13, accountId: "seller" }, { connectionId: 12, accountId: "other-seller" }])(
    "refuses recurring content refresh after the destination changes: %j", async destination => {
      fixture.rows = rows(3, "CAT-3", "EBAY-3");
      await expect(refreshRecoveredEbayListing({ productId: 3, ...destination,
        commandKey: "00000000-0000-4000-8000-000000000003" })).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
      expect(fixture.queued).toEqual([]);
      expect(fixture.failures).toEqual([]);
    });
  it("distinguishes a consumed durable rejection from a lost queue acknowledgement", async () => {
    fixture.products = [{ id: 3, name: "Excluded" }];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(refreshRecoveredEbayListing({ productId: 3, connectionId: 12, accountId: "seller",
        commandKey: "00000000-0000-4000-8000-000000000003" })).rejects.toMatchObject({ code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE" });
      expect(fixture.failures).toHaveLength(1);
      expect(fixture.queued).toEqual([]);
    } finally { log.mockRestore(); }
  });
  it("admits both renamed SKU/group examples without any provider discovery during the HTTP request", async () => {
    fixture.rows = [...rows(3, "SHLZ-TOP-180PT-CLR", "SHLZ-TOP-180PT"), ...rows(86, "SHLZ-TOP-TCG-SLIM-CLR", "SHLZ-TOP-40PT-SLIM")];
    const result = await syncActiveListings(null, "operator");
    expect(result).toMatchObject({ pending: 2, errors: 0 });
    expect(fixture.queued).toEqual([
      expect.objectContaining({ identity: expect.objectContaining({ productId: 3, groupKey: null,
        variants: [expect.objectContaining({ catalogSku: "SHLZ-TOP-180PT-CLR-PACK", sku: "SHLZ-TOP-180PT-PACK" }), expect.anything()] }) }),
      expect.objectContaining({ identity: expect.objectContaining({ productId: 86, groupKey: null,
        variants: [expect.objectContaining({ catalogSku: "SHLZ-TOP-TCG-SLIM-CLR-PACK", sku: "SHLZ-TOP-40PT-SLIM-PACK" }), expect.anything()] }) }),
    ]);
    expect(fixture.failures).toEqual([]);
  });

  it("does not let malformed middle-product rows abort a Sync All request before durable admission", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fixture.rows = [...rows(3, "CAT-3", "EBAY-3"), ...rows(20, "CAT-20", "EBAY-20", true), ...rows(86, "CAT-86", "EBAY-86")];
      const result = await syncActiveListings(null, "operator");
      expect(result).toMatchObject({ pending: 2, errors: 2 });
      expect(result.jobs.map(job => [job.productId, job.state])).toEqual([[3, "queued"], [20, "needs_attention"], [86, "queued"]]);
      expect(fixture.queued).toHaveLength(2);
      expect(fixture.failures).toEqual([expect.objectContaining({ productId: 20, variantIds: [200, 201], code: "EBAY_SYNC_MAPPING_INVALID" })]);
    } finally { errorLog.mockRestore(); }
  });

  it("records an existing but ineligible requested product and continues eligible products", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fixture.rows = rows(3, "CAT-3", "EBAY-3");
      fixture.products = [{ id: 86, name: "Excluded toploader" }];
      const result = await syncActiveListings({ productIds: [3, 86] }, "operator");
      expect(result).toMatchObject({ pending: 1, errors: 1 });
      expect(result.details).toEqual([expect.objectContaining({ productId: 86, productName: "Excluded toploader", code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE" })]);
      expect(fixture.failures).toEqual([expect.objectContaining({ productId: 86, variantIds: [], code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE" })]);
    } finally { errorLog.mockRestore(); }
  });

  it("reports a missing requested product without attempting a foreign-key-invalid admission journal", async () => {
    const result = await syncActiveListings({ productIds: [999] }, "operator", "00000000-0000-4000-8000-000000000001");
    expect(result).toMatchObject({ pending: 0, errors: 1, jobs: [], details: [{ productId: 999, code: "EBAY_SYNC_PRODUCT_NOT_FOUND" }] });
    expect(fixture.failures).toEqual([]);
    expect(fixture.queued).toEqual([]);
  });

  it("records an all-disabled product as an actionable admission rather than an update waiting to run", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fixture.rows = rows(3, "CAT-3", "EBAY-3").map(row => ({ ...row, variant_is_active: false }));
      fixture.products = [{ id: 3, name: "All disabled" }];
      const result = await syncActiveListings({ productIds: [3] }, "operator");
      expect(result).toMatchObject({ pending: 0, errors: 1, jobs: [{ productId: 3, kind: "admission", code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE" }] });
      expect(fixture.queued).toEqual([]);
    } finally { errorLog.mockRestore(); }
  });
});
