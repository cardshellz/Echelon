import { z } from "zod";
import { dropshipSupportedStorePlatforms } from "../domain/store-connection";

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
