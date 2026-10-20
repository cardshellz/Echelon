import { sql } from "drizzle-orm";
import { z } from "zod";
import type { db } from "../../../db";

const identity = z.number().int().positive().safe();
const FOLLOWUP_BATCH_SIZE = 20;
const RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 300_000;
const MAX_ATTEMPT_COUNT = 2_147_483_647;

export function nextSupplierReturnFollowupAttempt(at: Date, previousAttempts: number): Date {
  z.date().parse(at);
  z.number().int().min(0).max(MAX_ATTEMPT_COUNT).parse(previousAttempts);
  // Match the existing inventory publication outbox's bounded backoff. Failed
  // oldest rows leave the due set, so newer committed returns remain reachable.
  const delay = Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * 2 ** Math.min(previousAttempts, 10));
  return z.date().parse(new Date(at.getTime() + delay));
}

/** Physical custody commits first. Publication failures retain this work so a
 * process crash cannot silently leave downstream availability unchanged. The
 * injected publisher is the existing inventory-change owner, never a provider. */
export class SupplierReturnFollowupService {
  constructor(
    private readonly database: Pick<typeof db, "transaction" | "execute">,
    private readonly publishInventoryChange: (variantId: number, trigger: string) => Promise<void>,
    private readonly clock: () => Date,
  ) {}

  async recoverPending(): Promise<void> {
    const at = z.date().parse(this.clock());
    const pending = await this.database.execute(sql`
      SELECT supplier_return_id,product_variant_id FROM inventory.supplier_return_followups
      WHERE completed_at IS NULL AND next_attempt_at<=${at}
      ORDER BY next_attempt_at,created_at,supplier_return_id,product_variant_id
      LIMIT ${FOLLOWUP_BATCH_SIZE}`);
    for (const row of pending.rows) {
      await this.recover(identity.parse(Number(row.supplier_return_id)), identity.parse(Number(row.product_variant_id)));
    }
  }

  async recover(returnId: number, productVariantId: number): Promise<boolean> {
    identity.parse(returnId); identity.parse(productVariantId);
    try {
      return await this.database.transaction(async tx => {
        // This delivery transaction takes only its own outbox row. It never
        // enters the physical graph/location/lot lock order.
        const result = await tx.execute(sql`SELECT followup.completed_at,followup.next_attempt_at,followup.attempt_count,
          EXISTS(SELECT 1 FROM procurement.supplier_return_lines line
            JOIN inventory.supplier_return_allocations allocation ON allocation.supplier_return_line_id=line.id
            WHERE line.supplier_return_id=followup.supplier_return_id
              AND line.product_variant_id=followup.product_variant_id) AS has_receipt
          FROM inventory.supplier_return_followups followup
          WHERE supplier_return_id=${returnId} AND product_variant_id=${productVariantId}
          FOR UPDATE SKIP LOCKED`);
        if (result.rows.length === 0) return false;
        const row = result.rows[0];
        if (row.completed_at !== null) return true;
        const at = z.date().parse(this.clock());
        if (z.date().parse(row.next_attempt_at).getTime() > at.getTime()) return false;
        const previousAttempts = z.number().int().min(0).max(MAX_ATTEMPT_COUNT).parse(row.attempt_count);
        const attemptCount = Math.min(previousAttempts + 1, MAX_ATTEMPT_COUNT);
        try {
          if (row.has_receipt !== true) throw new Error("Supplier return availability work has no physical receipt.");
          await this.publishInventoryChange(productVariantId, "supplier_return");
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
          const nextAttempt = nextSupplierReturnFollowupAttempt(at, previousAttempts);
          await tx.execute(sql`UPDATE inventory.supplier_return_followups SET attempt_count=${attemptCount},
            next_attempt_at=${nextAttempt},last_error=${message}
            WHERE supplier_return_id=${returnId} AND product_variant_id=${productVariantId} AND completed_at IS NULL`);
          console.error(JSON.stringify({ event: "supplier_return_inventory_followup_failed", returnId, productVariantId,
            attemptCount, nextAttemptAt: nextAttempt.toISOString(), message }));
          return false;
        }
        const completedAt = z.date().parse(this.clock());
        await tx.execute(sql`UPDATE inventory.supplier_return_followups SET completed_at=${completedAt},
          attempt_count=${attemptCount},last_error=NULL
          WHERE supplier_return_id=${returnId} AND product_variant_id=${productVariantId} AND completed_at IS NULL`);
        return true;
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "supplier_return_inventory_followup_failed", returnId, productVariantId,
        message: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  }
}
