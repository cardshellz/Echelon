# Echelon - Operations Management System

## Overview
Echelon is a full-stack operations management system providing end-to-end control for warehouse operations, from product purchase to fulfillment. It covers order ingestion, wave/batch planning, picking, packing, and shipping. Echelon aims to be a central hub for efficiency and accuracy, functioning as the source of truth for inventory and facilitating multi-channel sales and dropship partner integrations. It supports Progressive Web App features.

## User Preferences
Preferred communication style: Simple, everyday language.
Database: Uses EXTERNAL database (EXTERNAL_DATABASE_URL), NOT Replit's built-in database. Do not reference Replit Database pane for production issues - provide SQL directly.
Testing: ALWAYS test on PRODUCTION (Heroku). Development database is empty/unused.

## System Architecture

### Frontend
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter
- **State Management**: TanStack React Query
- **UI Components**: shadcn/ui built on Radix UI
- **Styling**: Tailwind CSS
- **Charts**: Recharts
- **Build Tool**: Vite

### Backend
- **Framework**: Express.js with TypeScript
- **Database ORM**: Drizzle ORM with PostgreSQL
- **API Design**: RESTful API
- **Session Storage**: PostgreSQL-backed sessions
- **Route Organization**: Domain-specific route files under `server/routes/`:
  - `middleware.ts` — shared middleware (requireAuth, requirePermission, requireInternalApiKey, upload, syncPickQueueForSku)
  - `auth.routes.ts` — auth, users, roles, permissions
  - `locations.routes.ts` — product locations CRUD, CSV import/export
  - `picking.routes.ts` — picking queue, picking ops, picking logs, order management, combining, exceptions
  - `shopify.routes.ts` — Shopify sync, backfill, webhooks
  - `warehouse.routes.ts` — warehouses, zones, routing rules, warehouse locations, warehouse settings
  - `products.routes.ts` — products CRUD, variants, assets, bin assignments
  - `inventory.routes.ts` — inventory ops, adjustments, bootstrap, catalog products, break/assembly, returns, reservations, channel sync, alerts, lots
  - `channels.routes.ts` — channel management, OMS, allocation, product lines
  - `settings.routes.ts` — app settings, adjustment reasons, cycle counts
  - `purchasing.routes.ts` — vendors, receiving, replenishment, POs, invoices, AP, payments, operations dashboard, SLA, notifications
  - `routes.ts` — thin dispatcher that imports and calls all domain registrars

- **Storage Layer**: Domain-split modules under `server/storage/`:
  - `base.ts` — shared `db` re-export and schema imports
  - `users.ts` — user CRUD
  - `product-locations.ts` — product location assignments, bin lookups
  - `orders.ts` — orders, order items, fulfillment, exceptions
  - `warehouse.ts` — warehouses, zones, warehouse locations
  - `products.ts` — products, variants, assets, archive helpers
  - `channel-catalog.ts` — channel product/variant/pricing/listing overrides
  - `inventory.ts` — inventory levels, transactions, transfers, adjustment reasons, channel feeds
  - `picking-logs.ts` — picking audit trail, metrics
  - `order-history.ts` — order history queries, order detail
  - `channels.ts` — channels, connections, partner profiles, reservations
  - `settings.ts` — echelon app settings
  - `cycle-counts.ts` — cycle counts and items
  - `replenishment.ts` — tier defaults, rules, location configs, tasks, warehouse settings
  - `procurement.ts` — vendors, receiving, POs, lots, costs, inbound shipments
  - `index.ts` — composes all domains into `IStorage` interface and `storage` singleton
  - `server/storage.ts` — thin re-export for backward compatibility

### Shared Layer
- **Schema & Validation**: Drizzle schema definitions and Zod validation schemas.

### Database Schema (Hub-and-Spoke Architecture)
Echelon uses a hub-and-spoke pattern for multi-channel orders with raw tables for full channel data and an `orders` table for operational fields. `catalog_products` is the single source of truth for product identity, identified by `catalog_products.id`.

### Authentication & Authorization
Session-based authentication with Role-Based Access Control (RBAC) using `express-session` and dedicated auth tables (`auth_roles`, `auth_permissions`, etc.). Permissions follow a `resource:action` pattern.

### Navigation Structure
The application features a left sidebar for operational sections (Dashboard, Warehouse, Orders, Fulfillment, Sales Channels) and a top-right gear menu for admin settings.

### Application Settings
Configurable settings are stored in the `app_settings` table (key-value) and managed via a UI and API.

### Inventory Management System (WMS)
Echelon acts as the source of truth for inventory, managing on-hand and available-to-promise (ATP) calculations. It supports base unit tracking, UOM variants, and a multi-location model (Forward Pick, Bulk Storage, Receiving Dock) with replenishment chains. Inventory states include On Hand, Reserved, Picked, Packed, Shipped, and ATP. ATP calculation is based on total on-hand minus reserved and picked quantities across all locations. Pickable quantity is an operational metric for inventory in forward pick locations.

### Variant Migration (In Progress)
The system is migrating from `uom_variants` (legacy) to `product_variants` (new). Current state:
- **Mapping table**: `uom_to_pv_mapping` maps all 198 uom_variant IDs to product_variant IDs by SKU
- **Dual-write**: All dependent tables now have both legacy columns and new `product_variant_id` columns
- **Backfilled**: All existing data in inventory_levels, inventory_transactions, catalog_products, receiving_lines has both IDs populated
- **Storage layer**: `createInventoryLevel`, `upsertInventoryLevel`, `createInventoryTransaction`, `executeTransfer` all dual-write to both columns
- **Phase**: Code still primarily reads from uom_variants. Next phase will switch reads to product_variants, then drop legacy columns.
- **Key difference**: `product_variants` links to `products` table (not `inventory_items`), has Shopify options, pricing, and cleaner types (boolean instead of integer for active)
- Tables migrated: inventory_levels, inventory_transactions, catalog_products, receiving_lines, channel_feeds, channel_listings, channel_pricing, channel_variant_overrides, replen_rules, replen_tasks

### Dimensional Standards (Cube-Based Capacity)
All physical dimensions use **millimeters (mm)** for consistency and clean integer math:
- `warehouse_locations`: `width_mm`, `height_mm`, `depth_mm`, `capacity_cubic_mm`, `max_weight_g`
- `product_variants`: `length_mm`, `width_mm`, `height_mm`, `weight_grams` (replaces uom_variants dimensions)

Capacity calculation: `max_units = floor(location.capacity_cubic_mm / variant_cubic_mm)`. This allows the same bin to correctly hold different quantities based on item size (e.g., 100 packs OR 10 cases). Weight constraints use grams (g). Replenishment triggers (minQty/maxQty) live in `replen_rules`, not on locations.

### Picking Logs (Audit Trail)
An append-only `picking_logs` table captures all picking actions for auditing, including timestamps, action types, picker info, order context, item details, quantities, and status snapshots.

### Inventory Transactions Ledger
The `inventory_transactions` table is an append-only ledger for a complete inventory movement audit trail. It tracks `receipt`, `pick`, `adjustment`, `transfer`, `ship`, `return`, `replenish`, `reserve`, `unreserve`, and `csv_upload` transaction types with `from_location_id`, `to_location_id`, `variant_qty_delta`, and `source_state`/`target_state` fields.

### Receiving Subsystem
The receiving system handles inventory intake from vendors. It includes `vendors`, `receiving_orders` (with workflow), `receiving_lines` (with expected/received quantities and put-away location), and CSV bulk import functionality. Closing a receiving order generates `inventory_transactions` and updates `inventory_levels`.

### Replenishment Subsystem
Fully event-driven — replenishment triggers automatically on any inventory change, not via scheduled batch scans. Automates inventory flow from bulk to forward pick locations.

**Architecture** (Fix #6 — event-driven refactor):
- `checkReplenForLocation(locationId)` — lightweight wrapper that checks all variants assigned to a pickable bin
- `checkReplenNeeded(variantId, locationId)` — single source of truth for threshold evaluation
- `checkAndTriggerAfterPick(variantId, locationId)` — inline trigger during picking (creates + optionally auto-executes tasks)
- `createAndExecuteReplen(variantId, locationId)` — creates a task and optionally auto-executes it
- Shared resolution helpers: `resolveReplenParams()`, `calculateQtyNeeded()`, `checkThreshold()`, `loadLocationConfig()`
- No scheduler, no batch scanners — all replen is reactive

**Config Resolution** (most-specific wins):
1. `location_replen_config` — per-location, optionally per-variant overrides
2. `replen_rules` — SKU-specific overrides
3. `replen_tier_defaults` — hierarchy-level defaults (warehouse-specific > global)

**Event Triggers** — `checkReplenForLocation` fires after:
- Manual adjustments, stock adds, stock adjustments (inventory.routes.ts)
- Bin-to-bin transfers (source location checked)
- CSV inventory uploads (all affected locations)
- Receiving put-away (all putaway locations)
- Cycle count resolution (adjusted locations)
- Returns processing (restock location)
- Break/assembly conversions (target location)
- Picking already calls `checkAndTriggerAfterPick` directly

**Warehouse Settings (`warehouse_settings`)**: Configure warehouse-level replenishment behavior:
- `replenMode`: inline (pickers replen), queue (dedicated workers), hybrid (threshold-based)
- `shortPickAction`: What happens when picker finds empty bin
- `inlineReplenMaxUnits`: Threshold for hybrid mode

### Mock Data Removal (Fix #8)
All mock/demo data has been removed from the frontend:
- **Picking.tsx**: Deleted `createSingleOrderQueue`, `createInitialQueue` mock data blocks (~110 lines), `handleResetDemo` function, and all `isRealItem`/`isRealOrder` branching (22+ occurrences). All picking flows now use API paths exclusively. Queue initializes empty.
- **Dashboard.tsx**: Replaced mock chart data and mock inventory table with empty state components.
- **Dropship.tsx**: Replaced mock vendors and syncCatalog arrays with empty states.
- **Note**: Batch picking mode queue has no API hydration (pre-existing limitation — was always mock-driven). Single mode is fully API-driven.

### Audit Log Error Handling (Fix #9)
Audit log writes are now resilient — a failed log entry won't crash the main operation:
- **Picking logs** (service + routes): Already used fire-and-forget `.catch()` pattern (no change needed)
- **Picking log backfill route**: Now wraps each order in per-order try/catch; reports `ordersFailed` count in response
- **Reservation orphaned-release**: Transaction log write wrapped in try/catch; release operation continues if log fails
- **3PL inventory sync**: Transaction log write wrapped in try/catch; sync continues if log fails
- **Inventory-core `logTransaction`**: Intentionally left inside DB transactions — these are atomic with the operation (if log fails, operation rolls back, which is correct for inventory integrity)

### Order Combining
Allows grouping multiple orders to the same customer/address for efficient picking and shipping. The system:
- Automatically detects orders with matching addresses using normalized address hashing (email + normalized street/city/state/zip)
- Shows a "Combine" badge on the Orders page when combinable orders exist
- Provides a dialog to view and select orders to combine into a group
- Uses `combined_order_groups` table for group metadata and `combined_group_id`/`combined_role` fields on orders
- Parent/child relationship preserves original orders (non-destructive)

API Endpoints:
- `GET /api/orders/combinable` - Get orders grouped by address that can be combined
- `POST /api/orders/combine` - Create a combined order group
- `POST /api/orders/:id/uncombine` - Remove an order from its group
- `GET /api/orders/combined-groups` - Get all combined groups

Database migrations are stored in `migrations/` folder as numbered SQL files. Startup migrations in `server/db.ts` also ensure the required columns/tables exist as a fallback.

### Sync Health Monitoring
The system monitors order sync health and alerts when issues are detected via an API endpoint (`/api/sync/health`), a dashboard alert banner, and optional email alerts. Thresholds are configured for detecting sync gaps, unsynced orders, and consecutive errors.

## External Dependencies

### Database
- **PostgreSQL**: Primary database.

### Third-Party Libraries
- **@tanstack/react-query**: Server state management.
- **drizzle-orm 0.39.x / drizzle-zod 0.5.x**: Database ORM and schema generation. drizzle-zod pinned to 0.5.x for type compatibility with drizzle-orm 0.39.x (0.7.x breaks createInsertSchema type inference).
- **date-fns**: Date formatting.
- **recharts**: Chart components.
- **Radix UI**: Accessible UI component primitives.

### Shopify Integration
Integrates with Shopify for product and order synchronization using sync and webhook endpoints. Requires `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`, and `SHOPIFY_API_SECRET`.

### Multi-Channel Infrastructure
Supports multi-channel sales and dropship partner management through dedicated UI and API for `channels`, `channel_connections`, `partner_profiles`, and `channel_reservations`. It also includes comprehensive catalog management for product content and pricing per channel. Global and Channel ATP calculations incorporate channel-specific reserves.

### Email Alerts
- **SendGrid**: Optional for email notifications when `SENDGRID_API_KEY` is configured.