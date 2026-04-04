# 100% Exhaustive Echelon `public` Schema Map

| Legacy Table (`public.*`) | Target Domain | Status / Notes |
|---------------------------|---------------|----------------|
| `__cardshellz_manual_migrations` | **SYSTEM** | System Admin / Skip |
| `__drizzle_migrations` | **SYSTEM** | System Admin / Skip |
| `_migrations` | **SYSTEM** | System Admin / Skip |
| `access_rules` | **UNKNOWN / ORPHANED** | Pending Migration |
| `adjustment_reasons` | **INVENTORY** | Pending Migration |
| `admin_sessions` | **UNKNOWN / ORPHANED** | Pending Migration |
| `allocation_audit_log` | **CHANNELS** | Pending Migration |
| `ap_payment_allocations` | **PROCUREMENT** | Pending Migration |
| `ap_payments` | **PROCUREMENT** | Pending Migration |
| `app_settings` | **WAREHOUSE** | Pending Migration |
| `auth_permissions` | **IDENTITY** | Pending Migration |
| `auth_role_permissions` | **IDENTITY** | Pending Migration |
| `auth_roles` | **IDENTITY** | Pending Migration |
| `auth_user_roles` | **IDENTITY** | Pending Migration |
| `back_in_stock_sends` | **UNKNOWN / ORPHANED** | Pending Migration |
| `back_in_stock_subscriptions` | **UNKNOWN / ORPHANED** | Pending Migration |
| `blockchain_config` | **UNKNOWN / ORPHANED** | Pending Migration |
| `channel_allocation_rules` | **CHANNELS** | Pending Migration |
| `channel_asset_overrides` | **CHANNELS** | Pending Migration |
| `channel_connections` | **CHANNELS** | Pending Migration |
| `channel_feeds` | **CHANNELS** | Pending Migration |
| `channel_listings` | **CHANNELS** | Pending Migration |
| `channel_pricing` | **CHANNELS** | Pending Migration |
| `channel_pricing_rules` | **UNKNOWN / ORPHANED** | Pending Migration |
| `channel_product_allocation` | **CHANNELS** | Pending Migration |
| `channel_product_lines` | **CHANNELS** | Pending Migration |
| `channel_product_overrides` | **CHANNELS** | Pending Migration |
| `channel_reservations` | **CHANNELS** | Pending Migration |
| `channel_sync_log` | **CHANNELS** | Pending Migration |
| `channel_variant_overrides` | **CHANNELS** | Pending Migration |
| `channel_warehouse_assignments` | **CHANNELS** | Pending Migration |
| `channels` | **CHANNELS** | Pending Migration |
| `collection_alert_notification_queue` | **UNKNOWN / ORPHANED** | Pending Migration |
| `collection_alert_settings` | **UNKNOWN / ORPHANED** | Pending Migration |
| `collection_alert_subscriptions` | **UNKNOWN / ORPHANED** | Pending Migration |
| `combined_order_groups` | **ORDERS** | Pending Migration |
| `cost_adjustment_log` | **UNKNOWN / ORPHANED** | Pending Migration |
| `cycle_count_items` | **INVENTORY** | Pending Migration |
| `cycle_counts` | **INVENTORY** | Pending Migration |
| `discounts` | **UNKNOWN / ORPHANED** | Pending Migration |
| `dropship_vendor_products` | **UNKNOWN / ORPHANED** | Pending Migration |
| `dropship_vendors` | **UNKNOWN / ORPHANED** | Pending Migration |
| `dropship_wallet_ledger` | **UNKNOWN / ORPHANED** | Pending Migration |
| `earning_activities` | **UNKNOWN / ORPHANED** | Pending Migration |
| `ebay_category_aspects` | **UNKNOWN / ORPHANED** | Pending Migration |
| `ebay_category_mappings` | **EBAY** | Pending Migration |
| `ebay_listing_rules` | **EBAY** | Pending Migration |
| `ebay_oauth_tokens` | **EBAY** | Pending Migration |
| `ebay_product_aspect_overrides` | **UNKNOWN / ORPHANED** | Pending Migration |
| `ebay_type_aspect_defaults` | **UNKNOWN / ORPHANED** | Pending Migration |
| `echelon_settings` | **WAREHOUSE** | Pending Migration |
| `inbound_freight_allocations` | **PROCUREMENT** | Pending Migration |
| `inbound_freight_costs` | **PROCUREMENT** | Pending Migration |
| `inbound_shipment_lines` | **PROCUREMENT** | Pending Migration |
| `inbound_shipment_status_history` | **PROCUREMENT** | Pending Migration |
| `inbound_shipments` | **PROCUREMENT** | Pending Migration |
| `inventory_levels` | **INVENTORY** | Pending Migration |
| `inventory_lots` | **INVENTORY** | Pending Migration |
| `inventory_transactions` | **INVENTORY** | Pending Migration |
| `landed_cost_snapshots` | **PROCUREMENT** | Pending Migration |
| `location_replen_config` | **INVENTORY** | Pending Migration |
| `marketplace_exclusions` | **UNKNOWN / ORPHANED** | Pending Migration |
| `medal_benefit_grants` | **UNKNOWN / ORPHANED** | Pending Migration |
| `member_current_membership` | **UNKNOWN / ORPHANED** | Pending Migration |
| `member_earning_events` | **UNKNOWN / ORPHANED** | Pending Migration |
| `member_medal_achievements` | **UNKNOWN / ORPHANED** | Pending Migration |
| `member_referrals` | **UNKNOWN / ORPHANED** | Pending Migration |
| `member_shopify_customer_ids` | **UNKNOWN / ORPHANED** | Pending Migration |
| `member_stats` | **UNKNOWN / ORPHANED** | Pending Migration |
| `notification_preferences` | **NOTIFICATIONS** | Pending Migration |
| `notification_templates` | **UNKNOWN / ORPHANED** | Pending Migration |
| `notification_types` | **NOTIFICATIONS** | Pending Migration |
| `notifications` | **NOTIFICATIONS** | Pending Migration |
| `order_item_plan_savings_snapshots` | **UNKNOWN / ORPHANED** | Pending Migration |
| `order_line_costs` | **UNKNOWN / ORPHANED** | Pending Migration |
| `partner_profiles` | **CHANNELS** | Pending Migration |
| `pg_stat_statements` | **UNKNOWN / ORPHANED** | Pending Migration |
| `pg_stat_statements_info` | **UNKNOWN / ORPHANED** | Pending Migration |
| `plan_collection_exclusions` | **UNKNOWN / ORPHANED** | Pending Migration |
| `plan_earning_rules` | **UNKNOWN / ORPHANED** | Pending Migration |
| `plan_feature_grants` | **UNKNOWN / ORPHANED** | Pending Migration |
| `plan_features` | **UNKNOWN / ORPHANED** | Pending Migration |
| `plan_medal_benefits` | **UNKNOWN / ORPHANED** | Pending Migration |
| `plan_redemption_rules` | **UNKNOWN / ORPHANED** | Pending Migration |
| `plan_variant_overrides` | **UNKNOWN / ORPHANED** | Pending Migration |
| `po_approval_tiers` | **PROCUREMENT** | Pending Migration |
| `po_receipts` | **PROCUREMENT** | Pending Migration |
| `po_revisions` | **PROCUREMENT** | Pending Migration |
| `po_status_history` | **PROCUREMENT** | Pending Migration |
| `portal_config` | **UNKNOWN / ORPHANED** | Pending Migration |
| `pricing_rules` | **UNKNOWN / ORPHANED** | Pending Migration |
| `product_collections` | **UNKNOWN / ORPHANED** | Pending Migration |
| `product_line_products` | **UNKNOWN / ORPHANED** | Pending Migration |
| `product_lines` | **UNKNOWN / ORPHANED** | Pending Migration |
| `product_locations` | **WAREHOUSE** | Pending Migration |
| `product_types` | **UNKNOWN / ORPHANED** | Pending Migration |
| `purchase_order_lines` | **PROCUREMENT** | Pending Migration |
| `purchase_orders` | **PROCUREMENT** | Pending Migration |
| `receiving_lines` | **PROCUREMENT** | Pending Migration |
| `receiving_orders` | **PROCUREMENT** | Pending Migration |
| `redemption_options` | **UNKNOWN / ORPHANED** | Pending Migration |
| `replen_rules` | **INVENTORY** | Pending Migration |
| `replen_tasks` | **INVENTORY** | Pending Migration |
| `replen_tier_defaults` | **INVENTORY** | Pending Migration |
| `reward_ledger` | **UNKNOWN / ORPHANED** | Pending Migration |
| `reward_medals` | **UNKNOWN / ORPHANED** | Pending Migration |
| `reward_overrides` | **UNKNOWN / ORPHANED** | Pending Migration |
| `reward_redemptions` | **UNKNOWN / ORPHANED** | Pending Migration |
| `sc_admin_users` | **UNKNOWN / ORPHANED** | Pending Migration |
| `sc_sessions` | **UNKNOWN / ORPHANED** | Pending Migration |
| `selling_plan_groups` | **UNKNOWN / ORPHANED** | Pending Migration |
| `session` | **UNKNOWN / ORPHANED** | Pending Migration |
| `shopify_collections` | **UNKNOWN / ORPHANED** | Pending Migration |
| `shopify_order_items` | **UNKNOWN / ORPHANED** | Pending Migration |
| `shopify_orders` | **UNKNOWN / ORPHANED** | Pending Migration |
| `shopify_products` | **UNKNOWN / ORPHANED** | Pending Migration |
| `shopify_variants` | **UNKNOWN / ORPHANED** | Pending Migration |
| `social_accounts` | **UNKNOWN / ORPHANED** | Pending Migration |
| `social_action_verifications` | **UNKNOWN / ORPHANED** | Pending Migration |
| `social_verifications` | **UNKNOWN / ORPHANED** | Pending Migration |
| `source_lock_config` | **CHANNELS** | Pending Migration |
| `subscription_billing_attempts` | **UNKNOWN / ORPHANED** | Pending Migration |
| `subscription_contracts` | **UNKNOWN / ORPHANED** | Pending Migration |
| `subscription_events` | **UNKNOWN / ORPHANED** | Pending Migration |
| `subscription_ledger` | **UNKNOWN / ORPHANED** | Pending Migration |
| `sync_log` | **CHANNELS** | Pending Migration |
| `sync_settings` | **CHANNELS** | Pending Migration |
| `token_transactions` | **UNKNOWN / ORPHANED** | Pending Migration |
| `user_audit` | **IDENTITY** | Pending Migration |
| `users` | **IDENTITY** | Pending Migration |
| `vendor_invoice_attachments` | **PROCUREMENT** | Pending Migration |
| `vendor_invoice_lines` | **PROCUREMENT** | Pending Migration |
| `vendor_invoice_po_links` | **PROCUREMENT** | Pending Migration |
| `vendor_invoices` | **PROCUREMENT** | Pending Migration |
| `vendor_products` | **PROCUREMENT** | Pending Migration |
| `vendors` | **PROCUREMENT** | Pending Migration |
| `warehouse_locations` | **WAREHOUSE** | Pending Migration |
| `warehouse_settings` | **INVENTORY** | Pending Migration |
| `warehouse_zones` | **WAREHOUSE** | Pending Migration |
| `warehouses` | **WAREHOUSE** | Pending Migration |
