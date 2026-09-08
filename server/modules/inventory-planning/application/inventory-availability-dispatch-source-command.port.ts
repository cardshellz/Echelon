import type { CanonicalClaimDispatchCommand, CanonicalClaimDispatchEvidence } from "@shared/types/inventory-availability-dispatch";
import type { CanonicalClaimTransactionClient } from "./canonical-claim-inventory.port";

/** Ingress identifies a persisted source, never a guessed claim, bin or physical item. */
export type CanonicalClaimDispatchSourceRequest = Pick<CanonicalClaimDispatchCommand,
  "orderId" | "orderItemId" | "outboundShipmentId" | "sourceShipmentItemId" | "productVariantId" | "quantity" | "actor" | "reason">;

export type CanonicalClaimDispatchPreparedSource = Omit<CanonicalClaimDispatchEvidence["source"],
  "dispatchedQuantity" | "warehouseLocationId"> & { warehouseLocationId: number | null };

/** WMS owns both source authorization and the NULL-only source-bin assignment. */
export interface CanonicalClaimDispatchSourcePreparationOwner {
  lockSourceForPreparation(input: {
    client: CanonicalClaimTransactionClient;
    request: CanonicalClaimDispatchSourceRequest;
  }): Promise<CanonicalClaimDispatchPreparedSource>;
  bindSourceLocation(input: {
    client: CanonicalClaimTransactionClient;
    request: CanonicalClaimDispatchSourceRequest;
    warehouseLocationId: number;
  }): Promise<void>;
}

/** Caller owns one SERIALIZABLE transaction and retries preparation and dispatch together. */
export interface CanonicalClaimDispatchSourceCommandResolver {
  resolve(client: CanonicalClaimTransactionClient, request: CanonicalClaimDispatchSourceRequest): Promise<CanonicalClaimDispatchCommand>;
}
