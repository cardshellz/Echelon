import { z } from "zod";
import type { InventoryAvailabilityTransactionQueryClient } from "../application/inventory-availability-transaction-query.port";
import { hasFinalQuantityProviderOutcome } from "../domain/quantity-provider-finality";
import { quantityPublicationScopeSchema, type QuantityPublicationScope } from "../domain/quantity-publication-admission";

const attemptIdsSchema = z.array(z.string().regex(/^[1-9][0-9]{0,18}$/)).max(1000)
  .refine(ids => new Set(ids).size === ids.length, "Attempt IDs must be unique");

/** Inventory owns provider-attempt evidence and finality classification.
 * Callers retain their own work locks and cannot turn finality into delivery. */
export async function readQuantityProviderFinality(client: InventoryAvailabilityTransactionQueryClient,
  rawAttemptIds: readonly string[]): Promise<ReadonlyMap<string, { final: boolean; scope: QuantityPublicationScope | null }>> {
  const ids = attemptIdsSchema.parse(rawAttemptIds);
  if (!ids.length) return new Map();
  const rows = (await client.query<{ id: string; state: string; scope: unknown; resolution_basis: string | null;
    request_count: number; unfinished_request_count: number; completed_request_count: number;
    has_request_journal_contract: boolean; has_response_recovery_receipt: boolean }>(`
    SELECT p.id::text,p.state,p.scope,p.resolution_basis,count(q.id)::integer AS request_count,
      count(q.id) FILTER (WHERE r.request_terminated IS NOT TRUE)::integer AS unfinished_request_count,
      count(q.id) FILTER (WHERE r.outcome='completed' AND r.request_terminated IS TRUE
        AND r.http_status IS NOT NULL AND r.response_hash IS NOT NULL)::integer AS completed_request_count,
      p.request_journal_contract IS NOT NULL AS has_request_journal_contract,
      EXISTS (SELECT 1 FROM inventory.quantity_publication_response_recoveries recovery
        WHERE recovery.attempt_id=p.id AND recovery.evidence_hash=p.outcome_hash) AS has_response_recovery_receipt
    FROM inventory.quantity_publication_attempts p
    LEFT JOIN inventory.quantity_provider_requests q ON q.attempt_id=p.id
    LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
    WHERE p.id=ANY($1::bigint[]) GROUP BY p.id`, [ids])).rows;
  if (rows.length !== ids.length) throw new Error("Saved provider attempt evidence is incomplete.");
  return new Map(rows.map(row => {
    const parsedScope = quantityPublicationScopeSchema.safeParse(row.scope);
    return [row.id,{ scope: parsedScope.success ? parsedScope.data : null,final: parsedScope.success && hasFinalQuantityProviderOutcome({
      state: row.state,resolutionBasis: row.resolution_basis,requestCount: row.request_count,
      unfinishedRequestCount: row.unfinished_request_count,completedRequestCount: row.completed_request_count,
      hasRequestJournalContract: row.has_request_journal_contract,hasResponseRecoveryReceipt: row.has_response_recovery_receipt,
    }) }] as const;
  }));
}
