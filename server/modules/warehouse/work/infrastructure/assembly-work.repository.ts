import type { PoolClient } from "pg";
import { assemblyTaskSchema, type AssemblyTask, type AssemblyTaskContext } from "@shared/warehouse-assembly-work";
import { WarehouseWorkError } from "../domain/work-configuration";

interface TaskRow {
  id: string; warehouse_id: number; claim_id: string; claim_operation_id: string;
  context: unknown; state: string; version: number; assigned_to: string | null;
  started_at: Date | null; completed_at: Date | null; blocked_reason: string | null;
  received_by: string | null; received_at: Date | null;
}
function fromRow(row: TaskRow): AssemblyTask {
  if (!row.context || typeof row.context !== "object") throw new Error("Warehouse work context is invalid");
  return assemblyTaskSchema.parse({ ...row.context, id: String(row.id), warehouseId: row.warehouse_id,
    claimId: String(row.claim_id), claimOperationId: String(row.claim_operation_id),
    state: row.state, version: row.version, assignedTo: row.assigned_to,
    startedAt: row.started_at?.toISOString() ?? null, completedAt: row.completed_at?.toISOString() ?? null,
    blockedReason: row.blocked_reason, receivedBy: row.received_by, receivedAt: row.received_at?.toISOString() ?? null });
}

/** All writes require the owning claim lock FIRST; this repository never calls an inventory owner. */
export class AssemblyWorkRepository {
  async forClaims(client: PoolClient, claimIds: readonly string[]): Promise<AssemblyTask[]> {
    if (claimIds.length === 0) return [];
    const result = await client.query<TaskRow>("SELECT * FROM warehouse.work_items WHERE claim_id=ANY($1::bigint[]) ORDER BY id LIMIT 10001", [[...new Set(claimIds)]]);
    if (result.rows.length > 10000) throw new WarehouseWorkError("WORK_READ_LIMIT_EXCEEDED", "Narrow the work query", 422);
    return result.rows.map(fromRow);
  }
  async byId(client: PoolClient, id: string, lock = false): Promise<AssemblyTask | null> {
    const result = await client.query<TaskRow>(`SELECT * FROM warehouse.work_items WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
  async byOperation(client: PoolClient, operationId: string, lock = true): Promise<AssemblyTask | null> {
    const result = await client.query<TaskRow>(`SELECT * FROM warehouse.work_items WHERE claim_operation_id=$1 ${lock ? "FOR UPDATE" : ""}`, [operationId]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
  async forClaim(client: PoolClient, claimId: string): Promise<AssemblyTask[]> {
    const result = await client.query<TaskRow>("SELECT * FROM warehouse.work_items WHERE claim_id=$1 ORDER BY id FOR UPDATE", [claimId]);
    return result.rows.map(fromRow);
  }
  async queue(client: PoolClient, input: {
    warehouseId: number; stationIds: string[]; beforeId?: string; limit: number; includeClosed: boolean;
  }): Promise<AssemblyTask[]> {
    const result = await client.query<TaskRow>(`
      SELECT * FROM warehouse.work_items WHERE warehouse_id=$1 AND station_id=ANY($2::uuid[])
        AND ($3::bigint IS NULL OR id < $3) AND ($4::boolean OR state NOT IN ('completed','cancelled'))
      ORDER BY id DESC LIMIT $5
    `, [input.warehouseId, input.stationIds, input.beforeId ?? null, input.includeClosed, input.limit]);
    return result.rows.map(fromRow);
  }
  async create(client: PoolClient, task: AssemblyTaskContext): Promise<AssemblyTask> {
    const result = await client.query<TaskRow>(`
      INSERT INTO warehouse.work_items
        (warehouse_id, claim_id, claim_operation_id, station_id, configuration_revision, context, state, version)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,'queued',1) RETURNING *
    `, [task.warehouseId, task.claimId, task.claimOperationId, task.station.id, task.configurationRevision, JSON.stringify(task)]);
    return fromRow(result.rows[0]);
  }
  async update(client: PoolClient, previous: AssemblyTask, next: AssemblyTask): Promise<void> {
    const result = await client.query(`
      UPDATE warehouse.work_items SET state=$1, version=$2, assigned_to=$3, started_at=$4,
        completed_at=$5, blocked_reason=$6, received_by=$7, received_at=$8
      WHERE id=$9 AND version=$10
    `, [next.state, next.version, next.assignedTo, next.startedAt, next.completedAt,
      next.blockedReason, next.receivedBy, next.receivedAt, previous.id, previous.version]);
    if (result.rowCount !== 1) throw new WarehouseWorkError("WORK_TASK_VERSION_CONFLICT", "The work changed while it was being recorded", 409);
  }
  async replay(client: PoolClient, commandKey: string, requestHash: string): Promise<AssemblyTask | null> {
    const result = await client.query<{ request_hash: string; after_state: unknown }>(
      "SELECT request_hash, after_state FROM warehouse.work_item_events WHERE command_key=$1", [commandKey]);
    if (!result.rows[0]) return null;
    if (result.rows[0].request_hash !== requestHash) throw new WarehouseWorkError("WORK_COMMAND_REUSED", "This command ID was used for another employee, job or request", 409);
    return assemblyTaskSchema.parse(result.rows[0].after_state);
  }
  async event(client: PoolClient, input: {
    previous: AssemblyTask | null; next: AssemblyTask; action: string; commandKey: string;
    requestHash: string; actorId: string; reason: string; occurredAt: string;
  }): Promise<void> {
    await client.query(`
      INSERT INTO warehouse.work_item_events
        (work_item_id,version,event_type,command_key,request_hash,actor_id,reason,before_state,after_state,occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
    `, [input.next.id, input.next.version, input.action, input.commandKey, input.requestHash, input.actorId,
      input.reason, input.previous === null ? null : JSON.stringify(input.previous), JSON.stringify(input.next), input.occurredAt]);
  }
}
