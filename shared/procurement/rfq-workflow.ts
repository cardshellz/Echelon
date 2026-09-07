import { z } from "zod";
import { rfqQuantityReviewSchema } from "./rfq-quantity-review";
import { normalizePoLinePricing } from "../utils/po-line-pricing";

export const RFQ_WORKFLOW_MAX_LINES = 500;
export const RFQ_HISTORY_PAGE_SIZE = 50;
export const rfqResourceIdSchema = z.number().int().positive().max(2_147_483_647);
const amount = z.number().int().nonnegative().safe();
const version = z.string().regex(/^[0-9a-f]{64}$/);
const text = z.string().trim().min(1).max(2_000);
const dateOnly = z.string().date();
const timestamp = z.string().datetime({ offset: true });

export const rfqQuotePricingSchema = z.discriminatedUnion("basis", [
  z.object({ basis: z.literal("per_piece"), quantityPieces: rfqResourceIdSchema, unitCostMills: amount }).strict(),
  z.object({ basis: z.literal("per_purchase_uom"), purchaseUom: z.string().trim().min(1).max(50), uomQuantity: rfqResourceIdSchema, piecesPerUom: rfqResourceIdSchema, quotedCostMillsPerUom: amount }).strict(),
  z.object({ basis: z.literal("extended_total"), quantityPieces: rfqResourceIdSchema, quotedTotalCents: amount }).strict(),
]);

export const rfqQuoteEvidenceSchema = z.object({
  pricing: rfqQuotePricingSchema,
  packagingTreatment: z.enum(["separate", "included_in_product", "unknown"]),
  packagingCostCents: amount.nullable(),
  quoteReference: z.string().trim().min(1).max(255),
  quoteValidUntil: dateOnly.nullable(),
  quotedAt: timestamp,
  leadTimeDays: z.number().int().nonnegative().max(3_650).nullable(),
  reason: text,
}).strict().superRefine((quote, context) => {
  if (quote.packagingTreatment === "separate" && quote.packagingCostCents === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["packagingCostCents"], message: "Record the separate packaging amount, including an explicit zero when none is charged" });
  }
});

export const rfqQuoteCaptureSchema = z.object({
  expectedVersion: version,
  quote: rfqQuoteEvidenceSchema,
}).strict();

export const rfqConvertSchema = z.object({
  expectedVersion: version,
  lines: z.array(z.object({ rfqLineId: rfqResourceIdSchema, quoteRevisionId: rfqResourceIdSchema }).strict()).min(1).max(RFQ_WORKFLOW_MAX_LINES),
  quantityOverrideReason: text.nullable(),
}).strict().superRefine((command, context) => {
  if (new Set(command.lines.map((line) => line.rfqLineId)).size !== command.lines.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "An RFQ line can be selected only once" });
  }
});

export const rfqQuoteRevisionSchema = z.object({
  id: rfqResourceIdSchema,
  rfqLineId: rfqResourceIdSchema,
  revision: rfqResourceIdSchema,
  fingerprint: version,
  currency: z.string().regex(/^[A-Z]{3}$/),
  quotedPieces: rfqResourceIdSchema,
  quotedUnitCostMills: amount,
  productTotalMills: amount,
  pricingRemainderMills: z.number().int().safe(),
  quote: rfqQuoteEvidenceSchema,
  createdBy: z.string().trim().min(1).max(200),
  createdAt: timestamp,
}).strict().superRefine((revision, context) => {
  try {
    const exact = normalizePoLinePricing(revision.quote.pricing);
    if (revision.quotedPieces !== exact.orderQty || revision.quotedUnitCostMills !== exact.unitCostMills || revision.productTotalMills !== exact.quotedExtendedMills || revision.pricingRemainderMills !== exact.pricingRemainderMills) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Quote revision amounts must match its preserved pricing basis exactly" });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["quote", "pricing"], message: "Quote pricing exceeds the supported exact range" });
  }
});

export const rfqPurchaseOrderLinkSchema = z.object({
  purchaseOrderId: rfqResourceIdSchema,
  purchaseOrderLineId: rfqResourceIdSchema,
  quoteRevisionId: rfqResourceIdSchema,
  poNumber: z.string(),
  status: z.string(),
}).strict();

export const rfqWorkflowDetailSchema = z.object({
  id: rfqResourceIdSchema,
  rfqNumber: z.string(),
  vendorId: rfqResourceIdSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.string(),
  version,
  lines: z.array(z.object({
    id: rfqResourceIdSchema,
    status: z.string(),
    productId: rfqResourceIdSchema,
    productVariantId: rfqResourceIdSchema.nullable(),
    warehouseId: rfqResourceIdSchema.nullable(),
    vendorProductId: rfqResourceIdSchema,
    sku: z.string(),
    productName: z.string(),
    requestedPieces: rfqResourceIdSchema,
    quantityReview: rfqQuantityReviewSchema,
    latestQuote: rfqQuoteRevisionSchema.nullable(),
    purchaseOrder: rfqPurchaseOrderLinkSchema.nullable(),
  }).strict()).max(RFQ_WORKFLOW_MAX_LINES),
}).strict();

export const rfqConversionResultSchema = z.object({
  rfqId: rfqResourceIdSchema,
  purchaseOrderId: rfqResourceIdSchema,
  poNumber: z.string(),
  status: z.literal("draft"),
  lines: z.array(z.object({ rfqLineId: rfqResourceIdSchema, quoteRevisionId: rfqResourceIdSchema, purchaseOrderLineId: rfqResourceIdSchema }).strict()),
}).strict();

export type RfqQuoteEvidence = z.infer<typeof rfqQuoteEvidenceSchema>;
export type RfqQuoteRevision = z.infer<typeof rfqQuoteRevisionSchema>;
export type RfqQuoteCapture = z.infer<typeof rfqQuoteCaptureSchema>;
export type RfqConvert = z.infer<typeof rfqConvertSchema>;
export type RfqWorkflowDetail = z.infer<typeof rfqWorkflowDetailSchema>;
export type RfqConversionResult = z.infer<typeof rfqConversionResultSchema>;
