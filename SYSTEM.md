# Echelon System Map

> Auto-generated reference of everything that's built. Read this before touching anything.

## Stack
- **Frontend:** React + Vite + Tailwind CSS + shadcn/ui
- **Backend:** Express + TypeScript + Drizzle ORM
- **Database:** PostgreSQL (Heroku Postgres)
- **Hosting:** Heroku (`cardshellz-echelon`)
- **Build:** `npx vite build`

---

## Database Tables (130+ tables)

### Core Catalog
| Table | Rows | Purpose |
|-------|------|---------|
| `products` | 188 | Master product catalog (51 columns) |
| `product_variants` | 313 | SKU-level variants (36 columns including `ebay_listing_excluded`) |
| `product_types` | 16 | Product type lookup (slug-based) |
| `product_assets` | 326 | Product images |
| `product_collections` | 45 | Collection assignments |
| `product_lines` | 0 | Product line groupings |
| `product_locations` | 224 | Warehouse location assignments |

### Channels & Sync
| Table | Rows | Purpose |
|-------|------|---------|
| `channels` | 1 | Channel definitions (Shopify=36, eBay=67) |
| `channel_connections` | 1 | OAuth/API credentials per channel |
| `channel_feeds` | 589 | Per-variant channel sync state (last_synced_qty, channel_inventory_item_id) |
| `channel_listings` | 294 | Product listings per channel |
| `channel_pricing` | 293 | Per-channel pricing overrides |
| `channel_variant_overrides` | 0 | **Per-variant channel overrides (is_listed, name, sku, barcode, weight)** |
| `channel_product_overrides` | 0 | Per-product channel overrides (isListed, name, description) |
| `channel_allocation_rules` | 5 | Inventory allocation rules per channel |
| `channel_product_allocation` | 0 | Manual product-channel allocation |
| `channel_asset_overrides` | 0 | Per-channel image overrides |
| `channel_warehouse_assignments` | 3 | Which warehouses feed which channels |
| `channel_reservations` | 1 | Inventory reservations per channel |
| `channel_sync_log` | 304k | Sync event history |
| `allocation_audit_log` | 106k | Allocation decision audit trail |
| `source_lock_config` | 20 | Field-level source lock (Echelon vs channel) |
| `sync_settings` | 1 | Global sync configuration |
| `sync_log` | 99k | Legacy sync log |

### eBay
| Table | Rows | Purpose |
|-------|------|---------|
| `ebay_oauth_tokens` | 1 | eBay OAuth tokens (channel_id=67) |
| `ebay_category_mappings` | 16 | Product type → eBay browse/store category mapping |
| `ebay_category_aspects` | 28 | Cached eBay item specifics per category (24h TTL) |
| `ebay_type_aspect_defaults` | 1 | Default aspect values per product type |
| `ebay_product_aspect_overrides` | 0 | Per-product aspect value overrides |
| `ebay_listing_rules` | 2 | eBay listing automation rules |

### OMS (Order Management)
| Table | Rows | Purpose |
|-------|------|---------|
| `oms_orders` | 2774 | **Unified order table** — all channels normalize here |
| `oms_order_lines` | 7035 | Order line items |
| `oms_order_events` | 2786 | Order lifecycle events |

### WMS / Legacy Orders
| Table | Rows | Purpose |
|-------|------|---------|
| `orders` | 54k | WMS orders (legacy, being migrated to oms_orders) |
| `order_items` | 1439 | WMS order items |
| `shopify_orders` | 54k | Raw Shopify order mirror |
| `shopify_order_items` | 149k | Raw Shopify line items |

### Inventory
| Table | Rows | Purpose |
|-------|------|---------|
| `inventory_levels` | 318 | Current stock by variant + warehouse location |
| `inventory_lots` | 54 | Lot tracking (cost, expiry) |
| `inventory_transactions` | 11k | **Full audit trail** — every qty change |

### Procurement
| Table | Rows | Purpose |
|-------|------|---------|
| `purchase_orders` | 4 | Purchase orders |
| `purchase_order_lines` | 11 | PO line items (order_qty, received_qty, unit_cost) |
| `receiving_orders` | 6 | Receiving sessions |
| `receiving_lines` | 263 | Per-line receiving (expected_qty, received_qty, putaway_location) |
| `po_receipts` | 7 | Receipt summaries |
| `po_status_history` | 20 | PO status audit trail |
| `vendors` | 2 | Vendor master |
| `vendor_products` | 4 | Vendor catalog |
| `vendor_invoices` | 5 | AP invoices |
| `vendor_invoice_lines` | 13 | Invoice line items |
| `ap_payments` | 3 | Payments to vendors |

### Warehouse
| Table | Rows | Purpose |
|-------|------|---------|
| `warehouse_locations` | 235 | Bin/shelf locations |
| `warehouse_zones` | 0 | Zone definitions |
| `warehouse_settings` | 0 | Per-warehouse config |

### Picking / Fulfillment
| Table | Rows | Purpose |
|-------|------|---------|
| `picking_logs` | 11k | Pick history |
| `combined_order_groups` | 4 | Multi-order combining |
| `shipments` | 0 | Shipment tracking |
| `shipment_costs` | 3 | Shipping costs |
| `fulfillment_routing_rules` | 0 | Order routing rules |

### Membership (Shellz Club)
| Table | Rows | Purpose |
|-------|------|---------|
| `members` | 273 | Member profiles |
| `member_subscriptions` | 279 | Subscription records |
| `member_current_membership` | 273 | Active plan lookup |
| `plans` | 5 | Membership tiers |
| `reward_ledger` | 642 | Points/rewards transactions |
| `reward_redemptions` | 375 | Reward claims |

### Notifications
| Table | Rows | Purpose |
|-------|------|---------|
| `notifications` | 0 | Notification queue |
| `notification_preferences` | 0 | User preferences |
| `back_in_stock_subscriptions` | 152 | Restock alerts |

---

## Server Modules

### `/server/modules/channels/` — Channel Management
| File | Lines | Purpose |
|------|-------|---------|
| `allocation-engine.service.ts` | 585 | **Inventory allocation** — determines how much stock goes to each channel. ⚠️ Does NOT check `channel_variant_overrides.is_listed` |
| `echelon-sync-orchestrator.service.ts` | 1141 | **THE sync engine** — allocate → push inventory to channels. Scheduled + on-demand |
| `product-push.service.ts` | 500 | Push product catalog data to channels. Uses `channel_variant_overrides` for `is_listed` |
| `channel-catalog.storage.ts` | 308 | CRUD for channel_product_overrides, channel_variant_overrides, channel_feeds |
| `channels.storage.ts` | 613 | Channel connections, config, settings storage |
| `reservation.service.ts` | 772 | Channel inventory reservations |
| `scheduled-sync.service.ts` | — | Cron-based sync scheduling |
| `sync.service.ts` | — | Legacy sync service |
| `sync-settings.service.ts` | — | Sync configuration |
| `source-lock.service.ts` | — | Field-level source lock (Echelon vs channel ownership) |
| `catalog-backfill.service.ts` | — | Backfill catalog from Shopify |

### `/server/modules/channels/adapters/` — Channel Adapters
| File | Purpose |
|------|---------|
| `shopify.adapter.ts` | Shopify API adapter (inventory push, catalog push) |
| `ebay.adapter.ts` | eBay adapter (stub/partial) |
| `ebay/ebay-api.client.ts` | eBay API HTTP client |
| `ebay/ebay-auth.service.ts` | eBay OAuth2 token management |
| `ebay/ebay-category-map.ts` | Category mapping utilities |
| `ebay/ebay-listing-builder.ts` | Build eBay listing payloads |

### `/server/modules/inventory/` — Inventory Management
| File | Lines | Purpose |
|------|-------|---------|
| `core.service.ts` | 1007 | **Core inventory operations** — receive, adjust, transfer, reserve, break/assemble |
| `inventory.routes.ts` | 2574 | All inventory REST endpoints |
| `inventory.storage.ts` | — | Inventory data access |
| `atp.service.ts` | — | Available-to-promise calculations |
| `lots.service.ts` | — | Lot tracking |
| `cycle-count.service.ts` | — | Cycle count operations |
| `alerts.service.ts` | — | Low stock / reorder alerts |
| `break-assembly.service.ts` | — | Unit break/assembly (cases→eaches) |
| `replen.service.ts` | — | Replenishment rules engine |
| `source.service.ts` | — | Shopify inventory source sync |

### `/server/modules/procurement/` — Purchasing & Receiving
| File | Lines | Purpose |
|------|-------|---------|
| `purchasing.service.ts` | — | PO creation, approval, management |
| `receiving.service.ts` | 667 | **Receiving operations** — create receive, close (updates inventory), `completeAllLines()` |
| `procurement.routes.ts` | — | All procurement REST endpoints |
| `procurement.storage.ts` | — | PO/receiving data access |
| `shipment-tracking.service.ts` | — | Inbound shipment tracking + landed cost |
| `ap-ledger.service.ts` | — | Accounts payable |

### `/server/modules/oms/` — Order Management System
| File | Purpose |
|------|---------|
| `oms.service.ts` | OMS operations (create, update, status) |
| `shopify-bridge.ts` | Shopify → oms_orders bridge (pg LISTEN/NOTIFY) |
| `ebay-order-ingestion.ts` | eBay → oms_orders (webhook + 5-min polling) |
| `shipstation.service.ts` | ShipStation push + webhook handling |
| `fulfillment-push.service.ts` | Push tracking to origin channel |

### `/server/modules/orders/` — WMS Order Operations
| File | Purpose |
|------|---------|
| `picking.service.ts` | Pick list generation |
| `picking.routes.ts` | Picking REST endpoints |
| `pick-queue-sync.ts` | ⚠️ Floods logs every ~15s |
| `fulfillment.service.ts` | Fulfillment operations |
| `fulfillment-router.service.ts` | Order routing engine |
| `combining.service.ts` | Multi-order combining |
| `returns.service.ts` | Return processing |
| `sla-monitor.service.ts` | SLA tracking |
| `operations-dashboard.service.ts` | Ops dashboard aggregations |
| `order-sync-listener.ts` | Shopify order webhook listener |

### `/server/routes/` — Top-Level Routes
| File | Lines | Purpose |
|------|-------|---------|
| `ebay-channel.routes.ts` | 1805 | **eBay channel page** — listing feed, push, aspects, category mapping |
| `ebay-oauth.routes.ts` | — | eBay OAuth2 flow |
| `ebay-settings.routes.ts` | — | eBay settings |
| `ebay-listing-rules.routes.ts` | — | eBay listing automation rules |
| `oms.routes.ts` | — | OMS endpoints |
| `shopify.routes.ts` | — | Shopify webhooks + endpoints |

---

## Client Pages

### Core
| Page | Purpose |
|------|---------|
| `Dashboard.tsx` | Main dashboard |
| `CatalogPage.tsx` | Product catalog browser |
| `ProductDetail.tsx` | Single product view |
| `Inventory.tsx` | Inventory management |
| `InventoryHistory.tsx` | Transaction audit trail |

### Channels
| Page | Purpose |
|------|---------|
| `ChannelsPage.tsx` | Channel overview |
| `ChannelAllocation.tsx` | Inventory allocation rules |
| `EbayChannelPage.tsx` | **eBay channel** — category mapping, listing feed, aspects, push |
| `EbaySettings.tsx` | eBay connection settings |
| `SyncLogPage.tsx` | Sync history viewer |

### Orders & Fulfillment
| Page | Purpose |
|------|---------|
| `OmsOrders.tsx` | Unified OMS order view |
| `Orders.tsx` | WMS orders (legacy) |
| `OperationsView.tsx` | Operations dashboard |
| `PickingPage.tsx` | Pick queue |
| `PickingLogs.tsx` | Pick history |
| `Returns.tsx` | Returns processing |

### Procurement
| Page | Purpose |
|------|---------|
| `PurchaseOrders.tsx` | PO list |
| `PurchaseOrderDetail.tsx` | PO detail + line items |
| `Receiving.tsx` | **Receiving modal** — receive against POs |
| `Suppliers.tsx` | Vendor management |
| `InboundShipments.tsx` | Shipment tracking |
| `APInvoices.tsx` / `APPayments.tsx` | Accounts payable |

### Warehouse
| Page | Purpose |
|------|---------|
| `WarehousePage.tsx` | Warehouse overview |
| `WarehouseLocations.tsx` | Bin management |
| `BinAssignments.tsx` | Bin assignment |
| `CycleCounts.tsx` | Cycle count sessions |
| `Replenishment.tsx` | Replenishment tasks |

### Components
| Directory | Purpose |
|-----------|---------|
| `components/ebay/` | `EbayCategoryPicker.tsx`, `AspectEditor.tsx` |
| `components/layout/` | App shell, navigation |
| `components/operations/` | Ops dashboard widgets |
| `components/ui/` | shadcn/ui primitives |

---

## Key Data Flows

### Inventory Sync: Echelon → Shopify
```
inventory_levels (warehouse qty)
  → allocation-engine.service.ts (allocate per channel rules)
  → echelon-sync-orchestrator.service.ts (orchestrate push)
  → shopify.adapter.ts (Shopify Inventory API)
  → channel_feeds.last_synced_qty (record sync)
```
⚠️ **BUG:** Allocation engine does NOT check `channel_variant_overrides.is_listed`. Unlisted variants still get inventory pushed.

### Receiving: PO → Inventory
```
PO → receiving_orders → receiving_lines (expected_qty, received_qty)
  → receiving.service.ts close() → inventory core receiveInventory()
  → inventory_levels updated → inventory_transactions logged
  → sync triggered → Shopify updated
```
⚠️ **BUG:** `completeAllLines()` sets `receivedQty = expectedQty`, overriding user input.

### eBay Order Flow
```
eBay webhook/polling → ebay-order-ingestion.ts → oms_orders
  → shipstation.service.ts (push to ShipStation)
  → ship_notify webhook → fulfillment-push (tracking to eBay)
```

### eBay Listing Push
```
listing-feed (products + category + aspects) → push endpoint
  → create inventory item (PUT) → create offer (POST) → publish offer
  → channel_listings updated
```
Aspects resolved: product override → type default → auto-mapped (Brand)

### Shopify Order Flow
```
Shopify webhook → shopify_orders → shopify-bridge.ts (LISTEN/NOTIFY)
  → oms_orders → (future: WMS pick queue)
```

---

## Known Bugs & Issues

1. ~~Allocation engine ignores `channel_variant_overrides.is_listed`~~ — **FIXED** (commit `c6ff769`). Now checks both variant and product overrides.
2. ~~`completeAllLines()` overrides received qty~~ — **FIXED** (commit `54cef28`). Now honors user-entered qty.
3. **WMS pick-queue-sync floods logs** — full JSON payloads every ~15s
4. **Heroku release phase SSL error** — drizzle-kit push fails (`pg_hba.conf`), non-blocking
5. **`channel_variant_overrides` table has 0 rows** — override save may not be working from UI

---

## External Integrations

| Service | Status | Key Details |
|---------|--------|-------------|
| **Shopify** | ✅ Active | Channel 36, real-time sync via orchestrator |
| **eBay** | 🔨 Building | Channel 67, OAuth2, listing push in progress |
| **ShipStation** | ✅ Active | Push eBay orders, ship_notify webhook |
| **Google Analytics** | ✅ Active | GA4 property 416552071 |

---

## Important IDs

| Entity | ID |
|--------|-----|
| Shopify channel | 36 |
| eBay channel | 67 |
| ShipStation warehouse | 996884 |
| ShipStation Manual Orders store | 319989 |
| eBay merchant location | `card-shellz-hq` |
| eBay fulfillment policy | 254926236019 |
| eBay return policy | 254575298019 |
| eBay payment policy | 254415953019 |

---

*Last updated: 2026-03-19*
