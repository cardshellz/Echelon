import type { SQL } from "drizzle-orm";

/**
 * Minimal transaction surface used when a catalog identity command must include
 * inventory-planning evidence and writes in the caller's atomic transaction.
 * The inventory-planning implementation remains the only code allowed to know
 * its table layout or mutation choreography.
 */
export interface CatalogConsolidationInventoryPlanningTransaction {
  execute(query: SQL): Promise<unknown>;
}

export interface CatalogConsolidationProductPlanningEvidence {
  readonly productId: number;
  readonly activeTransformationModelId: number | null;
  readonly draftTransformationModelId: number | null;
  readonly activeChannelExposurePolicyCount: number;
}

export interface CatalogConsolidationVariantPlanningEvidence {
  readonly variantId: number;
  readonly activeClaimCount: number;
  readonly openPlanningWorkReferenceCount: number;
  readonly nonDraftTransformationReferenceCount: number;
  readonly channelExposurePolicyVersionCount: number;
  readonly transformationRecipeBindingCount: number;
  readonly transformationRecipeComponentSnapshotCount: number;
}

export interface CatalogConsolidationInventoryPlanningEvidence {
  readonly activeCutoverFreezeId: string | null;
  readonly products: readonly CatalogConsolidationProductPlanningEvidence[];
  readonly variants: readonly CatalogConsolidationVariantPlanningEvidence[];
}

export interface CatalogConsolidationDraftInvalidationResult {
  readonly invalidatedModelIds: readonly number[];
  readonly replacementModelIds: readonly number[];
}

export type CatalogConsolidationInventoryPlanningErrorCode =
  | "INVENTORY_PLANNING_CONSOLIDATION_EVIDENCE_INVALID"
  | "INVENTORY_PLANNING_CONSOLIDATION_DRAFT_STALE"
  | "INVENTORY_PLANNING_CONSOLIDATION_DRAFT_VERSION_EXHAUSTED"
  | "INVENTORY_PLANNING_CONSOLIDATION_DRAFT_NOT_REPLACED";

export class CatalogConsolidationInventoryPlanningError extends Error {
  constructor(
    readonly code: CatalogConsolidationInventoryPlanningErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "CatalogConsolidationInventoryPlanningError";
  }
}

export interface CatalogConsolidationInventoryPlanningPort {
  /** Acquire the canonical transformation lock in ascending product order. */
  lockProducts(input: {
    client: CatalogConsolidationInventoryPlanningTransaction;
    productIds: readonly number[];
  }): Promise<void>;

  /** Fence all planning tables read by the consolidation dependency snapshot. */
  fenceDependencies(input: {
    client: CatalogConsolidationInventoryPlanningTransaction;
  }): Promise<void>;

  loadEvidence(input: {
    client: CatalogConsolidationInventoryPlanningTransaction;
    productIds: readonly number[];
    variants: readonly { variantId: number; productId: number }[];
  }): Promise<CatalogConsolidationInventoryPlanningEvidence>;

  invalidateDrafts(input: {
    client: CatalogConsolidationInventoryPlanningTransaction;
    expectedDrafts: readonly {
      productId: number;
      draftModelId: number;
    }[];
    canonicalProductId: number;
    externalProductId: string;
    requestHash: string;
    idempotencyKey: string;
    actor: string;
    reason: string;
    occurredAt: Date;
  }): Promise<CatalogConsolidationDraftInvalidationResult>;
}
