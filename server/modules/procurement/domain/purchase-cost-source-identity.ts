import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { readIntegerMills } from "@shared/money-read";
import { MILLS_PER_CENT } from "@shared/utils/po-line-pricing";
import { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
import { isApprovedCostInvoiceStatus, purchaseCostAuthorityInputSchema, type PurchaseCostAuthorityInput } from "@shared/procurement/purchase-cost-authority";
import { costFingerprint } from "../../inventory/domain/cost-fingerprint";
import { projectPurchaseCostAuthority } from "./purchase-cost-authority";
import { resolvePurchaseCostSource } from "./purchase-cost-source";
import { verifiedStoredCostSource, type CostSourceProposal, type StoredCostSource } from "./cost-source-compatibility";

// PostgreSQL BIGINTs are captured as strings in old immutable evidence. Validate
// without coercing/replacing those captured values or changing their old hash.
const integer = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d{1,19}$/).refine(value => Number.isSafeInteger(Number(value)))]);
const positive = integer.refine(value => Number.isSafeInteger(Number(value)) && Number(value) > 0);
const sourceSchema = z.object({
  purchaseOrderLine: z.object({
    id: positive, purchase_order_id: positive, line_type: z.literal("product"), currency: z.literal("USD"),
    order_qty: positive, received_qty: integer, status: z.string().min(1),
    total_product_cost_cents: integer, packaging_cost_cents: integer,
    discount_cents: z.unknown().optional(), tax_cents: z.unknown().optional(),
  }).passthrough(),
  approvedInvoices: z.array(z.object({
    id: positive, vendor_invoice_id: positive, qty_invoiced: positive, line_total_cents: integer,
    currency: z.literal("USD"), cost_component_evidence: invoiceCostComponentEvidenceSchema,
    status: z.string().refine(isApprovedCostInvoiceStatus).optional(),
  }).passthrough()).min(1).max(1_000),
  // Credit/no-inventory-effect compatibility needs its own quantity proof. It
  // remains on the existing owner rather than being treated as an empty credit.
  supplierCredits: z.array(z.unknown()).max(0).optional(),
}).passthrough();

const unselectedQuoteFields = new Set([
  "order_qty", "received_qty", "status", "total_product_cost_cents", "packaging_cost_cents", "discount_cents", "tax_cents",
]);
const millsPerCent = BigInt(MILLS_PER_CENT);
type NormalizedConfirmedProposal = CostSourceProposal & { economicFingerprint: string };

function supportedAmounts(source: z.infer<typeof sourceSchema>): boolean {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if ([source.purchaseOrderLine.total_product_cost_cents, source.purchaseOrderLine.packaging_cost_cents]
    .some(value => BigInt(value) * millsPerCent > maximum)) return false;
  let document = BigInt(0), product = BigInt(0), packaging = BigInt(0);
  for (const row of source.approvedInvoices) {
    document += BigInt(row.line_total_cents) * millsPerCent;
    product += BigInt(row.cost_component_evidence.productMills);
    packaging += BigInt(row.cost_component_evidence.packagingMills);
  }
  return document <= maximum && product <= maximum && packaging <= maximum;
}

function authorityInput(source: z.infer<typeof sourceSchema>, basePieces: number): PurchaseCostAuthorityInput | null {
  const line = source.purchaseOrderLine;
  const invoices = source.approvedInvoices.map(row => {
    const evidence = row.cost_component_evidence;
    return {
      reference: { kind: "vendor_invoice_line" as const, documentId: Number(row.vendor_invoice_id), lineId: Number(row.id) },
      purchaseOrderLineId: Number(line.id), currency: row.currency, pieces: Number(row.qty_invoiced),
      // The captured approvedInvoices query and confirmed legacy contract prove
      // eligibility. Original invoice approval identity is not invented here.
      status: "approved" as const, receiptCoverage: null, sourceRevisionId: null, approval: null,
      amount: { documentTotalMills: readIntegerMills(BigInt(row.line_total_cents) * millsPerCent, "invoice document total"),
        goodsMills: evidence.productMills + evidence.packagingMills,
        breakdown: { productMills: evidence.productMills, packagingMills: evidence.packagingMills }, adjustments: [] },
    };
  });
  const parsed = purchaseCostAuthorityInputSchema.safeParse({
    contractVersion: 1,
    scope: { purchaseOrderId: Number(line.purchase_order_id), purchaseOrderLineId: Number(line.id), currency: "USD", basePieces },
    // This proof covers a fully invoiced source. No quote is selected or
    // repriced; its captured values remain untouched in the original revision.
    quote: { reference: { kind: "purchase_order_line", documentId: Number(line.purchase_order_id), lineId: Number(line.id) },
      basePieces: Number(line.order_qty), amount: null, sourceRevisionId: null, approval: null },
    invoices, receiptAllocationPolicy: "unresolved", shipmentCostCoverage: "not_applicable", shipmentShares: [], application: null,
  });
  return parsed.success ? parsed.data : null;
}

/** Prove the old fully confirmed, split supplier contract against the S1 money
 * model. No partial source, new allocation policy or unsupported adjustment is
 * promoted by a compatibility comparison. Unknown fields remain significant. */
function normalizedConfirmedProposal(proposal: CostSourceProposal): NormalizedConfirmedProposal | null {
  const { input } = proposal;
  if (input.scope.kind !== "purchase_order_line" || input.component === "landed" || input.evidence !== "confirmed"
    || input.currency !== "USD" || input.issue !== null || input.manualOverride !== null || input.inventoryEffect
    || input.basePieces === null || input.sources.some(row => row.kind !== "vendor_invoice_line")) return null;
  const parsed = sourceSchema.safeParse(proposal.sourceEvidence);
  if (!parsed.success) return null;
  // The schema only validates; comparison keeps the captured JSON itself.
  // Zod's object clone may omit prototype-named unknown keys, which must not
  // disappear from immutable evidence or become proof of equivalence.
  const source = proposal.sourceEvidence as z.infer<typeof sourceSchema>;
  if (source.approvedInvoices.some(row => row.cost_component_evidence.adjustmentMills !== 0)) return null;
  if (!supportedAmounts(source)) return null;
  const resolved = resolvePurchaseCostSource({ purchaseOrderLine: source.purchaseOrderLine,
    approvedInvoices: source.approvedInvoices }).find(row => row.component === input.component);
  if (!resolved || canonicalJson(resolved) !== canonicalJson(input)) return null;
  const authority = authorityInput(source, input.basePieces);
  if (!authority) return null;
  const selected = projectPurchaseCostAuthority(authority);
  // A historical aggregate can remain equivalent while the future per-receipt
  // rule is unresolved. This preserves an existing posting, never assigns stock.
  if (selected.issues.some(issue => issue.code !== "INVOICE_RECEIPT_ALLOCATION_REQUIRED")
    || selected.coverage.estimatedPieces !== 0 || selected.supplier === null
    || selected.supplier[input.component === "product" ? "productMills" : "packagingMills"] !== input.totalMills) return null;
  const invoices = source.approvedInvoices.map(row => ({ ...row, ...(row.status === undefined ? {} : { status: "approved" }) }));
  const versions = new Map(invoices.map(row => [`${row.vendor_invoice_id}:${row.id}`, costFingerprint(row)]));
  const sources: CostSourceProposal["input"]["sources"] = [];
  for (const row of input.sources) {
    const version = versions.get(`${row.documentId}:${row.lineId}`);
    if (!version) return null;
    sources.push({ ...row, version });
  }
  const { supplierCredits: _emptyCredits, ...sourceFacts } = source;
  return {
    economicFingerprint: selected.economicFingerprint,
    input: { ...input, sources },
    sourceEvidence: { ...sourceFacts, purchaseOrderLine: Object.fromEntries(Object.entries(source.purchaseOrderLine)
      .filter(([field]) => !unselectedQuoteFields.has(field))), approvedInvoices: invoices },
  };
}

export function retainEquivalentPurchaseCostSource(current: CostSourceProposal, saved: StoredCostSource | undefined): CostSourceProposal {
  const previous = verifiedStoredCostSource(saved);
  if (!previous) return current;
  const before = normalizedConfirmedProposal(previous);
  const after = normalizedConfirmedProposal(current);
  return before !== null && after !== null && canonicalJson(before) === canonicalJson(after) ? previous : current;
}
