import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { LABEL_RECONCILIATION_LEASE_MS, LabelReconciliationError,
  type LabelScanCheckpoint, type LabelScanClaim, type LabelScanRepository } from "./shipstation-label-reconciliation.service";

interface Executor { execute(query: SQL): Promise<unknown> }
interface Database extends Executor { transaction<T>(work: (tx: Executor) => Promise<T>): Promise<T> }
const rowSchema = z.object({ version: z.number().int().nonnegative(), completed_through: z.coerce.date(),
  window_start: z.coerce.date().nullable(), window_end: z.coerce.date().nullable(),
  next_page: z.number().int().positive(), last_success_at: z.coerce.date().nullable() });
function rows(result: unknown): unknown[] {
  return z.object({ rows: z.array(z.unknown()) }).parse(result).rows;
}
function checkpoint(raw: unknown): LabelScanCheckpoint {
  const row = rowSchema.parse(raw);
  return { version: row.version, completedThrough: row.completed_through, lastSuccessAt: row.last_success_at,
    window: row.window_start && row.window_end ? { start: row.window_start, end: row.window_end, page: row.next_page } : null };
}
function assertUpdated(result: unknown): void {
  if (rows(result).length !== 1) throw new LabelReconciliationError("SHIPSTATION_LABEL_SCAN_LEASE_LOST");
}
function leaseEnd(now: Date): Date { return new Date(z.date().parse(now).getTime() + LABEL_RECONCILIATION_LEASE_MS); }

export function createShipStationLabelReconciliationRepository(db: Database): LabelScanRepository {
  return {
    async readOrCreate(initialThrough, now) {
      z.date().parse(initialThrough); z.date().parse(now);
      return db.transaction(async tx => {
        await tx.execute(sql`INSERT INTO oms.shipstation_label_reconciliation_checkpoint
          (id, completed_through, updated_at) VALUES (1, ${initialThrough}, ${now}) ON CONFLICT (id) DO NOTHING`);
        return checkpoint(rows(await tx.execute(sql`SELECT * FROM oms.shipstation_label_reconciliation_checkpoint WHERE id = 1`))[0]);
      });
    },
    async claim(current, window, now) {
      const result = rows(await db.execute(sql`UPDATE oms.shipstation_label_reconciliation_checkpoint
        SET version = version + 1, window_start = ${window.start}, window_end = ${window.end},
          next_page = ${window.page}, lease_until = ${leaseEnd(now)}, updated_at = ${now}
        WHERE id = 1 AND version = ${current.version} AND (lease_until IS NULL OR lease_until <= ${now}) RETURNING *`));
      return result.length === 0 ? null : checkpoint(result[0]) as LabelScanClaim;
    },
    async renew(claim, now) {
      assertUpdated(await db.execute(sql`UPDATE oms.shipstation_label_reconciliation_checkpoint
        SET lease_until = ${leaseEnd(now)}, updated_at = ${now}
        WHERE id = 1 AND version = ${claim.version} AND lease_until > ${now} RETURNING id`));
    },
    async completePage(claim, hasMore, now) {
      assertUpdated(await db.execute(sql`UPDATE oms.shipstation_label_reconciliation_checkpoint
        SET completed_through = ${hasMore ? claim.completedThrough : claim.window.end},
          window_start = ${hasMore ? claim.window.start : null}::timestamptz,
          window_end = ${hasMore ? claim.window.end : null}::timestamptz,
          next_page = ${hasMore ? claim.window.page + 1 : 1}, lease_until = NULL,
          last_success_at = ${now}, last_error_code = NULL, consecutive_failures = 0, updated_at = ${now}
        WHERE id = 1 AND version = ${claim.version} AND lease_until > ${now} RETURNING id`));
    },
    async fail(claim, code, now) {
      z.string().regex(/^[A-Z0-9_]{1,100}$/).parse(code); z.date().parse(now);
      assertUpdated(await db.execute(sql`UPDATE oms.shipstation_label_reconciliation_checkpoint
        SET lease_until = NULL, last_error_code = ${code}, consecutive_failures = consecutive_failures + 1, updated_at = ${now}
        WHERE id = 1 AND version = ${claim.version} AND lease_until > ${now} RETURNING id`));
    },
  };
}
