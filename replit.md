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
Automates inventory flow from bulk to forward pick locations using a two-tier architecture:

**Tier Defaults (`replen_tier_defaults`)**: Define replenishment rules by UOM hierarchy level. Each default specifies:
- `hierarchyLevel`: Target UOM tier (1=each, 2=pack, 3=case, 4=pallet)
- `sourceHierarchyLevel`: Source UOM tier to replenish from
- `pickLocationType` / `sourceLocationType`: Location types for source and destination
- `minQty` / `maxQty`: Trigger thresholds
- `replenMethod`: case_break, full_case, or pallet_drop
- `priority`: Lower = higher priority when multiple defaults match

**SKU Overrides (`replen_rules`)**: Product-specific exceptions that override tier defaults. Null fields inherit from the matching tier default.

**Generate Logic**: When generating tasks, the system:
1. Scans all products with inventory in forward pick locations below minQty
2. For each product, finds the highest-priority tier default where BOTH hierarchyLevel and sourceHierarchyLevel exist in the product's UOM variants
3. Applies any SKU-specific overrides (null fields fall back to tier default)
4. Creates replenishment tasks with source/destination locations

**Warehouse Settings (`warehouse_settings`)**: Configure warehouse-level replenishment behavior:
- `replenMode`: inline (pickers replen), queue (dedicated workers), hybrid (threshold-based)
- `shortPickAction`: What happens when picker finds empty bin
- `inlineReplenMaxUnits`: Threshold for hybrid mode
- Additional wave planning and pick path settings

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
- **drizzle-orm / drizzle-zod**: Database ORM and schema generation.
- **date-fns**: Date formatting.
- **recharts**: Chart components.
- **Radix UI**: Accessible UI component primitives.

### Shopify Integration
Integrates with Shopify for product and order synchronization using sync and webhook endpoints. Requires `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`, and `SHOPIFY_API_SECRET`.

### Multi-Channel Infrastructure
Supports multi-channel sales and dropship partner management through dedicated UI and API for `channels`, `channel_connections`, `partner_profiles`, and `channel_reservations`. It also includes comprehensive catalog management for product content and pricing per channel. Global and Channel ATP calculations incorporate channel-specific reserves.

### Email Alerts
- **SendGrid**: Optional for email notifications when `SENDGRID_API_KEY` is configured.