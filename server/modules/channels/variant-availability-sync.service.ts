import { pool } from "../../db";
import type {
  ChannelAdapterRegistry,
  InventoryPushResult,
} from "./channel-adapter.interface";
import { resolveVariantAvailabilityTarget } from "./variant-availability-sync.domain";
import {
  claimVariantAvailabilitySyncs,
  availabilityClaimPublicationGuard,
  enqueueVariantAvailabilitySync,
  loadVariantAvailabilityContext,
  markVariantAvailabilityDelegated,
  markVariantAvailabilityNotApplicable,
  markVariantAvailabilityFailed,
  markVariantAvailabilitySynced,
  retainVariantAvailabilityAcknowledgement,
  supersedeAvailabilityClaim,
  type ClaimedVariantAvailabilitySync,
  type SqlPool,
  type VariantAvailabilityContext,
} from "./variant-availability-sync.repository";
import { isInventoryManagedVariant } from "@shared/catalog/variant-inventory-eligibility";
import { isCustomerSellableVariant } from "@shared/catalog/variant-sales-eligibility";
import type { AuthorityAwareInventoryPublicationService } from "../inventory-planning/application/inventory-availability-runtime-publication.service";
import type { PublicationTransactionGuard } from "../inventory-planning/publication-transaction-guard";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LEASE_SECONDS = 120;
const LOG_PREFIX = "[Variant Availability Sync]";

interface AllocationEngineLike {
  allocateProduct(
    productId: number,
    triggeredBy?: string,
    channelIds?: readonly number[],
  ): Promise<{
    allocations: Array<{
      channelId: number;
      productVariantId: number;
      allocatedUnits: number;
    }>;
  }>;
}

export interface VariantAvailabilitySyncServiceDependencies {
  dbPool?: SqlPool;
  allocationEngine: AllocationEngineLike;
  adapterRegistry: ChannelAdapterRegistry;
  inventoryPublication: AuthorityAwareInventoryPublicationService;
  batchSize?: number;
  leaseSeconds?: number;
}

export interface VariantAvailabilityBatchResult {
  claimed: number;
  synced: number;
  retried: number;
  superseded: number;
  needsReview: number;
}

export interface QueueVariantAvailabilityRepairInput {
  channelId: number;
  productVariantId: number;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

export async function queueVariantAvailabilityRepair(
  input: QueueVariantAvailabilityRepairInput,
  dependencies: { dbPool?: SqlPool } = {},
): Promise<void> {
  const channelId = requirePositiveInteger(input.channelId, "channelId");
  const productVariantId = requirePositiveInteger(input.productVariantId, "productVariantId");
  await enqueueVariantAvailabilitySync(
    dependencies.dbPool ?? (pool as unknown as SqlPool),
    {
      channelId,
      productVariantId,
      desiredActive: false,
      requestKind: "stock_repair",
    },
  );
}

async function processClaim(
  dependencies: Required<Pick<
    VariantAvailabilitySyncServiceDependencies,
    "dbPool" | "allocationEngine" | "adapterRegistry" | "inventoryPublication"
  >>,
  claim: ClaimedVariantAvailabilitySync,
): Promise<"synced" | "retryable" | "superseded" | "needs_review"> {
  let providerAcknowledged = false;
  try {
    const context = await loadVariantAvailabilityContext(dependencies.dbPool, claim);
    if (!context) return "superseded";

    const catalogActive = context.catalogProductActive === true
      && context.catalogProductStatus !== "archived" && context.catalogVariantActive === true;
    // A status scan can explicitly request a zero for an internal-only
    // variant. The recorded request kind, not a matching boolean, distinguishes
    // this existing obligation from an old archive-triggered zero.
    const internalOnlyRepair = claim.requestKind === "stock_repair" && !claim.desiredActive
      && (!catalogActive || !isCustomerSellableVariant({ salesEligibility: context.catalogSalesEligibility }));
    if ((!catalogActive && !internalOnlyRepair)
      || (context.catalogVariantActive !== claim.desiredActive && !internalOnlyRepair)) {
      return supersedeAvailabilityClaim(
        dependencies.dbPool,
        claim,
        catalogActive,
      );
    }

    if (context.channelProvider.toLowerCase() !== "ebay") {
      throw new Error(`Unsupported availability-sync provider ${context.channelProvider}`);
    }

    if (!isInventoryManagedVariant({
      requiresShipping: context.catalogRequiresShipping,
      trackInventory: context.catalogTrackInventory,
    })) {
      const completed = await markVariantAvailabilityNotApplicable(dependencies.dbPool, claim);
      console.info(`${LOG_PREFIX} Skipped quantity publication for unmanaged variant`, {
        channelId: context.channelId,
        productVariantId: context.productVariantId,
        requiresShipping: context.catalogRequiresShipping,
        trackInventory: context.catalogTrackInventory,
        revision: claim.revision,
        completed,
      });
      return completed ? "synced" : "superseded";
    }
    if (!isCustomerSellableVariant({ salesEligibility: context.catalogSalesEligibility }) && !internalOnlyRepair) {
      const completed = await markVariantAvailabilityNotApplicable(dependencies.dbPool, claim);
      console.info(`${LOG_PREFIX} Skipped quantity publication for internal-only variant`, {
        channelId: context.channelId,
        productVariantId: context.productVariantId,
        salesEligibility: context.catalogSalesEligibility,
        revision: claim.revision,
        completed,
      });
      return completed ? "synced" : "superseded";
    }

    const ownerGuard = availabilityClaimPublicationGuard(claim, context);
    const routed = await dependencies.inventoryPublication.publishVariantAvailability({
      productId: context.productId,
      productVariantId: context.productVariantId,
      channelId: context.channelId,
      desiredActive: claim.desiredActive,
      triggeredBy: "variant_availability_sync",
    }, async () => publishLegacyAvailability(dependencies, claim, context, ownerGuard), ownerGuard);
    if (routed.authority === "legacy") {
      providerAcknowledged = true;
      let completion: Awaited<ReturnType<typeof markVariantAvailabilitySynced>>;
      try {
        completion = await markVariantAvailabilitySynced(dependencies.dbPool, claim, routed.legacyResult, context.mappingSnapshot);
      } catch (error) {
        // A confirmed provider response must never go through the unsent-work
        // retry path just because its local projection failed.
        completion = await retainVariantAvailabilityAcknowledgement(dependencies.dbPool, claim, routed.legacyResult, context.mappingSnapshot);
        console.error(`${LOG_PREFIX} Could not project an acknowledged provider update`, {
          channelId: claim.channelId, productVariantId: claim.productVariantId, revision: claim.revision,
          code: "VARIANT_AVAILABILITY_ACKNOWLEDGEMENT_PROJECTION_FAILED",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (completion === "needs_review") {
        console.error(`${LOG_PREFIX} Acknowledged provider update needs review`, {
          channelId: claim.channelId, productVariantId: claim.productVariantId, revision: claim.revision,
          code: "VARIANT_AVAILABILITY_ACKNOWLEDGEMENT_REVIEW",
        });
        return "needs_review";
      }
      if (completion === "claim_changed") {
        console.warn(`${LOG_PREFIX} Provider acknowledged an update after its claim changed`, {
          channelId: claim.channelId, productVariantId: claim.productVariantId, revision: claim.revision,
          code: "VARIANT_AVAILABILITY_ACKNOWLEDGED_CLAIM_CHANGED",
        });
        return "superseded";
      }
    } else if (!await markVariantAvailabilityDelegated(dependencies.dbPool, claim)) {
      return "superseded";
    }

    console.info(`${LOG_PREFIX} Synchronized variant availability`, {
      channelId: context.channelId,
      productVariantId: context.productVariantId,
      sku: context.externalSku ?? context.catalogSku,
      desiredActive: claim.desiredActive,
      publicationAuthority: routed.authority === "legacy" ? "legacy_direct" : "canonical_outbox",
      quantity: routed.authority === "legacy" ? routed.legacyResult.quantity : null,
      canonicalRows: routed.authority === "canonical" ? routed.publication.rows.length : 0,
      revision: claim.revision,
    });
    return "synced";
  } catch (error) {
    if (providerAcknowledged) {
      console.error(`${LOG_PREFIX} Could not retain an acknowledged provider update`, {
        channelId: claim.channelId, productVariantId: claim.productVariantId, revision: claim.revision,
        code: "VARIANT_AVAILABILITY_ACKNOWLEDGEMENT_NOT_SAVED",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const disposition = await markVariantAvailabilityFailed(dependencies.dbPool, claim, error);
    console.error(`${LOG_PREFIX} Failed to synchronize variant availability`, {
      channelId: claim.channelId,
      productVariantId: claim.productVariantId,
      desiredActive: claim.desiredActive,
      revision: claim.revision,
      attemptCount: claim.attemptCount,
      disposition,
      error: error instanceof Error ? error.message : String(error),
    });
    return disposition;
  }
}

export function createVariantAvailabilitySyncService(
  dependencies: VariantAvailabilitySyncServiceDependencies,
): { processDue(): Promise<VariantAvailabilityBatchResult> } {
  const dbPool = dependencies.dbPool ?? (pool as unknown as SqlPool);
  const batchSize = requirePositiveInteger(
    dependencies.batchSize ?? DEFAULT_BATCH_SIZE,
    "batchSize",
  );
  const leaseSeconds = requirePositiveInteger(
    dependencies.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    "leaseSeconds",
  );
  const requiredDependencies = {
    dbPool,
    allocationEngine: dependencies.allocationEngine,
    adapterRegistry: dependencies.adapterRegistry,
    inventoryPublication: dependencies.inventoryPublication,
  };

  return {
    async processDue(): Promise<VariantAvailabilityBatchResult> {
      const claims = await claimVariantAvailabilitySyncs(dbPool, {
        batchSize,
        leaseSeconds,
      });
      const summary: VariantAvailabilityBatchResult = {
        claimed: claims.length,
        synced: 0,
        retried: 0,
        superseded: 0,
        needsReview: 0,
      };

      // Process sequentially to respect marketplace rate limits and keep the
      // per-variant transition order obvious in logs.
      for (const claim of claims) {
        const disposition = await processClaim(requiredDependencies, claim);
        if (disposition === "synced") summary.synced += 1;
        else if (disposition === "retryable") summary.retried += 1;
        else if (disposition === "needs_review") summary.needsReview += 1;
        else summary.superseded += 1;
      }
      return summary;
    },
  };
}

async function publishLegacyAvailability(
  dependencies: Required<Pick<
    VariantAvailabilitySyncServiceDependencies,
    "allocationEngine" | "adapterRegistry"
  >>,
  claim: ClaimedVariantAvailabilitySync,
  context: VariantAvailabilityContext,
  ownerGuard: PublicationTransactionGuard,
): Promise<{
  quantity: number;
  feedActive: boolean;
  externalProductId: string | null;
  externalVariantId: string | null;
  externalInventoryItemId: string | null;
  externalSku: string;
}> {
  let allocatedQuantity = 0;
  if (claim.desiredActive) {
    if (
      context.channelStatus !== "active" ||
      context.channelSyncEnabled !== true ||
      context.channelSyncMode !== "live"
    ) {
      throw new Error(
        `Cannot reactivate ${context.externalSku ?? context.catalogSku ?? context.productVariantId}: ` +
        `channel ${context.channelName} is not active with live sync enabled`,
      );
    }
    const allocation = await dependencies.allocationEngine.allocateProduct(
      context.productId,
      "variant_availability_reactivation",
      [context.channelId],
    );
    const matchingAllocation = allocation.allocations.find(
      (candidate) => candidate.channelId === context.channelId
        && candidate.productVariantId === context.productVariantId,
    );
    allocatedQuantity = matchingAllocation?.allocatedUnits ?? 0;
  }
  const target = resolveVariantAvailabilityTarget({
    desiredActive: claim.desiredActive,
    catalogVariantActive: context.catalogVariantActive,
    catalogProductActive: context.catalogProductActive,
    catalogProductStatus: context.catalogProductStatus,
    productExcluded: context.productExcluded,
    variantExcluded: context.variantExcluded,
    productOverrideIsListed: context.productOverrideIsListed,
    variantOverrideIsListed: context.variantOverrideIsListed,
    allocatedQuantity,
  });
  const externalSku = context.externalSku ?? context.catalogSku;
  if (!externalSku) {
    throw new Error(`Variant ${context.productVariantId} has no SKU for eBay availability sync`);
  }
  const adapter = dependencies.adapterRegistry.getOrThrow(context.channelProvider);
  const results = await adapter.pushInventory(context.channelId, [{
    variantId: context.productVariantId,
    sku: externalSku,
    externalVariantId: context.externalVariantId,
    externalInventoryItemId: context.externalInventoryItemId,
    allocatedQty: target.quantity,
  }], undefined, ownerGuard);
  const result: InventoryPushResult | undefined = results.find(
    (candidate) => candidate.variantId === context.productVariantId,
  );
  if (!result) {
    throw new Error(`eBay adapter returned no result for variant ${context.productVariantId}`);
  }
  if (result.status !== "success") {
    throw new Error(result.error || `eBay adapter returned ${result.status}`);
  }
  return {
    quantity: target.quantity,
    feedActive: target.feedActive,
    externalProductId: context.externalProductId,
    externalVariantId: result.refreshedExternalVariantId ?? context.externalVariantId,
    externalInventoryItemId: context.externalInventoryItemId,
    externalSku,
  };
}
