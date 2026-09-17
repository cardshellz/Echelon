import { z } from "zod";

export const PICKING_HISTORY_PAGE_SIZE = 50;
export const MAX_PICKING_HISTORY_PAGE_SIZE = 100;
const databaseId = z.number().int().positive().max(2_147_483_647);
const dateText = z.string().datetime();

export const pickingHistoryItemSchema = z.object({
  id: databaseId,
  sku: z.string(),
  name: z.string(),
  quantity: z.number().int(),
  pickedQuantity: z.number().int(),
  status: z.string(),
  pickedAt: dateText.nullable(),
});

export const pickingHistoryOrderSchema = z.object({
  id: databaseId,
  orderNumber: z.string(),
  customerName: z.string(),
  warehouseStatus: z.string(),
  channelName: z.string().nullable(),
  warehouseId: databaseId.nullable(),
  createdAt: dateText,
  completedAt: dateText.nullable(),
  lastPickAt: dateText.nullable(),
  lastPickerName: z.string().nullable(),
  items: z.array(pickingHistoryItemSchema),
});

export const pickingHistoryPageSchema = z.object({
  orders: z.array(pickingHistoryOrderSchema).max(MAX_PICKING_HISTORY_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(MAX_PICKING_HISTORY_PAGE_SIZE),
  offset: z.number().int().nonnegative(),
});
export type PickingHistoryItem = z.infer<typeof pickingHistoryItemSchema>;
export type PickingHistoryOrder = z.infer<typeof pickingHistoryOrderSchema>;
export type PickingHistoryPage = z.infer<typeof pickingHistoryPageSchema>;
