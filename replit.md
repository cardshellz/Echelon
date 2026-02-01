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

### Picking Logs (Audit Trail)
An append-only `picking_logs` table captures all picking actions for auditing, including timestamps, action types, picker info, order context, item details, quantities, and status snapshots.

### Inventory Transactions Ledger
The `inventory_transactions` table is an append-only ledger for a complete inventory movement audit trail. It tracks `receipt`, `pick`, `adjustment`, `transfer`, `ship`, `return`, `replenish`, `reserve`, `unreserve`, and `csv_upload` transaction types with `from_location_id`, `to_location_id`, `variant_qty_delta`, and `source_state`/`target_state` fields.

### Receiving Subsystem
The receiving system handles inventory intake from vendors. It includes `vendors`, `receiving_orders` (with workflow), `receiving_lines` (with expected/received quantities and put-away location), and CSV bulk import functionality. Closing a receiving order generates `inventory_transactions` and updates `inventory_levels`.

### Replenishment Subsystem
Automates inventory flow from bulk to forward pick locations using a product-centric design. `replen_rules` define product-level configurations (`catalogProductId`, `minQty`/`maxQty`, `replenMethod`). `replen_tasks` are generated as a work queue for warehouse workers, determining source and destination locations dynamically.

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