import { sql } from "drizzle-orm";
import type { ReceivingEntryAction } from "@shared/procurement/receiving-entry-command";
import { insertAuditEventSql } from "../../infrastructure/transactional-audit";

export interface ReceivingEntryTransaction {
  execute(query: ReturnType<typeof sql>): Promise<{ rows: unknown[] }>;
}

export async function recordReceivingEntryAudit(tx: ReceivingEntryTransaction, input: {
  action: ReceivingEntryAction; actorId: string; commandKey: string; recordedAt: Date;
  receivingOrderId: number; before: unknown; after: unknown;
}): Promise<void> {
  await insertAuditEventSql(tx, {
    timestamp: input.recordedAt,
    actor: input.actorId,
    action: `procurement.receiving.entry.${input.action}`,
    target: `receiving-order:${input.receivingOrderId}`,
    changesJson: JSON.stringify({ before: input.before, after: input.after }),
    contextJson: JSON.stringify({ receivingOrderId: input.receivingOrderId, commandKey: input.commandKey }),
  });
}
