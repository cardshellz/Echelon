import { z } from "zod";
import type { purchaseOrders, purchaseOrderLines, vendorInvoices, vendorInvoiceLines } from "@shared/schema/procurement.schema";
import type { PurchaseApprovalActor } from "../identity/domain/purchase-approval-authority";
import { SYSTEM_ROLES } from "../identity/domain/identity.domain";
import { normalizePoLinePricing, type PoLinePricingInput } from "@shared/utils/po-line-pricing";
import { evaluatePurchaseOrderInvoiceMatches } from "./purchase-order-invoice-match";
import {
  poQuantityAmendmentContextSchema, poQuantityAmendmentPreviewSchema,
  poLineAmountCents,
  type PoQuantityAmendmentPreview, type PoQuantityPreviewRequest,
} from "@shared/procurement/po-quantity-amendment";

export class PoQuantityAmendmentError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 409) { super(message); }
}
export type AmendmentHeader = typeof purchaseOrders.$inferSelect;
export type AmendmentLine = typeof purchaseOrderLines.$inferSelect;
export type AmendmentInvoice = typeof vendorInvoices.$inferSelect;
export type AmendmentInvoiceLine = typeof vendorInvoiceLines.$inferSelect;
export type AmendmentFacts = {
  header: AmendmentHeader;
  lines: AmendmentLine[];
  invoices: AmendmentInvoice[];
  invoiceLines: AmendmentInvoiceLine[];
  recommendationOwned: boolean;
};
export type AmendmentLinePatch = Pick<AmendmentLine,
  "orderQty" | "pricingBasis" | "pricingSource" | "purchaseUom" | "purchaseUomQuantity" |
  "piecesPerPurchaseUom" | "quotedUnitCostMills" | "quotedTotalCents" | "pricingRemainderMills" |
  "unitCostMills" | "unitCostCents" | "totalProductCostCents" | "lineTotalCents" | "status"> &
  Partial<Pick<AmendmentLine, "packagingCostCents" | "discountCents" | "taxCents">>;
export type AmendmentPlan = { preview: PoQuantityAmendmentPreview; patches: { id: number; patch: AmendmentLinePatch }[]; subtotalCents: number; receivedLineCount: number };

/** Lifecycle approval coverage compares approvedAt to every line version. Keep
 * this revision's timestamp monotonic even if two commands share a clock tick. */
export function quantityAmendmentTimestamp(facts: AmendmentFacts, clockValue: Date): Date {
  const versions = [facts.header.updatedAt, ...facts.lines.map((line) => line.updatedAt)];
  const latestVersion = Math.max(...versions.map((date) => z.date().parse(date).getTime()));
  return z.date().parse(new Date(Math.max(z.date().parse(clockValue).getTime(), latestVersion + 1)));
}

const integer = z.number().int().nonnegative().safe();
function stored(value: unknown, field: string): number {
  const parsed = integer.safeParse(value);
  if (!parsed.success) throw new PoQuantityAmendmentError(`Recorded ${field} is invalid. Review the source evidence first.`, "PO_AMENDMENT_SOURCE_INVALID");
  return parsed.data;
}
function safeAmount(value: bigint): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PoQuantityAmendmentError("The resulting amount is outside the supported range.", "PO_AMENDMENT_AMOUNT_INVALID", 400);
  }
  return Number(value);
}
export function hasQuantityAmendmentAuthority(actor: PurchaseApprovalActor): boolean {
  return actor.active && actor.approvalGrantIds.length > 0 && actor.roles.some((role) => role.isSystem && role.name === SYSTEM_ROLES.admin.name);
}
export function assertQuantityAmendmentAuthority(actor: PurchaseApprovalActor): void {
  if (!hasQuantityAmendmentAuthority(actor)) throw new PoQuantityAmendmentError("A current Administrator with purchasing approval permission must approve this correction.", "PO_AMENDMENT_ADMIN_REQUIRED", 403);
}
export function quantityAmendmentBlockedReason(facts: AmendmentFacts): string | null {
  if (facts.recommendationOwned) return "This PO belongs to an accepted purchasing recommendation. Its accepted quantities and prices are immutable.";
  if (!["approved", "sent", "acknowledged", "partially_received", "received"].includes(facts.header.status)) {
    return "PO edits are available on approved, sent, acknowledged, partially received and received POs. Use the normal editor for a draft PO.";
  }
  if (facts.header.closedAt || facts.header.cancelledAt || ["closed", "cancelled", "short_closed"].includes(facts.header.physicalStatus)) return "Closed or cancelled POs cannot be amended.";
  return null;
}
function lineBlockedReason(line: AmendmentLine, lines: AmendmentLine[]): string | null {
  if (line.lineType !== "product" && line.orderQty <= 0) return "This charge has an invalid recorded quantity. Review its source first.";
  if (line.lineType === "product" && line.productId === null) return "This product line has no linked product. Review its source first.";
  if (!["open", "partially_received", "received"].includes(line.status)) return "Closed or cancelled lines cannot be amended.";
  if (line.parentLineId !== null || lines.some((child) => child.parentLineId === line.id && child.status !== "cancelled")) return "This line has dependent adjustments. Review those adjustments before correcting quantity.";
  if ((line.cancelledQty ?? 0) !== 0 || (line.returnedQty ?? 0) !== 0) return "This line has cancellations or returns. Correct those records through their owning workflow.";
  return null;
}
function unitMills(line: AmendmentLine): number {
  if (line.lineType !== "product") return z.number().int().safe().parse(line.unitCostMills ?? Number(BigInt(z.number().int().safe().parse(line.unitCostCents)) * BigInt(100)));
  return line.unitCostMills === null ? safeAmount(BigInt(stored(line.unitCostCents, "unit cost")) * BigInt(100)) : stored(line.unitCostMills, "unit cost");
}
function componentTotal(line: AmendmentLine): number {
  if (line.lineType !== "product") return z.number().int().safe().parse(line.lineTotalCents);
  return z.number().int().safe().parse(Number(BigInt(stored(line.totalProductCostCents, "product amount")) + BigInt(stored(line.packagingCostCents, "packaging amount"))
    - BigInt(stored(line.discountCents, "discount")) + BigInt(stored(line.taxCents, "tax"))));
}
function recordedPricing(line: AmendmentLine): PoLinePricingInput | null {
  if (line.lineType !== "product" || line.orderQty === 0) return null;
  if (line.pricingBasis === "per_purchase_uom") return { basis: "per_purchase_uom", purchaseUom: line.purchaseUom!,
    uomQuantity: stored(line.purchaseUomQuantity, "purchase UOM quantity"), piecesPerUom: stored(line.piecesPerPurchaseUom, "pieces per UOM"), quotedCostMillsPerUom: stored(line.quotedUnitCostMills, "quoted price") };
  if (line.pricingBasis === "extended_total") return { basis: "extended_total", quantityPieces: line.orderQty, quotedTotalCents: stored(line.quotedTotalCents, "quoted product total") };
  return { basis: "per_piece", quantityPieces: line.orderQty, unitCostMills: line.pricingBasis === "per_piece" ? stored(line.quotedUnitCostMills, "quoted price") : unitMills(line) };
}
function lineView(line: AmendmentLine, facts: AmendmentFacts) {
  const invoicedQty = facts.invoiceLines.filter((invoiceLine) => invoiceLine.purchaseOrderLineId === line.id)
    .reduce((sum, invoiceLine) => sum + BigInt(stored(invoiceLine.qtyInvoiced, "invoice quantity")), BigInt(0));
  return {
    id: line.id, lineNumber: line.lineNumber, name: line.productName || line.sku || `Line ${line.lineNumber}`,
    orderQty: stored(line.orderQty, "ordered quantity"), receivedQty: stored(line.receivedQty ?? 0, "received quantity"),
    invoicedQty: safeAmount(invoicedQty), unitCostMills: unitMills(line),
    totalProductCostCents: stored(line.totalProductCostCents, "product amount"),
    packagingCostCents: stored(line.packagingCostCents, "packaging amount"), discountCents: stored(line.discountCents, "discount"), taxCents: stored(line.taxCents, "tax"),
    componentTotalCents: componentTotal(line), lineType: line.lineType, pricing: recordedPricing(line),
    lineTotalCents: z.number().int().safe().parse(line.lineTotalCents), status: line.status, blockedReason: lineBlockedReason(line, facts.lines),
  };
}
export function buildQuantityAmendmentContext(facts: AmendmentFacts, actor: PurchaseApprovalActor, sourceVersion: string) {
  return poQuantityAmendmentContextSchema.parse({
    purchaseOrderId: facts.header.id, currency: facts.header.currency ?? "USD", sourceVersion,
    canApprove: hasQuantityAmendmentAuthority(actor), blockedReason: quantityAmendmentBlockedReason(facts),
    lines: facts.lines.map((line) => lineView(line, facts)),
  });
}
function correctedPricing(line: AmendmentLine, quantityPieces: number, treatment: string) {
  let pricing: PoLinePricingInput;
  if (treatment === "keep_product_total") {
    pricing = { basis: "extended_total", quantityPieces, quotedTotalCents: stored(line.totalProductCostCents, "product amount") };
  } else if (line.pricingBasis === "per_purchase_uom") {
    const piecesPerUom = stored(line.piecesPerPurchaseUom, "pieces per purchase UOM");
    if (!piecesPerUom || quantityPieces % piecesPerUom !== 0 || !line.purchaseUom) throw new PoQuantityAmendmentError("Quantity must be a whole number of the quoted purchase UOM to keep its rate.", "PO_AMENDMENT_PURCHASE_UOM_INVALID", 400);
    pricing = { basis: "per_purchase_uom", purchaseUom: line.purchaseUom, uomQuantity: quantityPieces / piecesPerUom, piecesPerUom, quotedCostMillsPerUom: stored(line.quotedUnitCostMills, "quoted UOM rate") };
  } else {
    pricing = { basis: "per_piece", quantityPieces, unitCostMills: line.pricingBasis === "per_piece" ? stored(line.quotedUnitCostMills, "quoted piece rate") : unitMills(line) };
  }
  try { return normalizePoLinePricing(pricing); }
  catch (error) { throw new PoQuantityAmendmentError(error instanceof Error ? error.message : "Invalid price calculation.", "PO_AMENDMENT_PRICING_INVALID", 400); }
}
/** Changes only commercial quantities/economics and their status projection.
 * Posted receipts, AP economics and inventory cost evidence remain independently owned. */
export function planQuantityAmendment(facts: AmendmentFacts, request: PoQuantityPreviewRequest): AmendmentPlan {
  const blocked = quantityAmendmentBlockedReason(facts);
  if (blocked) throw new PoQuantityAmendmentError(blocked, "PO_AMENDMENT_BLOCKED");
  const oldSubtotal = facts.lines.filter((line) => line.status !== "cancelled").reduce((sum, line) => sum + BigInt(z.number().int().safe().parse(line.lineTotalCents)), BigInt(0));
  const oldTotal = oldSubtotal - BigInt(stored(facts.header.discountCents, "PO discount")) + BigInt(stored(facts.header.taxCents, "PO tax")) + BigInt(stored(facts.header.shippingCostCents, "PO freight"));
  if (oldSubtotal !== BigInt(stored(facts.header.subtotalCents, "PO subtotal")) || oldTotal !== BigInt(stored(facts.header.totalCents, "PO total"))) throw new PoQuantityAmendmentError("Recorded PO amounts do not reconcile. Review the cost evidence before correcting quantity.", "PO_AMENDMENT_SOURCE_INVALID");
  const warnings = new Set<string>([
    "Receipt quantities, inventory quantities and recorded inventory costs stay unchanged.",
    "Invoice amounts, invoice quantities and payments stay unchanged. Remaining match issues require separate review.",
    "Review product, packaging, discount and tax against the supplier document; no missing cost component is guessed.",
    "Changed product costs require a separate inventory cost review. This approval does not revalue stock or COGS.",
    "Previous three-way match variance approvals are superseded; any remaining variance requires a new review.",
  ]);
  const patches = request.changes.map((change) => {
    const line = facts.lines.find((candidate) => candidate.id === change.lineId);
    if (!line) throw new PoQuantityAmendmentError("The selected line does not belong to this PO.", "PO_AMENDMENT_LINE_NOT_FOUND", 404);
    const reason = lineBlockedReason(line, facts.lines);
    if (reason) throw new PoQuantityAmendmentError(reason, "PO_AMENDMENT_LINE_BLOCKED");
    if (change.priceTreatment === "edit_charge") {
      if (line.lineType === "product") throw new PoQuantityAmendmentError("Product lines require product and packaging pricing.", "PO_AMENDMENT_PRICING_INVALID", 400);
      const amount = change.chargeTotalCents!;
      if (change.quantityPieces !== line.orderQty) throw new PoQuantityAmendmentError("A charge correction must preserve its recorded quantity.", "PO_AMENDMENT_PRICING_INVALID", 400);
      if ((["discount", "rebate"].includes(line.lineType) && amount > 0) || (["fee", "tax"].includes(line.lineType) && amount < 0)) throw new PoQuantityAmendmentError("Enter a negative amount for a credit or discount, and a positive amount for a fee or tax.", "PO_AMENDMENT_PRICING_INVALID", 400);
      // Preserve charge identity/quantity. Its exact signed total is the
      // document amount; unit mirrors use deterministic rounding only.
      const magnitude = BigInt(amount < 0 ? -amount : amount) * BigInt(100);
      const denominator = BigInt(stored(line.orderQty, "charge quantity"));
      if (denominator === BigInt(0)) throw new PoQuantityAmendmentError("The charge quantity is invalid.", "PO_AMENDMENT_SOURCE_INVALID");
      const unsignedMills = (magnitude * BigInt(2) + denominator) / (denominator * BigInt(2));
      const mills = amount < 0 ? -unsignedMills : unsignedMills;
      const cents = (unsignedMills + BigInt(50)) / BigInt(100);
      if (unsignedMills > BigInt(Number.MAX_SAFE_INTEGER)) throw new PoQuantityAmendmentError("The charge exceeds the supported limit.", "PO_AMENDMENT_AMOUNT_INVALID", 400);
      if (amount === line.lineTotalCents) throw new PoQuantityAmendmentError("Change a line value before approving.", "PO_AMENDMENT_NO_CHANGE", 400);
      return { id: line.id, patch: { orderQty: line.orderQty, pricingBasis: "not_applicable", pricingSource: "manual", purchaseUom: null, purchaseUomQuantity: null,
        piecesPerPurchaseUom: null, quotedUnitCostMills: null, quotedTotalCents: null, pricingRemainderMills: 0,
        unitCostMills: Number(mills), unitCostCents: Number(amount < 0 ? -cents : cents), totalProductCostCents: 0, packagingCostCents: 0, discountCents: 0, taxCents: 0,
        lineTotalCents: amount, status: line.status } satisfies AmendmentLinePatch };
    }
    if (line.lineType !== "product") throw new PoQuantityAmendmentError("Use a charge correction for this line.", "PO_AMENDMENT_LINE_BLOCKED");
    if (line.orderQty === change.quantityPieces && change.priceTreatment !== "edit_line") throw new PoQuantityAmendmentError("Enter a quantity different from the recorded quantity.", "PO_AMENDMENT_NO_CHANGE", 400);
    const product = stored(line.totalProductCostCents, "product amount");
    const packaging = change.packagingCostCents ?? stored(line.packagingCostCents, "packaging amount");
    const discount = change.discountCents ?? stored(line.discountCents, "discount amount");
    const tax = change.taxCents ?? stored(line.taxCents, "tax amount");
    if (componentTotal(line) !== line.lineTotalCents) {
      if (change.priceTreatment !== "edit_line") throw new PoQuantityAmendmentError("Recorded line amounts do not reconcile. Review all line amounts in the line editor.", "PO_AMENDMENT_SOURCE_INVALID");
      warnings.add(`Line ${line.lineNumber}'s recorded total differs from its cost components. This approval replaces that inconsistent total with the reviewed components.`);
    }
    let price;
    try { price = change.priceTreatment === "edit_line" ? normalizePoLinePricing(change.pricing!) : correctedPricing(line, change.quantityPieces, change.priceTreatment); }
    catch (error) { if (error instanceof PoQuantityAmendmentError) throw error; throw new PoQuantityAmendmentError(error instanceof Error ? error.message : "Invalid pricing.", "PO_AMENDMENT_PRICING_INVALID", 400); }
    if (price.orderQty !== change.quantityPieces) throw new PoQuantityAmendmentError("The purchase-unit pricing must match the corrected piece quantity.", "PO_AMENDMENT_PURCHASE_UOM_INVALID", 400);
    const { quotedExtendedMills: _exactQuote, ...normalized } = price;
    const received = stored(line.receivedQty ?? 0, "received quantity");
    if (received > change.quantityPieces) warnings.add(`Line ${line.lineNumber} remains over-received: ${received} received against ${change.quantityPieces} ordered.`);
    if (["legacy_unknown", "extended_total"].includes(line.pricingBasis) && change.priceTreatment === "keep_quoted_rate") warnings.add(`Line ${line.lineNumber} uses the recorded normalized piece rate; its original piece quote was not recorded.`);
    let lineTotalCents: number;
    try { lineTotalCents = poLineAmountCents(normalized.totalProductCostCents, packaging, discount, tax); }
    catch { throw new PoQuantityAmendmentError("Product and packaging, minus discount, plus tax must produce a nonnegative supported line total.", "PO_AMENDMENT_AMOUNT_INVALID", 400); }
    const patch: AmendmentLinePatch = {
      ...normalized, pricingSource: "manual",
      ...(change.priceTreatment === "edit_line" ? { packagingCostCents: packaging, discountCents: discount, taxCents: tax } : {}),
      lineTotalCents,
      status: received >= change.quantityPieces ? "received" : received > 0 ? "partially_received" : "open",
    };
    if (change.quantityPieces === line.orderQty && normalized.totalProductCostCents === product && normalized.unitCostMills === unitMills(line)
      && packaging === line.packagingCostCents && discount === line.discountCents && tax === line.taxCents && patch.lineTotalCents === line.lineTotalCents) throw new PoQuantityAmendmentError("Change a quantity or amount before approving.", "PO_AMENDMENT_NO_CHANGE", 400);
    return { id: line.id, patch };
  });
  const afterLines = facts.lines.map((line) => ({ ...line, ...patches.find((change) => change.id === line.id)?.patch }));
  const activeLines = afterLines.filter((line) => line.status !== "cancelled");
  for (const line of activeLines) if (line.lineType === "product" && componentTotal(line) !== line.lineTotalCents) throw new PoQuantityAmendmentError(`Line ${line.lineNumber}'s amounts do not reconcile. Include that line in the reviewed correction.`, "PO_AMENDMENT_SOURCE_INVALID");
  const subtotal = activeLines.reduce((sum, line) => sum + BigInt(z.number().int().safe().parse(line.lineTotalCents)), BigInt(0));
  const total = subtotal - BigInt(stored(facts.header.discountCents, "PO discount")) + BigInt(stored(facts.header.taxCents, "PO tax")) + BigInt(stored(facts.header.shippingCostCents, "PO freight"));
  const products = activeLines.filter((line) => line.lineType === "product");
  const receivedLineCount = products.filter((line) => line.status === "received").length;
  const afterStatus = products.length > 0 && receivedLineCount === products.length ? "received"
    : products.some((line) => (line.receivedQty ?? 0) > 0) || facts.header.status === "received" ? "partially_received" : facts.header.status;
  const beforeMatches = evaluatePurchaseOrderInvoiceMatches({ purchaseOrderLines: facts.lines, invoiceLines: facts.invoiceLines });
  const afterMatches = evaluatePurchaseOrderInvoiceMatches({ purchaseOrderLines: afterLines, invoiceLines: facts.invoiceLines });
  const preview = poQuantityAmendmentPreviewSchema.parse({
    purchaseOrderId: facts.header.id, currency: facts.header.currency ?? "USD", sourceVersion: request.sourceVersion, reason: request.reason,
    lines: request.changes.map((change) => ({ before: lineView(facts.lines.find((line) => line.id === change.lineId)!, facts), after: lineView(afterLines.find((line) => line.id === change.lineId)!, { ...facts, lines: afterLines }), priceTreatment: change.priceTreatment })),
    beforeTotalCents: stored(facts.header.totalCents, "PO total"), afterTotalCents: safeAmount(total), beforeStatus: facts.header.status, afterStatus, warnings: [...warnings],
    invoiceMatches: afterMatches.map((match) => ({ invoiceId: match.vendorInvoiceId, invoiceLineId: match.id, before: beforeMatches.find((before) => before.id === match.id)!.matchStatus, after: match.matchStatus })),
  });
  return { preview, patches, subtotalCents: safeAmount(subtotal), receivedLineCount };
}
