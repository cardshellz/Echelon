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