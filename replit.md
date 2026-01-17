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
- Role-based access control with `admin`, `lead`, and `picker` roles.
- Default users: admin/admin123 and picker1/picker123.

### Inventory Management System (WMS)
Echelon acts as the source of truth for inventory, managing on-hand and available-to-promise (ATP) calculations. It supports base unit tracking, UOM variants, and a multi-location model (Forward Pick, Bulk Storage, Receiving Dock) with replenishment chains. Key inventory states include On Hand, Reserved, Picked, Packed, Shipped, and ATP. The system implements implicit inventory movements based on picker actions and provides a robust Shopify sync strategy for inventory levels.

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