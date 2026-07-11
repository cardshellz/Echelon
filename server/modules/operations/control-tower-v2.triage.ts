import type { Pool, PoolClient } from "pg";

import { ControlTowerRequestError } from "./control-tower-v2.request";

const MAX_SNOOZE_DAYS = 30;

async function withTriageTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function integer(value: unknown): number {
  return Number(value ?? 0);
}

async function lockedWorkItem(client: PoolClient, id: number, version: number) {
  const result = await client.query(`
    SELECT *
    FROM operations.control_tower_work_items
    WHERE id = $1
    FOR UPDATE
  `, [id]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new ControlTowerRequestError("Control Tower work item not found", 404, "WORK_ITEM_NOT_FOUND");
  if (integer(row.row_version) !== version) {
    throw new ControlTowerRequestError("This work item changed. Refresh and try again.", 409, "STALE_WORK_ITEM_VERSION");
  }
  if (["resolved", "ignored"].includes(String(row.source_status)) || row.triage_status === "resolved") {
    throw new ControlTowerRequestError("Resolved work items cannot be triaged", 409, "WORK_ITEM_RESOLVED");
  }
  return row;
}

async function insertTriageObservation(params: {
  client: PoolClient;
  workItemId: number;
  kind: "acknowledged" | "assigned" | "snoozed";
  priorStatus: unknown;
  currentStatus: unknown;
  actorUserId: string;
  note: string | null;
  changedFields: Record<string, unknown>;
}): Promise<void> {
  await params.client.query(`
    INSERT INTO operations.control_tower_observations (
      work_item_id,
      observation_kind,
      prior_triage_status,
      current_triage_status,
      changed_fields,
      actor_user_id,
      note
    )
    VALUES ($1, $2, $3, $4, $5::JSONB, $6, $7)
  `, [
    params.workItemId,
    params.kind,
    params.priorStatus,
    params.currentStatus,
    JSON.stringify(params.changedFields),
    params.actorUserId,
    params.note,
  ]);
}

function validateNote(value: unknown, required: boolean): string | null {
  const note = String(value ?? "").trim();
  if (required && !note) throw new ControlTowerRequestError("A reason is required", 400, "REASON_REQUIRED");
  if (note.length > 500) throw new ControlTowerRequestError("Reason cannot exceed 500 characters", 400, "REASON_TOO_LONG");
  return note || null;
}

export async function acknowledgeControlTowerV2Item(params: {
  pool: Pool;
  id: number;
  version: number;
  actorUserId: string;
  note?: unknown;
}) {
  return withTriageTransaction(params.pool, async (client) => {
    const existing = await lockedWorkItem(client, params.id, params.version);
    if (existing.assigned_user_id && existing.assigned_user_id !== params.actorUserId) {
      throw new ControlTowerRequestError(
        "This work item is assigned to another user. Reassign it before starting work.",
        409,
        "WORK_ITEM_ASSIGNED_TO_ANOTHER_USER",
      );
    }
    const note = validateNote(params.note, false);
    const result = await client.query(`
      UPDATE operations.control_tower_work_items
      SET triage_status = 'in_progress',
          assigned_user_id = $2,
          assigned_by = $2,
          next_review_at = NULL,
          row_version = row_version + 1,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, triage_status, assigned_user_id, owner_team, row_version
    `, [params.id, params.actorUserId]);
    const updated = result.rows[0];
    await insertTriageObservation({
      client,
      workItemId: params.id,
      kind: "acknowledged",
      priorStatus: existing.triage_status,
      currentStatus: "in_progress",
      actorUserId: params.actorUserId,
      note,
      changedFields: {
        assignedUserId: { before: existing.assigned_user_id, after: updated.assigned_user_id },
      },
    });
    return updated;
  });
}

export async function assignControlTowerV2Item(params: {
  pool: Pool;
  id: number;
  version: number;
  actorUserId: string;
  assignedUserId: unknown;
  ownerTeam: unknown;
  note?: unknown;
}) {
  return withTriageTransaction(params.pool, async (client) => {
    const existing = await lockedWorkItem(client, params.id, params.version);
    const assignedUserId = params.assignedUserId === null || params.assignedUserId === ""
      ? null
      : String(params.assignedUserId).trim();
    const ownerTeam = params.ownerTeam === null || params.ownerTeam === undefined || params.ownerTeam === ""
      ? String(existing.owner_team ?? "").trim() || null
      : String(params.ownerTeam).trim();
    if (assignedUserId && assignedUserId.length > 120) {
      throw new ControlTowerRequestError("assignedUserId is too long", 400, "INVALID_ASSIGNEE");
    }
    if (ownerTeam && ownerTeam.length > 50) {
      throw new ControlTowerRequestError("ownerTeam is too long", 400, "INVALID_OWNER_TEAM");
    }
    if (assignedUserId) {
      const userResult = await client.query("SELECT id FROM identity.users WHERE id = $1 AND active = 1", [assignedUserId]);
      if (userResult.rows.length === 0) {
        throw new ControlTowerRequestError("Assigned user is not active", 400, "INVALID_ASSIGNEE");
      }
    }
    const note = validateNote(params.note, false);
    const result = await client.query(`
      UPDATE operations.control_tower_work_items
      SET assigned_user_id = $2,
          assigned_by = $3,
          owner_team = $4,
          row_version = row_version + 1,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, triage_status, assigned_user_id, owner_team, row_version
    `, [params.id, assignedUserId, params.actorUserId, ownerTeam]);
    const updated = result.rows[0];
    await insertTriageObservation({
      client,
      workItemId: params.id,
      kind: "assigned",
      priorStatus: existing.triage_status,
      currentStatus: existing.triage_status,
      actorUserId: params.actorUserId,
      note,
      changedFields: {
        assignedUserId: { before: existing.assigned_user_id, after: assignedUserId },
        ownerTeam: { before: existing.owner_team, after: ownerTeam },
      },
    });
    return updated;
  });
}

export async function snoozeControlTowerV2Item(params: {
  pool: Pool;
  id: number;
  version: number;
  actorUserId: string;
  until: unknown;
  reason: unknown;
  clock?: () => Date;
}) {
  const until = new Date(String(params.until ?? ""));
  const now = (params.clock ?? (() => new Date()))();
  if (Number.isNaN(until.getTime())) {
    throw new ControlTowerRequestError("A valid snooze deadline is required", 400, "INVALID_SNOOZE_DEADLINE");
  }
  if (until.getTime() <= now.getTime() + 60_000) {
    throw new ControlTowerRequestError("Snooze deadline must be at least one minute in the future", 400, "INVALID_SNOOZE_DEADLINE");
  }
  if (until.getTime() > now.getTime() + MAX_SNOOZE_DAYS * 86_400_000) {
    throw new ControlTowerRequestError(`Snooze deadline cannot exceed ${MAX_SNOOZE_DAYS} days`, 400, "INVALID_SNOOZE_DEADLINE");
  }
  const reason = validateNote(params.reason, true)!;

  return withTriageTransaction(params.pool, async (client) => {
    const existing = await lockedWorkItem(client, params.id, params.version);
    const result = await client.query(`
      UPDATE operations.control_tower_work_items
      SET triage_status = 'waiting',
          next_review_at = $2,
          row_version = row_version + 1,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, triage_status, assigned_user_id, owner_team, next_review_at, row_version
    `, [params.id, until.toISOString()]);
    const updated = result.rows[0];
    await insertTriageObservation({
      client,
      workItemId: params.id,
      kind: "snoozed",
      priorStatus: existing.triage_status,
      currentStatus: "waiting",
      actorUserId: params.actorUserId,
      note: reason,
      changedFields: {
        nextReviewAt: { before: existing.next_review_at, after: until.toISOString() },
      },
    });
    return updated;
  });
}
