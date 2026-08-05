import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  CreateReturnFeeVersionInput,
  CreateReturnPolicyVersionInput,
  DropshipResolvedReturnFees,
  DropshipReturnFeeFaultCategory,
  DropshipReturnFeeMutationResult,
  DropshipReturnFeeScheduleRecord,
  DropshipReturnFeeType,
  DropshipReturnPolicyMutationResult,
  DropshipReturnPolicyRepository,
  DropshipReturnPolicyVersionRecord,
} from "../application/dropship-return-policy-service";

interface PolicyRow {
  id: number;
  version: number;
  return_window_days: number;
  vendor_id: number | null;
  store_connection_id: number | null;
  priority: number;
  is_active: boolean;
  effective_from: Date;
  effective_to: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface FeeRow {
  id: number;
  version: number;
  fee_type: DropshipReturnFeeType;
  fault_category: DropshipReturnFeeFaultCategory;
  amount_type: "flat_cents" | "percent";
  amount: string | number;
  vendor_id: number | null;
  store_connection_id: number | null;
  priority: number;
  is_active: boolean;
  effective_from: Date;
  effective_to: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AdminCommandRow {
  id: number;
  command_type: string;
  request_hash: string;
  entity_id: string | null;
}

type CreatePolicyRepositoryInput = Omit<
  CreateReturnPolicyVersionInput,
  "idempotencyKey" | "actor" | "vendorId" | "storeConnectionId"
> & {
  vendorId: number | null;
  storeConnectionId: number | null;
  effectiveFrom: Date;
  idempotencyKey: string;
  actor: { actorType: "admin" | "system"; actorId?: string };
  now: Date;
};

type CreateFeeRepositoryInput = Omit<
  CreateReturnFeeVersionInput,
  "idempotencyKey" | "actor" | "vendorId" | "storeConnectionId"
> & {
  vendorId: number | null;
  storeConnectionId: number | null;
  effectiveFrom: Date;
  idempotencyKey: string;
  actor: { actorType: "admin" | "system"; actorId?: string };
  now: Date;
};

/**
 * PG repository for hierarchical return policy + fee schedule resolution.
 *
 * Scope precedence (design spec D1/D2): vendor+store (specificity 4) > vendor
 * (3) > store (2) > global (1). Within a scope level: priority DESC, id DESC.
 */
export class PgDropshipReturnPolicyRepository implements DropshipReturnPolicyRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async resolveReturnPolicy(input: {
    vendorId: number | null;
    storeConnectionId: number | null;
    at: Date;
  }): Promise<DropshipReturnPolicyVersionRecord | null> {
    const result = await this.dbPool.query<PolicyRow & { specificity: number }>(
      `SELECT p.*, scope.specificity
       FROM dropship.dropship_return_policies p
       JOIN (
         VALUES
           (1, 'global'),
           (2, 'store'),
           (3, 'vendor'),
           (4, 'vendor_store')
       ) AS scope(specificity, scope_name) ON true
       WHERE p.is_active = true
         AND p.effective_from <= $3
         AND (p.effective_to IS NULL OR p.effective_to > $3)
         AND CASE scope.scope_name
           WHEN 'global' THEN p.vendor_id IS NULL AND p.store_connection_id IS NULL
           WHEN 'store' THEN p.vendor_id IS NULL AND p.store_connection_id = $2
           WHEN 'vendor' THEN p.vendor_id = $1 AND p.store_connection_id IS NULL
           WHEN 'vendor_store' THEN p.vendor_id = $1 AND p.store_connection_id = $2
         END
       ORDER BY scope.specificity DESC, p.priority DESC, p.id DESC
       LIMIT 1`,
      [input.vendorId, input.storeConnectionId, input.at],
    );
    const row = result.rows[0];
    return row ? mapPolicyRow(row) : null;
  }

  async resolveReturnFees(input: {
    vendorId: number | null;
    storeConnectionId: number | null;
    faultCategory: DropshipReturnFeeFaultCategory;
    at: Date;
  }): Promise<DropshipResolvedReturnFees> {
    const result = await this.dbPool.query<FeeRow & { specificity: number }>(
      `SELECT f.*, scope.specificity
       FROM dropship.dropship_return_fee_schedule f
       JOIN (
         VALUES
           (1, 'global'),
           (2, 'store'),
           (3, 'vendor'),
           (4, 'vendor_store')
       ) AS scope(specificity, scope_name) ON true
       WHERE f.is_active = true
         AND f.fault_category = $4
         AND f.effective_from <= $3
         AND (f.effective_to IS NULL OR f.effective_to > $3)
         AND CASE scope.scope_name
           WHEN 'global' THEN f.vendor_id IS NULL AND f.store_connection_id IS NULL
           WHEN 'store' THEN f.vendor_id IS NULL AND f.store_connection_id = $2
           WHEN 'vendor' THEN f.vendor_id = $1 AND f.store_connection_id IS NULL
           WHEN 'vendor_store' THEN f.vendor_id = $1 AND f.store_connection_id = $2
         END
       ORDER BY f.fee_type, scope.specificity DESC, f.priority DESC, f.id DESC`,
      [input.vendorId, input.storeConnectionId, input.at, input.faultCategory],
    );
    const resolved: DropshipResolvedReturnFees = {
      restockingFee: null,
      processingFee: null,
      returnShippingFee: null,
    };
    // Rows arrive ordered by fee_type then precedence — first row per type wins.
    for (const row of result.rows) {
      const record = mapFeeRow(row);
      if (record.feeType === "restocking_fee" && !resolved.restockingFee) {
        resolved.restockingFee = record;
      } else if (record.feeType === "processing_fee" && !resolved.processingFee) {
        resolved.processingFee = record;
      } else if (record.feeType === "return_shipping_fee" && !resolved.returnShippingFee) {
        resolved.returnShippingFee = record;
      }
    }
    return resolved;
  }

  async listPolicies(input: {
    vendorId?: number | null;
    storeConnectionId?: number | null;
    includeInactive: boolean;
  }): Promise<DropshipReturnPolicyVersionRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (input.vendorId !== undefined) {
      params.push(input.vendorId);
      where.push(input.vendorId === null ? "vendor_id IS NULL" : `vendor_id = $${params.length}`);
    }
    if (input.storeConnectionId !== undefined) {
      params.push(input.storeConnectionId);
      where.push(input.storeConnectionId === null
        ? "store_connection_id IS NULL"
        : `store_connection_id = $${params.length}`);
    }
    if (!input.includeInactive) {
      where.push("is_active = true");
    }
    const result = await this.dbPool.query<PolicyRow>(
      `SELECT *
       FROM dropship.dropship_return_policies
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY vendor_id NULLS FIRST, store_connection_id NULLS FIRST, priority DESC, id DESC`,
      params,
    );
    return result.rows.map(mapPolicyRow);
  }

  async listFees(input: {
    vendorId?: number | null;
    storeConnectionId?: number | null;
    feeType?: DropshipReturnFeeType;
    faultCategory?: DropshipReturnFeeFaultCategory;
    includeInactive: boolean;
  }): Promise<DropshipReturnFeeScheduleRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (input.vendorId !== undefined) {
      params.push(input.vendorId);
      where.push(input.vendorId === null ? "vendor_id IS NULL" : `vendor_id = $${params.length}`);
    }
    if (input.storeConnectionId !== undefined) {
      params.push(input.storeConnectionId);
      where.push(input.storeConnectionId === null
        ? "store_connection_id IS NULL"
        : `store_connection_id = $${params.length}`);
    }
    if (input.feeType) {
      params.push(input.feeType);
      where.push(`fee_type = $${params.length}`);
    }
    if (input.faultCategory) {
      params.push(input.faultCategory);
      where.push(`fault_category = $${params.length}`);
    }
    if (!input.includeInactive) {
      where.push("is_active = true");
    }
    const result = await this.dbPool.query<FeeRow>(
      `SELECT *
       FROM dropship.dropship_return_fee_schedule
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY fee_type, fault_category, vendor_id NULLS FIRST, store_connection_id NULLS FIRST, priority DESC, id DESC`,
      params,
    );
    return result.rows.map(mapFeeRow);
  }

  async createPolicyVersion(input: CreatePolicyRepositoryInput): Promise<DropshipReturnPolicyMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminCommand(client, "return_policy_version_created", input, {
        returnWindowDays: input.returnWindowDays,
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        priority: input.priority,
        effectiveFrom: input.effectiveFrom.toISOString(),
      });
      if (command.idempotentReplay) {
        const policy = await loadPolicyByIdWithClient(client, parseEntityId(command.entityId));
        await client.query("COMMIT");
        return { policy, idempotentReplay: true };
      }

      const version = await nextPolicyVersion(client, {
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
      });
      // Exactly-one-active-global invariant: supersede the current active
      // global row when the new row is global and effective now.
      if (input.vendorId === null && input.storeConnectionId === null && input.effectiveFrom <= input.now) {
        await client.query(
          `UPDATE dropship.dropship_return_policies
           SET is_active = false, effective_to = $1, updated_at = $1
           WHERE vendor_id IS NULL AND store_connection_id IS NULL AND is_active = true`,
          [input.now],
        );
      }
      const inserted = await client.query<PolicyRow>(
        `INSERT INTO dropship.dropship_return_policies
          (version, return_window_days, vendor_id, store_connection_id, priority,
           is_active, effective_from, effective_to, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, NULL, $7, $7)
         RETURNING *`,
        [
          version,
          input.returnWindowDays,
          input.vendorId,
          input.storeConnectionId,
          input.priority,
          input.effectiveFrom,
          input.now,
        ],
      );
      const policy = mapPolicyRow(requiredRow(inserted.rows[0], "Dropship return policy insert returned no row."));
      await completeAdminCommand(client, command.commandId, "dropship_return_policies", policy.policyId, input.now);
      await recordPolicyAuditEvent(client, {
        entityId: String(policy.policyId),
        eventType: "return_policy_version_created",
        actor: input.actor,
        payload: {
          version: policy.version,
          vendorId: policy.vendorId,
          storeConnectionId: policy.storeConnectionId,
          returnWindowDays: policy.returnWindowDays,
          priority: policy.priority,
          effectiveFrom: policy.effectiveFrom.toISOString(),
          idempotencyKey: input.idempotencyKey,
        },
        createdAt: input.now,
      });
      await client.query("COMMIT");
      return { policy, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findPolicyReplayAfterUniqueConflict(input);
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async createFeeVersion(input: CreateFeeRepositoryInput): Promise<DropshipReturnFeeMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminCommand(client, "return_fee_version_created", input, {
        feeType: input.feeType,
        faultCategory: input.faultCategory,
        amountType: input.amountType,
        amount: input.amount,
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        priority: input.priority,
        effectiveFrom: input.effectiveFrom.toISOString(),
      });
      if (command.idempotentReplay) {
        const fee = await loadFeeByIdWithClient(client, parseEntityId(command.entityId));
        await client.query("COMMIT");
        return { fee, idempotentReplay: true };
      }

      const version = await nextFeeVersion(client, {
        feeType: input.feeType,
        faultCategory: input.faultCategory,
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
      });
      const inserted = await client.query<FeeRow>(
        `INSERT INTO dropship.dropship_return_fee_schedule
          (version, fee_type, fault_category, amount_type, amount,
           vendor_id, store_connection_id, priority, is_active,
           effective_from, effective_to, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, NULL, $10, $10)
         RETURNING *`,
        [
          version,
          input.feeType,
          input.faultCategory,
          input.amountType,
          input.amount,
          input.vendorId,
          input.storeConnectionId,
          input.priority,
          input.effectiveFrom,
          input.now,
        ],
      );
      const fee = mapFeeRow(requiredRow(inserted.rows[0], "Dropship return fee insert returned no row."));
      await completeAdminCommand(client, command.commandId, "dropship_return_fee_schedule", fee.feeId, input.now);
      await recordPolicyAuditEvent(client, {
        entityId: String(fee.feeId),
        eventType: "return_fee_version_created",
        actor: input.actor,
        payload: {
          version: fee.version,
          feeType: fee.feeType,
          faultCategory: fee.faultCategory,
          amountType: fee.amountType,
          amount: fee.amount,
          vendorId: fee.vendorId,
          storeConnectionId: fee.storeConnectionId,
          priority: fee.priority,
          effectiveFrom: fee.effectiveFrom.toISOString(),
          idempotencyKey: input.idempotencyKey,
        },
        createdAt: input.now,
      });
      await client.query("COMMIT");
      return { fee, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findFeeReplayAfterUniqueConflict(input);
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async deactivatePolicy(input: {
    policyId: number;
    idempotencyKey: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    now: Date;
  }): Promise<DropshipReturnPolicyMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminCommand(client, "return_policy_deactivated", input, {
        policyId: input.policyId,
      });
      if (command.idempotentReplay) {
        const policy = await loadPolicyByIdWithClient(client, parseEntityId(command.entityId));
        await client.query("COMMIT");
        return { policy, idempotentReplay: true };
      }
      const updated = await client.query<PolicyRow>(
        `UPDATE dropship.dropship_return_policies
         SET is_active = false, effective_to = COALESCE(effective_to, $2), updated_at = $2
         WHERE id = $1 AND is_active = true
         RETURNING *`,
        [input.policyId, input.now],
      );
      const row = updated.rows[0];
      if (!row) {
        const existing = await client.query<PolicyRow & { is_active: boolean }>(
          `SELECT * FROM dropship.dropship_return_policies WHERE id = $1 LIMIT 1`,
          [input.policyId],
        );
        if (!existing.rows[0]) {
          throw new DropshipError("DROPSHIP_RETURN_POLICY_NOT_FOUND", "Dropship return policy was not found.", {
            policyId: input.policyId,
          });
        }
        throw new DropshipError(
          "DROPSHIP_RETURN_POLICY_ALREADY_INACTIVE",
          "Dropship return policy is already inactive.",
          { policyId: input.policyId },
        );
      }
      const policy = mapPolicyRow(row);
      await completeAdminCommand(client, command.commandId, "dropship_return_policies", policy.policyId, input.now);
      await recordPolicyAuditEvent(client, {
        entityId: String(policy.policyId),
        eventType: "return_policy_deactivated",
        actor: input.actor,
        payload: { idempotencyKey: input.idempotencyKey },
        createdAt: input.now,
      });
      await client.query("COMMIT");
      return { policy, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async deactivateFee(input: {
    feeId: number;
    idempotencyKey: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    now: Date;
  }): Promise<DropshipReturnFeeMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminCommand(client, "return_fee_deactivated", input, {
        feeId: input.feeId,
      });
      if (command.idempotentReplay) {
        const fee = await loadFeeByIdWithClient(client, parseEntityId(command.entityId));
        await client.query("COMMIT");
        return { fee, idempotentReplay: true };
      }
      const updated = await client.query<FeeRow>(
        `UPDATE dropship.dropship_return_fee_schedule
         SET is_active = false, effective_to = COALESCE(effective_to, $2), updated_at = $2
         WHERE id = $1 AND is_active = true
         RETURNING *`,
        [input.feeId, input.now],
      );
      const row = updated.rows[0];
      if (!row) {
        const existing = await client.query<FeeRow>(
          `SELECT * FROM dropship.dropship_return_fee_schedule WHERE id = $1 LIMIT 1`,
          [input.feeId],
        );
        if (!existing.rows[0]) {
          throw new DropshipError("DROPSHIP_RETURN_FEE_NOT_FOUND", "Dropship return fee schedule row was not found.", {
            feeId: input.feeId,
          });
        }
        throw new DropshipError(
          "DROPSHIP_RETURN_FEE_ALREADY_INACTIVE",
          "Dropship return fee schedule row is already inactive.",
          { feeId: input.feeId },
        );
      }
      const fee = mapFeeRow(row);
      await completeAdminCommand(client, command.commandId, "dropship_return_fee_schedule", fee.feeId, input.now);
      await recordPolicyAuditEvent(client, {
        entityId: String(fee.feeId),
        eventType: "return_fee_deactivated",
        actor: input.actor,
        payload: { idempotencyKey: input.idempotencyKey },
        createdAt: input.now,
      });
      await client.query("COMMIT");
      return { fee, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async findPolicyReplayAfterUniqueConflict(
    input: CreatePolicyRepositoryInput,
  ): Promise<DropshipReturnPolicyMutationResult | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<AdminCommandRow>(
        `SELECT id, command_type, request_hash, entity_id
         FROM dropship.dropship_admin_config_commands
         WHERE idempotency_key = $1
         FOR UPDATE`,
        [input.idempotencyKey],
      );
      const row = existing.rows[0];
      const expectedHash = createHash("sha256").update(JSON.stringify({
        returnWindowDays: input.returnWindowDays,
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        priority: input.priority,
        effectiveFrom: input.effectiveFrom.toISOString(),
      })).digest("hex");
      if (!row || row.command_type !== "return_policy_version_created" || row.request_hash !== expectedHash || !row.entity_id) {
        await client.query("COMMIT");
        return null;
      }
      const policy = await loadPolicyByIdWithClient(client, parseEntityId(row.entity_id));
      await client.query("COMMIT");
      return { policy, idempotentReplay: true };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async findFeeReplayAfterUniqueConflict(
    input: CreateFeeRepositoryInput,
  ): Promise<DropshipReturnFeeMutationResult | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<AdminCommandRow>(
        `SELECT id, command_type, request_hash, entity_id
         FROM dropship.dropship_admin_config_commands
         WHERE idempotency_key = $1
         FOR UPDATE`,
        [input.idempotencyKey],
      );
      const row = existing.rows[0];
      const expectedHash = createHash("sha256").update(JSON.stringify({
        feeType: input.feeType,
        faultCategory: input.faultCategory,
        amountType: input.amountType,
        amount: input.amount,
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        priority: input.priority,
        effectiveFrom: input.effectiveFrom.toISOString(),
      })).digest("hex");
      if (!row || row.command_type !== "return_fee_version_created" || row.request_hash !== expectedHash || !row.entity_id) {
        await client.query("COMMIT");
        return null;
      }
      const fee = await loadFeeByIdWithClient(client, parseEntityId(row.entity_id));
      await client.query("COMMIT");
      return { fee, idempotentReplay: true };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function nextPolicyVersion(
  client: PoolClient,
  input: { vendorId: number | null; storeConnectionId: number | null },
): Promise<number> {
  const result = await client.query<{ next_version: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
     FROM dropship.dropship_return_policies
     WHERE vendor_id IS NOT DISTINCT FROM $1
       AND store_connection_id IS NOT DISTINCT FROM $2`,
    [input.vendorId, input.storeConnectionId],
  );
  return Number(requiredRow(result.rows[0], "Dropship return policy version query returned no row.").next_version);
}

async function nextFeeVersion(
  client: PoolClient,
  input: {
    feeType: DropshipReturnFeeType;
    faultCategory: DropshipReturnFeeFaultCategory;
    vendorId: number | null;
    storeConnectionId: number | null;
  },
): Promise<number> {
  const result = await client.query<{ next_version: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
     FROM dropship.dropship_return_fee_schedule
     WHERE fee_type = $1
       AND fault_category = $2
       AND vendor_id IS NOT DISTINCT FROM $3
       AND store_connection_id IS NOT DISTINCT FROM $4`,
    [input.feeType, input.faultCategory, input.vendorId, input.storeConnectionId],
  );
  return Number(requiredRow(result.rows[0], "Dropship return fee version query returned no row.").next_version);
}

async function loadPolicyByIdWithClient(client: PoolClient, policyId: number): Promise<DropshipReturnPolicyVersionRecord> {
  const result = await client.query<PolicyRow>(
    `SELECT * FROM dropship.dropship_return_policies WHERE id = $1 LIMIT 1`,
    [policyId],
  );
  return mapPolicyRow(requiredRow(result.rows[0], "Dropship return policy was not found."));
}

async function loadFeeByIdWithClient(client: PoolClient, feeId: number): Promise<DropshipReturnFeeScheduleRecord> {
  const result = await client.query<FeeRow>(
    `SELECT * FROM dropship.dropship_return_fee_schedule WHERE id = $1 LIMIT 1`,
    [feeId],
  );
  return mapFeeRow(requiredRow(result.rows[0], "Dropship return fee schedule row was not found."));
}

async function claimAdminCommand(
  client: PoolClient,
  commandType: string,
  input: {
    idempotencyKey: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    now: Date;
  },
  requestPayload: Record<string, unknown>,
): Promise<{ commandId: number; entityId: string | null; idempotentReplay: boolean }> {
  const requestHash = createHash("sha256").update(JSON.stringify(requestPayload)).digest("hex");
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO dropship.dropship_admin_config_commands
      (command_type, idempotency_key, request_hash, entity_type,
       actor_type, actor_id, created_at)
     VALUES ($1, $2, $3, $1, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [commandType, input.idempotencyKey, requestHash, input.actor.actorType, input.actor.actorId ?? null, input.now],
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
  const row = requiredRow(existing.rows[0], "Dropship admin config command row was not found after conflict.");
  if (row.command_type !== commandType || row.request_hash !== requestHash) {
    throw new DropshipError(
      "DROPSHIP_RETURN_POLICY_IDEMPOTENCY_CONFLICT",
      "Dropship return policy idempotency key was reused with a different request.",
      { commandType, idempotencyKey: input.idempotencyKey, requestHashMatches: row.request_hash === requestHash },
    );
  }
  if (!row.entity_id) {
    throw new DropshipError(
      "DROPSHIP_RETURN_POLICY_COMMAND_INCOMPLETE",
      "Dropship return policy command replay is incomplete.",
      { commandType, idempotencyKey: input.idempotencyKey },
    );
  }
  return { commandId: row.id, entityId: row.entity_id, idempotentReplay: true };
}

async function completeAdminCommand(
  client: PoolClient,
  commandId: number,
  entityType: string,
  entityId: number,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE dropship.dropship_admin_config_commands
     SET entity_type = $2, entity_id = $3, completed_at = $4
     WHERE id = $1`,
    [commandId, entityType, String(entityId), now],
  );
}

async function recordPolicyAuditEvent(
  client: PoolClient,
  input: {
    entityId: string;
    eventType: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    payload: Record<string, unknown>;
    createdAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (entity_type, entity_id, event_type, actor_type, actor_id,
       severity, payload, created_at)
     VALUES ('dropship_return_policy', $1, $2, $3, $4, 'info', $5::jsonb, $6)`,
    [
      input.entityId,
      input.eventType,
      input.actor.actorType,
      input.actor.actorId ?? null,
      JSON.stringify(input.payload),
      input.createdAt,
    ],
  );
}

function mapPolicyRow(row: PolicyRow): DropshipReturnPolicyVersionRecord {
  return {
    policyId: row.id,
    version: row.version,
    returnWindowDays: row.return_window_days,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    priority: row.priority,
    isActive: row.is_active,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFeeRow(row: FeeRow): DropshipReturnFeeScheduleRecord {
  return {
    feeId: row.id,
    version: row.version,
    feeType: row.fee_type,
    faultCategory: row.fault_category,
    amountType: row.amount_type,
    amount: Number(row.amount),
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    priority: row.priority,
    isActive: row.is_active,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseEntityId(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_RETURN_POLICY_COMMAND_INCOMPLETE",
      "Dropship return policy replay entity id is invalid.",
      { entityId: value },
    );
  }
  return parsed;
}

function requiredRow<T>(row: T | null | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
