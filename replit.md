# Echelon - Operations Management System

## Overview

Echelon is a full-stack operations management system designed to provide end-to-end control for warehouse operations, from product purchase to fulfillment. It covers order ingestion, wave/batch planning, picking, packing, and shipping, aiming to be a central hub for efficiency and accuracy. The system supports Progressive Web App features and is built as a modern web application. Echelon manages inventory tracking, order processing, and warehouse operations, functioning as the source of truth for inventory and facilitating multi-channel sales and dropship partner integrations.

## User Preferences

Preferred communication style: Simple, everyday language.
Database: Uses EXTERNAL database (EXTERNAL_DATABASE_URL), NOT Replit's built-in database. Do not reference Replit Database pane for production issues - provide SQL directly.

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

### Database Schema
Key tables include `users` for authentication, `product_locations` for SKU mapping, `orders` for unified OMS, and `order_items` for line items with picking progress. The `orders` table is a multi-channel OMS table, storing comprehensive information including channel linkage, customer details, shipping/billing addresses, financial data, channel status, shipping methods, warehouse operational fields, item/unit counts, notes, timestamps, and exception handling. The `order_items` table enhances line-item details with product info, quantities, pricing, flags, warehouse operational fields, product specifics, picking status, and metadata.

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