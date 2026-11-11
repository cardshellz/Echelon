import { eq } from "drizzle-orm";
import { pickingLogs, insertPickingLogSchema } from "@shared/schema/orders.schema";
import type { db } from "../../db";

/** A retry after logging cannot create a second action log. */
export async function createPickingCommandLog(
  client: Pick<typeof db, "insert">,
  operationKey: string,
  payload: unknown,
): Promise<void> {
  const log = insertPickingLogSchema.parse(payload);
  await client
    .insert(pickingLogs)
    .values({ ...log, operationKey })
    .onConflictDoNothing();
}

export async function renameWmsPickingLogSku(
  client: Pick<typeof db, "update">,
  args: { oldSku: string; newSku: string },
): Promise<number> {
  const oldSku = args.oldSku.trim();
  const newSku = args.newSku.trim();
  if (!oldSku || !newSku) {
    throw new Error("renameWmsPickingLogSku: oldSku and newSku are required");
  }
  const rows = await client
    .update(pickingLogs)
    .set({ sku: newSku })
    .where(eq(pickingLogs.sku, oldSku))
    .returning({ id: pickingLogs.id });
  return Array.isArray(rows) ? rows.length : 0;
}
