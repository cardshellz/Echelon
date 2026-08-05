import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipCollectionAttemptRecord,
  DropshipCollectionAttemptStatus,
  DropshipCollectionConfigRecord,
  DropshipCollectionSweepRepository,
} from "../application/dropship-collection-sweep-service";
import { DropshipError } from "../domain/errors";

interface ConfigRow {
  id: number;
  version: number;
  grace_days: number;
  sweep_cadence_days: number;
  max_consecutive_failures: number;
  effective_from: Date;
  effective_to: Date | null;
}

interface CollectibleVendorRow {
  vendor_id: number;
  wallet_account_id: number;
  available_balance_cents: string | number;
  currency: string;
  balance_updated_at: Date;
}

interface AttemptRow {
  id: number;
  vendor_id: number;
  period_start: Date;
  period_end: Date;
  amount_cents: string | number;
  currency: string;
  funding_method_id: number | null;
  config_version_id: number | null;
  status: string;
  consecutive_failures: number;
  last_attempt_at: Date | null;
  last_failure_code: string | null;
  last_failure_message: string | null;
  provider_payment_intent_id: string | null;
  wallet_ledger_entry_id: number | null;
  escalated_at: Date | null;
}

interface FundingMethodRow {
  id: number;
  rail: string;
  status: string;
  provider_customer_id: string | null;
  provider_payment_method_id: string | null;
}

export class PgDropshipCollectionSweepRepository implements DropshipCollectionSweepRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async getActiveConfig(at: Date): Promise<DropshipCollectionConfigRecord | null> {
    const result = await this.dbPool.query<ConfigRow>(
      `SELECT id, version, grace_days, sweep_cadence_days, max_consecutive_failures,
              effective_from, effective_to
       FROM dropship.dropship_collection_config
       WHERE is_active = true
         AND effective_from <= $1
         AND (effective_to IS NULL OR effective_to > $1)
       ORDER BY id DESC
       LIMIT 1`,
      [at],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      configId: row.id,
      version: row.version,
      graceDays: row.grace_days,
      sweepCadenceDays: row.sweep_cadence_days,
      maxConsecutiveFailures: row.max_consecutive_failures,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    };
  }

  async listCollectibleVendors(input: {
    now: Date;
    graceDays: number;
    limit: number;
  }): Promise<{
    vendorId: number;
    walletAccountId: number;
    availableBalanceCents: number;
    currency: string;
    balanceUpdatedAt: Date;
  }[]> {
    // The wallet went negative at most updated_at ago: the balance only moves
    // via ledger writes, which touch updated_at. Grace = the balance has been
    // continuously negative since at least (now - graceDays).
    const result = await this.dbPool.query<CollectibleVendorRow>(
      `SELECT wa.vendor_id, wa.id AS wallet_account_id, wa.available_balance_cents,
              wa.currency, wa.updated_at AS balance_updated_at
       FROM dropship.dropship_wallet_accounts wa
       WHERE wa.status = 'active'
         AND wa.available_balance_cents < 0
         AND wa.updated_at <= $1::timestamptz - ($2::text)::interval
       ORDER BY wa.available_balance_cents ASC, wa.vendor_id ASC
       LIMIT $3`,
      [input.now, `${input.graceDays} days`, input.limit],
    );
    return result.rows.map((row) => ({
      vendorId: row.vendor_id,
      walletAccountId: row.wallet_account_id,
      availableBalanceCents: requireSafeInteger(row.available_balance_cents, "available_balance_cents"),
      currency: row.currency,
      balanceUpdatedAt: row.balance_updated_at,
    }));
  }

  async claimAttempt(input: {
    vendorId: number;
    periodStart: Date;
    periodEnd: Date;
    amountCents: number;
    currency: string;
    fundingMethodId: number | null;
    configVersionId: number;
    idempotencyKey: string;
    now: Date;
  }): Promise<{ attempt: DropshipCollectionAttemptRecord; created: boolean }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<AttemptRow>(
        `INSERT INTO dropship.dropship_collection_attempts
          (vendor_id, period_start, period_end, amount_cents, currency,
           funding_method_id, config_version_id, status, consecutive_failures,
           idempotency_key, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending',
                 COALESCE((
                   SELECT a.consecutive_failures
                   FROM dropship.dropship_collection_attempts a
                   WHERE a.vendor_id = $1
                     AND a.status IN ('failed', 'escalated')
                   ORDER BY a.period_start DESC, a.id DESC
                   LIMIT 1
                 ), 0),
                 $8, $9, $9)
         ON CONFLICT (vendor_id, period_start) DO NOTHING
         RETURNING *`,
        [
          input.vendorId,
          input.periodStart,
          input.periodEnd,
          input.amountCents,
          input.currency,
          input.fundingMethodId,
          input.configVersionId,
          input.idempotencyKey,
          input.now,
        ],
      );
      if (inserted.rows[0]) {
        await client.query("COMMIT");
        return { attempt: mapAttemptRow(inserted.rows[0]), created: true };
      }
      const existing = await client.query<AttemptRow>(
        `SELECT * FROM dropship.dropship_collection_attempts
         WHERE vendor_id = $1 AND period_start = $2
         LIMIT 1
         FOR UPDATE`,
        [input.vendorId, input.periodStart],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new DropshipError(
          "DROPSHIP_COLLECTION_ATTEMPT_CLAIM_FAILED",
          "Dropship collection attempt claim did not return a row.",
          { vendorId: input.vendorId },
        );
      }
      await client.query("COMMIT");
      return { attempt: mapAttemptRow(row), created: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getDefaultChargeableFundingMethod(input: {
    vendorId: number;
  }): Promise<{
    fundingMethodId: number;
    rail: string;
    status: string;
    providerCustomerId: string | null;
    providerPaymentMethodId: string | null;
  } | null> {
    const result = await this.dbPool.query<FundingMethodRow>(
      `SELECT id, rail, status, provider_customer_id, provider_payment_method_id
       FROM dropship.dropship_funding_methods
       WHERE vendor_id = $1
         AND status = 'active'
       ORDER BY is_default DESC, id ASC
       LIMIT 1`,
      [input.vendorId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      fundingMethodId: row.id,
      rail: row.rail,
      status: row.status,
      providerCustomerId: row.provider_customer_id,
      providerPaymentMethodId: row.provider_payment_method_id,
    };
  }

  async recordChargeSuccess(input: {
    attemptId: number;
    vendorId: number;
    amountCents: number;
    currency: string;
    fundingMethodId: number;
    providerPaymentIntentId: string;
    externalTransactionId: string | null;
    fundingStatus: "pending" | "settled";
    idempotencyKey: string;
    now: Date;
  }): Promise<{ walletLedgerEntryId: number }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const attempt = await lockAttempt(client, input.attemptId);
      if (attempt.status === "succeeded" && attempt.wallet_ledger_entry_id !== null) {
        // Replay: the wallet credit already posted for this attempt.
        await client.query("COMMIT");
        return { walletLedgerEntryId: attempt.wallet_ledger_entry_id };
      }

      const account = await getOrCreateWalletAccountForUpdate(client, {
        vendorId: input.vendorId,
        currency: input.currency,
        now: input.now,
      });
      const nextAvailable = account.availableBalanceCents + input.amountCents;
      await updateWalletAccountBalance(client, {
        walletAccountId: account.walletAccountId,
        availableBalanceCents: nextAvailable,
        updatedAt: input.now,
      });
      const ledger = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_wallet_ledger
          (wallet_account_id, vendor_id, type, status, amount_cents, currency,
           available_balance_after_cents, pending_balance_after_cents,
           reference_type, reference_id, idempotency_key, funding_method_id,
           external_transaction_id, metadata, created_at, settled_at)
         VALUES ($1, $2, 'funding', $3, $4, $5, $6, $7,
                 'stripe_payment_intent', $8, $9, $10, $11, $12::jsonb, $13,
                 CASE WHEN $3 = 'settled' THEN $13 ELSE NULL END)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          account.walletAccountId,
          input.vendorId,
          input.fundingStatus,
          input.amountCents,
          input.currency,
          nextAvailable,
          account.pendingBalanceCents,
          input.providerPaymentIntentId,
          input.idempotencyKey,
          input.fundingMethodId,
          input.externalTransactionId,
          JSON.stringify({
            provider: "stripe",
            collection: true,
            collectionAttemptId: input.attemptId,
          }),
          input.now,
        ],
      );
      let walletLedgerEntryId: number;
      if (ledger.rows[0]) {
        walletLedgerEntryId = ledger.rows[0].id;
      } else {
        const existing = await client.query<{ id: number }>(
          `SELECT id FROM dropship.dropship_wallet_ledger WHERE idempotency_key = $1 LIMIT 1`,
          [input.idempotencyKey],
        );
        walletLedgerEntryId = requiredRow(
          existing.rows[0],
          "Dropship collection wallet ledger replay row was not found.",
        ).id;
      }

      const updated = await client.query(
        `UPDATE dropship.dropship_collection_attempts
         SET status = 'succeeded',
             consecutive_failures = 0,
             last_attempt_at = $2,
             provider_payment_intent_id = $3,
             wallet_ledger_entry_id = $4,
             updated_at = $2
         WHERE id = $1`,
        [input.attemptId, input.now, input.providerPaymentIntentId, walletLedgerEntryId],
      );
      assertOneRowAffected(updated.rowCount, "Dropship collection attempt success update failed.");

      await recordCollectionAuditEvent(client, {
        vendorId: input.vendorId,
        attemptId: input.attemptId,
        eventType: "collection_charge_succeeded",
        payload: {
          amountCents: input.amountCents,
          currency: input.currency,
          providerPaymentIntentId: input.providerPaymentIntentId,
          walletLedgerEntryId,
        },
        occurredAt: input.now,
      });

      await client.query("COMMIT");
      return { walletLedgerEntryId };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordChargeFailure(input: {
    attemptId: number;
    vendorId: number;
    failureCode: string;
    failureMessage: string;
    escalate: boolean;
    now: Date;
  }): Promise<{ consecutiveFailures: number; escalated: boolean }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const attempt = await lockAttempt(client, input.attemptId);
      if (attempt.status === "succeeded" || attempt.status === "escalated") {
        // Terminal states never move again (a success that raced the failure
        // report wins; an escalated attempt stays escalated).
        await client.query("COMMIT");
        return {
          consecutiveFailures: attempt.consecutive_failures,
          escalated: attempt.status === "escalated",
        };
      }
      const nextFailures = attempt.consecutive_failures + 1;
      const nextStatus: DropshipCollectionAttemptStatus = input.escalate ? "escalated" : "failed";
      const updated = await client.query<{ consecutive_failures: number }>(
        `UPDATE dropship.dropship_collection_attempts
         SET status = $2,
             consecutive_failures = $3,
             last_attempt_at = $4,
             last_failure_code = $5,
             last_failure_message = $6,
             escalated_at = CASE WHEN $2 = 'escalated' THEN $4 ELSE escalated_at END,
             updated_at = $4
         WHERE id = $1
         RETURNING consecutive_failures`,
        [
          input.attemptId,
          nextStatus,
          nextFailures,
          input.now,
          input.failureCode,
          input.failureMessage.slice(0, 2000),
        ],
      );
      const row = requiredRow(updated.rows[0], "Dropship collection attempt failure update failed.");
      await recordCollectionAuditEvent(client, {
        vendorId: input.vendorId,
        attemptId: input.attemptId,
        eventType: input.escalate ? "collection_escalated" : "collection_charge_failed",
        payload: {
          failureCode: input.failureCode,
          consecutiveFailures: nextFailures,
          escalated: input.escalate,
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return { consecutiveFailures: row.consecutive_failures, escalated: input.escalate };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async carryForwardEscalation(input: {
    attemptId: number;
    now: Date;
  }): Promise<{ consecutiveFailures: number }> {
    const result = await this.dbPool.query<{ consecutive_failures: number }>(
      `UPDATE dropship.dropship_collection_attempts
       SET status = 'escalated',
           escalated_at = COALESCE(escalated_at, $2),
           updated_at = $2
       WHERE id = $1
         AND status = 'pending'
       RETURNING consecutive_failures`,
      [input.attemptId, input.now],
    );
    const row = result.rows[0];
    if (!row) {
      // Already moved on (concurrent run) — read the current state.
      const current = await this.dbPool.query<{ consecutive_failures: number }>(
        `SELECT consecutive_failures FROM dropship.dropship_collection_attempts WHERE id = $1 LIMIT 1`,
        [input.attemptId],
      );
      return { consecutiveFailures: current.rows[0]?.consecutive_failures ?? 0 };
    }
    return { consecutiveFailures: row.consecutive_failures };
  }
}

async function lockAttempt(client: PoolClient, attemptId: number): Promise<{
  status: DropshipCollectionAttemptStatus;
  consecutive_failures: number;
  wallet_ledger_entry_id: number | null;
}> {
  const result = await client.query<{
    status: string;
    consecutive_failures: number;
    wallet_ledger_entry_id: number | null;
  }>(
    `SELECT status, consecutive_failures, wallet_ledger_entry_id
     FROM dropship.dropship_collection_attempts
     WHERE id = $1
     LIMIT 1
     FOR UPDATE`,
    [attemptId],
  );
  const row = requiredRow(result.rows[0], "Dropship collection attempt was not found.");
  return {
    status: row.status as DropshipCollectionAttemptStatus,
    consecutive_failures: row.consecutive_failures,
    wallet_ledger_entry_id: row.wallet_ledger_entry_id,
  };
}

async function getOrCreateWalletAccountForUpdate(
  client: PoolClient,
  input: { vendorId: number; currency: string; now: Date },
): Promise<{
  walletAccountId: number;
  availableBalanceCents: number;
  pendingBalanceCents: number;
}> {
  await client.query(
    `INSERT INTO dropship.dropship_wallet_accounts
      (vendor_id, available_balance_cents, pending_balance_cents, currency, status, created_at, updated_at)
     VALUES ($1, 0, 0, $2, 'active', $3, $3)
     ON CONFLICT (vendor_id) DO NOTHING`,
    [input.vendorId, input.currency, input.now],
  );
  const result = await client.query<{
    id: number;
    available_balance_cents: string | number;
    pending_balance_cents: string | number;
  }>(
    `SELECT id, available_balance_cents, pending_balance_cents
     FROM dropship.dropship_wallet_accounts
     WHERE vendor_id = $1
     LIMIT 1
     FOR UPDATE`,
    [input.vendorId],
  );
  const row = requiredRow(result.rows[0], "Dropship wallet account was not found for collection.");
  return {
    walletAccountId: row.id,
    availableBalanceCents: requireSafeInteger(row.available_balance_cents, "available_balance_cents"),
    pendingBalanceCents: requireSafeInteger(row.pending_balance_cents, "pending_balance_cents"),
  };
}

async function updateWalletAccountBalance(
  client: PoolClient,
  input: { walletAccountId: number; availableBalanceCents: number; updatedAt: Date },
): Promise<void> {
  const result = await client.query(
    `UPDATE dropship.dropship_wallet_accounts
     SET available_balance_cents = $2, updated_at = $3
     WHERE id = $1`,
    [input.walletAccountId, input.availableBalanceCents, input.updatedAt],
  );
  assertOneRowAffected(result.rowCount, "Dropship wallet balance update failed for collection.");
}

async function recordCollectionAuditEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    attemptId: number;
    eventType: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, NULL, 'dropship_collection_attempt', $2, $3,
             'job', 'dropship-collection-sweep', 'info', $4::jsonb, $5)`,
    [
      input.vendorId,
      String(input.attemptId),
      input.eventType,
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
}

function mapAttemptRow(row: AttemptRow): DropshipCollectionAttemptRecord {
  return {
    attemptId: row.id,
    vendorId: row.vendor_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    amountCents: requireSafeInteger(row.amount_cents, "amount_cents"),
    currency: row.currency,
    fundingMethodId: row.funding_method_id,
    configVersionId: row.config_version_id,
    status: row.status as DropshipCollectionAttemptStatus,
    consecutiveFailures: row.consecutive_failures,
    lastAttemptAt: row.last_attempt_at,
    lastFailureCode: row.last_failure_code,
    lastFailureMessage: row.last_failure_message,
    providerPaymentIntentId: row.provider_payment_intent_id,
    walletLedgerEntryId: row.wallet_ledger_entry_id,
    escalatedAt: row.escalated_at,
  };
}

function requireSafeInteger(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DropshipError(
      "DROPSHIP_COLLECTION_STORED_MONEY_INVALID",
      `${field} is not a safe integer.`,
      { value: String(value) },
    );
  }
  return parsed;
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) {
    throw new DropshipError("DROPSHIP_COLLECTION_WRITE_INCOMPLETE", message);
  }
  return row;
}

function assertOneRowAffected(rowCount: number | null, message: string): void {
  if (rowCount !== 1) {
    throw new DropshipError("DROPSHIP_COLLECTION_WRITE_INCOMPLETE", message, { rowCount });
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
