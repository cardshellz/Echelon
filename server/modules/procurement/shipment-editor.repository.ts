import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { inboundShipmentLines, inboundShipmentStatusHistory } from "@shared/schema/procurement.schema";
import { auditEvents } from "@shared/schema";
import { shipmentEditorContextSchema, type ShipmentEditorPreview, type ShipmentEditorRequest } from "@shared/procurement/shipment-editor";
import { shipmentLineEditableSchema } from "@shared/procurement/shipment-line-command";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { costFingerprint, costInteger } from "../inventory/infrastructure/cost-evidence-values";
import { hasQuantityAmendmentAuthority } from "./po-quantity-amendment.policy";
import { readPurchaseApprovalActor, readPurchaseApproverName } from "../identity/infrastructure/purchase-approval-access.repository";
import { shipmentLineVersion } from "./shipment-line-version";
import { rejectShipmentEdit, sumShipmentCents, shipmentEditorBlockedReason } from "./shipment-editor.policy";
import { readShipmentUnitOptions } from "./shipment-unit-selection.repository";
import { shipmentReceivingUnitSource } from "./shipment-receiving-setup.service";

const number = (value: unknown) => costInteger(value, "shipment value", -Number.MAX_SAFE_INTEGER);
const nullableId = (value: unknown) => value == null ? null : costInteger(value, "linked document", 1);
const nullableString = (value: unknown) => value == null ? null : z.string().parse(value);

export async function readShipmentEditorSource(tx: AmendmentTransaction, shipmentId: number, actorId: string) {
  await lockInventoryCostGraph(tx);
  const [shipment] = (await tx.execute(sql`SELECT * FROM procurement.inbound_shipments WHERE id=${shipmentId} FOR UPDATE`)).rows;
  if (!shipment) rejectShipmentEdit("Shipment not found.", "SHIPMENT_EDITOR_NOT_FOUND", 404);
  const lines = (await tx.execute(sql`SELECT l.*,p.po_number,pl.product_name,pl.product_id AS source_product_id,
    pl.expected_receive_variant_id,pl.product_variant_id AS source_variant_id,pl.expected_receive_units_per_variant FROM procurement.inbound_shipment_lines l
    LEFT JOIN procurement.purchase_orders p ON p.id=l.purchase_order_id
    LEFT JOIN procurement.purchase_order_lines pl ON pl.id=l.purchase_order_line_id
    WHERE l.inbound_shipment_id=${shipmentId} ORDER BY l.id FOR UPDATE OF l`)).rows;
  const costs = (await tx.execute(sql`SELECT * FROM procurement.inbound_freight_costs WHERE inbound_shipment_id=${shipmentId} ORDER BY id FOR UPDATE`)).rows;
  const allocations = (await tx.execute(sql`SELECT a.* FROM procurement.inbound_freight_allocations a JOIN procurement.inbound_freight_costs c ON c.id=a.shipment_cost_id WHERE c.inbound_shipment_id=${shipmentId} ORDER BY a.id`)).rows;
  const receipts = (await tx.execute(sql`SELECT r.* FROM procurement.receiving_orders r WHERE r.inbound_shipment_id=${shipmentId}
    OR EXISTS (SELECT 1 FROM procurement.receiving_lines rl JOIN procurement.inbound_shipment_lines sl ON sl.id=rl.inbound_shipment_line_id
      WHERE rl.receiving_order_id=r.id AND sl.inbound_shipment_id=${shipmentId}) ORDER BY r.id FOR SHARE OF r`)).rows;
  const posted = (await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM procurement.landed_cost_snapshots s JOIN procurement.inbound_shipment_lines l ON l.id=s.inbound_shipment_line_id WHERE l.inbound_shipment_id=${shipmentId})
    OR EXISTS(SELECT 1 FROM procurement.landed_cost_adjustments a JOIN procurement.inbound_shipment_lines l ON l.id=a.inbound_shipment_line_id WHERE l.inbound_shipment_id=${shipmentId})
    OR EXISTS(SELECT 1 FROM inventory.inventory_lots WHERE inbound_shipment_id=${shipmentId}) AS protected`)).rows[0];
  const actor = await readPurchaseApprovalActor(tx, actorId);
  const protectedCharges = costs.map(row => ({ id: row.id, actual: row.actual_cents, estimated: row.estimated_cents, currency: row.currency }));
  const currencies = [...new Set(costs.map(cost => nullableString(cost.currency)))].sort();
  const unitOptions = await readShipmentUnitOptions(tx, lines.map(row => ({ key: number(row.id),
    ...shipmentReceivingUnitSource({ productVariantId: nullableId(row.product_variant_id), unitsPerVariantSnapshot: nullableId(row.units_per_variant_snapshot) },
      { productId: nullableId(row.source_product_id), expectedReceiveVariantId: nullableId(row.expected_receive_variant_id),
        productVariantId: nullableId(row.source_variant_id), expectedReceiveUnitsPerVariant: nullableId(row.expected_receive_units_per_variant) }) })));
  const context = shipmentEditorContextSchema.parse({ shipmentId, shipmentNumber: shipment.shipment_number, status: shipment.status,
    sourceVersion: costFingerprint({ shipment, lines, costs, allocations, receipts, posted, actor }),
    canApprove: hasQuantityAmendmentAuthority(actor),
    blockedReason: shipmentEditorBlockedReason({ status: String(shipment.status), hasReceipts: receipts.length > 0,
      hasPostedCosts: posted?.protected === true, chargeCurrencies: currencies }),
    lines: lines.map(row => ({ key: `line:${row.id}`, id: number(row.id), sku: nullableString(row.sku), name: String(row.product_name ?? row.sku ?? "Unlinked product"),
      purchaseOrderId: nullableId(row.purchase_order_id), purchaseOrderLineId: nullableId(row.purchase_order_line_id), poNumber: nullableString(row.po_number),
      fields: shipmentLineEditableSchema.parse({ qtyShipped: row.qty_shipped, cartonCount: row.carton_count,
        dimensionBasis: row.dimension_basis, weightKg: row.weight_kg, lengthCm: row.length_cm, widthCm: row.width_cm, heightCm: row.height_cm, notes: row.notes }),
      shipmentUnits: unitOptions.get(number(row.id)), allocatedCostCents: number(row.allocated_cost_cents ?? 0), totalWeightKg: nullableString(row.total_weight_kg), totalVolumeCbm: nullableString(row.total_volume_cbm) })),
    charges: currencies.map(currency => ({ currency: currency ?? "Unspecified currency", cents: sumShipmentCents(costs.filter(cost => cost.currency === currency).map(cost => number(cost.actual_cents ?? cost.estimated_cents ?? 0))) })),
    receipts: receipts.map(row => ({ id: number(row.id), number: row.receipt_number })),
  });
  const typedLines = await tx.select().from(inboundShipmentLines).where(eq(inboundShipmentLines.inboundShipmentId, shipmentId));
  return { context, lines, shipment, protectedCharges, versions: new Map(typedLines.map(line => [line.id, shipmentLineVersion(line)])) };
}

export async function recordShipmentEditorApproval(tx: AmendmentTransaction, source: Awaited<ReturnType<typeof readShipmentEditorSource>>,
  after: Awaited<ReturnType<typeof readShipmentEditorSource>>, preview: ShipmentEditorPreview, request: ShipmentEditorRequest, actorId: string, at: Date) {
  const actorName = await readPurchaseApproverName(tx, actorId);
  const [event] = await tx.insert(auditEvents).values({ timestamp: at, level: "AUDIT", actor: actorId,
    action: "procurement.shipment.editor.approved", target: `shipment:${source.context.shipmentId}`,
    changes: { before: source.lines, after: after.lines, preview },
    context: { shipmentId: source.context.shipmentId, actorName, reason: request.reason, sourceVersion: request.sourceVersion } }).returning({ id: auditEvents.id });
  await tx.insert(inboundShipmentStatusHistory).values({ inboundShipmentId: source.context.shipmentId,
    fromStatus: source.context.status, toStatus: source.context.status, changedBy: actorId, changedAt: at,
    notes: `Shipment lines edited with administrator approval (${actorName}). ${request.reason}` });
  return { auditId: number(event.id), actorName, approvedAt: at.toISOString(), preview };
}
