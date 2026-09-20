import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type { DropshipWalletPolicyLimits } from "../domain/wallet-policy";
import type {
  CreateDropshipWalletPolicyVersionRepositoryInput,
  DropshipWalletPolicyMutationResult,
  DropshipWalletPolicyRecord,
  DropshipWalletPolicyRepository,
  DropshipWalletPolicyVendorImpactCounts,
} from "../application/dropship-wallet-policy-service";

/**
 * PG repository for the staff-managed wallet policy (migration 0681).
 *
 * Column <-> field mapping (the SQL names describe the policy, the TypeScript
 * names match the wallet DTO the portal reads, so the serializer stays a plain
 * pass-through):
 *   minimum_floor_cents                  -> autoReloadMinTriggerCents
 *   minimum_single_top_up_limit_cents    -> autoReloadMinAmountCents
 *   manual_top_up_minimum_cents          -> manualFundingMinCents
 *   manual_top_up_maximum_cents          -> manualFundingMaxCents
 *   default_payment_hold_timeout_minutes -> defaultPaymentHoldTimeoutMinutes
 *   hold_expiry_warning_minutes          -> holdExpiryWarningMinutes
 *
 * Published rows are immutable (DB trigger); a change inserts a new version and
 * retires the previous one inside ONE transaction with its command row and its
 * audit row, so the change can never be half-applied or unattributed.
 */

/** Serializes concurrent version publishes so the one-active-row index is never raced into a retry storm. */
const WALLET_POLICY_ADVISORY_LOCK_ID = 94003;

const COMMAND_TYPE = "wallet_policy_version_created";
const ENTITY_TYPE = "dropship_wallet_policy";

interface PolicyRow {
  id: number;
  version: number;
  minimum_floor_cents: string | number;
  minimum_single_top_up_limit_cents: string | number;
  manual_top_up_minimum_cents: string | number;
  manual_top_up_maximum_cents: string | number;
  default_payment_hold_timeout_minutes: number;
  hold_expiry_warning_minutes: number;
  is_active: boolean;
  change_note: string | null;
  created_at: Date;
  created_by_actor_type: "admin" | "system";
  created_by_actor_id: string | null;
  deactivated_at: Date | null;
}

interface AdminCommandRow {
  id: number;
  command_type: string;
  request_hash: string;
  entity_id: string | null;
}

interface ImpactCountRow {
  below_floor: string | number;
  below_limit: string | number;
  total: string | number;
}

export class PgDropshipWalletPolicyRepository implements DropshipWalletPolicyRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async getActivePolicy(): Promise<DropshipWalletPolicyRecord | null> {
    try {
      const result = await this.dbPool.query<PolicyRow>(
        `SELECT * FROM dropship.dropship_wallet_policies WHERE is_active = true LIMIT 1`,
      );
      const row = result.rows[0];
      return row ? mapPolicyRow(row) : null;
    } catch (error) {
      throw mapWalletPolicyError(error);
    }
  }

  /**
   * Counts already-saved auto-reload rows that sit below a proposed floor.
   *
   * Read-only: nothing here rewrites a vendor's stored configuration. A NULL
   * `max_single_reload_cents` is not counted — an enabled row without a cap is
   * already refused for a different reason, and moving a floor neither creates
   * nor fixes that.
   */
  async countVendorsBelowLimits(input: {
    autoReloadMinTriggerCents: number;
    autoReloadMinAmountCents: number;
  }): Promise<DropshipWalletPolicyVendorImpactCounts> {
    try {
      const result = await this.dbPool.query<ImpactCountRow>(
        `SELECT
           COUNT(*) FILTER (WHERE s.minimum_balance_cents < $1) AS below_floor,
           COUNT(*) FILTER (
             WHERE s.max_single_reload_cents IS NOT NULL
               AND s.max_single_reload_cents < $2
           ) AS below_limit,
           COUNT(*) AS total
         FROM dropship.dropship_auto_reload_settings s
         JOIN dropship.dropship_vendors v ON v.id = s.vendor_id
         WHERE v.status = 'active'`,
        [input.autoReloadMinTriggerCents, input.autoReloadMinAmountCents],
      );
      const row = result.rows[0];
      return {
        vendorsBelowMinimumFloor: count(row?.below_floor ?? 0),
        vendorsBelowMinimumSingleTopUpLimit: count(row?.below_limit ?? 0),
        activeVendorsWithAutoReloadSettings: count(row?.total ?? 0),
      };
    } catch (error) {
      throw mapWalletPolicyError(error);
    }
  }

  async createPolicyVersion(
    input: CreateDropshipWalletPolicyVersionRepositoryInput,
  ): Promise<DropshipWalletPolicyMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimCommand(client, input);
      if (command.idempotentReplay) {
        const policy = await loadPolicyById(client, parseEntityId(command.entityId));
        await client.query("COMMIT");
        // A replay changed nothing, so it has no before -> after to report.
        return { policy, previousPolicy: null, idempotentReplay: true };
      }

      await client.query("SELECT pg_advisory_xact_lock($1)", [WALLET_POLICY_ADVISORY_LOCK_ID]);

      const currentActive = await client.query<PolicyRow>(
        `SELECT * FROM dropship.dropship_wallet_policies WHERE is_active = true FOR UPDATE`,
      );
      const previousPolicy = currentActive.rows[0] ? mapPolicyRow(currentActive.rows[0]) : null;

      const versionResult = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM dropship.dropship_wallet_policies`,
      );
      const version = Number(requiredRow(versionResult.rows[0], "Wallet policy version query returned no row.").version);

      if (previousPolicy) {
        // Retirement is the only UPDATE the immutability trigger permits.
        await client.query(
          `UPDATE dropship.dropship_wallet_policies
           SET is_active = false, deactivated_at = $2
           WHERE id = $1 AND is_active = true`,
          [previousPolicy.policyId, input.now],
        );
      }

      const inserted = await client.query<PolicyRow>(
        `INSERT INTO dropship.dropship_wallet_policies
          (version, minimum_floor_cents, minimum_single_top_up_limit_cents,
           manual_top_up_minimum_cents, manual_top_up_maximum_cents,
           default_payment_hold_timeout_minutes, hold_expiry_warning_minutes,
           is_active, change_note, created_at, created_by_actor_type, created_by_actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11)
         RETURNING *`,
        [
          version,
          input.limits.autoReloadMinTriggerCents,
          input.limits.autoReloadMinAmountCents,
          input.limits.manualFundingMinCents,
          input.limits.manualFundingMaxCents,
          input.limits.defaultPaymentHoldTimeoutMinutes,
          input.limits.holdExpiryWarningMinutes,
          input.changeNote,
          input.now,
          input.actor.actorType,
          input.actor.actorId ?? null,
        ],
      );
      const policy = mapPolicyRow(requiredRow(inserted.rows[0], "Wallet policy insert returned no row."));

      await completeCommand(client, command.commandId, policy.policyId, input.now);
      await recordAuditEvent(client, {
        entityId: policy.policyId,
        actor: input.actor,
        payload: {
          version: policy.version,
          idempotencyKey: input.idempotencyKey,
          changeNote: policy.changeNote,
          before: previousPolicy
            ? { policyId: previousPolicy.policyId, version: previousPolicy.version, ...previousPolicy.limits }
            : null,
          after: { policyId: policy.policyId, version: policy.version, ...policy.limits },
        },
        createdAt: input.now,
      });
      await client.query("COMMIT");
      return { policy, previousPolicy, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw mapWalletPolicyError(error);
    } finally {
      client.release();
    }
  }
}

async function claimCommand(
  client: PoolClient,
  input: CreateDropshipWalletPolicyVersionRepositoryInput,
): Promise<{ commandId: number; entityId: string | null; idempotentReplay: boolean }> {
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO dropship.dropship_admin_config_commands
      (command_type, idempotency_key, request_hash, entity_type, actor_type, actor_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      COMMAND_TYPE,
      input.idempotencyKey,
      input.requestHash,
      ENTITY_TYPE,
      input.actor.actorType,
      input.actor.actorId ?? null,
      input.now,
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) {
    return { commandId: insertedId, entityId: null, idempotentReplay: false };
  }
  const existing = await client.query<AdminCommandRow>(
    `SELECT id, command_type, request_hash, entity_id
     FROM dropship.dropship_admin_config_commands
     WHERE idempotency_key = $1
     FOR UPDATE`,
    [input.idempotencyKey],
  );
  const row = requiredRow(existing.rows[0], "Wallet policy command row was not found after conflict.");
  if (row.command_type !== COMMAND_TYPE || row.request_hash !== input.requestHash) {
    throw new DropshipError(
      "DROPSHIP_WALLET_POLICY_IDEMPOTENCY_CONFLICT",
      "Idempotency key was reused for a different wallet policy request.",
      {
        classification: "permanent",
        idempotencyKey: input.idempotencyKey,
        commandTypeMatches: row.command_type === COMMAND_TYPE,
        requestHashMatches: row.request_hash === input.requestHash,
      },
    );
  }
  if (!row.entity_id) {
    // The original attempt died between claiming the key and finishing. Retry
    // is safe once the incomplete command is resolved, so this is transient.
    throw new DropshipError(
      "DROPSHIP_WALLET_POLICY_COMMAND_INCOMPLETE",
      "Wallet policy command replay is incomplete.",
      { classification: "transient", idempotencyKey: input.idempotencyKey },
    );
  }
  return { commandId: row.id, entityId: row.entity_id, idempotentReplay: true };
}

async function completeCommand(
  client: PoolClient,
  commandId: number,
  policyId: number,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE dropship.dropship_admin_config_commands
     SET entity_type = $2, entity_id = $3, completed_at = $4
     WHERE id = $1`,
    [commandId, ENTITY_TYPE, String(policyId), now],
  );
}

/**
 * The audit row carries the REAL staff actor from the session, not 'system':
 * a limit change is an operator decision and has to be attributable.
 */
async function recordAuditEvent(
  client: PoolClient,
  input: {
    entityId: number;
    actor: { actorType: "admin" | "system"; actorId?: string };
    payload: Record<string, unknown>;
    createdAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, 'info', $6::jsonb, $7)`,
    [
      ENTITY_TYPE,
      String(input.entityId),
      COMMAND_TYPE,
      input.actor.actorType,
      input.actor.actorId ?? null,
      JSON.stringify(input.payload),
      input.createdAt,
    ],
  );
}

async function loadPolicyById(client: PoolClient, policyId: number): Promise<DropshipWalletPolicyRecord> {
  const result = await client.query<PolicyRow>(
    `SELECT * FROM dropship.dropship_wallet_policies WHERE id = $1`,
    [policyId],
  );
  return mapPolicyRow(requiredRow(result.rows[0], "Wallet policy row was not found."));
}

function mapPolicyRow(row: PolicyRow): DropshipWalletPolicyRecord {
  const limits: DropshipWalletPolicyLimits = {
    autoReloadMinTriggerCents: money(row.minimum_floor_cents, "minimum_floor_cents"),
    autoReloadMinAmountCents: money(row.minimum_single_top_up_limit_cents, "minimum_single_top_up_limit_cents"),
    manualFundingMinCents: money(row.manual_top_up_minimum_cents, "manual_top_up_minimum_cents"),
    manualFundingMaxCents: money(row.manual_top_up_maximum_cents, "manual_top_up_maximum_cents"),
    defaultPaymentHoldTimeoutMinutes: minutes(row.default_payment_hold_timeout_minutes, "default_payment_hold_timeout_minutes"),
    holdExpiryWarningMinutes: minutes(row.hold_expiry_warning_minutes, "hold_expiry_warning_minutes"),
  };
  return {
    policyId: row.id,
    version: row.version,
    limits,
    isActive: row.is_active,
    changeNote: row.change_note,
    createdAt: row.created_at,
    createdBy: { actorType: row.created_by_actor_type, actorId: row.created_by_actor_id },
    deactivatedAt: row.deactivated_at,
  };
}

/** bigint cents arrive as strings from pg; a non-integer means the row is unusable. */
function money(value: string | number, column: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_WALLET_POLICY_INVALID_STORED_VALUE",
      "Stored wallet policy money is not a positive integer number of cents.",
      { classification: "fatal", column, value },
    );
  }
  return parsed;
}

function minutes(value: number, column: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DropshipError(
      "DROPSHIP_WALLET_POLICY_INVALID_STORED_VALUE",
      "Stored wallet policy timing is not a positive whole number of minutes.",
      { classification: "fatal", column, value },
    );
  }
  return value;
}

function count(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DropshipError(
      "DROPSHIP_WALLET_POLICY_INVALID_STORED_VALUE",
      "Wallet policy impact count is not a non-negative integer.",
      { classification: "fatal", value },
    );
  }
  return parsed;
}

function parseEntityId(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_WALLET_POLICY_COMMAND_INCOMPLETE",
      "Wallet policy command has no valid entity id.",
      { classification: "transient", entityId: value },
    );
  }
  return parsed;
}

function requiredRow<T>(row: T | null | undefined, message: string): T {
  if (!row) {
    throw new DropshipError("DROPSHIP_WALLET_POLICY_NOT_FOUND", message, { classification: "permanent" });
  }
  return row;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure; the pool discards a client left in a bad state.
  }
}

/**
 * Turns the PG failures this repository can actually provoke into classified
 * dropship errors. Anything else propagates untouched.
 */
export function mapWalletPolicyError(error: unknown): unknown {
  if (error instanceof DropshipError) return error;
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "42P01") {
      return new DropshipError(
        "DROPSHIP_WALLET_POLICY_TABLE_MISSING",
        "Dropship wallet policy table does not exist yet.",
        { classification: "transient", sqlState: code },
      );
    }
    if (code === "23505") {
      return new DropshipError(
        "DROPSHIP_WALLET_POLICY_CONFLICT",
        "Another wallet policy version was published concurrently; retry the request.",
        { classification: "transient", sqlState: code },
      );
    }
    if (code === "23514") {
      return new DropshipError(
        "DROPSHIP_WALLET_POLICY_INVALID_INPUT",
        "Wallet policy values violate a database invariant.",
        { classification: "permanent", sqlState: code },
      );
    }
  }
  return error;
}
