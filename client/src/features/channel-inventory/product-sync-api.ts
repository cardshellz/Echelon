import { z } from "zod";
import { productSyncStartSchema, productSyncWorkflowSchema, type ProductSyncStart } from "@shared/types/inventory-product-sync-workflow";
import {
  inventoryProductSyncProgressSchema, inventoryProductSyncRequestSchema, inventoryProductSyncResultSchema,
  inventoryProductSyncReviewRequestSchema, inventoryProductSyncReviewSchema,
  type InventoryProductSyncRequest,
} from "@shared/types/inventory-product-sync";

const ROOT = "/api/inventory-planning/admin/product-sync";

export async function startProductSyncWorkflow(input: ProductSyncStart, actor: string) {
  const command = productSyncStartSchema.parse(input);
  const result = await request("/requests", productSyncWorkflowSchema, command);
  assertWorkflowScope(result, command, actor);
  return result;
}
export async function readProductSyncWorkflow(input: ProductSyncStart, actor: string) {
  const command = productSyncStartSchema.parse(input);
  const result = await request(`/requests/${encodeURIComponent(command.idempotencyKey)}`, productSyncWorkflowSchema);
  assertWorkflowScope(result, command, actor);
  return result;
}
function assertWorkflowScope(result: z.infer<typeof productSyncWorkflowSchema>, command: ProductSyncStart, actor: string) {
  if (result.idempotencyKey !== command.idempotencyKey || result.productId !== command.productId || result.requestedBy !== actor)
    throw new ProductSyncRequestError("The inventory sync status belongs to another request. Retry the saved request.", 502, false);
}

export class ProductSyncRequestError extends Error {
  constructor(message: string, readonly status: number, readonly definitiveRejected: boolean) {
    super(message);
    this.name = "ProductSyncRequestError";
  }
}

async function request<T extends z.ZodTypeAny>(path: string, schema: T, body?: unknown): Promise<z.output<T>> {
  const response = await fetch(ROOT + path, { credentials: "include", ...(body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ error: z.object({ message: z.string(), definitiveRejected: z.boolean().optional() }) }).safeParse(result);
    throw new ProductSyncRequestError(error.success ? error.data.error.message : "The inventory sync response could not be confirmed.",
      response.status, response.status >= 400 && response.status < 500 && error.success && error.data.error.definitiveRejected === true);
  }
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw new ProductSyncRequestError("The inventory sync evidence could not be confirmed. Keep the same request and reload its status.", 502, false);
  return parsed.data;
}

export async function reviewProductSync(productId: number) {
  const selection = inventoryProductSyncReviewRequestSchema.parse({ productId });
  const result = await request("/review", inventoryProductSyncReviewSchema, selection);
  if (result.productId !== productId) throw new ProductSyncRequestError("The inventory review belongs to another product. Reload it before syncing.", 502, false);
  return result;
}

export async function syncProductInventory(input: InventoryProductSyncRequest, actor: string) {
  const command = inventoryProductSyncRequestSchema.parse(input);
  const result = await request("/sync", inventoryProductSyncResultSchema, command);
  if (result.receipt.productId !== command.productId || result.receipt.idempotencyKey !== command.idempotencyKey
    || result.receipt.reviewHash !== command.expectedReviewHash || result.receipt.requestedBy !== actor)
    throw new ProductSyncRequestError("The sync response could not be confirmed. Retry the same request.", 502, false);
  return result;
}

export async function productSyncProgress(command: InventoryProductSyncRequest, actor: string) {
  const parsed = inventoryProductSyncRequestSchema.parse(command);
  const result = await request(`/commands/${encodeURIComponent(parsed.idempotencyKey)}`, inventoryProductSyncProgressSchema);
  if (result.receipt.idempotencyKey !== parsed.idempotencyKey || result.receipt.productId !== parsed.productId
    || result.receipt.reviewHash !== parsed.expectedReviewHash || result.receipt.requestedBy !== actor)
    throw new ProductSyncRequestError("The delivery evidence does not match this inventory sync.", 502, false);
  return result;
}
