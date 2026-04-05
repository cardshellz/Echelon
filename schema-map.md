# Comprehensive Echelon Database Schema Map

## `channels` Domain
> Target Namespace: `channels`

- `public.channels` → **MOVE TO** `channels.channels`
- `public.channel_connections` → **MOVE TO** `channels.channel_connections`
- `public.partner_profiles` → **MOVE TO** `channels.partner_profiles`
- `public.channel_feeds` → **MOVE TO** `channels.channel_feeds`
- `public.channel_reservations` → **MOVE TO** `channels.channel_reservations`
- `public.channel_product_allocation` → **MOVE TO** `channels.channel_product_allocation`
- `public.channel_sync_log` → **MOVE TO** `channels.channel_sync_log`
- `public.channel_product_lines` → **MOVE TO** `channels.channel_product_lines`
- `public.channel_product_overrides` → **MOVE TO** `channels.channel_product_overrides`
- `public.channel_pricing` → **MOVE TO** `channels.channel_pricing`
- `public.channel_listings` → **MOVE TO** `channels.channel_listings`
- `public.channel_variant_overrides` → **MOVE TO** `channels.channel_variant_overrides`
- `public.channel_asset_overrides` → **MOVE TO** `channels.channel_asset_overrides`
- `public.source_lock_config` → **MOVE TO** `channels.source_lock_config`
- `public.channel_warehouse_assignments` → **MOVE TO** `channels.channel_warehouse_assignments`
- `public.channel_allocation_rules` → **MOVE TO** `channels.channel_allocation_rules`
- `public.allocation_audit_log` → **MOVE TO** `channels.allocation_audit_log`
- `public.sync_settings` → **MOVE TO** `channels.sync_settings`
- `public.sync_log` → **MOVE TO** `channels.sync_log`

## `ebay` Domain
> Target Namespace: `ebay`

- `public.ebay_oauth_tokens` → **MOVE TO** `ebay.ebay_oauth_tokens`
- `public.ebay_listing_rules` → **MOVE TO** `ebay.ebay_listing_rules`
- `public.ebay_category_mappings` → **MOVE TO** `ebay.ebay_category_mappings`

## `identity` Domain
> Target Namespace: `identity`

- `public.users` → **MOVE TO** `identity.users`
- `public.user_audit` → **MOVE TO** `identity.user_audit`
- `public.auth_roles` → **MOVE TO** `identity.auth_roles`
- `public.auth_permissions` → **MOVE TO** `identity.auth_permissions`
- `public.auth_role_permissions` → **MOVE TO** `identity.auth_role_permissions`
- `public.auth_user_roles` → **MOVE TO** `identity.auth_user_roles`

## `inventory` Domain
> Target Namespace: `inventory`

- `public.inventory_levels` → **MOVE TO** `inventory.inventory_levels`
- `public.adjustment_reasons` → **MOVE TO** `inventory.adjustment_reasons`
- `public.cycle_counts` → **MOVE TO** `inventory.cycle_counts`
- `public.inventory_transactions` → **MOVE TO** `inventory.inventory_transactions`
- `public.warehouse_settings` → **MOVE TO** `inventory.warehouse_settings`
- `public.replen_tier_defaults` → **MOVE TO** `inventory.replen_tier_defaults`
- `public.replen_rules` → **MOVE TO** `inventory.replen_rules`
- `public.location_replen_config` → **MOVE TO** `inventory.location_replen_config`
- `public.replen_tasks` → **MOVE TO** `inventory.replen_tasks`
- `public.cycle_count_items` → **MOVE TO** `inventory.cycle_count_items`
- `public.inventory_lots` → **MOVE TO** `inventory.inventory_lots`

## `notifications` Domain
> Target Namespace: `notifications`

- `public.notification_types` → **MOVE TO** `notifications.notification_types`
- `public.notification_preferences` → **MOVE TO** `notifications.notification_preferences`
- `public.notifications` → **MOVE TO** `notifications.notifications`

## `orders` Domain
> Target Namespace: `orders`

- `public.combined_order_groups` → **MOVE TO** `orders.combined_order_groups`

## `procurement` Domain
> Target Namespace: `procurement`

- `public.vendors` → **MOVE TO** `procurement.vendors`
- `public.vendor_products` → **MOVE TO** `procurement.vendor_products`
- `public.po_approval_tiers` → **MOVE TO** `procurement.po_approval_tiers`
- `public.receiving_orders` → **MOVE TO** `procurement.receiving_orders`
- `public.receiving_lines` → **MOVE TO** `procurement.receiving_lines`
- `public.purchase_orders` → **MOVE TO** `procurement.purchase_orders`
- `public.purchase_order_lines` → **MOVE TO** `procurement.purchase_order_lines`
- `public.po_status_history` → **MOVE TO** `procurement.po_status_history`
- `public.po_revisions` → **MOVE TO** `procurement.po_revisions`
- `public.po_receipts` → **MOVE TO** `procurement.po_receipts`
- `public.inbound_shipments` → **MOVE TO** `procurement.inbound_shipments`
- `public.inbound_shipment_lines` → **MOVE TO** `procurement.inbound_shipment_lines`
- `public.vendor_invoices` → **MOVE TO** `procurement.vendor_invoices`
- `public.inbound_freight_costs` → **MOVE TO** `procurement.inbound_freight_costs`
- `public.inbound_freight_allocations` → **MOVE TO** `procurement.inbound_freight_allocations`
- `public.landed_cost_snapshots` → **MOVE TO** `procurement.landed_cost_snapshots`
- `public.inbound_shipment_status_history` → **MOVE TO** `procurement.inbound_shipment_status_history`
- `public.vendor_invoice_po_links` → **MOVE TO** `procurement.vendor_invoice_po_links`
- `public.vendor_invoice_lines` → **MOVE TO** `procurement.vendor_invoice_lines`
- `public.vendor_invoice_attachments` → **MOVE TO** `procurement.vendor_invoice_attachments`
- `public.ap_payments` → **MOVE TO** `procurement.ap_payments`
- `public.ap_payment_allocations` → **MOVE TO** `procurement.ap_payment_allocations`

## `warehouse` Domain
> Target Namespace: `warehouse`

- `public.warehouse_zones` → **MOVE TO** `warehouse.warehouse_zones`
- `public.warehouses` → **MOVE TO** `warehouse.warehouses`
- `public.warehouse_locations` → **MOVE TO** `warehouse.warehouse_locations`
- `public.product_locations` → **MOVE TO** `warehouse.product_locations`
- `public.echelon_settings` → **MOVE TO** `warehouse.echelon_settings`
- `public.app_settings` → **MOVE TO** `warehouse.app_settings`

