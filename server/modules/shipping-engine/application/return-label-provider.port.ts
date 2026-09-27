import { z } from "zod";
import { MAX_DIMENSION_MM, MILLIMETERS_PER_INCH } from "@shared/shipping/dimensions";

const text = (maximum: number) => z.string().trim().min(1).max(maximum).regex(/^[^\u0000-\u001f\u007f]+$/);
export const returnLabelProviderIdSchema = z.string().regex(/^se(?:-[a-z0-9]+)+$/).max(80);
const externalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,49}$/);
const dimension = z.number().finite().positive().max(MAX_DIMENSION_MM / MILLIMETERS_PER_INCH);

export const returnLabelAddressSchema = z.object({
  name: text(200),
  phone: text(50).optional(),
  companyName: text(200).optional(),
  addressLine1: text(200),
  addressLine2: text(200).optional(),
  addressLine3: text(200).optional(),
  city: text(100),
  state: text(50),
  postalCode: text(20),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
}).strict();
export type ReturnLabelAddress = z.infer<typeof returnLabelAddressSchema>;

export const returnLabelInputSchema = z.object({
  externalShipmentId: externalId,
  rmaNumber: text(50),
  carrierId: returnLabelProviderIdSchema,
  serviceCode: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/).max(100),
  shipFrom: returnLabelAddressSchema,
  shipTo: returnLabelAddressSchema,
  parcel: z.object({
    weightGrams: z.number().int().positive().safe(),
    dimensionsInches: z.object({ length: dimension, width: dimension, height: dimension }).strict(),
  }).strict(),
}).strict().refine(input => input.shipFrom.countryCode === input.shipTo.countryCode, {
  message: "Return labels require a domestic shipment.",
});
export type ReturnLabelInput = z.infer<typeof returnLabelInputSchema>;

/** Downloads are sensitive label artifacts. This validates metadata only; it never fetches a URL. */
export const returnLabelDownloadUrlSchema = z.string().max(2048).url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash
    // Provider artifact paths are opaque ASCII tokens. Encoded separators and
    // dot segments must not make the downloader reach another API endpoint.
    && !/[\\%\s\u0000-\u001f\u007f]/.test(url.pathname)
    && !/[\\\u0000-\u0020\u007f]/.test(value)
    && (!url.port || url.port === "443")
    && ((url.hostname === "api.shipstation.com" && url.pathname.startsWith("/v2/downloads/"))
      || (url.hostname === "api.shipengine.com" && url.pathname.startsWith("/v1/downloads/")));
}, "The label download is not on an approved provider endpoint.");

export const returnLabelRecordSchema = z.object({
  labelId: returnLabelProviderIdSchema,
  shipmentId: returnLabelProviderIdSchema,
  externalShipmentId: externalId,
  trackingNumber: text(200),
  carrierId: returnLabelProviderIdSchema,
  serviceCode: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/).max(100),
  amountCents: z.number().int().nonnegative().safe(),
  currency: z.literal("USD"),
  downloadUrl: returnLabelDownloadUrlSchema,
  labelFormat: z.literal("pdf"),
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export type ReturnLabelRecord = z.infer<typeof returnLabelRecordSchema>;

export class ReturnLabelProviderError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: "rejected" | "unknown",
    readonly retryable: boolean = false,
  ) {
    super(outcome === "unknown"
      ? "The return label outcome requires reconciliation. Do not purchase it again."
      : "The return label request was not accepted.");
    this.name = "ReturnLabelProviderError";
  }
}

export interface ReturnLabelProvider {
  /** Exactly one POST. Persist the attempt before invoking this effect. */
  purchase(input: ReturnLabelInput, signal?: AbortSignal): Promise<ReturnLabelRecord>;
  /** Read only. null means not found yet, NEVER permission to repeat purchase. */
  recover(input: ReturnLabelInput, signal?: AbortSignal): Promise<ReturnLabelRecord | null>;
}
