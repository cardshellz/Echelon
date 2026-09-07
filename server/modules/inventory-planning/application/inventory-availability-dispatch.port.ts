import type {
  CanonicalClaimDispatchCommand, CanonicalClaimDispatchEvidence, CanonicalClaimDispatchReceipt,
} from "@shared/types/inventory-availability-dispatch";
import type { CanonicalClaimTransactionClient } from "./canonical-claim-inventory.port";

/** WMS owns source authorization and locks the order BEFORE its shipment rows. */
export interface CanonicalClaimDispatchSourceOwner {
  lockDispatchSource(input: {
    client: CanonicalClaimTransactionClient;
    command: CanonicalClaimDispatchCommand;
  }): Promise<Omit<CanonicalClaimDispatchEvidence["source"], "dispatchedQuantity">>;
}

export interface CanonicalClaimDispatchStore {
  dispatch(command: CanonicalClaimDispatchCommand): Promise<CanonicalClaimDispatchReceipt>;
}

/**
 * Required composition boundary for transactional publication invalidation and
 * WMS progress. Implementations may write through their owners on this client;
 * they must not send provider requests or commit/rollback the transaction.
 */
export type CanonicalClaimDispatchBeforeCommit = (input: {
  client: CanonicalClaimTransactionClient;
  receipt: CanonicalClaimDispatchReceipt;
  inventoryTransactionId: number;
}) => Promise<void>;
