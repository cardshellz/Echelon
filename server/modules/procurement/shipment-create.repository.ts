import { eq, sql } from "drizzle-orm";
import { inboundShipments, inboundShipmentLines, inboundShipmentStatusHistory, auditEvents, type InboundShipment, type InboundShipmentLine, type InsertInboundShipment } from "@shared/schema";
import type { db } from "../../db";
import { nextShipmentNumber, shipmentNumberPrefix, ShipmentCreateError } from "./domain/shipment-create";

export type ShipmentCreateTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Every create takes this lock, including manual numbers, before checking or allocating. */
export async function allocateShipmentNumber(tx: ShipmentCreateTransaction, requested: string | undefined, now: Date): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('procurement.shipment_number'), hashtext('version_1'))`);
  if (requested) return requested;
  const prefix = shipmentNumberPrefix(now);
  // Numbered cancelled shipments remain part of the sequence. Only an entirely
  // numeric suffix counts; imported reference labels cannot distort allocation.
  // Cast the bound start position: PostgreSQL otherwise selects substring(text, text)
  // and treats an untyped parameter as a regex rather than a character offset.
  const evidence = await tx.execute(sql`
    SELECT MAX(substring(shipment_number FROM ${prefix.length + 1}::integer)::numeric)::text AS suffix
    FROM procurement.inbound_shipments
    WHERE shipment_number ~ ${`^${prefix}[0-9]+$`}
  `);
  const suffix = evidence.rows[0]?.suffix;
  if (suffix !== null && typeof suffix !== "string") throw new TypeError("Shipment numbering evidence is missing or invalid");
  return nextShipmentNumber(prefix, suffix);
}

export async function insertShipmentWithHistory(tx: ShipmentCreateTransaction, data: InsertInboundShipment, actorId: string, now: Date): Promise<InboundShipment> {
  let shipment: InboundShipment | undefined;
  try {
    [shipment] = await tx.insert(inboundShipments).values({ ...data, createdAt: now, updatedAt: now }).returning();
  } catch (error) {
    const cause = error instanceof Error ? error.cause ?? error : error;
    const failure = cause && typeof cause === "object" ? cause as Record<string, unknown> : null;
    if (failure?.code === "23505" && failure.constraint === "inbound_shipments_shipment_number_active_uidx") {
      throw new ShipmentCreateError("SHIPMENT_CREATE_NUMBER_CONFLICT", "This shipment number is already used by an active shipment. Choose a different number.", 409);
    }
    throw error;
  }
  if (!shipment) throw new Error("Shipment insert returned no record");
  await tx.insert(inboundShipmentStatusHistory).values({
    inboundShipmentId: shipment.id, fromStatus: null, toStatus: "draft", changedBy: actorId,
    changedAt: now, notes: "Shipment created",
  });
  return shipment;
}

export async function readCreatedShipment(tx: ShipmentCreateTransaction, shipmentId: number) {
  const [shipment] = await tx.select().from(inboundShipments).where(eq(inboundShipments.id, shipmentId));
  if (!shipment) throw new Error("Created shipment disappeared within its transaction");
  const lines = await tx.select().from(inboundShipmentLines).where(eq(inboundShipmentLines.inboundShipmentId, shipmentId));
  return { shipment, lines };
}

export async function recordShipmentCreation(tx: ShipmentCreateTransaction, input: {
  shipment: InboundShipment; lines: InboundShipmentLine[]; actorId: string; now: Date;
}): Promise<void> {
  await tx.insert(auditEvents).values({
    timestamp: input.now, level: "AUDIT", actor: input.actorId, action: "procurement.shipment.create",
    target: `shipment:${input.shipment.id}`, changes: { before: null, after: { shipment: input.shipment, lines: input.lines } },
    context: { shipmentId: input.shipment.id, lineCount: input.lines.length },
  });
}
