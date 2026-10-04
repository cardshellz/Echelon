import { and, eq, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { replenTasks } from "@shared/schema";
import {
  replenishmentTaskPatchSchema,
  assertReplenishmentTaskTransition,
} from "@shared/types/replenishment-task-command";
import { AppError, IntegrityError, NotFoundError } from "@shared/errors";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import { createDrizzleFinancialCommandRepository } from "../../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../../platform/commands/http-command";
import { runTransactionalFinancialCommand } from "../../../platform/commands/transactional-command.service";
import type { db } from "../../../db";

type Database = Pick<typeof db, "transaction">;
const taskResultSchema = createSelectSchema(replenTasks).extend({
  createdAt: z.coerce.date(),
  assignedAt: z.coerce.date().nullable(),
  startedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
});

/** Persist state changes and their replay result together using the existing command owner. */
export async function changeReplenishmentTask(
  database: Database,
  taskId: number,
  rawCommand: unknown,
  actor: string,
  clock: () => Date,
) {
  z.number().int().positive().max(2_147_483_647).parse(taskId);
  z.string().trim().min(1).max(100).parse(actor);
  const command = replenishmentTaskPatchSchema.parse(rawCommand);
  const routeTemplate = "/api/replen/tasks/:id";
  const resourceKey = `inventory.replen_task:${taskId}`;
  const result = await runTransactionalFinancialCommand({
    repository: createDrizzleFinancialCommandRepository(database),
    descriptor: {
      actorType: "user",
      actorId: actor,
      method: "PATCH",
      routeTemplate,
      resourceKey,
      idempotencyKey: command.commandId,
      commandName: "inventory.replen_task.change",
      contractVersion: 1,
      requestHash: hashHttpFinancialCommand({
        method: "PATCH",
        routeTemplate,
        resourceKey,
        body: command,
      }),
    },
    work: async (tx) => {
      await tx.execute(
        sql`SELECT id FROM inventory.replen_tasks WHERE id=${taskId} FOR UPDATE`,
      );
      const [task] = await tx
        .select()
        .from(replenTasks)
        .where(eq(replenTasks.id, taskId))
        .limit(1);
      if (!task)
        throw new NotFoundError("Replenishment task does not exist", {
          taskId,
        });
      const {
        commandId: _id,
        expectedStatus,
        expectedRevision,
        ...updates
      } = command;
      if (task.status !== expectedStatus || task.revision !== expectedRevision)
        throw new IntegrityError(
          "Replenishment task changed. Refresh before changing it.",
          {
            taskId,
            expectedStatus,
            expectedRevision,
            actualStatus: task.status,
            actualRevision: task.revision,
          },
        );
      assertReplenishmentTaskTransition(
        task.status,
        updates.status ?? task.status,
      );
      const now = clock();
      if (!(now instanceof Date) || Number.isNaN(now.getTime()))
        throw new IntegrityError("Task command clock is invalid", { taskId });
      const [updated] = await tx
        .update(replenTasks)
        .set({
          ...updates,
          ...(updates.status === "cancelled" ? { completedAt: now } : {}),
          ...(updates.status === "assigned" ? { assignedAt: now } : {}),
          ...(updates.status === "in_progress"
            ? { startedAt: task.startedAt ?? now }
            : {}),
        })
        .where(
          and(
            eq(replenTasks.id, taskId),
            eq(replenTasks.revision, expectedRevision),
          ),
        )
        .returning();
      if (!updated)
        throw new IntegrityError("Task command lost its revision guard", {
          taskId,
        });
      await persistAuditEvent(
        tx,
        {
          actor,
          action: "inventory.replen_task_changed",
          target: resourceKey,
          changes: {
            before: {
              revision: task.revision,
              status: task.status,
              assignedTo: task.assignedTo,
              priority: task.priority,
              notes: task.notes,
            },
            after: {
              revision: updated.revision,
              status: updated.status,
              assignedTo: updated.assignedTo,
              priority: updated.priority,
              notes: updated.notes,
            },
          },
        },
        { timestamp: now },
      );
      return {
        httpStatus: 200,
        body: taskResultSchema.parse(updated),
        resultType: "replen_task",
        resultId: taskId,
      };
    },
    classifyFailure: (error) =>
      error instanceof AppError
        ? {
            kind: "rejected",
            httpStatus: error.statusCode,
            errorCode: error.code,
            errorMessage: error.message,
            body: { error: error.message, code: error.code },
          }
        : {
            kind: "retryable",
            errorCode: "REPLEN_TASK_CHANGE_FAILED",
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
  });
  if (result.terminalState === "rejected") {
    const rejection = z
      .object({ error: z.string(), code: z.string() })
      .parse(result.body);
    throw new AppError(rejection.error, rejection.code, result.httpStatus);
  }
  return taskResultSchema.parse(result.body);
}
