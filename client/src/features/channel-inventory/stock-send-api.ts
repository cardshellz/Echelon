import { z } from "zod";
import {
  inventoryStockSendContextSchema, inventoryStockSendProgressSchema, inventoryStockSendResultSchema, inventoryStockSendReviewSchema,
  matchesStockSendSelection,
  type InventoryStockSendSelection, type InventoryStockSendRequest,
} from "@shared/types/inventory-stock-send";

const root = "/api/inventory-planning/admin/stock-send";
export class StockSendRequestError extends Error {
  constructor(message: string, readonly status: number, readonly definitiveRejected: boolean) { super(message); this.name = "StockSendRequestError"; }
}
async function request<T extends z.ZodTypeAny>(path: string, schema: T, body?: unknown): Promise<z.output<T>> {
  const response = await fetch(root + path, { credentials: "include", ...(body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ error: z.object({ message: z.string(), definitiveRejected: z.boolean().optional() }) }).safeParse(result);
    throw new StockSendRequestError(error.success ? error.data.error.message : "The stock-send response could not be confirmed.",
      response.status, response.status >= 400 && response.status < 500 && error.success && error.data.error.definitiveRejected === true);
  }
  return schema.parse(result);
}
export async function stockSendContext(productId: number, channelId?: number) {
  const result = await request(`/context?productId=${productId}${channelId === undefined ? "" : `&channelId=${channelId}`}`, inventoryStockSendContextSchema);
  if (result.productId !== productId || channelId !== undefined && result.targets.some(target => target.channelId !== channelId))
    throw new StockSendRequestError("The response does not match this product and Shopify channel. Reload its destinations.", 502, false);
  return result;
}
export async function reviewStockSend(selection: InventoryStockSendSelection) {
  const result = await request("/review", inventoryStockSendReviewSchema, selection);
  if (!matchesStockSendSelection(result, selection)) throw new StockSendRequestError("The stock review does not match your selection. Reload it before sending.", 502, false);
  return result;
}
export async function sendStock(command: InventoryStockSendRequest) {
  const result = await request("/send", inventoryStockSendResultSchema, command);
  if (!matchesStockSendSelection(result.receipt, command) || result.receipt.idempotencyKey !== command.idempotencyKey
    || result.receipt.reviewHash !== command.expectedReviewHash)
    throw new StockSendRequestError("The send response could not be confirmed. Retry the same send.", 502, false);
  return result;
}
export async function stockSendProgress(commandKey: string) {
  const result = await request(`/commands/${encodeURIComponent(commandKey)}`, inventoryStockSendProgressSchema);
  if (result.receipt.idempotencyKey !== commandKey) throw new StockSendRequestError("The response does not confirm this stock send.", 502, false);
  return result;
}
