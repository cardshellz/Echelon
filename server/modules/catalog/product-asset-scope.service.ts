import { catalogPhotoIdSchema, productAssetScopeSchema, productAssetScopeResultSchema } from "@shared/catalog/product-asset-scope";
import type { db } from "../../db";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { runTransactionalFinancialCommand, type FinancialCommandDescriptor,
  type FinancialCommandFailureDisposition } from "../../platform/commands/transactional-command.service";
import { ProductAssetError } from "./product-asset-errors";
import { changeProductAssetScope } from "./product-asset-scope.repository";

export function classifyProductAssetScopeFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof ProductAssetError) return {
    kind: "rejected", httpStatus: error.status, errorCode: error.code, errorMessage: error.message,
    body: { code: error.code, error: error.message },
  };
  return { kind: "retryable", errorCode: "ASSET_SCOPE_SAVE_FAILED",
    errorMessage: "The photo assignment did not commit. Retry the same change." };
}

/** Reuses the platform command ledger: assignment, audit and replay receipt commit together. */
export function createProductAssetScopeService(database: Pick<typeof db, "transaction">, clock: () => Date) {
  const repository = createDrizzleFinancialCommandRepository(database);
  return {
    async apply(productId: number, assetId: number, input: unknown, descriptor: FinancialCommandDescriptor) {
      const parsed = productAssetScopeSchema.safeParse(input);
      if (!catalogPhotoIdSchema.safeParse(productId).success || !catalogPhotoIdSchema.safeParse(assetId).success || !parsed.success) {
        throw new ProductAssetError("ASSET_SCOPE_INVALID", "Provide a valid photo assignment and its previous assignment.", 400);
      }
      const command = parsed.data;
      return runTransactionalFinancialCommand({
        repository, descriptor, classifyFailure: classifyProductAssetScopeFailure,
        work: async tx => {
          const result = productAssetScopeResultSchema.parse(await changeProductAssetScope(tx, productId, assetId, command));
          if (result.changed) await persistAuditEvent(tx, {
            actor: `${descriptor.actorType}:${descriptor.actorId}`,
            action: "catalog.asset.scope_changed", target: `catalog.product_assets:${assetId}`,
            changes: { before: { productId, productVariantId: command.expectedProductVariantId },
              after: { productId, productVariantId: command.productVariantId } },
            context: { assetId, idempotencyKey: descriptor.idempotencyKey },
          }, { timestamp: clock(), emitStructuredLog: false });
          return { httpStatus: 200, body: result, resultType: "catalog.product_asset", resultId: assetId };
        },
      });
    },
  };
}
