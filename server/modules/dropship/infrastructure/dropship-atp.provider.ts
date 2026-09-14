import { DropshipError } from "../domain/errors";
import type {
  DropshipAtpProvider,
  DropshipAtpSnapshot,
} from "../application/dropship-selection-atp-service";
import { isAllocationEngineError } from "../../channels/allocation-engine.errors";
import {
  InventoryChannelQuantityRuntimeError,
  type InventoryChannelQuantityRuntimeService,
} from "../../inventory-planning/application/inventory-channel-quantity-runtime.service";

/**
 * The slice of a Channel Allocation result the Dropship program consumes.
 * Kept structural so the provider can be unit-tested without the engine.
 */
export interface DropshipChannelAllocationRow {
  channelId: number;
  productVariantId: number;
  allocatedUnits: number;
  warehouseScopeSource: "explicit" | "legacy_all_active_fallback";
}

export interface DropshipChannelAllocationEngine {
  /** Read-only allocation preview: no audit rows, no provider writes. */
  previewProduct(productId: number): Promise<{
    productId: number;
    allocations: readonly DropshipChannelAllocationRow[];
  }>;
}

export interface ChannelAllocationDropshipAtpProviderDependencies {
  allocationEngine: DropshipChannelAllocationEngine;
  runtimeQuantity: InventoryChannelQuantityRuntimeService;
  /** Resolves the static internal `Dropship OMS` channel; throws when it is not configured. */
  resolveDropshipOmsChannelId: () => Promise<number>;
}

/**
 * Bound so one catalog page cannot open an allocation preview (several ATP
 * transactions each) for every product at once and exhaust the pool.
 */
const MAX_CONCURRENT_ALLOCATION_PREVIEWS = 4;

/**
 * Dropship quantity authority. Under legacy authority, the internal `Dropship
 * OMS` channel's Allocation Engine preview remains the compatibility result.
 * Under canonical authority, the exact store publication target is the only
 * quantity source; legacy vendor caps are not applied a second time. Both paths
 * are read-only and provider-safe.
 *
 * Fail-closed rules:
 *   - The channel must have an explicit enabled warehouse assignment. The engine's
 *     "all fulfillment warehouses" fallback is rejected so a vendor never lists
 *     supply from a warehouse the program did not enable.
 *   - A variant with no allocation row for the channel (blocked product line,
 *     not customer-sellable, unlisted) is exposed as 0, never as network ATP.
 *   - An engine failure is surfaced as a structured DropshipError; no quantity is
 *     fabricated.
 */
export class ChannelAllocationDropshipAtpProvider implements DropshipAtpProvider {
  constructor(private readonly deps: ChannelAllocationDropshipAtpProviderDependencies) {}

  async getVariantAtp(
    targets: readonly { productId: number; productVariantId: number }[],
    scope: { storeConnectionId?: number } = {},
  ): Promise<DropshipAtpSnapshot> {
    if (targets.length === 0) return { authority: "legacy", quantities: new Map() };
    const productIdByVariantId = indexTargetsByVariant(targets);
    const channelId = await this.deps.resolveDropshipOmsChannelId();
    const productIds = [...new Set(productIdByVariantId.values())].sort((left, right) => left - right);

    const result = new Map<number, number>(
      [...productIdByVariantId.keys()].map((variantId) => [variantId, 0]),
    );

    const allocations = await mapWithConcurrency(
      productIds,
      MAX_CONCURRENT_ALLOCATION_PREVIEWS,
      (productId) => this.previewProduct(productId, channelId, scope.storeConnectionId),
    );
    const authorities = [...new Set(allocations.map((allocation) => allocation.authority))];
    if (authorities.length !== 1) {
      throw providerError(
        "DROPSHIP_ATP_AUTHORITY_CHANGED",
        "Inventory authority changed while the Dropship quantity snapshot was being read; retry the complete read.",
        { channelId, authorities, retryable: true },
      );
    }

    for (const { productId, rows } of allocations) {
      for (const row of rows) {
        if (row.channelId !== channelId) continue;
        if (productIdByVariantId.get(row.productVariantId) !== productId) continue;
        if (!Number.isSafeInteger(row.allocatedUnits) || row.allocatedUnits < 0) {
          throw providerError(
            "DROPSHIP_ATP_QUANTITY_INVALID",
            "Channel Allocation returned an invalid allocated quantity.",
            { channelId, productId, productVariantId: row.productVariantId, allocatedUnits: row.allocatedUnits, retryable: false },
          );
        }
        result.set(row.productVariantId, row.allocatedUnits);
      }
    }
    return { authority: authorities[0]!, quantities: result };
  }

  private async previewProduct(
    productId: number,
    channelId: number,
    storeConnectionId?: number,
  ): Promise<{
    authority: "legacy" | "canonical";
    productId: number;
    rows: readonly DropshipChannelAllocationRow[];
  }> {
    try {
      const result = await this.deps.runtimeQuantity.readProduct({
        productId,
        channelId,
        target: {
          destinationKind: "dropship_store_connection",
          ...(storeConnectionId == null ? {} : { connectionId: storeConnectionId }),
          providerKey: "ebay",
        },
        allowEquivalentDestinationRows: storeConnectionId == null,
        triggeredBy: storeConnectionId == null
          ? "dropship_catalog_channel_quantity_read"
          : "dropship_store_channel_quantity_read",
      }, async () => this.previewLegacyProduct(productId, channelId));
      return {
        authority: result.authority,
        productId,
        rows: result.rows.map((row) => ({
          channelId,
          productVariantId: row.productVariantId,
          allocatedUnits: row.quantity,
          warehouseScopeSource: "explicit",
        })),
      };
    } catch (error: unknown) {
      if (isAllocationEngineError(error)) {
        throw providerError(
          "DROPSHIP_ALLOCATION_UNAVAILABLE",
          `Channel Allocation could not be computed for product ${productId}: ${error.message}`,
          {
            channelId,
            productId,
            allocationErrorCode: error.code,
            classification: error.classification,
            // Same convention the order-processing classifier reads: only a
            // transient engine failure (for example the velocity read) may retry.
            retryable: error.classification === "transient",
            ...error.context,
          },
        );
      }
      if (error instanceof InventoryChannelQuantityRuntimeError
        || (error instanceof Error && error.name === "InventoryAvailabilityRuntimePublicationError")) {
        throw providerError(
          "DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE",
          `The canonical Dropship channel quantity could not be resolved for product ${productId}: ${error.message}`,
          {
            channelId,
            productId,
            storeConnectionId: storeConnectionId ?? null,
            quantityErrorCode: "code" in error ? String(error.code) : error.name,
            retryable: false,
          },
        );
      }
      throw error;
    }
  }

  private async previewLegacyProduct(
    productId: number,
    channelId: number,
  ): Promise<readonly { productVariantId: number; quantity: number }[]> {
    const allocation = await this.deps.allocationEngine.previewProduct(productId);
    if (allocation.productId !== productId) {
      throw providerError(
        "DROPSHIP_ALLOCATION_RESULT_MISMATCH",
        "Channel Allocation returned a result for a different product.",
        { channelId, requestedProductId: productId, returnedProductId: allocation.productId, retryable: false },
      );
    }
    return allocation.allocations
      .filter((row) => row.channelId === channelId)
      .map((row) => {
        if (row.warehouseScopeSource === "legacy_all_active_fallback") {
          throw providerError(
            "DROPSHIP_ALLOCATION_WAREHOUSE_SCOPE_REQUIRED",
            "The Dropship OMS channel has no enabled warehouse assignment. Dropship quantities fail closed until at least one warehouse is enabled for it in Channel Allocation.",
            { channelId, productId, productVariantId: row.productVariantId, retryable: false },
          );
        }
        if (!Number.isSafeInteger(row.allocatedUnits) || row.allocatedUnits < 0) {
          throw providerError(
            "DROPSHIP_ATP_QUANTITY_INVALID",
            "Channel Allocation returned an invalid allocated quantity.",
            { channelId, productId, productVariantId: row.productVariantId,
              allocatedUnits: row.allocatedUnits, retryable: false },
          );
        }
        return { productVariantId: row.productVariantId, quantity: row.allocatedUnits };
      });
  }
}

function indexTargetsByVariant(
  targets: readonly { productId: number; productVariantId: number }[],
): Map<number, number> {
  const productIdByVariantId = new Map<number, number>();
  for (const target of targets) {
    const productId = positiveInteger(target.productId, "productId");
    const productVariantId = positiveInteger(target.productVariantId, "productVariantId");
    const existingProductId = productIdByVariantId.get(productVariantId);
    if (existingProductId != null && existingProductId !== productId) {
      throw providerError(
        "DROPSHIP_ATP_TARGET_CONFLICT",
        "One product variant cannot belong to multiple ATP target products.",
        { productVariantId, productIds: [existingProductId, productId] },
      );
    }
    productIdByVariantId.set(productVariantId, productId);
  }
  return productIdByVariantId;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw providerError(
      "DROPSHIP_ATP_TARGET_INVALID",
      `${field} must be a positive PostgreSQL integer.`,
      { field, value },
    );
  }
  return parsed;
}

function providerError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>>,
): DropshipError {
  return new DropshipError(code, message, { ...context });
}
