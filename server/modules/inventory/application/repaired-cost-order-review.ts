import type { CostIssue } from "@shared/procurement/cost-source-contracts";
import {
  costFingerprint,
  costInteger,
  type CostEvidenceTransaction,
} from "../infrastructure/cost-evidence.repository";
import { readRepairedOrderEvidence } from "../infrastructure/repaired-cost-order.repository";
import { hasVerifiedCostSale } from "../domain/verified-cost-sale";

/** A repaired inventory path supplies no missing sale authority. This check is
 * repeated on future revisions through the policy persisted on the receipt. */
export async function reviewRepairedOrderCosts(
  tx: CostEvidenceTransaction,
  lotIds: number[],
) {
  const evidence = await readRepairedOrderEvidence(tx, lotIds);
  const orders = new Map(evidence.orders.map((row) => [Number(row.id), row]));
  const items = new Map(evidence.items.map((row) => [Number(row.id), row]));
  const shipmentsByItem = new Map<number, typeof evidence.shipments>();
  for (const shipment of evidence.shipments) {
    const id = costInteger(shipment.order_item_id, "shipment order item", 1);
    const group = shipmentsByItem.get(id) ?? [];
    group.push(shipment);
    shipmentsByItem.set(id, group);
  }
  const excluded = evidence.costs.filter((row) => {
    const order = orders.get(Number(row.order_id)),
      item = items.get(Number(row.order_item_id));
    return !hasVerifiedCostSale({
      orderStatus: order ? String(order.warehouse_status) : null,
      cancelled: order?.cancelled_at != null,
      itemMatchesOrder:
        !!item && Number(item.order_id) === Number(row.order_id),
      itemStatus: item ? String(item.status) : null,
      orderedUnits: item ? costInteger(item.quantity, "ordered units") : 0,
      shipments: (shipmentsByItem.get(Number(row.order_item_id)) ?? []).map(
        (shipment) => ({
          quantity: costInteger(shipment.qty, "shipped units"),
          status: String(shipment.status),
          voided: shipment.voided_at != null,
          purpose:
            shipment.shipment_purpose === "customer_fulfillment"
              ? String(shipment.shipment_item_purpose)
              : String(shipment.shipment_purpose),
          membership: String(shipment.provider_membership_state),
        }),
      ),
    });
  });
  const issues: CostIssue[] = excluded.map((row) => {
    const status = orders.get(Number(row.order_id))?.warehouse_status;
    return {
      code: "COST_ORDER_SALE_UNVERIFIED",
      message: `Order #${row.order_id}, cost record #${row.id}, lot #${row.inventory_lot_id}: ${Math.abs(costInteger(row.qty, "order quantity", -2_147_483_647))} units lack confirmed shipment coverage or belong to a cancelled order. Existing costs were preserved. Review the order's shipment or cancellation before updating COGS.`,
      orderCostReview: {
        orderId: costInteger(row.order_id, "order", 1),
        orderCostId: costInteger(row.id, "cost id", 1),
        inventoryLotId: costInteger(row.inventory_lot_id, "lot", 1),
        quantity: Math.abs(
          costInteger(row.qty, "order quantity", -2_147_483_647),
        ),
        status: status == null ? null : String(status),
      },
    };
  });
  return {
    excludedIds: excluded.map((row) => costInteger(row.id, "cost id", 1)),
    issues,
    // Only source evidence is hashed; mutable cost amounts are application outputs.
    evidenceVersion: costFingerprint(evidence),
    evidence,
  };
}
