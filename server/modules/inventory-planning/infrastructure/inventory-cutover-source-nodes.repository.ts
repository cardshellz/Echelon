import { inventoryCutoverManifestSchema, type InventoryCutoverManifest } from "@shared/types/inventory-cutover-commit";
import type { InventoryAvailabilityTransactionQueryClient } from "../application/inventory-availability-transaction-query.port";
import { readWarehouseSourceActivationEvidence } from "../../warehouse/infrastructure/warehouse-source-activation.repository";
import { validateWarehouseSourceActivation } from "../../warehouse/domain/warehouse-source-activation";

/** Capture only warehouse sources reachable from the reviewed Echelon-owned
 * binding/policy definitions. External observe-only destinations have neither. */
export async function captureCutoverSourceNodes(
  client: InventoryAvailabilityTransactionQueryClient, input: InventoryCutoverManifest,
): Promise<InventoryCutoverManifest> {
  const manifest = inventoryCutoverManifestSchema.parse(input);
  const bindings = manifest.selections.filter(row => row.kind === "source_binding").map(row => row.definitionId);
  const policies = manifest.selections.filter(row => row.kind === "channel_policy").map(row => row.definitionId);
  if (bindings.length === 0 && policies.length === 0) return { ...manifest, sourceNodes: [] };
  const rows = (await client.query<{ node_id: number }>(`SELECT DISTINCT node_id FROM (
    SELECT fulfillment_node_id AS node_id FROM inventory.publication_source_binding_members WHERE binding_id=ANY($1::integer[])
    UNION ALL
    SELECT unnest(source_fulfillment_node_ids) AS node_id FROM inventory.channel_exposure_policy_versions
      WHERE id=ANY($2::integer[]) AND inherit_all=false
    ) selected WHERE node_id IS NOT NULL ORDER BY node_id`, [bindings, policies])).rows;
  const sourceNodes = (await readWarehouseSourceActivationEvidence(client, rows.map(row => row.node_id)))
    .map(validateWarehouseSourceActivation);
  return inventoryCutoverManifestSchema.parse({ ...manifest, sourceNodes });
}
