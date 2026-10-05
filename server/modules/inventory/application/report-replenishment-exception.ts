import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  replenTasks,
  productVariants,
  inventoryLevels,
  cycleCounts,
  cycleCountItems,
} from "@shared/schema";
import { AppError, IntegrityError, NotFoundError } from "@shared/errors";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import { createDrizzleFinancialCommandRepository } from "../../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../../platform/commands/http-command";
import { runTransactionalFinancialCommand } from "../../../platform/commands/transactional-command.service";
import type { db } from "../../../db";

const id = z.number().int().positive().max(2_147_483_647);
export const replenishmentExceptionCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative().max(2_147_483_647),
    expectedStatus: z.enum(["pending", "assigned", "in_progress"]),
    reason: z.enum(["short", "wrong_product", "empty", "other"]),
    actualQty: z.number().int().nonnegative().max(2_147_483_647).optional(),
    actualSku: z.string().trim().min(1).max(100).optional(),
    notes: z.string().max(5000).nullable().optional(),
  })
  .strict();
const resultSchema = z
  .object({
    taskId: id,
    cycleCountId: id,
    status: z.literal("blocked"),
    exceptionReason: replenishmentExceptionCommandSchema.shape.reason,
  })
  .strict();

/** The exception, count request, audit and replay response share one transaction. */
export async function reportReplenishmentException(
  database: Pick<typeof db, "transaction">,
  taskId: number,
  rawCommand: unknown,
  actor: string,
  clock: () => Date,
) {
  id.parse(taskId);
  z.string().trim().min(1).max(100).parse(actor);
  const command = replenishmentExceptionCommandSchema.parse(rawCommand);
  const routeTemplate = "/api/replen/tasks/:id/exception";
  const resourceKey = `inventory.replen_task:${taskId}`;
  const result = await runTransactionalFinancialCommand({
    repository: createDrizzleFinancialCommandRepository(database),
    descriptor: {
      actorType: "user",
      actorId: actor,
      method: "POST",
      routeTemplate,
      resourceKey,
      idempotencyKey: command.commandId,
      commandName: "inventory.replen_task.exception",
      contractVersion: 1,
      requestHash: hashHttpFinancialCommand({
        method: "POST",
        routeTemplate,
        resourceKey,
        body: command,
      }),
    },
    work: async (tx) => {
      const now = z.date().parse(clock());
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
      if (
        task.status !== command.expectedStatus ||
        task.revision !== command.expectedRevision
      ) {
        throw new IntegrityError(
          "Replenishment task changed. Refresh before reporting an exception.",
          {
            taskId,
            expectedStatus: command.expectedStatus,
            expectedRevision: command.expectedRevision,
            actualStatus: task.status,
            actualRevision: task.revision,
          },
        );
      }
      const [source] = task.sourceProductVariantId
        ? await tx
            .select()
            .from(productVariants)
            .where(eq(productVariants.id, task.sourceProductVariantId))
            .limit(1)
        : [];
      if (!source || !task.fromLocationId || !task.warehouseId)
        throw new IntegrityError(
          "Exception count requires the task's recorded source identity",
          { taskId },
        );
      const [level] = await tx
        .select()
        .from(inventoryLevels)
        .where(
          and(
            eq(inventoryLevels.warehouseLocationId, task.fromLocationId),
            eq(inventoryLevels.productVariantId, source.id),
          ),
        )
        .limit(1);
      const [count] = await tx
        .insert(cycleCounts)
        .values({
          name: `Replen Exception - Task #${taskId}`,
          description: `Created from replen task #${taskId} exception: ${command.reason}${command.notes ? ` - ${command.notes}` : ""}`,
          status: "in_progress",
          warehouseId: task.warehouseId,
          totalBins: 1,
          countedBins: 0,
          varianceCount: 0,
          approvedVariances: 0,
          createdBy: actor,
          createdAt: now,
        })
        .returning();
      await tx
        .insert(cycleCountItems)
        .values({
          cycleCountId: count.id,
          warehouseLocationId: task.fromLocationId,
          productVariantId: source.id,
          productId: task.productId,
          expectedSku: source.sku,
          expectedQty: level?.variantQty ?? 0,
          countedSku:
            command.reason === "wrong_product"
              ? (command.actualSku ?? null)
              : source.sku,
          countedQty:
            command.reason === "empty" ? 0 : (command.actualQty ?? null),
          status: "pending",
          countedBy: actor,
        });
      const [updated] = await tx
        .update(replenTasks)
        .set({
          status: "blocked",
          exceptionReason: command.reason,
          linkedCycleCountId: count.id,
          notes: [
            task.notes,
            `[Exception: ${command.reason}${command.notes ? ` - ${command.notes}` : ""}]`,
          ]
            .filter(Boolean)
            .join("\n"),
        })
        .where(
          and(
            eq(replenTasks.id, taskId),
            eq(replenTasks.revision, command.expectedRevision),
          ),
        )
        .returning();
      if (!updated)
        throw new IntegrityError(
          "Exception command lost its task revision guard",
          { taskId },
        );
      await persistAuditEvent(
        tx,
        {
          actor,
          action: "inventory.replen_exception_reported",
          target: resourceKey,
          changes: {
            before: {
              status: task.status,
              revision: task.revision,
              linkedCycleCountId: task.linkedCycleCountId,
            },
            after: {
              status: updated.status,
              revision: updated.revision,
              linkedCycleCountId: updated.linkedCycleCountId,
            },
          },
          context: {
            reason: command.reason,
            actualQty: command.actualQty,
            actualSku: command.actualSku,
          },
        },
        { timestamp: now },
      );
      return {
        httpStatus: 200,
        body: resultSchema.parse({
          taskId,
          cycleCountId: count.id,
          status: "blocked",
          exceptionReason: command.reason,
        }),
        resultType: "cycle_count",
        resultId: count.id,
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
            errorCode: "REPLEN_EXCEPTION_FAILED",
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
  return resultSchema.parse(result.body);
}
