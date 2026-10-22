/** New historical allocations use recorded timestamp coordinates, not the host
 * timezone. Legacy COGS wall times use the schema's nominal UTC coordinate;
 * timestamptz operations use their absolute instant. This is a financial ordering
 * policy, not a reconstruction of unidentified physical piece movements.
 * Previously persisted quantity intervals remain authoritative on replay.
 */
export const HISTORICAL_COST_EVIDENCE_ORDER_POLICY =
  "stable_recorded_evidence_order_v2";

export interface HistoricalCostEvidenceOrderInput {
  kind: "operation" | "cogs" | "reversal";
  id: number;
  timestampMicros: unknown;
}

export class HistoricalCostEvidenceOrderError extends Error {
  readonly code = "COST_HISTORICAL_TIMESTAMP_INVALID";

  constructor(readonly sourceKind: string, readonly sourceId: number) {
    super("Historical cost evidence needs a finite, exact recorded timestamp before allocating costs.");
    this.name = "HistoricalCostEvidenceOrderError";
  }
}

/** PostgreSQL returns exact integer microseconds as text. Validate before any
 * allocation writes, and retain text in audit JSON (JSON cannot encode bigint).
 * BigInt comparisons preserve sub-millisecond order and pre-epoch timestamps.
 */
export function orderHistoricalCostEvidence<T extends HistoricalCostEvidenceOrderInput>(
  candidates: readonly T[],
): Array<T & { timestampMicros: string }> {
  const ordered = candidates.map((candidate) => {
    if (typeof candidate.timestampMicros !== "string"
      || !/^-?\d+$/.test(candidate.timestampMicros)) {
      throw new HistoricalCostEvidenceOrderError(candidate.kind, candidate.id);
    }
    const timestamp = BigInt(candidate.timestampMicros);
    return { candidate: { ...candidate, timestampMicros: timestamp.toString() }, timestamp };
  });
  ordered.sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp < right.timestamp ? -1 : 1;
    if (left.candidate.kind !== right.candidate.kind) {
      return left.candidate.kind < right.candidate.kind ? -1 : 1;
    }
    return left.candidate.id - right.candidate.id;
  });
  return ordered.map(({ candidate }) => candidate);
}
