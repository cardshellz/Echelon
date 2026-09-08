import type { PendingQuantityPublicationRecovery, QuantityPublicationRecovery, QuantityPublicationRecoveryResult } from "@shared/types/inventory-publication-recovery";
import { CUTOVER_COMPLETION_NOW } from "./inventory-cutover-completion.fixture";

export function recoveryRequest(): QuantityPublicationRecovery {
  return { attemptId: "20", idempotencyKey: "recovery-20", reason: "Inspected the retained terminal request record",
    evidenceKind: "provider_terminal_request_record", terminalOutcome: "completed",
    evidenceReference: "Retained provider request log/request-20", evidenceHash: "a".repeat(64) };
}
export function recoveryResult(): QuantityPublicationRecoveryResult {
  return { attemptId: "20", basis: "operator_attestation", replay: false, providerWriteAttempted: false };
}
export function pendingRecovery(): PendingQuantityPublicationRecovery {
  return { activationRunId: "1", gateEpoch: "2", suppressed: true, capturedAt: CUTOVER_COMPLETION_NOW.toISOString(),
    basis: "recorded_attempt_history", providerWriteAttempted: false, pendingCatchupCount: 1,
    unresolvedAttempts: [{ attemptId: "20", owner: "outbox", state: "uncertain", outboxId: "10",
      destinationKind: "channel_connection", connectionId: 3, providerKey: "shopify", providerScopeType: "location",
      externalScopeId: "location-1", externalInventoryItemId: "item-1" }] };
}
