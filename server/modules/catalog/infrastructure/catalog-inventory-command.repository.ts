import { and, asc, eq, inArray } from "drizzle-orm";
import type { db as applicationDatabase } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import { channelFeeds, inventoryLevels, productLocations, products, productVariants } from "@shared/schema";
import {
  archiveProductReplenishmentInTx,
  lockInventoryCostGraph,
  openOperationalQuantityPosting,
  type InventoryUseCases,
} from "../../inventory/catalog-inventory.api";
import { deactivateActiveChannelFeedsByVariantIdInChannels } from "../../channels/channel-feed-listing-mutations.api";
import { deleteZeroInventoryLevelsByVariantIdInTx } from "../../inventory/cross-module-inventory-mutations.api";
import {
  deleteProductLocationsByVariantIdInWarehouse,
  reassignProductLocationsToVariantInWarehouse,
} from "../../warehouse/cross-module-warehouse-mutations.api";
import { CatalogInventoryCommandError, CatalogInventoryCommandService,
  type CatalogInventoryCommandRepository, type CatalogInventoryUnitOfWork } from "../application/catalog-inventory-command.service";

export class PostgresCatalogInventoryCommandRepository implements CatalogInventoryCommandRepository {
  constructor(private readonly database: typeof applicationDatabase, private readonly inventory: InventoryUseCases) {}

  async transaction<T>(work: (unit: CatalogInventoryUnitOfWork) => Promise<T>): Promise<T> {
    return this.database.transaction(async tx => {
      const posting = await openOperationalQuantityPosting(tx);
      const inventory = this.inventory.withTx(tx);
      return work({
        posting,
        async loadSource(command) {
          // Match every cost owner: graph lock precedes catalog and level locks.
          // Parent product lock also fences concurrent FK-linked variant adds.
          await lockInventoryCostGraph(tx);
          const sourceTable = command.operation === "product_archive" ? products : productVariants;
          const [source] = await tx.select({ id: sourceTable.id, sku: sourceTable.sku, name: sourceTable.name })
            .from(sourceTable).where(eq(sourceTable.id, command.sourceId)).for("update");
          if (!source) throw new CatalogInventoryCommandError("CATALOG_SOURCE_MISSING", "Source product or variant not found", 404);
          const variants = command.operation === "product_archive"
            ? await tx.select({ id: productVariants.id }).from(productVariants)
              .where(eq(productVariants.productId, command.sourceId)).orderBy(asc(productVariants.id)).for("update")
            : [{ id: source.id }];
          if (command.targetVariantId !== null) {
            const [target] = await tx.select({ active: productVariants.isActive }).from(productVariants)
              .where(eq(productVariants.id, command.targetVariantId)).for("update");
            if (!target?.active) throw new CatalogInventoryCommandError("CATALOG_TARGET_INVALID", "Target variant not found or inactive", 400);
          }
          return { source, sourceVariantIds: variants.map(variant => variant.id) };
        },
        async lockQuantities(ids) {
          if (ids.length === 0) return [];
          return tx.select({ productVariantId: inventoryLevels.productVariantId, onHand: inventoryLevels.variantQty,
            reserved: inventoryLevels.reservedQty, picked: inventoryLevels.pickedQty, packed: inventoryLevels.packedQty })
            .from(inventoryLevels).where(inArray(inventoryLevels.productVariantId, [...new Set(ids)]))
            .orderBy(asc(inventoryLevels.warehouseLocationId), asc(inventoryLevels.productVariantId), asc(inventoryLevels.id)).for("update");
        },
        convert(sourceId, targetId, childKey, actor, deferUntilCommit) {
          return inventory.convertSku({ fromVariantId: sourceId, toVariantId: targetId, commandKey: childKey,
            notes: `Catalog SKU correction: ${sourceId} to ${targetId}`, userId: actor, deferUntilCommit }, posting ?? undefined);
        },
        async applyMetadata(command, sourceVariantIds, now) {
          const result = { inventoryCleared: 0, binAssignmentsCleared: 0, channelFeedsDeactivated: 0,
            replenDeactivated: 0, replenTasksCancelled: 0, movedLocationCount: 0 };
          for (const sourceId of sourceVariantIds) {
            if (command.operation === "variant_merge") {
              result.movedLocationCount += await reassignProductLocationsToVariantInWarehouse(
                tx,
                sourceId,
                command.targetVariantId!,
                now,
              );
            } else {
              if (command.targetVariantId !== null) {
                // Every ledger-era zero projection retains its historical identity.
                if (!posting) result.inventoryCleared += await deleteZeroInventoryLevelsByVariantIdInTx(tx, sourceId);
                result.binAssignmentsCleared += await deleteProductLocationsByVariantIdInWarehouse(tx, sourceId);
              }
              // is_active triggers retain listing identity and enqueue publication.
              result.channelFeedsDeactivated += await deactivateActiveChannelFeedsByVariantIdInChannels(tx, sourceId, now);
            }
            await tx.update(productVariants).set({ isActive: false, updatedAt: now }).where(eq(productVariants.id, sourceId));
          }
          if (command.operation === "product_archive") {
            const replen = await archiveProductReplenishmentInTx(tx, command.sourceId, now);
            result.replenDeactivated = replen.replenDeactivated;
            result.replenTasksCancelled = replen.replenTasksCancelled;
            await tx.update(products).set({ isActive: false, status: "archived", updatedAt: now }).where(eq(products.id, command.sourceId));
          }
          return result;
        },
        async recordAudit(command, evidence, now) {
          // No-movement commands have no quantity journal actor. Preserve the
          // complete caller intent and inspected source evidence transactionally.
          await persistAuditEvent(tx, { actor: command.actor, action: "catalog_inventory_command",
            target: `${command.operation}:${command.sourceId}`, context: { intent: command, ...evidence } },
          { timestamp: now, emitStructuredLog: false });
        },
      });
    });
  }
}

export function createCatalogInventoryCommandService(database: typeof applicationDatabase, inventory: InventoryUseCases) {
  return new CatalogInventoryCommandService(new PostgresCatalogInventoryCommandRepository(database, inventory),
    () => new Date(), error => console.error("[CatalogInventory] Committed command notification failed", error));
}
