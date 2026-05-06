import { z } from "zod";
import {
  CentsSchema,
  CurrencyCodeSchema,
  PositiveCentsSchema,
} from "../../../../shared/validation/currency";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const platformSchema = z.enum(["ebay", "shopify"]);
const jsonObjectSchema = z.record(z.unknown());
const actorSchema = z.object({
  actorType: z.enum(["vendor", "admin", "system", "job"]),
  actorId: z.string().trim().min(1).max(255).optional(),
}).strict();

const productVariantQuantitySchema = z.object({
  productVariantId: positiveIdSchema,
  quantity: z.number().int().positive(),
}).strict();

const destinationAddressSchema = z.object({
  country: z.string().trim().length(2),
  region: z.string().trim().min(1).max(100).optional(),
  postalCode: z.string().trim().min(1).max(20),
}).strict();

export const generateVendorListingPreviewInputSchema = z.object({
  vendorId: positiveIdSchema,
  storeConnectionId: positiveIdSchema,
  productVariantIds: z.array(positiveIdSchema).min(1).max(500),
  requestedRetailPriceCents: CentsSchema.optional(),
  actor: actorSchema,
}).strict();

export const createListingPushJobInputSchema = z.object({
  vendorId: positiveIdSchema,
  storeConnectionId: positiveIdSchema,
  productVariantIds: z.array(positiveIdSchema).min(1).max(500),
  idempotencyKey: idempotencyKeySchema,
  requestedBy: actorSchema,
}).strict();

export const processListingPushJobInputSchema = z.object({
  jobId: positiveIdSchema,
  workerId: z.string().trim().min(1).max(255),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const recordMarketplaceOrderIntakeInputSchema = z.object({
  vendorId: positiveIdSchema,
  storeConnectionId: positiveIdSchema,
  platform: platformSchema,
  externalOrderId: z.string().trim().min(1).max(255),
  externalOrderNumber: z.string().trim().min(1).max(100).optional(),
  rawPayload: jsonObjectSchema,
  payloadHash: z.string().trim().min(16).max(128),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const acceptDropshipOrderInputSchema = z.object({
  intakeId: positiveIdSchema,
  vendorId: positiveIdSchema,
  storeConnectionId: positiveIdSchema,
  shippingQuoteSnapshotId: positiveIdSchema,
  idempotencyKey: idempotencyKeySchema,
  actor: actorSchema,
}).strict();

export const rejectDropshipOrderInputSchema = z.object({
  intakeId: positiveIdSchema,
  vendorId: positiveIdSchema,
  reason: z.string().trim().min(3).max(1000),
  idempotencyKey: idempotencyKeySchema,
  actor: actorSchema,
}).strict();

export const quoteDropshipShippingInputSchema = z.object({
  vendorId: positiveIdSchema,
  storeConnectionId: positiveIdSchema,
  warehouseId: positiveIdSchema,
  destination: destinationAddressSchema,
  items: z.array(productVariantQuantitySchema).min(1).max(200),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const creditWalletFundingInputSchema = z.object({
  vendorId: positiveIdSchema,
  walletAccountId: positiveIdSchema,
  fundingMethodId: positiveIdSchema.optional(),
  amountCents: PositiveCentsSchema,
  currency: CurrencyCodeSchema.default("USD"),
  referenceType: z.string().trim().min(1).max(80),
  referenceId: z.string().trim().min(1).max(255),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const debitWalletForOrderInputSchema = z.object({
  vendorId: positiveIdSchema,
  walletAccountId: positiveIdSchema,
  intakeId: positiveIdSchema,
  amountCents: PositiveCentsSchema,
  currency: CurrencyCodeSchema.default("USD"),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const handleAutoReloadInputSchema = z.object({
  vendorId: positiveIdSchema,
  walletAccountId: positiveIdSchema,
  reason: z.enum(["minimum_balance", "payment_hold"]),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const refreshStoreTokenInputSchema = z.object({
  storeConnectionId: positiveIdSchema,
  idempotencyKey: idempotencyKeySchema,
  actor: actorSchema,
}).strict();

export const pushTrackingToVendorStoreInputSchema = z.object({
  vendorId: positiveIdSchema,
  storeConnectionId: positiveIdSchema,
  intakeId: positiveIdSchema,
  carrier: z.string().trim().min(1).max(80),
  trackingNumber: z.string().trim().min(1).max(120),
  shippedAt: z.date(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const processReturnInspectionInputSchema = z.object({
  rmaId: positiveIdSchema,
  inspectorId: z.string().trim().min(1).max(255),
  outcome: z.enum(["approved", "rejected"]),
  faultCategory: z.enum(["card_shellz", "vendor", "customer", "marketplace", "carrier"]),
  creditCents: CentsSchema,
  feeCents: CentsSchema,
  notes: z.string().trim().max(2000).optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const sendDropshipNotificationInputSchema = z.object({
  vendorId: positiveIdSchema,
  eventType: z.string().trim().min(1).max(100),
  critical: z.boolean(),
  channels: z.array(z.enum(["email", "in_app", "sms", "webhook"])).min(1),
  title: z.string().trim().min(1).max(300),
  message: z.string().trim().max(4000).optional(),
  payload: jsonObjectSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export type GenerateVendorListingPreviewInput = z.infer<typeof generateVendorListingPreviewInputSchema>;
export type CreateListingPushJobInput = z.infer<typeof createListingPushJobInputSchema>;
export type ProcessListingPushJobInput = z.infer<typeof processListingPushJobInputSchema>;
export type RecordMarketplaceOrderIntakeInput = z.infer<typeof recordMarketplaceOrderIntakeInputSchema>;
export type AcceptDropshipOrderInput = z.infer<typeof acceptDropshipOrderInputSchema>;
export type RejectDropshipOrderInput = z.infer<typeof rejectDropshipOrderInputSchema>;
export type QuoteDropshipShippingInput = z.infer<typeof quoteDropshipShippingInputSchema>;
export type CreditWalletFundingInput = z.infer<typeof creditWalletFundingInputSchema>;
export type DebitWalletForOrderInput = z.infer<typeof debitWalletForOrderInputSchema>;
export type HandleAutoReloadInput = z.infer<typeof handleAutoReloadInputSchema>;
export type RefreshStoreTokenInput = z.infer<typeof refreshStoreTokenInputSchema>;
export type PushTrackingToVendorStoreInput = z.infer<typeof pushTrackingToVendorStoreInputSchema>;
export type ProcessReturnInspectionInput = z.infer<typeof processReturnInspectionInputSchema>;
export type SendDropshipNotificationInput = z.infer<typeof sendDropshipNotificationInputSchema>;
