import type { RelationshipSnapshot } from "@shared/procurement/document-relationships";
import { costInteger } from "../../inventory/infrastructure/cost-evidence-values";
import { resolveShipmentSupplierCredits } from "./shipment-supplier-credits";

/** Reuse the posting owner's exact credit allocation. This is a read projection:
 * it does not rerun allocation, confirm charges or change posting status. */
export function projectDocumentRelationshipCosts(
  evidence: Parameters<typeof resolveShipmentSupplierCredits>[0],
): Pick<RelationshipSnapshot, "charges" | "allocations" | "costIssues"> {
  const net = resolveShipmentSupplierCredits(evidence);
  const integer = (value: unknown) => costInteger(value, "relationshipAmount", -Number.MAX_SAFE_INTEGER);
  const chargesById = new Map(evidence.charges.map(row => [costInteger(row.id, "costId", 1), row]));
  return {
    allocations: net.allocations.map(row => ({
      costId: costInteger(row.shipment_cost_id, "costId", 1), shipmentLineId: costInteger(row.inbound_shipment_line_id, "shipmentLineId", 1),
      currency: chargesById.get(Number(row.shipment_cost_id))?.currency == null ? null : String(chargesById.get(Number(row.shipment_cost_id))!.currency),
      cents: row.allocated_cents == null ? null : integer(row.allocated_cents),
    })),
    charges: evidence.charges.map(row => ({
      id: costInteger(row.id, "costId", 1), shipmentId: costInteger(row.inbound_shipment_id, "shipmentId", 1),
      currency: row.currency == null ? null : String(row.currency),
      cents: row.actual_cents == null && row.estimated_cents == null ? null
        : integer((BigInt(integer(row.actual_cents ?? row.estimated_cents)) - BigInt(net.creditedCentsByCharge.get(Number(row.id)) ?? 0)).toString()),
    })),
    costIssues: net.issues.map(issue => issue.message),
  };
}
