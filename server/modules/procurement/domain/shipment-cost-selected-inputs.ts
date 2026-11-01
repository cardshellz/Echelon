import { z } from "zod";
import { shipmentAllocationEvidenceSchema, SHIPMENT_ALLOCATION_MAX_SOURCE_QUANTITY } from "@shared/procurement/shipment-allocation";
import { costFingerprint } from "../../inventory/domain/cost-fingerprint";
import type { CostSourceProposal } from "./cost-source-compatibility";

const id = z.number().int().positive().max(SHIPMENT_ALLOCATION_MAX_SOURCE_QUANTITY);
const money = z.union([z.number().int().safe(), z.string().regex(/^-?\d{1,19}$/).refine(value => Number.isSafeInteger(Number(value)))]);
const evidenceSchema = z.object({
  shipmentLineSnapshot: z.object({ id, purchase_order_id: id, purchase_order_line_id: id }).passthrough(),
  charges: z.array(z.object({ id, actual_cents: money.nullish(), estimated_cents: money.nullish() }).passthrough()).min(1),
  allocationBasis: z.array(z.object({ costId: id, method: shipmentAllocationEvidenceSchema.shape.method }).passthrough()),
  allocations: z.array(z.object({ shipment_cost_id: id, inbound_shipment_line_id: id }).passthrough()),
}).passthrough();
const poPriceFields = new Set(["allocation_po_order_qty", "allocation_po_product_total_cents", "allocation_po_currency"]);

/** A physical/count allocation does not consume PO product-price inputs. Prove
 * the selected methods and exact original charge-reference hashes before
 * removing only those unused fields for comparison. Persisted rows stay intact. */
export function normalizeUnselectedShipmentQuote(proposal: CostSourceProposal): CostSourceProposal {
  const scope = proposal.input.scope;
  if (scope.kind !== "shipment_line" || proposal.input.component !== "landed") return proposal;
  const parsed = evidenceSchema.safeParse(proposal.sourceEvidence);
  if (!parsed.success) return proposal;
  // No transformations are defined by this schema. Preserve the original JSON
  // so unknown/prototype-named fields cannot vanish in a validation clone.
  const evidence = proposal.sourceEvidence as z.infer<typeof evidenceSchema>;
  const snapshot = evidence.shipmentLineSnapshot;
  if (snapshot.id !== scope.inboundShipmentLineId || snapshot.purchase_order_id !== scope.purchaseOrderId
    || snapshot.purchase_order_line_id !== scope.purchaseOrderLineId) return proposal;
  const methods = new Map(evidence.allocationBasis.map(row => [row.costId, row.method]));
  if (methods.size !== evidence.allocationBasis.length || [...methods.values()].some(method => method === "by_value")) return proposal;
  const charges = new Map(evidence.charges.map(row => [row.id, row]));
  if (charges.size !== evidence.charges.length || [...methods.keys()].some(costId => !charges.has(costId))) return proposal;
  for (const charge of charges.values()) {
    const amount = charge.actual_cents ?? charge.estimated_cents;
    if (amount == null || (BigInt(amount) !== BigInt(0) && !methods.has(charge.id))) return proposal;
  }
  const normalizedSnapshot = Object.fromEntries(Object.entries(snapshot).filter(([field]) => !poPriceFields.has(field)));
  const sources: CostSourceProposal["input"]["sources"] = [];
  const seen = new Set<number>();
  for (const source of proposal.input.sources) {
    if (source.kind !== "shipment_cost") { sources.push(source); continue; }
    const charge = charges.get(source.lineId);
    if (!charge || source.documentId !== scope.inboundShipmentId || seen.has(source.lineId)) return proposal;
    seen.add(source.lineId);
    const signature = { charge, allocationBasis: evidence.allocationBasis,
      allocations: evidence.allocations.filter(row => row.shipment_cost_id === source.lineId && row.inbound_shipment_line_id === snapshot.id),
      snapshot };
    if (costFingerprint(signature) !== source.version) return proposal;
    sources.push({ ...source, version: costFingerprint({ ...signature, snapshot: normalizedSnapshot }) });
  }
  if (seen.size !== charges.size) return proposal;
  return { input: { ...proposal.input, sources }, sourceEvidence: { ...evidence, shipmentLineSnapshot: normalizedSnapshot } };
}
