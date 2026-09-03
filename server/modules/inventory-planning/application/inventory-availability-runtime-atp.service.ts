import { isCustomerSellableVariant } from "@shared/catalog/variant-sales-eligibility";
import type { AtpProjectionRequestDto, SupplySnapshotDto } from "@shared/types/inventory-availability-planner";

import type {
  BaseUnitTotals,
  ChannelVariantAtp,
  InventoryAtpServiceContract,
  InventoryItemAtpSummary,
  ProductAtpSummary,
  VariantAtp,
} from "../../inventory/atp.service";
import { projectCanonicalAtp } from "../domain/inventory-availability-planner";

export type InventoryAvailabilityRuntimeAuthority = "legacy" | "canonical";

export interface InventoryAvailabilityRuntimeAtpContext {
  authority: InventoryAvailabilityRuntimeAuthority;
  authorityRevision: string;
  activationRunId: string | null;
  legacy: InventoryAtpServiceContract;
  captureActiveSupplySnapshot(productId: number): Promise<SupplySnapshotDto>;
  getProductIdsByVariantIds(variantIds: readonly number[]): Promise<Map<number, number>>;
}

export interface InventoryAvailabilityRuntimeAtpExecutor {
  execute<T>(
    work: (context: InventoryAvailabilityRuntimeAtpContext) => Promise<T>,
  ): Promise<T>;
}

export interface InventoryAvailabilityRuntimeAtpLogger {
  warn(event: Readonly<Record<string, unknown>>): void;
}

const defaultLogger: InventoryAvailabilityRuntimeAtpLogger = {
  warn(event) {
    console.warn(JSON.stringify(event));
  },
};

export class InventoryAvailabilityRuntimeAtpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityRuntimeAtpError";
  }
}

/**
 * The single operational ATP read boundary.
 *
 * The executor pins and locks one runtime-authority revision for the complete
 * read. Legacy mode delegates to the deployed calculator. Canonical mode uses
 * only active planning heads and never falls back to a draft or raw inventory
 * formula.
 */
export class AuthorityAwareInventoryAtpService implements InventoryAtpServiceContract {
  constructor(
    private readonly executor: InventoryAvailabilityRuntimeAtpExecutor,
    private readonly logger: InventoryAvailabilityRuntimeAtpLogger = defaultLogger,
  ) {}

  async getProductInventoryStrategy(productId: number) {
    const validatedProductId = positiveInteger(productId, "productId");
    return this.executor.execute(async (context) => {
      if (context.authority === "canonical") {
        throw unsupportedCanonicalCompatibilityRead(
          "CANONICAL_CLAIM_ROUTING_REQUIRED",
          "Legacy inventory strategy cannot decide reservation behavior after canonical cutover.",
          context,
          { productId: validatedProductId },
        );
      }
      return context.legacy.getProductInventoryStrategy(validatedProductId);
    });
  }

  async getTotalBaseUnits(productId: number): Promise<BaseUnitTotals> {
    const validatedProductId = positiveInteger(productId, "productId");
    return this.executor.execute((context) => context.legacy.getTotalBaseUnits(validatedProductId));
  }

  async getAtpBase(productId: number): Promise<number> {
    const validatedProductId = positiveInteger(productId, "productId");
    return this.executor.execute(async (context) => {
      if (context.authority === "canonical") {
        throw unsupportedCanonicalCompatibilityRead(
          "CANONICAL_PRODUCT_BASE_ATP_UNSUPPORTED",
          "Canonical ATP is defined per sellable SKU and fulfillment scope, not as one fungible product pool.",
          context,
          { productId: validatedProductId },
        );
      }
      return context.legacy.getAtpBase(validatedProductId);
    });
  }

  async getAtpBaseByWarehouse(productId: number, warehouseId: number): Promise<number> {
    const validatedProductId = positiveInteger(productId, "productId");
    const validatedWarehouseId = positiveInteger(warehouseId, "warehouseId");
    return this.executor.execute(async (context) => {
      if (context.authority === "canonical") {
        throw unsupportedCanonicalCompatibilityRead(
          "CANONICAL_PRODUCT_BASE_ATP_UNSUPPORTED",
          "Canonical warehouse ATP is defined per sellable SKU, not as one fungible product pool.",
          context,
          { productId: validatedProductId, warehouseId: validatedWarehouseId },
        );
      }
      return context.legacy.getAtpBaseByWarehouse(validatedProductId, validatedWarehouseId);
    });
  }

  async getDirectVariantAtpByWarehouse(
    variantIds: number[],
    warehouseId: number,
  ): Promise<Map<number, number>> {
    const validatedVariantIds = uniquePositiveIntegers(variantIds, "variantIds");
    const validatedWarehouseId = positiveInteger(warehouseId, "warehouseId");
    if (validatedVariantIds.length === 0) return new Map();
    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") {
        return context.legacy.getDirectVariantAtpByWarehouse(
          validatedVariantIds,
          validatedWarehouseId,
        );
      }
      const productIdsByVariantId = await context.getProductIdsByVariantIds(validatedVariantIds);
      const requestedByProduct = new Map<number, number[]>();
      for (const variantId of validatedVariantIds) {
        const productId = productIdsByVariantId.get(variantId);
        if (productId == null) continue;
        const values = requestedByProduct.get(productId) ?? [];
        values.push(variantId);
        requestedByProduct.set(productId, values);
      }
      const result = new Map<number, number>(
        validatedVariantIds.map((variantId) => [variantId, 0]),
      );
      for (const [productId, productVariantIds] of [...requestedByProduct].sort(([left], [right]) => left - right)) {
        const projected = await this.projectCanonicalVariants(
          context,
          productId,
          { kind: "warehouse", warehouseId: validatedWarehouseId },
        );
        const requested = new Set(productVariantIds);
        for (const variant of projected) {
          if (requested.has(variant.productVariantId)) result.set(variant.productVariantId, variant.atpUnits);
        }
      }
      return result;
    });
  }

  async getAtpPerVariantByWarehouse(productId: number, warehouseId: number): Promise<VariantAtp[]> {
    const validatedProductId = positiveInteger(productId, "productId");
    const validatedWarehouseId = positiveInteger(warehouseId, "warehouseId");
    return this.executor.execute((context) => context.authority === "legacy"
      ? context.legacy.getAtpPerVariantByWarehouse(validatedProductId, validatedWarehouseId)
      : this.projectCanonicalVariants(
          context,
          validatedProductId,
          { kind: "warehouse", warehouseId: validatedWarehouseId },
        ));
  }

  async getAtpPerVariant(productId: number): Promise<VariantAtp[]> {
    const validatedProductId = positiveInteger(productId, "productId");
    return this.executor.execute((context) => context.authority === "legacy"
      ? context.legacy.getAtpPerVariant(validatedProductId)
      : this.projectCanonicalVariants(context, validatedProductId, { kind: "network" }));
  }

  async getAtpForChannel(productId: number, channelId: number): Promise<ChannelVariantAtp[]> {
    const validatedProductId = positiveInteger(productId, "productId");
    const validatedChannelId = positiveInteger(channelId, "channelId");
    return this.executor.execute(async (context) => {
      if (context.authority === "canonical") {
        throw unsupportedCanonicalCompatibilityRead(
          "CANONICAL_CHANNEL_EXPOSURE_REQUIRED",
          "Canonical channel quantity requires the active channel-exposure policy and source binding.",
          context,
          { productId: validatedProductId, channelId: validatedChannelId },
        );
      }
      return context.legacy.getAtpForChannel(validatedProductId, validatedChannelId);
    });
  }

  async getProductSummary(productId: number): Promise<ProductAtpSummary | null> {
    const validatedProductId = positiveInteger(productId, "productId");
    return this.executor.execute(async (context) => {
      const legacySummary = await context.legacy.getProductSummary(validatedProductId);
      if (context.authority === "legacy" || legacySummary === null) return legacySummary;
      const canonical = await this.projectCanonicalVariants(context, validatedProductId, { kind: "network" });
      const byVariantId = new Map(canonical.map((variant) => [variant.productVariantId, variant] as const));
      return {
        ...legacySummary,
        // This compatibility aggregate is non-additive because target-SKU ATP
        // projections can consume the same physical resource through different
        // directed paths. The largest represented capacity is conservative and
        // is display-only; promise decisions consume the per-SKU rows above.
        totalAtpBase: maximumAtpBase(canonical),
        variants: legacySummary.variants.map((variant) => ({
          ...variant,
          atpUnits: byVariantId.get(variant.productVariantId)?.atpUnits ?? 0,
        })),
      };
    });
  }

  async getInventoryItemSummary(productId: number): Promise<InventoryItemAtpSummary | null> {
    const validatedProductId = positiveInteger(productId, "productId");
    return this.executor.execute(async (context) => {
      const legacySummary = await context.legacy.getInventoryItemSummary(validatedProductId);
      if (context.authority === "legacy" || legacySummary === null) return legacySummary;
      const canonical = await this.projectCanonicalVariants(context, validatedProductId, { kind: "network" });
      const byVariantId = new Map(canonical.map((variant) => [variant.productVariantId, variant] as const));
      return {
        ...legacySummary,
        totalAtpPieces: maximumAtpBase(canonical),
        variants: legacySummary.variants.map((variant) => {
          const atp = byVariantId.get(variant.variantId);
          return {
            ...variant,
            available: atp?.atpUnits ?? 0,
            atpPieces: atp?.atpBase ?? 0,
          };
        }),
      };
    });
  }

  async getBulkAtp(productIds: number[]): Promise<Map<number, number>> {
    const validatedProductIds = uniquePositiveIntegers(productIds, "productIds");
    if (validatedProductIds.length === 0) return new Map();
    return this.executor.execute(async (context) => {
      if (context.authority === "canonical") {
        throw unsupportedCanonicalCompatibilityRead(
          "CANONICAL_PRODUCT_BASE_ATP_UNSUPPORTED",
          "Bulk canonical ATP must request exact sellable SKUs instead of product base pools.",
          context,
          { productIds: validatedProductIds },
        );
      }
      return context.legacy.getBulkAtp(validatedProductIds);
    });
  }

  private async projectCanonicalVariants(
    context: InventoryAvailabilityRuntimeAtpContext,
    productId: number,
    scope: AtpProjectionRequestDto["scope"],
  ): Promise<VariantAtp[]> {
    const snapshot = await context.captureActiveSupplySnapshot(productId);
    const targetVariants = snapshot.variants
      .filter((variant) => variant.productId === productId && variant.isActive)
      .filter(isCustomerSellableVariant)
      .sort((left, right) => left.id - right.id);
    return targetVariants.map((variant) => {
      const projection = projectCanonicalAtp(snapshot, {
        targetVariantId: variant.id,
        scope,
      });
      if (projection.blockers.length > 0) {
        this.logger.warn({
          event: "canonical_atp_projection_blocked",
          productId,
          productVariantId: variant.id,
          scope,
          authorityRevision: context.authorityRevision,
          activationRunId: context.activationRunId,
          blockerCodes: projection.blockers.map((blocker) => blocker.code),
        });
      }
      return {
        productVariantId: variant.id,
        sku: variant.sku ?? "",
        name: variant.name,
        unitsPerVariant: variant.unitsPerVariant,
        salesEligibility: "sellable",
        atpUnits: safeNonnegativeQuantity(projection.atpUnits, "projection.atpUnits", variant.id),
        atpBase: safeNonnegativeQuantity(projection.atpBaseUnits, "projection.atpBaseUnits", variant.id),
      };
    });
  }
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new InventoryAvailabilityRuntimeAtpError(
      "INVALID_INVENTORY_ATP_IDENTIFIER",
      `${field} must be a positive PostgreSQL integer.`,
      { field, value },
    );
  }
  return parsed;
}

function uniquePositiveIntegers(values: readonly number[], field: string): number[] {
  if (!Array.isArray(values)) {
    throw new InventoryAvailabilityRuntimeAtpError(
      "INVALID_INVENTORY_ATP_IDENTIFIERS",
      `${field} must be an array of positive PostgreSQL integers.`,
      { field },
    );
  }
  return [...new Set(values.map((value) => positiveInteger(value, field)))].sort((left, right) => left - right);
}

function safeNonnegativeQuantity(value: string, field: string, productVariantId: number): number {
  try {
    const parsed = BigInt(value);
    if (parsed < BigInt(0) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("out of range");
    return Number(parsed);
  } catch (error) {
    throw new InventoryAvailabilityRuntimeAtpError(
      "CANONICAL_ATP_QUANTITY_INVALID",
      `${field} must fit the nonnegative JavaScript safe-integer range.`,
      { field, value, productVariantId },
      { cause: error },
    );
  }
}

function maximumAtpBase(variants: readonly VariantAtp[]): number {
  return variants.reduce((maximum, variant) => Math.max(maximum, variant.atpBase), 0);
}

function unsupportedCanonicalCompatibilityRead(
  code: string,
  message: string,
  context: InventoryAvailabilityRuntimeAtpContext,
  details: Readonly<Record<string, unknown>>,
): InventoryAvailabilityRuntimeAtpError {
  return new InventoryAvailabilityRuntimeAtpError(code, message, {
    ...details,
    authority: context.authority,
    authorityRevision: context.authorityRevision,
    activationRunId: context.activationRunId,
  });
}
