import type { InventoryAvailabilityTransactionQueryClient } from "./inventory-availability-transaction-query.port";
import type { LegacyMaintenanceEvidence } from "../domain/publication-replacement-policy";
import type { QuantityPublicationScope } from "../domain/quantity-publication-admission";

export interface LegacyMaintenanceProof {
  policy: LegacyMaintenanceEvidence;
  source: unknown;
}
/** Reads retained local evidence only, on the recovery owner's locked transaction. */
export interface LegacyMaintenanceEvidenceReader {
  read(client: InventoryAvailabilityTransactionQueryClient, input: {
    attemptId: string; syncJobId: string; syncRevision: string; scopes: readonly QuantityPublicationScope[];
  }): Promise<LegacyMaintenanceProof | null>;
}
