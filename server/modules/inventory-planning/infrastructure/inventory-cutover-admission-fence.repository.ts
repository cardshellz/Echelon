import type { InventoryAvailabilityTransactionQueryClient } from "../application/inventory-availability-transaction-query.port";
import {
  inventoryCutoverFenceRequestSchema,
  inventoryCutoverFenceReceiptSchema,
  type InventoryCutoverFenceRequest,
  type InventoryCutoverFenceReceipt,
} from "../domain/inventory-cutover-admission-fence";

export class InventoryCutoverAdmissionFenceError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {},
    options?: ErrorOptions) {
    super(message, options);
    this.name = "InventoryCutoverAdmissionFenceError";
  }
}

/**
 * Call FIRST in a caller-owned READ COMMITTED transaction, before run, graph,
 * order, or inventory locks. The DB owner drains authority users, then acquires
 * admission NOWAIT to avoid cycles with admission-first writers.
 * No commit, rollback, provider calls, or durable business transition occurs here.
 */
export async function acquireInventoryCutoverFenceInsideTransaction(
  client: InventoryAvailabilityTransactionQueryClient,
  input: InventoryCutoverFenceRequest,
): Promise<InventoryCutoverFenceReceipt> {
  const parsed = inventoryCutoverFenceRequestSchema.safeParse(input);
  if (!parsed.success) throw new InventoryCutoverAdmissionFenceError(
    "INVENTORY_CUTOVER_FENCE_INPUT_INVALID", "Invalid cutover fence expectations.");
  const result = await client.query<{
    epoch: string; authority: string; authority_revision: string; configuration_run_id: string | null;
  }>(
    `SELECT epoch::text, authority, authority_revision::text, configuration_run_id::text
     FROM inventory.acquire_cutover_admission_fence($1::text, $2::bigint)`,
    [parsed.data.expectedAuthority, parsed.data.expectedConfigurationRunId],
  );
  const row = result.rows[0];
  const receipt = inventoryCutoverFenceReceiptSchema.safeParse(row && {
    epoch: row.epoch, authority: row.authority, authorityRevision: row.authority_revision,
    configurationRunId: row.configuration_run_id,
  });
  if (result.rows.length !== 1 || !receipt.success
    || receipt.data.authority !== parsed.data.expectedAuthority
    || receipt.data.configurationRunId !== parsed.data.expectedConfigurationRunId) {
    throw new InventoryCutoverAdmissionFenceError(
      "INVENTORY_CUTOVER_FENCE_RECEIPT_INVALID", "The database returned invalid cutover fence evidence.");
  }
  return Object.freeze(receipt.data);
}

/** Database-backed exception to snapshot capture's ordinary RR/SERIALIZABLE requirement. */
export async function assertInventoryCutoverFenceHeldInsideTransaction(client: InventoryAvailabilityTransactionQueryClient): Promise<string> {
  const result = await client.query<{ epoch: string }>(
    "SELECT inventory.assert_cutover_admission_fence_owner()::text AS epoch",
  );
  const epoch = result.rows[0]?.epoch;
  if (result.rows.length !== 1 || typeof epoch !== "string" || !/^[1-9][0-9]*$/.test(epoch)) {
    throw new InventoryCutoverAdmissionFenceError(
      "INVENTORY_CUTOVER_FENCE_RECEIPT_INVALID", "The database returned invalid exclusive fence evidence.");
  }
  return epoch;
}
