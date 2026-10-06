import { returnCommandResultSchema, type ReturnCommandResult } from "@shared/inventory/return-command";
export { returnCommandResultSchema, type ReturnCommandResult } from "@shared/inventory/return-command";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { CostEvidenceError, type CostEvidenceTransaction } from "./cost-evidence.repository";

export async function loadReturnCommand(tx: CostEvidenceTransaction, key: string, hash: string): Promise<ReturnCommandResult | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory.return_command:${key}`}))`);
  const result = await tx.execute(sql`SELECT request_hash,response FROM inventory.return_commands WHERE idempotency_key=${key}`);
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_hash !== hash) throw new CostEvidenceError("RETURN_COMMAND_REPLAY_CONFLICT","Return replay differs from its recorded request.");
  return returnCommandResultSchema.parse(row.response);
}

export async function recordReturnCommand(tx: CostEvidenceTransaction, input: {
  key: string; hash: string; result: ReturnCommandResult; actor: string; now: Date;
}): Promise<void> {
  const result = returnCommandResultSchema.parse(input.result);
  if (!input.actor.trim() || !Number.isFinite(input.now.getTime())) throw new CostEvidenceError("COST_AUDIT_IDENTITY_REQUIRED","Return command requires audit identity.");
  await tx.execute(sql`INSERT INTO inventory.return_commands(idempotency_key,request_hash,wms_order_id,response,recorded_by,recorded_at)
    VALUES (${input.key},${input.hash},${result.orderId},${canonicalJson(result)}::jsonb,${input.actor},${input.now})`);
}
