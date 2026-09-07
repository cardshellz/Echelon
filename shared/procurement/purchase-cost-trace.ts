import { receiptCostRequestHistorySchema } from "./receipt-cost-queue";
import { purchaseCostApplicationHistorySchema } from "./purchase-cost-applications";
import { invoiceCostComponentEvidenceSchema } from "./invoice-cost-evidence";
import { z } from "zod";

const id = z.number().int().positive().safe();
const integer = z.number().int().safe();
const money = integer.nullable();
const date = z.string().datetime({ offset: true }).nullable();
const exactDecimal = z.string().regex(/^-?\d+(?:\.\d+)?$/).nullable();

/** Source previews and current lot balances are deliberately separate. Neither
 * is a receipt proving that a source revision reached inventory or sold COGS. */
export const purchaseCostTraceSchema = z.object({
  version: z.literal(1),
  applicationEvidence: z.enum(["not_verified", "recorded"]),
  applicationHistory: purchaseCostApplicationHistorySchema.optional(),
  receiptCostRequests: receiptCostRequestHistorySchema.optional(),
  purchaseLines: z.array(z.object({
    id,
    sku: z.string().nullable(),
    lineType: z.string(),
    status: z.string(),
    currency: z.string().nullable(),
    pricingBasis: z.string(),
    pricingSource: z.string(),
    quoteReference: z.string().nullable(),
    orderedPieces: integer.nullable(),
    receivedPieces: integer.nullable(),
    cancelledPieces: integer.nullable(),
    productCents: money,
    packagingCents: money,
    discountCents: money,
    taxCents: money,
    lineTotalCents: money,
    productUnitMills: money,
    pricingRemainderMills: money,
    outstandingPieces: integer.nonnegative().nullable(),
    // Proportional product + packaging quote, rounded once to cents. It is not
    // an inventory valuation, payable balance, or landed-cost application.
    unreceivedQuoteCents: money,
    expectedArrivalDate: date,
    arrivalDateSource: z.enum(["line_promise", "line_expected", "purchase_confirmed", "purchase_expected"]).nullable(),
    issues: z.array(z.string()),
  })),
  invoiceLines: z.array(z.object({
    id,
    invoiceId: id,
    purchaseOrderLineId: id,
    quantity: integer,
    unitCostCents: money,
    unitCostMills: money,
    lineTotalCents: money,
    matchStatus: z.string(),
    componentEvidence: z.enum(["unclassified", "explicit_recorded", "review_required"]),
    components: invoiceCostComponentEvidenceSchema.nullable().optional(),
    componentIssues: z.array(z.string()).optional(),
  })),
  shipmentCharges: z.array(z.object({
    id,
    shipmentId: id,
    costType: z.string(),
    description: z.string().nullable(),
    currency: z.string().nullable(),
    exchangeRate: exactDecimal,
    estimatedCents: money,
    actualCents: money,
    recordedStatus: z.string().nullable(),
    amountEvidence: z.enum(["actual_recorded", "estimated", "unknown"]),
    invoiceId: id.nullable(),
    amountScope: z.literal("whole_shipment_charge"),
    allocations: z.array(z.object({
      id,
      shipmentLineId: id,
      purchaseOrderLineId: id,
      allocatedCents: money,
      basisValue: exactDecimal,
      basisTotal: exactDecimal,
      // Allocation output has no captured currency/source revision contract.
      currency: z.null(),
    })),
  })),
  receiptLines: z.array(z.object({
    id,
    receiptId: id,
    purchaseOrderLineId: id,
    shipmentId: id.nullable(),
    shipmentLineId: id.nullable(),
    receivedUnits: integer,
    reversedUnits: integer,
    frozenPiecesPerUnit: integer.positive().nullable(),
    unitEvidence: z.enum(["frozen_receipt", "unknown"]),
    lineageEvidence: z.enum(["original_receipt_proven", "awaiting_posting", "review_required"]),
    issues: z.array(z.string()),
    postings: z.array(z.object({
      id,
      variantQuantity: integer,
      postedAt: date,
      voidedAt: date,
      lot: z.object({
        id,
        lotNumber: z.string(),
        variantId: id,
        locationId: id,
        onHandUnits: integer,
        reservedUnits: integer,
        pickedUnits: integer,
        productUnitMills: money,
        packagingUnitMills: money,
        landedUnitMills: money,
        totalUnitMills: money,
        recordedProvisional: z.boolean(),
        // Lots have no persisted currency column. The PO currency is not proof.
        currency: z.null(),
      }).nullable(),
    })),
  })),
  limitations: z.array(z.string()),
});

export type PurchaseCostTrace = z.infer<typeof purchaseCostTraceSchema>;
