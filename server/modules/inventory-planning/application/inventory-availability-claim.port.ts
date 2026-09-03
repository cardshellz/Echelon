import type {
  CanonicalAvailabilityClaimBuildHandoffCommand,
  CanonicalAvailabilityClaimBuildHandoffResult,
  CanonicalAvailabilityClaimCommand,
  CanonicalAvailabilityClaimOperationExecutionCommand,
  CanonicalAvailabilityClaimOperationExecutionResult,
  CanonicalAvailabilityClaimPickCommand,
  CanonicalAvailabilityClaimPickResult,
  CanonicalAvailabilityClaimReleaseCommand,
  CanonicalAvailabilityClaimReplacementCommand,
  CanonicalAvailabilityClaimReplacementResult,
  CanonicalAvailabilityClaimResult,
  CanonicalAvailabilityClaimUnpickCommand,
} from "@shared/types/inventory-availability-claims";

/**
 * Application-owned persistence boundary for the complete canonical claim lifecycle.
 * Runtime callers depend on this port; PostgreSQL remains an implementation detail.
 */
export interface InventoryAvailabilityClaimStore {
  claimOrder(command: CanonicalAvailabilityClaimCommand): Promise<CanonicalAvailabilityClaimResult>;
  replaceOrderClaim(
    command: CanonicalAvailabilityClaimReplacementCommand,
  ): Promise<CanonicalAvailabilityClaimReplacementResult>;
  releaseOrderClaim(command: CanonicalAvailabilityClaimReleaseCommand): Promise<CanonicalAvailabilityClaimResult>;
  executePackageOperation(
    command: CanonicalAvailabilityClaimOperationExecutionCommand,
  ): Promise<CanonicalAvailabilityClaimOperationExecutionResult>;
  executeBuildOperation(
    command: CanonicalAvailabilityClaimOperationExecutionCommand,
  ): Promise<CanonicalAvailabilityClaimOperationExecutionResult>;
  handoffBuildOperation(
    command: CanonicalAvailabilityClaimBuildHandoffCommand,
  ): Promise<CanonicalAvailabilityClaimBuildHandoffResult>;
  pickClaimLine(command: CanonicalAvailabilityClaimPickCommand): Promise<CanonicalAvailabilityClaimPickResult>;
  unpickClaimLine(command: CanonicalAvailabilityClaimUnpickCommand): Promise<CanonicalAvailabilityClaimPickResult>;
}
