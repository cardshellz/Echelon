# Echelon - Operations Management System

## Overview

Echelon is a full-stack operations management system designed for end-to-end control from product purchase to fulfillment, including inventory tracking, order processing, and warehouse operations. The application follows a standard warehouse lifecycle: order ingestion, wave/batch planning, picking, packing, and shipping. It's built as a modern web application with a React frontend and Express backend, using PostgreSQL for data persistence.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight React router)
- **State Management**: TanStack React Query for server state and data fetching
- **UI Components**: shadcn/ui component library built on Radix UI primitives
- **Styling**: Tailwind CSS with CSS variables for theming
- **Charts**: Recharts for data visualization
- **Build Tool**: Vite

The frontend follows a page-based structure with reusable components:
- `/client/src/pages/` - Page components (Dashboard, Inventory, Orders, Picking, Locations, etc.)
- `/client/src/components/ui/` - shadcn/ui component library
- `/client/src/components/layout/` - Layout components (AppShell with sidebar navigation)
- `/client/src/lib/` - Utilities, API client, and query client configuration

### Backend Architecture
- **Framework**: Express.js with TypeScript
- **Database ORM**: Drizzle ORM with PostgreSQL
- **API Design**: RESTful API endpoints under `/api/` prefix
- **Session Storage**: PostgreSQL-backed sessions via connect-pg-simple

The backend follows a clean separation:
- `/server/index.ts` - Express app setup and middleware
- `/server/routes.ts` - API route definitions
- `/server/storage.ts` - Data access layer implementing IStorage interface
- `/server/db.ts` - Database connection configuration

### Shared Layer
- `/shared/schema.ts` - Drizzle schema definitions and Zod validation schemas shared between frontend and backend

### Database Schema
Main tables:
1. **users** - Authentication with role-based access (id, username, password, role, displayName, active, createdAt, lastLoginAt)
2. **product_locations** - SKU to warehouse location mapping (id, sku, name, location, zone, updatedAt)
3. **orders** - Order tracking with picking workflow status
4. **order_items** - Line items for each order with picking progress

Location format follows warehouse convention: Zone-Aisle-Rack-Bin (e.g., "A-01-02-B")

### Authentication & Authorization
- **Session-based auth** using express-session with cookie storage
- **Roles**: admin, lead, picker
- **Route protection**: Pickers only see Picking page; admins/leads see full navigation
- **Default users**:
  - admin / admin123 (full access)
  - picker1 / picker123 (picking only)

### Build System
- Development: Vite dev server with HMR for frontend, tsx for backend
- Production: esbuild bundles server code, Vite builds static frontend assets
- Output: `/dist/` directory with `index.cjs` (server) and `/dist/public/` (static assets)

### PWA Support
The application includes Progressive Web App configuration with a manifest.json for installability on mobile devices, targeting warehouse floor workers using scanners.

## External Dependencies

### Database
- **PostgreSQL** - Primary database, connection via `DATABASE_URL` or `EXTERNAL_DATABASE_URL` environment variable
- Drizzle Kit for schema migrations (`npm run db:push`)

**IMPORTANT: External Database Migrations**
- The app uses `EXTERNAL_DATABASE_URL` (Heroku) in production, not the built-in Replit database
- Schema changes must be applied to the external database manually:
  ```bash
  psql "$EXTERNAL_DATABASE_URL" -c "ALTER TABLE table_name ADD COLUMN column_name TYPE;"
  ```
- The `npm run db:push` command only updates the local development database
- Always verify schema changes against the external database before testing

### Third-Party Libraries
- **@tanstack/react-query** - Server state management
- **drizzle-orm** / **drizzle-zod** - Database ORM with Zod schema generation
- **date-fns** - Date formatting utilities
- **recharts** - Chart components for dashboard visualizations
- **Radix UI** - Accessible component primitives (dialog, dropdown, tabs, etc.)

### Development Tools
- **tsx** - TypeScript execution for development
- **esbuild** - Production server bundling
- **Vite** - Frontend build tool with React plugin

### Replit-Specific Integrations
- `@replit/vite-plugin-runtime-error-modal` - Error overlay in development
- `@replit/vite-plugin-cartographer` - Development tooling
- `@replit/vite-plugin-dev-banner` - Development environment indicator
- Custom `vite-plugin-meta-images` - OpenGraph image handling for Replit deployments

### Shopify Integration
- **Sync Endpoint**: `POST /api/shopify/sync` - Fetches all products from Shopify, upserts SKUs to product_locations, and deletes orphaned SKUs
- **Order Sync**: `POST /api/shopify/sync-orders` - Fetches unfulfilled orders and also runs fulfillment status sync
- **Fulfillment Sync**: `POST /api/shopify/sync-fulfillments` - Checks all active orders against Shopify and marks fulfilled/cancelled orders
- **Webhook Endpoints**: 
  - `POST /api/shopify/webhooks/products/create` - Handles new product creation
  - `POST /api/shopify/webhooks/products/update` - Handles product updates
  - `POST /api/shopify/webhooks/products/delete` - Handles product deletion
  - `POST /api/shopify/webhooks/orders/create` - Handles new order creation
  - `POST /api/shopify/webhooks/orders/cancelled` - Handles order cancellation
  - `POST /api/shopify/webhooks/fulfillments/create` - **Auto-ships orders when fulfilled in Shopify (via Shipstation)**
  - `POST /api/shopify/webhooks/fulfillments/update` - Handles fulfillment status updates
- **Environment Variables Required**:
  - `SHOPIFY_SHOP_DOMAIN` - Store domain (either "card-shellz" or "card-shellz.myshopify.com" - both formats work)
  - `SHOPIFY_ACCESS_TOKEN` - Admin API access token with read_products scope
  - `SHOPIFY_API_SECRET` - API secret (shpss_ prefix) used for webhook HMAC verification
- New SKUs are created with location "UNASSIGNED" and zone "U" until manually assigned
- **Fulfillment Flow**: 
  - When Shipstation ships items, it updates Shopify's fulfillment_status
  - Shopify sends a `fulfillments/create` webhook to Echelon with line-item details
  - Echelon tracks `fulfilledQuantity` for each order_item (how many units have been shipped)
  - An order is marked "shipped" only when ALL tracked physical items are fully fulfilled
  - This supports **split shipments** - if an order has 3 items but only 2 ship, it stays in the queue until the 3rd ships
  - Digital items (memberships, etc.) are excluded during import, so partial fulfillments with only digital items remaining are handled correctly

## IMPLEMENTED: Inventory Management System (WMS)

### Status: Phase 1 Complete ✅
All Phase 1 deliverables have been implemented and are operational.

### Architecture Overview
The WMS is now the source of truth for inventory. Echelon owns on-hand/ATP calculations, and syncs to Shopify.

### Core Principles
1. **Base Unit Tracking** - All inventory stored as base units (individual items)
2. **WMS is Source of Truth** - Echelon owns on-hand/ATP, Shopify reflects what we push
3. **UOM Variants** - Same product sold at different pack sizes (P1, P100, B500, C10000)
4. **Implicit Movements** - System auto-calculates inventory movements from picker actions (for now)

### SKU Hierarchy Model
Each product has a base SKU with sellable variants at different pack levels:
```
Base SKU: EG-STD-SLV (Easy Glide Standard Sleeve)
├── EG-STD-SLV-P1     (Pack of 1)      - units_per: 1
├── EG-STD-SLV-P100   (Pack of 100)    - units_per: 100
├── EG-STD-SLV-B500   (Box of 500)     - units_per: 500
└── EG-STD-SLV-C10000 (Case of 10000)  - units_per: 10000
```

**Availability Calculation:** `available = floor(base_units / units_per_variant)`

### Location Model
- **One SKU variant per location** - No mixing eaches and cases in same bin
- **Location types**: Forward Pick (pickable), Bulk Storage (not pickable), Receiving Dock
- **Replenishment chain**: Bulk → Pickable Pallet → Case Bin → Each Bin
- Example: P1 location depleted → replenish from B25 location (open 1 box = 25 P1 units)

### Inventory States (Buckets)
| Bucket | Description |
|--------|-------------|
| On Hand | Total physical units in warehouse |
| Reserved | Allocated to orders, waiting to be picked |
| Picked | In picker's cart |
| Packed | Boxed, awaiting ship (future) |
| Shipped | Gone from warehouse (future) |
| ATP | Available-to-Promise = On Hand (pickable) - Reserved |

### Order Lifecycle & Inventory Flow
1. **Order Created (Shopify)** → Reserve base units, recalc ATP, push sibling variants to Shopify
2. **Picker Claims** → No inventory change
3. **Item Scanned** → Move from Reserved → Picked
4. **Order Complete** → Move from Picked → Shipped, deduct On Hand

### Shopify Sync Strategy
- **Push absolute numbers** (not deltas) to prevent drift
- **On order received**: Push SIBLING variants only (Shopify already decremented the sold variant)
- **On PO received / adjustment**: Push ALL variants
- **Nightly reconciliation**: Pull Shopify, compare to our ATP, overwrite mismatches, alert anomalies

### Implicit Movement (Current Phase)
System auto-calculates movements without extra picker scans:
- Picker picks P1 but location empty → System auto-replenishes from B25, logs transaction
- Picker picks case from pallet → System deducts from pallet location
- All movements logged for audit trail

**Movement Policy Matrix**: Each movement type has strictness level (implicit, soft log, require scan). Can dial up over time.

### Business Rules Confirmed
- No loose items - use P1 SKUs for singles
- Case/inner pack breaking is normal - auto-logged
- Allow negative inventory → triggers backorder status
- Multi-location support required
- Shopify variant deletion does NOT delete our inventory (alert + break channel link)
- Large orders: partial ship + backorder remainder
- Bulk-to-pickable moves CAN require scans now

### Database Tables Needed
1. **inventory_items** - Master SKU with base unit, cost, etc.
2. **uom_variants** - Sellable SKUs with conversion factors, parent/child hierarchy
3. **inventory_levels** - Qty per location (on_hand, reserved, picked, packed, atp in base units)
4. **inventory_transactions** - Ledger of all movements (picks, receipts, adjustments, breaks)
5. **locations** - Warehouse locations with type, is_pickable, parent location (replenishment chain)
6. **channel_feeds** - Maps UOM variants to Shopify variant IDs for sync

### Phase 1 Deliverables (COMPLETED)
1. ✅ Extended database schema (6 tables: warehouse_locations, inventory_items, uom_variants, inventory_levels, inventory_transactions, channel_feeds)
2. ✅ Core inventory service (allocation, ATP calculation, variant cascade, replenishment, backorder handling)
3. ✅ Shopify sync with sibling variant updates (via channel feeds, syncs after picks and order creation)
4. ✅ WMS tab with stock dashboard, adjustments, item/variant/location views
5. ✅ Wire picking to auto-decrement inventory (UOM-aware conversions, location priority)

### WMS API Endpoints
- `GET /api/inventory/summary` - Full inventory summary with ATP calculations
- `GET /api/inventory/items` - All inventory items
- `POST /api/inventory/items` - Create inventory item
- `GET /api/inventory/variants` - All UOM variants
- `POST /api/inventory/variants` - Create UOM variant
- `GET /api/inventory/locations` - All warehouse locations
- `POST /api/inventory/locations` - Create warehouse location
- `GET /api/inventory/levels` - All inventory levels
- `POST /api/inventory/levels` - Upsert inventory level
- `POST /api/inventory/adjust` - Manual inventory adjustment
- `POST /api/inventory/receive` - Receive inventory from PO
- `POST /api/inventory/replenish` - Move stock from bulk to pick location
- `GET /api/inventory/replenishment-needed` - Get locations below min qty
- `GET /api/inventory/backorder-status/:itemId` - Check backorder status
- `GET /api/inventory/transactions/:itemId` - Audit trail for an item
- `GET /api/inventory/channel-feeds` - Channel feed mappings
- `POST /api/inventory/sync-shopify` - Sync inventory levels to Shopify

### How Inventory Flows
1. **Order Created (Shopify webhook)** → Reserve base units, push sibling variants to Shopify
2. **Picker Claims** → No inventory change
3. **Item Picked** → Decrement onHand, release reserved, increment picked; sync to Shopify
4. **Order Shipped** → Decrement picked (item leaves building)

### Key Service Functions (server/inventory.ts)
- `calculateATP()` - ATP = onHand (pickable) - reserved
- `calculateVariantAvailability()` - floor(ATP / unitsPerVariant) for each variant
- `reserveForOrder()` - Increase reserved bucket
- `pickItem()` - Decrement onHand, release reserved, increment picked
- `recordShipment()` - Decrement picked
- `receiveInventory()` - Add to onHand
- `adjustInventory()` - Manual adjustment (cycle count, write-off)
- `replenishLocation()` - Move stock from parent (bulk) to child (pickable) location
- `checkBackorderStatus()` - Check if ATP < 0
- `getLocationsNeedingReplenishment()` - Find locations below minQty