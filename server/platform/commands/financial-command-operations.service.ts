import type { Pool } from "pg";

export const FINANCIAL_COMMAND_TERMINAL_RETENTION_DAYS = 400;
export const FINANCIAL_COMMAND_MAX_ATTEMPT_LIMIT = 100;

export type FinancialCommandOperationsStatus =
  | "all"
  | "attention"
  | "claimed"
  | "succeeded"
  | "rejected"
  | "retryable"
  | "dead";

export class FinancialCommandOperationsError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "FinancialCommandOperationsError";
  }
}

export async function getFinancialCommandOperations(
  dbPool: Pool,
  input: { status: FinancialCommandOperationsStatus; search?: string; limit: number },
) {
  const summaryResult = await dbPool.query(
    `SELECT
       count(*)::integer AS total,
       count(*) FILTER (WHERE status = 'claimed')::integer AS claimed,
       count(*) FILTER (WHERE status = 'succeeded')::integer AS succeeded,
       count(*) FILTER (WHERE status = 'rejected')::integer AS rejected,
       count(*) FILTER (WHERE status = 'retryable')::integer AS retryable,
       count(*) FILTER (WHERE status = 'dead')::integer AS dead,
       count(*) FILTER (
         WHERE status = 'claimed' AND lease_expires_at <= transaction_timestamp()
       )::integer AS "stalledClaims",
       count(*) FILTER (
         WHERE status = 'retryable' AND next_attempt_at <= transaction_timestamp()
       )::integer AS "dueRetries",
       count(*) FILTER (
         WHERE status IN ('claimed', 'retryable') AND expires_at <= transaction_timestamp()
       )::integer AS "expiredNonterminal",
       min(created_at) FILTER (WHERE status = 'dead') AS "oldestDeadAt",
       min(lease_expires_at) FILTER (
         WHERE status = 'claimed' AND lease_expires_at <= transaction_timestamp()
       ) AS "oldestStalledLeaseAt",
       min(next_attempt_at) FILTER (
         WHERE status = 'retryable' AND next_attempt_at <= transaction_timestamp()
       ) AS "oldestDueRetryAt"
     FROM public.financial_command_results`,
  );

  const values: unknown[] = [];
  const predicates: string[] = [];
  if (input.status === "attention") {
    predicates.push(`(
      status = 'dead'
      OR (status = 'claimed' AND lease_expires_at <= transaction_timestamp())
      OR (status = 'retryable' AND next_attempt_at <= transaction_timestamp())
      OR (status IN ('claimed', 'retryable') AND expires_at <= transaction_timestamp())
    )`);
  } else if (input.status !== "all") {
    values.push(input.status);
    predicates.push(`status = $${values.length}`);
  }
  if (input.search) {
    values.push(`%${escapeLike(input.search)}%`);
    predicates.push(`(
      command_name ILIKE $${values.length} ESCAPE '\\'
      OR resource_key ILIKE $${values.length} ESCAPE '\\'
      OR COALESCE(last_error_code, '') ILIKE $${values.length} ESCAPE '\\'
    )`);
  }
  values.push(input.limit);
  const where = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
  const rowsResult = await dbPool.query(
    `SELECT
       id,
       actor_type AS "actorType",
       actor_id AS "actorId",
       method,
       route_template AS "routeTemplate",
       resource_key AS "resourceKey",
       command_name AS "commandName",
       contract_version AS "contractVersion",
       status,
       attempt_count AS "attemptCount",
       attempt_limit AS "attemptLimit",
       recovery_count AS "recoveryCount",
       lease_expires_at AS "leaseExpiresAt",
       next_attempt_at AS "nextAttemptAt",
       last_error_code AS "lastErrorCode",
       last_error_message AS "lastErrorMessage",
       completed_at AS "completedAt",
       created_at AS "createdAt",
       updated_at AS "updatedAt",
       expires_at AS "expiresAt"
     FROM public.financial_command_results
     ${where}
     ORDER BY
       CASE
         WHEN status = 'dead' THEN 0
         WHEN status = 'claimed' AND lease_expires_at <= transaction_timestamp() THEN 1
         WHEN status = 'retryable' AND next_attempt_at <= transaction_timestamp() THEN 2
         ELSE 3
       END,
       updated_at DESC,
       id DESC
     LIMIT $${values.length}`,
    values,
  );

  return {
    summary: summaryResult.rows[0],
    commands: rowsResult.rows.map(normalizeRowId),
    generatedAt: new Date().toISOString(),
  };
}

export async function getFinancialCommandOperationsDetail(dbPool: Pool, commandId: number) {
  const commandResult = await dbPool.query(
    `SELECT
       id,
       actor_type AS "actorType",
       actor_id AS "actorId",
       method,
       route_template AS "routeTemplate",
       resource_key AS "resourceKey",
       command_name AS "commandName",
       contract_version AS "contractVersion",
       status,
       attempt_count AS "attemptCount",
       attempt_limit AS "attemptLimit",
       recovery_count AS "recoveryCount",
       lease_expires_at AS "leaseExpiresAt",
       next_attempt_at AS "nextAttemptAt",
       last_error_code AS "lastErrorCode",
       last_error_message AS "lastErrorMessage",
       completed_at AS "completedAt",
       created_at AS "createdAt",
       updated_at AS "updatedAt",
       expires_at AS "expiresAt"
     FROM public.financial_command_results
     WHERE id = $1`,
    [commandId],
  );
  if (commandResult.rowCount !== 1) {
    throw new FinancialCommandOperationsError(
      "Financial command not found",
      404,
      "FINANCIAL_COMMAND_NOT_FOUND",
    );
  }
  const recoveriesResult = await dbPool.query(
    `SELECT
       id,
       recovery_number AS "recoveryNumber",
       operator_id AS "operatorId",
       reason,
       prior_attempt_count AS "priorAttemptCount",
       prior_attempt_limit AS "priorAttemptLimit",
       prior_error_code AS "priorErrorCode",
       prior_error_message AS "priorErrorMessage",
       prior_completed_at AS "priorCompletedAt",
       created_at AS "createdAt"
     FROM public.financial_command_recoveries
     WHERE command_result_id = $1
     ORDER BY recovery_number DESC`,
    [commandId],
  );
  return {
    command: normalizeRowId(commandResult.rows[0]),
    recoveries: recoveriesResult.rows.map(normalizeRowId),
  };
}

export async function rearmDeadFinancialCommand(
  dbPool: Pool,
  input: { commandId: number; operatorId: string; reason: string },
) {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT *
       FROM public.financial_command_results
       WHERE id = $1
       FOR UPDATE`,
      [input.commandId],
    );
    const command = selected.rows[0];
    if (!command) {
      throw new FinancialCommandOperationsError(
        "Financial command not found",
        404,
        "FINANCIAL_COMMAND_NOT_FOUND",
      );
    }
    if (command.status !== "dead") {
      throw new FinancialCommandOperationsError(
        "Only a dead financial command can be re-armed",
        409,
        "FINANCIAL_COMMAND_NOT_DEAD",
      );
    }
    if (Number(command.attempt_limit) >= FINANCIAL_COMMAND_MAX_ATTEMPT_LIMIT) {
      throw new FinancialCommandOperationsError(
        "Financial command reached the maximum operator recovery limit",
        409,
        "FINANCIAL_COMMAND_RECOVERY_LIMIT_REACHED",
      );
    }

    // Copy terminal evidence inside PostgreSQL. Routing completed_at through a
    // JavaScript Date truncates PostgreSQL microseconds, which would make the
    // trigger's exact audit match fail even though the selected row is locked.
    const insertedRecovery = await client.query(
      `INSERT INTO public.financial_command_recoveries (
         command_result_id,
         recovery_number,
         operator_id,
         reason,
         prior_attempt_count,
         prior_attempt_limit,
         prior_error_code,
         prior_error_message,
         prior_completed_at
       )
       SELECT
         command.id,
         command.recovery_count + 1,
         $2,
         $3,
         command.attempt_count,
         command.attempt_limit,
         command.last_error_code,
         command.last_error_message,
         command.completed_at
       FROM public.financial_command_results command
       WHERE command.id = $1
         AND command.status = 'dead'
       RETURNING id`,
      [
        input.commandId,
        input.operatorId,
        input.reason,
      ],
    );
    if (insertedRecovery.rowCount !== 1) {
      throw new FinancialCommandOperationsError(
        "Dead financial command changed before recovery evidence could be recorded",
        409,
        "FINANCIAL_COMMAND_RECOVERY_CONFLICT",
      );
    }
    const updated = await client.query(
      `UPDATE public.financial_command_results
       SET status = 'retryable',
           attempt_limit = attempt_limit + 1,
           recovery_count = recovery_count + 1,
           next_attempt_at = transaction_timestamp(),
           completed_at = NULL,
           updated_at = transaction_timestamp(),
           expires_at = GREATEST(
             expires_at,
             transaction_timestamp() + ($2::text || ' days')::interval
           )
       WHERE id = $1
       RETURNING
         id,
         status,
         attempt_count AS "attemptCount",
         attempt_limit AS "attemptLimit",
         recovery_count AS "recoveryCount",
         next_attempt_at AS "nextAttemptAt",
         expires_at AS "expiresAt"`,
      [input.commandId, FINANCIAL_COMMAND_TERMINAL_RETENTION_DAYS],
    );
    await client.query("COMMIT");
    return {
      command: normalizeRowId(updated.rows[0]),
      message: "Command re-armed for one exact caller retry with the original idempotency key and payload.",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function purgeExpiredFinancialCommandResults(
  dbPool: Pool,
  batchSize: number,
): Promise<number> {
  const result = await dbPool.query(
    `WITH expired AS (
       SELECT id
       FROM public.financial_command_results
       WHERE status IN ('succeeded', 'rejected')
         AND expires_at <= transaction_timestamp()
       ORDER BY expires_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     DELETE FROM public.financial_command_results command
     USING expired
     WHERE command.id = expired.id
     RETURNING command.id`,
    [batchSize],
  );
  return result.rowCount ?? 0;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function normalizeRowId<T extends { id: unknown }>(row: T): Omit<T, "id"> & { id: number } {
  const id = Number(row.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new FinancialCommandOperationsError(
      "Financial command operations returned an invalid identifier",
      500,
      "FINANCIAL_COMMAND_ID_CORRUPT",
    );
  }
  return { ...row, id };
}
