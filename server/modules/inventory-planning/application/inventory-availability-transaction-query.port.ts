/**
 * Query-only view of a transaction already owned by an application command.
 * Deliberately excludes connection acquisition, transaction control and release.
 * PostgreSQL PoolClient and the canonical inventory owner client satisfy it.
 */
export interface InventoryAvailabilityTransactionQueryClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount?: number | null }>;
}
