import { syncSettings } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";

export async function updateGlobalSyncSettingsSingletonWithCasInTx(
  transaction: { update: (...args: any[]) => any },
  input: {
    globalEnabled: boolean;
    sweepIntervalMinutes: number;
    currentRevision: bigint;
    actorId: string | null;
    changeReason: string | null;
    occurredAt: Date;
  },
): Promise<{ revision: bigint }[]> {
  return transaction
    .update(syncSettings)
    .set({
      globalEnabled: input.globalEnabled,
      sweepIntervalMinutes: input.sweepIntervalMinutes,
      revision: sql`${syncSettings.revision} + 1`,
      changedBy: input.actorId,
      changeReason: input.changeReason,
      updatedAt: input.occurredAt,
    })
    .where(
      and(
        eq(syncSettings.singletonKey, true),
        eq(syncSettings.revision, input.currentRevision),
      ),
    )
    .returning({ revision: syncSettings.revision });
}
