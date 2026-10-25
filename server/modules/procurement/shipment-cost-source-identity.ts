import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { costSourceRevisionSchema, type CostSourceRevision } from "@shared/procurement/cost-source-contracts";
import { costFingerprint } from "../inventory/infrastructure/cost-evidence-values";

export interface ShipmentCostProposal {
  input: Omit<CostSourceRevision, "revision" | "fingerprint">;
  sourceEvidence: unknown;
}

const sourceEvidenceSchema = z.object({
  invoices: z.array(z.object({
    id: z.number().int().positive().nullable(),
    vendor_invoice_id: z.number().int().positive(),
    purchase_order_line_id: z.number().int().positive().nullable().optional(),
    product_variant_id: z.number().int().positive().nullable().optional(),
  }).passthrough()),
}).passthrough();

/** These two nullable links were added to the invoice read after cost revisions
 * had already been posted. Absence and explicit null both mean no product link.
 * Preserve every other field, including unknown fields, as cost evidence. */
function normalizedProposal(proposal: ShipmentCostProposal): ShipmentCostProposal | null {
  const evidence = sourceEvidenceSchema.safeParse(proposal.sourceEvidence);
  if (!evidence.success) return null;
  const versions = new Map<string, { original: string; normalized: string }>();
  const invoices = evidence.data.invoices.map(invoice => {
    const normalized = { ...invoice };
    if (normalized.purchase_order_line_id == null) delete normalized.purchase_order_line_id;
    if (normalized.product_variant_id == null) delete normalized.product_variant_id;
    const key = `${invoice.vendor_invoice_id}:${invoice.id}`;
    // Duplicate document lines cannot prove a unique source reference.
    if (versions.has(key)) return null;
    versions.set(key, { original: costFingerprint(invoice), normalized: costFingerprint(normalized) });
    return normalized;
  });
  if (invoices.some(invoice => invoice === null)) return null;
  const sources = [];
  for (const source of proposal.input.sources) {
    if (source.kind !== "vendor_invoice_line") { sources.push(source); continue; }
    const version = versions.get(`${source.documentId}:${source.lineId}`);
    if (!version || version.original !== source.version) return null;
    sources.push({ ...source, version: version.normalized });
  }
  return { input: { ...proposal.input, sources }, sourceEvidence: { ...evidence.data, invoices } };
}

/** Keep the original immutable revision (and its approval identity) when the
 * current, fully validated proposal differs only in nullable link serialization.
 * Used by both read projections and posting preparation, never by a UI filter.
 * Actual links, amounts, authorities, issues and allocation changes still differ. */
export function retainEquivalentShipmentCostSource(current: ShipmentCostProposal, saved: {
  contract: unknown;
  fingerprint: unknown;
  source_evidence: unknown;
} | undefined): ShipmentCostProposal {
  if (!saved) return current;
  const parsed = costSourceRevisionSchema.safeParse(saved.contract);
  if (!parsed.success || parsed.data.component !== "landed" || parsed.data.scope.kind !== "shipment_line") return current;
  const { revision: _revision, fingerprint, ...input } = parsed.data;
  const previous = { input, sourceEvidence: saved.source_evidence };
  // A compatibility comparison must not legitimize a damaged saved contract.
  if (saved.fingerprint !== fingerprint || costFingerprint(previous) !== fingerprint) return current;
  const before = normalizedProposal(previous);
  const after = normalizedProposal(current);
  if (before === null || after === null || canonicalJson(before) !== canonicalJson(after)) return current;
  return previous;
}
