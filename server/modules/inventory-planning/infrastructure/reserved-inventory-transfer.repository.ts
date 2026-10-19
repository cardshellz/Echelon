import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, IntegrityError } from "@shared/errors";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { CanonicalClaimTransactionClient } from "../application/canonical-claim-inventory.port";
import type { ReservedInventoryTransferOwner } from "../application/reserved-inventory-transfer.port";
import { selectReservedTransferGroups } from "../domain/reserved-inventory-transfer";
import { lockCanonicalClaimsForInventoryTransfer } from "./inventory-availability-claim.repository";
const quantity = z.coerce.number().int().min(0).max(2147483647);
const id = z.coerce.number().int().positive().max(2147483647);
const bigintId = z.string().regex(/^[1-9][0-9]*$/);
const mills = z.string().regex(/^[0-9]+$/);
const resourceSchema = z.object({
  resource_id: bigintId, claim_id: bigintId, claim_line_id: bigintId,
  order_id: id, order_item_id: id, inventory_level_id: id, warehouse_id: id, order_warehouse_id: id.nullable(), open_qty: quantity, picked_qty: quantity,
  line_picked: quantity, line_consumed: quantity, item_picked: quantity,
  consumer_operation_key: z.string().nullable(), producer_operation_key: z.string().nullable(),
  target_variant_id: id, item_status: z.string(), order_status: z.string(), edit_operation: z.string().nullable()
});
const allocationSchema = z.object({
  allocation_id: bigintId, resource_id: bigintId, inventory_lot_id: id, open_qty: quantity,
  unit_cost_mills: mills, po_unit_cost_mills: mills.nullable(), packaging_unit_cost_mills: mills.nullable(), landed_unit_cost_mills: mills.nullable()
});
function conflict(message: string, code: string, context?: Record<string, unknown>): never {
  throw new AppError(message, code, 409, context);
}
async function changed(client: CanonicalClaimTransactionClient, text: string, values: unknown[]): Promise<void> {
  if ((await client.query(text, values)).rows.length !== 1)
    throw new IntegrityError("A locked reservation changed during its transfer");
}
/** Metadata owner only. The inventory owner moves physical lots and posts one
 * balanced on-hand/reserved journal entry in the caller's same transaction. */
export function createReservedInventoryTransferOwner(): ReservedInventoryTransferOwner {
  return {
    lockSource: lockCanonicalClaimsForInventoryTransfer,
    async plan(client, input) {
      const resources = z.array(resourceSchema).parse((await client.query(`SELECT r.id::text AS resource_id,r.claim_id::text,r.claim_line_id::text,c.order_id,l.order_item_id,r.inventory_level_id,r.warehouse_id,o.warehouse_id AS order_warehouse_id,
          (r.claimed_qty-r.released_qty-r.consumed_qty-r.picked_qty)::text AS open_qty,r.picked_qty::text,
          l.picked_target_qty::text AS line_picked,l.consumed_target_qty::text AS line_consumed,
          i.picked_quantity AS item_picked,i.status AS item_status,o.warehouse_status AS order_status,
          to_jsonb(o)->>'order_edit_operation_id' AS edit_operation,
          r.consumer_operation_key,r.producer_operation_key,l.target_variant_id
         FROM inventory.availability_claim_resources r
         JOIN inventory.availability_claims c ON c.id=r.claim_id
         JOIN inventory.availability_claim_lines l ON l.id=r.claim_line_id AND l.claim_id=c.id
         JOIN wms.order_items i ON i.id=l.order_item_id AND i.order_id=c.order_id
         JOIN wms.orders o ON o.id=c.order_id
         WHERE c.status='active' AND r.source_variant_id=$1 AND r.warehouse_location_id=$2
           AND r.claimed_qty-r.released_qty-r.consumed_qty-r.picked_qty>0
         ORDER BY c.created_at,c.id,r.id FOR UPDATE OF r,l`, [input.productVariantId, input.fromLocationId])).rows);
      if (resources.some(resource => resource.inventory_level_id !== input.sourceLevelId || resource.warehouse_id !== input.warehouseId
        || (resource.order_warehouse_id !== null && resource.order_warehouse_id !== resource.warehouse_id))
        || resources.reduce((sum, resource) => sum + resource.open_qty, 0) !== input.reserved) {
        conflict("Source reservations changed or lack exact order ownership. Refresh before moving reserved stock.", "TRANSFER_RESERVATION_EVIDENCE_REQUIRED");
      }
      const groups = new Map<number, { orderItemId: number; quantity: number }>();
      const blocked = new Map<number, { code: string; message: string; orderId: number }>();
      for (const resource of resources) {
        const group = groups.get(resource.order_item_id) ?? { orderItemId: resource.order_item_id, quantity: 0 };
        group.quantity += resource.open_qty;
        groups.set(resource.order_item_id, group);
        if (resource.picked_qty || resource.line_picked || resource.line_consumed || resource.item_picked
          || resource.item_status !== "pending" || ["shipped", "cancelled", "completed"].includes(resource.order_status)) {
          blocked.set(resource.order_item_id, {
            code: "TRANSFER_BLOCKED_BY_ACTIVE_PICK", orderId: resource.order_id,
            message: "An order using this stock has started picking or completed. Finish or reverse that pick before moving its reservation."
          });
        } else if (resource.edit_operation || resource.consumer_operation_key || resource.producer_operation_key
          || resource.target_variant_id !== input.productVariantId) {
          blocked.set(resource.order_item_id, {
            code: "TRANSFER_RESERVATION_WORKFLOW_REQUIRED", orderId: resource.order_id,
            message: "An assembly or order-edit workflow owns this reservation. Finish that workflow before moving its stock."
          });
        }
      }
      const eligibleGroups = [...groups.values()].filter(group => !blocked.has(group.orderItemId));
      const available = input.onHand - input.reserved;
      if (eligibleGroups.reduce((sum, group) => sum + group.quantity, 0) < input.quantity - available && blocked.size) {
        const [orderItemId, blocker] = blocked.entries().next().value!;
        conflict(blocker.message, blocker.code, { orderId: blocker.orderId, orderItemId });
      }
      const selected = selectReservedTransferGroups(eligibleGroups, input.quantity, available);
      const selectedIds = new Set(selected.map(group => group.orderItemId));
      const moving = resources.filter(r => selectedIds.has(r.order_item_id));
      const lineIds = [...new Set(moving.map(r => r.claim_line_id))];
      // Existing canonical picking pins a line's first picked bin. Preserve that
      // invariant rather than creating an unpickable split or changing a build's output identity.
      const elsewhere = (await client.query(`SELECT id FROM inventory.availability_claim_resources
        WHERE claim_line_id=ANY($1::bigint[]) AND source_variant_id=$2
          AND warehouse_location_id NOT IN ($3,$4)
          AND claimed_qty-released_qty-consumed_qty>0 LIMIT 1`, [lineIds, input.productVariantId, input.fromLocationId, input.toLocationId])).rows;
      if (elsewhere.length)
        conflict("This pick line already spans another bin. Replan its locations before transferring it.", "TRANSFER_WHOLE_PICK_LINE_REQUIRED");
      const allocations = z.array(allocationSchema).parse((await client.query(`SELECT id::text AS allocation_id,claim_resource_id::text AS resource_id,
        inventory_lot_id,(claimed_qty-released_qty-consumed_qty-picked_qty)::text AS open_qty,
        unit_cost_mills::text,po_unit_cost_mills::text,packaging_unit_cost_mills::text,landed_unit_cost_mills::text
        FROM inventory.availability_claim_lot_allocations WHERE claim_resource_id=ANY($1::bigint[])
          AND claimed_qty-released_qty-consumed_qty-picked_qty>0 ORDER BY inventory_lot_id,id FOR UPDATE`, [moving.map(r => r.resource_id)])).rows);
      const allocationTotals = new Map<string, number>();
      for (const allocation of allocations) {
        allocationTotals.set(allocation.resource_id, (allocationTotals.get(allocation.resource_id) ?? 0) + allocation.open_qty);
      }
      for (const resource of moving) {
        if (allocationTotals.get(resource.resource_id) !== resource.open_qty) {
          throw new IntegrityError("The order reservation does not match its exact FIFO lot allocations", { resourceId: resource.resource_id });
        }
      }
      const byResource = new Map(moving.map(r => [r.resource_id, r]));
      return {
        productVariantId: input.productVariantId, fromLocationId: input.fromLocationId, toLocationId: input.toLocationId,
        reservedQuantity: selected.reduce((sum, r) => sum + r.quantity, 0), orderItemIds: [...selectedIds],
        allocations: allocations.map(a => {
          const r = byResource.get(a.resource_id)!;
          return {
            allocationId: a.allocation_id, resourceId: r.resource_id,
            claimId: r.claim_id, claimLineId: r.claim_line_id, orderId: r.order_id, orderItemId: r.order_item_id, sourceLotId: a.inventory_lot_id, quantity: a.open_qty,
            unitCostMills: a.unit_cost_mills, poUnitCostMills: a.po_unit_cost_mills, packagingUnitCostMills: a.packaging_unit_cost_mills, landedUnitCostMills: a.landed_unit_cost_mills
          };
        })
      };
    },
    async relocate(client, { plan, lots, destinationLevelId, warehouseId, commandKey, actor, occurredAt }) {
      const expectedByLot = new Map<number, number>();
      for (const allocation of plan.allocations) {
        expectedByLot.set(allocation.sourceLotId, (expectedByLot.get(allocation.sourceLotId) ?? 0) + allocation.quantity);
      }
      const reservedLots = lots.filter(lot => lot.reservedQuantity > 0);
      if (new Set(plan.allocations.map(allocation => allocation.allocationId)).size !== plan.allocations.length
        || plan.allocations.reduce((sum, allocation) => sum + allocation.quantity, 0) !== plan.reservedQuantity
        || reservedLots.length !== expectedByLot.size
        || new Set(reservedLots.map(lot => lot.sourceLotId)).size !== reservedLots.length
        || reservedLots.some(lot => expectedByLot.get(lot.sourceLotId) !== lot.reservedQuantity
          || lot.quantity < lot.reservedQuantity)) {
        throw new IntegrityError("Transferred physical lots do not exactly match the reservation plan");
      }
      const destinationBySourceLot = new Map(reservedLots.map(lot => [lot.sourceLotId, lot.destinationLotId]));
      const allocationsByResource = new Map<string, typeof plan.allocations[number][]>();
      for (const allocation of plan.allocations) {
        const allocations = allocationsByResource.get(allocation.resourceId) ?? [];
        allocations.push(allocation);
        allocationsByResource.set(allocation.resourceId, allocations);
      }
      for (const [resourceId, allocations] of allocationsByResource) {
        const first = allocations[0];
        const amount = allocations.reduce((sum, a) => sum + a.quantity, 0);
        await changed(client, `UPDATE inventory.availability_claim_resources SET released_qty=released_qty+$1,updated_at=$2
          WHERE id=$3 AND claimed_qty-released_qty-consumed_qty-picked_qty=$1 RETURNING id`, [amount, occurredAt, resourceId]);
        const existing = (await client.query(`SELECT id::text,claim_id::text,warehouse_id,warehouse_location_id FROM inventory.availability_claim_resources
          WHERE claim_line_id=$1 AND inventory_level_id=$2 AND source_variant_id=$3
            AND consumer_operation_key IS NULL AND producer_operation_key IS NULL FOR UPDATE`, [first.claimLineId, destinationLevelId, plan.productVariantId])).rows;
        if (existing.length > 1 || existing.some(resource => String(resource.claim_id) !== first.claimId
          || resource.warehouse_id !== warehouseId || resource.warehouse_location_id !== plan.toLocationId)) {
          throw new IntegrityError("Destination reservation identity is ambiguous or inconsistent");
        }
        const destinationId = existing.length === 1 ? String(existing[0].id) : String((await client.query(`INSERT INTO inventory.availability_claim_resources(claim_id,claim_line_id,warehouse_id,warehouse_location_id,inventory_level_id,source_variant_id,claimed_qty,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id::text`, [first.claimId, first.claimLineId, warehouseId, plan.toLocationId, destinationLevelId, plan.productVariantId, amount, occurredAt])).rows[0].id);
        if (existing.length)
          await changed(client, `UPDATE inventory.availability_claim_resources SET claimed_qty=claimed_qty+$1,updated_at=$2 WHERE id=$3 AND picked_qty=0 RETURNING id`, [amount, occurredAt, destinationId]);
        const evidence: Array<Record<string, unknown>> = [];
        for (const a of allocations) {
          const destinationLotId = destinationBySourceLot.get(a.sourceLotId)!;
          await changed(client, `UPDATE inventory.availability_claim_lot_allocations SET released_qty=released_qty+$1,updated_at=$2
            WHERE id=$3 AND claimed_qty-released_qty-consumed_qty-picked_qty=$1 RETURNING id`, [a.quantity, occurredAt, a.allocationId]);
          const output = (await client.query(`INSERT INTO inventory.availability_claim_lot_allocations
            (claim_id,claim_resource_id,inventory_lot_id,claimed_qty,unit_cost_mills,po_unit_cost_mills,packaging_unit_cost_mills,landed_unit_cost_mills,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id::text`, [a.claimId, destinationId, destinationLotId, a.quantity, a.unitCostMills, a.poUnitCostMills, a.packagingUnitCostMills, a.landedUnitCostMills, occurredAt])).rows[0];
          evidence.push({
            sourceAllocationId: a.allocationId, destinationAllocationId: String(output.id), sourceLotId: a.sourceLotId, destinationLotId, quantity: a.quantity
          });
        }
        const payload = {
          commandKey, orderId: first.orderId, orderItemId: first.orderItemId, sourceResourceId: resourceId, destinationResourceId: destinationId,
          fromLocationId: plan.fromLocationId, toLocationId: plan.toLocationId, quantity: amount, lots: evidence
        };
        await client.query(`INSERT INTO inventory.availability_claim_events(claim_id,event_type,from_status,to_status,evidence_payload,evidence_hash,actor,reason,occurred_at)
          VALUES($1,'claim_stock_transferred','active','active',$2::jsonb,$3,$4,'Unpicked reserved inventory transfer',$5)`, [first.claimId, JSON.stringify(payload), createHash("sha256").update(canonicalJson(payload)).digest("hex"), actor, occurredAt]);
      }
    },
  };
}
