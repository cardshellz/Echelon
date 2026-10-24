import { sql } from "drizzle-orm";
import type { ReceivingEntryAction } from "@shared/procurement/receiving-entry-command";

export interface ReceivingEntryTransaction {
  execute(query: ReturnType<typeof sql>): Promise<{ rows: unknown[] }>;
}

export async function recordReceivingEntryAudit(tx: ReceivingEntryTransaction, input: {
  action: ReceivingEntryAction; actorId: string; commandKey: string; recordedAt: Date;
  receivingOrderId: number; before: unknown; after: unknown;
}): Promise<void> {
  await tx.execute(sql`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES(${input.recordedAt},'AUDIT',${input.actorId},${`procurement.receiving.entry.${input.action}`},
      ${`receiving-order:${input.receivingOrderId}`},${JSON.stringify({ before: input.before, after: input.after })}::jsonb,
      ${JSON.stringify({ receivingOrderId: input.receivingOrderId, commandKey: input.commandKey })}::jsonb)`);
}
