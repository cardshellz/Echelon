import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ query: vi.fn(), publish: vi.fn(), execute: vi.fn() }));
vi.mock("../../../../db", () => ({ pool: { query: f.query } }));
vi.mock("../../infrastructure/inventory-availability-runtime-publication.repository", () => ({
  PostgresInventoryAvailabilityRuntimePublicationExecutor: class { executeWithClient = f.execute; },
}));
vi.mock("../../application/inventory-availability-runtime-publication.service", async importOriginal => ({
  ...await importOriginal<typeof import("../../application/inventory-availability-runtime-publication.service")>(),
  AuthorityAwareInventoryPublicationService: class { publishProduct = f.publish; },
}));
import { planCurrentCanonicalListingQuantity, createQuantityPublicationCatchupService, quantityPublicationAdmission, quantityProviderResponseRecovery } from "../../infrastructure/quantity-publication-runtime";

const scope = { destinationKind: "channel_connection" as const, connectionId: 7, providerKey: "ebay" as const,
  providerScopeType: "account" as const, externalScopeId: "verified", externalInventoryItemId: "P5", productId: null, productVariantId: null };
const intent = { publicationTargetId: 1, publicationTargetRevision: "3", productVariantId: 101,
  destinationKind: scope.destinationKind, channelConnectionId: 7, dropshipStoreConnectionId: null,
  providerKey: "ebay", providerScopeType: "account", externalScopeId: "verified", externalInventoryItemId: "P5", desiredQuantity: "14" };
function installTransaction() {
  f.execute.mockImplementation(work => work({ query: f.query }, { authority: "canonical", authorityRevision: "2", activationRunId: "4" }));
}
describe("current canonical listing quantity handoff", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    installTransaction();
    f.query.mockResolvedValueOnce({ rows: [{ product_id: 20, product_variant_id: 101, target_id: 1 }] });
    f.publish.mockResolvedValue({ authority: "canonical", publication: { activationRunId: "4", rows: [intent] } });
  });
  it("requires the freshly returned exact intent before selecting matching durable desired state", async () => {
    f.query.mockResolvedValueOnce({ rows: [{ id: "9", desired_quantity: "14" }] });
    await expect(planCurrentCanonicalListingQuantity(scope)).resolves.toEqual({ outboxId: "9", quantity: 14 });
    expect(f.publish).toHaveBeenCalledWith({ productId: 20, publicationTargetId: 1, productVariantIds: [101],
      dryRun: false, triggeredBy: "canonical_listing_quantity_refresh" }, expect.any(Function));
    expect(f.query.mock.calls[0][1]).toEqual(["channel_connection", 7, "account", "verified", "P5", "ebay"]);
    expect(f.query.mock.calls[0][0]).toContain("FOR SHARE OF t,h,m,v,provider_owner");
    expect(f.query.mock.calls[1][1]).toEqual([1, 101, "4", "3", "14", "channel_connection", 7, "ebay", "account", "verified", "P5"]);
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it("cannot revive an old positive outbox when the current eligible plan omits the SKU", async () => {
    f.publish.mockResolvedValue({ authority: "canonical", publication: { activationRunId: "4", rows: [] } });
    await expect(planCurrentCanonicalListingQuantity(scope)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_PLAN_OMITTED" });
    expect(f.query).toHaveBeenCalledOnce();
  });
  it("rejects a changed destination identity even when product and target match", async () => {
    f.publish.mockResolvedValue({ authority: "canonical", publication: { activationRunId: "4", rows: [{ ...intent, externalScopeId: "different" }] } });
    await expect(planCurrentCanonicalListingQuantity(scope)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_PLAN_OMITTED" });
  });
  it("rejects when no current desired row agrees with the fresh plan", async () => {
    f.query.mockResolvedValueOnce({ rows: [] });
    await expect(planCurrentCanonicalListingQuantity(scope)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_PLAN_MISSING" });
  });
  it("requires an exact authoritative mapping before invoking the planner", async () => {
    f.query.mockReset().mockResolvedValue({ rows: [] });
    await expect(planCurrentCanonicalListingQuantity({ ...scope, productId: 20, productVariantId: 102 }))
      .rejects.toMatchObject({ code: "PUBLICATION_LISTING_TARGET_UNMAPPED" });
    expect(f.query.mock.calls[0][1]).toEqual(["channel_connection", 7, "account", "verified", "P5", "ebay"]);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("reads the Dropship provider owner while retaining the same exact scoped planner", async () => {
    const dropship = { ...scope, destinationKind: "dropship_store_connection" as const };
    f.publish.mockResolvedValue({ authority: "canonical", publication: { activationRunId: "4", rows: [{ ...intent,
      destinationKind: dropship.destinationKind, channelConnectionId: null, dropshipStoreConnectionId: 7 }] } });
    f.query.mockResolvedValueOnce({ rows: [{ id: "9", desired_quantity: "14" }] });
    await expect(planCurrentCanonicalListingQuantity(dropship)).resolves.toEqual({ outboxId: "9", quantity: 14 });
    expect(f.query.mock.calls[0][0]).toContain("JOIN dropship.dropship_store_connections provider_owner");
    expect(f.query.mock.calls[0][0]).toContain("lower(provider_owner.platform)=$6");
  });
  it("validates the scope before acquiring a database connection", async () => {
    await expect(planCurrentCanonicalListingQuantity({ ...scope, connectionId: 0 })).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("rejects legacy authority before resolving or publishing a listing", async () => {
    f.execute.mockImplementation(work => work({ query: f.query }, { authority: "legacy" }));
    await expect(planCurrentCanonicalListingQuantity(scope)).rejects.toMatchObject({ code: "PUBLICATION_AUTHORITY_CHANGED" });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
});

describe("legacy channel catch-up runtime boundary", () => {
  const claim = { catchupId: "1", revision: "2", attemptBoundaryId: "4", scope };
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    installTransaction();
    vi.spyOn(quantityProviderResponseRecovery, "reconcile").mockResolvedValue({busy:false,resolved:[],unresolved:[]});
    vi.spyOn(quantityPublicationAdmission, "listDue").mockResolvedValue([claim]);
    vi.spyOn(quantityPublicationAdmission, "complete").mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.spyOn(quantityPublicationAdmission, "fail").mockResolvedValue();
  });

  it("delegates the exact scope under a non-admitting constraint without a global SKU or historical mapping lookup", async () => {
    f.query.mockResolvedValue({ rows: [{ authority: "legacy" }] });
    let admitted = false;
    vi.spyOn(quantityPublicationAdmission, "withLegacyCatchupScope").mockImplementation(async (_scope, work) => {
      admitted = true;
      try { return await work(); } finally { admitted = false; }
    });
    const refresh = vi.fn(async () => { expect(admitted).toBe(true); });
    await expect(createQuantityPublicationCatchupService({ refreshLegacyChannelScope: refresh }).processDue())
      .resolves.toEqual({ completed: 1, failed: 0 });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(scope);
    expect(quantityPublicationAdmission.withLegacyCatchupScope).toHaveBeenCalledWith(scope, expect.any(Function), claim);
    expect(f.query).toHaveBeenCalledOnce();
    expect(quantityProviderResponseRecovery.reconcile).toHaveBeenCalledWith(undefined,25);
    expect(vi.mocked(quantityProviderResponseRecovery.reconcile).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(quantityPublicationAdmission.listDue).mock.invocationCallOrder[0]);
  });

  it("does not invoke a legacy publisher if authority changes before admission", async () => {
    f.query.mockResolvedValue({ rows: [{ authority: "legacy" }] });
    vi.spyOn(quantityPublicationAdmission, "withLegacyCatchupScope").mockRejectedValue(Object.assign(new Error("Authority changed"), {
      code: "PUBLICATION_AUTHORITY_CHANGED",
    }));
    const refresh = vi.fn();
    await expect(createQuantityPublicationCatchupService({ refreshLegacyChannelScope: refresh }).processDue())
      .resolves.toEqual({ completed: 0, failed: 1 });
    expect(refresh).not.toHaveBeenCalled();
    expect(quantityPublicationAdmission.fail).toHaveBeenCalledWith(claim, "PUBLICATION_AUTHORITY_CHANGED", "Authority changed");
  });

  it("does not clear missing or failed scoped publication merely because a callback was attempted", async () => {
    f.query.mockResolvedValue({ rows: [{ authority: "legacy" }] });
    vi.spyOn(quantityPublicationAdmission, "withLegacyCatchupScope").mockImplementation(async (_scope, work) => work());
    const refresh = vi.fn().mockRejectedValue(new Error("Exact channel item did not publish"));
    await expect(createQuantityPublicationCatchupService({ refreshLegacyChannelScope: refresh }).processDue())
      .resolves.toEqual({ completed: 0, failed: 1 });
    expect(quantityPublicationAdmission.complete).toHaveBeenCalledOnce();
  });

  it("keeps canonical authority on the fresh exact outbox plan without entering legacy admission", async () => {
    f.query.mockResolvedValueOnce({ rows: [{ authority: "canonical" }] })
      .mockResolvedValueOnce({ rows: [{ product_id: 20, product_variant_id: 101, target_id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: "9", desired_quantity: "14" }] });
    f.publish.mockResolvedValue({ authority: "canonical", publication: { activationRunId: "4", rows: [intent] } });
    vi.spyOn(quantityPublicationAdmission, "withLegacyCatchupScope");
    const refresh = vi.fn();
    await expect(createQuantityPublicationCatchupService({ refreshLegacyChannelScope: refresh }).processDue())
      .resolves.toEqual({ completed: 1, failed: 0 });
    expect(refresh).not.toHaveBeenCalled();
    expect(quantityPublicationAdmission.withLegacyCatchupScope).not.toHaveBeenCalled();
    expect(quantityPublicationAdmission.complete).toHaveBeenLastCalledWith(claim, expect.objectContaining({ outboxId: "9" }));
  });
});
