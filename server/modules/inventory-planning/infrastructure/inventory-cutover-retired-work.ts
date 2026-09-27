import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

export class CutoverRetiredWorkError extends Error {
  readonly code = "CUTOVER_HISTORY_RETIRED";
  readonly classification = "permanent";
  constructor(readonly context: { kind: "receipt" | "shipment"; batchId: string }) {
    super("This exact processing record was retired at inventory cutover. Original history is retained; new work requires its own identity.");
    this.name = "CutoverRetiredWorkError";
  }
}

type DrizzleReader = { execute(statement: SQL): Promise<unknown> };
function rows(result: unknown): Array<{ batch_id: string }> {
  const parsed = z.object({ rows: z.array(z.object({ batch_id: z.string().regex(/^[1-9][0-9]{0,18}$/) })).max(1) }).safeParse(result);
  if (parsed.success) return parsed.data.rows;
  // Never infer 'not retired' from a failed/malformed database response.
  throw new Error("CUTOVER_HISTORY_LOOKUP_INVALID");
}
export async function assertReceiptNotRetired(tx: DrizzleReader, receiptId: number): Promise<void> {
  const batchId = await retiredReceiptBatch(tx,receiptId);
  if (batchId) throw new CutoverRetiredWorkError({ kind: "receipt", batchId });
}
export async function retiredReceiptBatch(tx: DrizzleReader, receiptId: number): Promise<string | null> {
  const result = rows(await tx.execute(sql`SELECT batch_id::text FROM inventory.cutover_history_retirements WHERE receipt_id=${receiptId}`));
  return result.length ? result[0].batch_id : null;
}

/** The owning transaction already holds runtime authority/source locks. This is
 * a narrowly indexed lifecycle check, not a new inventory formula or DB trigger.
 * Check BOTH IDs so a caller cannot revive an old source under a new header. */
export async function assertShipmentNotRetiredPg(client: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
  shipmentId: number, sourceItemId: number): Promise<void> {
  const result = rows(await client.query(`SELECT batch_id::text FROM inventory.cutover_history_retirements
    WHERE shipment_id=$1 OR decision_payload @> jsonb_build_object('sourceItemIds',jsonb_build_array($2::integer)) LIMIT 1`, [shipmentId,sourceItemId]));
  if (result.length) throw new CutoverRetiredWorkError({ kind: "shipment", batchId: result[0].batch_id });
}
export async function assertShipmentNotRetired(tx: DrizzleReader, shipmentId: string | number | undefined,
  sourceItemId: number | undefined): Promise<void> {
  const headerId = shipmentId !== undefined && /^[1-9][0-9]*$/.test(String(shipmentId))
    && Number(shipmentId) <= 2_147_483_647 ? Number(shipmentId) : null;
  if (headerId === null && sourceItemId === undefined) return;
  const result = rows(await tx.execute(sql`SELECT batch_id::text FROM inventory.cutover_history_retirements
    WHERE shipment_id=${headerId} OR decision_payload @>
      jsonb_build_object('sourceItemIds',jsonb_build_array(${sourceItemId ?? null}::integer)) LIMIT 1`));
  if (result.length) throw new CutoverRetiredWorkError({ kind: "shipment", batchId: result[0].batch_id });
}
