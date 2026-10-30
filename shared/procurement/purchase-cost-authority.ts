import { z } from "zod";
import { costFingerprintSchema, costIssueSchema } from "./cost-source-contracts";

const id = z.number().int().positive().max(2_147_483_647);
const storedId = z.number().int().positive().safe();
const money = z.number().int().safe();
const nonnegativeMoney = money.nonnegative();
const pieces = z.number().int().positive().safe();
const currency = z.string().regex(/^[A-Z]{3}$/);
const MAX_SOURCES = 1_000;
const MAX_ADJUSTMENTS = 100;

export const purchaseCostReferenceSchema = z.object({
  kind: z.enum(["purchase_order_line", "vendor_invoice_line", "shipment_cost", "supplier_credit_line"]),
  documentId: id,
  lineId: id,
}).strict();
export const purchaseCostApprovalSchema = z.object({
  actorId: z.string().trim().min(1).max(500),
  recordedAt: z.string().datetime({ offset: true }),
  reference: z.string().trim().min(1).max(500),
}).strict();
const provenance = {
  sourceRevisionId: storedId.nullable().default(null),
  approval: purchaseCostApprovalSchema.nullable().default(null),
};

/** A known document total is independent of whether its internal split is known.
 * Inclusion of adjustments is an explicit input from the owning policy. */
export const purchaseCostAmountSchema = z.object({
  documentTotalMills: nonnegativeMoney,
  goodsMills: nonnegativeMoney,
  breakdown: z.object({ productMills: nonnegativeMoney, packagingMills: nonnegativeMoney }).strict().nullable(),
  adjustments: z.array(z.object({
    key: z.string().trim().min(1).max(200),
    category: z.enum(["discount", "tax", "supplier_freight", "supplier_credit", "other"]),
    amountMills: money,
    treatment: z.enum(["inventory", "excluded", "unclassified"]),
  }).strict()).max(MAX_ADJUSTMENTS),
}).strict().superRefine((value, context) => {
  if (![value.goodsMills, value.documentTotalMills, ...value.adjustments.map(row => row.amountMills),
    ...(value.breakdown ? [value.breakdown.productMills, value.breakdown.packagingMills] : [])].every(Number.isSafeInteger)) return;
  const total = BigInt(value.goodsMills) + value.adjustments.reduce((sum, row) => sum + BigInt(row.amountMills), BigInt(0));
  if (total !== BigInt(value.documentTotalMills))
    context.addIssue({ code: "custom", message: "Goods and adjustments must equal the document amount exactly." });
  if (value.breakdown && BigInt(value.breakdown.productMills) + BigInt(value.breakdown.packagingMills) !== BigInt(value.goodsMills))
    context.addIssue({ code: "custom", path: ["breakdown"], message: "The product and packaging split must equal the goods amount." });
  if (new Set(value.adjustments.map(row => row.key)).size !== value.adjustments.length)
    context.addIssue({ code: "custom", path: ["adjustments"], message: "Adjustment references must be unique within a source." });
});

export const purchaseCostInvoiceSchema = z.object({
  reference: purchaseCostReferenceSchema.extend({ kind: z.literal("vendor_invoice_line") }),
  purchaseOrderLineId: id,
  currency,
  pieces,
  status: z.enum(["draft", "received", "approved", "partially_paid", "paid", "disputed", "voided"]),
  amount: purchaseCostAmountSchema,
  receiptCoverage: z.array(z.object({
    receivingLineId: id,
    startPiece: z.number().int().nonnegative().safe(),
    pieces,
  }).strict()).min(1).max(MAX_SOURCES).nullable(),
  ...provenance,
}).strict().superRefine((value, context) => {
  if (![value.pieces, ...(value.receiptCoverage ?? []).map(row => row.pieces)].every(Number.isSafeInteger)) return;
  if (value.receiptCoverage && value.receiptCoverage.reduce((sum, row) => sum + BigInt(row.pieces), BigInt(0)) !== BigInt(value.pieces))
    context.addIssue({ code: "custom", path: ["receiptCoverage"], message: "Receipt coverage must equal the invoiced pieces." });
});

export const purchaseCostApplicationSchema = z.object({
  state: z.enum(["not_requested", "pending", "applied", "review_required", "retry_required"]),
  economicFingerprint: costFingerprintSchema.nullable(),
  applicationIds: z.array(storedId).max(MAX_SOURCES),
  approvals: z.array(purchaseCostApprovalSchema).max(MAX_SOURCES),
}).strict().superRefine((value, context) => {
  if (new Set(value.applicationIds).size !== value.applicationIds.length)
    context.addIssue({ code: "custom", path: ["applicationIds"], message: "Application references must be unique." });
  if (value.state === "applied" && (!value.economicFingerprint || value.applicationIds.length === 0))
    context.addIssue({ code: "custom", message: "Applied costs require their economic identity and recorded applications." });
});

/** Additive planning/read contract. It does not authorize or execute posting. */
const purchaseCostAuthorityFields = {
  contractVersion: z.literal(1),
  scope: z.object({ purchaseOrderId: id, purchaseOrderLineId: id, currency, basePieces: pieces }).strict(),
  quote: z.object({
    reference: purchaseCostReferenceSchema.extend({ kind: z.literal("purchase_order_line") }),
    basePieces: pieces,
    amount: purchaseCostAmountSchema.nullable(),
    ...provenance,
  }).strict(),
  invoices: z.array(purchaseCostInvoiceSchema).max(MAX_SOURCES),
  shipmentCostCoverage: z.enum(["not_applicable", "complete", "awaiting_source"]),
  shipmentShares: z.array(z.object({
    shipmentId: id,
    shipmentLineId: id,
    chargeId: id,
    category: z.enum(["freight", "duty", "insurance", "other"]),
    reference: purchaseCostReferenceSchema,
    currency,
    sourceAmountMills: money,
    allocatedMills: money.nullable(),
    allocationSourceAmountMills: money.nullable(),
    evidence: z.enum(["estimated", "confirmed", "review_required"]),
    ...provenance,
  }).strict()).max(MAX_SOURCES),
  receiptAllocationPolicy: z.enum(["explicit_receipts", "po_line_blended", "unresolved"]),
  application: purchaseCostApplicationSchema.nullable(),
};
export const purchaseCostAuthorityInputSchema = z.object(purchaseCostAuthorityFields).strict().superRefine((value, context) => {
  if (value.quote.reference.documentId !== value.scope.purchaseOrderId || value.quote.reference.lineId !== value.scope.purchaseOrderLineId)
    context.addIssue({ code: "custom", path: ["quote", "reference"], message: "The quote must identify this exact purchase line." });
  const invoiceKeys = value.invoices.map(row => `${row.reference.documentId}:${row.reference.lineId}`);
  if (new Set(invoiceKeys).size !== invoiceKeys.length)
    context.addIssue({ code: "custom", path: ["invoices"], message: "An invoice line can contribute only once." });
  if (value.invoices.reduce((sum, row) => sum + (row.receiptCoverage?.length ?? 0), 0) > MAX_SOURCES)
    context.addIssue({ code: "custom", path: ["invoices"], message: "Receipt coverage exceeds the supported source interval limit." });
  if (value.invoices.some(row => row.purchaseOrderLineId !== value.scope.purchaseOrderLineId))
    context.addIssue({ code: "custom", path: ["invoices"], message: "Invoice evidence identifies another purchase line." });
  const shares = value.shipmentShares.map(row => `${row.chargeId}:${row.shipmentLineId}`);
  if (new Set(shares).size !== shares.length)
    context.addIssue({ code: "custom", path: ["shipmentShares"], message: "A charge's shipment-line share can contribute only once." });
  if ((value.shipmentCostCoverage === "not_applicable" && value.shipmentShares.length !== 0)
    || (value.shipmentCostCoverage === "complete" && value.shipmentShares.length === 0))
    context.addIssue({ code: "custom", path: ["shipmentCostCoverage"], message: "Shipment coverage requires saved charge evidence or an explicit not-applicable disposition." });
});

export const purchaseCostAmountProjectionSchema = z.object({
  documentMills: money,
  goodsMills: money,
  productMills: money.nullable(),
  packagingMills: money.nullable(),
  inventoryAdjustmentsMills: money,
  excludedAdjustmentsMills: money,
  unclassifiedAdjustmentsMills: money,
  includedMills: money.nullable(),
  classification: z.enum(["complete", "unclassified"]),
}).strict().superRefine((value, context) => {
  const amounts = [value.documentMills, value.goodsMills, value.productMills ?? 0, value.packagingMills ?? 0,
    value.inventoryAdjustmentsMills, value.excludedAdjustmentsMills, value.unclassifiedAdjustmentsMills, value.includedMills ?? 0];
  if (!amounts.every(Number.isSafeInteger)) return;
  if (BigInt(value.documentMills) !== BigInt(value.goodsMills) + BigInt(value.inventoryAdjustmentsMills)
    + BigInt(value.excludedAdjustmentsMills) + BigInt(value.unclassifiedAdjustmentsMills))
    context.addIssue({ code: "custom", message: "Projected goods and adjustments must conserve the document amount." });
  if ((value.productMills === null) !== (value.packagingMills === null)
    || (value.productMills !== null && value.packagingMills !== null && BigInt(value.productMills) + BigInt(value.packagingMills) !== BigInt(value.goodsMills)))
    context.addIssue({ code: "custom", message: "The projected split must be complete or explicitly unknown." });
  if ((value.classification === "unclassified") !== (value.includedMills === null)
    || (value.unclassifiedAdjustmentsMills !== 0 && value.classification !== "unclassified")
    || (value.includedMills !== null && BigInt(value.includedMills) !== BigInt(value.goodsMills) + BigInt(value.inventoryAdjustmentsMills)))
    context.addIssue({ code: "custom", message: "Included cost requires an explicit, exactly reconciled classification." });
});

export const purchaseCostAuthoritySchema = z.object({
  contractVersion: z.literal(1),
  scope: purchaseCostAuthorityFields.scope,
  economicFingerprint: costFingerprintSchema,
  sourceState: z.enum(["estimated", "confirmed", "mixed", "review_required"]),
  coverage: z.object({
    confirmedPieces: z.number().int().nonnegative().safe(),
    estimatedPieces: z.number().int().nonnegative().safe(),
    receiptAllocation: z.enum(["whole_line", "explicit_receipts", "po_line_blended", "decision_required"]),
  }).strict(),
  agreedQuote: purchaseCostAmountProjectionSchema.nullable(),
  supplier: purchaseCostAmountProjectionSchema.nullable(),
  selectedSources: z.array(z.object({
    reference: purchaseCostReferenceSchema,
    currency,
    pieces,
    sourceBasePieces: pieces,
    evidence: z.enum(["confirmed", "estimated"]),
    sourceAmount: purchaseCostAmountSchema,
    amount: purchaseCostAmountProjectionSchema,
    ...provenance,
  }).strict()).max(MAX_SOURCES + 1),
  shipmentCostCoverage: purchaseCostAuthorityFields.shipmentCostCoverage,
  shipmentShares: purchaseCostAuthorityFields.shipmentShares,
  shipmentMills: money.nullable(),
  landedMills: money.nullable(),
  application: z.object({
    state: z.enum(["not_requested", "pending", "applied", "source_changed", "review_required", "retry_required"]),
    applicationIds: z.array(storedId).max(MAX_SOURCES),
    approvals: z.array(purchaseCostApprovalSchema).max(MAX_SOURCES),
  }).strict(),
  issues: z.array(costIssueSchema).max(MAX_SOURCES * 4 + 16),
}).strict().superRefine((value, context) => {
  if (![value.scope.basePieces, value.coverage.confirmedPieces, value.coverage.estimatedPieces,
    value.shipmentMills ?? 0, value.landedMills ?? 0, value.supplier?.includedMills ?? 0].every(Number.isSafeInteger)) return;
  if (value.supplier !== null && value.supplier.includedMills !== null && value.shipmentMills !== null && value.landedMills !== null
    && BigInt(value.supplier.includedMills) + BigInt(value.shipmentMills) !== BigInt(value.landedMills))
    context.addIssue({ code: "custom", path: ["landedMills"], message: "Landed cost must equal selected supplier cost plus saved shipment shares." });
  if (BigInt(value.coverage.confirmedPieces) + BigInt(value.coverage.estimatedPieces) > BigInt(value.scope.basePieces))
    context.addIssue({ code: "custom", path: ["coverage"], message: "Coverage exceeds the purchase cost scope." });
  if (value.landedMills !== null && (value.supplier?.includedMills == null || value.shipmentMills === null))
    context.addIssue({ code: "custom", path: ["landedMills"], message: "Landed cost requires complete supplier and shipment amounts." });
  if (value.application.state === "applied" && (value.application.applicationIds.length === 0 || value.landedMills === null
    || value.issues.length > 0 || value.coverage.receiptAllocation === "decision_required"))
    context.addIssue({ code: "custom", path: ["application"], message: "A completed monetary projection requires current, complete application evidence." });
  if (value.supplier !== null && value.selectedSources.some(row => row.currency !== value.scope.currency))
    context.addIssue({ code: "custom", path: ["supplier"], message: "Supplier amounts in different currencies cannot be summed." });
  if (value.selectedSources.every(row => Number.isSafeInteger(row.pieces))
    && value.selectedSources.reduce((sum, row) => sum + BigInt(row.pieces), BigInt(0))
      !== BigInt(value.coverage.confirmedPieces) + BigInt(value.coverage.estimatedPieces))
    context.addIssue({ code: "custom", path: ["selectedSources"], message: "Selected sources must match the declared quantity coverage." });
  for (const [evidence, field] of [["confirmed", "confirmedPieces"], ["estimated", "estimatedPieces"]] as const) {
    if (value.selectedSources.every(row => Number.isSafeInteger(row.pieces))
      && value.selectedSources.filter(row => row.evidence === evidence).reduce((sum, row) => sum + BigInt(row.pieces), BigInt(0)) !== BigInt(value.coverage[field]))
      context.addIssue({ code: "custom", path: ["coverage", field], message: "Source authority must match the declared quantity coverage." });
  }
  if (value.shipmentMills !== null && (value.shipmentCostCoverage === "awaiting_source"
    || value.shipmentShares.some(row => row.allocatedMills === null || !Number.isSafeInteger(row.allocatedMills) || row.currency !== value.scope.currency)
    || value.shipmentShares.reduce((sum, row) => sum + BigInt(Number.isSafeInteger(row.allocatedMills) ? row.allocatedMills! : 0), BigInt(0)) !== BigInt(value.shipmentMills)))
    context.addIssue({ code: "custom", path: ["shipmentMills"], message: "Shipment totals require complete saved shares in the purchase currency." });
  if (new Set(value.application.applicationIds).size !== value.application.applicationIds.length)
    context.addIssue({ code: "custom", path: ["application", "applicationIds"], message: "Application references must be unique." });
  if (value.supplier !== null) {
    if (BigInt(value.coverage.confirmedPieces) + BigInt(value.coverage.estimatedPieces) !== BigInt(value.scope.basePieces))
      context.addIssue({ code: "custom", path: ["supplier"], message: "A complete supplier total requires coverage of the whole monetary scope." });
    const fields = ["documentMills", "goodsMills", "inventoryAdjustmentsMills", "excludedAdjustmentsMills", "unclassifiedAdjustmentsMills"] as const;
    for (const field of fields) if (Number.isSafeInteger(value.supplier[field]) && value.selectedSources.every(row => Number.isSafeInteger(row.amount[field]))
      && value.selectedSources.reduce((sum, row) => sum + BigInt(row.amount[field]), BigInt(0)) !== BigInt(value.supplier[field]))
      context.addIssue({ code: "custom", path: ["supplier", field], message: "The supplier summary must equal its selected source amounts." });
    for (const field of ["productMills", "packagingMills", "includedMills"] as const) {
      const amounts = value.selectedSources.map(row => row.amount[field]);
      const known = amounts.every((amount): amount is number => amount !== null && Number.isSafeInteger(amount));
      if (known ? value.supplier[field] === null || !Number.isSafeInteger(value.supplier[field])
          || amounts.reduce((sum, amount) => sum + BigInt(amount!), BigInt(0)) !== BigInt(value.supplier[field]!)
        : value.supplier[field] !== null)
        context.addIssue({ code: "custom", path: ["supplier", field], message: "Known and unknown supplier amounts must agree with the selected evidence." });
    }
  }
});

export type PurchaseCostAuthorityInput = z.infer<typeof purchaseCostAuthorityInputSchema>;
export type PurchaseCostAuthority = z.infer<typeof purchaseCostAuthoritySchema>;
export type PurchaseCostAmount = z.infer<typeof purchaseCostAmountSchema>;
export type PurchaseCostAmountProjection = z.infer<typeof purchaseCostAmountProjectionSchema>;
export type PurchaseCostInvoice = z.infer<typeof purchaseCostInvoiceSchema>;
