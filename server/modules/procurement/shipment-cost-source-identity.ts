import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { isApprovedCostInvoiceStatus } from "@shared/procurement/purchase-cost-authority";
import { costFingerprint } from "../inventory/infrastructure/cost-evidence-values";
import { verifiedStoredCostSource, type CostSourceProposal, type StoredCostSource } from "./domain/cost-source-compatibility";
import { normalizeUnselectedShipmentQuote } from "./domain/shipment-cost-selected-inputs";

export type ShipmentCostProposal = CostSourceProposal;

const sourceEvidenceSchema = z.object({
  invoices: z.array(z.object({
    id: z.number().int().positive().nullable(),
    vendor_invoice_id: z.number().int().positive(),
    purchase_order_line_id: z.number().int().positive().nullable().optional(),
    product_variant_id: z.number().int().positive().nullable().optional(),
  }).passthrough()),
}).passthrough();

/** Select only proved method-dependent quote inputs first. Absent/null links
 * and progress within the approved settlement class also do not change cost
 * authority. Preserve all remaining fields, including unknown ones. */
function normalizedProposal(proposal: ShipmentCostProposal): ShipmentCostProposal | null {
  const selected = normalizeUnselectedShipmentQuote(proposal);
  const evidence = sourceEvidenceSchema.safeParse(selected.sourceEvidence);
  if (!evidence.success) return null;
  // Validate known fields without discarding any captured unknown JSON keys.
  const captured = selected.sourceEvidence as z.infer<typeof sourceEvidenceSchema>;
  const versions = new Map<string, { original: string; normalized: string }>();
  const invoices = captured.invoices.map(invoice => {
    const normalized = { ...invoice };
    if (normalized.purchase_order_line_id == null) delete normalized.purchase_order_line_id;
    if (normalized.product_variant_id == null) delete normalized.product_variant_id;
    if (isApprovedCostInvoiceStatus(normalized.status)) normalized.status = "approved";
    const key = `${invoice.vendor_invoice_id}:${invoice.id}`;
    // Duplicate document lines cannot prove a unique source reference.
    if (versions.has(key)) return null;
    versions.set(key, { original: costFingerprint(invoice), normalized: costFingerprint(normalized) });
    return normalized;
  });
  if (invoices.some(invoice => invoice === null)) return null;
  const sources: ShipmentCostProposal["input"]["sources"] = [];
  for (const source of selected.input.sources) {
    if (source.kind !== "vendor_invoice_line") { sources.push(source); continue; }
    const version = versions.get(`${source.documentId}:${source.lineId}`);
    if (!version || version.original !== source.version) return null;
    sources.push({ ...source, version: version.normalized });
  }
  return { input: { ...selected.input, sources }, sourceEvidence: { ...captured, invoices } };
}

/** Keep the original immutable revision (and its approval identity) when the
 * current proposal differs only in proved unused quote inputs, nullable link
 * serialization or approved settlement progress. Financial authority stays intact.
 * Used by both read projections and posting preparation, never by a UI filter.
 * Actual links, amounts, authorities, issues and allocation changes still differ. */
export function retainEquivalentShipmentCostSource(current: ShipmentCostProposal, saved: StoredCostSource | undefined): ShipmentCostProposal {
  const previous = verifiedStoredCostSource(saved);
  if (!previous || previous.input.component !== "landed" || previous.input.scope.kind !== "shipment_line") return current;
  const before = normalizedProposal(previous);
  const after = normalizedProposal(current);
  if (before === null || after === null || canonicalJson(before) !== canonicalJson(after)) return current;
  return previous;
}
