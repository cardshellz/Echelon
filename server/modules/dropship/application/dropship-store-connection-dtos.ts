import { z } from "zod";
import { dropshipSupportedStorePlatforms } from "../domain/store-connection";

export const dropshipStoreConnectionLifecycleStatusSchema = z.enum([
  "connected",
  "needs_reauth",
  "refresh_failed",
  "grace_period",
  "paused",
  "disconnected",
]);

export const startDropshipStoreConnectionOAuthInputSchema = z.object({
  platform: z.enum(dropshipSupportedStorePlatforms),
  shopDomain: z.string().trim().min(1).max(255).optional(),
  returnTo: z.string().trim().max(500).optional(),
});

export type StartDropshipStoreConnectionOAuthInput = z.infer<
  typeof startDropshipStoreConnectionOAuthInputSchema
>;

export const completeDropshipStoreConnectionOAuthInputSchema = z.object({
  platform: z.enum(dropshipSupportedStorePlatforms).optional(),
  code: z.string().trim().min(1).max(4096).optional(),
  state: z.string().trim().min(1).max(4096),
  error: z.string().trim().max(500).optional(),
  shop: z.string().trim().max(255).optional(),
  hmac: z.string().trim().max(255).optional(),
});

export type CompleteDropshipStoreConnectionOAuthInput = z.infer<
  typeof completeDropshipStoreConnectionOAuthInputSchema
>;

export const disconnectDropshipStoreConnectionInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  confirmed: z.literal(true),
  idempotencyKey: z.string().trim().min(8).max(200),
});

export type DisconnectDropshipStoreConnectionInput = z.infer<
  typeof disconnectDropshipStoreConnectionInputSchema
>;

export const listDropshipAdminStoreConnectionsInputSchema = z.object({
  statuses: z.array(dropshipStoreConnectionLifecycleStatusSchema).min(1).max(6).optional(),
  platform: z.enum(dropshipSupportedStorePlatforms).optional(),
  vendorId: z.number().int().positive().optional(),
  search: z.string().trim().min(1).max(255).optional(),
  page: z.number().int().positive().max(10_000).default(1),
  limit: z.number().int().positive().max(200).default(50),
}).strict();

export type ListDropshipAdminStoreConnectionsInput = z.infer<
  typeof listDropshipAdminStoreConnectionsInputSchema
>;

export const updateDropshipStoreOrderProcessingConfigInputSchema = z.object({
  defaultWarehouseId: z.number().int().positive().nullable(),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export type UpdateDropshipStoreOrderProcessingConfigInput = z.infer<
  typeof updateDropshipStoreOrderProcessingConfigInputSchema
>;
