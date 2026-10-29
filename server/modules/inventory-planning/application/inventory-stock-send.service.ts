import { z } from "zod";
import {
  inventoryStockSendContextRequestSchema, inventoryStockSendContextSchema, inventoryStockSendSelectionSchema,
  inventoryStockSendRequestSchema, inventoryStockSendReviewSchema, inventoryStockSendResultSchema, inventoryStockSendProgressSchema,
  matchesStockSendSelection,
  type InventoryStockSendContextRequest, type InventoryStockSendContext, type InventoryStockSendSelection,
  type InventoryStockSendRequest, type InventoryStockSendReview, type InventoryStockSendResult, type InventoryStockSendProgress,
} from "@shared/types/inventory-stock-send";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";

export class InventoryStockSendError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = "InventoryStockSendError"; }
}
export interface InventoryStockSendStore {
  context(input: InventoryStockSendContextRequest): Promise<InventoryStockSendContext>;
  review(selection: InventoryStockSendSelection): Promise<InventoryStockSendReview>;
  send(command: InventoryStockSendRequest, actor: string, requestHash: string, now: Date): Promise<InventoryStockSendResult>;
  progress(commandKey: string): Promise<InventoryStockSendProgress>;
}

/** Selects inventory work only. The canonical publisher owns quantities and the
 * existing outbox worker owns provider delivery and readback verification. */
export class InventoryStockSendService {
  constructor(private readonly store: InventoryStockSendStore, private readonly clock: () => Date = () => new Date()) {}
  async context(input: unknown): Promise<InventoryStockSendContext> {
    const request = inventoryStockSendContextRequestSchema.parse(input);
    const result = await validatedOutput(inventoryStockSendContextSchema, this.store.context(request));
    if (result.productId !== request.productId || request.channelId !== undefined && result.targets.some(target => target.channelId !== request.channelId))
      throw new InventoryStockSendError("STOCK_SEND_CONTEXT_INVALID", "Stock destinations do not match the requested product and channel.", 500);
    return result;
  }
  async review(input: unknown): Promise<InventoryStockSendReview> {
    const selection = normalizedSelection(input);
    const result = await validatedOutput(inventoryStockSendReviewSchema, this.store.review(selection));
    if (!matchesStockSendSelection(result, selection)) throw new InventoryStockSendError("STOCK_SEND_REVIEW_INVALID", "The stock review does not match the requested selection.", 500);
    return result;
  }
  async send(input: unknown, actorInput: unknown): Promise<InventoryStockSendResult> {
    const parsed = inventoryStockSendRequestSchema.parse(input);
    const command = { ...parsed, ...normalizedSelection({ productId: parsed.productId,
      publicationTargetId: parsed.publicationTargetId, productVariantIds: parsed.productVariantIds }) };
    const actor = z.string().trim().min(1).max(100).parse(actorInput);
    const now = z.date().parse(this.clock());
    const result = await validatedOutput(inventoryStockSendResultSchema, this.store.send(command, actor,
      inventoryCutoverEvidenceHash({ contract: "inventory_stock_send_v1", command, actor }), now));
    const receipt = result.receipt;
    if (!matchesStockSendSelection(receipt, command)
      || receipt.idempotencyKey !== command.idempotencyKey || receipt.reviewHash !== command.expectedReviewHash || receipt.requestedBy !== actor)
      throw new InventoryStockSendError("STOCK_SEND_RECEIPT_INVALID", "The recorded send does not match this request. Retry the same command to recover its result.", 500);
    return result;
  }
  async progress(commandKey: unknown): Promise<InventoryStockSendProgress> {
    const key = z.string().uuid().parse(commandKey);
    const result = await validatedOutput(inventoryStockSendProgressSchema, this.store.progress(key));
    if (result.receipt.idempotencyKey !== key) throw new InventoryStockSendError("STOCK_SEND_EVIDENCE_INVALID", "The delivery evidence belongs to another stock send.", 500);
    return result;
  }
}

async function validatedOutput<T extends z.ZodTypeAny>(schema: T, output: Promise<unknown>): Promise<z.output<T>> {
  try { return schema.parse(await output); }
  catch (error) {
    // Output may be a saved receipt from an already committed command. Never
    // classify damaged evidence as a rejected input and discard its retry key.
    if (error instanceof z.ZodError) throw new InventoryStockSendError("STOCK_SEND_EVIDENCE_INVALID",
      "The recorded stock-send evidence could not be confirmed. Keep the same send key and reload its status.", 500);
    throw error;
  }
}

function normalizedSelection(input: unknown): InventoryStockSendSelection {
  const selection = inventoryStockSendSelectionSchema.parse(input);
  return { ...selection, productVariantIds: [...selection.productVariantIds].sort((left, right) => left - right) };
}
