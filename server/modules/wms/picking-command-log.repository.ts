import { pickingLogs, insertPickingLogSchema } from "@shared/schema";
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
