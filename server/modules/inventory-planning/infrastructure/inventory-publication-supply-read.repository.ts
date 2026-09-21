import type { Pool } from "pg";
import { z } from "zod";
import type { InventoryPublicationSupplyReader, InventoryPublicationSupplyScope, InventoryPublicationSourceWarehouse } from "../application/inventory-publication-supply-read.port";

const id = z.number().int().positive().max(2_147_483_647);
const scopeSchema = z.object({ channelId: id, channelConnectionId: id, providerScopeType: z.literal("location"), externalScopeId: z.string().trim().min(1).max(200) });
const sourceSchema = z.object({ warehouse_id: id.nullable(), lifecycle_status: z.string().nullable() });

export class PostgresInventoryPublicationSupplyReader implements InventoryPublicationSupplyReader {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async getSourceWarehouses(scope: InventoryPublicationSupplyScope): Promise<ReadonlyArray<InventoryPublicationSourceWarehouse>> {
    const input = scopeSchema.parse(scope);
    const client = await this.pool.connect();
    try {
      // Do not filter inactive/missing nodes out: a partly invalid binding must
      // remain visible to the caller and cannot look like a valid smaller set.
      const result = await client.query(`SELECT DISTINCT node.warehouse_id,node.lifecycle_status
        FROM inventory.inventory_publication_targets target
        JOIN inventory.publication_source_binding_heads head ON head.publication_target_id=target.id
        JOIN inventory.publication_source_binding_versions binding ON binding.id=head.active_binding_id
          AND binding.publication_target_id=target.id AND binding.lifecycle_status='sealed'
        JOIN inventory.publication_source_binding_members member ON member.binding_id=binding.id AND member.publication_target_id=target.id
        LEFT JOIN warehouse.fulfillment_nodes node ON node.id=member.fulfillment_node_id
        WHERE target.destination_kind='channel_connection' AND target.channel_id=$1 AND target.channel_connection_id=$2
          AND target.provider_scope_type=$3 AND target.external_scope_id=$4`,
      [input.channelId, input.channelConnectionId, input.providerScopeType, input.externalScopeId]);
      return result.rows.map(value => {
        const row = sourceSchema.parse(value);
        return { warehouseId: row.warehouse_id, isActive: row.lifecycle_status === "active" };
      });
    } finally { client.release(); }
  }
}
