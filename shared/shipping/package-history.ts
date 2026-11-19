import { z } from "zod";
import { shippingPackageDimensionsSchema } from "./package-dimensions";

const id = z.number().int().positive().safe();
const providerId = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(30);
const quantity = z.number().int().positive().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PACKAGE_HISTORY_LIMIT = 200;
export const packageHistoryScopeSchema = z
  .object({
    omsOrderId: id,
    channelId: id,
    connectionId: id,
    externalOrderId: providerId,
    externalCustomerId: providerId.nullable(),
    orderReference: z.string().min(1).max(50),
    shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    displayName: z.string().min(1).max(100),
    lines: z
      .array(
        z
          .object({
            omsOrderLineId: id,
            externalLineId: providerId,
            sku: z.string().max(100).nullable(),
            quantity: z.number().int().nonnegative().safe(),
            requiresShipping: z.boolean(),
            aliases: z.array(z.string().min(1).max(100)).max(2_000),
          })
          .strict(),
      )
      .max(PACKAGE_HISTORY_LIMIT),
  })
  .strict();
export const packageHistoryNativeSchema = z
  .object({
    orderId: providerId,
    reference: z.string().min(1).max(50),
    customerId: providerId.nullable(),
    lines: z
      .array(
        z
          .object({
            id: providerId,
            quantity: z.number().int().nonnegative().safe(),
            requiresShipping: z.boolean(),
            sku: z.string().max(100).nullable(),
          })
          .strict(),
      )
      .max(PACKAGE_HISTORY_LIMIT),
    fulfillments: z
      .array(
        z
          .object({
            id: providerId,
            status: z.string().min(1).max(30),
            updatedAt: z.string().datetime({ offset: true }),
            tracking: z
              .array(z.string().trim().min(1).max(200))
              .max(PACKAGE_HISTORY_LIMIT),
            lines: z
              .array(
                z
                  .object({
                    lineItemId: providerId,
                    quantity: z.number().int().nonnegative().safe(),
                  })
                  .strict(),
              )
              .max(PACKAGE_HISTORY_LIMIT),
          })
          .strict(),
      )
      .max(PACKAGE_HISTORY_LIMIT),
  })
  .strict();
export const packageHistoryLineSchema = z
  .object({
    omsOrderLineId: id,
    externalLineId: providerId,
    quantity,
  })
  .strict();
export const packageHistoryPackageSchema = z
  .object({
    provider: z.literal("shipstation"),
    providerShipmentId: providerId,
    fulfillmentId: providerId,
    trackingNumber: z.string().trim().min(1).max(200),
    providerObservationHash: hash,
    providerLineItems: z
      .array(
        z
          .object({ lineItemKey: z.string().min(1).max(200), quantity })
          .strict(),
      )
      .min(1)
      .max(PACKAGE_HISTORY_LIMIT),
    dimensions: shippingPackageDimensionsSchema.nullable(),
    measurementStatus: z.enum(["verified", "missing", "invalid"]),
    measurementSource: z.enum(["provider", "retained", "missing"]),
    lines: z.array(packageHistoryLineSchema).min(1).max(PACKAGE_HISTORY_LIMIT),
  })
  .strict()
  .refine(
    (value) =>
      value.measurementStatus === "verified"
        ? value.dimensions !== null && value.measurementSource !== "missing"
        : value.dimensions === null &&
          (value.measurementStatus === "missing"
            ? value.measurementSource === "missing"
            : value.measurementSource === "provider"),
    "Verified measurements require dimensions; unavailable measurements cannot carry a size",
  );
export const packageHistoryDocumentSchema = z
  .object({
    version: z.literal(1),
    omsOrderId: id,
    channelId: id,
    externalOrderId: providerId,
    sourceRevision: hash,
    nativeRevision: hash,
    sourceEvidence: packageHistoryScopeSchema,
    nativeEvidence: packageHistoryNativeSchema,
    packages: z.array(packageHistoryPackageSchema).max(PACKAGE_HISTORY_LIMIT),
  })
  .strict();
export type PackageHistoryDocument = z.infer<
  typeof packageHistoryDocumentSchema
>;
export type PackageHistoryPackage = z.infer<typeof packageHistoryPackageSchema>;

/** Non-operational shipping evidence. It grants no fulfillment/return entitlement. */
export interface PackageHistoryReadPort {
  read(input: {
    omsOrderId: number;
    channelId: number;
    externalOrderId: string;
  }): Promise<PackageHistoryDocument | null>;
}
