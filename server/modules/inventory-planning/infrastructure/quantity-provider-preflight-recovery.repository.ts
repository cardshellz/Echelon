import { z } from "zod";
import type { InventoryAvailabilityTransactionQueryClient as Client } from "../application/inventory-availability-transaction-query.port";
import { ebayRequestJournalContractSchema, preflightEvidenceHash, type EbayNoRequestProof } from "../domain/ebay-publication-preflight";

export interface QuantityNoRequestAttempt {
  id: string;
  before_record: Record<string, unknown>;
}

export function journalContractNoRequestProof(attempt: QuantityNoRequestAttempt): EbayNoRequestProof | null {
  const scope = z.object({ providerKey: z.literal("ebay") }).passthrough().safeParse(attempt.before_record.scope);
  const parsed = ebayRequestJournalContractSchema.safeParse(attempt.before_record.request_journal_contract);
  return scope.success && parsed.success ? { source: "request_journal_contract", contract: parsed.data } : null;
}

/** Caller holds the publication gate and every exact scope exclusively. The
 * immutable start is committed before HTTP; any row (even without a response)
 * prevents no-send recovery. No age/lease heuristic or quantity read is proof. */
export async function recoverNoRequestAttemptInsideTransaction(client: Client,
  attempt: QuantityNoRequestAttempt, proof: EbayNoRequestProof, now: Date): Promise<boolean> {
  if (!["running", "uncertain"].includes(String(attempt.before_record.state))) return false;
  const requests = (await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM inventory.quantity_provider_requests WHERE attempt_id=$1", [attempt.id])).rows[0];
  if (requests?.count !== "0") return false;
  const evidenceHash = preflightEvidenceHash({ attemptId: attempt.id, proof });
  await client.query(`INSERT INTO inventory.quantity_publication_no_request_recoveries
    (attempt_id,evidence_hash,proof,before_record,created_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)`,
  [attempt.id, evidenceHash, JSON.stringify(proof), JSON.stringify(attempt.before_record), now.toISOString()]);
  const changed = await client.query(`UPDATE inventory.quantity_publication_attempts SET state='not_sent',completed_at=$2,
    outcome_hash=$3,resolution_basis='owner_preflight_no_request',error_code=COALESCE(error_code,'PROVIDER_PREFLIGHT_NOT_SENT')
    WHERE id=$1 AND state IN ('running','uncertain')`, [attempt.id, now.toISOString(), evidenceHash]);
  if (changed.rowCount !== 1) throw new Error("No-request recovery lost its exact attempt ownership.");
  // A recovered failed lookup has not delivered stock. Retain/release current
  // catch-up work instead of completing it or replaying a stored quantity.
  await client.query(`UPDATE inventory.quantity_publication_catchup SET next_attempt_at=$2,updated_at=$2
    WHERE completed_revision<revision AND scope_key IN
      (SELECT unnest(affected_scope_keys) FROM inventory.quantity_publication_attempts WHERE id=$1)`,
  [attempt.id, now.toISOString()]);
  return true;
}
