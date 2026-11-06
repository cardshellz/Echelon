import type { InventoryAvailabilityTransactionQueryClient } from "./inventory-availability-transaction-query.port";
import { QuantityPublicationAdmissionError, type QuantityPublicationScope } from "../domain/quantity-publication-admission";

export interface PublicationTransactionContext {
  scopes: readonly QuantityPublicationScope[];
  environment: "production" | "sandbox" | null;
  /** True only when the transport declares that every mutation is journaled. */
  providerJournaled?: boolean;
}

/** A calling work owner can require its durable claim to remain current in the
 * same transaction that admits or enqueues a publication. The guard validates
 * ownership only; it does not calculate quantity or write provider state. */
export type PublicationTransactionGuard = ((client: InventoryAvailabilityTransactionQueryClient,
  context?: PublicationTransactionContext) => Promise<void>) & {
  /** Record the exact caller claim after admission created its attempt, in
   * that same transaction and before any provider request can start. */
  recordProviderAttempt?: (client: InventoryAvailabilityTransactionQueryClient, attemptId: string,
    context: PublicationTransactionContext) => Promise<void>;
};

/** Called by the inventory owner inside its existing write transaction. The
 * caller passes its guard explicitly; it is never inferred from async state. */
export async function assertPublicationTransactionGuard(client: InventoryAvailabilityTransactionQueryClient,
  guard?: PublicationTransactionGuard, context?: PublicationTransactionContext): Promise<void> {
  if (guard) {
    try { await guard(client,context); }
    catch (error) {
      if (error instanceof QuantityPublicationAdmissionError) throw error;
      const sqlState = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
      throw Object.assign(new QuantityPublicationAdmissionError("PUBLICATION_OWNER_CHECK_FAILED",
        "The saved work could not be checked safely. No provider request was sent; retry current work.",
        { sqlState }), { cause: error });
    }
  }
}

export async function recordPublicationGuardProviderAttempt(client: InventoryAvailabilityTransactionQueryClient,
  attemptId: string, guard: PublicationTransactionGuard | undefined, context: PublicationTransactionContext): Promise<void> {
  if (guard) {
    try { await guard.recordProviderAttempt?.(client, attemptId, context); }
    catch (error) {
      if (error instanceof QuantityPublicationAdmissionError) throw error;
      const sqlState = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
      throw Object.assign(new QuantityPublicationAdmissionError("PUBLICATION_OWNER_EVIDENCE_FAILED",
        "The saved work could not record provider admission. No provider request was sent; retry current work.",
        { sqlState,attemptId }), { cause: error });
    }
  }
}
