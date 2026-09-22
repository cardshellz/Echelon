import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { LABEL_RECONCILIATION_LEASE_MS, MAX_LABEL_RECOVERY_ATTEMPTS, LabelReconciliationError,
  type LabelScanCheckpoint, type LabelScanClaim, type LabelScanRepository } from "./shipstation-label-reconciliation.service";

interface Executor { execute(query: SQL): Promise<unknown> }
interface Database extends Executor { transaction<T>(work: (tx: Executor) => Promise<T>): Promise<T> }
const rowSchema = z.object({ version: z.number().int().nonnegative(), completed_through: z.coerce.date(),
  window_start: z.coerce.date().nullable(), window_end: z.coerce.date().nullable(),
  next_page: z.number().int().positive(), last_success_at: z.coerce.date().nullable() });
const recoveryClaimSchema = z.object({ providerLabelId: z.number().int().positive().safe(),
  trackingNumber: z.string().trim().min(1).max(200),
  providerOrderId: z.number().int().positive().safe().nullable(), version: z.number().int().positive(),
  attempts: z.number().int().min(1).max(MAX_LABEL_RECOVERY_ATTEMPTS) }).strict();
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
    async completePage(claim, hasMore, now, discovered = []) {
      const labels = z.array(z.object({ providerLabelId: z.number().int().positive().safe(), providerOrderId: z.number().int().positive().safe().nullable(),
        trackingNumber: z.string().trim().min(1).max(200) }).strict()).max(10).parse(discovered);
      await db.transaction(async tx => {
        assertUpdated(await tx.execute(sql`UPDATE oms.shipstation_label_reconciliation_checkpoint
          SET completed_through = ${hasMore ? claim.completedThrough : claim.window.end},
            window_start = ${hasMore ? claim.window.start : null}::timestamptz,
            window_end = ${hasMore ? claim.window.end : null}::timestamptz,
            next_page = ${hasMore ? claim.window.page + 1 : 1}, lease_until = NULL,
            last_success_at = ${now}, last_error_code = NULL, consecutive_failures = 0, updated_at = ${now}
          WHERE id = 1 AND version = ${claim.version} AND lease_until > ${now} RETURNING id`));
        for (const label of labels) await tx.execute(sql`INSERT INTO oms.shipstation_label_recovery_work
          (provider_label_id, provider_order_id, tracking_number, state, next_attempt_at, created_at, updated_at)
          VALUES (${label.providerLabelId}, ${label.providerOrderId}, ${label.trackingNumber}, 'pending', ${now}, ${now}, ${now})
          ON CONFLICT (provider_label_id) DO NOTHING`);
      });
    },
    async fail(claim, code, now) {
      z.string().regex(/^[A-Z0-9_]{1,100}$/).parse(code); z.date().parse(now);
      assertUpdated(await db.execute(sql`UPDATE oms.shipstation_label_reconciliation_checkpoint
        SET lease_until = NULL, last_error_code = ${code}, consecutive_failures = consecutive_failures + 1, updated_at = ${now}
        WHERE id = 1 AND version = ${claim.version} AND lease_until > ${now} RETURNING id`));
    },
    async claimOrder(now) {
      z.date().parse(now);
      return db.transaction(async tx => {
        const result = rows(await tx.execute(sql`WITH due AS (
          SELECT provider_label_id FROM oms.shipstation_label_recovery_work
          WHERE state = 'pending' AND next_attempt_at <= ${now} AND (lease_until IS NULL OR lease_until <= ${now})
          ORDER BY next_attempt_at, provider_label_id LIMIT 1 FOR UPDATE SKIP LOCKED
        ) UPDATE oms.shipstation_label_recovery_work work SET version = version + 1, lease_until = ${leaseEnd(now)}, updated_at = ${now}
          FROM due WHERE work.provider_label_id = due.provider_label_id
          RETURNING work.provider_label_id::text, work.provider_order_id::text, work.tracking_number, work.version, work.attempt_count`));
        if (result.length === 0) return null;
        const row = z.object({ provider_label_id: z.coerce.number().int().positive().safe(),
          tracking_number: z.string().trim().min(1).max(200),
          provider_order_id: z.coerce.number().int().positive().safe().nullable(), version: z.number().int().positive(),
          attempt_count: z.number().int().min(0).max(MAX_LABEL_RECOVERY_ATTEMPTS - 1) }).parse(result[0]);
        return { providerLabelId: row.provider_label_id, providerOrderId: row.provider_order_id, trackingNumber: row.tracking_number, version: row.version, attempts: row.attempt_count + 1 };
      });
    },
    async renewOrder(claim, now) {
      recoveryClaimSchema.parse(claim);
      assertUpdated(await db.execute(sql`UPDATE oms.shipstation_label_recovery_work SET lease_until = ${leaseEnd(now)}, updated_at = ${now}
        WHERE provider_label_id = ${claim.providerLabelId} AND version = ${claim.version} AND state = 'pending' AND lease_until > ${now} RETURNING provider_label_id`));
    },
    async finishOrder(claim, completion, now) {
      recoveryClaimSchema.parse(claim);
      z.object({ state: z.enum(['complete', 'pending', 'review']), code: z.string().regex(/^[A-Z0-9_]{1,100}$/).nullable(), nextAttemptAt: z.date().nullable() }).parse(completion);
      z.date().parse(now);
      if ((completion.state === 'pending') !== (completion.nextAttemptAt !== null)
        || (completion.state === 'complete') !== (completion.code === null)
        || (completion.state === 'pending' && (claim.attempts >= MAX_LABEL_RECOVERY_ATTEMPTS || completion.nextAttemptAt! <= now))) {
        throw new LabelReconciliationError('SHIPSTATION_LABEL_RECOVERY_COMPLETION_INVALID');
      }
      await db.transaction(async tx => {
        assertUpdated(await tx.execute(sql`UPDATE oms.shipstation_label_recovery_work SET state = ${completion.state},
          next_attempt_at = ${completion.nextAttemptAt}, last_error_code = ${completion.code}, attempt_count = ${claim.attempts},
          lease_until = NULL, updated_at = ${now}
          WHERE provider_label_id = ${claim.providerLabelId} AND version = ${claim.version} AND state = 'pending'
            AND lease_until > ${now} AND attempt_count = ${claim.attempts - 1} RETURNING provider_label_id`));
        await tx.execute(sql`INSERT INTO oms.shipstation_label_recovery_attempts
          (provider_label_id, attempt_number, outcome, error_code, completed_at, actor)
          VALUES (${claim.providerLabelId}, ${claim.attempts}, ${completion.state}, ${completion.code}, ${now}, 'system:shipstation_label_reconciliation')`);
      });
    },
  };
}
