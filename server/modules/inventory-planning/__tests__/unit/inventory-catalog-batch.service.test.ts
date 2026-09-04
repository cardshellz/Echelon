import { describe, expect, it, vi } from "vitest";
import { catalogBatchAction, catalogBatchExecutionPreview, INVENTORY_CATALOG_BATCH_LIMIT } from "@shared/types/inventory-catalog-batch";
import type { InventoryAvailabilityBackfillQueueRow } from "@shared/types/inventory-availability-backfill";
import { InventoryCatalogBatchService } from "../../application/inventory-catalog-batch.service";
import { InventoryAvailabilityMasterDataError } from "../../domain/inventory-availability-master-data.contracts";
import { GLOBAL_JSON_LIMIT_BYTES } from "../../../shipping-engine/interfaces/http/rate-table-admin-body.middleware";

const HASH = "a".repeat(64);
const OLD = "b".repeat(64);
function product(productId = 10): InventoryAvailabilityBackfillQueueRow {
  return { productId, productSku: `SKU-${productId}`, productName: "Product", legacyInventoryStrategy: "physical_only",
    activeVariantCount: 1, activeRecipeCount: 0, classification: "exact_only", inputHash: HASH, resultHash: HASH,
    candidateDefinitionHash: HASH, candidateDefinition: { buildToPromiseEnabled: false, paths: [], recipeBindings: [] },
    issues: [], queueState: "not_backfilled", draft: null, review: null, latestShadow: null };
}
function drafted(stale = false, id = 10): InventoryAvailabilityBackfillQueueRow {
  return { ...product(id), queueState: stale ? "conflicting_draft" : "awaiting_review",
    draft: { modelId: id + 100, version: 1, definitionHash: HASH, headRevision: "0", origin: "phase3_backfill",
      originInputHash: stale ? OLD : HASH, originResultHash: stale ? OLD : HASH,
      definitionMatch: true, provenanceMatch: !stale, candidateMatch: !stale } };
}
function setup(products = [product()]) {
  const backfill = {
    getMigrationQueue: vi.fn(async () => ({ algorithmVersion: "inventory_availability_backfill_v3" as const,
      capturedAt: "2026-09-04T12:00:00.000Z", catalogInputHash: HASH, catalogResultHash: HASH,
      summary: { totalActiveProducts: products.length, blocked: 0, excluded: 0, notBackfilled: products.length,
        conflictingDraft: 0, awaitingReview: 0, changesRequired: 0, approved: 0 }, products })),
    applyProductDraft: vi.fn(async () => ({ modelId: 110, version: 1, definitionHash: HASH,
      alreadyApplied: false, inputHash: HASH, resultHash: HASH })),
    refreshProductDraft: vi.fn(async () => ({ modelId: 111, supersededModelId: 110, version: 2,
      definitionHash: HASH, alreadyApplied: false, inputHash: HASH, resultHash: HASH })),
    reviewProductDraft: vi.fn(async () => ({ alreadyApplied: false, review: { reviewId: "1",
      decision: "approved" as const, reason: "Reviewed", reviewedBy: "operator", reviewedAt: "2026-09-04T12:00:00.000Z",
      modelId: 110, modelVersion: 1, modelDefinitionHash: HASH } })),
  };
  const log = vi.fn();
  const service = new InventoryCatalogBatchService(backfill, log);
  return { backfill, service, log };
}

describe("catalog batch convergence", () => {
  it("previews deterministically in product order without calling a writer", async () => {
    const { service, backfill } = setup([product(2), product(1)]);
    const first = await service.preview({ mode: "drafts", productIds: [2, 1] });
    expect(first).toEqual(await service.preview({ mode: "drafts", productIds: [1, 2] }));
    expect(first.products.map((row) => row.productId)).toEqual([1, 2]);
    expect(backfill.applyProductDraft).not.toHaveBeenCalled();
    expect(backfill.refreshProductDraft).not.toHaveBeenCalled();
    expect(backfill.reviewProductDraft).not.toHaveBeenCalled();
  });

  it.each([[], [10, 10], [0], [-1], [2147483648], Array.from({ length: INVENTORY_CATALOG_BATCH_LIMIT + 1 }, (_, i) => i + 1)])(
    "rejects invalid or unbounded selections %#", async (...ids) => {
      const { service, backfill } = setup();
      await expect(service.preview({ mode: "drafts", productIds: ids })).rejects.toMatchObject({ status: 400 });
      expect(backfill.getMigrationQueue).not.toHaveBeenCalled();
    });

  it("accepts the maximum batch and rejects unknown selected products", async () => {
    const products = Array.from({ length: INVENTORY_CATALOG_BATCH_LIMIT }, (_, i) => product(i + 1));
    const { service } = setup(products);
    expect((await service.preview({ mode: "drafts", productIds: products.map((row) => row.productId) })).products).toHaveLength(25);
    await expect(service.preview({ mode: "drafts", productIds: [999] })).rejects.toMatchObject({ status: 404 });
  });

  it("separates draft convergence from review and skips operator/excluded/blocked/approved rows", () => {
    expect(catalogBatchAction("drafts", product())).toBe("create");
    expect(catalogBatchAction("drafts", drafted(true))).toBe("refresh");
    expect(catalogBatchAction("drafts", drafted())).toBe("skip");
    expect(catalogBatchAction("reviews", drafted())).toBe("review");
    expect(catalogBatchAction("reviews", { ...drafted(), queueState: "changes_required" })).toBe("review");
    for (const mode of ["drafts", "reviews"] as const) {
      for (const queueState of ["blocked", "excluded", "approved"] as const) {
        expect(catalogBatchAction(mode, { ...drafted(), queueState })).toBe("skip");
      }
      const operator = drafted(true);
      operator.draft = { ...operator.draft!, origin: "operator", originInputHash: null, originResultHash: null };
      expect(catalogBatchAction(mode, operator)).toBe("skip");
    }
  });

  it("keeps maximum-size batch execution below the actual global body limit", async () => {
    const products = Array.from({ length: INVENTORY_CATALOG_BATCH_LIMIT }, (_, index) => {
      const row = drafted(false, index + 1);
      row.productName = "Long catalog name ".repeat(1000);
      row.queueState = "changes_required";
      row.review = { reviewId: String(index + 1), modelId: row.draft!.modelId, modelVersion: 1,
        modelDefinitionHash: HASH, decision: "changes_required", reason: "🧪".repeat(500),
        reviewedBy: "operator", reviewedAt: "2026-09-04T12:00:00.000Z" };
      return row;
    });
    const { service } = setup(products);
    const fullPreview = await service.preview({ mode: "reviews", productIds: products.map((row) => row.productId) });
    const compact = catalogBatchExecutionPreview(fullPreview);
    expect(compact.products[0]).not.toHaveProperty("candidateDefinition");
    expect(compact.products[0]).not.toHaveProperty("review");
    expect(Buffer.byteLength(JSON.stringify({ preview: compact, reason: "🧪".repeat(500), decision: "approved" })))
      .toBeLessThan(GLOBAL_JSON_LIMIT_BYTES);
  });

  it("forwards exact source, supersession, actor and reason evidence with stable row keys", async () => {
    const { service, backfill } = setup([product(), drafted(true, 20)]);
    const preview = catalogBatchExecutionPreview(await service.preview({ mode: "drafts", productIds: [10, 20] }));
    const request = { preview, reason: "Converge current catalog", decision: null };
    const result = await service.execute(request, "operator");
    expect(result.rows.map((row) => row.status)).toEqual(["applied", "applied"]);
    expect(result).toMatchObject({ runtimeAuthorityChanged: false, inventoryWriteAttempted: false, providerWriteAttempted: false });
    expect(backfill.applyProductDraft).toHaveBeenCalledWith(10, expect.objectContaining({
      expectedInputHash: HASH, expectedResultHash: HASH, changeReason: request.reason,
      idempotencyKey: expect.stringMatching(/^catalog-batch:[a-f0-9]{64}$/),
    }), "operator");
    expect(backfill.refreshProductDraft).toHaveBeenCalledWith(20, 120, expect.objectContaining({
      expectedDraftVersion: 1, expectedDraftDefinitionHash: HASH, expectedDraftHeadRevision: "0",
      expectedDraftOriginInputHash: OLD, expectedDraftOriginResultHash: OLD,
    }), "operator");
    await service.execute(request, "operator");
    expect(backfill.refreshProductDraft.mock.calls[1]).toEqual(backfill.refreshProductDraft.mock.calls[0]);
    expect(backfill.reviewProductDraft).not.toHaveBeenCalled();
  });

  it("rejects tampered preview, blank reason, caller-supplied actor and mixed-phase decisions before writes", async () => {
    const { service, backfill } = setup();
    const preview = catalogBatchExecutionPreview(await service.preview({ mode: "drafts", productIds: [10] }));
    for (const request of [
      { preview: { ...preview, previewHash: OLD }, reason: "Test", decision: null },
      { preview, reason: " ", decision: null },
      { preview, reason: "Test", decision: "approved" },
      { preview, reason: "Test", decision: null, actorId: "forged" },
    ]) await expect(service.execute(request, "operator")).rejects.toBeInstanceOf(InventoryAvailabilityMasterDataError);
    await expect(service.execute({ preview, reason: "Test", decision: null }, " ")).rejects.toMatchObject({ status: 400 });
    expect(backfill.applyProductDraft).not.toHaveBeenCalled();
  });

  it.each(["create", "refresh"])("recognizes a converged %s after a lost response without another write", async (action) => {
    const products = [action === "create" ? product() : drafted(true)];
    const { service, backfill } = setup(products);
    const preview = catalogBatchExecutionPreview(await service.preview({ mode: "drafts", productIds: [10] }));
    products[0] = drafted();
    const result = await service.execute({ preview, reason: "Test", decision: null }, "operator");
    expect(result.rows[0]).toMatchObject({ status: "already_current", modelId: 110 });
    expect(backfill.applyProductDraft).not.toHaveBeenCalled();
    expect(backfill.refreshProductDraft).not.toHaveBeenCalled();
  });

  it("binds reviews to the exact definition and latest decision; preserves replay receipts", async () => {
    const { service, backfill } = setup([drafted()]);
    const preview = catalogBatchExecutionPreview(await service.preview({ mode: "reviews", productIds: [10] }));
    await expect(service.execute({ preview, reason: "Reviewed", decision: null }, "operator")).rejects.toMatchObject({ status: 400 });
    const request = { preview, reason: "Reviewed", decision: "approved" };
    await service.execute(request, "operator");
    expect(backfill.reviewProductDraft).toHaveBeenCalledWith(10, expect.objectContaining({
      expectedModelId: 110, expectedModelVersion: 1, expectedDefinitionHash: HASH, expectedHeadRevision: "0",
      expectedLatestReviewId: null, decision: "approved", reason: "Reviewed",
    }), "operator");
    const receipt = await backfill.reviewProductDraft();
    backfill.reviewProductDraft.mockResolvedValue({ ...receipt, alreadyApplied: true });
    expect((await service.execute(request, "operator")).rows[0]).toMatchObject({ status: "replayed", reviewId: "1" });
  });

  it.each([
    [new InventoryAvailabilityMasterDataError(409, "STALE", "Reload"), "permanent", "STALE"],
    [Object.assign(new Error("serialization"), { code: "40001" }), "transient", "INVENTORY_CATALOG_BATCH_CONCURRENT_CHANGE"],
    [Object.assign(new Error("deadlock"), { code: "40P01" }), "transient", "INVENTORY_CATALOG_BATCH_CONCURRENT_CHANGE"],
    [Object.assign(new Error("constraint"), { code: "23505" }), "permanent", "INVENTORY_CATALOG_BATCH_REFERENCE_CHANGED"],
  ])("reports expected row failures without discarding other results %#", async (error, failureClass, code) => {
    const { service, backfill } = setup([product(1), product(2)]);
    backfill.applyProductDraft.mockRejectedValueOnce(error);
    const preview = catalogBatchExecutionPreview(await service.preview({ mode: "drafts", productIds: [1, 2] }));
    expect((await service.execute({ preview, reason: "Test", decision: null }, "operator")).rows).toMatchObject([
      { status: "failed", failureClass, code }, { status: "applied" },
    ]);
  });

  it("stops on an unexpected failure and logs details without leaking them to the response", async () => {
    const { service, backfill, log } = setup([product(1), product(2)]);
    backfill.applyProductDraft.mockRejectedValueOnce(new Error("private DB diagnostics"));
    const preview = catalogBatchExecutionPreview(await service.preview({ mode: "drafts", productIds: [1, 2] }));
    const result = await service.execute({ preview, reason: "Test", decision: null }, "operator");
    expect(result.rows).toMatchObject([{ status: "failed", failureClass: "fatal" }, { status: "not_attempted" }]);
    expect(backfill.applyProductDraft).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private DB diagnostics");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: "error", error: "private DB diagnostics" }));
  });
});
