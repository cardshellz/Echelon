import { z } from "zod";
import {
  inventoryProductSyncReviewRequestSchema, inventoryProductSyncRequestSchema, inventoryProductSyncReviewSchema,
  inventoryProductSyncResultSchema, inventoryProductSyncProgressSchema,
  type InventoryProductSyncReviewRequest, type InventoryProductSyncRequest, type InventoryProductSyncReview,
  type InventoryProductSyncResult, type InventoryProductSyncProgress,
} from "@shared/types/inventory-product-sync";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";

export class InventoryProductSyncError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = "InventoryProductSyncError"; }
}
export interface InventoryProductSyncStore {
  review(input: InventoryProductSyncReviewRequest): Promise<InventoryProductSyncReview>;
  sync(command: InventoryProductSyncRequest, actor: string, requestHash: string, now: Date): Promise<InventoryProductSyncResult>;
  progress(commandKey: string): Promise<InventoryProductSyncProgress>;
}

/** An operator selects one product. ATP and its existing publication owners
 * determine every destination, quantity and delivery; callers cannot supply them. */
export class InventoryProductSyncService {
  constructor(private readonly store: InventoryProductSyncStore, private readonly clock: () => Date = () => new Date()) {}
  async review(input: unknown): Promise<InventoryProductSyncReview> {
    const request = inventoryProductSyncReviewRequestSchema.parse(input);
    const result = await validatedOutput(inventoryProductSyncReviewSchema, this.store.review(request));
    if (result.productId !== request.productId) throw new InventoryProductSyncError("PRODUCT_SYNC_REVIEW_INVALID", "The ATP review belongs to another product.", 500);
    return result;
  }
  async sync(input: unknown, actorInput: unknown): Promise<InventoryProductSyncResult> {
    const command = inventoryProductSyncRequestSchema.parse(input);
    const actor = z.string().trim().min(1).max(100).parse(actorInput);
    const now = z.date().parse(this.clock());
    const result = await validatedOutput(inventoryProductSyncResultSchema, this.store.sync(command, actor,
      inventoryCutoverEvidenceHash({ contract: "inventory_product_sync_v1", command, actor }), now));
    const receipt = result.receipt;
    if (receipt.productId !== command.productId || receipt.idempotencyKey !== command.idempotencyKey
      || receipt.reviewHash !== command.expectedReviewHash || receipt.requestedBy !== actor)
      throw new InventoryProductSyncError("PRODUCT_SYNC_RECEIPT_INVALID", "The recorded sync does not match this request. Retry the same command to recover its result.", 500);
    return result;
  }
  async progress(commandKey: unknown): Promise<InventoryProductSyncProgress> {
    const key = z.string().uuid().parse(commandKey);
    const result = await validatedOutput(inventoryProductSyncProgressSchema, this.store.progress(key));
    if (result.receipt.idempotencyKey !== key) throw new InventoryProductSyncError("PRODUCT_SYNC_EVIDENCE_INVALID", "The delivery evidence belongs to another sync.", 500);
    return result;
  }
}

async function validatedOutput<T extends z.ZodTypeAny>(schema: T, output: Promise<unknown>): Promise<z.output<T>> {
  try { return schema.parse(await output); }
  catch (error) {
    if (error instanceof z.ZodError) throw new InventoryProductSyncError("PRODUCT_SYNC_EVIDENCE_INVALID",
      "The recorded ATP sync evidence could not be confirmed. Keep the same sync key and reload its status.", 500);
    throw error;
  }
}
