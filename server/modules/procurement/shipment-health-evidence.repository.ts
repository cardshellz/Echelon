import { asc, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  inboundShipmentLines, inboundFreightCosts, inboundFreightAllocations,
  landedCostSnapshots, purchaseOrderLines, purchaseOrders,
  type InboundShipmentLine, type InboundFreightCost, type InboundFreightAllocation,
  type LandedCostSnapshot, type PurchaseOrderLine, type PurchaseOrder,
} from "@shared/schema";
import { SHIPMENT_SCAN_PAGE_SIZE } from "@shared/procurement/shipment-work-list";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";

export interface ShipmentAllocationReadEvidence {
  lines: InboundShipmentLine[];
  costs: InboundFreightCost[];
  allocationsByCostId: ReadonlyMap<number, InboundFreightAllocation[]>;
  purchaseLinesById: ReadonlyMap<number, PurchaseOrderLine>;
  purchaseOrdersById: ReadonlyMap<number, PurchaseOrder>;
}

export interface ShipmentHealthReadEvidence extends ShipmentAllocationReadEvidence {
  snapshotsByLineId: ReadonlyMap<number, LandedCostSnapshot>;
}

const shipmentIdsSchema = z.array(z.number().int().positive().safe()).max(SHIPMENT_SCAN_PAGE_SIZE);
type EvidenceReader = Pick<NodePgDatabase, "select">;

function uniqueRows<T>(rows: readonly T[], key: (row: T) => number): Map<number, T> {
  const result = new Map<number, T>();
  for (const row of rows) {
    const id = key(row);
    if (result.has(id)) throw new CostEvidenceError("SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE",
      "Current shipment cost evidence contains duplicate identities. Reload cost health.");
    result.set(id, row);
  }
  return result;
}

function groupRows<T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> {
  const result = new Map<number, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = result.get(id) ?? [];
    group.push(row);
    result.set(id, group);
  }
  return result;
}

function assertScope<T>(rows: readonly T[], key: (row: T) => number | null, allowed: readonly number[]): void {
  const ids = new Set(allowed);
  if (rows.some(row => !ids.has(key(row)!))) throw new CostEvidenceError("SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE",
    "Current shipment cost evidence contains an unexpected source identity. Reload cost health.");
}

/** Read one header page's raw evidence in its caller's repeatable-read snapshot.
 * No status decisions, money calculations, evidence truncation or cross-request
 * cache belong here. Existing application/domain owners still evaluate each
 * shipment, including the supplier review's per-shipment safety bounds. */
export async function readShipmentHealthEvidence(
  tx: EvidenceReader,
  shipmentIds: readonly number[],
): Promise<Map<number, ShipmentHealthReadEvidence>> {
  const ids = shipmentIdsSchema.parse(shipmentIds);
  if (new Set(ids).size !== ids.length) throw new CostEvidenceError("SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE",
    "Current shipment cost evidence contains duplicate shipment identities. Reload cost health.");
  if (!ids.length) return new Map();
  const lines = await tx.select().from(inboundShipmentLines)
    .where(inArray(inboundShipmentLines.inboundShipmentId, ids))
    .orderBy(asc(inboundShipmentLines.createdAt), asc(inboundShipmentLines.id));
  uniqueRows(lines, line => line.id);
  const lineIds = lines.map(line => line.id);
  const poLineIds = [...new Set(lines.flatMap(line => line.purchaseOrderLineId == null ? [] : [line.purchaseOrderLineId]))];
  const poIds = [...new Set(lines.flatMap(line => line.purchaseOrderId == null ? [] : [line.purchaseOrderId]))];
  const costs = await tx.select().from(inboundFreightCosts).where(inArray(inboundFreightCosts.inboundShipmentId, ids));
  uniqueRows(costs, cost => cost.id);
  // A bounded header page can still have many lines/charges. Bind arrays as
  // one PostgreSQL parameter; expanded IN values can overflow the wire count.
  const allocations = costs.length ? await tx.select().from(inboundFreightAllocations)
    .where(sql`${inboundFreightAllocations.shipmentCostId}=ANY(${sql.param(costs.map(cost => cost.id))}::int[])`) : [];
  const snapshots = lineIds.length ? await tx.select().from(landedCostSnapshots)
    .where(sql`${landedCostSnapshots.inboundShipmentLineId}=ANY(${sql.param(lineIds)}::int[])`) : [];
  const poLines = poLineIds.length ? await tx.select().from(purchaseOrderLines)
    .where(sql`${purchaseOrderLines.id}=ANY(${sql.param(poLineIds)}::int[])`) : [];
  const orders = poIds.length ? await tx.select().from(purchaseOrders)
    .where(sql`${purchaseOrders.id}=ANY(${sql.param(poIds)}::int[])`) : [];
  assertScope(lines, row => row.inboundShipmentId, ids);
  assertScope(costs, row => row.inboundShipmentId, ids);
  assertScope(allocations, row => row.shipmentCostId, costs.map(cost => cost.id));
  assertScope(snapshots, row => row.inboundShipmentLineId, lineIds);
  assertScope(poLines, row => row.id, poLineIds);
  assertScope(orders, row => row.id, poIds);
  uniqueRows(allocations, row => row.id);
  const allocationsByCostId = groupRows(allocations, row => row.shipmentCostId);
  // Migration 156 permits one current snapshot per non-null shipment line.
  // Do not hide contradictory rows with LIMIT/DISTINCT or pick an arbitrary one.
  const snapshotsByLineId = uniqueRows(snapshots, row => row.inboundShipmentLineId!);
  const purchaseLinesById = uniqueRows(poLines, row => row.id);
  const purchaseOrdersById = uniqueRows(orders, row => row.id);
  const linesByShipment = groupRows(lines, row => row.inboundShipmentId);
  const costsByShipment = groupRows(costs, row => row.inboundShipmentId);
  return new Map(ids.map(id => [id, {
    lines: linesByShipment.get(id) ?? [], costs: costsByShipment.get(id) ?? [],
    allocationsByCostId, snapshotsByLineId,
    purchaseLinesById, purchaseOrdersById,
  }]));
}

export interface ShipmentProvisionalLotCounts {
  provisionalLotCount: number;
  untracedProvisionalLotCount: number;
}

/** Count every flagged lot in PostgreSQL. Transfer only complete counts; the
 * traced set is scoped to each shipment's actual supplier-cost review. */
export async function readShipmentProvisionalLotCounts(tx: Pick<NodePgDatabase, "execute">, scopes: readonly {
  shipmentId: number; tracedLotIds: readonly number[];
}[]): Promise<Map<number, ShipmentProvisionalLotCounts>> {
  const validated = z.array(z.object({ shipmentId: z.number().int().positive().safe(),
    tracedLotIds: z.array(z.number().int().positive().safe()) })).max(SHIPMENT_SCAN_PAGE_SIZE).parse(scopes);
  const ids = validated.map(scope => scope.shipmentId);
  if (new Set(ids).size !== ids.length) throw new CostEvidenceError("SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE", "Duplicate shipment identities in provisional-lot scope.");
  const counts = new Map(ids.map(id => [id, { provisionalLotCount: 0, untracedProvisionalLotCount: 0 }]));
  if (!ids.length) return counts;
  const traced = validated.map(scope => ({ shipment_id: scope.shipmentId, lot_ids: [...new Set(scope.tracedLotIds)] }));
  const rows = (await tx.execute(sql`
    WITH traced AS MATERIALIZED (
      SELECT scope.shipment_id,lot_id.value::integer AS lot_id
      FROM jsonb_to_recordset(${JSON.stringify(traced)}::jsonb) AS scope(shipment_id integer,lot_ids jsonb)
      CROSS JOIN LATERAL jsonb_array_elements_text(scope.lot_ids) AS lot_id(value)
    )
    SELECT lot.inbound_shipment_id AS shipment_id,count(*)::text AS provisional_count,
      count(*) FILTER (WHERE traced.lot_id IS NULL)::text AS untraced_count
    FROM inventory.inventory_lots lot LEFT JOIN traced
      ON traced.shipment_id=lot.inbound_shipment_id AND traced.lot_id=lot.id
    WHERE lot.inbound_shipment_id=ANY(${sql.param(ids)}::int[]) AND lot.cost_provisional=1
    GROUP BY lot.inbound_shipment_id ORDER BY lot.inbound_shipment_id
  `)).rows;
  const seen = new Set<number>();
  for (const row of rows) {
    const id = Number(row.shipment_id), total = Number(row.provisional_count), untraced = Number(row.untraced_count);
    if (!Number.isSafeInteger(id) || !counts.has(id) || seen.has(id)
      || typeof row.provisional_count !== "string" || !/^(0|[1-9][0-9]*)$/.test(row.provisional_count)
      || typeof row.untraced_count !== "string" || !/^(0|[1-9][0-9]*)$/.test(row.untraced_count)
      || !Number.isSafeInteger(total) || !Number.isSafeInteger(untraced) || untraced > total) {
      throw new CostEvidenceError("SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE", "Current provisional-lot counts are inconsistent. Reload cost health.");
    }
    seen.add(id); counts.set(id, { provisionalLotCount: total, untracedProvisionalLotCount: untraced });
  }
  return counts;
}
