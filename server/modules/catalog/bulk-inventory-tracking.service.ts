import {
  bulkInventoryTrackingApplySchema, bulkInventoryTrackingRequestSchema,
  bulkInventoryTrackingResultSchema, type BulkInventoryTrackingPreview,
} from "@shared/catalog/bulk-inventory-tracking";
import { db } from "../../db";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { runTransactionalFinancialCommand, type FinancialCommandDescriptor,
  type FinancialCommandFailureDisposition } from "../../platform/commands/transactional-command.service";
import { buildBulkInventoryTrackingPreview } from "./bulk-inventory-tracking.domain";
import { loadBulkInventoryTrackingSelection, type InventoryTrackingTransaction } from "./bulk-inventory-tracking.repository";
import { InventoryTrackingPolicyError, updateProductInventoryTracking } from "./inventory-tracking-policy.repository";

export class BulkInventoryTrackingError extends InventoryTrackingPolicyError {
  constructor(code: string, message: string, readonly context?: Record<string, unknown>) {
    super(code, message, 409);
  }
}

export function classifyBulkInventoryTrackingFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof InventoryTrackingPolicyError) return {
    kind: "rejected", httpStatus: error.statusCode, errorCode: error.code, errorMessage: error.message,
    body: { error: error.message, code: error.code,
      ...(error instanceof BulkInventoryTrackingError ? { context: error.context } : {}) },
  };
  return { kind: "retryable", errorCode: "BULK_INVENTORY_TRACKING_FAILED",
    errorMessage: "The inventory tracking batch did not commit. Retry the same request." };
}

export function createBulkInventoryTrackingService(database: typeof db = db, clock: () => Date = () => new Date()) {
  const commandRepository = createDrizzleFinancialCommandRepository(database);
  async function previewInTransaction(tx: InventoryTrackingTransaction, input: unknown): Promise<BulkInventoryTrackingPreview> {
    const request = bulkInventoryTrackingRequestSchema.parse(input);
    return buildBulkInventoryTrackingPreview(
      await loadBulkInventoryTrackingSelection(tx, request.productIds, request.inventoryTrackingDefault),
      request.inventoryTrackingDefault,
    );
  }
  return {
    async preview(input: unknown): Promise<BulkInventoryTrackingPreview> {
      return database.transaction(tx => previewInTransaction(tx, input));
    },
    async apply(input: unknown, descriptor: FinancialCommandDescriptor) {
      const { expectedPreviewHash, ...request } = bulkInventoryTrackingApplySchema.parse(input);
      return runTransactionalFinancialCommand({
        repository: commandRepository, descriptor, classifyFailure: classifyBulkInventoryTrackingFailure,
        work: async tx => {
          const preview = await previewInTransaction(tx, request);
          if (preview.previewHash !== expectedPreviewHash) throw new BulkInventoryTrackingError(
            "BULK_INVENTORY_PREVIEW_STALE", "Products or their inventory dependencies changed. Review this selection again.",
          );
          const blocked = preview.products.filter(product => product.status === "blocked");
          if (blocked.length) throw new BulkInventoryTrackingError("BULK_INVENTORY_TRACKING_BLOCKED",
            "No products were changed. Resolve the blockers or remove those products from the selection.",
            { products: blocked });
          const changed = preview.products.filter(product => product.status === "change");
          const actor = `${descriptor.actorType}:${descriptor.actorId}`;
          const now = clock();
          for (const product of changed) {
            await updateProductInventoryTracking(tx, product.productId, request.inventoryTrackingDefault, actor, now);
          }
          const result = bulkInventoryTrackingResultSchema.parse({
            inventoryTrackingDefault: request.inventoryTrackingDefault,
            changedProductIds: changed.map(product => product.productId),
            unchangedProductIds: preview.products.filter(product => product.status === "unchanged").map(product => product.productId),
            changingVariantCount: preview.products.reduce((sum, product) => sum + product.changingVariantCount, 0),
            trackedOverrideCount: preview.products.reduce((sum, product) => sum + product.trackedOverrideCount, 0),
            untrackedOverrideCount: preview.products.reduce((sum, product) => sum + product.untrackedOverrideCount, 0),
          });
          if (changed.length > 0) await persistAuditEvent(tx, {
            actor, action: "catalog.inventory_tracking_bulk.changed", target: "catalog.products.inventory_tracking_default",
            changes: { before: { products: changed.map(product => ({ productId: product.productId, inventoryTrackingDefault: product.currentDefault })) },
              after: { productIds: result.changedProductIds, inventoryTrackingDefault: result.inventoryTrackingDefault } },
            context: { previewHash: expectedPreviewHash, idempotencyKey: descriptor.idempotencyKey,
              trackedOverrideCount: result.trackedOverrideCount, untrackedOverrideCount: result.untrackedOverrideCount },
          }, { timestamp: now });
          return { httpStatus: 200, body: result };
        },
      });
    },
  };
}
