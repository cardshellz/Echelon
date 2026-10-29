import { z } from "zod";

export const MAX_RETURN_PARCEL_RECEIPT_LINES = 200;
const id = z.number().int().positive().safe();
const quantity = z.number().int().nonnegative().safe();
export const returnParcelReceiptInputSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    notes: z.string().trim().max(2000).nullable().default(null),
    lines: z
      .array(
        z
          .object({
            authorizationLineId: id,
            expectedCurrentReceivedQuantity: quantity,
            quantityReceivedNow: id,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_RETURN_PARCEL_RECEIPT_LINES),
  })
  .strict();
export type ReturnParcelReceiptInput = z.infer<
  typeof returnParcelReceiptInputSchema
>;
export const returnParcelReceivingSchema = z
  .object({
    parcelId: id,
    authorizationId: id,
    authorizationNumber: z.string().min(1).max(32),
    boxNumber: id,
    trackingNumber: z.string().min(1).max(MAX_RETURN_PARCEL_RECEIPT_LINES),
    lines: z
      .array(
        z
          .object({
            authorizationLineId: id,
            title: z.string().nullable(),
            sku: z.string().nullable(),
            expectedQuantity: id,
            receivedQuantity: quantity,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_RETURN_PARCEL_RECEIPT_LINES),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.lines.map((line) => line.authorizationLineId)).size !==
        value.lines.length ||
      value.lines.some((line) => line.receivedQuantity > line.expectedQuantity)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Return box quantities are inconsistent.",
      });
    }
  });
export type ReturnParcelReceiving = z.infer<typeof returnParcelReceivingSchema>;
export const returnParcelReceiptResultSchema = z
  .object({
    parcel: returnParcelReceivingSchema,
    caseIds: z.array(id).min(1).max(MAX_RETURN_PARCEL_RECEIPT_LINES),
    replayed: z.boolean(),
  })
  .strict();
export type ReturnParcelReceiptResult = z.infer<
  typeof returnParcelReceiptResultSchema
>;
