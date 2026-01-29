# Echelon - Operations Management System

## Overview

Echelon is a full-stack operations management system designed to provide end-to-end control for warehouse operations, from product purchase to fulfillment. It covers order ingestion, wave/batch planning, picking, packing, and shipping, aiming to be a central hub for efficiency and accuracy. The system supports Progressive Web App features and is built as a modern web application. Echelon manages inventory tracking, order processing, and warehouse operations, functioning as the source of truth for inventory and facilitating multi-channel sales and dropship partner integrations.

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
Echelon uses a hub-and-spoke pattern for multi-channel orders:
- **Raw tables** (`shopify_orders`, `ebay_orders`): Store FULL order data from each channel
- **Operational table** (`orders`): Contains ONLY fields needed for warehouse operations
- **Linkage**: `orders.sourceTableId` links to raw tables for JOIN lookups when full data is needed

Key tables:
- `users`: Authentication with role-based access
- `catalog_products`: **Master product catalog (PIM)** - internal `id` is the source of truth for product identity. Contains shopifyVariantId as sync metadata.
- `product_locations`: Product to warehouse bin mapping. **Supports multi-location storage** - products can be stored in multiple bins with `isPrimary` (1=primary pick location, 0=secondary) and `locationType` (forward_pick, bulk_storage, overflow) fields. Uses `catalogProductId` as primary link (internal ID is source of truth, not SKU or shopifyVariantId)
- `orders`: ALL orders from all channels with operational fields (sourceTableId, customerName, shipping address, priority, status, itemCount, unitCount)
- `order_items`: ALL items with **requiresShipping** flag per item. Has optional `catalogProductId` for analytics (doesn't affect order creation)
- `picking_logs`: Audit trail with optional `catalogProductId` for analytics
- `shopify_orders`, `shopify_order_items`: Full Shopify data (billing address, financials, notes, tags, variant info, pricing, properties, **requires_shipping**) - populated by external shellz_club app

**Product Identity Architecture:**
- `catalog_products.id` is the **internal source of truth** for product identity
- `shopifyVariantId` is metadata from Shopify sync, not a structural dependency
- Products can exist without SKUs (many Shopify products don't have SKUs assigned)
- All product relationships (locations, analytics) link via `catalogProductId`

**Order Routing:**
- ALL orders go into `orders` table (shipping + non-shipping like memberships)
- `order_items.requiresShipping` flag per item (1 = needs fulfillment, 0 = digital/membership)
- Source of truth: `shopify_order_items.requires_shipping`
- Pick queue filters by items with `requiresShipping = 1` - only shows orders needing picking
- Non-shipping orders auto-complete with status "completed"

### Authentication & Authorization
- Session-based authentication using `express-session`.
- Role-Based Access Control (RBAC) with `auth_roles`, `auth_permissions`, `auth_role_permissions`, and `auth_user_roles` tables. Permissions follow a `resource:action` pattern. System roles include Administrator, Team Lead, and Picker.

### Navigation Structure
The application features a left sidebar for operational sections (Dashboard, Warehouse, Orders, Fulfillment, Sales Channels) and a top-right gear menu for admin settings (General Settings, Integrations, User Management, Roles & Permissions).

### Application Settings
Configurable settings are stored in the `app_settings` table and managed via a UI (`/settings` page) and API. Settings cover company info, default warehouse, stock thresholds, picking defaults, and notification preferences.

### Inventory Management System (WMS)
Echelon acts as the source of truth for inventory, managing on-hand and available-to-promise (ATP) calculations. It supports base unit tracking, UOM variants, and a multi-location model (Forward Pick, Bulk Storage, Receiving Dock) with replenishment chains. Inventory states include On Hand, Reserved, Picked, Packed, Shipped, and ATP.
- **Dual-Level Inventory Tracking**: Tracks `variantQty` (physical count) and `onHandBase` (derived smallest unit count).
- **Hierarchical Warehouse Locations**: Uses a 5-level hierarchy (Zone, Aisle, Bay, Level, Bin) with smart display logic. Supports various location types (bin, pallet, carton_flow, bulk_reserve, receiving, etc.) with associated pick types.
- **Core WMS functionalities**: Extended database schema for inventory, allocation service, ATP calculation, variant cascading, replenishment, backorder handling, and a robust Shopify sync.
- **ATP Calculation**: ATP = Total On-Hand (ALL locations) - Reserved - Picked. Includes bulk storage, forward pick, and all other locations regardless of `isPickable` flag.
- **Pickable Qty**: Operational metric showing inventory in forward pick locations only (`is_pickable=1`). Used for same-day ship capability planning.
- **Multi-Tier Replenishment**: Schema supports `parentLocationId` for direct location chaining and `replenSourceType` for location-type-based replenishment (e.g., forward_pick → bulk_storage). Uses `minQty`/`maxQty` thresholds for automated alerts.

### Picking Logs (Audit Trail)
A comprehensive, append-only `picking_logs` table captures all picking actions for auditing. It includes timestamps, action types, picker info, order context, item details, quantities, and status snapshots, allowing for querying and generation of order timelines.

## External Dependencies

### Database
- **PostgreSQL**: Primary database. Drizzle Kit for schema migrations.

### Third-Party Libraries
- **@tanstack/react-query**: Server state management.
- **drizzle-orm / drizzle-zod**: Database ORM and schema generation.
- **date-fns**: Date formatting.
- **recharts**: Chart components.
- **Radix UI**: Accessible UI component primitives.

### Shopify Integration
Echelon integrates with Shopify for product and order synchronization. It uses sync and webhook endpoints for real-time updates and supports split shipments, tracking fulfilled quantities. Requires `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`, and `SHOPIFY_API_SECRET`.

### Multi-Channel Infrastructure
Supports multi-channel sales and dropship partner management through dedicated UI and API.
- **Channel Management UI (`/channels`)**: Grid view of connected channels, quick actions, and detail modals for settings, connection, and partner info.
- **Channel Reserves UI (`/channels/reserves`)**: View and manage inventory allocations across channels with filtering and threshold settings.
- **Channel Management API**: Manages `channels` (internal/partner, provider, status), `channel_connections`, and `partner_profiles`.
- **Inventory Allocation**: `channel_reservations` for priority stock allocation with `reserve_base_qty`, `min_stock_base`, and `max_stock_base`.
- **Catalog Management**: `catalog_products`, `catalog_assets`, `channel_product_overrides`, `channel_variant_overrides`, `channel_asset_overrides`, `channel_pricing`, and `channel_listings` for managing product content and pricing per channel.
- **ATP Calculation with Reserves**: Calculates Global ATP and Channel ATP based on on-hand inventory and channel-specific reserves.

### Application Settings
Echelon uses its own `echelon_settings` table (key-value pattern) separate from the legacy `app_settings` table used by shellz_club. This avoids conflicts with other apps sharing the same database.

### Receiving Subsystem
The receiving system handles inventory intake from vendors and supports initial inventory loads:
- **Vendors**: Supplier tracking with contact info, terms, and metadata
- **Receiving Orders**: Header records with status workflow (draft → open → closed)
- **Receiving Lines**: Line items with expected/received quantities and put-away location assignment
- **CSV Bulk Import**: Upload CSV files (format: `sku,qty,location`) for initial inventory load - looks up variants by SKU, creates receiving lines, and assigns warehouse locations
- **Inventory Updates**: When a receiving order is closed, it creates inventory_transactions for audit trail and updates inventory_levels at the put-away locations
- **Navigation**: Accessible via Purchasing → Receiving in the sidebar