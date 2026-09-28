import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  dropshipCostChangePolicySettingsSchema,
  type DropshipCostChangePolicySettings,
} from "../../../../shared/dropship/cost-change-policy";
import { DropshipError } from "../domain/errors";
import type {
  CreateDropshipCostChangePolicyVersionRepositoryInput,
  DropshipCostChangePolicyMutationResult,
  DropshipCostChangePolicyRecord,
  DropshipCostChangePolicyRepository,
} from "../application/dropship-cost-change-policy-service";
import {
  claimAdminConfigCommand,
  completeAdminConfigCommand,
  parseAdminConfigCommandEntityId,
  rollbackQuietly,
} from "./dropship-admin-config-command";

/**
 * PG repository for the staff-set .ops cost change policy (migration 0710).
 *
 * Published rows are immutable (DB trigger). A change inserts a new version and
 * retires the previous one inside ONE transaction with its idempotency command
 * row and its audit row, so a change is never half-applied or unattributed.
 * Stored rows are re-validated against the shared settings schema on read: a
 * row that fails it is refused, never trusted.
 */

/** Serializes concurrent publishes so the one-active-row index is never raced. Next to the wallet policy's 94003. */
const COST_CHANGE_POLICY_ADVISORY_LOCK_ID = 94004;

const COMMAND_TYPE = "cost_change_policy_version_created";
const ENTITY_TYPE = "dropship_cost_change_policy";
const COMMAND_CODES = {
  idempotencyConflict: "DROPSHIP_COST_CHANGE_POLICY_IDEMPOTENCY_CONFLICT",
  commandIncomplete: "DROPSHIP_COST_CHANGE_POLICY_COMMAND_INCOMPLETE",
};

interface PolicyRow {
  id: number;
  version: number;
  increase_notice_days: number;
  decrease_timing: string;
  price_protection: boolean;
  retail_changes_get_notice: boolean;
  notify_by_email: boolean;
  notify_in_portal: boolean;
  notify_on_decrease: boolean;
  notice_minimum_change_cents: number;
  notice_minimum_change_bps: number;
  rule_priced_listings: string;
  below_cost_fixed_listings: string;
  detection_interval_minutes: number;
  is_active: boolean;
  change_note: string;
  created_at: Date;
  created_by_actor_type: "admin" | "system";
  created_by_actor_id: string | null;
  deactivated_at: Date | null;
}

export class PgDropshipCostChangePolicyRepository implements DropshipCostChangePolicyRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async getActivePolicy(): Promise<DropshipCostChangePolicyRecord | null> {
    try {
      const result = await this.dbPool.query<PolicyRow>(
        `SELECT * FROM dropship.dropship_cost_change_policies WHERE is_active = true LIMIT 1`,
      );
      const row = result.rows[0];
      return row ? mapPolicyRow(row) : null;
    } catch (error) {
      throw mapCostChangePolicyError(error);
    }
  }

  async listPolicyVersions(limit: number): Promise<DropshipCostChangePolicyRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new DropshipError("DROPSHIP_COST_CHANGE_POLICY_INVALID_INPUT", "Version history limit must be a positive integer.",
        { classification: "permanent", limit });
    }
    try {
      const result = await this.dbPool.query<PolicyRow>(
        `SELECT * FROM dropship.dropship_cost_change_policies ORDER BY version DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map(mapPolicyRow);
    } catch (error) {
      throw mapCostChangePolicyError(error);
    }
  }

  async createPolicyVersion(
    input: CreateDropshipCostChangePolicyVersionRepositoryInput,
  ): Promise<DropshipCostChangePolicyMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminConfigCommand(client, {
        commandType: COMMAND_TYPE,
        entityType: ENTITY_TYPE,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        actor: input.actor,
        now: input.now,
        codes: COMMAND_CODES,
      });
      if (command.idempotentReplay) {
        const policy = await loadPolicyById(client,
          parseAdminConfigCommandEntityId(command.entityId, COMMAND_CODES.commandIncomplete));
        await client.query("COMMIT");
        // A replay changed nothing, so it has no before -> after.
        return { policy, previousPolicy: null, idempotentReplay: true };
      }

      await client.query("SELECT pg_advisory_xact_lock($1)", [COST_CHANGE_POLICY_ADVISORY_LOCK_ID]);
      const currentActive = await client.query<PolicyRow>(
        `SELECT * FROM dropship.dropship_cost_change_policies WHERE is_active = true FOR UPDATE`,
      );
      const previousPolicy = currentActive.rows[0] ? mapPolicyRow(currentActive.rows[0]) : null;
      const versionResult = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM dropship.dropship_cost_change_policies`,
      );
      const version = Number(requiredRow(versionResult.rows[0], "Cost change policy version query returned no row.").version);

      if (previousPolicy) {
        // Retirement is the only UPDATE the immutability trigger permits.
        await client.query(
          `UPDATE dropship.dropship_cost_change_policies
           SET is_active = false, deactivated_at = $2
           WHERE id = $1 AND is_active = true`,
          [previousPolicy.policyId, input.now],
        );
      }

      const settings = input.settings;
      const inserted = await client.query<PolicyRow>(
        `INSERT INTO dropship.dropship_cost_change_policies
          (version, increase_notice_days, decrease_timing, price_protection, retail_changes_get_notice,
           notify_by_email, notify_in_portal, notify_on_decrease, notice_minimum_change_cents, notice_minimum_change_bps,
           rule_priced_listings, below_cost_fixed_listings, detection_interval_minutes,
           is_active, change_note, created_at, created_by_actor_type, created_by_actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true, $14, $15, $16, $17)
         RETURNING *`,
        [
          version,
          settings.increaseNoticeDays,
          settings.decreaseTiming,
          settings.priceProtection,
          settings.retailChangesGetNotice,
          settings.notifyByEmail,
          settings.notifyInPortal,
          settings.notifyOnDecrease,
          settings.noticeMinimumChangeCents,
          settings.noticeMinimumChangeBps,
          settings.rulePricedListings,
          settings.belowCostFixedListings,
          settings.detectionIntervalMinutes,
          input.changeNote,
          input.now,
          input.actor.actorType,
          input.actor.actorId ?? null,
        ],
      );
      const policy = mapPolicyRow(requiredRow(inserted.rows[0], "Cost change policy insert returned no row."));

      await completeAdminConfigCommand(client, {
        commandId: command.commandId,
        entityType: ENTITY_TYPE,
        entityId: String(policy.policyId),
        now: input.now,
      });
      // The audit row carries the real staff actor: a policy change is an
      // operator decision and has to be attributable.
      await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, 'info', $6::jsonb, $7)`,
        [
          ENTITY_TYPE,
          String(policy.policyId),
          COMMAND_TYPE,
          input.actor.actorType,
          input.actor.actorId ?? null,
          JSON.stringify({
            version: policy.version,
            idempotencyKey: input.idempotencyKey,
            changeNote: policy.changeNote,
            before: previousPolicy
              ? { policyId: previousPolicy.policyId, version: previousPolicy.version, ...previousPolicy.settings }
              : null,
            after: { policyId: policy.policyId, version: policy.version, ...policy.settings },
          }),
          input.now,
        ],
      );
      await client.query("COMMIT");
      return { policy, previousPolicy, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw mapCostChangePolicyError(error);
    } finally {
      client.release();
    }
  }
}

async function loadPolicyById(client: PoolClient, policyId: number): Promise<DropshipCostChangePolicyRecord> {
  const result = await client.query<PolicyRow>(
    `SELECT * FROM dropship.dropship_cost_change_policies WHERE id = $1`,
    [policyId],
  );
  return mapPolicyRow(requiredRow(result.rows[0], "Cost change policy for an idempotent replay was not found."));
}

export function mapPolicyRow(row: PolicyRow): DropshipCostChangePolicyRecord {
  const parsed = dropshipCostChangePolicySettingsSchema.safeParse({
    increaseNoticeDays: row.increase_notice_days,
    decreaseTiming: row.decrease_timing,
    priceProtection: row.price_protection,
    retailChangesGetNotice: row.retail_changes_get_notice,
    notifyByEmail: row.notify_by_email,
    notifyInPortal: row.notify_in_portal,
    notifyOnDecrease: row.notify_on_decrease,
    noticeMinimumChangeCents: row.notice_minimum_change_cents,
    noticeMinimumChangeBps: row.notice_minimum_change_bps,
    rulePricedListings: row.rule_priced_listings,
    belowCostFixedListings: row.below_cost_fixed_listings,
    detectionIntervalMinutes: row.detection_interval_minutes,
  });
  if (!parsed.success) {
    // The table's CHECKs mirror the schema, so a row that fails it means those
    // constraints were bypassed: abort and alert, as the wallet policy does.
    throw new DropshipError("DROPSHIP_COST_CHANGE_POLICY_INVALID_STORED_VALUE",
      "A stored cost change policy version failed the settings contract.", {
        classification: "fatal",
        policyId: row.id,
        issues: parsed.error.issues.map((issue) => issue.path.join(".")),
      });
  }
  const settings: DropshipCostChangePolicySettings = parsed.data;
  return {
    policyId: row.id,
    version: row.version,
    settings,
    isActive: row.is_active,
    changeNote: row.change_note,
    createdAt: row.created_at,
    createdBy: { actorType: row.created_by_actor_type, actorId: row.created_by_actor_id },
    deactivatedAt: row.deactivated_at,
  };
}

function requiredRow<T>(row: T | null | undefined, message: string): T {
  if (!row) {
    throw new DropshipError("DROPSHIP_COST_CHANGE_POLICY_NOT_FOUND", message, { classification: "permanent" });
  }
  return row;
}

/** The PG failures this repository can provoke, as classified dropship errors. Anything else propagates untouched. */
export function mapCostChangePolicyError(error: unknown): unknown {
  if (error instanceof DropshipError) return error;
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "42P01") {
      return new DropshipError("DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING", "Dropship cost change policy table does not exist yet.",
        { classification: "transient", sqlState: code });
    }
    if (code === "23505") {
      return new DropshipError("DROPSHIP_COST_CHANGE_POLICY_CONFLICT",
        "Another cost change policy version was published concurrently; retry the request.",
        { classification: "transient", sqlState: code });
    }
    if (code === "23514") {
      return new DropshipError("DROPSHIP_COST_CHANGE_POLICY_INVALID_INPUT", "Cost change policy values violate a database invariant.",
        { classification: "permanent", sqlState: code });
    }
  }
  return error;
}
