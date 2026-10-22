import { sql, type SQL } from "drizzle-orm";

/**
 * Whether a Dropship store stock destination is ready to publish from its supply,
 * as one SQL boolean, for a read-only query that names
 * `inventory.inventory_publication_targets` as `t`. It is the Dropship branch of
 * readTargets' `source_ready` (publication-mapping-preparation.repository.ts): a
 * sealed active supply binding with members, every member's fulfillment node
 * present and active, and an active policy channel. The Walmart checks there apply
 * only to channel destinations, so they are not part of it.
 *
 * It lives in inventory-planning because this module owns the supply binding and
 * fulfillment node definitions it reads; other modules must not read
 * warehouse.fulfillment_nodes themselves (inventory-availability-foundation
 * migration contract test). OMS operations health embeds this fragment
 * (oms/dropship-stock-destination-health.ts) instead of keeping its own copy.
 * Dependency-free on purpose (drizzle `sql` only), so a read-only caller does not
 * load the publication runtime or its database pool.
 */
export function dropshipStockDestinationSourceReadySql(): SQL {
  return sql`(EXISTS (SELECT 1 FROM inventory.publication_source_binding_heads h
            JOIN inventory.publication_source_binding_versions b ON b.id = h.active_binding_id AND b.lifecycle_status = 'sealed'
            JOIN inventory.publication_source_binding_members m ON m.binding_id = b.id
            WHERE h.publication_target_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM inventory.publication_source_binding_heads h
            JOIN inventory.publication_source_binding_versions b ON b.id = h.active_binding_id
            JOIN inventory.publication_source_binding_members m ON m.binding_id = b.id
            LEFT JOIN warehouse.fulfillment_nodes n ON n.id = m.fulfillment_node_id
            WHERE h.publication_target_id = t.id AND (n.id IS NULL OR n.lifecycle_status <> 'active'))
          AND EXISTS (SELECT 1 FROM channels.channels c WHERE c.id = t.channel_id AND c.status = 'active')) IS TRUE`;
}
