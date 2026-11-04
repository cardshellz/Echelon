import { sql } from "drizzle-orm";
import { ShipmentTrackingError, type ShipmentTrackingService } from "./shipment-tracking.service";
import { readSupplierHeaderSources, supplierHeaderTargetKey } from "./supplier-header-cost-source.repository";
import { reviewedHeaderFreightAmounts } from "./domain/header-invoice-charges";
import { persistReviewedFreightChargeAmounts } from "./freight-invoice-costs.repository";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import type { CostRevisionApplicationResult } from "../inventory/application/apply-cost-revision";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";

export type HeaderShipmentApplications = Array<{ shipmentId: number; results: CostRevisionApplicationResult[];
  pending: boolean; issues: Array<{ code: string; message: string }> }>;

/** Financial classification is retained independently of a genuine missing
 * measurement. Only that named allocation failure rolls its shipment attempt
 * back; database errors and unexpected failures roll the whole approval back. */
export async function applySupplierHeaderShipmentCosts(tx: AmendmentTransaction, invoiceId: number,
  shipmentTracking: Pick<ShipmentTrackingService, "refreshQuantityAllocationInTransaction">, actorId: string, at: Date): Promise<HeaderShipmentApplications> {
  const target = { kind: "invoice" as const, id: invoiceId };
  const selected = (await readSupplierHeaderSources(tx, [target])).get(supplierHeaderTargetKey(target))!;
  if (!selected.current) return [];
  if (selected.issue) throw new CostEvidenceError(selected.issue.code, selected.issue.message);
  const charges = reviewedHeaderFreightAmounts(selected.source, selected.shares);
  await persistReviewedFreightChargeAmounts(tx, invoiceId, charges, at);
  const results: HeaderShipmentApplications = [];
  for (const shipmentId of [...new Set(charges.map(row => row.shipmentId))]) {
    await tx.execute(sql`SAVEPOINT supplier_header_shipment_costs`);
    try {
      const result = await shipmentTracking.refreshQuantityAllocationInTransaction(tx, shipmentId, actorId, at);
      results.push({ shipmentId, results: result.costApplications,
        pending: !("status" in result) || result.status !== "applied",
        issues: "skipped" in result ? result.skipped.map(row => ({ code: row.reason, message: row.message })) : [] });
      await tx.execute(sql`RELEASE SAVEPOINT supplier_header_shipment_costs`);
    } catch (error) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT supplier_header_shipment_costs`);
      await tx.execute(sql`RELEASE SAVEPOINT supplier_header_shipment_costs`);
      if (!(error instanceof ShipmentTrackingError) || error.details?.code !== "MISSING_ALLOCATION_DIMENSIONS") throw error;
      results.push({ shipmentId, results: [], pending: true, issues: [{ code: "MISSING_ALLOCATION_DIMENSIONS",
        message: `Shipment ${shipmentId} needs its saved packing measurements reviewed before inventory costs can be updated.` }] });
    }
  }
  return results;
}
