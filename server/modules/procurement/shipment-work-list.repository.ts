import { and, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { inboundShipments, type InboundShipment } from "@shared/schema";
import type { ShipmentWorkListQuery } from "@shared/procurement/shipment-work-list";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type ShipmentListFilters = Partial<Omit<ShipmentWorkListQuery, "costFilter">>;
type Executor = Pick<NodePgDatabase, "select">;
/** List and count share exactly one predicate, including literal substring search. */
export function shipmentListPredicate(filters: ShipmentListFilters = {}): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.status === "active") conditions.push(ne(inboundShipments.status, "cancelled"));
  else if (filters.status && filters.status !== "all") conditions.push(Array.isArray(filters.status)
    ? inArray(inboundShipments.status, filters.status) : eq(inboundShipments.status, filters.status));
  if (filters.mode) conditions.push(eq(inboundShipments.mode, filters.mode));
  if (filters.warehouseId !== undefined) conditions.push(eq(inboundShipments.warehouseId, filters.warehouseId));
  if (filters.search) {
    const pattern = `%${filters.search.replace(/[\\%_]/g, character => `\\${character}`)}%`;
    conditions.push(or(ilike(inboundShipments.shipmentNumber, pattern), ilike(inboundShipments.carrierName, pattern),
      ilike(inboundShipments.containerNumber, pattern), sql`EXISTS (
        SELECT 1 FROM procurement.inbound_shipment_lines sl
        LEFT JOIN procurement.purchase_order_lines pol ON pol.id=sl.purchase_order_line_id
        LEFT JOIN procurement.purchase_orders po ON po.id=sl.purchase_order_id OR po.id=pol.purchase_order_id
        WHERE sl.inbound_shipment_id=${inboundShipments.id}
          AND (po.po_number ILIKE ${pattern} OR sl.sku ILIKE ${pattern} OR pol.sku ILIKE ${pattern})
      )`)!);
  }
  return and(...conditions);
}
export async function readShipmentList(executor: Executor, filters: ShipmentListFilters = {}): Promise<InboundShipment[]> {
  let query = executor.select().from(inboundShipments).where(shipmentListPredicate(filters))
    .orderBy(desc(inboundShipments.createdAt), desc(inboundShipments.id)).$dynamic();
  if (filters.limit !== undefined) query = query.limit(filters.limit);
  if (filters.offset !== undefined) query = query.offset(filters.offset);
  return query;
}
export async function countShipmentList(executor: Executor, filters: ShipmentListFilters = {}): Promise<number> {
  const [row] = await executor.select({ count: sql<string>`count(*)` }).from(inboundShipments).where(shipmentListPredicate(filters));
  const count = Number(row.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Shipment count exceeds the supported range");
  return count;
}
