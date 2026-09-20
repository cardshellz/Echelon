import type { PoolClient } from "pg";
import { DropshipError } from "../domain/errors";

/**
 * The idempotency ledger every staff configuration write shares
 * (`dropship.dropship_admin_config_commands`, migration 0101).
 *
 * A write claims its idempotency key INSIDE its transaction before touching
 * anything else. A key that is already taken is either a replay of the same
 * request (same command type, same request hash: the caller re-reads the
 * entity and answers as if it had just written it), a reuse of the key for a
 * different request (refused, permanent), or the remains of an attempt that
 * died between claiming the key and finishing (refused, transient — the row
 * can be resolved and the request retried).
 *
 * Error codes are supplied by the caller so each surface keeps its own
 * namespace and its own HTTP status mapping.
 */

export interface AdminConfigCommandCodes {
  idempotencyConflict: string;
  commandIncomplete: string;
}

export interface ClaimAdminConfigCommandInput {
  commandType: string;
  entityType: string;
  idempotencyKey: string;
  requestHash: string;
  actor: { actorType: "admin" | "system"; actorId?: string };
  now: Date;
  codes: AdminConfigCommandCodes;
}

export type ClaimedAdminConfigCommand =
  | { commandId: number; entityId: null; idempotentReplay: false }
  | { commandId: number; entityId: string; idempotentReplay: true };

interface AdminCommandRow {
  id: number;
  command_type: string;
  request_hash: string;
  entity_id: string | null;
}

export async function claimAdminConfigCommand(
  client: PoolClient,
  input: ClaimAdminConfigCommandInput,
): Promise<ClaimedAdminConfigCommand> {
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO dropship.dropship_admin_config_commands
      (command_type, idempotency_key, request_hash, entity_type, actor_type, actor_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.commandType,
      input.idempotencyKey,
      input.requestHash,
      input.entityType,
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
  const row = existing.rows[0];
  if (!row) {
    throw new DropshipError(
      input.codes.commandIncomplete,
      "Admin config command row was not found after an idempotency conflict.",
      { classification: "transient", idempotencyKey: input.idempotencyKey },
    );
  }
  if (row.command_type !== input.commandType || row.request_hash !== input.requestHash) {
    throw new DropshipError(
      input.codes.idempotencyConflict,
      "Idempotency key was reused for a different request.",
      {
        classification: "permanent",
        idempotencyKey: input.idempotencyKey,
        commandTypeMatches: row.command_type === input.commandType,
        requestHashMatches: row.request_hash === input.requestHash,
      },
    );
  }
  if (!row.entity_id) {
    throw new DropshipError(
      input.codes.commandIncomplete,
      "An earlier attempt with this idempotency key did not finish.",
      { classification: "transient", idempotencyKey: input.idempotencyKey },
    );
  }
  return { commandId: row.id, entityId: row.entity_id, idempotentReplay: true };
}

export async function completeAdminConfigCommand(
  client: PoolClient,
  input: { commandId: number; entityType: string; entityId: string; now: Date },
): Promise<void> {
  await client.query(
    `UPDATE dropship.dropship_admin_config_commands
     SET entity_type = $2, entity_id = $3, completed_at = $4
     WHERE id = $1`,
    [input.commandId, input.entityType, input.entityId, input.now],
  );
}

/** A replayed command's entity id, as the positive integer it was stored from. */
export function parseAdminConfigCommandEntityId(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DropshipError(code, "Admin config command has no valid entity id.", {
      classification: "transient",
      entityId: value,
    });
  }
  return parsed;
}

export async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure; the pool discards a client left in a bad state.
  }
}
