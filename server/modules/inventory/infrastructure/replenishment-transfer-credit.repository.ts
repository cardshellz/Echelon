import { sql } from "drizzle-orm";
import { z } from "zod";
import { IntegrityError } from "@shared/errors";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import {
  planReplenishmentTransferCredits,
  replenishmentTransferTaskSchema,
  replenishmentTransferReceiptSchema,
} from "../domain/replenishment-transfer-credit";
import type { db } from "../../../db";
type Transaction = Pick<typeof db, "execute" | "insert">;
const id = z.number().int().positive().max(2_147_483_647);

/** Lock the receipt budget and task rows; the domain plan owns eligibility and unit calculations. */
export async function creditTransferToReplenishment(
  tx: Transaction,
  transferId: number,
  actor: string,
  occurredAt: Date,
  onlyTaskId?: number,
): Promise<number[]> {
  id.parse(transferId);
  if (onlyTaskId !== undefined) id.parse(onlyTaskId);
  z.string().trim().min(1).max(100).parse(actor);
  z.date().parse(occurredAt);
  await tx.execute(
    sql`SELECT id FROM inventory.inventory_transactions WHERE id=${transferId} FOR UPDATE`,
  );
  const receipt = (
    await tx.execute(sql`SELECT id,product_variant_id,from_location_id,to_location_id,variant_qty_delta,units_per_variant_snapshot
    FROM inventory.inventory_transactions WHERE id=${transferId} AND transaction_type='transfer' AND voided_at IS NULL`)
  ).rows[0];
  if (!receipt || !receipt.units_per_variant_snapshot)
    throw new IntegrityError(
      "Task credit requires an unvoided transfer receipt with its recorded unit basis",
      { transferId },
    );
  const existing = (
    await tx.execute(
      sql`SELECT task_id,variant_quantity FROM inventory.replen_transfer_credits WHERE transfer_id=${transferId}`,
    )
  ).rows;
  const taskRows = (
    await tx.execute(sql`SELECT * FROM inventory.replen_tasks WHERE from_location_id=${receipt.from_location_id}
    AND to_location_id=${receipt.to_location_id} ${onlyTaskId === undefined ? sql`` : sql`AND id=${onlyTaskId}`}
    ORDER BY id FOR UPDATE`)
  ).rows;
  const tasks = taskRows.map((task) =>
    replenishmentTransferTaskSchema.parse({
      id: task.id,
      sourceProductVariantId: task.source_product_variant_id,
      pickProductVariantId: task.pick_product_variant_id,
      fromLocationId: task.from_location_id,
      toLocationId: task.to_location_id,
      qtySourceUnits: task.qty_source_units,
      qtyTargetUnits: task.qty_target_units,
      qtyCompleted: task.qty_completed,
      status: task.status,
      replenMethod: task.replen_method,
    }),
  );
  const credits = planReplenishmentTransferCredits({
    receipt: replenishmentTransferReceiptSchema.parse({
      id: transferId,
      productVariantId: receipt.product_variant_id,
      fromLocationId: receipt.from_location_id,
      toLocationId: receipt.to_location_id,
      variantQuantity: receipt.variant_qty_delta,
      unitsPerVariant: receipt.units_per_variant_snapshot,
    }),
    tasks,
    existingCredits: existing.map((row) => ({
      taskId: id.parse(row.task_id),
      variantQuantity: id.parse(row.variant_quantity),
    })),
  });
  if (
    onlyTaskId !== undefined &&
    !existing.some((row) => row.task_id === onlyTaskId) &&
    !credits.some((credit) => credit.taskId === onlyTaskId)
  ) {
    throw new IntegrityError(
      "The transfer receipt does not supply this task's exact source, SKU, destination and unit basis",
      { transferId, taskId: onlyTaskId },
    );
  }
  const completed = tasks
    .filter(
      (task) =>
        task.status === "completed" &&
        existing.some((row) => row.task_id === task.id),
    )
    .map((task) => task.id);
  for (const credit of credits) {
    await tx.execute(sql`INSERT INTO inventory.replen_transfer_credits(transfer_id,task_id,variant_quantity,base_quantity,actor,occurred_at)
      VALUES (${transferId},${credit.taskId},${credit.variantQuantity},${credit.baseQuantity},${actor},${occurredAt})`);
    await tx.execute(sql`UPDATE inventory.replen_tasks SET qty_completed=${credit.completedAfter},status=${credit.status},
      assigned_to=COALESCE(assigned_to,${actor}),completed_at=${credit.status === "completed" ? occurredAt : null} WHERE id=${credit.taskId}`);
    await persistAuditEvent(
      tx,
      {
        actor,
        action: "inventory.replen_transfer_credited",
        target: `inventory.replen_task:${credit.taskId}`,
        context: {
          transferId,
          variantQuantity: credit.variantQuantity,
          baseQuantity: credit.baseQuantity,
        },
        changes: {
          before: {
            qtyCompleted: credit.completedBefore,
            status: tasks.find((task) => task.id === credit.taskId)!.status,
          },
          after: { qtyCompleted: credit.completedAfter, status: credit.status },
        },
      },
      { timestamp: occurredAt },
    );
    if (credit.status === "completed") {
      completed.push(credit.taskId);
      await recordReplenishmentFollowup(tx, credit.taskId, actor, occurredAt);
    }
  }
  return completed;
}

export async function recordReplenishmentFollowup(
  tx: Pick<Transaction, "execute">,
  taskId: number,
  actor: string,
  occurredAt: Date,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO inventory.replen_followups(task_id,actor,created_at) VALUES (${taskId},${actor},${occurredAt}) ON CONFLICT(task_id) DO NOTHING`,
  );
}
