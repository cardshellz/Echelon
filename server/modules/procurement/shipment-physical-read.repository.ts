import { asc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { inboundShipmentLines, type InboundShipmentLine } from "@shared/schema";
import { shipmentLineResourceIdSchema } from "@shared/procurement/shipment-line-command";

/** Raw batched evidence only; the physical-value owner computes every total. */
export async function readShipmentPhysicalLines(database: Pick<NodePgDatabase, "select">, shipmentIds: readonly number[]): Promise<Map<number, InboundShipmentLine[]>> {
  const ids = [...new Set(z.array(shipmentLineResourceIdSchema).parse(shipmentIds))];
  const result = new Map<number, InboundShipmentLine[]>(ids.map(id => [id, []]));
  if (!ids.length) return result;
  const rows = await database.select().from(inboundShipmentLines)
    .where(sql`${inboundShipmentLines.inboundShipmentId}=ANY(${sql.param(ids)}::int[])`)
    .orderBy(asc(inboundShipmentLines.inboundShipmentId), asc(inboundShipmentLines.id));
  for (const row of rows) {
    const group = result.get(row.inboundShipmentId);
    if (!group) throw new Error("Shipment physical evidence escaped its requested scope");
    group.push(row);
  }
  return result;
}
