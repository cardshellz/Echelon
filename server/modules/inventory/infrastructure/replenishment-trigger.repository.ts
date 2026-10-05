import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { IntegrityError } from "@shared/errors";
import type { ReplenOrderContext } from "../application/replenishment.use-cases";

type Transaction = {
  execute(
    query: ReturnType<typeof sql>,
  ): PromiseLike<{ rows: Record<string, unknown>[] }>;
};
const id = z.number().int().positive().max(2_147_483_647);
const key = z.string().min(1).max(500);
const receipt = z.object({ request_hash: z.string(), task_id: id.nullable() });

function identity(
  variantId: number,
  locationId: number,
  context: ReplenOrderContext,
) {
  const operationKey = key.parse(context.operationKey);
  const request = {
    variantId: id.parse(variantId),
    locationId: id.parse(locationId),
    orderId: id.nullable().parse(context.orderId ?? null),
    orderItemId: id.nullable().parse(context.orderItemId ?? null),
    blocksShipment: context.blocksShipment === true,
    forceWhenAtOrBelowZero: context.forceWhenAtOrBelowZero === true,
    triggeredBy: context.triggeredBy ?? null,
  };
  return {
    operationKey,
    requestHash: createHash("sha256")
      .update(canonicalJson(request))
      .digest("hex"),
  };
}

/** One task may satisfy several independent trigger commands. Each trigger keeps
 * its own immutable decision even after the shared task leaves the active queue. */
export async function readReplenishmentTrigger(
  tx: Transaction,
  variantId: number,
  locationId: number,
  context: ReplenOrderContext,
): Promise<{ taskId: number | null } | undefined> {
  const { operationKey, requestHash } = identity(
    variantId,
    locationId,
    context,
  );
  const result = await tx.execute(
    sql`SELECT request_hash,task_id FROM inventory.replen_trigger_receipts WHERE operation_key=${operationKey}`,
  );
  if (result.rows.length === 0) return undefined;
  const stored = receipt.parse(result.rows[0]);
  if (stored.request_hash !== requestHash)
    throw new IntegrityError(
      "Replenishment trigger identity was reused with different input",
      { operationKey },
    );
  return { taskId: stored.task_id };
}

export async function recordReplenishmentTrigger(
  tx: Transaction,
  variantId: number,
  locationId: number,
  context: ReplenOrderContext,
  taskId: number | null,
  occurredAt: Date,
): Promise<void> {
  const { operationKey, requestHash } = identity(
    variantId,
    locationId,
    context,
  );
  id.nullable().parse(taskId);
  z.date().parse(occurredAt);
  await tx.execute(sql`INSERT INTO inventory.replen_trigger_receipts(operation_key,request_hash,task_id,created_at)
    VALUES(${operationKey},${requestHash},${taskId},${occurredAt}) ON CONFLICT(operation_key) DO NOTHING`);
  const stored = await readReplenishmentTrigger(
    tx,
    variantId,
    locationId,
    context,
  );
  if (!stored || stored.taskId !== taskId)
    throw new IntegrityError(
      "Replenishment trigger decision changed during retry",
      { operationKey },
    );
}
