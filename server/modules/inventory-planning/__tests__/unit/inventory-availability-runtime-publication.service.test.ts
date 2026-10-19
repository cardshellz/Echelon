import { describe, expect, it, vi } from "vitest";

import type { InventoryChannelExposureRuntimePlan } from "@shared/types/inventory-channel-exposure";
import {
  AuthorityAwareInventoryPublicationService,
  type ActiveInventoryPublicationTarget,
  type InventoryAvailabilityRuntimePublicationContext,
  type InventoryAvailabilityRuntimePublicationExecutor,
} from "../../application/inventory-availability-runtime-publication.service";

const HASH = "a".repeat(64);

describe("AuthorityAwareInventoryPublicationService", () => {
  it.each([true, false])("does not perform retained-stock cleanup during a quantity read, but preserves the publication guard (dryRun=%s)", async dryRun => {
    const context = runtimeContext("canonical");
    context.listUnmanagedPublicationVariantIds = vi.fn(async () => [102]);
    const service = new AuthorityAwareInventoryPublicationService(executor(context), 3);
    const legacy = vi.fn();
    const result = await service.readProductQuantities({ productId: 10, dryRun: true, triggeredBy: "listing_feed" }, legacy);
    expect(result).toMatchObject({ authority: "canonical", publication: { dryRun: true,
      rows: [{ productVariantId: 101, desiredQuantity: "4" }], enqueuedRows: 0 } });
    expect(context.planProduct).toHaveBeenCalledWith(10, 3, "channel_quantity_read");
    expect(context.listUnmanagedPublicationVariantIds).not.toHaveBeenCalled();
    expect(context.loadActivePublicationTargets).not.toHaveBeenCalled();
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    await expect(service.publishProduct({ productId: 10, dryRun }, legacy)).rejects.toMatchObject({
      code: "CANONICAL_PUBLICATION_MAPPING_MISSING",
      message: "A retained listing has no exact provider identity to clear. Correct its saved listing link before retrying.",
    });
    expect(context.loadActivePublicationTargets).toHaveBeenCalledWith({ productId: 10, productVariantIds: [102], channelId: 3 });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });
  it("reads a deferred Dropship quantity under canonical authority without fabricating a provider identity or enqueuing", async () => {
    const context = runtimeContext("canonical");
    const plan = runtimePlan([{ ...target(), destinationKind: "dropship_store_connection",
      channelConnectionId: null, dropshipStoreConnectionId: 1, mappings: [] }]);
    plan.targets[0]!.rows[0]!.blockers = [];
    context.planProduct = vi.fn(async () => plan);
    const service = new AuthorityAwareInventoryPublicationService(executor(context), 3);
    const legacy = vi.fn();
    const result = await service.readProductQuantities({ productId: 10, dryRun: true, triggeredBy: "listing_preview" }, legacy);
    expect(result).toMatchObject({ authority: "canonical", publication: { dryRun: true, enqueuedRows: 0,
      rows: [{ desiredQuantity: "4", dropshipStoreConnectionId: 1, blockerCodes: [] }] } });
    if (result.authority !== "canonical") throw new Error("Expected canonical quantity");
    expect(result.publication.rows[0]).not.toHaveProperty("externalInventoryItemId");
    expect(context.planProduct).toHaveBeenCalledWith(10, 3, "channel_quantity_read");
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    await expect(service.publishProduct({ productId: 10, dryRun: false }, legacy)).rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_TARGET_BLOCKED" });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });
  it("keeps legacy Dropship reads pinned and rejects stale canonical read lineage", async () => {
    const legacyContext = runtimeContext("legacy"); const legacy = vi.fn(async () => ["legacy"]);
    const input = { productId: 10, dryRun: true as const, triggeredBy: "preview" };
    await expect(new AuthorityAwareInventoryPublicationService(executor(legacyContext)).readProductQuantities(input, legacy))
      .resolves.toEqual({ authority: "legacy", legacyResult: ["legacy"] });
    expect(legacyContext.planProduct).not.toHaveBeenCalled();
    const context = runtimeContext("canonical"); context.planProduct = vi.fn(async () => ({ ...runtimePlan([target()]), authorityRevision: "8" }));
    await expect(new AuthorityAwareInventoryPublicationService(executor(context)).readProductQuantities(input, legacy))
      .rejects.toMatchObject({ code: "CANONICAL_CHANNEL_QUANTITY_PLAN_MISMATCH" });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });
  it("pins legacy authority around the existing publisher", async () => {
    const context = runtimeContext("legacy");
    const legacyPublisher = vi.fn(async () => ["legacy-result"]);
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    await expect(service.publishProduct({
      productId: 10,
      dryRun: false,
      triggeredBy: "inventory_change:receive",
    }, legacyPublisher)).resolves.toEqual({
      authority: "legacy",
      legacyResult: ["legacy-result"],
    });

    expect(legacyPublisher).toHaveBeenCalledOnce();
    expect(context.planProduct).not.toHaveBeenCalled();
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("calculates active target exposure and durably enqueues absolute canonical quantity", async () => {
    const context = runtimeContext("canonical");
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    const routed = await service.publishProduct({
      productId: 10,
      dryRun: false,
      triggeredBy: "inventory_change:pick",
    }, vi.fn());

    expect(routed).toMatchObject({
      authority: "canonical",
      publication: {
        authorityRevision: "9",
        activationRunId: "44",
        enqueuedRows: 1,
        coalescedRows: 0,
        rows: [{
          publicationTargetId: 5,
          productVariantId: 101,
          desiredQuantity: "4",
          externalInventoryItemId: "inventory-item-101",
          sourceWarehouseIds: [1],
        }],
      },
    });
    expect(context.enqueueFullPublications).toHaveBeenCalledWith(
      "44",
      [expect.objectContaining({ desiredQuantity: "4" })],
    );
  });

  it("uses the canonical calculation for dry-run without inserting outbox work", async () => {
    const context = runtimeContext("canonical");
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    const routed = await service.publishProduct({ productId: 10, dryRun: true }, vi.fn());

    expect(routed).toMatchObject({
      authority: "canonical",
      publication: { dryRun: true, rows: [{ desiredQuantity: "4" }], enqueuedRows: 0 },
    });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("plans the whole channel but enqueues only the exact target selected by a scoped resume", async () => {
    const context = runtimeContext("canonical");
    context.planProduct = vi.fn(async () => runtimePlan([
      target(),
      { ...target(), publicationTargetId: 6, channelConnectionId: 34, externalScopeId: "location-2" },
    ]));
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    const routed = await service.publishProduct({
      productId: 10,
      channelId: 3,
      publicationTargetId: 6,
      dryRun: false,
      triggeredBy: "publication_target_resume",
    }, vi.fn());

    expect(context.planProduct).toHaveBeenCalledWith(10, 3);
    expect(routed).toMatchObject({
      authority: "canonical",
      publication: {
        rows: [{ publicationTargetId: 6, productVariantId: 101, desiredQuantity: "4" }],
        enqueuedRows: 1,
      },
    });
    expect(context.enqueueFullPublications).toHaveBeenCalledWith(
      "44",
      [expect.objectContaining({ publicationTargetId: 6, productVariantId: 101 })],
    );
  });

  it("enqueues an absolute zero when an exact mapped SKU is made ineligible", async () => {
    const context = runtimeContext("canonical");
    const plan = runtimePlan([target()]);
    context.planProduct = vi.fn(async () => ({
      ...plan,
      targets: plan.targets.map((plannedTarget) => ({
        ...plannedTarget,
        rows: plannedTarget.rows.map((row) => ({
          ...row,
          sharedUnits: "0",
          afterHoldbackUnits: "0",
          cappedUnits: "0",
          publishedUnits: "0",
          policy: row.policy ? { ...row.policy, eligible: false } : null,
        })),
      })),
    }));
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    const routed = await service.publishProduct({
      productId: 10,
      dryRun: false,
      triggeredBy: "channel_policy_changed",
    }, vi.fn());

    expect(routed).toMatchObject({
      authority: "canonical",
      publication: { rows: [{ productVariantId: 101, desiredQuantity: "0" }], enqueuedRows: 1 },
    });
    expect(context.enqueueFullPublications).toHaveBeenCalledWith(
      "44",
      [expect.objectContaining({ productVariantId: 101, desiredQuantity: "0" })],
    );
  });

  it("keeps the full product calculation while emitting only the requested target and members", async () => {
    const context = runtimeContext("canonical");
    const plan = runtimePlan([target(), { ...target(), publicationTargetId: 6 }]);
    const first = plan.targets[0]!.rows[0]!;
    plan.targets[0]!.rows.push({ ...structuredClone(first), productVariantId: 102, sku: "CASE",
      publishedUnits: "2", mapping: { ...first.mapping!, mappingId: 2,
        externalInventoryItemId: "inventory-item-102", externalSku: "CASE" } });
    const original = structuredClone(plan);
    context.planProduct = vi.fn(async () => plan);
    context.listUnmanagedPublicationVariantIds = vi.fn(async () => [103]);
    const requestedMembers = Object.freeze([101]);
    const service = new AuthorityAwareInventoryPublicationService(executor(context), 3);

    const result = await service.publishProduct({ productId: 10, publicationTargetId: 5,
      productVariantIds: requestedMembers, dryRun: false }, vi.fn());

    expect(context.planProduct).toHaveBeenCalledWith(10, 3);
    expect(result).toMatchObject({ authority: "canonical", publication: { enqueuedRows: 1,
      rows: [{ publicationTargetId: 5, productVariantId: 101, desiredQuantity: "4" }] } });
    expect(context.enqueueFullPublications).toHaveBeenCalledWith("44", [expect.objectContaining({
      publicationTargetId: 5, productVariantId: 101, desiredQuantity: "4" })]);
    expect(context.loadActivePublicationTargets).not.toHaveBeenCalled();
    expect(plan).toEqual(original);
    expect(requestedMembers).toEqual([101]);
  });

  it("publishes the requested clean member when only an unselected row makes the target unpublishable", async () => {
    const context = runtimeContext("canonical");
    const plan = runtimePlan([target()]);
    const plannedTarget = plan.targets[0]!;
    plannedTarget.rows.push({ ...structuredClone(plannedTarget.rows[0]!), productVariantId: 102, sku: "CASE",
      mapping: null, blockers: [{ code: "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING",
        message: "The unselected member has no provider mapping.", context: { productVariantId: 102 } }] });
    plannedTarget.publishable = false;
    const original = structuredClone(plan);
    context.planProduct = vi.fn(async () => plan);
    const service = new AuthorityAwareInventoryPublicationService(executor(context), 3);

    await expect(service.publishProduct({ productId: 10, publicationTargetId: 5,
      productVariantIds: [101], dryRun: false }, vi.fn())).resolves.toMatchObject({
      authority: "canonical", publication: { rows: [{ productVariantId: 101, desiredQuantity: "4" }], enqueuedRows: 1 },
    });

    expect(context.planProduct).toHaveBeenCalledExactlyOnceWith(10, 3);
    expect(context.enqueueFullPublications).toHaveBeenCalledExactlyOnceWith("44", [expect.objectContaining({
      publicationTargetId: 5, productVariantId: 101, desiredQuantity: "4" })]);
    expect(plan).toEqual(original);
  });

  it.each(["missing mapping", "row blocker"] as const)(
    "rejects a requested member with a %s before enqueueing any scoped rows", async problem => {
      const context = runtimeContext("canonical");
      const plan = runtimePlan([target()]);
      const plannedTarget = plan.targets[0]!;
      const requested = { ...structuredClone(plannedTarget.rows[0]!), productVariantId: 102, sku: "CASE" };
      requested.mapping = problem === "missing mapping" ? null : { ...requested.mapping!, mappingId: 2,
        externalInventoryItemId: "inventory-item-102", externalSku: "CASE" };
      requested.blockers = [{ code: problem === "missing mapping"
        ? "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING" : "CHANNEL_EXPOSURE_POLICY_INCOMPLETE",
      message: "The requested member is not safe to publish.", context: { productVariantId: 102 } }];
      plannedTarget.rows.push(requested);
      plannedTarget.publishable = false;
      const original = structuredClone(plan);
      context.planProduct = vi.fn(async () => plan);
      const service = new AuthorityAwareInventoryPublicationService(executor(context), 3);

      await expect(service.publishProduct({ productId: 10, publicationTargetId: 5,
        productVariantIds: [101, 102], dryRun: false }, vi.fn())).rejects.toMatchObject({
        code: "CANONICAL_PUBLICATION_ROW_BLOCKED", context: { productId: 10, publicationTargetId: 5, productVariantId: 102 },
      });

      expect(context.planProduct).toHaveBeenCalledExactlyOnceWith(10, 3);
      expect(context.enqueueFullPublications).not.toHaveBeenCalled();
      expect(plan).toEqual(original);
    });

  it("rejects a target blocker even when every explicitly requested row is clean", async () => {
    const context = runtimeContext("canonical");
    const plan = runtimePlan([target()]);
    plan.targets[0]!.publishable = false;
    plan.targets[0]!.blockers = [{ code: "CHANNEL_SOURCE_NODE_NOT_ACTIVE",
      message: "A source fulfillment node is inactive.", context: { fulfillmentNodeIds: [1] } }];
    const original = structuredClone(plan);
    context.planProduct = vi.fn(async () => plan);
    const service = new AuthorityAwareInventoryPublicationService(executor(context), 3);

    await expect(service.publishProduct({ productId: 10, publicationTargetId: 5,
      productVariantIds: [101], dryRun: false }, vi.fn())).rejects.toMatchObject({
      code: "CANONICAL_PUBLICATION_TARGET_BLOCKED", context: { productId: 10, publicationTargetId: 5,
        blockerCodes: ["CHANNEL_SOURCE_NODE_NOT_ACTIVE"] },
    });

    expect(context.planProduct).toHaveBeenCalledExactlyOnceWith(10, 3);
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
    expect(plan).toEqual(original);
  });

  it.each([
    { name: "empty", members: [] },
    { name: "duplicate", members: [101, 101] },
    { name: "zero", members: [0] },
    { name: "negative", members: [-1] },
    { name: "fractional", members: [101.5] },
    { name: "not a number", members: [Number.NaN] },
    { name: "unsafe integer", members: [Number.MAX_SAFE_INTEGER + 1] },
  ])("rejects a $name scope before planning or writing", async ({ members }) => {
    const context = runtimeContext("canonical");
    const legacy = vi.fn();
    const service = new AuthorityAwareInventoryPublicationService(executor(context), 3);
    await expect(service.publishProduct({ productId: 10, publicationTargetId: 5,
      productVariantIds: members, dryRun: false }, legacy)).rejects.toThrow();
    expect(context.planProduct).not.toHaveBeenCalled();
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("requires an exact target for an explicit member scope", async () => {
    const context = runtimeContext("canonical");
    const service = new AuthorityAwareInventoryPublicationService(executor(context), 3);
    await expect(service.publishProduct({ productId: 10, productVariantIds: [101], dryRun: false }, vi.fn()))
      .rejects.toThrow();
    expect(context.planProduct).not.toHaveBeenCalled();
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a variant absent from this product", publicationTargetId: 5, productVariantIds: [101, 999] },
    { name: "a target absent from this product plan", publicationTargetId: 999, productVariantIds: [101] },
  ])("rejects $name without partially enqueueing", async input => {
    const context = runtimeContext("canonical");
    const service = new AuthorityAwareInventoryPublicationService(executor(context), 3);
    await expect(service.publishProduct({ productId: 10, publicationTargetId: input.publicationTargetId,
      productVariantIds: input.productVariantIds, dryRun: false }, vi.fn()))
      .rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_VARIANT_NOT_ELIGIBLE" });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("does not widen an explicit member scope into a legacy whole-product write", async () => {
    const context = runtimeContext("legacy");
    const legacy = vi.fn();
    const service = new AuthorityAwareInventoryPublicationService(executor(context), 3);
    await expect(service.publishProduct({ productId: 10, publicationTargetId: 5,
      productVariantIds: [101], dryRun: false }, legacy)).rejects.toThrow();
    expect(legacy).not.toHaveBeenCalled();
    expect(context.planProduct).not.toHaveBeenCalled();
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("enqueues a Dropship-owned target from the same canonical exposure result", async () => {
    const context = runtimeContext("canonical");
    const plan = runtimePlan([target()]);
    context.planProduct = vi.fn(async () => ({
      ...plan,
      targets: plan.targets.map((publicationTarget) => ({
        ...publicationTarget,
        destinationKind: "dropship_store_connection" as const,
        channelConnectionId: null,
        dropshipStoreConnectionId: 91,
        channelProvider: "ebay",
        providerScopeType: "account" as const,
        externalScopeId: "seller-account-1",
      })),
    }));
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    await expect(service.publishProduct({ productId: 10, dryRun: false }, vi.fn()))
      .resolves.toMatchObject({
        authority: "canonical",
        publication: {
          rows: [{
            desiredQuantity: "4",
            destinationKind: "dropship_store_connection",
            channelConnectionId: null,
            dropshipStoreConnectionId: 91,
            providerKey: "ebay",
          }],
        },
      });
    expect(context.enqueueFullPublications).toHaveBeenCalledWith(
      "44",
      [expect.objectContaining({
        destinationKind: "dropship_store_connection",
        dropshipStoreConnectionId: 91,
        desiredQuantity: "4",
      })],
    );
  });

  it("forces an inactive mapped variant to zero without requiring it in the active ATP snapshot", async () => {
    const context = runtimeContext("canonical");
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    const routed = await service.publishVariantAvailability({
      productId: 10,
      productVariantId: 101,
      channelId: 3,
      desiredActive: false,
    }, vi.fn());

    expect(routed).toMatchObject({
      authority: "canonical",
      publication: {
        rows: [{ productVariantId: 101, channelId: 3, desiredQuantity: "0" }],
      },
    });
    expect(context.planProduct).not.toHaveBeenCalled();
    expect(context.enqueueFullPublications).toHaveBeenCalledWith(
      "44",
      [expect.objectContaining({ desiredQuantity: "0" })],
    );
  });

  it("fails closed when a live target lacks the exact active provider mapping", async () => {
    const context = runtimeContext("canonical", [{ ...target(), mappings: [] }]);
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    await expect(service.publishProduct({ productId: 10, dryRun: false }, vi.fn()))
      .rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING" });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("rejects overlapping account and location targets for the same channel variant", async () => {
    const context = runtimeContext("canonical", [
      { ...target(), providerScopeType: "account", externalScopeId: "account-3" },
      { ...target(), publicationTargetId: 6, externalScopeId: "location-2" },
    ]);
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    await expect(service.publishProduct({ productId: 10, dryRun: false }, vi.fn()))
      .rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_TARGET_SCOPE_AMBIGUOUS" });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("does not treat separate channel connections as an overlapping provider scope", async () => {
    const context = runtimeContext("canonical", [
      { ...target(), providerScopeType: "account", externalScopeId: "account-3" },
      { ...target(), publicationTargetId: 6, channelConnectionId: 34, externalScopeId: "location-2" },
    ]);
    const service = new AuthorityAwareInventoryPublicationService(executor(context));

    await expect(service.publishProduct({ productId: 10, dryRun: false }, vi.fn()))
      .resolves.toMatchObject({ authority: "canonical", publication: { enqueuedRows: 2 } });
  });

  it("uses active canonical mappings to enumerate full-sync products", async () => {
    const canonical = runtimeContext("canonical");
    canonical.listActivePublicationProductIds = vi.fn(async () => [12, 10, 12]);
    const canonicalService = new AuthorityAwareInventoryPublicationService(executor(canonical));
    await expect(canonicalService.listProductIds(vi.fn(async () => [99])))
      .resolves.toEqual([10, 12]);

    const legacy = runtimeContext("legacy");
    const legacyReader = vi.fn(async () => [8, 7, 8]);
    const legacyService = new AuthorityAwareInventoryPublicationService(executor(legacy));
    await expect(legacyService.listProductIds(legacyReader)).resolves.toEqual([7, 8]);
    expect(legacy.listActivePublicationProductIds).not.toHaveBeenCalled();
  });
  // #64414: one live destination with no listing mapping made the whole
  // product unpublishable, which failed the pick and froze every other channel.
  describe("isolating an unsafe destination during fan-out", () => {
    const walmart = (): ActiveInventoryPublicationTarget => ({ ...target(), publicationTargetId: 34, channelId: 104,
      channelName: "Walmart", providerKey: "walmart", channelConnectionId: 44, externalScopeId: "walmart-1", mappings: [] });

    it("publishes every safe destination and reports the unsafe one instead of throwing", async () => {
      const context = runtimeContext("canonical", [target(), walmart()]);
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const service = new AuthorityAwareInventoryPublicationService(executor(context), undefined, logger);

      const routed = await service.publishProduct({ productId: 10, dryRun: false, triggeredBy: "inventory_change:pick",
        blockedTargets: "isolate" }, vi.fn());

      expect(routed).toMatchObject({ authority: "canonical", publication: {
        rows: [{ publicationTargetId: 5, productVariantId: 101, desiredQuantity: "4" }],
        blockedTargets: [{ publicationTargetId: 34, channelId: 104, channelName: "Walmart",
          errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING",
          blockerCodes: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"], productVariantIds: [101] }],
      } });
      expect(context.enqueueFullPublications).toHaveBeenCalledExactlyOnceWith("44",
        [expect.objectContaining({ publicationTargetId: 5 })]);
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        event: "canonical_inventory_publication_target_isolated", error_code: "CANONICAL_PUBLICATION_MAPPING_MISSING",
        publicationTargetId: 34, productId: 10 }));
    });

    it("sends nothing to an isolated destination, including its retained zero obligations", async () => {
      const context = runtimeContext("canonical", [target(), walmart()]);
      context.listUnmanagedPublicationVariantIds = vi.fn(async () => [102]);
      const service = new AuthorityAwareInventoryPublicationService(executor(context), undefined,
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() });

      const routed = await service.publishProduct({ productId: 10, dryRun: false, blockedTargets: "isolate" }, vi.fn());

      if (routed.authority !== "canonical") throw new Error("Expected canonical publication");
      // 102 has no mapping on either target: both are blocked for it, and
      // target 5 withholds its whole projection rather than a partial one.
      expect(routed.publication.rows).toEqual([]);
      expect(routed.publication.blockedTargets?.map(entry => [entry.publicationTargetId, entry.productVariantIds]))
        .toEqual([[5, [102]], [34, [101, 102]]]);
    });

    it("keeps rejecting by default so listing setup still gets its exact answer", async () => {
      const context = runtimeContext("canonical", [target(), walmart()]);
      const service = new AuthorityAwareInventoryPublicationService(executor(context));
      await expect(service.publishProduct({ productId: 10, dryRun: false }, vi.fn()))
        .rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING", context: { publicationTargetId: 34 } });
      expect(context.enqueueFullPublications).not.toHaveBeenCalled();
    });

    it("refuses isolation for an exact-target request", async () => {
      const context = runtimeContext("canonical", [target(), walmart()]);
      const service = new AuthorityAwareInventoryPublicationService(executor(context));
      await expect(service.publishProduct({ productId: 10, dryRun: false, publicationTargetId: 34,
        blockedTargets: "isolate" }, vi.fn())).rejects.toMatchObject({ code: "INVALID_INVENTORY_PUBLICATION_SCOPE" });
      expect(context.planProduct).not.toHaveBeenCalled();
    });
  });

});

function executor(
  context: InventoryAvailabilityRuntimePublicationContext,
): InventoryAvailabilityRuntimePublicationExecutor {
  return { execute: (work) => work(context) };
}

function runtimeContext(
  authority: "legacy" | "canonical",
  targets: ActiveInventoryPublicationTarget[] = [target()],
): InventoryAvailabilityRuntimePublicationContext & Record<string, ReturnType<typeof vi.fn>> {
  return {
    authority,
    authorityRevision: authority === "canonical" ? "9" : "1",
    activationRunId: authority === "canonical" ? "44" : null,
    listActivePublicationProductIds: vi.fn(async () => [10]),
    planProduct: vi.fn(async () => runtimePlan(targets)),
    loadActivePublicationTargets: vi.fn(async () => targets),
    enqueueFullPublications: vi.fn(async (_runId, intents) => ({
      enqueuedRows: intents.length,
      coalescedRows: 0,
      enqueuedPublicationKeys: intents.map((row) =>
        `${row.publicationTargetId}:${row.productVariantId}`),
      coalescedPublicationKeys: [],
    })),
  } as never;
}

function target(): ActiveInventoryPublicationTarget {
  return {
    publicationTargetId: 5,
    publicationTargetRevision: "2",
    channelId: 3,
    channelName: "Shopify US",
    providerKey: "shopify",
    destinationKind: "channel_connection",
    channelConnectionId: 33,
    dropshipStoreConnectionId: null,
    providerScopeType: "location",
    externalScopeId: "location-1",
    sourceBindingId: 7,
    sourceWarehouseIds: [1],
    mappings: [{
      productVariantId: 101,
      externalInventoryItemId: "inventory-item-101",
      externalSku: "EA",
    }],
  };
}

function runtimePlan(targets: ActiveInventoryPublicationTarget[]): InventoryChannelExposureRuntimePlan {
  return {
    authority: "canonical",
    authorityRevision: "9",
    activationRunId: "44",
    productId: 10,
    snapshotFingerprint: HASH,
    snapshotCapturedAt: "2026-09-04T12:00:00.000Z",
    targets: targets.map((target) => {
      const mapping = target.mappings[0] ?? null;
        return {
          publicationTargetId: target.publicationTargetId,
          publicationTargetRevision: target.publicationTargetRevision,
          destinationKind: target.destinationKind,
          channelId: target.channelId,
        channelName: target.channelName,
        channelProvider: target.providerKey,
          channelConnectionId: target.channelConnectionId,
          dropshipStoreConnectionId: target.dropshipStoreConnectionId,
        providerScopeType: target.providerScopeType,
        externalScopeId: target.externalScopeId,
        publicationAuthority: "echelon" as const,
        publicationTargetState: "live" as const,
        sourceBinding: {
          bindingId: target.sourceBindingId ?? 7,
          version: 1,
          definitionHash: HASH,
          fulfillmentNodeIds: [1],
          warehouseIds: target.sourceWarehouseIds,
        },
        selectedPolicies: [{
          scopeKey: `channel:${target.channelId}`,
          policyId: 1,
          version: 1,
          definitionHash: HASH,
        }],
        rows: [{
          productVariantId: 101,
          sku: "EA",
          unitsPerVariant: 1,
          canonicalAtpUnits: "10",
          sharedUnits: "5",
          afterHoldbackUnits: "4",
          cappedUnits: "4",
          publishedUnits: "4",
          sourceWarehouseBreakdown: [{ warehouseId: 1, canonicalAtpUnits: "10" }],
          policy: {
            allocationSemantics: "exposure" as const,
            eligible: true,
            shareBps: 5_000,
            holdbackSellableUnits: "1",
            maxPublishSellableUnits: null,
            minPublishSellableUnits: "0",
            sources: {
              allocationSemantics: `channel:${target.channelId}`,
              eligible: `channel:${target.channelId}`,
              shareBps: `channel:${target.channelId}`,
              holdbackSellableUnits: `channel:${target.channelId}`,
              maxPublishSellableUnits: `channel:${target.channelId}`,
              minPublishSellableUnits: `channel:${target.channelId}`,
            },
          },
          mapping: mapping ? {
            mappingId: 1,
            version: 1,
            definitionHash: HASH,
            externalInventoryItemId: mapping.externalInventoryItemId,
            externalSku: mapping.externalSku,
          } : null,
          blockers: mapping ? [] : [{
            code: "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING",
            message: "The target has no active provider inventory identity for this SKU.",
            context: {},
          }],
          warnings: [],
        }],
        blockers: [],
        publishable: mapping !== null,
      };
    }),
    providerWriteAttempted: false,
    outboxEnqueued: false,
  };
}
