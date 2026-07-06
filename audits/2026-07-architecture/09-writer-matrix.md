# Echelon — Global Writer-Topology Matrix (Audit 09)

Date: 2026-07-02. Scope: all DB write sites in `server/` (excluding `__tests__`, `*.test.ts`, `*.spec.ts`), resolved against the 207 drizzle table definitions in `shared/schema/*.ts` (205 `pgTable`/`schema.table` definitions + 2 alias exports `wmsOrders = orders`, `wmsOrderItems = orderItems` at `shared/schema/orders.schema.ts:240,245`).

**Evidence base (mechanical sweep, verifiable):**
- Drizzle writes: every `.insert(`, `.update(`, `.delete(` call whose argument resolves (directly, via import alias, or via schema alias export) to a table identifier — 573 sites.
- Raw SQL writes: every `INSERT INTO` / `UPDATE … SET` / `DELETE FROM` / `TRUNCATE` inside `sql\`\`` templates and `client.query()` strings — 403 sites (2 prose false positives excluded, noted in §6).
- Attribution: each site is attributed to `modules/<name>` or its top-level location (`server/routes/`, `server/routes.ts`, `server/jobs`, `server/index`, `server/db`, `server/scripts`, `server/seed`, `server/infrastructure`, `server/storage`, `server/services`).

**Headline numbers:**
- 207 schema-defined tables + 4 raw-SQL-only tables found in write paths (`inventory.cost_adjustment_log`, `membership.shopify_metafield_outbox`, `public.shopify_orders`, `public.shopify_order_items`) = 211 total tables in scope.
- 160 tables have at least one writer in `server/`; 49 schema tables have **zero** server-side writers (mostly `membership.*` rewards/club tables — written from elsewhere or dormant).
- **41 tables are multi-writer** (written by >1 module).
- 83 write sites live in controller-layer files (`*.routes.ts`, `server/routes/`) — §3.
- `server/index.ts` alone contains 20 raw-SQL writes to order/shipment state (startup repair + recurring reconcilers) — §5.

---

## 1. FULL MATRIX

Every table with ≥1 writer, then zero-writer tables. "Representative refs" = first site per module; `(+n)` = n more sites in that module (full lists for multi-writer tables are in §2; complete site-level JSON in `matrix.json` alongside this report).

| schema.table | writing modules | representative refs (first site per module, +n more) | single-writer? |
|---|---|---|---|
| catalog.product_assets | modules/catalog, modules/channels, server/routes/ | modules/catalog: `server/modules/catalog/catalog.routes.ts:1084` (+18)<br>modules/channels: `server/modules/channels/catalog-backfill.service.ts:725`<br>server/routes/: `server/routes/ebay/ebay-policies.routes.ts:288` | **N** |
| catalog.product_categories | modules/catalog | modules/catalog: `server/modules/catalog/catalog.routes.ts:618` (+2) | Y |
| catalog.product_line_products | modules/channels, server/db | modules/channels: `server/modules/channels/channels.storage.ts:478` (+6)<br>server/db: `server/db.ts:284` | **N** |
| catalog.product_lines | modules/channels, server/db | modules/channels: `server/modules/channels/channels.storage.ts:458` (+1)<br>server/db: `server/db.ts:278` | **N** |
| catalog.product_types | server/db | server/db: `server/db.ts:407` | Y |
| catalog.product_variants | modules/catalog, modules/channels, modules/inventory, server/routes/ | modules/catalog: `server/modules/catalog/catalog.routes.ts:1724` (+3)<br>modules/channels: `server/modules/channels/catalog-backfill.service.ts:514` (+1)<br>modules/inventory: `server/modules/inventory/lots.service.ts:811` (+1)<br>server/routes/: `server/routes/ebay/ebay-listing-state.ts:86` (+1) | **N** |
| catalog.products | modules/catalog, modules/channels, modules/procurement, server/routes/ | modules/catalog: `server/modules/catalog/catalog.routes.ts:537` (+5)<br>modules/channels: `server/modules/channels/catalog-backfill.service.ts:364` (+2)<br>modules/procurement: `server/modules/procurement/procurement.storage.ts:1880`<br>server/routes/: `server/routes/ebay/ebay-listing-state.ts:52` (+4) | **N** |
| catalog.shipping_groups | modules/catalog | modules/catalog: `server/modules/catalog/catalog.routes.ts:562` (+1) | Y |
| channels.allocation_audit_log | modules/channels | modules/channels: `server/modules/channels/allocation-engine.service.ts:768` | Y |
| channels.channel_allocation_rules | modules/channels | modules/channels: `server/modules/channels/channels.routes.ts:2429` (+2) | Y |
| channels.channel_asset_overrides | modules/channels | modules/channels: `server/modules/channels/channel-catalog.storage.ts:261` (+1) | Y |
| channels.channel_connections | modules/channels, modules/dropship, server/routes/ | modules/channels: `server/modules/channels/channels.storage.ts:185` (+2)<br>modules/dropship: `server/modules/dropship/infrastructure/dropship-oms-channel-config.repository.ts:321`<br>server/routes/: `server/routes/ebay-settings.routes.ts:78` (+3) | **N** |
| channels.channel_feeds | modules/catalog, modules/channels, modules/inventory | modules/catalog: `server/modules/catalog/catalog.routes.ts:1730` (+2)<br>modules/channels: `server/modules/channels/catalog-backfill.service.ts:584` (+7)<br>modules/inventory: `server/modules/inventory/infrastructure/inventory.repository.ts:621` (+2) | **N** |
| channels.channel_listings | modules/catalog, modules/channels, server/routes/ | modules/catalog: `server/modules/catalog/catalog.routes.ts:1765` (+3)<br>modules/channels: `server/modules/channels/catalog-backfill.service.ts:619` (+6)<br>server/routes/: `server/routes/ebay/ebay-policies.routes.ts:378` (+10) | **N** |
| channels.channel_pricing | modules/channels | modules/channels: `server/modules/channels/catalog-backfill.service.ts:665` (+3) | Y |
| channels.channel_pricing_rules | server/routes/ | server/routes/: `server/routes/ebay/ebay-pricing.routes.ts:94` (+3) | Y |
| channels.channel_product_allocation | modules/channels | modules/channels: `server/modules/channels/channels.storage.ts:359` (+2) | Y |
| channels.channel_product_lines | modules/channels, server/db | modules/channels: `server/modules/channels/channel-catalog.storage.ts:292` (+1)<br>server/db: `server/db.ts:291` | **N** |
| channels.channel_product_overrides | modules/channels, server/routes/ | modules/channels: `server/modules/channels/channel-catalog.storage.ts:75` (+1)<br>server/routes/: `server/routes/ebay/ebay-listing-state.ts:57` | **N** |
| channels.channel_reservations | modules/channels | modules/channels: `server/modules/channels/channels.storage.ts:258` (+2) | Y |
| channels.channel_sync_log | modules/channels | modules/channels: `server/modules/channels/echelon-sync-orchestrator.service.ts:1548` (+1) | Y |
| channels.channel_variant_overrides | modules/channels, server/routes/ | modules/channels: `server/modules/channels/channel-catalog.storage.ts:127` (+1)<br>server/routes/: `server/routes/ebay/ebay-listing-state.ts:91` | **N** |
| channels.channel_warehouse_assignments | modules/channels | modules/channels: `server/modules/channels/channels.routes.ts:2237` (+2) | Y |
| channels.channels | modules/channels, modules/dropship, modules/identity, server/routes/ | modules/channels: `server/modules/channels/channels.storage.ts:160` (+4)<br>modules/dropship: `server/modules/dropship/infrastructure/dropship-oms-channel-config.repository.ts:260` (+3)<br>modules/identity: `server/modules/identity/infrastructure/identity.repository.ts:155`<br>server/routes/: `server/routes/ebay-oauth.routes.ts:109` (+2) | **N** |
| channels.partner_profiles | modules/channels | modules/channels: `server/modules/channels/channels.storage.ts:214` (+1) | Y |
| channels.source_lock_config | modules/channels | modules/channels: `server/modules/channels/source-lock.service.ts:179` (+2) | Y |
| channels.sync_log | modules/channels | modules/channels: `server/modules/channels/sync-settings.service.ts:184` (+2) | Y |
| channels.sync_settings | modules/channels, server/db | modules/channels: `server/modules/channels/sync-settings.service.ts:70` (+2)<br>server/db: `server/db.ts:580` | **N** |
| dropship.dropship_admin_config_commands | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-oms-channel-config.repository.ts:418` (+5) | Y |
| dropship.dropship_audit_events | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-catalog-exposure.repository.ts:290` (+31) | Y |
| dropship.dropship_auth_identities | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-auth.repository.ts:95` (+3) | Y |
| dropship.dropship_auto_reload_settings | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-wallet.repository.ts:605` (+1) | Y |
| dropship.dropship_box_catalog | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-shipping-config.repository.ts:196` (+1) | Y |
| dropship.dropship_catalog_rule_set_revisions | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-catalog-exposure.repository.ts:110` | Y |
| dropship.dropship_catalog_rules | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-catalog-exposure.repository.ts:256` (+1) | Y |
| dropship.dropship_funding_methods | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-wallet.repository.ts:710` (+2) | Y |
| dropship.dropship_insurance_pool_config | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-shipping-config.repository.ts:536` | Y |
| dropship.dropship_listing_push_job_items | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-listing-preview.repository.ts:566` (+5) | Y |
| dropship.dropship_listing_push_jobs | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-listing-preview.repository.ts:438` (+4) | Y |
| dropship.dropship_listing_sync_events | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-listing-push-worker.repository.ts:659` | Y |
| dropship.dropship_marketplace_tracking_pushes | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-marketplace-tracking.repository.ts:368` (+5) | Y |
| dropship.dropship_notification_events | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-notification-ops.repository.ts:131` (+4) | Y |
| dropship.dropship_notification_preferences | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-notification.repository.ts:216` | Y |
| dropship.dropship_order_economics_snapshots | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:1015` | Y |
| dropship.dropship_order_intake | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:695` (+14) | Y |
| dropship.dropship_package_profiles | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-shipping-config.repository.ts:262` | Y |
| dropship.dropship_passkey_credentials | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-auth.repository.ts:311` (+1) | Y |
| dropship.dropship_rate_table_rows | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-shipping-config.repository.ts:428` | Y |
| dropship.dropship_rate_tables | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-shipping-config.repository.ts:409` | Y |
| dropship.dropship_return_policy_config | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-return.repository.ts:273` | Y |
| dropship.dropship_rma_inspections | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-return.repository.ts:861` | Y |
| dropship.dropship_rma_items | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-return.repository.ts:347` (+1) | Y |
| dropship.dropship_rma_status_updates | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-return.repository.ts:803` | Y |
| dropship.dropship_rmas | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-return.repository.ts:320` (+2) | Y |
| dropship.dropship_sensitive_action_challenges | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-auth.repository.ts:160` (+2) | Y |
| dropship.dropship_shipping_markup_config | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-shipping-config.repository.ts:478` | Y |
| dropship.dropship_shipping_quote_snapshots | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-shipping-quote.repository.ts:196` | Y |
| dropship.dropship_store_connection_tokens | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-marketplace-credentials.ts:439` (+6) | Y |
| dropship.dropship_store_connections | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-ebay-order-intake.repository.ts:45` (+9) | Y |
| dropship.dropship_store_listing_configs | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-listing-config.repository.ts:104` (+1) | Y |
| dropship.dropship_store_setup_checks | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-marketplace-credentials.ts:460` (+4) | Y |
| dropship.dropship_usdc_ledger_entries | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-wallet.repository.ts:1490` | Y |
| dropship.dropship_vendor_listings | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-listing-preview.repository.ts:519` (+3) | Y |
| dropship.dropship_vendor_selection_rule_set_revisions | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-selection-atp.repository.ts:186` | Y |
| dropship.dropship_vendor_selection_rules | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-selection-atp.repository.ts:358` (+1) | Y |
| dropship.dropship_vendors | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-vendor-provisioning.repository.ts:396` (+3) | Y |
| dropship.dropship_wallet_accounts | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:644` (+5) | Y |
| dropship.dropship_wallet_ledger | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:956` (+3) | Y |
| dropship.dropship_zone_rules | modules/dropship | modules/dropship: `server/modules/dropship/infrastructure/dropship-shipping-config.repository.ts:360` (+1) | Y |
| ebay.ebay_category_aspects | server/routes/ | server/routes/: `server/routes/ebay/ebay-taxonomy.routes.ts:311` (+1) | Y |
| ebay.ebay_category_mappings | server/routes/ | server/routes/: `server/routes/ebay/ebay-config.routes.ts:214` (+1) | Y |
| ebay.ebay_listing_rules | server/routes/ | server/routes/: `server/routes/ebay-listing-rules.routes.ts:253` (+2) | Y |
| ebay.ebay_oauth_tokens | modules/channels | modules/channels: `server/modules/channels/adapters/ebay/ebay-auth.service.ts:292` (+1) | Y |
| ebay.ebay_product_aspect_overrides | server/routes/ | server/routes/: `server/routes/ebay/ebay-taxonomy.routes.ts:470` (+1) | Y |
| ebay.ebay_type_aspect_defaults | server/routes/ | server/routes/: `server/routes/ebay/ebay-taxonomy.routes.ts:393` (+1) | Y |
| identity.auth_permissions | modules/identity | modules/identity: `server/modules/identity/application/identity.use-cases.ts:85` | Y |
| identity.auth_role_permissions | modules/identity | modules/identity: `server/modules/identity/application/identity.use-cases.ts:101` (+3) | Y |
| identity.auth_roles | modules/identity | modules/identity: `server/modules/identity/application/identity.use-cases.ts:94` (+2) | Y |
| identity.auth_user_roles | modules/identity | modules/identity: `server/modules/identity/application/identity.use-cases.ts:119` (+2) | Y |
| identity.users | modules/identity | modules/identity: `server/modules/identity/infrastructure/identity.repository.ts:21` (+2) | Y |
| inventory.adjustment_reasons | modules/identity, modules/inventory | modules/identity: `server/modules/identity/application/identity.use-cases.ts:133` (+1)<br>modules/inventory: `server/modules/inventory/infrastructure/inventory.repository.ts:582` (+1) | **N** |
| inventory.cost_adjustment_log | modules/inventory | modules/inventory: `server/modules/inventory/cogs.service.ts:313` (+2) | Y |
| inventory.cycle_count_items | modules/inventory | modules/inventory: `server/modules/inventory/application/replenishment.use-cases.ts:2925` (+7) | Y |
| inventory.cycle_counts | modules/inventory | modules/inventory: `server/modules/inventory/application/replenishment.use-cases.ts:2911` (+5) | Y |
| inventory.inventory_levels | modules/catalog, modules/channels, modules/dropship, modules/inventory, server/db, server/scripts | modules/catalog: `server/modules/catalog/catalog.storage.ts:238`<br>modules/channels: `server/modules/channels/catalog-backfill.service.ts:867`<br>modules/dropship: `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:866`<br>modules/inventory: `server/modules/inventory/application/break-assembly.use-cases.ts:612` (+11)<br>server/db: `server/db.ts:550`<br>server/scripts: `server/scripts/fix_orphaned_picks.ts:35` | **N** |
| inventory.inventory_lots | modules/inventory, modules/procurement, server/db | modules/inventory: `server/modules/inventory/cogs.service.ts:159` (+19)<br>modules/procurement: `server/modules/procurement/procurement.storage.ts:986` (+2)<br>server/db: `server/db.ts:802` (+2) | **N** |
| inventory.inventory_transactions | modules/channels, modules/dropship, modules/inventory, server/routes/, server/scripts | modules/channels: `server/modules/channels/catalog-backfill.service.ts:878` (+1)<br>modules/dropship: `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:873`<br>modules/inventory: `server/modules/inventory/application/break-assembly.use-cases.ts:639` (+3)<br>server/routes/: `server/routes/diagnostics.ts:29`<br>server/scripts: `server/scripts/fix_orphaned_picks.ts:43` | **N** |
| inventory.location_replen_config | modules/inventory | modules/inventory: `server/modules/inventory/infrastructure/replenishment.repository.ts:283` (+2) | Y |
| inventory.replen_rules | modules/catalog, modules/inventory | modules/catalog: `server/modules/catalog/catalog.storage.ts:256`<br>modules/inventory: `server/modules/inventory/infrastructure/replenishment.repository.ts:231` (+2) | **N** |
| inventory.replen_tasks | modules/catalog, modules/inventory, modules/orders | modules/catalog: `server/modules/catalog/catalog.storage.ts:264`<br>modules/inventory: `server/modules/inventory/application/replenishment.use-cases.ts:455` (+30)<br>modules/orders: `server/modules/orders/picking.use-cases.ts:2004` | **N** |
| inventory.replen_tier_defaults | modules/inventory | modules/inventory: `server/modules/inventory/infrastructure/replenishment.repository.ts:186` (+2) | Y |
| inventory.warehouse_settings | modules/inventory, modules/orders, modules/procurement | modules/inventory: `server/modules/inventory/infrastructure/replenishment.repository.ts:373` (+4)<br>modules/orders: `server/modules/orders/combining.service.ts:217` (+3)<br>modules/procurement: `server/modules/procurement/purchasing.service.ts:2265` (+2) | **N** |
| membership.member_current_membership | modules/subscriptions | modules/subscriptions: `server/modules/subscriptions/infrastructure/subscription.repository.ts:399` (+2) | Y |
| membership.member_subscriptions | modules/subscriptions | modules/subscriptions: `server/modules/subscriptions/application/subscription.use-cases.ts:141` (+7) | Y |
| membership.members | modules/subscriptions | modules/subscriptions: `server/modules/subscriptions/infrastructure/subscription.repository.ts:228` (+1) | Y |
| membership.plans | modules/subscriptions, server/routes/ | modules/subscriptions: `server/modules/subscriptions/infrastructure/subscription.repository.ts:84` (+1)<br>server/routes/: `server/routes/pick-priority.routes.ts:277` | **N** |
| membership.selling_plan_map | modules/subscriptions | modules/subscriptions: `server/modules/subscriptions/infrastructure/subscription.repository.ts:162` | Y |
| membership.shopify_metafield_outbox | modules/catalog | modules/catalog: `server/modules/catalog/shipping-group-sync.ts:61` | Y |
| membership.subscription_billing_attempts | modules/subscriptions | modules/subscriptions: `server/modules/subscriptions/infrastructure/subscription.repository.ts:446` | Y |
| membership.subscription_events | modules/subscriptions | modules/subscriptions: `server/modules/subscriptions/infrastructure/subscription.repository.ts:517` | Y |
| oms.fulfillment_routing_rules | modules/warehouse | modules/warehouse: `server/modules/warehouse/infrastructure/warehouse.repository.ts:214` (+2) | Y |
| oms.oms_order_events | modules/dropship, modules/oms, modules/orders, server/index | modules/dropship: `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:791` (+1)<br>modules/oms: `server/modules/oms/channel-fulfillment.service.ts:108` (+33)<br>modules/orders: `server/modules/orders/fulfillment.service.ts:539`<br>server/index: `server/index.ts:1322` (+1) | **N** |
| oms.oms_order_lines | modules/dropship, modules/oms, modules/orders, server/index | modules/dropship: `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:816`<br>modules/oms: `server/modules/oms/oms-webhooks.ts:1814` (+12)<br>modules/orders: `server/modules/orders/fulfillment.service.ts:535`<br>server/index: `server/index.ts:1406` | **N** |
| oms.oms_orders | modules/dropship, modules/oms, modules/orders, server/db, server/index | modules/dropship: `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts:728`<br>modules/oms: `server/modules/oms/channel-fulfillment.service.ts:150` (+17)<br>modules/orders: `server/modules/orders/fulfillment.service.ts:523` (+1)<br>server/db: `server/db.ts:632`<br>server/index: `server/index.ts:857` (+3) | **N** |
| oms.order_item_costs | modules/inventory, modules/procurement, server/db | modules/inventory: `server/modules/inventory/lots.service.ts:421` (+3)<br>modules/procurement: `server/modules/procurement/procurement.storage.ts:1029` (+1)<br>server/db: `server/db.ts:843` | **N** |
| oms.order_item_financials | modules/catalog, modules/procurement | modules/catalog: `server/modules/catalog/catalog.storage.ts:471`<br>modules/procurement: `server/modules/procurement/procurement.storage.ts:1044` | **N** |
| oms.order_line_adjustments | modules/oms | modules/oms: `server/modules/oms/oms-webhooks.ts:553` | Y |
| oms.webhook_inbox | modules/oms | modules/oms: `server/modules/oms/webhook-inbox.service.ts:144` (+6) | Y |
| oms.webhook_retry_queue | modules/oms, server/routes/ | modules/oms: `server/modules/oms/oms-webhooks.ts:1383` (+7)<br>server/routes/: `server/routes/shopify.routes.ts:1624` (+1) | **N** |
| procurement.ap_payment_allocations | modules/procurement | modules/procurement: `server/modules/procurement/ap-ledger.service.ts:912` | Y |
| procurement.ap_payments | modules/procurement | modules/procurement: `server/modules/procurement/ap-ledger.service.ts:893` (+1) | Y |
| procurement.demand_event_lines | modules/procurement | modules/procurement: `server/modules/procurement/demand-events.service.ts:110` (+3) | Y |
| procurement.demand_events | modules/procurement | modules/procurement: `server/modules/procurement/demand-events.service.ts:101` (+2) | Y |
| procurement.inbound_freight_allocations | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:1197` (+2) | Y |
| procurement.inbound_freight_costs | modules/procurement | modules/procurement: `server/modules/procurement/ap-ledger.service.ts:2050` (+5) | Y |
| procurement.inbound_shipment_lines | modules/catalog, modules/procurement | modules/catalog: `server/modules/catalog/catalog.storage.ts:463`<br>modules/procurement: `server/modules/procurement/procurement.storage.ts:1145` (+5) | **N** |
| procurement.inbound_shipment_status_history | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:1245` | Y |
| procurement.inbound_shipments | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:1100` (+2) | Y |
| procurement.landed_cost_adjustments | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:1228` | Y |
| procurement.landed_cost_snapshots | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:1223` (+3) | Y |
| procurement.po_approval_tiers | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:658` (+2) | Y |
| procurement.po_events | modules/procurement | modules/procurement: `server/modules/procurement/purchasing.service.ts:2301` (+1) | Y |
| procurement.po_exceptions | modules/procurement | modules/procurement: `server/modules/procurement/po-exceptions.service.ts:159` (+4) | Y |
| procurement.po_receipts | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:895` (+1) | Y |
| procurement.po_revisions | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:884` | Y |
| procurement.po_status_history | modules/procurement | modules/procurement: `server/modules/procurement/po-exceptions.service.ts:666` (+8) | Y |
| procurement.purchase_order_lines | modules/catalog, modules/procurement | modules/catalog: `server/modules/catalog/catalog.storage.ts:462`<br>modules/procurement: `server/modules/procurement/procurement.storage.ts:839` (+7) | **N** |
| procurement.purchase_orders | modules/procurement | modules/procurement: `server/modules/procurement/ap-ledger.service.ts:298` (+9) | Y |
| procurement.purchasing_recommendation_decisions | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:1972` | Y |
| procurement.receiving_lines | modules/catalog, modules/procurement | modules/catalog: `server/modules/catalog/catalog.storage.ts:464`<br>modules/procurement: `server/modules/procurement/procurement.storage.ts:359` (+4) | **N** |
| procurement.receiving_orders | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:310` (+3) | Y |
| procurement.vendor_invoice_attachments | modules/procurement | modules/procurement: `server/modules/procurement/ap-ledger.service.ts:1564` (+1) | Y |
| procurement.vendor_invoice_lines | modules/catalog, modules/procurement | modules/catalog: `server/modules/catalog/catalog.storage.ts:466`<br>modules/procurement: `server/modules/procurement/ap-ledger.service.ts:803` (+8) | **N** |
| procurement.vendor_invoice_po_links | modules/procurement | modules/procurement: `server/modules/procurement/ap-ledger.service.ts:467` (+2) | Y |
| procurement.vendor_invoices | modules/procurement | modules/procurement: `server/modules/procurement/ap-ledger.service.ts:382` (+8) | Y |
| procurement.vendor_products | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:416` (+4) | Y |
| procurement.vendors | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:261` (+2) | Y |
| public.audit_events | modules/procurement, server/infrastructure | modules/procurement: `server/modules/procurement/ap-ledger.service.ts:165`<br>server/infrastructure: `server/infrastructure/auditLogger.ts:34` | **N** |
| public.auto_draft_runs | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:1897` (+1) | Y |
| public.idempotency_keys | server/middleware | server/middleware: `server/middleware/idempotency.ts:46` (+1) | Y |
| public.notification_preferences | modules/notifications | modules/notifications: `server/modules/notifications/notifications.service.ts:263` (+2) | Y |
| public.notifications | modules/notifications | modules/notifications: `server/modules/notifications/notifications.service.ts:97` (+2) | Y |
| public.reorder_exclusion_rules | modules/procurement | modules/procurement: `server/modules/procurement/procurement.storage.ts:1802` (+1) | Y |
| public.shopify_order_items | modules/orders | modules/orders: `server/modules/orders/shopify-order-reconciliation.ts:295` | Y |
| public.shopify_orders | modules/orders | modules/orders: `server/modules/orders/shopify-order-reconciliation.ts:227` (+1) | Y |
| warehouse.echelon_settings | modules/orders, modules/warehouse, server/routes/ | modules/orders: `server/modules/orders/shopify-order-reconciliation.ts:343`<br>modules/warehouse: `server/modules/warehouse/infrastructure/warehouse.repository.ts:53` (+1)<br>server/routes/: `server/routes/pick-priority.routes.ts:183` | **N** |
| warehouse.product_locations | modules/catalog, modules/orders, modules/warehouse, server/seed | modules/catalog: `server/modules/catalog/catalog.storage.ts:243` (+2)<br>modules/orders: `server/modules/orders/picking.use-cases.ts:671` (+1)<br>modules/warehouse: `server/modules/warehouse/bin-assignment.service.ts:333` (+21)<br>server/seed: `server/seed.ts:23` | **N** |
| warehouse.warehouse_locations | modules/channels, modules/inventory, modules/warehouse | modules/channels: `server/modules/channels/catalog-backfill.service.ts:1019`<br>modules/inventory: `server/modules/inventory/application/inventory.use-cases.ts:1134` (+3)<br>modules/warehouse: `server/modules/warehouse/infrastructure/warehouse.repository.ts:175` (+2) | **N** |
| warehouse.warehouse_zones | modules/warehouse | modules/warehouse: `server/modules/warehouse/infrastructure/warehouse.repository.ts:135` (+2) | Y |
| warehouse.warehouses | modules/channels, modules/inventory, modules/warehouse | modules/channels: `server/modules/channels/sync-settings.service.ts:173`<br>modules/inventory: `server/modules/inventory/application/inventory.use-cases.ts:1072` (+2)<br>modules/warehouse: `server/modules/warehouse/infrastructure/warehouse.repository.ts:109` (+2) | **N** |
| wms.allocation_exceptions | modules/orders | modules/orders: `server/modules/orders/picking.use-cases.ts:432` (+8) | Y |
| wms.combined_order_groups | modules/orders | modules/orders: `server/modules/orders/combining.service.ts:498` (+10) | Y |
| wms.order_items | modules/catalog, modules/inventory, modules/oms, modules/orders, modules/wms, server/index, server/routes/ | modules/catalog: `server/modules/catalog/catalog.storage.ts:469`<br>modules/inventory: `server/modules/inventory/application/inventory.use-cases.ts:834` (+1)<br>modules/oms: `server/modules/oms/wms-sync.service.ts:907` (+16)<br>modules/orders: `server/modules/orders/orders.storage.ts:830` (+19)<br>modules/wms: `server/modules/wms/line-item-hold.ts:41` (+1)<br>server/index: `server/index.ts:990`<br>server/routes/: `server/routes/diagnostics.ts:54` (+1) | **N** |
| wms.orders | modules/oms, modules/orders, modules/wms, server/index, server/routes/ | modules/oms: `server/modules/oms/wms-sync.service.ts:807` (+6)<br>modules/orders: `server/modules/orders/combining.service.ts:486` (+35)<br>modules/wms: `server/modules/wms/insert-order.ts:72`<br>server/index: `server/index.ts:918`<br>server/routes/: `server/routes/diagnostics.ts:268` (+2) | **N** |
| wms.outbound_shipment_items | modules/oms, modules/orders, modules/wms | modules/oms: `server/modules/oms/oms-webhooks.ts:618` (+5)<br>modules/orders: `server/modules/orders/fulfillment.service.ts:156` (+2)<br>modules/wms: `server/modules/wms/create-shipment.ts:163` (+1) | **N** |
| wms.outbound_shipments | modules/oms, modules/orders, modules/wms, server/db, server/index, server/routes/ | modules/oms: `server/modules/oms/fulfillment-push.service.ts:1359` (+15)<br>modules/orders: `server/modules/orders/fulfillment.service.ts:107` (+9)<br>modules/wms: `server/modules/wms/create-shipment.ts:356` (+3)<br>server/db: `server/db.ts:639` (+3)<br>server/index: `server/index.ts:950` (+10)<br>server/routes/: `server/routes/shopify.routes.ts:412` (+1) | **N** |
| wms.picking_logs | modules/catalog, modules/orders | modules/catalog: `server/modules/catalog/catalog.storage.ts:470`<br>modules/orders: `server/modules/orders/picking-logs.storage.ts:58` | **N** |
| wms.return_items | modules/oms | modules/oms: `server/modules/oms/oms-webhooks.ts:966` | Y |
| wms.returns | modules/oms | modules/oms: `server/modules/oms/oms-webhooks.ts:938` | Y |
| wms.shipment_tracking_history | modules/orders | modules/orders: `server/modules/orders/shipment-rollup.ts:265` (+1) | Y |
| dropship.dropship_carrier_claims | _none found in server/_ | — | Y (no writers) |
| dropship.dropship_pricing_policies | _none found in server/_ | — | Y (no writers) |
| dropship.dropship_setup_blockers | _none found in server/_ | — | Y (no writers) |
| dropship.dropship_vendor_variant_overrides | _none found in server/_ | — | Y (no writers) |
| identity.user_audit | _none found in server/_ | — | Y (no writers) |
| inventory.order_line_costs | _none found in server/_ | — | Y (no writers) |
| inventory.warehouse_pick_zones | _none found in server/_ | — | Y (no writers) |
| membership.access_rules | _none found in server/_ | — | Y (no writers) |
| membership.back_in_stock_sends | _none found in server/_ | — | Y (no writers) |
| membership.back_in_stock_subscriptions | _none found in server/_ | — | Y (no writers) |
| membership.collection_alert_notification_queue | _none found in server/_ | — | Y (no writers) |
| membership.collection_alert_settings | _none found in server/_ | — | Y (no writers) |
| membership.collection_alert_subscriptions | _none found in server/_ | — | Y (no writers) |
| membership.earning_activities | _none found in server/_ | — | Y (no writers) |
| membership.marketplace_exclusions | _none found in server/_ | — | Y (no writers) |
| membership.medal_benefit_grants | _none found in server/_ | — | Y (no writers) |
| membership.member_earning_events | _none found in server/_ | — | Y (no writers) |
| membership.member_medal_achievements | _none found in server/_ | — | Y (no writers) |
| membership.member_referrals | _none found in server/_ | — | Y (no writers) |
| membership.member_shopify_customer_ids | _none found in server/_ | — | Y (no writers) |
| membership.member_stats | _none found in server/_ | — | Y (no writers) |
| membership.notification_templates | _none found in server/_ | — | Y (no writers) |
| membership.plan_collection_exclusions | _none found in server/_ | — | Y (no writers) |
| membership.plan_earning_rules | _none found in server/_ | — | Y (no writers) |
| membership.plan_feature_grants | _none found in server/_ | — | Y (no writers) |
| membership.plan_features | _none found in server/_ | — | Y (no writers) |
| membership.plan_medal_benefits | _none found in server/_ | — | Y (no writers) |
| membership.plan_redemption_rules | _none found in server/_ | — | Y (no writers) |
| membership.plan_variant_overrides | _none found in server/_ | — | Y (no writers) |
| membership.portal_config | _none found in server/_ | — | Y (no writers) |
| membership.product_collections | _none found in server/_ | — | Y (no writers) |
| membership.redemption_options | _none found in server/_ | — | Y (no writers) |
| membership.reward_ledger | _none found in server/_ | — | Y (no writers) |
| membership.reward_medals | _none found in server/_ | — | Y (no writers) |
| membership.reward_overrides | _none found in server/_ | — | Y (no writers) |
| membership.reward_redemptions | _none found in server/_ | — | Y (no writers) |
| membership.selling_plan_groups | _none found in server/_ | — | Y (no writers) |
| membership.social_accounts | _none found in server/_ | — | Y (no writers) |
| membership.social_action_verifications | _none found in server/_ | — | Y (no writers) |
| membership.social_verifications | _none found in server/_ | — | Y (no writers) |
| membership.subscription_billing_log | _none found in server/_ | — | Y (no writers) |
| membership.subscription_contracts | _none found in server/_ | — | Y (no writers) |
| membership.subscription_ledger | _none found in server/_ | — | Y (no writers) |
| membership.token_transactions | _none found in server/_ | — | Y (no writers) |
| public.notification_types | _none found in server/_ | — | Y (no writers) |
| shopify.shopify_collection_products | _none found in server/_ | — | Y (no writers) |
| shopify.shopify_collections | _none found in server/_ | — | Y (no writers) |
| warehouse.app_settings | _none found in server/_ | — | Y (no writers) |
| wms.line_fulfillments | _none found in server/_ | — | Y (no writers) |

---

## 2. MULTI-WRITER TABLES (41) — ranked by criticality, ALL writer refs

Ranking: order state, shipment state, inventory levels/ledger, and money-bearing tables first (marked ⚠ CRITICAL); then config/catalog/channel tables by writer count. `dz.` = drizzle, `sql.` = raw SQL. Line numbers are the statement's first line.

**Boundary-violation highlights found while compiling this section (evidence-cited):**
- `modules/dropship` writes OMS + inventory tables via raw SQL: `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts` inserts `oms.oms_orders` (:728), `oms.oms_order_lines` (:816), `oms.oms_order_events` (:791, :903), and directly does `UPDATE inventory.inventory_levels SET reserved_qty = reserved_qty + $1` (:866) + `INSERT INTO inventory.inventory_transactions` (:873). This bypasses the WMS reservation path (`reserveForOrder()` per BOUNDARIES/CLAUDE.md: "Reservation goes through reserveForOrder() only — no raw SQL").
- `modules/catalog` writes WMS/OMS/procurement tables in `cascadeSkuRename` (`server/modules/catalog/catalog.storage.ts:455-472`) — commented as a deliberate cross-system SKU-consistency correction, but it makes catalog a writer of `wms.order_items`, `wms.picking_logs`, `oms.order_item_financials`, `procurement.purchase_order_lines`, `procurement.receiving_lines`, `procurement.inbound_shipment_lines`, `procurement.vendor_invoice_lines`, `warehouse.product_locations`.
- `modules/orders` (WMS side) writes OMS order state: `server/modules/orders/fulfillment.service.ts:523-539` (sets `oms.oms_orders.status='shipped'` + lines + event from a Shopify-webhook fulfillment path) and `server/modules/orders/orders.storage.ts:1497` (`UPDATE oms_orders`, unqualified table ref).
- `modules/oms` writes WMS execution state extensively (`wms.orders`, `wms.order_items`, `wms.outbound_shipments`, `wms.outbound_shipment_items`) from `wms-sync.service.ts`, `shipstation.service.ts`, `oms-webhooks.ts`, `oms-flow-reconciliation.service.ts` — the OMS→WMS sync writes directly into WMS tables rather than through a WMS public interface.

### 1. `wms.outbound_shipments` — 6 writing modules, 47 write sites  ⚠ CRITICAL
- **modules/oms** (16):
  - `server/modules/oms/fulfillment-push.service.ts`: 1359 sql.UPDATE; 2059 sql.UPDATE
  - `server/modules/oms/oms-webhooks.ts`: 690 sql.UPDATE
  - `server/modules/oms/shipstation-sweeper.ts`: 87 sql.UPDATE
  - `server/modules/oms/shipstation.service.ts`: 1532 sql.INSERT; 2746 sql.INSERT; 1131 sql.UPDATE; 1253 sql.UPDATE; 1324 sql.UPDATE; 1374 sql.UPDATE; 1647 sql.UPDATE; 1665 sql.UPDATE; 1927 sql.UPDATE; 2634 sql.UPDATE; 3823 sql.UPDATE
  - `server/modules/oms/webhook-retry.worker.ts`: 1660 sql.UPDATE
- **modules/orders** (10):
  - `server/modules/orders/fulfillment.service.ts`: 107 dz.insert; 247 dz.update; 329 dz.insert; 654 dz.update; 738 dz.update
  - `server/modules/orders/shipment-rollup.ts`: 279 sql.UPDATE; 426 sql.UPDATE; 494 sql.UPDATE; 700 sql.UPDATE; 1007 sql.UPDATE
- **modules/wms** (4):
  - `server/modules/wms/create-shipment.ts`: 356 dz.insert; 523 dz.insert
  - `server/modules/wms/line-item-hold.ts`: 65 sql.INSERT; 121 sql.UPDATE
- **server/db** (4):
  - `server/db.ts`: 639 sql.UPDATE; 647 sql.UPDATE; 657 sql.UPDATE; 668 sql.UPDATE
- **server/index** (11):
  - `server/index.ts`: 950 sql.UPDATE; 958 sql.UPDATE; 1004 sql.UPDATE; 1115 sql.UPDATE; 1263 sql.UPDATE; 1275 sql.UPDATE; 1286 sql.UPDATE; 1298 sql.UPDATE; 1311 sql.UPDATE; 1469 sql.UPDATE; 1489 sql.UPDATE
- **server/routes/** (2):
  - `server/routes/shopify.routes.ts`: 412 sql.INSERT; 647 sql.INSERT

### 2. `wms.orders` — 5 writing modules, 48 write sites  ⚠ CRITICAL
- **modules/oms** (7):
  - `server/modules/oms/wms-sync.service.ts`: 807 dz.update; 1046 sql.UPDATE; 1433 sql.UPDATE
  - `server/modules/oms/oms-flow-reconciliation.service.ts`: 1031 sql.UPDATE
  - `server/modules/oms/oms-webhooks.ts`: 1726 sql.UPDATE
  - `server/modules/oms/shipstation.service.ts`: 2655 sql.UPDATE; 2720 sql.UPDATE
- **modules/orders** (36):
  - `server/modules/orders/combining.service.ts`: 486 dz.update; 528 dz.update; 603 dz.update; 712 dz.update; 772 dz.update; 809 dz.update; 823 dz.update; 847 dz.update; 971 dz.update; 997 dz.update
  - `server/modules/orders/fulfillment-router.service.ts`: 162 dz.update
  - `server/modules/orders/orders.storage.ts`: 168 dz.update; 230 dz.update; 885 dz.update; 940 dz.update; 975 dz.update; 1023 dz.update; 1070 dz.update; 1168 dz.update; 1178 dz.update; 1188 dz.update; 1220 dz.update; 1314 dz.update; 1411 sql.UPDATE; 1460 sql.UPDATE; 1565 sql.UPDATE
  - `server/modules/orders/sla-monitor.service.ts`: 101 dz.update; 120 sql.UPDATE; 129 sql.UPDATE; 138 sql.UPDATE; 147 sql.UPDATE; 157 sql.UPDATE
  - `server/modules/orders/fulfillment.service.ts`: 567 sql.UPDATE
  - `server/modules/orders/order-status-core.ts`: 178 sql.UPDATE
  - `server/modules/orders/shipment-rollup.ts`: 843 sql.UPDATE; 876 sql.UPDATE
- **modules/wms** (1):
  - `server/modules/wms/insert-order.ts`: 72 dz.insert
- **server/index** (1):
  - `server/index.ts`: 918 sql.UPDATE
- **server/routes/** (3):
  - `server/routes/diagnostics.ts`: 268 sql.UPDATE; 73 sql.DELETE; 130 sql.DELETE

### 3. `wms.order_items` — 7 writing modules, 45 write sites  ⚠ CRITICAL
- **modules/catalog** (1):
  - `server/modules/catalog/catalog.storage.ts`: 469 dz.update
- **modules/inventory** (2):
  - `server/modules/inventory/application/inventory.use-cases.ts`: 834 sql.UPDATE
  - `server/modules/inventory/infrastructure/inventory.repository.ts`: 395 sql.UPDATE
- **modules/oms** (17):
  - `server/modules/oms/wms-sync.service.ts`: 907 dz.update; 919 dz.update; 949 dz.insert; 1259 dz.update; 1297 dz.update; 1330 dz.update; 1346 dz.update; 1356 dz.update; 1392 dz.insert; 1842 dz.delete; 1874 dz.insert; 983 sql.UPDATE
  - `server/modules/oms/oms-webhooks.ts`: 631 sql.UPDATE
  - `server/modules/oms/shipstation.service.ts`: 1722 sql.UPDATE; 1781 sql.UPDATE; 2664 sql.UPDATE; 2726 sql.UPDATE
- **modules/orders** (20):
  - `server/modules/orders/orders.storage.ts`: 830 dz.insert; 952 dz.update; 982 dz.update; 1111 dz.update; 1127 dz.update; 1163 dz.update; 1201 dz.update; 1210 dz.update; 1247 dz.update; 715 sql.UPDATE; 1006 sql.UPDATE; 1030 sql.UPDATE; 1422 sql.UPDATE; 1434 sql.UPDATE; 1447 sql.UPDATE; 1610 sql.UPDATE
  - `server/modules/orders/picking.use-cases.ts`: 702 dz.update; 1038 dz.update
  - `server/modules/orders/fulfillment.service.ts`: 475 sql.UPDATE; 573 sql.UPDATE
- **modules/wms** (2):
  - `server/modules/wms/line-item-hold.ts`: 41 sql.UPDATE; 104 sql.UPDATE
- **server/index** (1):
  - `server/index.ts`: 990 sql.UPDATE
- **server/routes/** (2):
  - `server/routes/diagnostics.ts`: 54 sql.DELETE; 115 sql.DELETE

### 4. `oms.oms_orders` — 5 writing modules, 26 write sites  ⚠ CRITICAL
- **modules/dropship** (1):
  - `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts`: 728 sql.INSERT
- **modules/oms** (18):
  - `server/modules/oms/channel-fulfillment.service.ts`: 150 dz.update
  - `server/modules/oms/member-tier-enrichment.ts`: 64 dz.update
  - `server/modules/oms/oms-webhooks.ts`: 1665 dz.update; 2005 dz.update; 2100 dz.update; 2268 dz.update
  - `server/modules/oms/oms.service.ts`: 175 dz.insert; 303 dz.update; 484 dz.update; 506 dz.update
  - `server/modules/oms/shipstation.service.ts`: 2420 dz.update; 2444 dz.update; 2854 dz.update
  - `server/modules/oms/ebay-order-ingestion.ts`: 260 sql.UPDATE unqualified ref; 286 sql.UPDATE unqualified ref
  - `server/modules/oms/oms-flow-reconciliation.service.ts`: 1069 sql.UPDATE; 1131 sql.UPDATE
  - `server/modules/oms/wms-sync.service.ts`: 1722 sql.UPDATE
- **modules/orders** (2):
  - `server/modules/orders/fulfillment.service.ts`: 523 dz.update
  - `server/modules/orders/orders.storage.ts`: 1497 sql.UPDATE unqualified ref
- **server/db** (1):
  - `server/db.ts`: 632 sql.UPDATE
- **server/index** (4):
  - `server/index.ts`: 857 sql.UPDATE; 1372 sql.UPDATE; 1424 sql.UPDATE; 1560 sql.UPDATE

### 5. `oms.oms_order_lines` — 4 writing modules, 16 write sites  ⚠ CRITICAL
- **modules/dropship** (1):
  - `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts`: 816 sql.INSERT
- **modules/oms** (13):
  - `server/modules/oms/oms-webhooks.ts`: 1814 dz.update; 1839 dz.insert; 1871 dz.update; 2112 dz.update
  - `server/modules/oms/oms.service.ts`: 241 dz.insert; 349 dz.insert; 520 dz.update; 971 dz.update
  - `server/modules/oms/shipstation.service.ts`: 2435 dz.update; 2867 dz.update; 2394 sql.UPDATE
  - `server/modules/oms/channel-fulfillment.service.ts`: 173 sql.UPDATE
  - `server/modules/oms/fulfillment-push.service.ts`: 1209 sql.UPDATE
- **modules/orders** (1):
  - `server/modules/orders/fulfillment.service.ts`: 535 dz.update
- **server/index** (1):
  - `server/index.ts`: 1406 sql.UPDATE

### 6. `inventory.inventory_levels` — 6 writing modules, 17 write sites  ⚠ CRITICAL
- **modules/catalog** (1):
  - `server/modules/catalog/catalog.storage.ts`: 238 dz.delete
- **modules/channels** (1):
  - `server/modules/channels/catalog-backfill.service.ts`: 867 dz.insert
- **modules/dropship** (1):
  - `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts`: 866 sql.UPDATE
- **modules/inventory** (12):
  - `server/modules/inventory/application/break-assembly.use-cases.ts`: 612 dz.update; 632 dz.insert
  - `server/modules/inventory/infrastructure/inventory.repository.ts`: 141 dz.insert; 162 dz.update; 168 dz.insert; 190 dz.update; 208 dz.update; 341 dz.update; 359 dz.update; 367 dz.insert; 681 dz.delete
  - `server/modules/inventory/application/inventory.use-cases.ts`: 1018 sql.DELETE unqualified ref
- **server/db** (1):
  - `server/db.ts`: 550 sql.DELETE
- **server/scripts** (1):
  - `server/scripts/fix_orphaned_picks.ts`: 35 sql.UPDATE

### 7. `inventory.inventory_transactions` — 5 writing modules, 9 write sites  ⚠ CRITICAL
- **modules/channels** (2):
  - `server/modules/channels/catalog-backfill.service.ts`: 878 dz.insert
  - `server/modules/channels/reservation.service.ts`: 509 dz.insert
- **modules/dropship** (1):
  - `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts`: 873 sql.INSERT
- **modules/inventory** (4):
  - `server/modules/inventory/application/break-assembly.use-cases.ts`: 639 dz.insert
  - `server/modules/inventory/infrastructure/inventory.repository.ts`: 244 dz.insert; 413 dz.insert; 430 dz.insert
- **server/routes/** (1):
  - `server/routes/diagnostics.ts`: 29 sql.UPDATE
- **server/scripts** (1):
  - `server/scripts/fix_orphaned_picks.ts`: 43 sql.INSERT

### 8. `wms.outbound_shipment_items` — 3 writing modules, 11 write sites  ⚠ CRITICAL
- **modules/oms** (6):
  - `server/modules/oms/oms-webhooks.ts`: 618 sql.UPDATE
  - `server/modules/oms/shipstation.service.ts`: 1337 sql.UPDATE; 1352 sql.UPDATE; 1391 sql.UPDATE; 1405 sql.UPDATE
  - `server/modules/oms/wms-sync.service.ts`: 1142 sql.INSERT
- **modules/orders** (3):
  - `server/modules/orders/fulfillment.service.ts`: 156 dz.insert; 455 dz.insert
  - `server/modules/orders/picking.use-cases.ts`: 1385 sql.UPDATE
- **modules/wms** (2):
  - `server/modules/wms/create-shipment.ts`: 163 sql.INSERT
  - `server/modules/wms/line-item-hold.ts`: 75 sql.UPDATE

### 9. `inventory.inventory_lots` — 3 writing modules, 26 write sites  ⚠ CRITICAL
- **modules/inventory** (20):
  - `server/modules/inventory/cogs.service.ts`: 159 dz.insert; 182 sql.UPDATE unqualified ref; 296 sql.UPDATE unqualified ref; 433 sql.UPDATE; 903 sql.UPDATE; 1001 sql.UPDATE unqualified ref; 1010 sql.UPDATE unqualified ref; 1015 sql.UPDATE unqualified ref; 1035 sql.UPDATE unqualified ref; 1154 sql.UPDATE
  - `server/modules/inventory/lots.service.ts`: 113 dz.insert; 954 dz.update; 244 sql.UPDATE; 300 sql.UPDATE; 411 sql.UPDATE; 478 sql.UPDATE; 559 sql.UPDATE; 601 sql.UPDATE; 685 sql.UPDATE; 758 sql.UPDATE
- **modules/procurement** (3):
  - `server/modules/procurement/procurement.storage.ts`: 986 dz.insert; 991 dz.update
  - `server/modules/procurement/shipment-tracking.service.ts`: 1646 sql.UPDATE
- **server/db** (3):
  - `server/db.ts`: 802 sql.UPDATE unqualified ref; 834 sql.UPDATE unqualified ref; 872 sql.UPDATE unqualified ref

### 10. `oms.order_item_costs` — 3 writing modules, 7 write sites  ⚠ CRITICAL
- **modules/inventory** (4):
  - `server/modules/inventory/lots.service.ts`: 421 dz.insert; 492 dz.delete; 504 dz.delete
  - `server/modules/inventory/cogs.service.ts`: 367 sql.UPDATE
- **modules/procurement** (2):
  - `server/modules/procurement/procurement.storage.ts`: 1029 dz.insert
  - `server/modules/procurement/shipment-tracking.service.ts`: 1668 sql.UPDATE
- **server/db** (1):
  - `server/db.ts`: 843 sql.UPDATE

### 11. `oms.oms_order_events` — 4 writing modules, 39 write sites  ⚠ CRITICAL
- **modules/dropship** (2):
  - `server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts`: 791 sql.INSERT; 903 sql.INSERT
- **modules/oms** (34):
  - `server/modules/oms/channel-fulfillment.service.ts`: 108 dz.insert
  - `server/modules/oms/fulfillment-push.service.ts`: 499 dz.insert; 605 dz.insert; 764 dz.insert; 1380 dz.insert
  - `server/modules/oms/oms-webhooks.ts`: 398 dz.insert; 434 dz.insert; 995 dz.insert; 1941 dz.insert; 2121 dz.insert; 2277 dz.insert
  - `server/modules/oms/oms.service.ts`: 268 dz.insert; 313 dz.insert; 469 dz.insert; 488 dz.insert; 524 dz.insert
  - `server/modules/oms/shipstation.service.ts`: 1934 dz.insert; 1995 dz.insert; 2041 dz.insert; 2085 dz.insert; 2145 dz.insert; 2491 dz.insert; 2872 dz.insert; 2967 dz.insert; 1169 sql.INSERT
  - `server/modules/oms/wms-sync.service.ts`: 731 dz.insert; 1492 dz.insert
  - `server/modules/oms/oms-flow-reconciliation.service.ts`: 820 sql.INSERT; 898 sql.INSERT; 984 sql.INSERT; 1034 sql.INSERT; 1104 sql.INSERT; 1154 sql.INSERT
  - `server/modules/oms/shipstation-sweeper.ts`: 64 sql.INSERT
- **modules/orders** (1):
  - `server/modules/orders/fulfillment.service.ts`: 539 dz.insert
- **server/index** (2):
  - `server/index.ts`: 1322 sql.INSERT; 1440 sql.INSERT

### 12. `oms.order_item_financials` — 2 writing modules, 2 write sites  ⚠ CRITICAL
- **modules/catalog** (1):
  - `server/modules/catalog/catalog.storage.ts`: 471 dz.update
- **modules/procurement** (1):
  - `server/modules/procurement/procurement.storage.ts`: 1044 dz.insert

### 13. `oms.webhook_retry_queue` — 2 writing modules, 10 write sites  ⚠ CRITICAL
- **modules/oms** (8):
  - `server/modules/oms/oms-webhooks.ts`: 1383 dz.insert
  - `server/modules/oms/webhook-retry.worker.ts`: 634 dz.insert; 1576 dz.update; 1620 dz.update; 1687 dz.update; 1703 dz.update; 711 sql.UPDATE
  - `server/modules/oms/webhook-inbox.service.ts`: 256 sql.INSERT
- **server/routes/** (2):
  - `server/routes/shopify.routes.ts`: 1624 dz.insert; 1690 dz.insert

### 14. `wms.picking_logs` — 2 writing modules, 2 write sites  ⚠ CRITICAL
- **modules/catalog** (1):
  - `server/modules/catalog/catalog.storage.ts`: 470 dz.update
- **modules/orders** (1):
  - `server/modules/orders/picking-logs.storage.ts`: 58 dz.insert

### 15. `catalog.product_variants` — 4 writing modules, 10 write sites
- **modules/catalog** (4):
  - `server/modules/catalog/catalog.routes.ts`: 1724 dz.update
  - `server/modules/catalog/catalog.storage.ts`: 216 dz.insert; 221 dz.update; 229 dz.delete
- **modules/channels** (2):
  - `server/modules/channels/catalog-backfill.service.ts`: 514 dz.update; 541 dz.insert
- **modules/inventory** (2):
  - `server/modules/inventory/lots.service.ts`: 811 dz.update
  - `server/modules/inventory/cogs.service.ts`: 1170 sql.UPDATE
- **server/routes/** (2):
  - `server/routes/ebay/ebay-listing-state.ts`: 86 dz.update
  - `server/routes/ebay/ebay-policies.routes.ts`: 122 dz.update

### 16. `catalog.products` — 4 writing modules, 15 write sites
- **modules/catalog** (6):
  - `server/modules/catalog/catalog.routes.ts`: 537 dz.update; 668 dz.update; 1709 dz.update
  - `server/modules/catalog/catalog.storage.ts`: 157 dz.insert; 162 dz.update; 170 dz.delete
- **modules/channels** (3):
  - `server/modules/channels/catalog-backfill.service.ts`: 364 dz.update; 387 dz.insert
  - `server/modules/channels/echelon-sync-orchestrator.service.ts`: 1163 dz.update
- **modules/procurement** (1):
  - `server/modules/procurement/procurement.storage.ts`: 1880 dz.update
- **server/routes/** (5):
  - `server/routes/ebay/ebay-listing-state.ts`: 52 dz.update
  - `server/routes/ebay/ebay-policies.routes.ts`: 90 dz.update
  - `server/routes/ebay-listing-rules.routes.ts`: 154 dz.update; 197 sql.UPDATE
  - `server/routes/ebay/ebay-config.routes.ts`: 367 sql.UPDATE

### 17. `channels.channels` — 4 writing modules, 13 write sites
- **modules/channels** (5):
  - `server/modules/channels/channels.storage.ts`: 160 dz.insert; 165 dz.update; 173 dz.delete; 910 dz.update
  - `server/modules/channels/sync-settings.service.ts`: 146 dz.update
- **modules/dropship** (4):
  - `server/modules/dropship/infrastructure/dropship-oms-channel-config.repository.ts`: 260 sql.INSERT; 248 sql.UPDATE; 303 sql.UPDATE; 350 sql.UPDATE
- **modules/identity** (1):
  - `server/modules/identity/infrastructure/identity.repository.ts`: 155 sql.INSERT unqualified ref
- **server/routes/** (3):
  - `server/routes/ebay-oauth.routes.ts`: 109 dz.insert
  - `server/routes/pick-priority.routes.ts`: 294 sql.UPDATE; 303 sql.UPDATE

### 18. `warehouse.product_locations` — 4 writing modules, 28 write sites
- **modules/catalog** (3):
  - `server/modules/catalog/catalog.storage.ts`: 243 dz.delete; 465 dz.update; 475 dz.update
- **modules/orders** (2):
  - `server/modules/orders/picking.use-cases.ts`: 671 dz.update; 685 dz.insert
- **modules/warehouse** (22):
  - `server/modules/warehouse/bin-assignment.service.ts`: 333 dz.update; 369 dz.insert; 317 sql.UPDATE; 352 sql.DELETE
  - `server/modules/warehouse/infrastructure/warehouse.repository.ts`: 321 dz.update; 335 dz.update; 347 dz.update; 349 dz.update; 351 dz.update; 355 dz.insert; 370 dz.update; 372 dz.update; 374 dz.update; 392 dz.insert; 405 dz.update; 410 dz.delete; 423 dz.update; 426 dz.insert; 436 dz.delete; 442 dz.delete; 446 dz.delete; 477 dz.update
- **server/seed** (1):
  - `server/seed.ts`: 23 dz.insert

### 19. `catalog.product_assets` — 3 writing modules, 21 write sites
- **modules/catalog** (19):
  - `server/modules/catalog/catalog.routes.ts`: 1084 dz.update; 2269 dz.insert; 2367 dz.delete; 2429 dz.insert; 2262 sql.UPDATE; 2286 sql.UPDATE; 2400 sql.UPDATE; 2446 sql.UPDATE
  - `server/modules/catalog/catalog.storage.ts`: 302 dz.insert; 307 dz.delete; 312 dz.delete; 317 dz.update; 326 dz.update; 333 dz.update; 336 dz.update
  - `server/modules/catalog/image-sync.service.ts`: 141 dz.insert; 277 dz.insert; 157 sql.UPDATE; 293 sql.UPDATE
- **modules/channels** (1):
  - `server/modules/channels/catalog-backfill.service.ts`: 725 dz.insert
- **server/routes/** (1):
  - `server/routes/ebay/ebay-policies.routes.ts`: 288 dz.insert

### 20. `channels.channel_connections` — 3 writing modules, 8 write sites
- **modules/channels** (3):
  - `server/modules/channels/channels.storage.ts`: 185 dz.update; 191 dz.insert; 196 dz.update
- **modules/dropship** (1):
  - `server/modules/dropship/infrastructure/dropship-oms-channel-config.repository.ts`: 321 sql.UPDATE
- **server/routes/** (4):
  - `server/routes/ebay-settings.routes.ts`: 78 dz.insert; 319 dz.update; 360 dz.update
  - `server/routes/shopify.routes.ts`: 828 dz.update

### 21. `channels.channel_feeds` — 3 writing modules, 14 write sites
- **modules/catalog** (3):
  - `server/modules/catalog/catalog.routes.ts`: 1730 dz.update; 1749 dz.insert
  - `server/modules/catalog/catalog.storage.ts`: 248 dz.update
- **modules/channels** (8):
  - `server/modules/channels/catalog-backfill.service.ts`: 584 dz.update; 594 dz.insert
  - `server/modules/channels/channels.storage.ts`: 299 dz.update; 303 dz.insert
  - `server/modules/channels/echelon-sync-orchestrator.service.ts`: 664 dz.update; 1432 dz.update; 1436 dz.insert
  - `server/modules/channels/sync.service.ts`: 648 dz.insert
- **modules/inventory** (3):
  - `server/modules/inventory/infrastructure/inventory.repository.ts`: 621 dz.update; 627 dz.insert; 634 dz.update

### 22. `channels.channel_listings` — 3 writing modules, 22 write sites
- **modules/catalog** (4):
  - `server/modules/catalog/catalog.routes.ts`: 1765 dz.update; 1784 dz.insert; 980 sql.DELETE; 2016 sql.DELETE
- **modules/channels** (7):
  - `server/modules/channels/catalog-backfill.service.ts`: 619 dz.update; 637 dz.insert
  - `server/modules/channels/channel-catalog.storage.ts`: 220 dz.insert
  - `server/modules/channels/echelon-sync-orchestrator.service.ts`: 908 dz.update; 1103 dz.update; 1444 dz.update; 1466 dz.update
- **server/routes/** (11):
  - `server/routes/ebay/ebay-policies.routes.ts`: 378 dz.delete
  - `server/routes/ebay/ebay-sync-helpers.ts`: 34 dz.insert; 108 dz.update
  - `server/routes/ebay/ebay-listing-state.ts`: 113 sql.UPDATE; 131 sql.UPDATE; 146 sql.UPDATE; 164 sql.UPDATE; 180 sql.UPDATE; 196 sql.UPDATE
  - `server/routes/ebay/ebay-listings.routes.ts`: 1844 sql.UPDATE unqualified ref; 1881 sql.UPDATE unqualified ref

### 23. `inventory.replen_tasks` — 3 writing modules, 33 write sites
- **modules/catalog** (1):
  - `server/modules/catalog/catalog.storage.ts`: 264 dz.update
- **modules/inventory** (31):
  - `server/modules/inventory/application/replenishment.use-cases.ts`: 455 dz.update; 485 dz.update; 510 dz.update; 520 dz.update; 550 dz.update; 1006 dz.update; 1046 dz.update; 1057 dz.update; 1315 dz.update; 1349 dz.update; 1439 dz.update; 1594 dz.update; 2110 dz.insert; 2148 dz.insert; 2388 dz.insert; 2486 dz.insert; 2550 dz.update; 2608 dz.update; 2759 dz.update; 2821 dz.insert; 2862 dz.update; 3025 dz.update; 3207 dz.insert; 3246 dz.insert; 1881 sql.UPDATE; 1938 sql.UPDATE; 2013 sql.UPDATE
  - `server/modules/inventory/infrastructure/replenishment.repository.ts`: 325 dz.insert; 330 dz.update; 338 dz.delete
  - `server/modules/inventory/application/cycle-count.use-cases.ts`: 457 sql.UPDATE
- **modules/orders** (1):
  - `server/modules/orders/picking.use-cases.ts`: 2004 sql.UPDATE

### 24. `inventory.warehouse_settings` — 3 writing modules, 12 write sites
- **modules/inventory** (5):
  - `server/modules/inventory/infrastructure/replenishment.repository.ts`: 373 dz.insert; 378 dz.update; 386 dz.delete; 401 sql.UPDATE; 407 sql.UPDATE
- **modules/orders** (4):
  - `server/modules/orders/combining.service.ts`: 217 dz.update; 234 dz.insert; 251 dz.update; 255 dz.insert
- **modules/procurement** (3):
  - `server/modules/procurement/purchasing.service.ts`: 2265 dz.update; 2272 dz.update
  - `server/modules/procurement/procurement.storage.ts`: 2043 sql.UPDATE unqualified ref

### 25. `warehouse.echelon_settings` — 3 writing modules, 4 write sites
- **modules/orders** (1):
  - `server/modules/orders/shopify-order-reconciliation.ts`: 343 sql.INSERT unqualified ref
- **modules/warehouse** (2):
  - `server/modules/warehouse/infrastructure/warehouse.repository.ts`: 53 dz.update; 56 dz.insert
- **server/routes/** (1):
  - `server/routes/pick-priority.routes.ts`: 183 sql.INSERT

### 26. `warehouse.warehouse_locations` — 3 writing modules, 8 write sites
- **modules/channels** (1):
  - `server/modules/channels/catalog-backfill.service.ts`: 1019 dz.insert
- **modules/inventory** (4):
  - `server/modules/inventory/application/inventory.use-cases.ts`: 1134 dz.insert
  - `server/modules/inventory/application/cycle-count.use-cases.ts`: 442 sql.UPDATE; 734 sql.UPDATE
  - `server/modules/inventory/cycle-count-freeze-guard.scheduler.ts`: 67 sql.UPDATE
- **modules/warehouse** (3):
  - `server/modules/warehouse/infrastructure/warehouse.repository.ts`: 175 dz.insert; 196 dz.update; 201 dz.delete

### 27. `warehouse.warehouses` — 3 writing modules, 7 write sites
- **modules/channels** (1):
  - `server/modules/channels/sync-settings.service.ts`: 173 dz.update
- **modules/inventory** (3):
  - `server/modules/inventory/application/inventory.use-cases.ts`: 1072 dz.update; 1182 dz.update; 1187 dz.update
- **modules/warehouse** (3):
  - `server/modules/warehouse/infrastructure/warehouse.repository.ts`: 109 dz.insert; 114 dz.update; 121 dz.delete

### 28. `catalog.product_line_products` — 2 writing modules, 8 write sites
- **modules/channels** (7):
  - `server/modules/channels/channels.storage.ts`: 478 dz.delete; 480 dz.insert; 487 dz.insert; 495 dz.delete; 502 dz.insert; 510 dz.delete; 521 dz.delete
- **server/db** (1):
  - `server/db.ts`: 284 sql.INSERT

### 29. `catalog.product_lines` — 2 writing modules, 3 write sites
- **modules/channels** (2):
  - `server/modules/channels/channels.storage.ts`: 458 dz.insert; 473 dz.update
- **server/db** (1):
  - `server/db.ts`: 278 sql.INSERT

### 30. `channels.channel_product_lines` — 2 writing modules, 3 write sites
- **modules/channels** (2):
  - `server/modules/channels/channel-catalog.storage.ts`: 292 dz.delete; 294 dz.insert
- **server/db** (1):
  - `server/db.ts`: 291 sql.INSERT

### 31. `channels.channel_product_overrides` — 2 writing modules, 3 write sites
- **modules/channels** (2):
  - `server/modules/channels/channel-catalog.storage.ts`: 75 dz.insert; 98 dz.delete
- **server/routes/** (1):
  - `server/routes/ebay/ebay-listing-state.ts`: 57 dz.insert

### 32. `channels.channel_variant_overrides` — 2 writing modules, 3 write sites
- **modules/channels** (2):
  - `server/modules/channels/channel-catalog.storage.ts`: 127 dz.insert; 145 dz.delete
- **server/routes/** (1):
  - `server/routes/ebay/ebay-listing-state.ts`: 91 dz.insert

### 33. `channels.sync_settings` — 2 writing modules, 4 write sites
- **modules/channels** (3):
  - `server/modules/channels/sync-settings.service.ts`: 70 dz.insert; 86 dz.update; 100 dz.update
- **server/db** (1):
  - `server/db.ts`: 580 sql.INSERT unqualified ref

### 34. `inventory.adjustment_reasons` — 2 writing modules, 4 write sites
- **modules/identity** (2):
  - `server/modules/identity/application/identity.use-cases.ts`: 133 dz.delete; 137 dz.insert
- **modules/inventory** (2):
  - `server/modules/inventory/infrastructure/inventory.repository.ts`: 582 dz.insert; 591 dz.update

### 35. `inventory.replen_rules` — 2 writing modules, 4 write sites
- **modules/catalog** (1):
  - `server/modules/catalog/catalog.storage.ts`: 256 dz.update
- **modules/inventory** (3):
  - `server/modules/inventory/infrastructure/replenishment.repository.ts`: 231 dz.insert; 236 dz.update; 244 dz.delete

### 36. `membership.plans` — 2 writing modules, 3 write sites
- **modules/subscriptions** (2):
  - `server/modules/subscriptions/infrastructure/subscription.repository.ts`: 84 dz.update; 115 dz.update
- **server/routes/** (1):
  - `server/routes/pick-priority.routes.ts`: 277 sql.UPDATE

### 37. `procurement.inbound_shipment_lines` — 2 writing modules, 7 write sites
- **modules/catalog** (1):
  - `server/modules/catalog/catalog.storage.ts`: 463 dz.update
- **modules/procurement** (6):
  - `server/modules/procurement/procurement.storage.ts`: 1145 dz.insert; 1151 dz.insert; 1155 dz.update; 1160 dz.delete
  - `server/modules/procurement/purchasing.service.ts`: 1209 dz.update
  - `server/modules/procurement/shipment-tracking.service.ts`: 725 dz.insert

### 38. `procurement.purchase_order_lines` — 2 writing modules, 9 write sites
- **modules/catalog** (1):
  - `server/modules/catalog/catalog.storage.ts`: 462 dz.update
- **modules/procurement** (8):
  - `server/modules/procurement/procurement.storage.ts`: 839 dz.insert; 845 dz.insert; 849 dz.update; 857 dz.delete; 931 dz.update
  - `server/modules/procurement/purchasing.service.ts`: 665 dz.update; 2775 dz.insert; 2803 dz.update

### 39. `procurement.receiving_lines` — 2 writing modules, 6 write sites
- **modules/catalog** (1):
  - `server/modules/catalog/catalog.storage.ts`: 464 dz.update
- **modules/procurement** (5):
  - `server/modules/procurement/procurement.storage.ts`: 359 dz.insert; 364 dz.update; 372 dz.delete; 378 dz.insert
  - `server/modules/procurement/receiving.service.ts`: 380 sql.DELETE

### 40. `procurement.vendor_invoice_lines` — 2 writing modules, 10 write sites
- **modules/catalog** (1):
  - `server/modules/catalog/catalog.storage.ts`: 466 dz.update
- **modules/procurement** (9):
  - `server/modules/procurement/ap-ledger.service.ts`: 803 dz.delete; 1353 dz.insert; 1394 dz.insert; 1428 dz.update; 1446 dz.delete; 1507 dz.update; 1524 dz.update; 1824 dz.insert
  - `server/modules/procurement/purchasing.service.ts`: 1218 dz.update

### 41. `public.audit_events` — 2 writing modules, 2 write sites
- **modules/procurement** (1):
  - `server/modules/procurement/ap-ledger.service.ts`: 165 dz.insert
- **server/infrastructure** (1):
  - `server/infrastructure/auditLogger.ts`: 34 dz.insert

---

## 3. ROUTE-LAYER WRITES (controller-layer DB writes — contract violations per CLAUDE.md §16)

83 write sites in `*.routes.ts` files / `server/routes/` (incl. two route-helper files `ebay-listing-state.ts`, `ebay-sync-helpers.ts` that live in the controller directory and are called only from routes). `server/routes.ts` itself is a pure registrar (116 lines, no writes). No writes found in `oms.routes.ts`, `picking.routes.ts`, `warehouse.routes.ts`, `inventory.routes.ts`, `subscription.webhooks.ts` — those delegate to services.

### 3.1 Financial/order-state route writes (highest severity)

| File:line | Write | Note |
|---|---|---|
| `server/routes/shopify.routes.ts:412` | sql.INSERT `wms.outbound_shipments` | Creates a `status='shipped'` mirror shipment row for Shopify external fulfillments, directly in the route file (advisory-locked, idempotency-checked — but still shipment-state creation in a controller). |
| `server/routes/shopify.routes.ts:647` | sql.INSERT `wms.outbound_shipments` | Second external-fulfillment mirror insert path. |
| `server/routes/diagnostics.ts:54,73` | sql.DELETE `wms.order_items`, `wms.orders` | POST `/api/_internal/diagnostics/cleanup-duplicates-normalized` — hard-deletes duplicate WMS orders/items inline in the route. |
| `server/routes/diagnostics.ts:115,130` | sql.DELETE `wms.order_items`, `wms.orders` | POST `/api/_internal/diagnostics/cleanup-duplicates` — same, legacy variant. |
| `server/routes/diagnostics.ts:29` | sql.UPDATE `inventory.inventory_transactions` (`SET voided_at=NOW()`) | Voids ledger rows inline in the route (soft-void, C5-compliant, but ledger mutation from a controller). |
| `server/routes/diagnostics.ts:268` | sql.UPDATE `wms.orders` (via `sql.raw`) | POST release-stuck-orders — mutates `warehouse_status` from the route. |
| `server/routes/shopify.routes.ts:1624,1690` | dz.insert `oms.webhook_retry_queue` | Webhook enqueue from route (arguably acceptable inbox-pattern, still a direct controller write). |

### 3.2 Channel/catalog/config route writes

- `server/modules/catalog/catalog.routes.ts` — **22 sites**: dz.update/insert on `catalog.products` (:537, :668, :1709), `catalog.shipping_groups` (:562, :590), `catalog.product_categories` (:618, :655), `catalog.product_assets` (:1084, :2269, :2367 delete, :2429; sql.UPDATE :2262, :2286, :2400, :2446), `catalog.product_variants` (:1724), `channels.channel_feeds` (:1730, :1749), `channels.channel_listings` (:1765, :1784; sql.DELETE :980, :2016).
- `server/modules/channels/channels.routes.ts` — 6 sites: `channels.channel_warehouse_assignments` (:2237, :2266, :2286), `channels.channel_allocation_rules` (:2429, :2481, :2511).
- `server/routes/ebay-listing-rules.routes.ts` — 5 sites: `catalog.products` (:154; sql :197), `ebay.ebay_listing_rules` (:253, :306, :362).
- `server/routes/ebay-oauth.routes.ts:109` — dz.insert `channels.channels`.
- `server/routes/ebay-settings.routes.ts` — `channels.channel_connections` (:78, :319, :360).
- `server/routes/ebay/ebay-config.routes.ts` — sql.INSERT `ebay_category_mappings` (:214, :446; unqualified), sql.UPDATE `catalog.products` (:367).
- `server/routes/ebay/ebay-listing-state.ts` — 10 sites: `catalog.products` (:52), `channels.channel_product_overrides` (:57), `catalog.product_variants` (:86), `channels.channel_variant_overrides` (:91), 6× sql.UPDATE `channels.channel_listings` (:113–:196).
- `server/routes/ebay/ebay-listings.routes.ts` — sql.UPDATE `channel_listings` (:1844, :1881; unqualified).
- `server/routes/ebay/ebay-policies.routes.ts` — `catalog.products` (:90), `catalog.product_variants` (:122), `catalog.product_assets` (:288), delete `channels.channel_listings` (:378).
- `server/routes/ebay/ebay-pricing.routes.ts` — `channels.channel_pricing_rules` (:94, :100, :105, :141 delete).
- `server/routes/ebay/ebay-sync-helpers.ts` — `channels.channel_listings` (:34 insert, :108 update).
- `server/routes/ebay/ebay-taxonomy.routes.ts` — 8 sites: `ebay.ebay_category_aspects` (:311 delete, :323), `ebay.ebay_type_aspect_defaults` (:393 delete, :407), `ebay.ebay_product_aspect_overrides` (:470 delete, :484).
- `server/routes/pick-priority.routes.ts` — sql.INSERT `warehouse.echelon_settings` (:183), sql.UPDATE `membership.plans` (:277), sql.UPDATE `channels.channels` (:294, :303).

---

## 4. HOT-COLUMN ANALYSIS — every mutation site repo-wide (server/)

Method: for each write site on the owning table, the full statement text was scanned for the column key (`status:` / `SET status =` etc.). `insert(initial)` = the write creates rows with an explicit value for the column; `update.set` = mutates existing rows.

### 4.1 `oms.oms_orders.status` — 19 sites, 4 writer locations
Canonical writer should be OMS. Actual:
- **modules/oms** (13): `channel-fulfillment.service.ts:150`; `oms-webhooks.ts:1665, 2005, 2100`; `oms.service.ts:175 (insert initial), 484, 506`; `shipstation.service.ts:2420, 2444, 2854`; sql: `ebay-order-ingestion.ts:260`; `oms-flow-reconciliation.service.ts:1069, 1131`; `wms-sync.service.ts:1722`.
- **modules/orders (WMS!)** (1): `fulfillment.service.ts:523` — sets `status='shipped'` from the Shopify-fulfillment path.
- **modules/dropship** (1): `dropship-order-acceptance.repository.ts:728` — raw INSERT with initial status.
- **server/index (startup/reconcilers)** (3): `:857` (eBay reconcile, hourly, sets `shipped`), `:1372`, `:1424` (ShipStation reconcile, every 10 min, sets `shipped`/`cancelled`).
- **server/db** (1, other columns): `db.ts:632` UPDATE oms_orders is engine-column backfill only (no status change) — verified `shipping_engine`/`engine_order_ref` set.

### 4.2 `oms.oms_orders.financial_status` — 5 sites, 2 modules
- **modules/oms**: `oms-webhooks.ts:1665, 2005` (update); `oms.service.ts:175` (insert initial); `ebay-order-ingestion.ts:286` (sql UPDATE).
- **modules/dropship**: `dropship-order-acceptance.repository.ts:728` (raw INSERT initial).

### 4.3 `wms.orders.warehouse_status` — 10 sites, 3 locations
- **modules/orders** (6): `combining.service.ts:971, 997`; `orders.storage.ts:885`; sql: `order-status-core.ts:178` (the intended status-transition core, uses `sql.raw(fromList)` guard); `shipment-rollup.ts:843, 876`.
- **modules/oms** (3): `wms-sync.service.ts:807` (dz), `wms-sync.service.ts:1046` (sql), `oms-webhooks.ts:1726` (sql) — OMS writing WMS execution state directly.
- **server/routes/** (1): `diagnostics.ts:268` — admin release-stuck-orders.

### 4.4 `wms.outbound_shipments.status` — 21 sites, 6 locations
- **modules/orders** (7): `fulfillment.service.ts:107, 329` (insert initial), `:654` (update); `shipment-rollup.ts:279, 426, 700, 1007` (sql; the markShipmentShipped/Cancelled/Voided helpers).
- **modules/oms** (6): `shipstation.service.ts:1532, 2746` (insert initial), `:2634, :3823` (sql update).
- **modules/wms** (1): `line-item-hold.ts:65` (insert initial; `:121` updates only the orthogonal `held` flag, not `status` — verified).
- **server/index** (5 status-setting of 11 total shipment writes): `:950, :958` (OMS/WMS reconcile, hourly — cancels), `:1004` (one-time repair — cancels orphans), `:1115` (one-time dup cleanup), `:1275` (ShipStation reconcile, 10 min).
- **server/db** (2): `db.ts:647, :657` — startup repair: retires `status='on_hold'` rows to `shipped`/`cancelled` (Phase 1c backfill, idempotent).
- **server/routes/** (2): `shopify.routes.ts:412, 647` — insert `status='shipped'` mirror rows.

### 4.5 `inventory.inventory_levels` quantity columns
- `variant_qty`: **modules/inventory** `infrastructure/inventory.repository.ts:341, 359 (update), 367 (upsert insert)`; **modules/channels** `catalog-backfill.service.ts:867` (insert initial). Also `break-assembly.use-cases.ts:612/632` mutate levels via dynamic payloads (column keys built at runtime — see §6).
- `reserved_qty`: same repository sites **plus** `modules/dropship` `dropship-order-acceptance.repository.ts:866` — raw `SET reserved_qty = reserved_qty + $1` (bypasses `reserveForOrder()`).
- `picked_qty`: repository upsert (:367), `catalog-backfill.service.ts:867`, **plus** `server/scripts/fix_orphaned_picks.ts:35` — raw repair `SET picked_qty = <active>`.
- `packed_qty` / `backorder_qty`: only the upsert insert sites (`inventory.repository.ts:367`, `catalog-backfill.service.ts:867`).
- Row deletion (zero-bucket cleanup): `inventory.repository.ts:681` (dz.delete), `inventory.use-cases.ts:1018` (sql, unqualified `inventory_levels`), `catalog.storage.ts:238` (dz.delete on variant merge), `server/db.ts:550` (startup zombie-row DELETE).

### 4.6 Reservation quantity columns
- `channels.channel_reservations.reserve_base_qty`: single writer module — `server/modules/channels/channels.storage.ts:258 (update via spread payload), :264 (insert), :269 (delete)`. No other writers found. (Column regex shows 0 direct hits because the payload is spread — verified by reading the function.)
- WMS reservation flow (`reserved_qty` on levels) — see 4.5: modules/inventory repository + the dropship raw-SQL bypass.

---

## 5. SCRIPTS & STARTUP WRITES

### 5.1 `server/db.ts` (runs at every boot — "fallback startup migrations", idempotent DDL + data repairs)
- `:278, :284, :291, :407, :580` — seed inserts (`catalog.product_lines`, `catalog.product_line_products`, `channels.channel_product_lines`, `catalog.product_types`, `sync_settings`).
- `:550` — DELETE zombie `inventory.inventory_levels` (all buckets zero, no bin assignment). Recurring every boot.
- `:632` — UPDATE `oms.oms_orders` engine-column backfill (`shipping_engine='shipstation'`).
- `:639, :647, :657, :668` — UPDATE `wms.outbound_shipments`: engine-column backfill; `held` backfill; **Phase 1c on_hold retirement (rewrites `status` to `shipped`/`cancelled`)**; clears stray `held`.
- `:802, :834, :872` — UPDATE `inventory_lots` (unqualified): COGS cents→mills backfills + PR5 mills-drift repair (money columns). `:843` — UPDATE `oms.order_item_costs` mills backfill.
All are one-time-in-effect (idempotent WHERE guards) but execute on every boot.

### 5.2 `server/index.ts` (20 raw-SQL writes)
Recurring reconcilers (guarded by `schedulersDisabled(...)` env kill-switches):
- **eBay stuck-order reconcile** (boot +5 s, then hourly): `:857` UPDATE `oms.oms_orders` → `shipped` for channel 67 orders confirmed >2 h whose engine says shipped.
- **OMS/WMS reconcile** (boot +15 s, then hourly): `:918` UPDATE `wms.orders` (release picker), `:950, :958` UPDATE `wms.outbound_shipments` (cancel divergent/orphaned).
- **ShipStation reconcile V1/V2** (boot +30 s, then every 10 min): `:1263–:1311, :1469, :1489` UPDATE `wms.outbound_shipments`; `:1372, :1424, :1560` UPDATE `oms.oms_orders`; `:1406` UPDATE `oms.oms_order_lines`; `:1322, :1440` INSERT `oms.oms_order_events`.
One-time boot repairs (setTimeout, no interval):
- `:987` block — `:990` UPDATE `wms.order_items` (complete items on shipped orders; wms_order_id-bug repair), `:1004` UPDATE `wms.outbound_shipments` (cancel orphaned planned/queued).
- `:1077` block — `:1115` UPDATE `wms.outbound_shipments` (duplicate-shipment cleanup).
- `:1140` block — sort_rank recompute (writes via services, no direct SQL captured).

### 5.3 `server/scripts/`
- `fix_orphaned_picks.ts:35, 43` — UPDATE `inventory.inventory_levels.picked_qty` + INSERT `inventory.inventory_transactions` (manual repair script, transactional, writes audit rows). One-shot, run by hand.
- `check_picked.ts`, `auth-audit.ts` — read-only. `fix_all_routes.ts`, `fix_routes.ts`, `fix_esc.cjs` — source-code fixers, no DB. `test_mark_shipped.ts` — drives service methods (indirect writes through modules/orders paths).

### 5.4 `server/seed.ts`
- `:23` dz.insert `warehouse.product_locations` (dev seeding).

### 5.5 `server/jobs/`
- No direct DB writes in job files. `auto-draft.job.ts` / `procurement-health-escalation.job.ts` write procurement tables via services; e.g. `public.auto_draft_runs` is written only by `server/modules/procurement/procurement.storage.ts:1897 (insert), :1902 (update)` — single-writer.

### 5.6 `server/middleware/`
- `idempotency.ts:46 (insert), :56 (update)` — `public.idempotency_keys`. Single-writer; infrastructure concern, acceptable.

---

## 6. METHOD NOTES & GAPS (confidence calibration for the synthesizer)

What the sweep **covers with high confidence**:
- All literal drizzle `.insert/.update/.delete(tableIdent)` calls, including `tx.*` variants, import aliases (`purchaseOrders as purchaseOrdersTable`), schema alias exports (`wmsOrders = orders`), and the two dynamic-import destructure sites in `channels/sync.service.ts:369, 392` (manually resolved to `channels.sync_log`).
- All literal raw-SQL statements naming a table after `INSERT INTO` / `UPDATE` (incl. `UPDATE t alias SET`) / `DELETE FROM` / `TRUNCATE`, in both `sql\`\`` templates and `client.query()` strings.

Known blind spots / caveats:
1. **Unqualified raw-SQL table refs** rely on the connection `search_path` (e.g., `UPDATE inventory_lots` in `server/db.ts`, `UPDATE oms_orders` in `orders.storage.ts:1497`, `INSERT INTO channels` in `identity.repository.ts:155`). I mapped bare names to their unique schema match; if production `search_path` differs, `identity.repository.ts:155` (`INSERT INTO channels …`) could target a different table than the `channels.channels` it reads three lines earlier — flagged as suspect.
2. **Column-level hot-column detection** reads the statement text; writes through **spread/dynamic payloads** (e.g., `.set({ ...reservation })` in `channels.storage.ts:258`, `.set(updates)` patterns, break-assembly's computed level mutations) are captured at table level but not column level. Hot-column lists are therefore lower bounds; table-level writer sets are complete.
3. **Comment/string false positives**: 2 TRUNCATE prose matches excluded; 1 comment line (`shopify-order-reconciliation.ts:227` "Insert into shopify_orders…") counted alongside the real insert at :251 — same file/module, so writer attribution unaffected.
4. **Dynamic SQL via `sql.raw()`**: audited all 11 uses — they interpolate ID lists/column names/limits, never table names, except `diagnostics.ts:267` and `order-status-core.ts:184` which wrap full statements already counted. No dynamic-table writes exist.
5. **Out of scope**: repo-root one-off scripts (`fix_orders.cjs`, `clear_neg.cjs`, `migrate-*.ts`, dozens more at `/home/user/Echelon/*.{ts,cjs,js}`) also contain writes — they are not part of `server/` runtime but can and do touch production data when run by hand; the 49 "zero-writer" tables (esp. `membership.*` rewards/club) may be written by those scripts or by an external app. `client/` contains no DB access (API-only).
6. **Writes through services counted once**: attribution is by the file containing the SQL, not the HTTP entry point; a route calling a service is not a route-layer write (only literal writes in controller files are in §3).
7. Raw-only tables missing from `shared/schema/`: `inventory.cost_adjustment_log` (cogs.service.ts:313/446/920), `membership.shopify_metafield_outbox` (shipping-group-sync.ts:61), `public.shopify_orders` / `public.shopify_order_items` (shopify-order-reconciliation.ts:251/295 — money columns `*_cents` written outside any schema validation).

Artifacts alongside this report: `matrix.json` (full site-level data), `drizzle-writes.json`, `raw-sql-writes.json`, `hot-columns.json`, `ident-map.json`, `scan.mjs`/`aggregate.mjs` (reproducible method).
