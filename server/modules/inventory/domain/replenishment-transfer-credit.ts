import { z } from "zod";
import { IntegrityError } from "@shared/errors";

const id = z.number().int().positive().max(2_147_483_647);
const nonnegative = z.number().int().nonnegative().max(2_147_483_647);
export const replenishmentTransferReceiptSchema = z.object({
  id,
  productVariantId: id,
  fromLocationId: id,
  toLocationId: id,
  variantQuantity: id,
  unitsPerVariant: id,
});
export const replenishmentTransferTaskSchema = z.object({
  id,
  sourceProductVariantId: id.nullable(),
  pickProductVariantId: id.nullable(),
  fromLocationId: id,
  toLocationId: id,
  qtySourceUnits: nonnegative,
  qtyTargetUnits: nonnegative,
  qtyCompleted: nonnegative,
  status: z.string(),
  replenMethod: z.string(),
});
export type ReplenishmentTransferTask = z.infer<
  typeof replenishmentTransferTaskSchema
>;
export type ReplenishmentTransferCredit = {
  taskId: number;
  variantQuantity: number;
  baseQuantity: number;
  completedBefore: number;
  completedAfter: number;
  status: "completed" | "in_progress";
};

/** Immutable receipt units and exact task identities bound credit; stock at a destination is not completion evidence. */
export function planReplenishmentTransferCredits(input: {
  receipt: z.input<typeof replenishmentTransferReceiptSchema>;
  tasks: readonly ReplenishmentTransferTask[];
  existingCredits: readonly { taskId: number; variantQuantity: number }[];
}): ReplenishmentTransferCredit[] {
  const receipt = replenishmentTransferReceiptSchema.parse(input.receipt);
  const tasks = z.array(replenishmentTransferTaskSchema).parse(input.tasks);
  const existing = z
    .array(z.object({ taskId: id, variantQuantity: id }))
    .parse(input.existingCredits);
  if (
    new Set(tasks.map((task) => task.id)).size !== tasks.length ||
    new Set(existing.map((credit) => credit.taskId)).size !== existing.length
  ) {
    throw new IntegrityError("Duplicate task or credit in transfer plan", {
      transferId: receipt.id,
    });
  }
  let remaining =
    BigInt(receipt.variantQuantity) -
    existing.reduce(
      (sum, credit) => sum + BigInt(credit.variantQuantity),
      BigInt(0),
    );
  if (remaining < BigInt(0))
    throw new IntegrityError(
      "Transfer credits exceed their committed receipt",
      { transferId: receipt.id },
    );
  const credits: ReplenishmentTransferCredit[] = [];
  for (const task of [...tasks].sort((left, right) => left.id - right.id)) {
    if (remaining === BigInt(0)) break;
    if (
      existing.some((credit) => credit.taskId === task.id) ||
      !["pending", "assigned", "in_progress"].includes(task.status) ||
      !["full_case", "pallet_drop"].includes(task.replenMethod) ||
      task.fromLocationId !== receipt.fromLocationId ||
      task.toLocationId !== receipt.toLocationId ||
      task.sourceProductVariantId !== receipt.productVariantId ||
      task.pickProductVariantId !== receipt.productVariantId
    )
      continue;
    // A changed catalog unit basis cannot satisfy a task frozen under older units.
    id.parse(task.qtySourceUnits);
    id.parse(task.qtyTargetUnits);
    if (
      BigInt(task.qtySourceUnits) * BigInt(receipt.unitsPerVariant) !==
      BigInt(task.qtyTargetUnits)
    )
      continue;
    if (
      task.qtyCompleted > task.qtyTargetUnits ||
      task.qtyCompleted % receipt.unitsPerVariant !== 0
    ) {
      throw new IntegrityError(
        "Task completed quantity does not have an exact variant-unit basis",
        { taskId: task.id },
      );
    }
    const required = BigInt(
      (task.qtyTargetUnits - task.qtyCompleted) / receipt.unitsPerVariant,
    );
    const variants = Number(remaining < required ? remaining : required);
    if (variants === 0) continue;
    const base = id.parse(variants * receipt.unitsPerVariant);
    const total = nonnegative.parse(task.qtyCompleted + base);
    credits.push({
      taskId: task.id,
      variantQuantity: variants,
      baseQuantity: base,
      completedBefore: task.qtyCompleted,
      completedAfter: total,
      status: total === task.qtyTargetUnits ? "completed" : "in_progress",
    });
    remaining -= BigInt(variants);
  }
  return credits;
}
