import { z } from "zod";
import { customerReturnLiveReviewInputSchema } from "./customer-return-live.contract";

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
export const customerReturnLabelSettingsInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative().safe(),
    enabled: z.boolean(),
    warehouseId: id,
    policyId: id,
    carrierId: z
      .string()
      .regex(/^se(?:-[a-z0-9]+)+$/)
      .max(80),
    serviceCode: z
      .string()
      .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
      .max(100),
    contactName: text(200),
    contactPhone: text(50).nullable(),
  })
  .strict();
export const customerReturnLabelSettingsSchema =
  customerReturnLabelSettingsInputSchema
    .omit({ expectedVersion: true })
    .extend({
      version: id,
      destinationAddress: customerReturnLabelAddressSchema,
    })
    .strict();
export const customerReturnLabelSettingsStateSchema = z
  .object({
    channelId: id,
    providerConfigured: z.boolean(),
    settings: customerReturnLabelSettingsSchema.nullable(),
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
    policies: z
      .array(z.object({ id, name: text(160), version: id }).strict())
      .max(200),
    carriers: z
      .array(
        z
          .object({
            id: text(80),
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
