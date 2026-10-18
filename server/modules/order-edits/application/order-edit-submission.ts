import type { OrderEditRecord } from "./order-edit-store";

/** Absence is evidence only on a validated persisted record, never an HTTP payload. */
export function orderEditHasSubmissionEvidence(
  record: OrderEditRecord,
): boolean {
  return Boolean(
    record.commitStartedAt ||
      record.commitKey ||
      record.refundIntent ||
      record.refundStartedAt ||
      record.recoveryStartedAt,
  );
}
