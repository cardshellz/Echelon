import { z } from "zod";
import { customerReturnShippingGuardrailsSchema } from "./customer-return-shipping-guardrails";
import { customerReturnLiveReviewInputSchema } from "./customer-return-live.contract";
import {
  customerReturnCarrierPolicyFields,
  refineCustomerReturnCarrierPolicy,
} from "./customer-return-carrier-policy";

export const CUSTOMER_RETURN_LABEL_API =
  "/api/returns/admin/portal-preview/live";
const id = z.number().int().positive().safe();
const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\u0000-\u001f\u007f]+$/);
export const customerReturnLabelAddressSchema = z
  .object({
    name: text(200),
    phone: text(50).optional(),
    companyName: text(200).optional(),
    addressLine1: text(200),
    addressLine2: text(200).optional(),
    addressLine3: text(200).optional(),
    city: text(100),
    state: text(50),
    postalCode: text(20),
    countryCode: z.literal("US"),
  })
  .strict();
export const customerReturnLabelSettingsFieldsSchema = z
  .object({
    enabled: z.boolean(),
    warehouseId: id,
    ...customerReturnCarrierPolicyFields,
    parcelGuardrails: customerReturnShippingGuardrailsSchema.nullable().optional(),
    contactName: text(200),
    contactPhone: text(50).nullable(),
  })
  .strict();
export const customerReturnLabelSettingsInputSchema =
  customerReturnLabelSettingsFieldsSchema
    .extend({
      expectedVersion: z.number().int().nonnegative().safe(),
      policyId: id.nullish(),
    })
    .superRefine(refineCustomerReturnCarrierPolicy)
    .transform(({ policyId: _legacyPolicyId, ...shipping }) => shipping);
export const customerReturnLabelSettingsSchema =
  customerReturnLabelSettingsFieldsSchema
    .extend({
      version: id,
      destinationAddress: customerReturnLabelAddressSchema,
      policyId: id.nullish(),
    })
    .strict()
    .superRefine(refineCustomerReturnCarrierPolicy);
export const customerReturnLabelControlSchema = z
  .object({
    paused: z.boolean(),
    version: z.number().int().nonnegative().safe(),
  })
  .strict();
export const customerReturnLabelControlInputSchema = z
  .object({
    paused: z.boolean(),
    expectedVersion: z.number().int().nonnegative().safe(),
  })
  .strict();
export const customerReturnResolvedPolicySchema = z
  .object({
    id,
    name: text(160),
    version: id,
    returnWindowDays: z.number().int().min(0).max(3650),
    scopeKind: z.enum([
      "global",
      "business_context",
      "channel_context",
      "vendor_context",
      "vendor_channel_context",
      "store",
    ]),
  })
  .strict();
export const customerReturnPolicyIssueSchema = z
  .object({
    code: z
      .string()
      .regex(/^[A-Z0-9_]+$/)
      .max(100),
    message: text(500),
  })
  .strict();
export const customerReturnLabelSettingsStateSchema = z
  .object({
    channelId: id,
    providerConfigured: z.boolean(),
    settings: customerReturnLabelSettingsSchema.nullable(),
    control: customerReturnLabelControlSchema,
    warehouses: z
      .array(
        z
          .object({
            id,
            name: text(200),
            address: customerReturnLabelAddressSchema.nullable(),
          })
          .strict(),
      )
      .max(200),
    resolvedPolicy: customerReturnResolvedPolicySchema.nullable(),
    policyIssue: customerReturnPolicyIssueSchema.nullable(),
    carriers: z
      .array(
        z
          .object({
            id: text(80),
            code: text(100),
            name: text(200),
            services: z
              .array(z.object({ code: text(100), name: text(200) }).strict())
              .max(200),
          })
          .strict(),
      )
      .max(100),
    message: z.string().max(500).nullable(),
  })
  .strict();
export type CustomerReturnLabelSettingsInput = z.infer<
  typeof customerReturnLabelSettingsInputSchema
>;
export type CustomerReturnLabelSettings = z.infer<
  typeof customerReturnLabelSettingsSchema
>;
export type CustomerReturnLabelSettingsState = z.infer<
  typeof customerReturnLabelSettingsStateSchema
>;

export const customerReturnLabelSubmitInputSchema =
  customerReturnLiveReviewInputSchema
    .extend({
      idempotencyKey: z.string().uuid(),
      settingsVersion: id,
    })
    .strict();
export type CustomerReturnLabelSubmitInput = z.infer<
  typeof customerReturnLabelSubmitInputSchema
>;
export const customerReturnLabelStatusSchema = z
  .object({
    channelId: id,
    authorizationId: id,
    authorizationNumber: text(32),
    parcels: z
      .array(
        z
          .object({
            parcelId: id,
            number: id,
            status: z.enum([
              "pending",
              "processing",
              "ready",
              "needs_review",
              "failed",
            ]),
            trackingNumber: text(200).nullable(),
            // Artifacts remain behind fresh authorization; provider URLs are never exposed here.
            downloadPath: z
              .string()
              .max(300)
              .regex(
                /^\/api\/returns\/admin\/portal-preview\/live\/labels\/\d+\/\d+\/parcels\/\d+\/download$/,
              )
              .nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    canProgress: z.boolean(),
  })
  .strict();
export type CustomerReturnLabelStatus = z.infer<
  typeof customerReturnLabelStatusSchema
>;
