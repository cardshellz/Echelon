import { financialCommandResults } from "@shared/schema";
import { sql } from "drizzle-orm";
import type { CustodyTransaction } from "./receiving-quarantine.repository";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { lockReceivingCustodyFence } from "./receiving-custody-public";

/** Old actor-scoped commands cannot be safely adopted into the new shared key
 * namespace. Keep their evidence immutable and block a second custody write. */
export async function assertNoLegacyCustodyCommand(tx: CustodyTransaction, key: string): Promise<void> {
  await lockReceivingCustodyFence(tx, "write");
  const evidence = await tx.execute(sql`SELECT 1 FROM ${financialCommandResults}
    WHERE actor_type='user' AND command_name LIKE 'procurement.receiving.custody.%' AND idempotency_key=${key}
    UNION ALL SELECT 1 FROM procurement.receiving_quarantine_observations WHERE command_key=${key}
    UNION ALL SELECT 1 FROM procurement.receiving_quarantine_dispositions WHERE command_key=${key} LIMIT 1`);
  if (evidence.rows.length) throw new FinancialCommandError("This quarantine key has historical custody evidence. Review the original command before another change.",
    503, "RECEIVING_CUSTODY_LEGACY_RECOVERY_REQUIRED");
}
