import { randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";

import { financialCommandResults } from "@shared/schema";
import { db as defaultDatabase } from "../../db";
import {
  FinancialCommandError,
  type FinancialCommandClaim,
  type FinancialCommandDescriptor,
  type FinancialCommandFailureDisposition,
  type FinancialCommandRepository,
  type FinancialCommandReservation,
  type FinancialCommandResult,
  type FinancialCommandSuccess,
} from "./transactional-command.service";

type Database = Pick<typeof defaultDatabase, "transaction">;
type Transaction = Parameters<Parameters<typeof defaultDatabase.transaction>[0]>[0];

const LEASE_SECONDS = 120;
const RESULT_RETENTION_DAYS = 400;
const DEFAULT_ATTEMPT_LIMIT = 5;

function scopeWhere(descriptor: FinancialCommandDescriptor) {
  return and(
    eq(financialCommandResults.actorType, descriptor.actorType),
    eq(financialCommandResults.actorId, descriptor.actorId),
    eq(financialCommandResults.method, descriptor.method),
    eq(financialCommandResults.routeTemplate, descriptor.routeTemplate),
    eq(financialCommandResults.resourceKey, descriptor.resourceKey),
    eq(financialCommandResults.idempotencyKey, descriptor.idempotencyKey),
  );
}

function retryAfterSeconds(value: Date | string | null | undefined): number {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) return 1;
  return Math.max(1, Math.ceil((timestamp - Date.now()) / 1_000));
}

function bounded(value: string, maximum: number): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return (normalized || "Unspecified command failure").slice(0, maximum);
}

function assertSamePayload(row: any, descriptor: FinancialCommandDescriptor): void {
  if (row.requestHash !== descriptor.requestHash) {
    throw new FinancialCommandError(
      "Idempotency-Key was already used for a different request in this command scope",
      422,
      "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED",
      { commandId: row.id },
    );
  }
}

function assertExecutableContract(row: any, descriptor: FinancialCommandDescriptor): void {
  if (
    row.commandName !== descriptor.commandName
    || Number(row.contractVersion) !== descriptor.contractVersion
  ) {
    throw new FinancialCommandError(
      "An unfinished financial command belongs to a different command contract",
      409,
      "FINANCIAL_COMMAND_CONTRACT_CHANGED",
      { commandId: row.id },
    );
  }
}

function replay(row: any): FinancialCommandReservation {
  if (
    (row.status !== "succeeded" && row.status !== "rejected")
    || !Number.isInteger(row.httpStatus)
    || row.responseBody == null
  ) {
    throw new FinancialCommandError(
      "Stored command result is not replayable",
      500,
      "FINANCIAL_COMMAND_RESULT_CORRUPT",
      { commandId: row.id },
    );
  }
  return {
    kind: "replay",
    result: {
      commandId: row.id,
      replayed: true,
      httpStatus: row.httpStatus,
      body: row.responseBody,
      terminalState: row.status,
    },
  };
}

function inProgress(row: any, dueAt = row.leaseExpiresAt): FinancialCommandError {
  const seconds = retryAfterSeconds(dueAt);
  return new FinancialCommandError(
    "An identical financial command is already being processed",
    409,
    "FINANCIAL_COMMAND_IN_PROGRESS",
    { commandId: row.id, retryAfterSeconds: seconds },
    { "Retry-After": String(seconds) },
  );
}

function staleOwner(commandId: number): FinancialCommandError {
  return new FinancialCommandError(
    "Financial command ownership changed before completion",
    409,
    "FINANCIAL_COMMAND_STALE_OWNER",
    { commandId },
  );
}

function assertOwnedRow(
  row: any,
  claim: FinancialCommandClaim,
  descriptor: FinancialCommandDescriptor,
): void {
  if (!row || row.status !== "claimed" || row.leaseToken !== claim.leaseToken) {
    throw staleOwner(claim.commandId);
  }
  assertSamePayload(row, descriptor);
  assertExecutableContract(row, descriptor);
}

export function createDrizzleFinancialCommandRepository(
  database: Database = defaultDatabase,
): FinancialCommandRepository<Transaction> {
  return {
    async reserve(descriptor): Promise<FinancialCommandReservation> {
      const leaseToken = randomUUID();
      try {
        const reservation = await database.transaction(async (tx: Transaction) => {
          // A duplicate insert may wait on the first reservation's unique-key
          // lock. Bound that wait so HTTP callers receive a retryable response.
          await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);

          const insertedRows = await tx
            .insert(financialCommandResults)
            .values({
              actorType: descriptor.actorType,
              actorId: descriptor.actorId,
              method: descriptor.method,
              routeTemplate: descriptor.routeTemplate,
              resourceKey: descriptor.resourceKey,
              idempotencyKey: descriptor.idempotencyKey,
              requestHash: descriptor.requestHash,
              commandName: descriptor.commandName,
              contractVersion: descriptor.contractVersion,
              status: "claimed",
              leaseToken,
              leaseExpiresAt: sql`transaction_timestamp() + (${LEASE_SECONDS} * interval '1 second')`,
              attemptCount: 1,
              attemptLimit: DEFAULT_ATTEMPT_LIMIT,
              expiresAt: sql`transaction_timestamp() + (${RESULT_RETENTION_DAYS} * interval '1 day')`,
            })
            .onConflictDoNothing({
              target: [
                financialCommandResults.actorType,
                financialCommandResults.actorId,
                financialCommandResults.method,
                financialCommandResults.routeTemplate,
                financialCommandResults.resourceKey,
                financialCommandResults.idempotencyKey,
              ],
            })
            .returning();
          if (insertedRows[0]) {
            return {
              kind: "claimed" as const,
              claim: { commandId: insertedRows[0].id, leaseToken },
            };
          }

          const existingRows = await tx
            .select()
            .from(financialCommandResults)
            .where(scopeWhere(descriptor))
            .limit(1)
            .for("update");
          const existing = existingRows[0];
          if (!existing) {
            throw new FinancialCommandError(
              "Financial command reservation disappeared during conflict resolution",
              503,
              "FINANCIAL_COMMAND_RESERVATION_UNAVAILABLE",
            );
          }
          assertSamePayload(existing, descriptor);

          if (existing.status === "succeeded" || existing.status === "rejected") {
            return replay(existing);
          }
          if (existing.status === "dead") {
            throw new FinancialCommandError(
              "Financial command exhausted its retry policy and requires operator review",
              409,
              "FINANCIAL_COMMAND_DEAD",
              { commandId: existing.id },
            );
          }
          assertExecutableContract(existing, descriptor);

          const dueCondition = existing.status === "claimed"
            ? lte(financialCommandResults.leaseExpiresAt, sql`transaction_timestamp()`)
            : lte(financialCommandResults.nextAttemptAt, sql`transaction_timestamp()`);

          if (existing.attemptCount >= existing.attemptLimit) {
            const deadRows = await tx
              .update(financialCommandResults)
              .set({
                status: "dead",
                leaseToken: null,
                leaseExpiresAt: null,
                nextAttemptAt: null,
                lastErrorCode: "FINANCIAL_COMMAND_MAX_ATTEMPTS",
                lastErrorMessage: "Financial command exhausted its retry policy.",
                completedAt: sql`transaction_timestamp()`,
                updatedAt: sql`transaction_timestamp()`,
              })
              .where(and(
                eq(financialCommandResults.id, existing.id),
                eq(financialCommandResults.status, existing.status),
                dueCondition,
              ))
              .returning({ id: financialCommandResults.id });
            if (!deadRows[0]) {
              throw inProgress(
                existing,
                existing.status === "claimed" ? existing.leaseExpiresAt : existing.nextAttemptAt,
              );
            }
            return { kind: "dead" as const, commandId: existing.id };
          }

          const reclaimedRows = await tx
            .update(financialCommandResults)
            .set({
              status: "claimed",
              leaseToken,
              leaseExpiresAt: sql`transaction_timestamp() + (${LEASE_SECONDS} * interval '1 second')`,
              attemptCount: sql`${financialCommandResults.attemptCount} + 1`,
              nextAttemptAt: null,
              lastErrorCode: null,
              lastErrorMessage: null,
              updatedAt: sql`transaction_timestamp()`,
            })
            .where(and(
              eq(financialCommandResults.id, existing.id),
              eq(financialCommandResults.status, existing.status),
              dueCondition,
            ))
            .returning();
          if (!reclaimedRows[0]) {
            throw inProgress(
              existing,
              existing.status === "claimed" ? existing.leaseExpiresAt : existing.nextAttemptAt,
            );
          }
          return {
            kind: "claimed" as const,
            claim: { commandId: reclaimedRows[0].id, leaseToken },
          };
        });

        if (reservation.kind === "dead") {
          throw new FinancialCommandError(
            "Financial command exhausted its retry policy and requires operator review",
            409,
            "FINANCIAL_COMMAND_DEAD",
            { commandId: reservation.commandId },
          );
        }
        return reservation;
      } catch (error: any) {
        if (error instanceof FinancialCommandError) throw error;
        if (error?.code === "55P03") {
          throw new FinancialCommandError(
            "An identical financial command is already being reserved",
            409,
            "FINANCIAL_COMMAND_IN_PROGRESS",
            { retryAfterSeconds: 1 },
            { "Retry-After": "1" },
          );
        }
        throw error;
      }
    },

    async executeClaim<T>(
      claim: FinancialCommandClaim,
      descriptor: FinancialCommandDescriptor,
      work: (tx: Transaction) => Promise<FinancialCommandSuccess<T>>,
    ): Promise<FinancialCommandResult<T>> {
      return database.transaction(async (tx: Transaction) => {
        const ownedRows = await tx
          .select()
          .from(financialCommandResults)
          .where(and(
            eq(financialCommandResults.id, claim.commandId),
            eq(financialCommandResults.status, "claimed"),
            eq(financialCommandResults.leaseToken, claim.leaseToken),
          ))
          .limit(1)
          .for("update");
        const owned = ownedRows[0];
        assertOwnedRow(owned, claim, descriptor);

        const success = await work(tx);
        const completedRows = await tx
          .update(financialCommandResults)
          .set({
            status: "succeeded",
            leaseToken: null,
            leaseExpiresAt: null,
            httpStatus: success.httpStatus,
            responseBody: success.body as any,
            resultType: success.resultType ?? null,
            resultId: success.resultId === undefined ? null : String(success.resultId),
            completedAt: sql`transaction_timestamp()`,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(and(
            eq(financialCommandResults.id, claim.commandId),
            eq(financialCommandResults.status, "claimed"),
            eq(financialCommandResults.leaseToken, claim.leaseToken),
          ))
          .returning({ id: financialCommandResults.id });
        if (!completedRows[0]) throw staleOwner(claim.commandId);
        return {
          commandId: claim.commandId,
          replayed: false,
          httpStatus: success.httpStatus,
          body: success.body,
          terminalState: "succeeded",
        };
      });
    },

    async rejectClaim(
      claim,
      descriptor,
      rejection: Extract<FinancialCommandFailureDisposition, { kind: "rejected" }>,
    ) {
      return database.transaction(async (tx: Transaction) => {
        const ownedRows = await tx
          .select()
          .from(financialCommandResults)
          .where(and(
            eq(financialCommandResults.id, claim.commandId),
            eq(financialCommandResults.status, "claimed"),
            eq(financialCommandResults.leaseToken, claim.leaseToken),
          ))
          .limit(1)
          .for("update");
        assertOwnedRow(ownedRows[0], claim, descriptor);
        const completedRows = await tx
          .update(financialCommandResults)
          .set({
            status: "rejected",
            leaseToken: null,
            leaseExpiresAt: null,
            httpStatus: rejection.httpStatus,
            responseBody: rejection.body as any,
            lastErrorCode: bounded(rejection.errorCode, 100),
            lastErrorMessage: bounded(rejection.errorMessage, 1_000),
            completedAt: sql`transaction_timestamp()`,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(and(
            eq(financialCommandResults.id, claim.commandId),
            eq(financialCommandResults.status, "claimed"),
            eq(financialCommandResults.leaseToken, claim.leaseToken),
          ))
          .returning({ id: financialCommandResults.id });
        if (!completedRows[0]) throw staleOwner(claim.commandId);
        return {
          commandId: claim.commandId,
          replayed: false,
          httpStatus: rejection.httpStatus,
          body: rejection.body,
          terminalState: "rejected" as const,
        };
      });
    },

    async markRetryable(
      claim,
      descriptor,
      failure: Extract<FinancialCommandFailureDisposition, { kind: "retryable" }>,
    ) {
      await database.transaction(async (tx: Transaction) => {
        const ownedRows = await tx
          .select()
          .from(financialCommandResults)
          .where(and(
            eq(financialCommandResults.id, claim.commandId),
            eq(financialCommandResults.status, "claimed"),
            eq(financialCommandResults.leaseToken, claim.leaseToken),
          ))
          .limit(1)
          .for("update");
        const owned = ownedRows[0];
        assertOwnedRow(owned, claim, descriptor);
        const terminal = owned.attemptCount >= owned.attemptLimit;
        const updatedRows = await tx
          .update(financialCommandResults)
          .set({
            status: terminal ? "dead" : "retryable",
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: terminal
              ? null
              : sql`transaction_timestamp() + (LEAST(300, power(2, ${owned.attemptCount})) * interval '1 second')`,
            lastErrorCode: bounded(failure.errorCode, 100),
            lastErrorMessage: bounded(failure.errorMessage, 1_000),
            completedAt: terminal ? sql`transaction_timestamp()` : null,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(and(
            eq(financialCommandResults.id, claim.commandId),
            eq(financialCommandResults.status, "claimed"),
            eq(financialCommandResults.leaseToken, claim.leaseToken),
          ))
          .returning({ id: financialCommandResults.id });
        if (!updatedRows[0]) throw staleOwner(claim.commandId);
      });
    },
  };
}

export const financialCommandRepository = createDrizzleFinancialCommandRepository();
