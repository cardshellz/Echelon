import { describe, expect, it, vi } from "vitest";
import { EbayExistingListingSyncExecution, EbayListingSyncService, type EbayListingExecutionContext,
  type EbayListingSyncStore } from "../../ebay-listing-sync.service";
import { storedEbayListingSyncJobSchema, syncFailure } from "../../ebay-listing-sync.domain";
import { EbayMarketplaceListingConnector } from "../../listing-connectors/ebay-listing.connector";
import { syncIdentity, syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";

const jobId = "00000000-0000-4000-8000-000000000017";
const clock = () => new Date("2026-10-15T16:00:00.000Z");
function context(operation: EbayListingExecutionContext["operation"] = "sync"): EbayListingExecutionContext {
  return { jobId, requestedBy: "operator", operation, claimedRevision: "2", publicationTarget: null,
    publicationAccepted: null, publicationWriteCompleted: false, publicationWriteStarted: false,
    publicationAcceptedRevision: null, publicationIntentHash: null,
    bindPublicationTarget: vi.fn(), bindPublicationAccepted: vi.fn() };
}
const stage = async (_key: string, _hash: string, work: () => Promise<void>) => work();

describe("automatic recovery inside the existing Sync command", () => {
  it("preserves exact product, variant, account, group and saved revision when requesting automatic recovery", async () => {
    const provider = syncProviderFixture();
    const recover = vi.fn(async () => ({ superseded: ["17032"], unresolved: [], busy: false, watchId: "1" }));
    const execution = new EbayExistingListingSyncExecution(provider.prepare,
      { reconcile: async () => ({ busy: false, resolved: [], unresolved: ["17032"] }) },
      new EbayMarketplaceListingConnector(), { recover });
    expect(await execution.execute(syncIdentity, stage, null, vi.fn(), context())).toMatchObject({ synced: 1, errors: 0 });
    expect(recover).toHaveBeenCalledWith({ syncJobId: jobId, syncRevision: "2", scopes: [
      expect.objectContaining({ productId: 20, productVariantId: null, connectionId: 1, externalScopeId: "verified-account", externalInventoryItemId: "group:PACK" }),
      expect.objectContaining({ productId: 20, productVariantId: 101, connectionId: 1, externalScopeId: "verified-account", externalInventoryItemId: "P5" }),
    ] });
    expect(provider.client.createOrReplaceInventoryItem).toHaveBeenCalledOnce();
    expect(provider.client.createOffer).not.toHaveBeenCalled();
    expect(provider.client.publishOffer).not.toHaveBeenCalled();
  });
  it.each([true, false])("does not send while a publisher is active (first recovery busy=%s)", async initiallyBusy => {
    const provider = syncProviderFixture();
    const recover = vi.fn(async () => ({ superseded: [], unresolved: ["17032"], busy: true, watchId: null }));
    const execution = new EbayExistingListingSyncExecution(provider.prepare,
      { reconcile: async () => ({ busy: initiallyBusy, resolved: [], unresolved: ["17032"] }) },
      new EbayMarketplaceListingConnector(), { recover });
    await expect(execution.execute(syncIdentity, stage, null, vi.fn(), context())).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY" });
    expect(recover).toHaveBeenCalledTimes(initiallyBusy ? 0 : 1);
    expect(provider.client.updateOffer).not.toHaveBeenCalled();
  });
  it("keeps unsupported unknown operations fenced instead of manufacturing completion", async () => {
    const provider = syncProviderFixture();
    const execution = new EbayExistingListingSyncExecution(provider.prepare,
      { reconcile: async () => ({ busy: false, resolved: [], unresolved: ["17032"] }) },
      new EbayMarketplaceListingConnector(), { recover: async () => ({ superseded: [], unresolved: ["17032"], busy: false, watchId: null }) });
    await expect(execution.execute(syncIdentity, stage, null, vi.fn(), context())).rejects.toMatchObject({ code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED" });
    expect(provider.client.updateOffer).not.toHaveBeenCalled();
  });
  it.each(["1", null])("prepares stock for an existing recovery watch %s even when content already matches", async watchId => {
    const provider = syncProviderFixture();
    const assertInventoryReady = vi.fn(async () => {});
    const prepared = { ...await provider.prepare(), assertInventoryReady };
    const connector = new EbayMarketplaceListingConnector();
    vi.spyOn(connector, "verifyExistingListing").mockResolvedValue(undefined);
    const recover = vi.fn(async () => ({ busy: false, superseded: [], unresolved: [], watchId }));
    const execution = new EbayExistingListingSyncExecution(async () => prepared,
      { reconcile: async () => ({ busy: false, resolved: [], unresolved: [] }) }, connector, { recover });
    await expect(execution.execute(syncIdentity, stage, null, vi.fn(), context())).resolves.toMatchObject({ synced: 1, errors: 0 });
    expect(recover).toHaveBeenCalledOnce();
    expect(assertInventoryReady).toHaveBeenCalledTimes(watchId === null ? 0 : 1);
    if (watchId !== null) expect(assertInventoryReady).toHaveBeenCalledWith({ commandKey: jobId, actor: "operator" });
    expect(provider.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });
  it("does not authorize unknown withdrawal operations as a maintenance retry", async () => {
    const provider = syncProviderFixture();
    const recover = vi.fn();
    const execution = new EbayExistingListingSyncExecution(provider.prepare,
      { reconcile: async () => ({ busy: false, resolved: [], unresolved: ["17032"] }) },
      new EbayMarketplaceListingConnector(), { recover });
    await expect(execution.execute(syncIdentity, stage, null, vi.fn(), context("withdraw"))).rejects.toMatchObject({ code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED" });
    expect(recover).not.toHaveBeenCalled();
    expect(provider.client.updateOffer).not.toHaveBeenCalled();
  });
  it("maintains a verified live publication through the same automatic stock recovery owner", async () => {
    const provider = syncProviderFixture();
    const recover = vi.fn(async () => ({ superseded: ["17032"], unresolved: [], busy: false, watchId: "1" }));
    const execution = new EbayExistingListingSyncExecution(provider.prepare,
      { reconcile: async () => ({ busy: false, resolved: [], unresolved: ["17032"] }) },
      new EbayMarketplaceListingConnector(), { recover });
    await expect(execution.execute(syncIdentity, stage, null, vi.fn(), context("publish"))).resolves.toMatchObject({ synced: 1, errors: 0 });
    expect(recover).toHaveBeenCalledOnce();
    expect(provider.client.publishOffer).not.toHaveBeenCalled();
  });
  it.each(["ECONNRESET", "QUANTITY_PROVIDER_REQUEST_TIMEOUT", "PUBLICATION_AUTOMATIC_RECOVERY_FAILED", "EBAY_SYNC_READBACK_PENDING"])(
    "keeps %s retryable after a long outage without unbounded rapid retries", code => {
      const failure = syncFailure(Object.assign(new Error("temporary"), { code }), 500, clock());
      expect(failure.state).toBe("recovering");
      expect(failure.nextAttemptAt.getTime() - clock().getTime()).toBe(15 * 60_000);
    });
});

describe("listing status with independent stock evidence", () => {
  function setup(readStatuses: NonNullable<ConstructorParameters<typeof EbayListingSyncService>[4]>["readStatuses"]) {
    const job = storedEbayListingSyncJobSchema.parse({ id: jobId, productId: 20, identity: syncIdentity, state: "completed",
      revision: "1", claimedRevision: null, ownerToken: null, attempts: 0, result: null,
      code: null, message: null, verificationIntentHash: null, verificationRevision: null,
      nextAttemptAt: clock().toISOString(), updatedAt: clock().toISOString() });
    const store: EbayListingSyncStore = { list: vi.fn(async () => [job]), get: vi.fn(async () => job),
      getByCommand: vi.fn(async () => job), authorizePublicationRetry: vi.fn(), recordAdmissionFailure: vi.fn(),
      bindProviderIdentity: vi.fn(), bindPublicationTarget: vi.fn(), bindPublicationAccepted: vi.fn(), enqueue: vi.fn(),
      getAdmission: vi.fn(), claim: vi.fn(), stage: vi.fn(), finish: vi.fn() };
    return new EbayListingSyncService(store, { execute: vi.fn() }, clock, () => jobId, { readStatuses });
  }
  it("shows fresh stock evidence without changing the completed content result", async () => {
    const evidence = { state: "pending" as const, checkedAt: null, nextCheckAt: clock().toISOString(), code: null, message: null };
    const readStatuses = vi.fn(async () => ({ [jobId]: evidence }));
    const service = setup(readStatuses);
    expect(await service.get(jobId)).toMatchObject({ state: "completed", inventoryReconciliation: evidence });
    expect(await service.list(1)).toEqual([expect.objectContaining({ state: "completed", inventoryReconciliation: evidence })]);
    expect(readStatuses).toHaveBeenCalledWith([jobId]);
  });
  it("keeps the listing feed available and marks stock evidence unavailable when its reader fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = setup(async () => { throw new Error("private database details"); });
      const jobs = await service.list(1);
      expect(jobs).toEqual([expect.objectContaining({ state: "completed", inventoryReconciliation: {
        state: "unavailable", checkedAt: null, nextCheckAt: null,
        code: "PUBLICATION_RECONCILIATION_STATUS_UNAVAILABLE",
        message: "Stock verification status could not be loaded. The listing update status is still available.",
      } })]);
      expect(JSON.stringify(jobs)).not.toContain("private database details");
      expect(log).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });
});
