import { createHash } from "node:crypto";
import { z } from "zod";
import { PO_LINE_TYPES } from "@shared/procurement/po-line-type";
import { PO_PHYSICAL_STATUSES } from "@shared/schema/procurement.schema";
import { canonicalJson } from "@shared/utils/canonical-json";
import { normalizePoLinePricing, type PoLinePricingInput } from "@shared/utils/po-line-pricing";

export class SupplierPoDocumentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) { super(message); this.name = "SupplierPoDocumentError"; }
}

const money = z.number().int().safe();
const nonnegative = money.nonnegative();
const positive = money.positive();
const text = z.string().nullable();
const date = z.union([z.date(), z.string().datetime({ offset: true })])
  .transform((value, context) => {
    const parsed = value instanceof Date ? value : new Date(value);
    // A supplier date must be a real recorded instant. Do not let Date repair
    // an impossible calendar day, or throw an unclassified RangeError.
    const calendarDate = typeof value === "string" ? value.slice(0, 10) : null;
    const calendar = calendarDate === null ? null : new Date(`${calendarDate}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || (calendar !== null &&
        (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== calendarDate))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Recorded date is invalid." });
      return z.NEVER;
    }
    return parsed.toISOString();
  });
const nullableDate = date.nullable();
const lineStatus = z.enum(["open", "partially_received", "received", "closed", "cancelled"]);
const pricingBasis = z.enum(["legacy_unknown", "not_applicable", "per_piece", "per_purchase_uom", "extended_total"]);

// Deliberate allowlist. Parsing strips unselected source fields before any
// supplier projection or hash is built, including all private notes/metadata.
const headerSchema = z.object({
  id: positive, poNumber: z.string().trim().min(1), vendorId: positive,
  status: z.enum(["draft", "pending_approval", "approved", "sent", "acknowledged", "partially_received", "received", "closed", "cancelled"]),
  physicalStatus: z.enum(PO_PHYSICAL_STATUSES), revisionNumber: nonnegative,
  currency: z.literal("USD"), subtotalCents: money, discountCents: nonnegative,
  taxCents: nonnegative, shippingCostCents: nonnegative, totalCents: nonnegative,
  createdAt: date, updatedAt: date, orderDate: nullableDate, expectedDeliveryDate: nullableDate,
  paymentTermsType: text, paymentTermsDays: nonnegative.nullable(),
  shipToAddress: text, vendorContactName: text, vendorContactEmail: text,
  vendorNotes: text, referenceNumber: text, incoterms: text,
});
const lineIdentitySchema = z.object({ id: positive, purchaseOrderId: positive, status: lineStatus });
const lineSourceSchema = lineIdentitySchema.extend({
  lineNumber: positive, lineType: z.enum(PO_LINE_TYPES), productId: positive.nullable(), parentLineId: positive.nullable(),
  sku: text, vendorSku: text, productName: text, description: text, orderQty: positive,
  unitCostCents: money, unitCostMills: money.nullable(),
  totalProductCostCents: money, packagingCostCents: money,
  discountCents: money, taxCents: money, lineTotalCents: money,
  pricingBasis, purchaseUom: text, purchaseUomQuantity: positive.nullable(),
  piecesPerPurchaseUom: positive.nullable(), quotedUnitCostMills: nonnegative.nullable(),
  quotedTotalCents: nonnegative.nullable(), pricingRemainderMills: money,
});
const vendorSchema = z.object({
  id: positive, name: z.string().trim().min(1), address: text, country: text,
  contactName: text, email: text, phone: text,
});
const warehouseSchema = z.object({
  name: z.string().trim().min(1), address: text, city: text, state: text, postalCode: text, country: text,
});
const inputSchema = z.object({
  po: headerSchema, lines: z.array(z.unknown()), vendor: vendorSchema,
  warehouse: warehouseSchema.nullish(),
  companyName: z.string().nullish(), companyAddress: z.string().nullish(),
  companyCity: z.string().nullish(), companyState: z.string().nullish(),
  companyPostalCode: z.string().nullish(), companyCountry: z.string().nullish(),
});
const addressSchema = z.object({
  name: z.string(), addressLines: z.array(z.string()), contactName: text, email: text, phone: text,
}).strict();
const projectedLineSchema = z.object({
  id: positive, lineNumber: positive, lineType: z.enum(PO_LINE_TYPES), appliesToLineNumber: positive.nullable(),
  sku: text, vendorSku: text, productName: text, description: text, quantityPieces: positive,
  pricing: z.object({
    basis: pricingBasis, quantity: positive, unitLabel: z.string(), unitCostMills: money.nullable(),
    quotedTotalCents: nonnegative.nullable(), piecesPerPurchaseUom: positive.nullable(),
  }).strict(),
  productAmountCents: money, packagingCents: money, discountCents: money, taxCents: money, totalCents: money,
}).strict();
const documentContentSchema = z.object({
  contractVersion: z.literal(1), purchaseOrderId: positive, poNumber: z.string(), revisionNumber: nonnegative,
  sourceUpdatedAt: date, purpose: z.enum(["draft_preview", "current_copy"]),
  purposeLabel: z.string(), notice: z.string(), currency: z.literal("USD"),
  createdAt: date, orderDate: nullableDate, expectedDeliveryDate: nullableDate,
  paymentTerms: text, referenceNumber: text, incoterms: text,
  company: addressSchema, vendor: addressSchema, shipTo: addressSchema,
  lines: z.array(projectedLineSchema),
  totals: z.object({ subtotalCents: money, discountCents: nonnegative, taxCents: nonnegative,
    shippingCents: nonnegative, totalCents: nonnegative }).strict(),
  vendorNotes: text,
}).strict();
export const supplierPoDocumentSchema = documentContentSchema.extend({ sourceRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type SupplierPoDocument = z.infer<typeof supplierPoDocumentSchema>;
type SourceLine = z.infer<typeof lineSourceSchema>;

function invalid(message: string, context: Readonly<Record<string, unknown>> = {}): never {
  throw new SupplierPoDocumentError("INVALID_SUPPLIER_DOCUMENT_SOURCE", `${message} Review the saved PO before producing a supplier document.`, 409, context);
}
function parseSource<Schema extends z.ZodTypeAny>(schema: Schema, source: unknown): z.output<Schema> {
  const result = schema.safeParse(source);
  if (!result.success) invalid("Required supplier-document data is missing or invalid.", {
    fields: result.error.issues.map(issue => issue.path.join(".")),
  });
  return result.data;
}
function assertSameAmount(actual: number, expected: bigint, field: string, lineId?: number): void {
  if (BigInt(actual) !== expected) {
    throw new SupplierPoDocumentError("SUPPLIER_DOCUMENT_TOTAL_MISMATCH",
      "Recorded PO amounts do not reconcile. Review the saved amounts before producing a supplier document.",
      409, { field, ...(lineId === undefined ? {} : { lineId }) });
  }
}
function quoteInput(line: SourceLine): PoLinePricingInput | null {
  if (line.pricingBasis === "legacy_unknown" || line.pricingBasis === "not_applicable") return null;
  if (line.pricingBasis === "per_piece") {
    if (line.quotedUnitCostMills === null) invalid("The per-piece quote is missing.", { lineId: line.id });
    return { basis: "per_piece", quantityPieces: line.orderQty, unitCostMills: line.quotedUnitCostMills };
  }
  if (line.pricingBasis === "extended_total") {
    if (line.quotedTotalCents === null) invalid("The extended quote is missing.", { lineId: line.id });
    return { basis: "extended_total", quantityPieces: line.orderQty, quotedTotalCents: line.quotedTotalCents };
  }
  if (!line.purchaseUom || line.purchaseUomQuantity === null || line.piecesPerPurchaseUom === null || line.quotedUnitCostMills === null) {
    invalid("The purchase-unit quote is incomplete.", { lineId: line.id });
  }
  return { basis: "per_purchase_uom", purchaseUom: line.purchaseUom, uomQuantity: line.purchaseUomQuantity,
    piecesPerUom: line.piecesPerPurchaseUom, quotedCostMillsPerUom: line.quotedUnitCostMills };
}
function validateLine(line: SourceLine): void {
  const isProduct = line.lineType === "product";
  if (isProduct !== (line.productId !== null) || (isProduct && line.pricingBasis === "not_applicable") ||
      (!isProduct && line.pricingBasis !== "not_applicable")) invalid("The line type and product/quote identity disagree.", { lineId: line.id });
  if (isProduct && !line.productName?.trim() && !line.description?.trim() && !line.sku?.trim()) {
    invalid("A product line has no recorded description or SKU.", { lineId: line.id });
  }
  if (!isProduct && !line.description?.trim()) invalid("A commercial charge has no description.", { lineId: line.id });
  if (!["product", "fee"].includes(line.lineType) && line.orderQty !== 1) invalid("The commercial adjustment quantity is invalid.", { lineId: line.id });
  if ((["product", "fee", "tax"].includes(line.lineType) && line.lineTotalCents < 0) ||
      (["discount", "rebate"].includes(line.lineType) && line.lineTotalCents > 0)) invalid("The signed line amount disagrees with its type.", { lineId: line.id });
  if (isProduct) {
    if ([line.totalProductCostCents, line.packagingCostCents, line.discountCents, line.taxCents, line.unitCostCents, line.unitCostMills ?? 0].some(amount => amount < 0)) {
      invalid("A product cost component is negative.", { lineId: line.id });
    }
    // Validate recorded components; rendering must never reprice or repair history.
    assertSameAmount(line.lineTotalCents, BigInt(line.totalProductCostCents) + BigInt(line.packagingCostCents)
      - BigInt(line.discountCents) + BigInt(line.taxCents), "lineTotalCents", line.id);
  }
  const quote = quoteInput(line);
  if (!quote) {
    if ([line.purchaseUom, line.purchaseUomQuantity, line.piecesPerPurchaseUom, line.quotedUnitCostMills, line.quotedTotalCents].some(value => value !== null) || line.pricingRemainderMills !== 0) {
      invalid("Unclassified pricing contains explicit quote fields.", { lineId: line.id });
    }
    return;
  }
  let normalized: ReturnType<typeof normalizePoLinePricing>;
  try { normalized = normalizePoLinePricing(quote); }
  catch { invalid("The recorded quote cannot be normalized safely.", { lineId: line.id }); }
  const keys = ["orderQty", "purchaseUom", "purchaseUomQuantity", "piecesPerPurchaseUom", "quotedUnitCostMills", "quotedTotalCents",
    "unitCostMills", "unitCostCents", "totalProductCostCents", "pricingRemainderMills"] as const;
  if (keys.some(key => normalized[key] !== line[key])) invalid("The recorded quote and its normalized amounts disagree.", { lineId: line.id });
}
function parentLineNumber(line: SourceLine, activeLines: ReadonlyMap<number, SourceLine>): number | null {
  if (line.parentLineId === null) return null;
  if (line.lineType === "product") invalid("A product line cannot target another PO line.", { lineId: line.id });
  const parent = activeLines.get(line.parentLineId);
  if (!parent || parent.lineType !== "product" || parent.purchaseOrderId !== line.purchaseOrderId) {
    invalid("The commercial adjustment must target an active product line on the same PO.", {
      lineId: line.id, parentLineId: line.parentLineId,
    });
  }
  return parent.lineNumber;
}
function projectLine(line: SourceLine, appliesToLineNumber: number | null): SupplierPoDocument["lines"][number] {
  validateLine(line);
  // Purchase UOM is explicitly separate from receiving configuration. An
  // extended/legacy total has no invented quoted unit price.
  const byUom = line.pricingBasis === "per_purchase_uom";
  const unitCostMills = line.pricingBasis === "per_piece" || byUom ? line.quotedUnitCostMills : null;
  return {
    id: line.id, lineNumber: line.lineNumber, lineType: line.lineType, appliesToLineNumber, sku: line.sku, vendorSku: line.vendorSku,
    productName: line.productName, description: line.description, quantityPieces: line.orderQty,
    pricing: { basis: line.pricingBasis, quantity: byUom ? line.purchaseUomQuantity! : line.orderQty,
      unitLabel: byUom ? line.purchaseUom! : line.lineType === "product" ? "pieces" : "charge units",
      unitCostMills, quotedTotalCents: line.quotedTotalCents, piecesPerPurchaseUom: byUom ? line.piecesPerPurchaseUom : null },
    productAmountCents: line.totalProductCostCents, packagingCents: line.packagingCostCents,
    discountCents: line.discountCents, taxCents: line.taxCents, totalCents: line.lineTotalCents,
  };
}
function addressLines(...values: (string | null | undefined)[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}
function paymentTerms(type: string | null, days: number | null): string | null {
  if (type === "net") return days === null ? "Net (days not recorded)" : `Net ${days} days`;
  const labels: Readonly<Record<string, string>> = { cod: "Cash on delivery", prepaid: "Prepaid", cia: "Cash in advance" };
  if (type) return labels[type] ?? (days === null ? type : `${type} (${days} days)`);
  return days === null ? null : `${days} days (payment type not recorded)`;
}

/** Produces a current commercial record, never a reconstructed original issue
 * or proof of approval/dispatch. The content identity changes with external terms. */
export function buildSupplierPoDocument(input: unknown): SupplierPoDocument {
  // Cancellation preserves a historical header amount while cancelling open
  // lines. Neither its former offer nor its current active total can safely be
  // reconstructed by adding arbitrary cancelled rows to this current read.
  const lifecycle = parseSource(z.object({
    po: headerSchema.pick({ id: true, status: true, physicalStatus: true }),
  }), input);
  if (lifecycle.po.status === "cancelled" || lifecycle.po.physicalStatus === "cancelled") {
    throw new SupplierPoDocumentError(
      "PURCHASE_ORDER_DOCUMENT_CANCELLED",
      "This PO is cancelled. A current supplier order cannot be generated; use a previously saved issued document for historical evidence.",
      409,
      { purchaseOrderId: lifecycle.po.id },
    );
  }
  const source = parseSource(inputSchema, input);
  const { po, vendor, warehouse } = source;
  if (vendor.id !== po.vendorId) invalid("The vendor does not belong to this PO.");
  const ids = new Set<number>();
  const lineNumbers = new Set<number>();
  const lines: SourceLine[] = [];
  for (const raw of source.lines) {
    const identity = parseSource(lineIdentitySchema, raw);
    if (identity.purchaseOrderId !== po.id || ids.has(identity.id)) invalid("PO line identity is inconsistent.", { lineId: identity.id });
    ids.add(identity.id);
    if (identity.status === "cancelled") continue;
    const line = parseSource(lineSourceSchema, raw);
    if (lineNumbers.has(line.lineNumber)) invalid("Active PO line numbers are duplicated.", { lineId: line.id });
    lineNumbers.add(line.lineNumber);
    lines.push(line);
  }
  lines.sort((left, right) => left.lineNumber - right.lineNumber || left.id - right.id);
  const activeLines = new Map(lines.map(line => [line.id, line]));
  const projectedLines = lines.map(line => projectLine(line, parentLineNumber(line, activeLines)));
  const subtotal = lines.reduce((sum, line) => sum + BigInt(line.lineTotalCents), BigInt(0));
  assertSameAmount(po.subtotalCents, subtotal, "subtotalCents");
  assertSameAmount(po.totalCents, subtotal - BigInt(po.discountCents) + BigInt(po.taxCents) + BigInt(po.shippingCostCents), "totalCents");
  const purpose = ["draft", "pending_approval"].includes(po.status) ? "draft_preview" : "current_copy";
  const purposeLabels = { draft_preview: "DRAFT PREVIEW", current_copy: "CURRENT COMMERCIAL COPY" } as const;
  const notices = {
    draft_preview: "For review only. This draft is not an instruction to supply goods.",
    current_copy: "Current recorded terms for the revision shown. This copy is not a new order or proof of dispatch or supplier acknowledgement. It does not reconstruct an earlier issued document.",
  } as const;
  const company = { name: source.companyName?.trim() || "Your Company",
    addressLines: addressLines(source.companyAddress, addressLines(source.companyCity, source.companyState, source.companyPostalCode, source.companyCountry).join(", ")),
    contactName: null, email: null, phone: null };
  const shipTo = { name: warehouse?.name ?? "Delivery address", addressLines: po.shipToAddress?.trim()
    ? [po.shipToAddress] : warehouse ? addressLines(warehouse.address, addressLines(warehouse.city, warehouse.state, warehouse.postalCode, warehouse.country).join(", ")) : [],
    contactName: null, email: null, phone: null };
  const content = documentContentSchema.parse({
    contractVersion: 1, purchaseOrderId: po.id, poNumber: po.poNumber, revisionNumber: po.revisionNumber,
    sourceUpdatedAt: po.updatedAt, purpose, purposeLabel: purposeLabels[purpose], notice: notices[purpose], currency: po.currency,
    createdAt: po.createdAt, orderDate: po.orderDate, expectedDeliveryDate: po.expectedDeliveryDate,
    paymentTerms: paymentTerms(po.paymentTermsType, po.paymentTermsDays), referenceNumber: po.referenceNumber, incoterms: po.incoterms,
    company, vendor: { name: vendor.name, addressLines: addressLines(vendor.address, vendor.country),
      contactName: po.vendorContactName || vendor.contactName, email: po.vendorContactEmail || vendor.email, phone: vendor.phone },
    shipTo, lines: projectedLines,
    totals: { subtotalCents: po.subtotalCents, discountCents: po.discountCents, taxCents: po.taxCents, shippingCents: po.shippingCostCents, totalCents: po.totalCents },
    vendorNotes: po.vendorNotes,
  });
  return supplierPoDocumentSchema.parse({ ...content, sourceRevision: createHash("sha256").update(canonicalJson(content)).digest("hex") });
}
