import type { InventoryAvailabilityTransactionQueryClient } from "../../inventory-planning/application/inventory-availability-transaction-query.port";
import type { WarehouseSourceActivationEvidence } from "@shared/types/warehouse-source-activation";
import { warehouseSourceActivationEvidenceSchema } from "@shared/types/warehouse-source-activation";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";
import { validateWarehouseSourceActivation } from "../domain/warehouse-source-activation";
import { WarehouseInventorySourceError } from "../domain/warehouse-inventory-source";

const nodeIdsSchema = z.array(z.number().int().positive().max(2_147_483_647)).max(10_000)
  .refine(values => values.every((value, index) => index === 0 || value > values[index - 1]), "Source IDs must be unique and sorted.");

export async function readWarehouseSourceActivationEvidence(
  client: InventoryAvailabilityTransactionQueryClient, input: readonly number[], lock = false,
): Promise<WarehouseSourceActivationEvidence[]> {
  const ids = nodeIdsSchema.parse(input);
  if (ids.length === 0) return [];
  // All callers use the global cutover fence before writes; node order is stable.
  const rows = (await client.query(`SELECT node.id AS "nodeId",node.warehouse_id AS "warehouseId",
    node.node_type AS "nodeType",node.inventory_authority AS "inventoryAuthority",node.fulfillment_authority AS "fulfillmentAuthority",
    node.provider_account_id AS "providerAccountId",node.provider_location_id AS "providerLocationId",
    node.lifecycle_status AS "lifecycleStatus",warehouse.is_active AS "warehouseActive"
    FROM warehouse.fulfillment_nodes node JOIN warehouse.warehouses warehouse ON warehouse.id=node.warehouse_id
    WHERE node.id=ANY($1::integer[]) ORDER BY node.id ${lock ? "FOR UPDATE OF node FOR SHARE OF warehouse" : ""}`, [ids])).rows;
  const evidence = rows.map(row => warehouseSourceActivationEvidenceSchema.parse(row));
  if (canonicalJson(evidence.map(row => row.nodeId)) !== canonicalJson(ids)) {
    throw new WarehouseInventorySourceError(409, "WAREHOUSE_SOURCE_ACTIVATION_MISSING", "Every selected warehouse source must still exist.");
  }
  return evidence;
}

/** Caller owns transaction and immutable cutover receipt. No provider/configuration
 * identity is rewritten; a later cutover failure rolls this transition back too. */
export async function activateReviewedWarehouseSourcesInsideTransaction(
  client: InventoryAvailabilityTransactionQueryClient,
  input: readonly WarehouseSourceActivationEvidence[],
  rawAudit: { actor: string; occurredAt: Date },
): Promise<number[]> {
  const audit = z.object({ actor: z.string().trim().min(1).max(100), occurredAt: z.date() }).strict().parse(rawAudit);
  const expected = input.map(validateWarehouseSourceActivation);
  await client.query("SELECT inventory.assert_cutover_admission_fence_owner()");
  const current = await readWarehouseSourceActivationEvidence(client, expected.map(row => row.nodeId), true);
  if (canonicalJson(current) !== canonicalJson(expected)) throw new WarehouseInventorySourceError(409,
    "WAREHOUSE_SOURCE_ACTIVATION_CHANGED", "Warehouse source identity or lifecycle changed after the cutover review.");
  const drafts = current.filter(row => row.lifecycleStatus === "draft").map(row => row.nodeId);
  if (drafts.length === 0) return [];
  const result = await client.query(`UPDATE warehouse.fulfillment_nodes SET lifecycle_status='active',
    activated_by=$2,activated_at=$3,updated_at=$3 WHERE id=ANY($1::integer[]) AND lifecycle_status='draft'`,
  [drafts, audit.actor, audit.occurredAt.toISOString()]);
  if (result.rowCount !== drafts.length) throw new WarehouseInventorySourceError(409,
    "WAREHOUSE_SOURCE_ACTIVATION_CHANGED", "Not every reviewed draft source could be activated.");
  return drafts;
}
