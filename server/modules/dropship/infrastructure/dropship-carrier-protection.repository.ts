import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  CarrierProtectionAssignmentRecord,
  CarrierProtectionCommandContext,
  CarrierProtectionMutationResult,
  CarrierProtectionMatch,
  CarrierProtectionOverview,
  CarrierProtectionPolicyRecord,
  CarrierProtectionRepository,
  NormalizedCreateCarrierProtectionAssignment,
  NormalizedCreateCarrierProtectionPolicy,
  ResolveCarrierProtectionPolicyInput,
} from "../application/dropship-carrier-protection-service";

interface PolicyRow {
  id: number; policy_key: string; version: number; supersedes_policy_id: number | null; name: string; status: CarrierProtectionPolicyRecord["status"];
  covered_loss: boolean; covered_misdelivery: boolean; covered_damage: boolean;
  merchandise_reimbursement_bps: number; shipping_reimbursement_bps: number;
  deductible_cents: string | number; max_credit_cents: string | number | null;
  loss_wait_days: number; misdelivery_wait_days: number; damage_inspection_required: boolean;
  payout_trigger: CarrierProtectionPolicyRecord["payoutTrigger"]; carrier_claim_required: boolean;
  approval_mode: CarrierProtectionPolicyRecord["approvalMode"]; automatic_approval_limit_cents: string | number | null;
  effective_from: Date; effective_to: Date | null; created_by: string | null; created_at: Date; retired_at: Date | null;
}

interface AssignmentRow {
  id: number; policy_id: number; policy_name: string; policy_version: number; name: string; priority: number;
  channel_id: number | null; channel_name: string | null; warehouse_id: number | null; warehouse_name: string | null;
  carrier: string | null; service: string | null; destination_country: string | null; destination_region: string | null;
  min_shipment_value_cents: string | number | null; max_shipment_value_cents: string | number | null;
  is_default: boolean; is_active: boolean; created_by: string | null; created_at: Date; deactivated_at: Date | null;
}

interface CommandRow { id: number; command_type: string; request_hash: string; entity_id: string | null }

export class PgDropshipCarrierProtectionRepository implements CarrierProtectionRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async getOverview(generatedAt: Date): Promise<CarrierProtectionOverview> {
    const client = await this.dbPool.connect();
    try {
      const [policies, assignments] = await Promise.all([listPolicies(client), listAssignments(client)]);
      return { policies, assignments, generatedAt };
    } finally { client.release(); }
  }

  async createPolicy(input: NormalizedCreateCarrierProtectionPolicy & CarrierProtectionCommandContext): Promise<CarrierProtectionMutationResult<CarrierProtectionPolicyRecord>> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimCommand(client, "carrier_protection_policy_created", input);
      if (command.replay) {
        const record = await loadPolicy(client, entityId(command.entityId));
        await client.query("COMMIT");
        return { record, idempotentReplay: true };
      }
      await client.query("SELECT pg_advisory_xact_lock($1)", [94001]);
      let policyKey = input.policyKey;
      let superseded: CarrierProtectionPolicyRecord | null = null;
      if (input.supersedesPolicyId) {
        superseded = await loadPolicy(client, input.supersedesPolicyId);
        policyKey = superseded.policyKey;
      }
      const versionResult = await client.query<{ version: number }>(
        "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM dropship.dropship_carrier_protection_policies WHERE policy_key = $1",
        [policyKey],
      );
      const version = Number(versionResult.rows[0]?.version ?? 1);
      if (input.status === "active") {
        await endSupersededPolicyWindow(client, superseded, input.effectiveFrom);
        await assertNoPolicyVersionOverlap(client, policyKey, input.effectiveFrom, input.effectiveTo, input.supersedesPolicyId);
      }
      const inserted = await client.query<PolicyRow>(
        `INSERT INTO dropship.dropship_carrier_protection_policies
          (policy_key, version, supersedes_policy_id, name, status, covered_loss, covered_misdelivery, covered_damage,
           merchandise_reimbursement_bps, shipping_reimbursement_bps, deductible_cents, max_credit_cents,
           loss_wait_days, misdelivery_wait_days, damage_inspection_required, payout_trigger,
           carrier_claim_required, approval_mode, automatic_approval_limit_cents, effective_from,
           effective_to, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         RETURNING *`,
        [policyKey, version, input.supersedesPolicyId ?? null, input.name, input.status, input.coveredLoss, input.coveredMisdelivery,
          input.coveredDamage, input.merchandiseReimbursementBps, input.shippingReimbursementBps,
          input.deductibleCents, input.maxCreditCents, input.lossWaitDays, input.misdeliveryWaitDays,
          input.damageInspectionRequired, input.payoutTrigger, input.carrierClaimRequired, input.approvalMode,
          input.automaticApprovalLimitCents, input.effectiveFrom, input.effectiveTo, input.actor.actorId ?? null, input.now],
      );
      const record = mapPolicy(required(inserted.rows[0], "Carrier-protection policy insert returned no row."));
      await finishCommand(client, command.id, "dropship_carrier_protection_policy", record.policyId, input.now);
      await audit(client, input, "dropship_carrier_protection_policy", record.policyId, "carrier_protection_policy_created", { policyKey, version });
      await client.query("COMMIT");
      return { record, idempotentReplay: false };
    } catch (error) { await rollback(client); throw mapError(error); } finally { client.release(); }
  }

  async retirePolicy(input: { policyId: number } & CarrierProtectionCommandContext): Promise<CarrierProtectionMutationResult<CarrierProtectionPolicyRecord>> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimCommand(client, "carrier_protection_policy_retired", input);
      const policyId = command.replay ? entityId(command.entityId) : input.policyId;
      if (!command.replay) {
        const assigned = await client.query("SELECT 1 FROM dropship.dropship_carrier_protection_assignments WHERE policy_id = $1 AND is_active = true LIMIT 1", [policyId]);
        if (assigned.rows[0]) throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_POLICY_ASSIGNED", "Deactivate active assignments before retiring this policy.", { policyId });
      }
      const updated = await client.query<PolicyRow>(
        `UPDATE dropship.dropship_carrier_protection_policies
         SET status = 'retired', retired_at = COALESCE(retired_at, $2),
             effective_to = CASE WHEN effective_from < $2 AND (effective_to IS NULL OR effective_to > $2) THEN $2 ELSE effective_to END
         WHERE id = $1 RETURNING *`, [policyId, input.now],
      );
      const record = mapPolicy(required(updated.rows[0], "Carrier-protection policy was not found."));
      if (!command.replay) {
        await finishCommand(client, command.id, "dropship_carrier_protection_policy", policyId, input.now);
        await audit(client, input, "dropship_carrier_protection_policy", policyId, "carrier_protection_policy_retired", {});
      }
      await client.query("COMMIT");
      return { record, idempotentReplay: command.replay };
    } catch (error) { await rollback(client); throw mapError(error); } finally { client.release(); }
  }

  async activatePolicy(input: { policyId: number } & CarrierProtectionCommandContext): Promise<CarrierProtectionMutationResult<CarrierProtectionPolicyRecord>> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimCommand(client, "carrier_protection_policy_activated", input);
      const policyId = command.replay ? entityId(command.entityId) : input.policyId;
      const current = await loadPolicy(client, policyId);
      if (!command.replay) {
        if (current.status !== "draft") throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_POLICY_NOT_DRAFT", "Only draft policy versions can be activated.", { policyId });
        await client.query("SELECT pg_advisory_xact_lock($1)", [94001]);
        const superseded = current.supersedesPolicyId ? await loadPolicy(client, current.supersedesPolicyId) : null;
        await endSupersededPolicyWindow(client, superseded, current.effectiveFrom);
        await assertNoPolicyVersionOverlap(client, current.policyKey, current.effectiveFrom, current.effectiveTo, current.policyId);
      }
      const updated = await client.query<PolicyRow>("UPDATE dropship.dropship_carrier_protection_policies SET status = 'active' WHERE id = $1 RETURNING *", [policyId]);
      const record = mapPolicy(required(updated.rows[0], "Carrier-protection policy was not found."));
      if (!command.replay) {
        await finishCommand(client, command.id, "dropship_carrier_protection_policy", policyId, input.now);
        await audit(client, input, "dropship_carrier_protection_policy", policyId, "carrier_protection_policy_activated", {});
      }
      await client.query("COMMIT");
      return { record, idempotentReplay: command.replay };
    } catch (error) { await rollback(client); throw mapError(error); } finally { client.release(); }
  }

  async createAssignment(input: NormalizedCreateCarrierProtectionAssignment & CarrierProtectionCommandContext): Promise<CarrierProtectionMutationResult<CarrierProtectionAssignmentRecord>> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimCommand(client, "carrier_protection_assignment_created", input);
      if (command.replay) {
        const record = await loadAssignment(client, entityId(command.entityId));
        await client.query("COMMIT");
        return { record, idempotentReplay: true };
      }
      const policy = await loadPolicy(client, input.policyId);
      if (policy.status !== "active") throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_POLICY_NOT_ACTIVE", "Assignments require an active carrier-protection policy.", { policyId: policy.policyId });
      if (policy.effectiveTo && policy.effectiveTo <= input.now) throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_POLICY_EXPIRED", "Assignments cannot target an expired carrier-protection policy.", { policyId: policy.policyId });
      if (input.isDefault) {
        await client.query("SELECT pg_advisory_xact_lock($1)", [94002]);
        await assertNoDefaultAssignmentOverlap(client, policy);
      }
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_carrier_protection_assignments
          (policy_id, name, priority, channel_id, warehouse_id, carrier, service, destination_country,
           destination_region, min_shipment_value_cents, max_shipment_value_cents, is_default,
           is_active, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14) RETURNING id`,
        [input.policyId, input.name, input.priority, input.channelId, input.warehouseId, input.carrier,
          input.service, input.destinationCountry, input.destinationRegion, input.minShipmentValueCents,
          input.maxShipmentValueCents, input.isDefault, input.actor.actorId ?? null, input.now],
      );
      const assignmentId = required(inserted.rows[0], "Carrier-protection assignment insert returned no row.").id;
      const record = await loadAssignment(client, assignmentId);
      await finishCommand(client, command.id, "dropship_carrier_protection_assignment", assignmentId, input.now);
      await audit(client, input, "dropship_carrier_protection_assignment", assignmentId, "carrier_protection_assignment_created", { policyId: input.policyId, priority: input.priority, isDefault: input.isDefault });
      await client.query("COMMIT");
      return { record, idempotentReplay: false };
    } catch (error) { await rollback(client); throw mapError(error); } finally { client.release(); }
  }

  async deactivateAssignment(input: { assignmentId: number } & CarrierProtectionCommandContext): Promise<CarrierProtectionMutationResult<CarrierProtectionAssignmentRecord>> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimCommand(client, "carrier_protection_assignment_deactivated", input);
      const assignmentId = command.replay ? entityId(command.entityId) : input.assignmentId;
      const updated = await client.query<{ id: number }>(
        "UPDATE dropship.dropship_carrier_protection_assignments SET is_active = false, deactivated_at = COALESCE(deactivated_at, $2) WHERE id = $1 RETURNING id",
        [assignmentId, input.now],
      );
      required(updated.rows[0], "Carrier-protection assignment was not found.");
      const record = await loadAssignment(client, assignmentId);
      if (!command.replay) {
        await finishCommand(client, command.id, "dropship_carrier_protection_assignment", assignmentId, input.now);
        await audit(client, input, "dropship_carrier_protection_assignment", assignmentId, "carrier_protection_assignment_deactivated", {});
      }
      await client.query("COMMIT");
      return { record, idempotentReplay: command.replay };
    } catch (error) { await rollback(client); throw mapError(error); } finally { client.release(); }
  }

  async resolvePolicy(input: ResolveCarrierProtectionPolicyInput): Promise<CarrierProtectionMatch | null> {
    const client = await this.dbPool.connect();
    try {
      return resolveCarrierProtectionPolicyWithClient(client, input);
    } finally { client.release(); }
  }
}

async function listPolicies(client: PoolClient): Promise<CarrierProtectionPolicyRecord[]> {
  const result = await client.query<PolicyRow>("SELECT * FROM dropship.dropship_carrier_protection_policies ORDER BY policy_key, version DESC");
  return result.rows.map(mapPolicy);
}

const assignmentSelect = `SELECT a.*, p.name AS policy_name, p.version AS policy_version, c.name AS channel_name, w.name AS warehouse_name
  FROM dropship.dropship_carrier_protection_assignments a
  JOIN dropship.dropship_carrier_protection_policies p ON p.id = a.policy_id
  LEFT JOIN channels.channels c ON c.id = a.channel_id
  LEFT JOIN warehouse.warehouses w ON w.id = a.warehouse_id`;

export async function resolveCarrierProtectionPolicyWithClient(
  client: PoolClient,
  input: ResolveCarrierProtectionPolicyInput,
): Promise<CarrierProtectionMatch | null> {
  const coverageColumn = input.eventType === "loss"
    ? "covered_loss"
    : input.eventType === "misdelivery"
      ? "covered_misdelivery"
      : "covered_damage";
  const result = await client.query<AssignmentRow>(
    `${assignmentSelect}
     WHERE a.is_active = true AND p.status = 'active' AND p.${coverageColumn} = true
       AND p.effective_from <= $1 AND (p.effective_to IS NULL OR p.effective_to > $1)
       AND (a.channel_id IS NULL OR a.channel_id = $2)
       AND (a.warehouse_id IS NULL OR a.warehouse_id = $3)
       AND (a.carrier IS NULL OR UPPER(a.carrier) = UPPER($4))
       AND (a.service IS NULL OR LOWER(a.service) = LOWER($5))
       AND (a.destination_country IS NULL OR a.destination_country = $6)
       AND (a.destination_region IS NULL OR a.destination_region = $7)
       AND (a.min_shipment_value_cents IS NULL OR a.min_shipment_value_cents <= $8)
       AND (a.max_shipment_value_cents IS NULL OR a.max_shipment_value_cents >= $8)
     ORDER BY a.is_default ASC, a.priority DESC,
       ((a.channel_id IS NOT NULL)::int + (a.warehouse_id IS NOT NULL)::int + (a.carrier IS NOT NULL)::int
        + (a.service IS NOT NULL)::int + (a.destination_country IS NOT NULL)::int + (a.destination_region IS NOT NULL)::int
        + (a.min_shipment_value_cents IS NOT NULL)::int + (a.max_shipment_value_cents IS NOT NULL)::int) DESC,
       a.id ASC LIMIT 1`,
    [input.occurredAt, input.channelId, input.warehouseId, input.carrier, input.service,
      input.destinationCountry, input.destinationRegion ?? null, input.shipmentValueCents],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { assignment: mapAssignment(row), policy: await loadPolicy(client, row.policy_id) };
}

async function listAssignments(client: PoolClient): Promise<CarrierProtectionAssignmentRecord[]> {
  const result = await client.query<AssignmentRow>(`${assignmentSelect} ORDER BY a.is_active DESC, a.priority DESC, a.id ASC`);
  return result.rows.map(mapAssignment);
}

async function loadPolicy(client: PoolClient, policyId: number): Promise<CarrierProtectionPolicyRecord> {
  const result = await client.query<PolicyRow>("SELECT * FROM dropship.dropship_carrier_protection_policies WHERE id = $1", [policyId]);
  return mapPolicy(required(result.rows[0], "Carrier-protection policy was not found."));
}

async function loadAssignment(client: PoolClient, assignmentId: number): Promise<CarrierProtectionAssignmentRecord> {
  const result = await client.query<AssignmentRow>(`${assignmentSelect} WHERE a.id = $1`, [assignmentId]);
  return mapAssignment(required(result.rows[0], "Carrier-protection assignment was not found."));
}

async function assertNoPolicyVersionOverlap(client: PoolClient, policyKey: string, from: Date, to: Date | null, excludePolicyId?: number): Promise<void> {
  const result = await client.query<{ id: number; version: number }>(
    `SELECT id, version FROM dropship.dropship_carrier_protection_policies
     WHERE policy_key = $1 AND status = 'active'
       AND effective_from < COALESCE($3::timestamptz, 'infinity'::timestamptz)
       AND COALESCE(effective_to, 'infinity'::timestamptz) > $2
       AND ($4::int IS NULL OR id <> $4) LIMIT 1`, [policyKey, from, to, excludePolicyId ?? null],
  );
  if (result.rows[0]) throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_POLICY_VERSION_CONFLICT", "Active versions of the same policy cannot overlap.", { policyKey, conflictingPolicyId: result.rows[0].id, conflictingVersion: result.rows[0].version });
}

async function endSupersededPolicyWindow(
  client: PoolClient,
  superseded: CarrierProtectionPolicyRecord | null,
  nextEffectiveFrom: Date,
): Promise<void> {
  if (!superseded || superseded.status !== "active") return;
  if (superseded.effectiveFrom >= nextEffectiveFrom) {
    throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_INVALID_SUPERSESSION", "A new policy version must start after the version it supersedes.", { supersededPolicyId: superseded.policyId });
  }
  if (superseded.effectiveTo && superseded.effectiveTo <= nextEffectiveFrom) return;
  await client.query("UPDATE dropship.dropship_carrier_protection_policies SET effective_to = $2 WHERE id = $1", [superseded.policyId, nextEffectiveFrom]);
}

async function assertNoDefaultAssignmentOverlap(
  client: PoolClient,
  policy: CarrierProtectionPolicyRecord,
): Promise<void> {
  const conflict = await client.query<{ assignment_id: number; policy_id: number }>(
    `SELECT a.id AS assignment_id, p.id AS policy_id
     FROM dropship.dropship_carrier_protection_assignments a
     JOIN dropship.dropship_carrier_protection_policies p ON p.id = a.policy_id
     WHERE a.is_default = true AND a.is_active = true AND p.status = 'active'
       AND p.effective_from < COALESCE($2::timestamptz, 'infinity'::timestamptz)
       AND COALESCE(p.effective_to, 'infinity'::timestamptz) > $1
     LIMIT 1`,
    [policy.effectiveFrom, policy.effectiveTo],
  );
  if (conflict.rows[0]) {
    throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_DEFAULT_CONFLICT", "An active default assignment already covers this policy window.", conflict.rows[0]);
  }
}

async function claimCommand(client: PoolClient, type: string, input: CarrierProtectionCommandContext): Promise<{ id: number; entityId: string | null; replay: boolean }> {
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO dropship.dropship_admin_config_commands (command_type,idempotency_key,request_hash,entity_type,actor_type,actor_id,created_at)
     VALUES ($1,$2,$3,$1,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [type, input.idempotencyKey, input.requestHash, input.actor.actorType, input.actor.actorId ?? null, input.now],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, entityId: null, replay: false };
  const existing = await client.query<CommandRow>("SELECT id, command_type, request_hash, entity_id FROM dropship.dropship_admin_config_commands WHERE idempotency_key = $1 FOR UPDATE", [input.idempotencyKey]);
  const row = required(existing.rows[0], "Carrier-protection idempotency command was not found.");
  if (row.command_type !== type || row.request_hash !== input.requestHash) throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different carrier-protection command.");
  if (!row.entity_id) throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_COMMAND_INCOMPLETE", "Carrier-protection command replay is incomplete.");
  return { id: row.id, entityId: row.entity_id, replay: true };
}

async function finishCommand(client: PoolClient, id: number, entityType: string, entityIdValue: number, now: Date): Promise<void> {
  await client.query("UPDATE dropship.dropship_admin_config_commands SET entity_type=$2, entity_id=$3, completed_at=$4 WHERE id=$1", [id, entityType, String(entityIdValue), now]);
}

async function audit(client: PoolClient, input: CarrierProtectionCommandContext, entityType: string, entityIdValue: number, eventType: string, payload: Record<string, unknown>): Promise<void> {
  await client.query(`INSERT INTO dropship.dropship_audit_events (entity_type,entity_id,event_type,actor_type,actor_id,severity,payload,created_at) VALUES ($1,$2,$3,$4,$5,'info',$6::jsonb,$7)`, [entityType, String(entityIdValue), eventType, input.actor.actorType, input.actor.actorId ?? null, JSON.stringify(payload), input.now]);
}

function mapPolicy(row: PolicyRow): CarrierProtectionPolicyRecord {
  return { policyId: row.id, policyKey: row.policy_key, version: row.version, supersedesPolicyId: row.supersedes_policy_id, name: row.name, status: row.status,
    coveredLoss: row.covered_loss, coveredMisdelivery: row.covered_misdelivery, coveredDamage: row.covered_damage,
    merchandiseReimbursementBps: row.merchandise_reimbursement_bps, shippingReimbursementBps: row.shipping_reimbursement_bps,
    deductibleCents: money(row.deductible_cents), maxCreditCents: optionalMoney(row.max_credit_cents), lossWaitDays: row.loss_wait_days,
    misdeliveryWaitDays: row.misdelivery_wait_days, damageInspectionRequired: row.damage_inspection_required,
    payoutTrigger: row.payout_trigger, carrierClaimRequired: row.carrier_claim_required, approvalMode: row.approval_mode,
    automaticApprovalLimitCents: optionalMoney(row.automatic_approval_limit_cents), effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to, createdBy: row.created_by, createdAt: row.created_at, retiredAt: row.retired_at };
}

function mapAssignment(row: AssignmentRow): CarrierProtectionAssignmentRecord {
  return { assignmentId: row.id, policyId: row.policy_id, policyName: row.policy_name, policyVersion: row.policy_version,
    name: row.name, priority: row.priority, channelId: row.channel_id, channelName: row.channel_name,
    warehouseId: row.warehouse_id, warehouseName: row.warehouse_name, carrier: row.carrier, service: row.service,
    destinationCountry: row.destination_country, destinationRegion: row.destination_region,
    minShipmentValueCents: optionalMoney(row.min_shipment_value_cents), maxShipmentValueCents: optionalMoney(row.max_shipment_value_cents),
    isDefault: row.is_default, isActive: row.is_active, createdBy: row.created_by, createdAt: row.created_at, deactivatedAt: row.deactivated_at };
}

function money(value: string | number): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_INVALID_MONEY", "Stored carrier-protection money is invalid."); return parsed; }
function optionalMoney(value: string | number | null): number | null { return value == null ? null : money(value); }
function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_NOT_FOUND", message); return value; }
function entityId(value: string | null): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_COMMAND_INCOMPLETE", "Carrier-protection command has no valid entity ID."); return parsed; }
async function rollback(client: PoolClient): Promise<void> { try { await client.query("ROLLBACK"); } catch { /* preserve original error */ } }
function mapError(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "23505") return new DropshipError("DROPSHIP_CARRIER_PROTECTION_CONFLICT", "Carrier-protection configuration conflicts with an existing active record.");
    if (code === "23503") return new DropshipError("DROPSHIP_CARRIER_PROTECTION_REFERENCE_NOT_FOUND", "Referenced policy, channel, or warehouse was not found.");
    if (code === "23514") return new DropshipError("DROPSHIP_CARRIER_PROTECTION_IMMUTABLE", "Published carrier-protection terms and claim snapshots cannot be changed.");
  }
  return error;
}
