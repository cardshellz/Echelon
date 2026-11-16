import {
  productLocations,
  warehouseLocations,
  warehouses,
  type WarehouseLocation,
} from "@shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

export async function upsertSyncEchelonSettingInWarehouse(
  executor: { execute: (...args: any[]) => any },
  key: string,
  value: string,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO warehouse.echelon_settings (key, value, type, category)
    VALUES (${key}, ${value}, 'string', 'sync')
    ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
  `);
}

export async function deleteProductLocationsByVariantIdInWarehouse(
  executor: { delete: (...args: any[]) => any },
  variantId: number,
): Promise<number> {
  const result = await executor
    .delete(productLocations)
    .where(eq(productLocations.productVariantId, variantId))
    .returning({ id: productLocations.id });
  return result.length;
}

export async function updateProductLocationsSkuByVariantIdInWarehouse(
  executor: { update: (...args: any[]) => any },
  variantId: number,
  newSku: string,
  now: Date = new Date(),
): Promise<void> {
  await executor
    .update(productLocations)
    .set({ sku: newSku, updatedAt: now })
    .where(eq(productLocations.productVariantId, variantId));
}

export async function reassignProductLocationsToVariantInWarehouse(
  executor: { update: (...args: any[]) => any },
  sourceVariantId: number,
  targetVariantId: number,
  now: Date = new Date(),
): Promise<number> {
  const result = await executor
    .update(productLocations)
    .set({ productVariantId: targetVariantId, updatedAt: now })
    .where(eq(productLocations.productVariantId, sourceVariantId))
    .returning({ id: productLocations.id });
  return result.length;
}

export async function mergeVariantProductLocationsInTx(
  tx: { delete: (...args: any[]) => any; update: (...args: any[]) => any },
  input: {
    sourceVariantId: number;
    targetVariantId: number;
    targetProductId: number;
    targetSku: string | null;
    occupiedLocationIds: number[];
    now: Date;
  },
): Promise<number> {
  if (input.occupiedLocationIds.length > 0) {
    await tx
      .delete(productLocations)
      .where(
        and(
          eq(productLocations.productVariantId, input.sourceVariantId),
          inArray(productLocations.warehouseLocationId, input.occupiedLocationIds),
        ),
      );
  }
  const moved = await tx
    .update(productLocations)
    .set({
      productVariantId: input.targetVariantId,
      productId: input.targetProductId,
      sku: input.targetSku,
      updatedAt: input.now,
    })
    .where(eq(productLocations.productVariantId, input.sourceVariantId))
    .returning({ id: productLocations.id });
  return moved.length;
}

export async function deleteProductLocationsBySkusInTx(
  tx: { delete: (...args: any[]) => any },
  skus: string[],
): Promise<number> {
  if (skus.length === 0) return 0;
  const removed = await tx
    .delete(productLocations)
    .where(inArray(productLocations.sku, skus))
    .returning({ id: productLocations.id });
  return removed.length;
}

export async function updateAutoFixedPickProductLocationInTx(
  tx: { update: (...args: any[]) => any },
  existingId: number,
  input: {
    productVariantId: number;
    productId: number;
    sku: string;
    name: string;
    location: string;
    zone: string;
  },
): Promise<void> {
  await tx
    .update(productLocations)
    .set({
      productVariantId: input.productVariantId,
      productId: input.productId,
      sku: input.sku,
      name: input.name,
      location: input.location,
      zone: input.zone,
      isPrimary: 1,
      status: "active",
      updatedAt: new Date(),
    })
    .where(eq(productLocations.id, existingId));
}

export async function insertAutoFixedPickProductLocationInTx(
  tx: { insert: (...args: any[]) => any },
  input: {
    productId: number;
    productVariantId: number;
    sku: string;
    name: string;
    location: string;
    zone: string;
    warehouseLocationId: number;
    imageUrl: string | null;
    barcode: string | null;
  },
): Promise<void> {
  await tx.insert(productLocations).values({
    productId: input.productId,
    productVariantId: input.productVariantId,
    sku: input.sku,
    name: input.name,
    location: input.location,
    zone: input.zone,
    warehouseLocationId: input.warehouseLocationId,
    isPrimary: 1,
    status: "active",
    imageUrl: input.imageUrl,
    barcode: input.barcode,
  });
}

export async function seedSampleProductLocationsInWarehouse(
  executor: { insert: (...args: any[]) => any },
  locations: ReadonlyArray<{ sku: string; name: string; location: string; zone: string }>,
): Promise<void> {
  for (const loc of locations) {
    await executor.insert(productLocations).values(loc).onConflictDoNothing();
  }
}

export async function insertBackfillDefaultWarehouseLocationInWarehouse(
  executor: { insert: (...args: any[]) => any },
  warehouseId: number,
): Promise<WarehouseLocation> {
  const [newLocation] = await executor
    .insert(warehouseLocations)
    .values({
      warehouseId,
      code: "BACKFILL-DEFAULT",
      name: "Backfill Default Location",
      locationType: "pick",
      isActive: 1,
    })
    .returning();
  return newLocation;
}

export async function unfreezeWarehouseLocationsForCycleCountInWarehouse(
  executor: { execute: (...args: any[]) => any },
  cycleCountId: number,
): Promise<void> {
  await executor.execute(sql`
    UPDATE warehouse.warehouse_locations
    SET cycle_count_freeze_id = NULL, updated_at = NOW()
    WHERE cycle_count_freeze_id = ${cycleCountId}
  `);
}

export async function freezeWarehouseLocationsChunkForCycleCountInWarehouse(
  executor: { execute: (...args: any[]) => any },
  cycleCountId: number,
  chunkLocationIds: number[],
): Promise<void> {
  await executor.execute(sql`
    UPDATE warehouse.warehouse_locations
    SET cycle_count_freeze_id = ${cycleCountId}, updated_at = NOW()
    WHERE id IN (${sql.join(chunkLocationIds.map((cid: number) => sql`${cid}`), sql`, `)})
      AND cycle_count_freeze_id IS NULL
  `);
}

export async function releaseStaleCycleCountLocationFreezesInWarehouse(
  executor: { execute: (...args: any[]) => any },
  cycleCountIds: readonly unknown[],
): Promise<void> {
  const idList = sql.raw(cycleCountIds.join(","));
  await executor.execute(sql`
    UPDATE warehouse.warehouse_locations
    SET cycle_count_freeze_id = NULL, updated_at = NOW()
    WHERE cycle_count_freeze_id IN (${idList})
  `);
}

export async function insertVirtual3plWarehouseLocationInWarehouse(
  executor: { insert: (...args: any[]) => any },
  input: {
    warehouseId: number;
    code: string;
    name: string;
  },
): Promise<WarehouseLocation> {
  const [createdLoc] = await executor
    .insert(warehouseLocations)
    .values({
      warehouseId: input.warehouseId,
      code: input.code,
      name: input.name,
      locationType: "3pl_virtual",
      binType: "floor",
      isPickable: 0,
    })
    .returning();
  return createdLoc;
}

export async function updateWarehouseFeedEnabledInWarehouse(
  executor: { update: (...args: any[]) => any },
  warehouseId: number,
  feedEnabled: boolean,
): Promise<void> {
  await executor
    .update(warehouses)
    .set({ feedEnabled, updatedAt: new Date() })
    .where(eq(warehouses.id, warehouseId));
}

export async function updateWarehouseInventorySyncStatusInWarehouse(
  executor: { update: (...args: any[]) => any },
  warehouseId: number,
  status: "syncing" | "ok" | "error",
  options?: { lastInventorySyncAt?: Date },
): Promise<void> {
  const patch: Record<string, unknown> = {
    inventorySyncStatus: status,
    updatedAt: new Date(),
  };
  if (options?.lastInventorySyncAt !== undefined) {
    patch.lastInventorySyncAt = options.lastInventorySyncAt;
  }
  await executor.update(warehouses).set(patch).where(eq(warehouses.id, warehouseId));
}
