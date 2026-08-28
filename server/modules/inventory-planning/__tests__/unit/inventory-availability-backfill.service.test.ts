import { describe, expect, it, vi } from "vitest";

import type { InventoryAvailabilityMasterDataRepository } from "../../domain/inventory-availability-master-data.contracts";
import type { InventoryAvailabilityBackfillSource } from "../../domain/inventory-availability-backfill";
import { planInventoryAvailabilityBackfill } from "../../domain/inventory-availability-backfill";
import {
  InventoryAvailabilityBackfillService,
  type CapturedInventoryAvailabilityBackfillProduct,
  type InventoryAvailabilityBackfillCatalogStore,
} from "../../application/inventory-availability-backfill.service";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const HASH = "a".repeat(64);

function source(): InventoryAvailabilityBackfillSource {
  return {
    product: {
      id: 10,
      sku: "PRODUCT",
      name: "Product",
      isActive: true,
      legacyInventoryStrategy: "physical_only",
    },
    variants: [{
      id: 11,
      productId: 10,
      sku: "EA",
      name: "Each",
      unitsPerVariant: 1,
      uomType: "each",
      isActive: true,
    }],
    recipes: [],
  };
}

function captured(
  overrides: Partial<CapturedInventoryAvailabilityBackfillProduct> = {},
): CapturedInventoryAvailabilityBackfillProduct {
  return { source: source(), draft: null, review: null, latestShadow: null, ...overrides };
}

function setup(product: CapturedInventoryAvailabilityBackfillProduct = captured()) {
  const catalogStore: InventoryAvailabilityBackfillCatalogStore = {
    captureBackfillCatalog: vi.fn(async () => ({
      capturedAt: NOW.toISOString(),
      products: [product],
    })),
    captureBackfillProduct: vi.fn(async (productId: number) => productId === 10 ? product : null),
    reviewTransformationModelDraft: vi.fn(async (command) => ({
      alreadyApplied: false,
      review: {
        reviewId: "1",
        decision: command.decision,
        reason: command.reason,
        reviewedBy: command.actorId,
        reviewedAt: command.occurredAt.toISOString(),
        modelId: command.expectedModelId,
        modelVersion: command.expectedModelVersion,
        modelDefinitionHash: command.expectedDefinitionHash,
      },
    })),
  };
  const masterDataStore = {
    createTransformationModelDraft: vi.fn(async () => ({
      modelId: 50,
      version: 1,
      definitionHash: planInventoryAvailabilityBackfill(product.source).definitionHash!,
      alreadyApplied: false,
    })),
  } as unknown as InventoryAvailabilityMasterDataRepository;
  const service = new InventoryAvailabilityBackfillService(
    catalogStore,
    masterDataStore,
    { previewLatestShadowChannels: vi.fn(async () => null) },
    { now: () => NOW },
  );
  return { service, catalogStore, masterDataStore };
}

describe("InventoryAvailabilityBackfillService", () => {
  it("classifies the complete capture and produces catalog hashes", async () => {
    const { service } = setup();
    const queue = await service.getMigrationQueue();
    expect(queue).toMatchObject({
      algorithmVersion: "inventory_availability_backfill_v1",
      capturedAt: NOW.toISOString(),
      summary: { totalActiveProducts: 1, blocked: 0, notBackfilled: 1 },
      products: [{ productId: 10, classification: "exact_only", queueState: "not_backfilled" }],
    });
    expect(queue.catalogInputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(queue.catalogResultHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a stale dry-run hash before calling the draft writer", async () => {
    const { service, masterDataStore } = setup();
    await expect(service.applyProductDraft(10, {
      expectedInputHash: HASH,
      expectedResultHash: HASH,
      changeReason: "Phase 3 review",
      idempotencyKey: "phase3-10",
    }, "operator-1")).rejects.toMatchObject({
      status: 409,
      code: "INVENTORY_AVAILABILITY_BACKFILL_PREVIEW_STALE",
    });
    expect(masterDataStore.createTransformationModelDraft).not.toHaveBeenCalled();
  });

  it("passes exact input/result evidence into the serializable draft writer", async () => {
    const product = captured();
    const candidate = planInventoryAvailabilityBackfill(product.source);
    const { service, masterDataStore } = setup(product);
    const result = await service.applyProductDraft(10, {
      expectedInputHash: candidate.inputHash,
      expectedResultHash: candidate.resultHash,
      changeReason: "Phase 3 review",
      idempotencyKey: "phase3-10",
    }, "operator-1");
    expect(result).toMatchObject({
      modelId: 50,
      inputHash: candidate.inputHash,
      resultHash: candidate.resultHash,
    });
    expect(masterDataStore.createTransformationModelDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "operator-1",
        backfillEvidence: { inputHash: candidate.inputHash, resultHash: candidate.resultHash },
        occurredAt: NOW,
      }),
    );
  });

  it("binds review evidence to the exact model, definition, and head revision", async () => {
    const draft = {
      modelId: 50,
      version: 1,
      definitionHash: HASH,
      headRevision: "2",
      origin: "phase3_backfill" as const,
      originInputHash: HASH,
      originResultHash: HASH,
    };
    const { service, catalogStore } = setup(captured({ draft }));
    const result = await service.reviewProductDraft(10, {
      expectedModelId: 50,
      expectedModelVersion: 1,
      expectedDefinitionHash: HASH,
      expectedHeadRevision: "2",
      decision: "approved",
      reason: "Verified exact-only behavior",
      idempotencyKey: "review-10",
    }, "operator-1");
    expect(result.review.decision).toBe("approved");
    expect(catalogStore.reviewTransformationModelDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 10,
        expectedModelId: 50,
        expectedDefinitionHash: HASH,
        expectedHeadRevision: "2",
        actorId: "operator-1",
        occurredAt: NOW,
      }),
    );
  });
});
