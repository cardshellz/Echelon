import { z } from "zod";

export const walmartIdentifier = z.string().trim().min(1).max(100);
export const walmartVerifiedAccountSchema = z.object({ partnerId: walmartIdentifier, partnerName: z.string().min(1),
  nodes: z.array(z.object({ shipNode: walmartIdentifier, shipNodeName: z.string() })) });
export const walmartKeyInputSchema = z.object({
  clientId: z.string().trim().min(1).max(500).refine(value => !value.includes(":")),
  clientSecret: z.string().min(1).max(2_000).refine(value => value.trim().length > 0),
  environment: z.enum(["production", "sandbox"]),
}).strict();
export const walmartConnectSchema = walmartKeyInputSchema.extend({
  expectedPartnerId: walmartIdentifier,
  shipNodeId: walmartIdentifier,
  warehouseId: z.number().int().positive().max(2_147_483_647),
  importSince: z.string().datetime({ offset: true }),
}).strict();
export const walmartMappingSchema = z.object({
  productVariantId: z.number().int().positive().max(2_147_483_647),
  sku: walmartIdentifier,
}).strict();
export const walmartControlSchema = z.object({
  ordersEnabled: z.boolean(),
  expectedRevision: z.number().int().positive().max(2_147_483_647),
}).strict();
export const walmartStatusSchema = z.object({
  channelId: z.number().int().positive().max(2_147_483_647),
  connectionId: z.number().int().positive().max(2_147_483_647),
  partnerId: walmartIdentifier,
  partnerName: z.string(),
  environment: z.enum(["production", "sandbox"]),
  shipNodeId: walmartIdentifier,
  warehouseId: z.number().int().positive().max(2_147_483_647),
  ordersEnabled: z.boolean(),
  importSince: z.string().datetime(),
  orderSyncBlockedReason: z.string().nullable().optional(),
  lastPollAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  lastErrorCode: z.string().nullable(),
  revision: z.number().int().positive().max(2_147_483_647),
  mappedSkus: z.number().int().nonnegative(),
}).strict();
export type WalmartChannelStatus = z.infer<typeof walmartStatusSchema>;
export type WalmartConnectInput = z.infer<typeof walmartConnectSchema>;
export type WalmartKeyInput = z.infer<typeof walmartKeyInputSchema>;
