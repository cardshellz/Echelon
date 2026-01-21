# Echelon - Operations Management System

## Overview

Echelon is a full-stack operations management system designed for end-to-end control from product purchase to fulfillment, including inventory tracking, order processing, and warehouse operations. It covers the standard warehouse lifecycle: order ingestion, wave/batch planning, picking, packing, and shipping. The application is built as a modern web application with a React frontend, an Express backend, and uses PostgreSQL for data persistence. Echelon aims to be the central hub for all warehouse operations, improving efficiency and accuracy from receiving to shipping. The system also supports Progressive Web App features for enhanced usability on warehouse floor devices.

## User Preferences

Preferred communication style: Simple, everyday language.

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
- **Schema & Validation**: Drizzle schema definitions and Zod validation schemas shared between frontend and backend.

### Database Schema
Key tables include `users` (authentication with role-based access), `product_locations` (SKU to warehouse location mapping), `orders` (tracking picking workflow status), and `order_items` (line items with picking progress).

### Authentication & Authorization
- Session-based authentication using `express-session`.
- Default users: admin/admin123 and picker1/picker123.

#### Role-Based Access Control (RBAC)
The system implements a flexible, database-driven RBAC system with the following components:

**Database Tables:**
- `auth_roles`: Custom roles created by admin (e.g., "Warehouse Manager", "Inventory Clerk")
- `auth_permissions`: Individual permissions as `resource:action` pairs
- `auth_role_permissions`: Links roles to their allowed permissions
- `auth_user_roles`: Assigns roles to users (supports multiple roles per user)

**Permission Model:**
Permissions follow a `resource:action` pattern for easy extension:
| Resource | Actions | Description |
|----------|---------|-------------|
| dashboard | view | Dashboard access |
| inventory | view, create, edit, adjust, upload, receive | Inventory management |
| orders | view, claim, edit, cancel, hold, priority, resolve_exception | Order management |
| picking | view, perform, complete | Picking operations |
| channels | view, create, edit, sync, delete | Multi-channel management |
| reports | view, export | Reporting access |
| users | view, create, edit, delete, manage_roles | User administration |
| roles | view, create, edit, delete | Role management |
| settings | view, edit | System settings |

**System Roles (built-in, cannot be deleted):**
- Administrator: Full system access
- Team Lead: Manage picking operations and resolve exceptions
- Picker: Perform picking operations only

**Implementation:**
- Backend: `requirePermission(resource, action)` middleware on API routes
- Frontend: `hasPermission()` and `hasAnyPermission()` helpers in auth context
- Admin UI: `/roles` page for creating roles, editing permissions, and assigning to users

### Inventory Management System (WMS)
Echelon acts as the source of truth for inventory, managing on-hand and available-to-promise (ATP) calculations. It supports base unit tracking, UOM variants, and a multi-location model (Forward Pick, Bulk Storage, Receiving Dock) with replenishment chains. Key inventory states include On Hand, Reserved, Picked, Packed, Shipped, and ATP. The system implements implicit inventory movements based on picker actions and provides a robust Shopify sync strategy for inventory levels.

#### Dual-Level Inventory Tracking
The system tracks inventory at two levels simultaneously:
- **Variant Quantity (variantQty)**: Physical count of variant units (e.g., "5 boxes") for receiving, cycle counts, and warehouse operations
- **Base Units (onHandBase)**: Derived count in smallest unit (e.g., "2,500 pieces") for purchasing, ATP calculations, and order fulfillment
- Receiving flow accepts variant-level quantities and automatically calculates base units: `baseUnits = variantQty × unitsPerVariant`
- Example: Receiving 5 boxes of SKU-B500 (500 pieces per box) → variantQty=5, onHandBase=2500

Core WMS functionalities:
- Extended database schema for inventory management (inventory_items, uom_variants, inventory_levels, inventory_transactions, locations, channel_feeds).
- Inventory service for allocation, ATP calculation, variant cascading, replenishment, and backorder handling.
- Shopify sync with sibling variant updates.
- WMS UI for stock dashboard, adjustments, item/variant/location views.
- Integration of picking process with inventory decrementing (UOM-aware conversions, location priority).

### Picking Logs (Audit Trail)
A comprehensive, append-only `picking_logs` database table captures all picking actions. This includes timestamps, action types (e.g., order_claimed, item_picked), picker information, order context, item details, quantities, and status snapshots. An API provides querying capabilities for logs and generates order timelines with metrics like Queue Wait Time and Pick Time.

## External Dependencies

### Database
- **PostgreSQL**: Primary database. Drizzle Kit is used for schema migrations.

### Third-Party Libraries
- **@tanstack/react-query**: Server state management.
- **drizzle-orm / drizzle-zod**: Database ORM and schema generation.
- **date-fns**: Date formatting.
- **recharts**: Chart components.
- **Radix UI**: Accessible UI component primitives.

### Shopify Integration
Echelon integrates with Shopify for product and order synchronization.
- **Sync Endpoints**: For fetching products, unfulfilled orders, and fulfillment statuses.
- **Webhook Endpoints**: Handles real-time updates for product creation/update/deletion, order creation/cancellation, and fulfillment creation/update.
- **Environment Variables**: Requires `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`, and `SHOPIFY_API_SECRET`.
- **Fulfillment Flow**: Supports split shipments and tracks fulfilled quantities per item, marking an order shipped only when all physical items are fulfilled.

### Multi-Channel Infrastructure
The system includes full UI and API support for multi-channel sales and dropship partner management:

#### Channel Management UI (`/channels`)
- **Sales Channels Page**: Grid view of connected channels with status indicators
- **Channel Cards**: Show provider icon, name, status, sync status, last sync time
- **Quick Actions**: Toggle active/paused, view connection details, delete
- **Channel Detail Modal**: Tabs for Settings, Connection, and Partner Info
- **Create Channel**: Add new internal stores or partner/dropship channels

#### Channel Reserves UI (`/channels/reserves`)
- **Reserves Table**: View all inventory allocations across channels
- **Channel Filter**: Filter reserves by specific channel
- **Create Reserve**: Allocate inventory items to channels with min/max stock thresholds
- **Summary Cards**: Active channels count, total reserves, total reserved units

#### Channel Management API
- **channels**: Core entity for all sales channels (internal stores and partner stores)
  - `type`: "internal" (your stores) or "partner" (dropship partners)
  - `provider`: shopify, ebay, amazon, etsy, manual
  - `status`: active, paused, pending_setup, error
- **channel_connections**: API credentials and sync status per channel
- **partner_profiles**: Extra info for dropship partners (company, contact, SLA, discounts)

#### Inventory Allocation
- **channel_reservations**: Priority stock allocation per channel per inventory item
  - `reserve_base_qty`: Base units reserved exclusively for this channel
  - `min_stock_base`: Alert threshold
  - `max_stock_base`: Cap availability

#### Catalog Management
- **catalog_products**: Master listing content (title, description, bullets, SEO)
- **catalog_assets**: Master media library (images, videos)
- **channel_product_overrides**: Per-channel product content customization (NULL = use master)
- **channel_variant_overrides**: Per-channel variant customization (name, SKU, barcode)
- **channel_asset_overrides**: Per-channel media customization (hide/show, reorder)
- **channel_pricing**: Per-channel, per-variant pricing
- **channel_listings**: External IDs after pushing to marketplace

All override and allocation tables enforce uniqueness constraints (one row per channel+entity) to ensure correct ATP calculations and sync operations.

#### ATP Calculation with Reserves
```
Global ATP = On Hand Base - Reserved Base - Sum(Channel Reserves)
Channel ATP = floor((Global ATP + Channel Reserve) / units_per_variant)
```

This architecture supports internal multi-channel sales and future dropship partner integrations without schema rework.