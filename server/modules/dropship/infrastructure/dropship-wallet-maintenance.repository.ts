import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipWalletMaintenanceRepository,
  DropshipWalletMaintenanceRunRecord,
  DropshipWalletMaintenanceRunStatus,
  RecordDropshipWalletMaintenanceOutcomeInput,
} from "../application/dropship-wallet-maintenance-service";
import { DROPSHIP_WALLET_MAINTENANCE_RUN_STATUSES } from "../application/dropship-wallet-maintenance-service";
import { DropshipError } from "../domain/errors";

interface VendorDueRow {
  vendor_id: number;
}

interface RunRow {
  id: number;
  vendor_id: number;
  run_date: string;
  status: string;
  attempt_count: number;
  amount_cents: string | number | null;
  card_fee_cents: string | number | null;
  charged_cents: string | number | null;
  currency: string;
  funding_method_id: number | null;
  funding_status: string | null;
  wallet_ledger_entry_id: number | null;
  provider_payment_intent_id: string | null;
  outcome_code: string | null;
  outcome_message: string | null;
  last_attempt_at: Date | null;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * `run_date` is selected as text on purpose: node-pg turns a `date` column
 * into a JS Date at local midnight, which shifts the day in any non-UTC
 * process. The job keys everything on the `YYYY-MM-DD` string.
 */
const RUN_COLUMNS = `id, vendor_id, run_date::text AS run_date, status, attempt_count,
  amount_cents, card_fee_cents, charged_cents, currency, funding_method_id, funding_status,
  wallet_ledger_entry_id, provider_payment_intent_id, outcome_code, outcome_message,
  last_attempt_at, idempotency_key, created_at, updated_at`;

/** Outcomes a human may need to find later ride the vendor's audit trail. */
const AUDITED_STATUSES: ReadonlySet<DropshipWalletMaintenanceRunStatus> = new Set([
  "reloaded",
  "attention",
  "declined",
  "failed",
]);

export class PgDropshipWalletMaintenanceRepository implements DropshipWalletMaintenanceRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listVendorsDue(input: { runDate: string; limit: number }): Promise<Array<{ vendorId: number }>> {
    // A live vendor always has a wallet account (created on wallet setup);
    // the join is a guard, not a filter. Vendors whose run for the day
    // already reached a terminal status are skipped here, so a healthy fleet
    // costs one indexed query per hourly tick.
    const result = await this.dbPool.query<VendorDueRow>(
      `SELECT v.id AS vendor_id
       FROM dropship.dropship_vendors v
       JOIN dropship.dropship_wallet_accounts wa
         ON wa.vendor_id = v.id
        AND wa.status = 'active'
       LEFT JOIN dropship.dropship_wallet_maintenance_runs r
         ON r.vendor_id = v.id
        AND r.run_date = $1::date
       WHERE v.status = 'active'
         AND (r.id IS NULL OR r.status IN ('pending', 'retry_pending'))
       ORDER BY v.id ASC
       LIMIT $2`,
      [input.runDate, input.limit],
    );
    return result.rows.map((row) => ({ vendorId: row.vendor_id }));
  }

  async claimRun(input: {
    vendorId: number;
    runDate: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<{ run: DropshipWalletMaintenanceRunRecord; created: boolean }> {
    const inserted = await this.dbPool.query<RunRow>(
      `INSERT INTO dropship.dropship_wallet_maintenance_runs
         (vendor_id, run_date, status, attempt_count, idempotency_key, created_at, updated_at)
       VALUES ($1, $2::date, 'pending', 0, $3, $4, $4)
       ON CONFLICT (vendor_id, run_date) DO NOTHING
       RETURNING ${RUN_COLUMNS}`,
      [input.vendorId, input.runDate, input.idempotencyKey, input.now],
    );
    if (inserted.rows[0]) {
      return { run: mapRunRow(inserted.rows[0]), created: true };
    }
    const existing = await this.dbPool.query<RunRow>(
      `SELECT ${RUN_COLUMNS}
       FROM dropship.dropship_wallet_maintenance_runs
       WHERE vendor_id = $1
         AND run_date = $2::date
       LIMIT 1`,
      [input.vendorId, input.runDate],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new DropshipError(
        "DROPSHIP_WALLET_MAINTENANCE_CLAIM_FAILED",
        "Dropship wallet maintenance run claim did not return a row.",
        { vendorId: input.vendorId, runDate: input.runDate },
      );
    }
    return { run: mapRunRow(row), created: false };
  }

  async markAttemptStarted(input: { runId: number; vendorId: number; now: Date }): Promise<DropshipWalletMaintenanceRunRecord> {
    const result = await this.dbPool.query<RunRow>(
      `UPDATE dropship.dropship_wallet_maintenance_runs
       SET attempt_count = attempt_count + 1,
           last_attempt_at = $3,
           updated_at = $3
       WHERE id = $1
         AND vendor_id = $2
       RETURNING ${RUN_COLUMNS}`,
      [input.runId, input.vendorId, input.now],
    );
    return mapRunRow(requireRow(result.rows[0], "Dropship wallet maintenance attempt update did not return a row.", input));
  }

  async recordOutcome(input: RecordDropshipWalletMaintenanceOutcomeInput): Promise<DropshipWalletMaintenanceRunRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<RunRow>(
        `UPDATE dropship.dropship_wallet_maintenance_runs
         SET status = $3,
             amount_cents = $4,
             card_fee_cents = $5,
             charged_cents = $6,
             currency = COALESCE($7, currency),
             funding_method_id = $8,
             funding_status = $9,
             wallet_ledger_entry_id = $10,
             provider_payment_intent_id = $11,
             outcome_code = $12,
             outcome_message = $13,
             updated_at = $14
         WHERE id = $1
           AND vendor_id = $2
         RETURNING ${RUN_COLUMNS}`,
        [
          input.runId,
          input.vendorId,
          input.status,
          input.amountCents,
          input.cardFeeCents,
          input.chargedCents,
          input.currency,
          input.fundingMethodId,
          input.fundingStatus,
          input.walletLedgerEntryId,
          input.providerPaymentIntentId,
          input.outcomeCode,
          input.outcomeMessage,
          input.now,
        ],
      );
      const run = mapRunRow(requireRow(result.rows[0], "Dropship wallet maintenance outcome update did not return a row.", input));
      if (AUDITED_STATUSES.has(run.status)) {
        // Audit rows commit or roll back with the outcome they describe.
        await client.query(
          `INSERT INTO dropship.dropship_audit_events
            (vendor_id, store_connection_id, entity_type, entity_id, event_type,
             actor_type, actor_id, severity, payload, created_at)
           VALUES ($1, NULL, 'dropship_wallet_maintenance_run', $2, $3,
                   'job', 'dropship-wallet-maintenance', 'info', $4::jsonb, $5)`,
          [
            run.vendorId,
            String(run.runId),
            `wallet_maintenance_${run.status}`,
            JSON.stringify(serializeRunForAudit(run)),
            input.now,
          ],
        );
      }
      await client.query("COMMIT");
      return run;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

function serializeRunForAudit(run: DropshipWalletMaintenanceRunRecord): Record<string, unknown> {
  return {
    runId: run.runId,
    vendorId: run.vendorId,
    runDate: run.runDate,
    status: run.status,
    attemptCount: run.attemptCount,
    amountCents: run.amountCents,
    cardFeeCents: run.cardFeeCents,
    chargedCents: run.chargedCents,
    currency: run.currency,
    fundingMethodId: run.fundingMethodId,
    fundingStatus: run.fundingStatus,
    walletLedgerEntryId: run.walletLedgerEntryId,
    providerPaymentIntentId: run.providerPaymentIntentId,
    outcomeCode: run.outcomeCode,
    outcomeMessage: run.outcomeMessage,
    lastAttemptAt: run.lastAttemptAt?.toISOString() ?? null,
  };
}

function mapRunRow(row: RunRow): DropshipWalletMaintenanceRunRecord {
  return {
    runId: row.id,
    vendorId: row.vendor_id,
    runDate: row.run_date,
    status: requireRunStatus(row.status, row.id),
    attemptCount: row.attempt_count,
    amountCents: nullableSafeInteger(row.amount_cents, "amount_cents"),
    cardFeeCents: nullableSafeInteger(row.card_fee_cents, "card_fee_cents"),
    chargedCents: nullableSafeInteger(row.charged_cents, "charged_cents"),
    currency: row.currency,
    fundingMethodId: row.funding_method_id,
    fundingStatus: requireFundingStatus(row.funding_status, row.id),
    walletLedgerEntryId: row.wallet_ledger_entry_id,
    providerPaymentIntentId: row.provider_payment_intent_id,
    outcomeCode: row.outcome_code,
    outcomeMessage: row.outcome_message,
    lastAttemptAt: row.last_attempt_at,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireRunStatus(value: string, runId: number): DropshipWalletMaintenanceRunStatus {
  if ((DROPSHIP_WALLET_MAINTENANCE_RUN_STATUSES as readonly string[]).includes(value)) {
    return value as DropshipWalletMaintenanceRunStatus;
  }
  throw new DropshipError(
    "DROPSHIP_WALLET_MAINTENANCE_RUN_STATUS_INVALID",
    "Dropship wallet maintenance run carries an unknown status.",
    { runId, status: value },
  );
}

function requireFundingStatus(value: string | null, runId: number): "pending" | "settled" | null {
  if (value === null || value === "pending" || value === "settled") return value;
  throw new DropshipError(
    "DROPSHIP_WALLET_MAINTENANCE_FUNDING_STATUS_INVALID",
    "Dropship wallet maintenance run carries an unknown funding status.",
    { runId, fundingStatus: value },
  );
}

function nullableSafeInteger(value: string | number | null, field: string): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DropshipError(
      "DROPSHIP_WALLET_MAINTENANCE_AMOUNT_INVALID",
      "Dropship wallet maintenance run carries a non-integer amount.",
      { field, value },
    );
  }
  return parsed;
}

function requireRow(row: RunRow | undefined, message: string, context: { runId: number; vendorId: number }): RunRow {
  if (!row) {
    throw new DropshipError("DROPSHIP_WALLET_MAINTENANCE_RUN_NOT_FOUND", message, { runId: context.runId, vendorId: context.vendorId });
  }
  return row;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The transaction is already gone; the original error is what matters.
  }
}
