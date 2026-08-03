import { pool } from "../../db";
import type {
  ChannelAdapterRegistry,
  InventoryPushResult,
} from "./channel-adapter.interface";
import { resolveVariantAvailabilityTarget } from "./variant-availability-sync.domain";
import {
  claimVariantAvailabilitySyncs,
  enqueueVariantAvailabilitySync,
  loadVariantAvailabilityContext,
  markVariantAvailabilityFailed,
  markVariantAvailabilitySynced,
  supersedeAvailabilityClaim,
  type ClaimedVariantAvailabilitySync,
  type SqlPool,
} from "./variant-availability-sync.repository";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LEASE_SECONDS = 120;
const LOG_PREFIX = "[Variant Availability Sync]";

interface AllocationEngineLike {
  allocateProduct(
    productId: number,
    triggeredBy?: string,
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
  batchSize?: number;
  leaseSeconds?: number;
}

export interface VariantAvailabilityBatchResult {
  claimed: number;
  synced: number;
  retried: number;
  superseded: number;
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
    },
  );
}

async function processClaim(
  dependencies: Required<Pick<VariantAvailabilitySyncServiceDependencies, "dbPool" | "allocationEngine" | "adapterRegistry">>,
  claim: ClaimedVariantAvailabilitySync,
): Promise<"synced" | "retryable" | "superseded"> {
  try {
    const context = await loadVariantAvailabilityContext(dependencies.dbPool, claim);
    if (!context) return "superseded";

    if (context.catalogVariantActive !== claim.desiredActive) {
      await supersedeAvailabilityClaim(
        dependencies.dbPool,
        claim,
        context.catalogVariantActive,
      );
      return "superseded";
    }

    if (context.channelProvider.toLowerCase() !== "ebay") {
      throw new Error(`Unsupported availability-sync provider ${context.channelProvider}`);
    }

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
      );
      const matchingAllocation = allocation.allocations.find(
        (candidate) =>
          candidate.channelId === context.channelId &&
          candidate.productVariantId === context.productVariantId,
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
    }]);
    const result: InventoryPushResult | undefined = results.find(
      (candidate) => candidate.variantId === context.productVariantId,
    );
    if (!result) {
      throw new Error(`eBay adapter returned no result for variant ${context.productVariantId}`);
    }
    if (result.status !== "success") {
      throw new Error(result.error || `eBay adapter returned ${result.status}`);
    }

    const completed = await markVariantAvailabilitySynced(dependencies.dbPool, claim, {
      quantity: target.quantity,
      feedActive: target.feedActive,
      externalProductId: context.externalProductId,
      externalVariantId: result.refreshedExternalVariantId ?? context.externalVariantId,
      externalInventoryItemId: context.externalInventoryItemId,
      externalSku,
    });
    if (!completed) return "superseded";

    console.info(`${LOG_PREFIX} Synchronized variant availability`, {
      channelId: context.channelId,
      productVariantId: context.productVariantId,
      sku: externalSku,
      desiredActive: claim.desiredActive,
      quantity: target.quantity,
      revision: claim.revision,
    });
    return "synced";
  } catch (error) {
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
      };

      // Process sequentially to respect marketplace rate limits and keep the
      // per-variant transition order obvious in logs.
      for (const claim of claims) {
        const disposition = await processClaim(requiredDependencies, claim);
        if (disposition === "synced") summary.synced += 1;
        else if (disposition === "retryable") summary.retried += 1;
        else summary.superseded += 1;
      }
      return summary;
    },
  };
}
