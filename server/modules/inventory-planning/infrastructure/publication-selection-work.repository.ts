import type { Pool } from "pg";
import { z } from "zod";
import type { InventoryAvailabilityTransactionQueryClient } from "../application/inventory-availability-transaction-query.port";

const BATCH_SIZE = 25;
const RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const batchSchema = z.number().int().min(1).max(100);
const workSchema = z.object({ product_id: z.number().int().positive(), revision: z.string().regex(/^[1-9][0-9]*$/),
  acknowledged_revision: z.string().regex(/^[0-9]+$/), attempt_count: z.number().int().nonnegative(), boundary_due: z.boolean() });
export interface PublicationSelectionWorkResult { planned: number; blocked: number; skipped: number }
/** Returns the code of an isolated (skipped) destination, or null when every
 * destination planned. A throw means nothing for the product was planned. */
type Planner = (client: InventoryAvailabilityTransactionQueryClient, productId: number) => Promise<{ blockedErrorCode: string | null } | void>;

/** One transaction owns both current desired/outbox quantities and the work ACK.
 * Crash or rollback leaves the revision pending. No provider I/O occurs here. */
export class PostgresPublicationSelectionWork {
  constructor(private readonly pool: Pick<Pool, "connect">,
    private readonly clock: () => Date = () => new Date(), private readonly plan: Planner = planCurrentSelection) {}

  async processDue(batchSize = BATCH_SIZE): Promise<PublicationSelectionWorkResult> {
    const limit = batchSchema.parse(batchSize);
    const now = z.date().parse(this.clock());
    const reader = await this.pool.connect();
    let candidates: Array<{ product_id: number }>;
    try {
      candidates = z.array(z.object({ product_id: z.number().int().positive() })).parse((await reader.query(`
        SELECT product_id FROM inventory.publication_selection_work
        WHERE (revision>acknowledged_revision AND next_attempt_at<=$1)
          OR next_boundary_at<=$1
        ORDER BY next_attempt_at,product_id LIMIT $2`, [now, limit])).rows);
    } finally { reader.release(); }
    const result: PublicationSelectionWorkResult = { planned: 0, blocked: 0, skipped: 0 };
    for (const candidate of candidates) result[await this.processProduct(candidate.product_id, now)] += 1;
    return result;
  }

  private async processProduct(productId: number, now: Date): Promise<keyof PublicationSelectionWorkResult> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL lock_timeout='2s'");
      const gate = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock_shared(918419,0) AS acquired");
      if (!gate.rows[0]?.acquired) { await client.query("ROLLBACK"); return "skipped"; }
      const row = (await client.query(`SELECT product_id,revision::text,acknowledged_revision::text,attempt_count,
        COALESCE(next_boundary_at<=$2,false) AS boundary_due FROM inventory.publication_selection_work
        WHERE product_id=$1 AND ((revision>acknowledged_revision AND next_attempt_at<=$2) OR next_boundary_at<=$2)
        FOR UPDATE SKIP LOCKED`, [productId, now])).rows[0];
      if (!row) { await client.query("ROLLBACK"); return "skipped"; }
      const work = workSchema.parse(row);
      let revision = work.revision;
      if (work.boundary_due) {
        revision = (BigInt(work.revision) + BigInt(1)).toString();
        await client.query("UPDATE inventory.publication_selection_work SET revision=$2 WHERE product_id=$1", [productId, revision]);
      }
      await client.query("SAVEPOINT selection_plan");
      let outcome: "planned" | "blocked" = "planned";
      let errorCode: string | null = null;
      // A thrown plan committed nothing: retry with backoff. An isolated
      // destination is a terminal data problem instead: its safe siblings commit,
      // the revision is ACKed (no hot retry), and its code stays on the work row
      // for review until a listing-data change re-marks the product.
      let acknowledged = true;
      try {
        const isolated = (await this.plan(client, productId))?.blockedErrorCode ?? null;
        if (isolated) { outcome = "blocked"; errorCode = safeFailureCode({ code: isolated }); }
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT selection_plan");
        outcome = "blocked";
        errorCode = safeFailureCode(error);
        acknowledged = false;
      }
      await client.query(`INSERT INTO inventory.publication_selection_attempts(product_id,revision,outcome,error_code,occurred_at)
        VALUES($1,$2,$3,$4,$5)`, [productId, revision, outcome, errorCode, now]);
      if (acknowledged) {
        await client.query(`UPDATE inventory.publication_selection_work SET acknowledged_revision=$2,
          attempt_count=0,last_error_code=$4,next_attempt_at=$3,
          next_boundary_at=inventory.next_publication_selection_boundary($3),updated_at=$3 WHERE product_id=$1`,
        [productId, revision, now, errorCode]);
      } else {
        const delay = Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * 2 ** Math.min(work.attempt_count, 10));
        await client.query(`UPDATE inventory.publication_selection_work SET attempt_count=attempt_count+1,last_error_code=$2,
          next_attempt_at=$3,next_boundary_at=inventory.next_publication_selection_boundary($4),updated_at=$4 WHERE product_id=$1`,
        [productId, errorCode, new Date(now.getTime() + delay), now]);
      }
      await client.query("COMMIT");
      return outcome;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { discard = true; throw new AggregateError([error, rollbackError], "Selection replan rollback failed."); }
      // A contended SERIALIZABLE transaction has committed neither ACK nor plan.
      // Leave it pending for the next existing worker tick.
      if (isRetryableTransaction(error)) return "skipped";
      throw error;
    } finally { client.release(discard); }
  }
}

async function planCurrentSelection(client: InventoryAvailabilityTransactionQueryClient, productId: number): Promise<{ blockedErrorCode: string | null }> {
  const { createTransactionScopedInventoryPublicationService } = await import("./inventory-availability-runtime-publication.repository");
  const routed = await createTransactionScopedInventoryPublicationService(client).publishProduct({ productId, dryRun: false,
    triggeredBy: "publication_work", blockedTargets: "isolate" }, async () => {
    throw Object.assign(new Error("Selection replanning requires canonical publication authority."), { code: "PUBLICATION_SELECTION_AUTHORITY_CHANGED" });
  });
  const blocked = routed.authority === "canonical" ? routed.publication.blockedTargets ?? [] : [];
  return { blockedErrorCode: blocked[0]?.errorCode ?? null };
}

function safeFailureCode(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(code)
    ? code : "PUBLICATION_SELECTION_PLAN_FAILED";
}
function isRetryableTransaction(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && ["40001", "40P01", "55P03"].includes(String((error as { code?: unknown }).code)));
}
