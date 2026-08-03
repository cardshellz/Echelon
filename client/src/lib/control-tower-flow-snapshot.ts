export interface FlowSnapshotFreshness {
  status: "pending" | "refreshing" | "degraded" | "failed" | "stale" | "current";
  stale: boolean;
}

/**
 * A refreshing snapshot may safely serve its recent prior payload. Failed,
 * degraded, and stale snapshots are historical evidence, not active counts.
 */
export function flowSnapshotIsCurrent(value: FlowSnapshotFreshness | null | undefined): boolean {
  if (!value || value.stale) return false;
  return value.status === "current" || value.status === "refreshing";
}
