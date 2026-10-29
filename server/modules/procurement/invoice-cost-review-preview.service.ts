import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import { invoiceCostReviewSchema } from "@shared/procurement/invoice-cost-review";
import { reviewInvoiceCostComponentsInTransaction } from "./invoice-cost-review.service";
import { ApLedgerError } from "./ap-ledger.service";
import type { AmendmentDatabase } from "./po-quantity-amendment.repository";

/** Run the real invoice/cost owners, then roll back every write. Sequence gaps
 * are harmless; no audit, source revision, posting or stock edit is committed. */
export function createInvoiceCostReviewPreviewService(database: AmendmentDatabase, clock: () => Date) {
  return async (lineId: number, input: unknown, actorId: string) => {
    z.number().int().positive().max(2_147_483_647).parse(lineId);
    if (!actorId.trim()) throw new ApLedgerError("Sign in to review supplier costs.", 401);
    const review = invoiceCostReviewSchema.parse(input);
    if (review.previewVersion !== undefined) throw new ApLedgerError("Start a new cost preview before saving.", 400);
    return database.transaction(async tx => {
      await tx.execute(sql`SAVEPOINT invoice_cost_preview`);
      try {
        const result = await reviewInvoiceCostComponentsInTransaction(tx, lineId, review, actorId, clock(), true, true);
        if (!result.body.preview) throw new Error("Invoice cost preview is missing");
        return { preview: result.body.preview, application: result.body.application };
      } finally {
        await tx.execute(sql`ROLLBACK TO SAVEPOINT invoice_cost_preview`);
        await tx.execute(sql`RELEASE SAVEPOINT invoice_cost_preview`);
      }
    });
  };
}

export const previewInvoiceCostReview = createInvoiceCostReviewPreviewService(db, () => new Date());
