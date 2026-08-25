export interface PostgresPoolMetricsSource {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options?: {
    max?: number;
  };
}

export interface PostgresPoolSnapshot {
  totalConnections: number;
  idleConnections: number;
  checkedOutConnections: number;
  waitingRequests: number;
  maximumConnections: number | null;
}

export function getPostgresPoolSnapshot(
  source: PostgresPoolMetricsSource,
): PostgresPoolSnapshot {
  const totalConnections = nonNegativeCount(source.totalCount);
  const idleConnections = Math.min(nonNegativeCount(source.idleCount), totalConnections);
  const maximumConnections = positiveCountOrNull(source.options?.max);

  return {
    totalConnections,
    idleConnections,
    checkedOutConnections: totalConnections - idleConnections,
    waitingRequests: nonNegativeCount(source.waitingCount),
    maximumConnections,
  };
}

function nonNegativeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positiveCountOrNull(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}
