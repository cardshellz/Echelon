import { sql } from "drizzle-orm";
import type { PurchaseCostStatus } from "@shared/procurement/purchase-cost-status";
import { CostEvidenceError, costInteger, type CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import { readPurchaseCostStatus } from "./purchase-cost-status.repository";
import { readPoShipmentCosts } from "./po-shipment-cost-summary.repository";

/** Request-local only: retain this cache within one read-only repeatable-read
 * transaction. Commands must create a fresh projection after each mutation. */
export function createSupplierCreditCostReadCache(tx: CostEvidenceTransaction) {
  type PurchaseLine = PurchaseCostStatus["lines"][number];
  type ShipmentScope = { shipmentId: number | null; purchaseOrderIds: number[] };
  const purchaseLines = new Map<number, Promise<PurchaseLine | undefined>>();
  const shipmentScopes = new Map<number, Promise<ShipmentScope>>();
  const poShipments = new Map<number, ReturnType<typeof readPoShipmentCosts>>();

  return {
    assertTransaction(candidate: CostEvidenceTransaction): void {
      if (candidate !== tx) throw new CostEvidenceError("CREDIT_COST_SNAPSHOT_MISMATCH", "Supplier credit cost evidence must stay within its original read transaction.");
    },
    async readPurchaseLines(ids: readonly number[]): Promise<PurchaseLine[]> {
      const requested = [...new Set(ids.map(id => costInteger(id, "purchaseOrderLineId", 1)))];
      const missing = requested.filter(id => !purchaseLines.has(id));
      if (missing.length) {
        const batch = readPurchaseCostStatus(tx, missing);
        for (const id of missing) purchaseLines.set(id, batch.then(result => result.lines.find(line => line.purchaseOrderLineId === id)));
      }
      return (await Promise.all(requested.map(id => purchaseLines.get(id)!))).flatMap(line => line ? [line] : []);
    },
    async readShipmentScope(freightCostId: number): Promise<ShipmentScope> {
      const id = costInteger(freightCostId, "freightCostId", 1);
      if (!shipmentScopes.has(id)) shipmentScopes.set(id, (async () => {
        const shipment = (await tx.execute(sql`SELECT inbound_shipment_id FROM procurement.inbound_freight_costs WHERE id=${id}`)).rows[0];
        if (!shipment) return { shipmentId: null, purchaseOrderIds: [] };
        const shipmentId = costInteger(shipment.inbound_shipment_id, "shipmentId", 1);
        const scopes = (await tx.execute(sql`SELECT DISTINCT purchase_order_id FROM procurement.inbound_shipment_lines
          WHERE inbound_shipment_id=${shipmentId} AND purchase_order_id IS NOT NULL ORDER BY purchase_order_id`)).rows;
        return { shipmentId, purchaseOrderIds: scopes.map(row => costInteger(row.purchase_order_id, "purchaseOrderId", 1)) };
      })());
      return shipmentScopes.get(id)!;
    },
    readPoShipments(purchaseOrderId: number): ReturnType<typeof readPoShipmentCosts> {
      const id = costInteger(purchaseOrderId, "purchaseOrderId", 1);
      if (!poShipments.has(id)) {
        // Reuse the caller's snapshot; never open a new transaction per credit.
        poShipments.set(id, readPoShipmentCosts({ execute: query => tx.execute(query), transaction: fn => fn(tx) }, id));
      }
      return poShipments.get(id)!;
    },
  };
}

export type SupplierCreditCostReadCache = ReturnType<typeof createSupplierCreditCostReadCache>;
