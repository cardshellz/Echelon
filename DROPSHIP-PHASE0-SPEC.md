# Dropship Platform — Phase 0 Technical Specification

> **Version:** 1.0  
> **Date:** 2026-03-22  
> **Author:** Systems Architecture  
> **Status:** Ready for Engineering  
> **Scope:** Phase 0 — Foundation (4 weeks)  
> **References:** `DROPSHIP-DESIGN.md` (Sections 1–17), `BOUNDARIES.md`, `SYSTEM.md`

---

## Table of Contents

1. [Phase 0 Scope Summary](#1-phase-0-scope-summary)
2. [Database Schema](#2-database-schema)
3. [API Endpoints](#3-api-endpoints)
4. [Vendor Auth System](#4-vendor-auth-system)
5. [Multi-Tenant eBay Integration](#5-multi-tenant-ebay-integration)
6. [Wallet & Stripe Integration](#6-wallet--stripe-integration)
7. [Dropship Order Flow](#7-dropship-order-flow)
8. [Vendor Portal Frontend](#8-vendor-portal-frontend)
9. [Admin UI (Echelon-Side)](#9-admin-ui-echelon-side)
10. [Existing System Changes](#10-existing-system-changes)
11. [Migration Plan](#11-migration-plan)
12. [Out of Scope (Deferred)](#12-out-of-scope-deferred)

---

## 1. Phase 0 Scope Summary

**Goal:** Prove the core loop — vendor connects eBay → products push to their store → customer buys → Card Shellz fulfills → tracking flows back.

**In scope:**
- Vendor portal (basic) — account management, product selection, wallet view, order history
- eBay OAuth flow — vendor connects their eBay account
- Multi-tenant eBay push — extend existing channel sync to push listings to vendor eBay accounts
- Stripe Customer Balance — vendor wallet funded via Stripe (saved ACH or card)
- Wallet ledger — deposits, debits, credits, full audit trail
- Dropship order ingestion — eBay orders from vendor accounts pulled into Echelon OMS
- 1-day ship SLA queue priority for dropship orders
- Card Shellz branded packing (no packing slips)
- Tracking push back to vendor's eBay

**Who's onboarded:** 2–3 hand-picked beta vendors (existing Shellz Club members with active eBay stores).

---

## 2. Database Schema

### 2.1 Naming Convention

The existing `vendors` table (in `procurement.schema.ts`) holds Card Shellz's **suppliers** — the companies Card Shellz buys inventory from. Dropship vendors are a completely different entity. To avoid collision, the dropship tables use the `dropship_` prefix.

### 2.2 New Table: `dropship_vendors`

Vendor accounts — separate from Echelon admin users and procurement suppliers.

```
dropship_vendors
├── id                          INTEGER PRIMARY KEY (generated always as identity)
├── name                        VARCHAR(200) NOT NULL
├── email                       VARCHAR(255) NOT NULL UNIQUE
├── password_hash               TEXT NOT NULL
├── company_name                VARCHAR(200)
├── phone                       VARCHAR(50)
│
├── shellz_club_member_id       INTEGER NOT NULL  → FK members(id)
├── status                      VARCHAR(20) NOT NULL DEFAULT 'pending'
│                                 -- enum: pending, active, suspended, closed
├── tier                        VARCHAR(20) NOT NULL DEFAULT 'standard'
│                                 -- enum: standard, pro, elite (derived from Shellz Club plan)
│
│ -- eBay OAuth (per-vendor credentials)
├── ebay_oauth_token            TEXT
├── ebay_refresh_token          TEXT
├── ebay_token_expires_at       TIMESTAMP
├── ebay_user_id                VARCHAR(100)
├── ebay_environment            VARCHAR(20) DEFAULT 'production'
│
│ -- Shopify (Phase 1 — columns exist but unused in Phase 0)
├── shopify_domain              VARCHAR(200)
├── shopify_access_token         TEXT
│
│ -- Stripe
├── stripe_customer_id          VARCHAR(100)
│
│ -- Wallet (cached balance — source of truth is the ledger)
├── wallet_balance_cents        INTEGER NOT NULL DEFAULT 0
│
│ -- Auto-reload config
├── auto_reload_enabled         BOOLEAN NOT NULL DEFAULT false
├── auto_reload_threshold_cents INTEGER DEFAULT 5000   -- $50.00
├── auto_reload_amount_cents    INTEGER DEFAULT 20000  -- $200.00
│
│ -- USDC (Phase 2+ — columns exist but unused)
├── usdc_wallet_address         VARCHAR(100)
├── usdc_approval_amount        NUMERIC(20,6)
│
├── created_at                  TIMESTAMP NOT NULL DEFAULT now()
└── updated_at                  TIMESTAMP NOT NULL DEFAULT now()

INDEXES:
  UNIQUE INDEX ON (email)
  UNIQUE INDEX ON (shellz_club_member_id)  -- one dropship account per member
  INDEX ON (status)
  INDEX ON (stripe_customer_id)
```

**Drizzle ORM type:** `dropshipVendors` in new file `shared/schema/dropship.schema.ts`

### 2.3 New Table: `dropship_wallet_ledger`

Every financial transaction for every vendor. Immutable append-only log — the source of truth for wallet balances.

```
dropship_wallet_ledger
├── id                    BIGINT PRIMARY KEY (generated always as identity)
├── vendor_id             INTEGER NOT NULL  → FK dropship_vendors(id)
├── type                  VARCHAR(30) NOT NULL
│                           -- enum: deposit, order_debit, refund_credit, return_credit,
│                           --       adjustment, withdrawal, auto_reload
├── amount_cents          INTEGER NOT NULL
│                           -- positive for credits (deposit, refund, return credit)
│                           -- negative for debits (order charge, withdrawal)
├── balance_after_cents   INTEGER NOT NULL
│                           -- running balance after this transaction
├── reference_type        VARCHAR(30)
│                           -- 'oms_order', 'return', 'stripe_payment', 'stripe_refund', 'manual'
├── reference_id          VARCHAR(100)
│                           -- oms_order.id, stripe payment_intent id, etc.
├── payment_method        VARCHAR(30)
│                           -- 'stripe_ach', 'stripe_card', 'usdc', 'manual'
├── stripe_payment_intent_id  VARCHAR(100)
│                           -- Stripe PaymentIntent ID for deposits (for reconciliation)
├── notes                 TEXT
├── created_by            VARCHAR(100)
│                           -- 'system', 'vendor:{id}', 'admin:{user_id}'
├── created_at            TIMESTAMP NOT NULL DEFAULT now()

INDEXES:
  INDEX ON (vendor_id, created_at DESC)
  INDEX ON (vendor_id, type)
  INDEX ON (reference_type, reference_id)
  INDEX ON (stripe_payment_intent_id)
```

**Immutability rule:** No UPDATE or DELETE on this table. Corrections are new rows with type `adjustment`.

### 2.4 New Table: `dropship_vendor_products`

Which products a vendor has selected to list on their eBay store.

```
dropship_vendor_products
├── id                    INTEGER PRIMARY KEY (generated always as identity)
├── vendor_id             INTEGER NOT NULL  → FK dropship_vendors(id)
├── product_id            INTEGER NOT NULL  → FK products(id)
├── enabled               BOOLEAN NOT NULL DEFAULT true
│                           -- vendor can toggle on/off without removing the row
├── ebay_listing_id       VARCHAR(50)
│                           -- eBay listing ID after push (null if not yet pushed)
├── ebay_offer_id         VARCHAR(50)
│                           -- eBay offer ID (used for inventory/price updates)
├── last_pushed_at        TIMESTAMP
│                           -- last time listing was pushed/updated on vendor's eBay
├── push_status           VARCHAR(20) DEFAULT 'pending'
│                           -- enum: pending, active, error, removed
├── push_error            TEXT
│                           -- last push error message (null if no error)
├── created_at            TIMESTAMP NOT NULL DEFAULT now()

INDEXES:
  UNIQUE INDEX ON (vendor_id, product_id)
  INDEX ON (vendor_id, enabled)
  INDEX ON (push_status)
```

### 2.5 Modified Table: `products`

Add one column for admin-level dropship eligibility control.

```
ALTER TABLE products ADD COLUMN dropship_eligible BOOLEAN NOT NULL DEFAULT false;
```

- Only products with `dropship_eligible = true` appear in the vendor product catalog
- Admin toggles this in the Echelon UI (new toggle on product pages)
- Default `false` — products must be explicitly opted in
- Does NOT affect existing Shopify/eBay channel sync — this is a dropship-only gate

### 2.6 Modified Table: `oms_orders`

Add vendor tracking columns to the existing OMS order table.

```
ALTER TABLE oms_orders ADD COLUMN vendor_id INTEGER REFERENCES dropship_vendors(id);
ALTER TABLE oms_orders ADD COLUMN order_source VARCHAR(30);
  -- Values: 'shopify', 'ebay', 'dropship_ebay', 'dropship_shopify', 'agent'
  -- NULL for legacy orders (backfill if desired)
ALTER TABLE oms_orders ADD COLUMN vendor_order_ref VARCHAR(100);
  -- Vendor's external order reference (eBay order ID from vendor's account)
ALTER TABLE oms_orders ADD COLUMN dropship_cost_cents INTEGER;
  -- Total cost charged to vendor (wholesale + shipping) for P&L reporting
```

```
CREATE INDEX idx_oms_orders_vendor ON oms_orders(vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX idx_oms_orders_source ON oms_orders(order_source);
```

### 2.7 Modified Table: `orders` (WMS)

Add vendor reference to WMS orders for pick/pack/ship visibility.

```
ALTER TABLE orders ADD COLUMN vendor_id INTEGER REFERENCES dropship_vendors(id);
ALTER TABLE orders ADD COLUMN order_source VARCHAR(30);
```

### 2.8 New Table: `dropship_channels`

Links a vendor's eBay account as a "channel" in Echelon's channel architecture, enabling reuse of the existing sync infrastructure.

```
dropship_channels
├── id                    INTEGER PRIMARY KEY (generated always as identity)
├── vendor_id             INTEGER NOT NULL  → FK dropship_vendors(id)
├── channel_id            INTEGER NOT NULL  → FK channels(id)
│                           -- Each vendor eBay account creates a new channel row
├── platform              VARCHAR(20) NOT NULL DEFAULT 'ebay'
│                           -- 'ebay' (Phase 0), 'shopify' (Phase 1)
├── external_store_id     VARCHAR(200)
│                           -- eBay user ID or Shopify domain
├── status                VARCHAR(20) NOT NULL DEFAULT 'active'
│                           -- active, paused, disconnected
├── last_order_poll_at    TIMESTAMP
│                           -- last time we polled for new orders
├── created_at            TIMESTAMP NOT NULL DEFAULT now()
└── updated_at            TIMESTAMP NOT NULL DEFAULT now()

INDEXES:
  UNIQUE INDEX ON (vendor_id, platform)
  INDEX ON (channel_id)
```

**Design decision:** Each vendor's eBay account is registered as a new row in the existing `channels` table (like channel 36 for Shopify and channel 67 for Card Shellz eBay). This lets us reuse the entire channel sync infrastructure — `channel_feeds`, `channel_listings`, `channel_allocation_rules`, `channel_sync_log` — without modification. The `dropship_channels` table bridges vendor ↔ channel.

### 2.9 Schema File Organization

All new tables go in a single new schema file:

```
shared/schema/dropship.schema.ts
```

This file exports:
- `dropshipVendors`
- `dropshipWalletLedger`
- `dropshipVendorProducts`
- `dropshipChannels`

Plus Zod insert schemas and TypeScript types for each.

The file is added to `shared/schema/index.ts` barrel export.

---

## 3. API Endpoints

All new endpoints live under two route prefixes:
- `/api/vendor/*` — vendor-facing (requires vendor JWT)
- `/api/admin/vendors/*` — admin-facing (requires Echelon admin session)

### 3.1 Vendor Auth

#### `POST /api/vendor/auth/register`

Create a new vendor account. Requires valid Shellz Club membership.

**Request:**
```json
{
  "email": "reseller@example.com",
  "password": "SecurePass123!",
  "name": "John Doe",
  "company_name": "JD Trading Cards",
  "phone": "555-0123",
  "shellz_club_member_id": 142
}
```

**Response (201):**
```json
{
  "vendor": {
    "id": 1,
    "email": "reseller@example.com",
    "name": "John Doe",
    "company_name": "JD Trading Cards",
    "status": "pending",
    "tier": "pro",
    "wallet_balance_cents": 0
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Validation:**
1. `shellz_club_member_id` must exist in `members` table
2. Linked member must have active subscription (`member_current_membership`)
3. No existing `dropship_vendors` row for that `shellz_club_member_id`
4. Email must not already be registered
5. Password: min 8 chars, at least 1 letter + 1 number

**Error responses:**
```json
{ "error": "membership_not_found", "message": "No active Shellz Club membership found for ID 142" }
{ "error": "membership_inactive", "message": "Shellz Club membership is not active" }
{ "error": "already_registered", "message": "A vendor account already exists for this membership" }
{ "error": "email_taken", "message": "Email is already registered" }
```

**Side effects:**
- Creates Stripe Customer via Stripe API
- Stores `stripe_customer_id` on vendor record
- Vendor status set to `pending` (admin must activate for Phase 0)

---

#### `POST /api/vendor/auth/login`

**Request:**
```json
{
  "email": "reseller@example.com",
  "password": "SecurePass123!"
}
```

**Response (200):**
```json
{
  "vendor": {
    "id": 1,
    "email": "reseller@example.com",
    "name": "John Doe",
    "company_name": "JD Trading Cards",
    "status": "active",
    "tier": "pro",
    "wallet_balance_cents": 48251,
    "ebay_connected": true
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Error responses:**
```json
{ "error": "invalid_credentials", "message": "Invalid email or password" }
{ "error": "account_suspended", "message": "Your account has been suspended. Contact support." }
{ "error": "account_closed", "message": "This account has been closed." }
```

---

#### `POST /api/vendor/auth/logout`

Invalidates the current JWT (if using a token blacklist) or is a no-op (if using short-lived JWTs only).

**Response (200):**
```json
{ "success": true }
```

---

#### `GET /api/vendor/auth/me`

Returns current vendor profile. Used on page load to validate session and hydrate the frontend.

**Response (200):**
```json
{
  "id": 1,
  "email": "reseller@example.com",
  "name": "John Doe",
  "company_name": "JD Trading Cards",
  "phone": "555-0123",
  "status": "active",
  "tier": "pro",
  "wallet_balance_cents": 48251,
  "auto_reload_enabled": true,
  "auto_reload_threshold_cents": 5000,
  "auto_reload_amount_cents": 20000,
  "ebay_connected": true,
  "ebay_user_id": "jd_trading_cards",
  "stripe_customer_id": "cus_abc123",
  "created_at": "2026-03-15T00:00:00Z"
}
```

---

### 3.2 Vendor Products

#### `GET /api/vendor/products`

Browse dropship-eligible products. Returns Card Shellz catalog data with ATP and wholesale pricing for the vendor's tier.

**Query params:**
- `page` (default 1)
- `limit` (default 50, max 100)
- `search` — text search on title/SKU
- `product_type` — filter by product type slug
- `selected` — `true` to show only vendor's selected products, `false` for unselected only

**Response (200):**
```json
{
  "products": [
    {
      "id": 42,
      "title": "Premium UV Shield Toploaders 25-Pack (35pt)",
      "sku": "CS-TL-35PT-25",
      "product_type": "toploaders",
      "image_url": "https://cdn.cardshellz.com/images/tl-35pt-25.jpg",
      "retail_price_cents": 1299,
      "wholesale_price_cents": 974,
      "atp": 312,
      "selected": true,
      "enabled": true,
      "ebay_listing_id": "123456789012",
      "push_status": "active",
      "variants": [
        {
          "id": 101,
          "sku": "CS-TL-35PT-25",
          "title": "Default",
          "wholesale_price_cents": 974,
          "atp": 312,
          "weight_oz": 6.2,
          "barcode": "860123456789"
        }
      ]
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 188,
    "total_pages": 4
  }
}
```

**Implementation notes:**
- Reads from `products` + `product_variants` + `product_assets` (existing tables)
- Filters by `products.dropship_eligible = true`
- ATP computed via `atpService.getAtpPerVariant()` scoped to the dropship allocation pool
- Wholesale price = retail × (1 - tier discount). Tier discount derived from vendor's Shellz Club plan.
- Left-joins `dropship_vendor_products` to populate `selected`, `enabled`, `push_status`

---

#### `POST /api/vendor/products/select`

Select products to list. Idempotent — selecting an already-selected product is a no-op.

**Request:**
```json
{
  "product_ids": [42, 55, 78]
}
```

**Response (200):**
```json
{
  "selected": 3,
  "already_selected": 0,
  "products": [
    { "product_id": 42, "status": "selected" },
    { "product_id": 55, "status": "selected" },
    { "product_id": 78, "status": "selected" }
  ]
}
```

**Validation:**
- All product IDs must exist and have `dropship_eligible = true`
- Max 500 selections per vendor (Phase 0 limit)

**Side effects:**
- Creates `dropship_vendor_products` rows with `enabled = true`, `push_status = 'pending'`
- Does NOT automatically push to eBay — vendor must explicitly push

---

#### `DELETE /api/vendor/products/:productId`

Remove a product from vendor's selection. If the product has an active eBay listing, marks it for removal.

**Response (200):**
```json
{
  "product_id": 42,
  "status": "removed",
  "ebay_listing_removed": true
}
```

**Side effects:**
- Sets `enabled = false` on the `dropship_vendor_products` row (soft delete — row persists for audit)
- If `ebay_listing_id` exists, calls eBay API to end the listing on vendor's account
- Sets `push_status = 'removed'`

---

### 3.3 Vendor Orders

#### `GET /api/vendor/orders`

List vendor's dropship orders with status and tracking.

**Query params:**
- `page` (default 1)
- `limit` (default 50, max 100)
- `status` — filter by OMS status
- `date_from`, `date_to` — order date range

**Response (200):**
```json
{
  "orders": [
    {
      "id": 2850,
      "vendor_order_ref": "11-12345-67890",
      "order_source": "dropship_ebay",
      "status": "shipped",
      "customer_name": "John Smith",
      "ship_to_city": "Pittsburgh",
      "ship_to_state": "PA",
      "items": [
        {
          "sku": "CS-TL-35PT-25",
          "title": "Premium UV Shield Toploaders 25-Pack (35pt)",
          "quantity": 2,
          "wholesale_price_cents": 974
        }
      ],
      "wholesale_total_cents": 1948,
      "shipping_cost_cents": 525,
      "total_charged_cents": 2473,
      "tracking_number": "9400111899223100001234",
      "tracking_carrier": "USPS",
      "shipped_at": "2026-03-20T14:30:00Z",
      "ordered_at": "2026-03-19T10:15:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 23,
    "total_pages": 1
  }
}
```

---

#### `GET /api/vendor/orders/:id`

Detailed order view including full timeline.

**Response (200):**
```json
{
  "id": 2850,
  "vendor_order_ref": "11-12345-67890",
  "order_source": "dropship_ebay",
  "status": "shipped",
  "customer_name": "John Smith",
  "ship_to": {
    "name": "John Smith",
    "address1": "123 Main St",
    "address2": "Apt 4",
    "city": "Pittsburgh",
    "state": "PA",
    "zip": "15201",
    "country": "US"
  },
  "items": [
    {
      "sku": "CS-TL-35PT-25",
      "title": "Premium UV Shield Toploaders 25-Pack (35pt)",
      "quantity": 2,
      "wholesale_price_cents": 974,
      "total_cents": 1948
    }
  ],
  "wholesale_total_cents": 1948,
  "shipping_cost_cents": 525,
  "total_charged_cents": 2473,
  "tracking_number": "9400111899223100001234",
  "tracking_carrier": "USPS",
  "estimated_delivery": "2026-03-25",
  "events": [
    { "type": "order_received", "at": "2026-03-19T10:15:00Z" },
    { "type": "wallet_debited", "at": "2026-03-19T10:15:01Z", "details": { "amount_cents": -2473 } },
    { "type": "status_confirmed", "at": "2026-03-19T10:15:02Z" },
    { "type": "picking_started", "at": "2026-03-19T14:00:00Z" },
    { "type": "shipped", "at": "2026-03-20T14:30:00Z", "details": { "tracking": "940011..." } },
    { "type": "tracking_pushed_to_ebay", "at": "2026-03-20T14:31:00Z" }
  ],
  "ordered_at": "2026-03-19T10:15:00Z"
}
```

---

### 3.4 Vendor Wallet

#### `GET /api/vendor/wallet`

Current balance plus recent transactions.

**Response (200):**
```json
{
  "balance_cents": 48251,
  "auto_reload_enabled": true,
  "auto_reload_threshold_cents": 5000,
  "auto_reload_amount_cents": 20000,
  "has_payment_method": true,
  "payment_method": {
    "type": "card",
    "last4": "4242",
    "brand": "visa",
    "exp_month": 12,
    "exp_year": 2027
  },
  "recent_transactions": [
    {
      "id": 156,
      "type": "order_debit",
      "amount_cents": -2473,
      "balance_after_cents": 48251,
      "reference_type": "oms_order",
      "reference_id": "2850",
      "notes": "Order DS-2850: CS-TL-35PT-25 x2",
      "created_at": "2026-03-19T10:15:01Z"
    },
    {
      "id": 155,
      "type": "deposit",
      "amount_cents": 50000,
      "balance_after_cents": 50724,
      "reference_type": "stripe_payment",
      "reference_id": "pi_abc123def456",
      "payment_method": "stripe_card",
      "notes": "Wallet deposit via Stripe",
      "created_at": "2026-03-18T09:00:00Z"
    }
  ]
}
```

---

#### `POST /api/vendor/wallet/deposit`

Initiate a Stripe Checkout Session for wallet funding.

**Request:**
```json
{
  "amount_cents": 50000
}
```

**Validation:**
- Minimum deposit: $10.00 (1000 cents)
- Maximum deposit: $5,000.00 (500000 cents)
- Vendor status must be `active`

**Response (200):**
```json
{
  "checkout_url": "https://checkout.stripe.com/c/pay/cs_live_abc123...",
  "session_id": "cs_live_abc123..."
}
```

**Flow:**
1. Backend creates Stripe Checkout Session in `payment` mode
2. `success_url` → vendor portal wallet page with `?deposit=success`
3. `cancel_url` → vendor portal wallet page with `?deposit=cancelled`
4. Stripe webhook (`checkout.session.completed`) credits the ledger (see Section 6)

**Alternative: Stripe PaymentIntent (for inline deposits):**

If the vendor has a saved payment method, the frontend can use a PaymentIntent instead of Checkout Session:

**Request:**
```json
{
  "amount_cents": 50000,
  "payment_method_id": "pm_abc123"
}
```

**Response (200):**
```json
{
  "payment_intent_id": "pi_abc123",
  "status": "succeeded",
  "balance_cents": 98251
}
```

---

#### `GET /api/vendor/wallet/ledger`

Full paginated transaction history.

**Query params:**
- `page` (default 1)
- `limit` (default 50, max 200)
- `type` — filter by transaction type
- `date_from`, `date_to`

**Response (200):**
```json
{
  "transactions": [
    {
      "id": 156,
      "type": "order_debit",
      "amount_cents": -2473,
      "balance_after_cents": 48251,
      "reference_type": "oms_order",
      "reference_id": "2850",
      "payment_method": null,
      "notes": "Order DS-2850: CS-TL-35PT-25 x2",
      "created_at": "2026-03-19T10:15:01Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 156,
    "total_pages": 4
  },
  "summary": {
    "total_deposited_cents": 200000,
    "total_debited_cents": -151749,
    "total_refunded_cents": 0,
    "current_balance_cents": 48251
  }
}
```

---

### 3.5 Vendor eBay Integration

#### `GET /api/vendor/ebay/auth-url`

Generate the eBay OAuth consent URL. Vendor clicks this to authorize Echelon to manage their eBay listings and read their orders.

**Response (200):**
```json
{
  "auth_url": "https://auth.ebay.com/oauth2/authorize?client_id=CardShe...&redirect_uri=...&scope=...&state=vendor_1_abc123"
}
```

**OAuth scopes requested:**
- `https://api.ebay.com/oauth/api_scope/sell.inventory` — create/manage listings
- `https://api.ebay.com/oauth/api_scope/sell.fulfillment` — read orders, push tracking
- `https://api.ebay.com/oauth/api_scope/sell.account` — read seller policies

**State parameter:** Encodes `vendor_id` + CSRF token for the callback.

---

#### `GET /api/vendor/ebay/callback`

eBay OAuth callback. Exchanges the authorization code for access + refresh tokens.

**Query params (from eBay):**
- `code` — authorization code
- `state` — vendor_id + CSRF token

**Flow:**
1. Validate `state` (CSRF check, extract vendor_id)
2. Exchange `code` for access + refresh token via eBay Token API
3. Fetch eBay user profile to get `ebay_user_id`
4. Store tokens on `dropship_vendors` row
5. Create a new `channels` row for this vendor's eBay account
6. Create `dropship_channels` bridge row
7. Redirect to vendor portal settings page with `?ebay=connected`

**Error handling:**
- If eBay returns an error → redirect to settings with `?ebay=error&reason=...`
- If vendor already has eBay connected → update tokens (re-authorization flow)

---

#### `POST /api/vendor/ebay/push`

Push selected products to vendor's eBay store. Creates new listings or updates existing ones.

**Request:**
```json
{
  "product_ids": [42, 55, 78]
}
```

Or push all enabled products:
```json
{
  "all": true
}
```

**Response (200):**
```json
{
  "pushed": 3,
  "results": [
    {
      "product_id": 42,
      "status": "created",
      "ebay_listing_id": "123456789012",
      "ebay_offer_id": "5678901234"
    },
    {
      "product_id": 55,
      "status": "updated",
      "ebay_listing_id": "123456789013",
      "ebay_offer_id": "5678901235"
    },
    {
      "product_id": 78,
      "status": "error",
      "error": "eBay rejected: Missing required item specific 'Brand'"
    }
  ]
}
```

**Validation:**
- Vendor must have eBay connected (tokens present and not expired)
- All product_ids must be in vendor's selection AND enabled
- Vendor status must be `active`

**Implementation:** Reuses existing eBay listing push logic (see Section 5).

---

#### `GET /api/vendor/ebay/listings`

View status of all vendor's eBay listings.

**Response (200):**
```json
{
  "listings": [
    {
      "product_id": 42,
      "product_title": "Premium UV Shield Toploaders 25-Pack (35pt)",
      "ebay_listing_id": "123456789012",
      "push_status": "active",
      "last_pushed_at": "2026-03-18T12:00:00Z",
      "ebay_url": "https://www.ebay.com/itm/123456789012",
      "current_atp": 312
    }
  ]
}
```

---

### 3.6 Admin Endpoints (Echelon-Side)

These are protected by Echelon's existing admin session auth (`requireAuth` middleware).

#### `GET /api/admin/vendors`

**Query params:**
- `page`, `limit`
- `status` — filter by vendor status
- `search` — text search on name/email/company

**Response (200):**
```json
{
  "vendors": [
    {
      "id": 1,
      "name": "John Doe",
      "company_name": "JD Trading Cards",
      "email": "reseller@example.com",
      "status": "active",
      "tier": "pro",
      "wallet_balance_cents": 48251,
      "total_orders": 23,
      "ebay_connected": true,
      "ebay_user_id": "jd_trading_cards",
      "created_at": "2026-03-15T00:00:00Z"
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 3, "total_pages": 1 }
}
```

---

#### `GET /api/admin/vendors/:id`

Full vendor detail including wallet ledger, recent orders, listing stats.

**Response (200):**
```json
{
  "vendor": {
    "id": 1,
    "name": "John Doe",
    "company_name": "JD Trading Cards",
    "email": "reseller@example.com",
    "phone": "555-0123",
    "status": "active",
    "tier": "pro",
    "shellz_club_member_id": 142,
    "wallet_balance_cents": 48251,
    "auto_reload_enabled": true,
    "auto_reload_threshold_cents": 5000,
    "auto_reload_amount_cents": 20000,
    "ebay_user_id": "jd_trading_cards",
    "ebay_token_expires_at": "2026-05-15T00:00:00Z",
    "stripe_customer_id": "cus_abc123",
    "created_at": "2026-03-15T00:00:00Z"
  },
  "stats": {
    "total_orders": 23,
    "orders_this_month": 8,
    "total_revenue_cents": 62450,
    "active_listings": 45,
    "products_selected": 52
  },
  "recent_orders": [ /* last 10 orders */ ],
  "recent_transactions": [ /* last 10 ledger entries */ ]
}
```

---

#### `PUT /api/admin/vendors/:id`

Update vendor status (activate, suspend, close).

**Request:**
```json
{
  "status": "active"
}
```

**Response (200):**
```json
{
  "id": 1,
  "status": "active",
  "updated_at": "2026-03-22T10:00:00Z"
}
```

**Business rules:**
- `pending → active`: enables vendor to use the platform
- `active → suspended`: immediately blocks new orders, pauses eBay listings
- `suspended → active`: re-enables access
- `any → closed`: permanent. Wallet balance queued for refund.

---

#### `PUT /api/admin/products/:id/dropship-eligible`

Toggle a product's dropship eligibility.

**Request:**
```json
{
  "dropship_eligible": true
}
```

**Response (200):**
```json
{
  "id": 42,
  "title": "Premium UV Shield Toploaders 25-Pack (35pt)",
  "dropship_eligible": true
}
```

---

#### `PUT /api/admin/products/bulk-dropship-eligible`

Bulk toggle.

**Request:**
```json
{
  "product_ids": [42, 55, 78, 91, 102],
  "dropship_eligible": true
}
```

**Response (200):**
```json
{
  "updated": 5,
  "product_ids": [42, 55, 78, 91, 102]
}
```

---

## 4. Vendor Auth System

### 4.1 Architecture

Vendor auth is completely separate from Echelon admin auth. Different JWT secret, different middleware, different session management.

| Aspect | Echelon Admin | Vendor Portal |
|--------|--------------|---------------|
| **Users table** | `users` | `dropship_vendors` |
| **Auth method** | Username + password | Email + password |
| **Session type** | Express session (cookie) | JWT (Bearer token) |
| **JWT secret** | N/A (uses sessions) | `VENDOR_JWT_SECRET` env var |
| **Token lifetime** | Session-based | 24 hours |
| **Refresh** | Session auto-extends | Re-login or refresh endpoint (Phase 1) |
| **Middleware** | `requireAuth` (existing) | `requireVendorAuth` (new) |
| **Route prefix** | `/api/*` (admin routes) | `/api/vendor/*` |

### 4.2 JWT Token Structure

```json
{
  "sub": 1,
  "email": "reseller@example.com",
  "vendor_id": 1,
  "tier": "pro",
  "status": "active",
  "iat": 1711108800,
  "exp": 1711195200
}
```

### 4.3 Middleware: `requireVendorAuth`

New middleware applied to all `/api/vendor/*` routes (except `/api/vendor/auth/login` and `/api/vendor/auth/register`).

**Behavior:**
1. Extract `Authorization: Bearer <token>` header
2. Verify JWT signature with `VENDOR_JWT_SECRET`
3. Check token expiration
4. Load vendor from `dropship_vendors` by `vendor_id`
5. Verify vendor status is `active` (reject `pending`, `suspended`, `closed`)
6. Attach `req.vendor` to the request object
7. Proceed to route handler

**Error responses:**
- Missing/invalid token → `401 { error: "unauthorized" }`
- Expired token → `401 { error: "token_expired" }`
- Vendor not active → `403 { error: "account_not_active", status: "suspended" }`

### 4.4 Password Handling

- Hash with `bcrypt` (same library already used for Echelon admin users)
- Cost factor: 12
- No password stored in plain text anywhere

### 4.5 Registration Validation Flow

```
Vendor submits registration
         │
         ▼
1. Validate email format, password strength
         │
         ▼
2. Check members table: does shellz_club_member_id exist?
   → NO: reject "membership_not_found"
         │
         ▼
3. Check member_current_membership: is membership active?
   → NO: reject "membership_inactive"
         │
         ▼
4. Check dropship_vendors: already registered for this member_id?
   → YES: reject "already_registered"
         │
         ▼
5. Check dropship_vendors: email already taken?
   → YES: reject "email_taken"
         │
         ▼
6. Derive tier from member's plan (plans table)
         │
         ▼
7. Create Stripe Customer (Stripe API)
         │
         ▼
8. Hash password, insert dropship_vendors row
         │
         ▼
9. Issue JWT, return vendor + token
```

### 4.6 Environment Variables (New)

```env
VENDOR_JWT_SECRET=<random-256-bit-secret>
VENDOR_JWT_EXPIRES_IN=24h
```

### 4.7 File Organization

```
server/modules/dropship/
├── vendor-auth.middleware.ts      -- requireVendorAuth middleware
├── vendor-auth.routes.ts          -- /api/vendor/auth/* routes
├── vendor-auth.service.ts         -- registration, login, JWT issuance
├── vendor.routes.ts               -- /api/vendor/* routes (products, orders, wallet)
├── vendor.service.ts              -- vendor CRUD operations
├── vendor-wallet.service.ts       -- wallet operations (deposit, debit, credit)
├── vendor-wallet.routes.ts        -- /api/vendor/wallet/* routes
├── vendor-ebay.service.ts         -- multi-tenant eBay operations
├── vendor-ebay.routes.ts          -- /api/vendor/ebay/* routes
├── vendor-orders.service.ts       -- dropship order ingestion + management
├── vendor-orders.routes.ts        -- /api/vendor/orders/* routes
├── vendor-products.service.ts     -- product selection + eBay push
├── vendor-products.routes.ts      -- /api/vendor/products/* routes
├── admin-vendors.routes.ts        -- /api/admin/vendors/* routes
└── dropship.storage.ts            -- data access layer for all dropship tables
```

---

## 5. Multi-Tenant eBay Integration

### 5.1 Current Architecture

Today, Echelon has a single eBay integration:

| Component | Current State |
|-----------|--------------|
| **Tokens** | One row in `ebay_oauth_tokens` for channel 67 |
| **Auth service** | `EbayAuthService` reads from `ebay_oauth_tokens` by `channel_id` |
| **API client** | `EbayApiClient` uses auth service to get token, makes HTTP calls |
| **Listing builder** | `ebay-listing-builder.ts` constructs eBay inventory item + offer payloads |
| **Push routes** | `ebay-channel.routes.ts` handles push for Card Shellz's eBay store |
| **Order ingestion** | `ebay-order-ingestion.ts` polls Card Shellz's eBay orders |

### 5.2 What Changes for Multi-Tenant

The key insight: **the existing eBay integration code is already structured to work per-channel**. The `EbayAuthService` takes a `channelId` and looks up tokens. The `EbayApiClient` takes an auth service instance. We need to:

1. **Store vendor tokens in `dropship_vendors`** instead of `ebay_oauth_tokens`
2. **Create a new channel row** per vendor eBay account
3. **Extend `EbayAuthService`** to read tokens from `dropship_vendors` when the channel belongs to a vendor
4. **Reuse `EbayApiClient` and `ebay-listing-builder.ts`** unchanged
5. **Extend `ebay-order-ingestion.ts`** to poll vendor eBay accounts for orders

### 5.3 Token Management

**Current:** `EbayAuthService.getValidToken(channelId)` → reads `ebay_oauth_tokens`

**New:** `EbayAuthService.getValidToken(channelId)` checks:
1. Is this channel in `dropship_channels`?
   - YES → read tokens from `dropship_vendors` (via `dropship_channels.vendor_id`)
   - NO → read tokens from `ebay_oauth_tokens` (existing behavior)
2. Token refresh logic is the same — eBay token refresh API, store new tokens
3. For vendor tokens, refresh writes back to `dropship_vendors.ebay_oauth_token` / `ebay_refresh_token`

**Reuse:** `EbayAuthService` — modified (add vendor token path)  
**Reuse unchanged:** `EbayApiClient`, all HTTP request logic

### 5.4 Listing Push (Vendor)

When a vendor pushes products to their eBay store:

```
Vendor clicks "Push to eBay" in portal
         │
         ▼
POST /api/vendor/ebay/push { product_ids: [42, 55] }
         │
         ▼
For each product:
  1. Load product data from products + product_variants + product_assets
     (same catalog data as Card Shellz's own listings)
         │
  2. Build eBay inventory item payload via ebay-listing-builder.ts
     - Title, description, images, aspects → from Card Shellz catalog
     - Condition: NEW
     - Aspects: resolved via existing cascade (product override → type default → auto)
         │
  3. Build eBay offer payload
     - Price: vendor sets their own retail price (or uses MSRP)
            For Phase 0: use Card Shellz MSRP as default
     - Quantity: from dropship ATP (NOT total ATP — scoped to dropship pool)
     - Fulfillment policy: Card Shellz's policy ID (254926236019)
     - Return policy: Card Shellz's policy ID (254575298019)
     - Payment policy: Card Shellz's policy ID (254415953019)
     - ⚠️ IMPORTANT: these policy IDs are on CARD SHELLZ's eBay account.
       Vendors need THEIR OWN policies on THEIR accounts.
       Phase 0: vendor must manually create compatible policies on their eBay account.
       The push includes policy IDs from the vendor's account (stored in config or auto-discovered).
     - Merchant location: Card Shellz warehouse key
       ⚠️ Same issue — merchant location is per-eBay-account.
       Vendor must create a "location" on their eBay account pointing to Card Shellz warehouse address.
         │
  4. Push via EbayApiClient using vendor's OAuth token
     - PUT /sell/inventory/v1/inventory_item/{sku}
     - POST /sell/inventory/v1/offer (or PUT to update)
     - POST /sell/inventory/v1/offer/{offerId}/publish
         │
  5. Store ebay_listing_id + ebay_offer_id on dropship_vendor_products
```

**Reuse:** `ebay-listing-builder.ts` — reuse for inventory item construction  
**New code:** Offer construction with vendor-specific policies + pricing  
**New code:** Vendor eBay policy discovery/setup flow

### 5.5 eBay Policy Setup (Vendor Onboarding)

Each vendor's eBay account needs its own:
- **Fulfillment policy** — ships from Card Shellz warehouse, 1 business day handling
- **Return policy** — returns to Card Shellz warehouse, vendor's terms
- **Payment policy** — eBay managed payments (default for all eBay sellers)
- **Merchant location** — Card Shellz warehouse address

**Phase 0 approach:** During eBay OAuth callback, Echelon auto-creates these policies on the vendor's eBay account via the eBay Account API:

```
POST /sell/account/v1/fulfillment_policy
{
  "name": "Card Shellz Dropship - Standard",
  "marketplaceId": "EBAY_US",
  "handlingTime": { "unit": "BUSINESS_DAY", "value": 1 },
  "shippingOptions": [
    {
      "costType": "CALCULATED",
      "optionType": "DOMESTIC",
      "shippingServices": [
        { "shippingServiceCode": "USPSFirstClass", "sortOrder": 1 },
        { "shippingServiceCode": "USPSPriority", "sortOrder": 2 }
      ]
    }
  ]
}
```

Policy IDs returned by eBay are stored per-vendor (add columns to `dropship_channels` or a new config table).

### 5.6 ATP Sync to Vendor Listings

When inventory changes (receive, adjust, reserve, unreserve):

```
ATP change detected (existing sync trigger)
         │
         ▼
Echelon sync orchestrator runs (existing)
         │
         ├── Push to Shopify channel 36 (existing)
         ├── Push to Card Shellz eBay channel 67 (existing)
         └── For each active vendor channel:
               │
               ▼
             Compute dropship ATP for this product
               │
               ▼
             Compare to last_synced_qty on vendor's channel_feed
               │
               ├── Changed → push new quantity to vendor's eBay via vendor's token
               └── Same → skip
```

**Reuse:** `echelon-sync-orchestrator.service.ts` — extend to include vendor channels  
**Reuse:** `channel_feeds` table — one row per variant per vendor channel  
**New code:** Vendor channel discovery (which vendor channels to include in sync)

### 5.7 Order Ingestion (Vendor eBay Orders)

When a customer buys on a vendor's eBay store:

```
Scheduled poll (every 5 minutes) — same as existing eBay order polling
         │
         ▼
For each active vendor with eBay connected:
  1. Call eBay Fulfillment API: GET /sell/fulfillment/v1/order
     using vendor's OAuth token
     filter: lastModifiedDate > last_order_poll_at
         │
  2. For each new order:
     a. Map eBay SKUs to Card Shellz product variants
     b. Validate: vendor active, wallet has funds, ATP available
     c. Compute cost: wholesale + shipping (with markup)
     d. Debit vendor wallet (atomic with order creation)
     e. Create oms_orders row with:
        - channel_id = vendor's channel
        - vendor_id = vendor's dropship_vendors.id
        - order_source = 'dropship_ebay'
        - vendor_order_ref = eBay order ID
     f. Create oms_order_lines for each item
     g. Reserve inventory via reserveForOrder()
         │
  3. Update dropship_channels.last_order_poll_at
```

**Reuse:** `ebay-order-ingestion.ts` — extend to iterate over vendor accounts  
**New code:** Wallet validation + debit within order creation transaction  
**New code:** Multi-account polling loop

### 5.8 Tracking Push

When a dropship order ships (tracking number available):

```
ShipStation ship_notify webhook fires (existing)
         │
         ▼
fulfillment-push.service.ts detects the order (existing)
         │
         ▼
Is this a dropship order? (check oms_orders.vendor_id)
  │
  ├── NO → push tracking to Card Shellz's eBay/Shopify (existing behavior)
  │
  └── YES → look up vendor's channel → push tracking to vendor's eBay
             using vendor's OAuth token
             eBay API: POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment
```

**Reuse:** `fulfillment-push.service.ts` — extend with vendor-aware tracking push  
**Change:** Add vendor_id check to decide which eBay account to push to

---

## 6. Wallet & Stripe Integration

### 6.1 Stripe Setup

| Stripe Resource | Purpose |
|----------------|---------|
| **Customer** | One per vendor. Created at registration. |
| **Customer Balance** | NOT used for Phase 0. We manage our own ledger for control + USDC compatibility. |
| **Checkout Session** | For wallet deposits. Mode: `payment`. |
| **PaymentIntent** | For inline deposits with saved payment methods. |
| **SetupIntent** | For saving a payment method without charging. |
| **Webhook** | `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed` |

**Why our own ledger instead of Stripe Customer Balance:**
- Stripe Customer Balance doesn't support USDC (Phase 2)
- Our ledger gives us full control over transaction types (order debits, refund credits, adjustments)
- Stripe Customer Balance would require all operations to go through Stripe — our ledger is faster and simpler
- Regulatory: using Stripe Customer Balance would make Stripe the custodian (good for money transmitter avoidance, but limits flexibility)

**Compromise for Phase 0:** Use our own `dropship_wallet_ledger` as the source of truth. Stripe is a funding source only. If regulatory counsel later advises using Stripe Customer Balance, the migration is straightforward — the ledger structure is the same.

### 6.2 Deposit Flow

```
Vendor clicks "Deposit $500" in portal
         │
         ▼
POST /api/vendor/wallet/deposit { amount_cents: 50000 }
         │
         ▼
Backend creates Stripe Checkout Session
  - mode: "payment"
  - customer: vendor's stripe_customer_id
  - line_items: [{ price_data: { unit_amount: 50000, currency: "usd" }, quantity: 1 }]
  - success_url: https://vendors.cardshellz.ai/wallet?deposit=success
  - cancel_url: https://vendors.cardshellz.ai/wallet?deposit=cancelled
  - metadata: { vendor_id: 1, type: "wallet_deposit" }
         │
         ▼
Frontend redirects to Stripe Checkout
         │
         ▼
Customer completes payment
         │
         ▼
Stripe fires webhook: checkout.session.completed
         │
         ▼
Webhook handler:
  1. Extract vendor_id from metadata
  2. Extract amount from session
  3. BEGIN TRANSACTION
     a. SELECT wallet_balance_cents FROM dropship_vendors WHERE id = vendor_id FOR UPDATE
     b. new_balance = current_balance + amount
     c. INSERT INTO dropship_wallet_ledger (vendor_id, type, amount_cents, balance_after_cents, ...)
     d. UPDATE dropship_vendors SET wallet_balance_cents = new_balance
  4. COMMIT
```

### 6.3 Order Debit Flow

```
Dropship order validated and ready to accept
         │
         ▼
BEGIN TRANSACTION
  1. SELECT wallet_balance_cents FROM dropship_vendors WHERE id = vendor_id FOR UPDATE
     (row-level lock prevents race conditions)
         │
  2. Compute total cost:
     wholesale_cents = SUM(variant.wholesale_price × quantity) for all items
     shipping_cents = computed from weight + destination (Card Shellz rate + markup)
     total_cents = wholesale_cents + shipping_cents
         │
  3. Is wallet_balance_cents >= total_cents?
     → NO: ROLLBACK, return { error: "insufficient_funds", required: total, balance: current }
     → YES: continue
         │
  4. new_balance = wallet_balance_cents - total_cents
  5. INSERT INTO dropship_wallet_ledger (
       vendor_id, type='order_debit', amount_cents=-total_cents,
       balance_after_cents=new_balance, reference_type='oms_order',
       reference_id=order_id
     )
  6. UPDATE dropship_vendors SET wallet_balance_cents = new_balance
  7. Create oms_orders + oms_order_lines
  8. Reserve inventory via reserveForOrder()
COMMIT
```

**Critical:** Steps 3–8 MUST be in a single database transaction. If inventory reservation fails, the wallet debit is rolled back.

### 6.4 Refund / Credit Flow

For order cancellations (before shipment) or return credits:

```
BEGIN TRANSACTION
  1. SELECT wallet_balance_cents FROM dropship_vendors WHERE id = vendor_id FOR UPDATE
  2. credit_amount = original order total (for cancellation) or wholesale minus restocking (for return)
  3. new_balance = wallet_balance_cents + credit_amount
  4. INSERT INTO dropship_wallet_ledger (
       vendor_id, type='refund_credit' or 'return_credit',
       amount_cents=+credit_amount, balance_after_cents=new_balance,
       reference_type='oms_order' or 'return', reference_id=...
     )
  5. UPDATE dropship_vendors SET wallet_balance_cents = new_balance
COMMIT
```

### 6.5 Auto-Reload (Phase 0: Foundation)

For Phase 0, auto-reload is implemented but only for vendors with saved Stripe payment methods.

```
After every wallet debit:
  1. Check: is auto_reload_enabled = true?
  2. Check: is wallet_balance_cents < auto_reload_threshold_cents?
  3. Check: does vendor have a saved payment method in Stripe?
  │
  └── All YES:
        Create Stripe PaymentIntent for auto_reload_amount_cents
        using saved payment method (off-session, confirm immediately)
        │
        ├── Succeeds → credit ledger (type: 'auto_reload')
        └── Fails → log failure, email vendor, do NOT block the current order
```

**Payment method saving:** During first deposit (Checkout Session), set `payment_intent_data.setup_future_usage: 'off_session'`. This saves the payment method for future auto-reloads.

### 6.6 Stripe Webhook Endpoint

**`POST /api/webhooks/stripe`** (public, verified via Stripe signature)

**Events handled:**

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Credit vendor wallet (deposit) |
| `payment_intent.succeeded` | Credit vendor wallet (auto-reload or inline deposit) |
| `payment_intent.payment_failed` | Log failure, notify vendor. If auto-reload: mark as failed, do not retry automatically. |

**Idempotency:** Check if a ledger entry with this `stripe_payment_intent_id` already exists. If so, skip (prevents double-credit on webhook retry).

### 6.7 Environment Variables (New)

```env
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_live_...  (for frontend)
```

---

## 7. Dropship Order Flow

### 7.1 End-to-End Sequence

```
1. Customer browses vendor's eBay store
   (listings pushed by Echelon from Card Shellz catalog)
         │
2. Customer buys product, pays vendor via eBay Managed Payments
         │
3. Echelon polls vendor's eBay account (every 5 min)
   picks up new order
         │
4. Order validation:
   a. Vendor status = active?
   b. SKUs map to active Card Shellz products?
   c. Dropship ATP available for all quantities?
   d. Vendor wallet >= wholesale + shipping cost?
         │
   All pass → continue
   Any fail → reject (wallet not debited, vendor notified, eBay order NOT cancelled)
         │
5. Atomic transaction:
   a. Debit vendor wallet
   b. Create oms_orders row (vendor_id, order_source='dropship_ebay')
   c. Create oms_order_lines
   d. Reserve inventory via reserveForOrder()
   e. Create oms_order_events entry
         │
6. Order enters WMS pick queue with PRIORITY flag
   (dropship orders sorted above standard retail orders)
         │
7. Picker picks + packs order
   - Card Shellz branded box + tape
   - NO packing slip (per Section 16.1 of DROPSHIP-DESIGN.md)
   - Ship-from address: Card Shellz warehouse
         │
8. ShipStation generates label → ships
         │
9. ShipStation ship_notify webhook fires
         │
10. Echelon:
    a. Updates oms_orders (tracking number, carrier, shipped_at)
    b. Detects vendor_id → pushes tracking to VENDOR's eBay account
       (eBay Fulfillment API using vendor's OAuth token)
         │
11. eBay buyer sees tracking on their purchase
    Vendor's eBay seller metrics updated (on-time shipment)
```

### 7.2 Order Rejection Handling

When a dropship order fails validation:

| Failure | System Action | Vendor Notification |
|---------|--------------|---------------------|
| Vendor suspended | Skip order. Do not debit wallet. | Email + portal notification |
| SKU not found / not active | Skip order. Log error. | Email with failed SKU details |
| ATP insufficient | Skip order. Log shortfall. | Email: "Order {ref} rejected — {SKU} out of stock" |
| Wallet insufficient | Skip order. Log required vs balance. | Email: "Order {ref} rejected — insufficient funds. Required: $X, Balance: $Y" |

**The eBay order is NOT cancelled by Echelon.** The vendor must handle it (cancel on eBay, refund their customer, etc.). Card Shellz's system never touches the vendor's customer relationship.

### 7.3 Priority Queue

Dropship orders receive priority in the WMS pick queue:

- **Existing priority system:** `orders` table has a `priority` column with values `rush`, `high`, `normal`
- **Dropship orders:** Created with `priority = 'high'` by default
- **SLA:** 1 business day ship for orders received by 2:00 PM ET
- **Implementation:** No new code needed — just set the priority value on creation

### 7.4 Shipping Cost Calculation

Per DROPSHIP-DESIGN.md Section 16.3, vendors see a single "shipping" number that includes:

```
shipping_charge_to_vendor = label_cost + dunnage_markup + insurance_pool + margin

Where:
  label_cost = actual carrier cost from ShipStation rate engine
  dunnage_markup = ~10% of label_cost (covers box, tape, packing materials)
  insurance_pool = ~2% of label_cost (internal self-insurance budget)
  margin = ~3-5% of label_cost
```

**Phase 0 simplification:** Use a flat shipping rate table based on package weight:

| Weight | Shipping Charge to Vendor |
|--------|--------------------------|
| ≤ 4 oz | $4.50 |
| ≤ 8 oz | $5.25 |
| ≤ 16 oz | $6.50 |
| ≤ 2 lbs | $8.00 |
| ≤ 5 lbs | $12.00 |
| > 5 lbs | $15.00 + $1.50/lb over 5 |

These rates include label + dunnage + insurance + margin. Stored in a config table or environment config. Adjusted as needed based on actual costs.

### 7.5 Wholesale Price Calculation

Per vendor tier (derived from Shellz Club plan):

| Tier | Discount from Retail | Example ($12.99 retail) |
|------|---------------------|------------------------|
| Standard | 15% | $11.04 |
| Pro | 25% | $9.74 |
| Elite | 30% | $9.09 |

Wholesale price is computed at order time from the product's retail price and vendor's tier. NOT stored as a separate price — always derived.

---

## 8. Vendor Portal Frontend

### 8.1 Project Setup

| Aspect | Value |
|--------|-------|
| **Framework** | React 18 + Vite |
| **Styling** | Tailwind CSS + shadcn/ui |
| **Routing** | React Router v6 |
| **State** | TanStack Query (React Query) for server state |
| **Forms** | React Hook Form + Zod validation |
| **HTTP** | Axios or fetch wrapper with JWT injection |
| **Deployment** | Separate Vite build, hosted on cardshellz.ai |
| **API** | Hits Echelon API at `api.cardshellz.ai` (or same origin with CORS) |
| **Minimum viewport** | 375px (mobile-first) |

**Separate repository or monorepo?** Recommend a new directory in the Echelon monorepo:

```
echelon/
├── client/                    ← existing Echelon admin UI
├── vendor-portal/             ← new vendor portal
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   ├── lib/
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   └── package.json
├── server/                    ← shared Express backend
└── shared/                    ← shared schemas/types
```

**Why monorepo:** Shares `shared/` types/schemas. One deployment pipeline. Vendor portal is a separate Vite build target.

### 8.2 Page Hierarchy

```
vendor-portal/src/
├── App.tsx                        ← Router + auth context
├── pages/
│   ├── auth/
│   │   ├── LoginPage.tsx          ← Email + password login
│   │   └── RegisterPage.tsx       ← Registration with Shellz Club member ID
│   │
│   ├── DashboardPage.tsx          ← Wallet balance, recent orders, listing stats
│   │
│   ├── products/
│   │   ├── ProductCatalogPage.tsx ← Browse eligible products, search/filter
│   │   └── MyProductsPage.tsx     ← Selected products, push to eBay, toggle
│   │
│   ├── orders/
│   │   ├── OrdersPage.tsx         ← Order list with filters
│   │   └── OrderDetailPage.tsx    ← Single order detail + timeline
│   │
│   ├── wallet/
│   │   └── WalletPage.tsx         ← Balance, deposit, transaction history
│   │
│   └── settings/
│       └── SettingsPage.tsx       ← eBay connection, auto-reload, profile
│
├── components/
│   ├── layout/
│   │   ├── AppShell.tsx           ← Sidebar + header + content
│   │   ├── Sidebar.tsx            ← Navigation (Dashboard, Products, Orders, Wallet, Settings)
│   │   └── MobileNav.tsx          ← Bottom tab bar for mobile
│   │
│   ├── dashboard/
│   │   ├── WalletCard.tsx         ← Balance display + quick deposit
│   │   ├── RecentOrdersCard.tsx   ← Last 5 orders
│   │   └── ListingStatsCard.tsx   ← Active listings, pending pushes
│   │
│   ├── products/
│   │   ├── ProductGrid.tsx        ← Product cards in grid layout
│   │   ├── ProductCard.tsx        ← Single product: image, title, price, ATP, select btn
│   │   ├── ProductFilters.tsx     ← Search, type filter, selected/unselected toggle
│   │   └── PushToEbayButton.tsx   ← Push selected products to eBay
│   │
│   ├── orders/
│   │   ├── OrdersTable.tsx        ← Responsive order table
│   │   ├── OrderStatusBadge.tsx   ← Color-coded status badge
│   │   └── OrderTimeline.tsx      ← Event timeline (accepted → picking → shipped → delivered)
│   │
│   ├── wallet/
│   │   ├── BalanceDisplay.tsx     ← Large balance number + trend
│   │   ├── DepositModal.tsx       ← Amount input → Stripe Checkout redirect
│   │   ├── TransactionList.tsx    ← Paginated ledger entries
│   │   └── AutoReloadConfig.tsx   ← Toggle, threshold, amount inputs
│   │
│   ├── settings/
│   │   ├── EbayConnectionCard.tsx ← Connect/disconnect eBay, show status
│   │   ├── ProfileForm.tsx        ← Name, email, company, phone
│   │   └── PaymentMethodCard.tsx  ← Saved Stripe payment method display
│   │
│   └── ui/                        ← shadcn/ui components (button, card, dialog, table, etc.)
│
├── hooks/
│   ├── useAuth.ts                 ← Auth context: login, logout, token management
│   ├── useVendor.ts               ← Current vendor profile query
│   ├── useProducts.ts             ← Product catalog + selection queries/mutations
│   ├── useOrders.ts               ← Order list + detail queries
│   └── useWallet.ts               ← Balance + ledger queries, deposit mutation
│
└── lib/
    ├── api.ts                     ← Axios instance with JWT interceptor
    ├── auth.ts                    ← Token storage (localStorage), JWT decode
    └── utils.ts                   ← formatCents, formatDate, etc.
```

### 8.3 Routing

```
/                        → redirect to /dashboard (if authenticated) or /login
/login                   → LoginPage
/register                → RegisterPage
/dashboard               → DashboardPage
/products                → ProductCatalogPage
/products/my             → MyProductsPage
/orders                  → OrdersPage
/orders/:id              → OrderDetailPage
/wallet                  → WalletPage
/settings                → SettingsPage
```

All routes except `/login` and `/register` require authentication (wrapped in `<ProtectedRoute>`).

### 8.4 Design Notes

- **Mobile-first:** 375px minimum. Sidebar collapses to bottom tab bar on mobile.
- **Brand:** Card Shellz brand colors + assets. Not identical to Echelon admin (which is internal) — this is customer-facing.
- **Key UX principle:** The vendor should be able to go from "just registered" to "products live on eBay" in under 10 minutes.
- **Real-time balance:** Wallet balance shown in the sidebar/header, updates on every page load via `useVendor` query.

---

## 9. Admin UI (Echelon-Side)

### 9.1 New Sidebar Section

Add a "Vendors" section to the Echelon admin sidebar, positioned after "Orders" and before "Procurement."

```
Echelon Sidebar (updated):
├── Dashboard
├── Catalog
├── Inventory
├── Channels
├── Orders
├── ──────────
├── 🏪 Vendors          ← NEW
│   ├── All Vendors
│   └── Vendor Settings
├── ──────────
├── Procurement
├── Warehouse
└── Settings
```

### 9.2 New Pages

#### Vendor List Page (`/vendors`)

- Table with columns: Name, Company, Email, Status (badge), Tier, Wallet Balance, Orders (count), eBay Connected (✓/✗), Created
- Filters: status dropdown, search box
- Row click → Vendor Detail
- "Export CSV" button for vendor list

#### Vendor Detail Page (`/vendors/:id`)

Tabbed layout:

- **Overview tab:** Vendor profile, status controls (activate/suspend/close), tier display, eBay connection status
- **Wallet tab:** Current balance, full transaction ledger (paginated table), manual adjustment button (admin can add/deduct with notes)
- **Orders tab:** All vendor's orders (reuse existing `OmsOrders` component with vendor_id filter)
- **Listings tab:** Vendor's eBay listings with push status, last synced time
- **Activity tab:** Audit log of admin actions on this vendor

#### Product Catalog Enhancement

Add a "Dropship" toggle column to the existing product catalog pages:

- **CatalogPage.tsx:** New column "Dropship" with a toggle switch
- Toggle calls `PUT /api/admin/products/:id/dropship-eligible`
- Bulk action: select multiple products → "Enable Dropship" / "Disable Dropship" buttons
- Filter: "Dropship Eligible" checkbox to show only eligible products

### 9.3 Existing Component Reuse

| Need | Existing Component | Modification |
|------|-------------------|--------------|
| Vendor list table | Use shadcn `DataTable` pattern from OmsOrders | New columns/data |
| Status badges | Reuse `Badge` component pattern | New status values |
| Order list in vendor detail | Reuse `OmsOrders` component | Pass `vendorId` prop as filter |
| Wallet ledger table | Similar pattern to `InventoryHistory` | New data source |
| Toggle switch for dropship | Reuse shadcn `Switch` component | Wire to new endpoint |

---

## 10. Existing System Changes

### 10.1 Summary of Changes to Existing Code

| File | Change | Risk |
|------|--------|------|
| `shared/schema/index.ts` | Add `dropship.schema.ts` export | None — additive |
| `shared/schema/catalog.schema.ts` | Add `dropship_eligible` column to `products` | Low — new column with default |
| `shared/schema/oms.schema.ts` | Add `vendor_id`, `order_source`, `vendor_order_ref`, `dropship_cost_cents` to `oms_orders` | Low — nullable columns |
| `shared/schema/orders.schema.ts` | Add `vendor_id`, `order_source` to `orders` | Low — nullable columns |
| `server/modules/channels/adapters/ebay/ebay-auth.service.ts` | Add vendor token path (check `dropship_channels` before `ebay_oauth_tokens`) | Medium — modifies auth flow |
| `server/modules/channels/echelon-sync-orchestrator.service.ts` | Include vendor channels in sync loop | Medium — extends sync to more channels |
| `server/modules/oms/ebay-order-ingestion.ts` | Add multi-account polling for vendor eBay accounts | Medium — extends polling loop |
| `server/modules/oms/fulfillment-push.service.ts` | Add vendor-aware tracking push | Medium — extends tracking push logic |
| `server/modules/orders/sla-monitor.service.ts` | Add dropship SLA (1 business day) monitoring | Low — additive rule |
| `client/src/pages/CatalogPage.tsx` | Add "Dropship" toggle column | Low — additive UI column |
| `client/src/components/layout/Sidebar.tsx` | Add "Vendors" nav section | Low — additive |

### 10.2 Boundary Compliance

Per `BOUNDARIES.md`, each system owns its own tables and calls into other systems via their public interfaces. The dropship module:

- **Does NOT** touch `inventory_levels` directly → calls `reserveForOrder()` (WMS boundary)
- **Does NOT** compute ATP directly → calls `atpService.getAtpPerVariant()` (WMS boundary)
- **Does NOT** create OMS orders by raw SQL → calls `omsService.createOrder()` (OMS boundary)
- **Does NOT** manage picking/packing → orders flow into existing WMS pick queue
- **Reads from** catalog tables (`products`, `product_variants`, `product_assets`) → Catalog is read-only for all consumers (per boundary rules)

**New boundary:** The dropship module **owns** the `dropship_*` tables and exposes its own service interfaces. OMS and WMS interact with dropship orders via the existing `vendor_id` column on `oms_orders` — they don't query `dropship_vendors` directly.

### 10.3 Channel Architecture Integration

The `dropship_channels` → `channels` bridge means each vendor eBay account is a first-class channel. This has implications:

1. **`channels` table:** New rows (one per vendor eBay account). Use a naming convention: `vendor_{id}_ebay`
2. **`channel_allocation_rules`:** A single "dropship" allocation rule covers all vendor channels. The dropship pool (10% initially) is shared.
3. **`channel_feeds`:** New rows per vendor channel × variant. This table will grow significantly with many vendors.
4. **`channel_sync_log`:** Sync events for vendor channels logged here. Consider adding a `vendor_id` column or filtering by channel_id.

**Scaling note:** With 50 vendors × 188 products = 9,400 `channel_feeds` rows (from ~589 today). This is fine for Postgres. At 500 vendors it's 94,000 rows — still fine, but watch sync orchestrator performance.

---

## 11. Migration Plan

### 11.1 Database Migrations

Run in order. Each is a separate migration file.

**Migration 1: Create dropship tables**
```
CREATE TABLE dropship_vendors (...)
CREATE TABLE dropship_wallet_ledger (...)
CREATE TABLE dropship_vendor_products (...)
CREATE TABLE dropship_channels (...)
```

**Migration 2: Add dropship columns to existing tables**
```
ALTER TABLE products ADD COLUMN dropship_eligible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE oms_orders ADD COLUMN vendor_id INTEGER REFERENCES dropship_vendors(id);
ALTER TABLE oms_orders ADD COLUMN order_source VARCHAR(30);
ALTER TABLE oms_orders ADD COLUMN vendor_order_ref VARCHAR(100);
ALTER TABLE oms_orders ADD COLUMN dropship_cost_cents INTEGER;
ALTER TABLE orders ADD COLUMN vendor_id INTEGER REFERENCES dropship_vendors(id);
ALTER TABLE orders ADD COLUMN order_source VARCHAR(30);
CREATE INDEX idx_oms_orders_vendor ON oms_orders(vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX idx_oms_orders_source ON oms_orders(order_source);
```

**Migration 3: Backfill order_source for existing orders**
```
UPDATE oms_orders SET order_source = 'ebay' WHERE channel_id = 67 AND order_source IS NULL;
UPDATE oms_orders SET order_source = 'shopify' WHERE channel_id = 36 AND order_source IS NULL;
```

### 11.2 Environment Setup

New environment variables required before deployment:

```env
# Vendor JWT
VENDOR_JWT_SECRET=<generate-256-bit-random>
VENDOR_JWT_EXPIRES_IN=24h

# Stripe (if not already configured)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Vendor Portal
VENDOR_PORTAL_URL=https://vendors.cardshellz.ai
```

### 11.3 eBay App Permissions

The existing eBay app (used for Card Shellz's channel 67) will also be used for vendor OAuth. Verify:

- App has `sell.inventory`, `sell.fulfillment`, `sell.account` scopes
- App's OAuth redirect URIs include the vendor callback URL
- App can handle multiple user tokens (eBay apps are not limited to one user)

---

## 12. Out of Scope (Deferred)

The following are explicitly NOT in Phase 0. Noted here for tracking.

| Feature | Phase | Notes |
|---------|-------|-------|
| Shopify vendor support | Phase 1 | `shopify_domain` + `shopify_access_token` columns exist but unused |
| USDC payments | Phase 2 | `usdc_wallet_address` column exists but unused |
| Auto-reload via USDC smart contract | Phase 2 | Requires Base smart contract deployment |
| Vendor self-registration (public) | Phase 1 | Phase 0: admin manually activates vendors |
| Returns / RMA portal | Phase 1 | Phase 0: returns handled manually |
| MAP enforcement tooling | Phase 2 | |
| Per-vendor allocation limits | Phase 2 | Phase 0: shared dropship pool, first-come-first-served |
| Vendor tier system (automated) | Phase 2 | Phase 0: tier manually set from Shellz Club plan |
| Real-time ATP webhooks to vendors | Phase 1 | Phase 0: Echelon pushes ATP directly to eBay listings |
| CSV/data feed exports | Removed | Per Section 16.2 — replaced by direct eBay push |
| Packing slips (plain or branded) | Removed | Per Section 16.1 — Card Shellz branded boxes, no slips |
| Vendor-branded shipping | Removed | Per Section 16.1 — always Card Shellz branded |
| Agent commerce API | Phase 2 | |
| cardshellz.io crypto storefront | Phase 3 | |
| International shipping | Phase 3 | |
| Vendor pricing override (set own retail) | Phase 1 | Phase 0: use Card Shellz MSRP |

---

*End of specification. Ready for engineering implementation.*
