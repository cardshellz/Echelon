import { z } from "zod";
import type { InventoryAvailabilityTransactionQueryClient } from "../inventory-planning/application/inventory-availability-transaction-query.port";

const id = z.number().int().positive().max(2_147_483_647);
const assignmentSchema = z.object({ channel_id: id, warehouse_id: id });
const authoritySchema = z.object({
  authority: z.enum(["legacy", "canonical"]),
  revision: z.string().regex(/^[1-9][0-9]*$/),
  activation_run_id: z.string().regex(/^[1-9][0-9]*$/).nullable(),
}).refine(row => (row.authority === "canonical") === (row.activation_run_id !== null));

export interface ChannelFulfillmentWarehouse {
  channelId: number;
  warehouseId: number;
  enabled: true;
}

/**
 * Operational warehouse eligibility, not an ATP calculation or an order router.
 * Canonical channel sources come from active, sealed source bindings, never a
 * draft source binding or the retired allocation table. Pausing publication does not invalidate
 * an already accepted order's warehouse. Walmart's explicit fulfillment routing
 * is owned by its connection; its positive ATP publication has a separate exact
 * source-binding check in WalmartAdapter. Externally managed 3PL destinations
 * retain their explicitly configured warehouse, even when their inventory node
 * is not activated in Echelon. This read neither activates that node nor grants
 * permission to publish stock or execute external fulfillment.
 *
 * Supply a transaction client for command validation. lock=true pins authority
 * and existing source heads until that command commits; overview callers use
 * their repeatable-read, read-only snapshot instead.
 */
export async function readChannelFulfillmentWarehouses(
  client: InventoryAvailabilityTransactionQueryClient,
  options: { channelId?: number; lock?: boolean } = {},
): Promise<ChannelFulfillmentWarehouse[]> {
  const channelId = options.channelId === undefined ? null : id.parse(options.channelId);
  const authorityRows = await client.query(`SELECT authority, revision::text AS revision,
    activation_run_id::text AS activation_run_id
    FROM inventory.availability_runtime_authority WHERE singleton_key=true${options.lock ? " FOR SHARE" : ""}`);
  const authority = z.array(authoritySchema).length(1).parse(authorityRows.rows)[0];
  let rows: unknown[];
  if (authority.authority === "legacy") {
    rows = (await client.query(`SELECT channel_id,warehouse_id
      FROM channels.channel_warehouse_assignments
      WHERE enabled=true AND ($1::integer IS NULL OR channel_id=$1)
      ORDER BY channel_id,warehouse_id${options.lock ? " FOR SHARE" : ""}`, [channelId])).rows;
  } else {
    if (options.lock) {
      await client.query(`SELECT id FROM inventory.inventory_publication_targets
        WHERE ($1::integer IS NULL OR channel_id=$1) ORDER BY id FOR SHARE`, [channelId]);
      await client.query(`SELECT head.publication_target_id
        FROM inventory.publication_source_binding_heads head
        JOIN inventory.inventory_publication_targets target ON target.id=head.publication_target_id
        WHERE ($1::integer IS NULL OR target.channel_id=$1)
        ORDER BY head.publication_target_id FOR SHARE OF head`, [channelId]);
    }
    rows = (await client.query(`SELECT DISTINCT target.channel_id,node.warehouse_id
      FROM inventory.inventory_publication_targets target
      JOIN channels.channels channel ON channel.id=target.channel_id AND channel.provider <> 'walmart'
      JOIN inventory.publication_source_binding_heads head ON head.publication_target_id=target.id
      JOIN inventory.publication_source_binding_versions binding ON binding.id=head.active_binding_id
        AND binding.publication_target_id=target.id AND binding.lifecycle_status='sealed'
      JOIN inventory.publication_source_binding_members member ON member.binding_id=binding.id
        AND member.publication_target_id=target.id
      JOIN warehouse.fulfillment_nodes node ON node.id=member.fulfillment_node_id AND node.lifecycle_status='active'
      JOIN warehouse.warehouses warehouse ON warehouse.id=node.warehouse_id AND warehouse.is_active=1
        AND warehouse.warehouse_type IN ('operations','3pl')
      WHERE ($1::integer IS NULL OR target.channel_id=$1)
      UNION
      SELECT target.channel_id,node.warehouse_id
      FROM inventory.inventory_publication_targets target
      JOIN channels.channels channel ON channel.id=target.channel_id AND channel.provider <> 'walmart'
      JOIN warehouse.fulfillment_nodes node ON node.id=target.fulfillment_node_id
        AND node.fulfillment_authority='external_provider' AND node.lifecycle_status IN ('draft','active')
      JOIN warehouse.warehouses warehouse ON warehouse.id=node.warehouse_id
        AND warehouse.is_active=1 AND warehouse.warehouse_type='3pl'
      WHERE target.publication_authority='external_provider'
        AND ($1::integer IS NULL OR target.channel_id=$1)
      UNION
      SELECT connection.channel_id,connection.warehouse_id
      FROM channels.walmart_connections connection
      JOIN channels.channels channel ON channel.id=connection.channel_id AND channel.provider='walmart'
      JOIN warehouse.warehouses warehouse ON warehouse.id=connection.warehouse_id
        AND warehouse.is_active=1 AND warehouse.warehouse_type <> '3pl'
      WHERE ($1::integer IS NULL OR connection.channel_id=$1)
      ORDER BY channel_id,warehouse_id`, [channelId])).rows;
  }
  return rows.map(value => {
    const row = assignmentSchema.parse(value);
    return { channelId: row.channel_id, warehouseId: row.warehouse_id, enabled: true };
  });
}
