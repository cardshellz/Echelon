import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@shared/schema";
import {
  purgeExpiredFinancialCommandResults,
  rearmDeadFinancialCommand,
} from "../../commands/financial-command-operations.service";
import {
  runTransactionalFinancialCommand,
  type FinancialCommandDescriptor,
  type FinancialCommandRepository,
  type FinancialCommandSuccess,
} from "../../commands/transactional-command.service";

config({ path: resolve(process.cwd(), ".env.test") });

// This suite deliberately has no DATABASE_URL fallback. It can only mutate a
// database explicitly opted into integration testing under this test-only key.
const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const describeWithDb = TEST_DB_URL ? describe : describe.skip;
const migrationSql = [
  "136_financial_command_results.sql",
  "140_financial_command_operations.sql",
].map((fileName) => readFileSync(resolve(process.cwd(), "migrations", fileName), "utf8"))
  .join("\n");

type CommandTransaction = {
  execute(query: unknown): Promise<unknown>;
};

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

function requestHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describeWithDb.sequential("financial command PostgreSQL transactions", () => {
  const runId = randomUUID().replaceAll("-", "");
  const actorId = `financial-command-integration-${runId}`;
  const probeTableName = `financial_command_probe_${runId}`;
  const probeTableQualified = `public."${probeTableName}"`;

  let pool: pg.Pool;
  let repository: FinancialCommandRepository<CommandTransaction>;
  let defaultModulePool: pg.Pool | undefined;

  function descriptor(
    testName: string,
    options: { key?: string; hashSeed?: string } = {},
  ): FinancialCommandDescriptor {
    return {
      actorType: "service",
      actorId,
      method: "POST",
      routeTemplate: "/__tests__/financial-commands/:id",
      resourceKey: `probe:${testName}`,
      idempotencyKey: `${runId}-${options.key ?? testName}`,
      requestHash: requestHash(options.hashSeed ?? testName),
      commandName: `test.financial_command.${testName.replaceAll("-", "_")}`,
      contractVersion: 1,
    };
  }

  async function insertProbe(
    tx: CommandTransaction,
    effectKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO public.${sql.identifier(probeTableName)}
        (effect_key, payload)
      VALUES (${effectKey}, ${JSON.stringify(payload)}::jsonb)
    `);
  }

  async function runCommand<T>(
    command: FinancialCommandDescriptor,
    work: (tx: CommandTransaction) => Promise<FinancialCommandSuccess<T>>,
  ) {
    return runTransactionalFinancialCommand({
      repository,
      descriptor: command,
      work,
      classifyFailure: (error) => {
        if (error instanceof DeterministicProbeError) {
          return {
            kind: "rejected" as const,
            httpStatus: 422,
            body: { error: "probe rejected", code: "PROBE_REJECTED" },
            errorCode: "PROBE_REJECTED",
            errorMessage: error.message,
          };
        }
        return {
          kind: "retryable" as const,
          errorCode: "PROBE_RETRYABLE",
          errorMessage: error instanceof Error ? error.message : "Unknown probe failure",
        };
      },
    });
  }

  beforeAll(async () => {
    const productionUrls = [
      process.env.DATABASE_URL,
      process.env.EXTERNAL_DATABASE_URL,
    ].filter((value): value is string => Boolean(value));
    if (productionUrls.includes(TEST_DB_URL!)) {
      throw new Error(
        "ECHELON_TEST_DATABASE_URL must not equal DATABASE_URL or EXTERNAL_DATABASE_URL",
      );
    }

    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      max: 8,
      ssl: sslConfig(TEST_DB_URL!),
    });
    await pool.query(migrationSql);
    await pool.query(`
      CREATE TABLE ${probeTableQualified} (
        effect_key TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
      )
    `);

    // command-results.repository also exports the application's default
    // repository. Hide every production connection variable while importing
    // it, then inject the dedicated test database below.
    const databaseUrl = process.env.DATABASE_URL;
    const externalDatabaseUrl = process.env.EXTERNAL_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.EXTERNAL_DATABASE_URL;
    try {
      const [{ createDrizzleFinancialCommandRepository }, databaseModule] = await Promise.all([
        import("../../commands/command-results.repository"),
        import("../../../db"),
      ]);
      defaultModulePool = databaseModule.pool;
      const testDatabase = drizzle(pool, { schema });
      repository = createDrizzleFinancialCommandRepository(testDatabase as never) as
        FinancialCommandRepository<CommandTransaction>;
    } finally {
      if (databaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = databaseUrl;
      if (externalDatabaseUrl === undefined) delete process.env.EXTERNAL_DATABASE_URL;
      else process.env.EXTERNAL_DATABASE_URL = externalDatabaseUrl;
    }
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(
        "DELETE FROM public.financial_command_results WHERE actor_id = $1",
        [actorId],
      );
      await pool.query(`DROP TABLE IF EXISTS ${probeTableQualified}`);
      await pool.end();
    }
    await defaultModulePool?.end();
  });

  it("commits the domain effect and exact succeeded result, then replays without work", async () => {
    const command = descriptor("atomic-success");
    let workCalls = 0;
    const body = { lineId: 731, state: "created" };

    const first = await runCommand(command, async (tx) => {
      workCalls += 1;
      await insertProbe(tx, "atomic-success", body);
      return {
        httpStatus: 201,
        body,
        resultType: "probe_effect",
        resultId: 731,
      };
    });

    expect(first).toMatchObject({
      replayed: false,
      httpStatus: 201,
      body,
      terminalState: "succeeded",
    });

    const stored = await pool.query<{
      status: string;
      http_status: number;
      response_body: Record<string, unknown>;
      effect_count: string;
    }>(
      `SELECT command.status,
              command.http_status,
              command.response_body,
              COUNT(probe.effect_key)::text AS effect_count
       FROM public.financial_command_results command
       LEFT JOIN ${probeTableQualified} probe
         ON probe.effect_key = 'atomic-success'
       WHERE command.actor_id = $1
         AND command.resource_key = $2
       GROUP BY command.id`,
      [actorId, command.resourceKey],
    );
    expect(stored.rows[0]).toEqual({
      status: "succeeded",
      http_status: 201,
      response_body: body,
      effect_count: "1",
    });

    const replay = await runCommand(command, async () => {
      workCalls += 1;
      throw new Error("replayed work must not execute");
    });
    expect(replay).toMatchObject({
      commandId: first.commandId,
      replayed: true,
      httpStatus: 201,
      body,
      terminalState: "succeeded",
    });

    const replayAfterCommandRename = await runCommand(
      {
        ...command,
        commandName: "test.financial_command.atomic_success_v2",
      },
      async () => {
        workCalls += 1;
        throw new Error("a terminal result must outlive an internal command rename");
      },
    );
    expect(replayAfterCommandRename).toMatchObject({
      commandId: first.commandId,
      replayed: true,
      httpStatus: 201,
      body,
      terminalState: "succeeded",
    });
    expect(workCalls).toBe(1);
  });

  it("rolls back a domain effect while durably recording and replaying a deterministic rejection", async () => {
    const command = descriptor("atomic-rejection");
    let workCalls = 0;

    const first = await runCommand(command, async (tx) => {
      workCalls += 1;
      await insertProbe(tx, "atomic-rejection", { shouldPersist: false });
      throw new DeterministicProbeError("The probe input is invalid");
    });

    expect(first).toMatchObject({
      replayed: false,
      httpStatus: 422,
      body: { error: "probe rejected", code: "PROBE_REJECTED" },
      terminalState: "rejected",
    });

    const stored = await pool.query<{
      status: string;
      http_status: number;
      response_body: Record<string, unknown>;
      effect_count: string;
    }>(
      `SELECT command.status,
              command.http_status,
              command.response_body,
              (
                SELECT COUNT(*)::text
                FROM ${probeTableQualified}
                WHERE effect_key = 'atomic-rejection'
              ) AS effect_count
       FROM public.financial_command_results command
       WHERE command.actor_id = $1
         AND command.resource_key = $2`,
      [actorId, command.resourceKey],
    );
    expect(stored.rows[0]).toEqual({
      status: "rejected",
      http_status: 422,
      response_body: { error: "probe rejected", code: "PROBE_REJECTED" },
      effect_count: "0",
    });

    const replay = await runCommand(command, async () => {
      workCalls += 1;
      throw new Error("rejected replay work must not execute");
    });
    expect(replay).toMatchObject({
      commandId: first.commandId,
      replayed: true,
      httpStatus: 422,
      body: { error: "probe rejected", code: "PROBE_REJECTED" },
      terminalState: "rejected",
    });
    expect(workCalls).toBe(1);
  });

  it("executes simultaneous identical commands once and makes the duplicate replayable", async () => {
    const command = descriptor("simultaneous");
    let workCalls = 0;
    const work = async (tx: CommandTransaction) => {
      workCalls += 1;
      await insertProbe(tx, "simultaneous", { workCalls });
      return { httpStatus: 201, body: { created: true } };
    };

    const settled = await Promise.allSettled([
      runCommand(command, work),
      runCommand(command, work),
    ]);
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof runCommand>>> =>
        result.status === "fulfilled",
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const failure of rejected) {
      expect(failure.reason).toMatchObject({
        statusCode: 409,
        code: "FINANCIAL_COMMAND_IN_PROGRESS",
      });
    }

    const eventualReplay = fulfilled.find((result) => result.value.replayed)?.value
      ?? await runCommand(command, work);
    expect(eventualReplay).toMatchObject({
      replayed: true,
      httpStatus: 201,
      body: { created: true },
      terminalState: "succeeded",
    });
    expect(workCalls).toBe(1);

    const probe = await pool.query<{ effect_count: string }>(
      `SELECT COUNT(*)::text AS effect_count
       FROM ${probeTableQualified}
       WHERE effect_key = 'simultaneous'`,
    );
    expect(probe.rows[0].effect_count).toBe("1");
  });

  it("rejects a different request hash under the same scoped idempotency key", async () => {
    const original = descriptor("hash-conflict", { key: "shared-key", hashSeed: "first" });
    await runCommand(original, async (tx) => {
      await insertProbe(tx, "hash-conflict", { version: 1 });
      return { httpStatus: 200, body: { version: 1 } };
    });

    let conflictingWorkCalls = 0;
    const conflicting = descriptor("hash-conflict", {
      key: "shared-key",
      hashSeed: "different",
    });
    await expect(runCommand(conflicting, async () => {
      conflictingWorkCalls += 1;
      return { httpStatus: 200, body: { version: 2 } };
    })).rejects.toMatchObject({
      statusCode: 422,
      code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED",
    });
    expect(conflictingWorkCalls).toBe(0);
  });

  it("prevents a stale lease owner from finalizing or running domain work after reclaim", async () => {
    const command = descriptor("stale-owner");
    const originalReservation = await repository.reserve(command);
    expect(originalReservation.kind).toBe("claimed");
    if (originalReservation.kind !== "claimed") {
      throw new Error("Expected the first reservation to create a claim");
    }

    const forcedExpiration = await pool.query<{ lease_token: string }>(
      `UPDATE public.financial_command_results
       SET lease_expires_at = GREATEST(
         updated_at + interval '1 microsecond',
         transaction_timestamp()
       )
       WHERE id = $1
         AND actor_id = $2
       RETURNING lease_token`,
      [originalReservation.claim.commandId, actorId],
    );
    expect(forcedExpiration.rows).toEqual([
      { lease_token: originalReservation.claim.leaseToken },
    ]);

    const reclaimedReservation = await repository.reserve(command);
    expect(reclaimedReservation.kind).toBe("claimed");
    if (reclaimedReservation.kind !== "claimed") {
      throw new Error("Expected the expired lease to be reclaimed");
    }
    expect(reclaimedReservation.claim).toMatchObject({
      commandId: originalReservation.claim.commandId,
    });
    expect(reclaimedReservation.claim.leaseToken).not.toBe(
      originalReservation.claim.leaseToken,
    );

    let staleWorkCalls = 0;
    await expect(repository.executeClaim(
      originalReservation.claim,
      command,
      async (tx) => {
        staleWorkCalls += 1;
        await insertProbe(tx, "stale-owner", { shouldPersist: false });
        return { httpStatus: 200, body: { staleOwnerWon: true } };
      },
    )).rejects.toMatchObject({
      statusCode: 409,
      code: "FINANCIAL_COMMAND_STALE_OWNER",
    });
    expect(staleWorkCalls).toBe(0);

    const stored = await pool.query<{
      status: string;
      lease_token: string;
      attempt_count: number;
      effect_count: string;
    }>(
      `SELECT command.status,
              command.lease_token,
              command.attempt_count,
              (
                SELECT COUNT(*)::text
                FROM ${probeTableQualified}
                WHERE effect_key = 'stale-owner'
              ) AS effect_count
       FROM public.financial_command_results command
       WHERE command.id = $1
         AND command.actor_id = $2`,
      [originalReservation.claim.commandId, actorId],
    );
    expect(stored.rows).toEqual([{
      status: "claimed",
      lease_token: reclaimedReservation.claim.leaseToken,
      attempt_count: 2,
      effect_count: "0",
    }]);
  });

  it("blocks attempt advancement while a lease or retry delay is still active", async () => {
    const activeCommand = descriptor("early-active-reclaim");
    const activeReservation = await repository.reserve(activeCommand);
    expect(activeReservation.kind).toBe("claimed");
    if (activeReservation.kind !== "claimed") {
      throw new Error("Expected an active claim reservation");
    }

    await expect(pool.query(
      `UPDATE public.financial_command_results
       SET attempt_count = attempt_count + 1,
           lease_token = $3,
           lease_expires_at = transaction_timestamp() + interval '2 minutes',
           updated_at = transaction_timestamp()
       WHERE id = $1
         AND actor_id = $2`,
      [activeReservation.claim.commandId, actorId, `early-active-${runId}`],
    )).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("active financial command lease cannot be reclaimed"),
    });

    const retryCommand = descriptor("early-retry-reclaim");
    const retryReservation = await repository.reserve(retryCommand);
    expect(retryReservation.kind).toBe("claimed");
    if (retryReservation.kind !== "claimed") {
      throw new Error("Expected a retry seed claim reservation");
    }

    await pool.query(
      `UPDATE public.financial_command_results
       SET status = 'retryable',
           lease_token = NULL,
           lease_expires_at = NULL,
           next_attempt_at = transaction_timestamp() + interval '2 minutes',
           last_error_code = 'TEST_RETRYABLE',
           last_error_message = 'Test-owned retry delay.',
           updated_at = transaction_timestamp()
       WHERE id = $1
         AND actor_id = $2`,
      [retryReservation.claim.commandId, actorId],
    );

    await expect(pool.query(
      `UPDATE public.financial_command_results
       SET status = 'claimed',
           attempt_count = attempt_count + 1,
           lease_token = $3,
           lease_expires_at = transaction_timestamp() + interval '2 minutes',
           next_attempt_at = NULL,
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = transaction_timestamp()
       WHERE id = $1
         AND actor_id = $2`,
      [retryReservation.claim.commandId, actorId, `early-retry-${runId}`],
    )).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("retry cannot be claimed before next_attempt_at"),
    });

    const stored = await pool.query<{
      resource_key: string;
      status: string;
      lease_token: string | null;
      attempt_count: number;
    }>(
      `SELECT resource_key, status, lease_token, attempt_count
       FROM public.financial_command_results
       WHERE actor_id = $1
         AND resource_key = ANY($2::text[])
       ORDER BY resource_key`,
      [actorId, [activeCommand.resourceKey, retryCommand.resourceKey]],
    );
    expect(stored.rows).toEqual([
      {
        resource_key: activeCommand.resourceKey,
        status: "claimed",
        lease_token: activeReservation.claim.leaseToken,
        attempt_count: 1,
      },
      {
        resource_key: retryCommand.resourceKey,
        status: "retryable",
        lease_token: null,
        attempt_count: 1,
      },
    ]);
  });

  it("keeps an active fifth claim in progress but dead-letters an expired fifth claim", async () => {
    const active = descriptor("fifth-active");
    const expired = descriptor("fifth-expired");

    await seedFifthClaim(pool, active, false);
    await seedFifthClaim(pool, expired, true);

    await expect(repository.reserve(active)).rejects.toMatchObject({
      statusCode: 409,
      code: "FINANCIAL_COMMAND_IN_PROGRESS",
    });
    await expect(repository.reserve(expired)).rejects.toMatchObject({
      statusCode: 409,
      code: "FINANCIAL_COMMAND_DEAD",
    });

    const stored = await pool.query<{
      resource_key: string;
      status: string;
      attempt_count: number;
    }>(
      `SELECT resource_key, status, attempt_count
       FROM public.financial_command_results
       WHERE actor_id = $1
         AND resource_key = ANY($2::text[])
       ORDER BY resource_key`,
      [actorId, [active.resourceKey, expired.resourceKey]],
    );
    expect(stored.rows).toEqual([
      { resource_key: active.resourceKey, status: "claimed", attempt_count: 5 },
      { resource_key: expired.resourceKey, status: "dead", attempt_count: 5 },
    ]);
  });

  it("requires an audit record to re-arm a dead command and grants exactly one exact retry", async () => {
    const command = descriptor("operator-rearm");
    await seedFifthClaim(pool, command, true);
    await expect(repository.reserve(command)).rejects.toMatchObject({
      code: "FINANCIAL_COMMAND_DEAD",
    });
    const stored = await pool.query<{ id: number }>(
      `SELECT id FROM public.financial_command_results
       WHERE actor_id = $1 AND resource_key = $2`,
      [actorId, command.resourceKey],
    );
    const commandId = Number(stored.rows[0].id);

    await expect(pool.query(
      `UPDATE public.financial_command_results
       SET status = 'retryable',
           attempt_limit = attempt_limit + 1,
           recovery_count = recovery_count + 1,
           next_attempt_at = transaction_timestamp(),
           completed_at = NULL,
           updated_at = transaction_timestamp()
       WHERE id = $1`,
      [commandId],
    )).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("Terminal financial command results are immutable"),
    });

    const recovery = await rearmDeadFinancialCommand(pool, {
      commandId,
      operatorId: `operator-${runId}`,
      reason: "Provider outage was resolved and the original caller is ready to retry.",
    });
    expect(recovery.command).toMatchObject({
      id: commandId,
      status: "retryable",
      attemptCount: 5,
      attemptLimit: 6,
      recoveryCount: 1,
    });

    const result = await runCommand(command, async (tx) => {
      await insertProbe(tx, "operator-rearm", { recovered: true });
      return { httpStatus: 200, body: { recovered: true } };
    });
    expect(result).toMatchObject({
      commandId,
      replayed: false,
      terminalState: "succeeded",
      body: { recovered: true },
    });

    const evidence = await pool.query<{
      status: string;
      attempt_count: number;
      attempt_limit: number;
      recovery_count: number;
      recovery_number: number;
      prior_error_code: string;
    }>(
      `SELECT command.status,
              command.attempt_count,
              command.attempt_limit,
              command.recovery_count,
              recovery.recovery_number,
              recovery.prior_error_code
       FROM public.financial_command_results command
       JOIN public.financial_command_recoveries recovery
         ON recovery.command_result_id = command.id
       WHERE command.id = $1`,
      [commandId],
    );
    expect(evidence.rows).toEqual([{
      status: "succeeded",
      attempt_count: 6,
      attempt_limit: 6,
      recovery_count: 1,
      recovery_number: 1,
      prior_error_code: "FINANCIAL_COMMAND_MAX_ATTEMPTS",
    }]);
  });

  it("serializes concurrent operator recovery so only one additional attempt is granted", async () => {
    const command = descriptor("concurrent-rearm");
    await seedFifthClaim(pool, command, true);
    await expect(repository.reserve(command)).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_DEAD" });
    const stored = await pool.query<{ id: number }>(
      `SELECT id FROM public.financial_command_results
       WHERE actor_id = $1 AND resource_key = $2`,
      [actorId, command.resourceKey],
    );
    const input = {
      commandId: Number(stored.rows[0].id),
      operatorId: `operator-${runId}`,
      reason: "Concurrent recovery probe with an intentionally sufficient audit explanation.",
    };
    const settled = await Promise.allSettled([
      rearmDeadFinancialCommand(pool, input),
      rearmDeadFinancialCommand(pool, input),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(failure?.reason).toMatchObject({ code: "FINANCIAL_COMMAND_NOT_DEAD" });

    const evidence = await pool.query<{
      attempt_limit: number;
      recovery_count: number;
      recovery_rows: string;
    }>(
      `SELECT command.attempt_limit,
              command.recovery_count,
              COUNT(recovery.id)::text AS recovery_rows
       FROM public.financial_command_results command
       LEFT JOIN public.financial_command_recoveries recovery
         ON recovery.command_result_id = command.id
       WHERE command.id = $1
       GROUP BY command.id`,
      [input.commandId],
    );
    expect(evidence.rows).toEqual([{ attempt_limit: 6, recovery_count: 1, recovery_rows: "1" }]);
  });

  it("purges only expired replayable terminal results and retains dead evidence", async () => {
    const seeded = await pool.query<{ id: number; status: string }>(
      `INSERT INTO public.financial_command_results (
         actor_type, actor_id, method, route_template, resource_key,
         idempotency_key, request_hash, command_name, contract_version,
         status, attempt_count, http_status, response_body,
         last_error_code, last_error_message, completed_at,
         created_at, updated_at, expires_at
       ) VALUES
       ('service', $1, 'POST', '/__tests__/retention/:id', 'retention:succeeded',
        $2, $3, 'test.financial_command.retention_succeeded', 1,
        'succeeded', 1, 200, '{"ok":true}'::jsonb,
        NULL, NULL, transaction_timestamp() - interval '2 days',
        transaction_timestamp() - interval '3 days', transaction_timestamp() - interval '2 days', transaction_timestamp() - interval '1 day'),
       ('service', $1, 'POST', '/__tests__/retention/:id', 'retention:dead',
        $4, $5, 'test.financial_command.retention_dead', 1,
        'dead', 5, NULL, NULL,
        'TEST_DEAD', 'Dead evidence must survive automatic cleanup.', transaction_timestamp() - interval '2 days',
        transaction_timestamp() - interval '3 days', transaction_timestamp() - interval '2 days', transaction_timestamp() - interval '1 day')
       RETURNING id, status`,
      [
        actorId,
        `${runId}-retention-succeeded`,
        requestHash("retention-succeeded"),
        `${runId}-retention-dead`,
        requestHash("retention-dead"),
      ],
    );
    expect(await purgeExpiredFinancialCommandResults(pool, 10)).toBe(1);
    const remaining = await pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM public.financial_command_results
       WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [seeded.rows.map((row) => row.id)],
    );
    expect(remaining.rows).toEqual([
      expect.objectContaining({ status: "dead" }),
    ]);
  });
});

class DeterministicProbeError extends Error {}

async function seedFifthClaim(
  pool: pg.Pool,
  descriptor: FinancialCommandDescriptor,
  expired: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO public.financial_command_results (
       actor_type,
       actor_id,
       method,
       route_template,
       resource_key,
       idempotency_key,
       request_hash,
       command_name,
       contract_version,
       status,
       lease_token,
       lease_expires_at,
       attempt_count,
       created_at,
       updated_at,
       expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       'claimed', $10,
       CASE
         WHEN $11::boolean THEN transaction_timestamp() - interval '1 minute'
         ELSE transaction_timestamp() + interval '2 minutes'
       END,
       5,
       transaction_timestamp() - interval '10 minutes',
       transaction_timestamp() - interval '2 minutes',
       transaction_timestamp() + interval '400 days'
     )`,
    [
      descriptor.actorType,
      descriptor.actorId,
      descriptor.method,
      descriptor.routeTemplate,
      descriptor.resourceKey,
      descriptor.idempotencyKey,
      descriptor.requestHash,
      descriptor.commandName,
      descriptor.contractVersion,
      `seeded-fifth-lease-${descriptor.resourceKey}`,
      expired,
    ],
  );
}
