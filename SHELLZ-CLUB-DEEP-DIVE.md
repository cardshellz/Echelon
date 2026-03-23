# Shellz Club App — Deep Dive Architecture Review

**Author:** Senior Systems Architect  
**Date:** 2026-03-22  
**Status:** READ-ONLY code review — no modifications made  
**Scope:** Full codebase analysis of `/home/cardshellz/.openclaw/workspace-webmaster/shellz-club-app/`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Directory Structure](#3-directory-structure)
4. [Database Schema — Every Table](#4-database-schema)
5. [Server Modules](#5-server-modules)
6. [Every Route (Grouped)](#6-every-route)
7. [Feature-by-Feature Review](#7-feature-by-feature-review)
8. [Shopify Integration Points](#8-shopify-integration-points)
9. [Code Quality Assessment](#9-code-quality-assessment)
10. [Gaps & Improvements](#10-gaps--improvements)
11. [Dropship Integration Points](#11-dropship-integration-points)
12. [Recommendations Before Adding Subscription Billing](#12-recommendations)

---

## 1. Executive Summary

The Shellz Club app is a **custom Shopify membership/subscription engine** built as a monolithic Express.js + React SPA. It is deployed on **Heroku** and connects to a **Neon PostgreSQL** database (shared with Echelon). It handles:

- **Membership plans** with tiered pricing (Free → Hobby Shop → Club)
- **Custom pricing engine** that creates Shopify draft orders with member prices
- **Rewards/loyalty system** with points earning, redemption, and gamification medals
- **Content gating** via access rules
- **Storefront integration** via a 7,700-line JavaScript file injected into the Shopify theme
- **Subscription contract scaffolding** (tables exist, Shopify Selling Plans API wired, but NOT handling actual recurring billing)

### Critical Finding

**The app does NOT currently handle subscription billing.** The `subscription_contracts`, `subscription_billing_attempts`, and `selling_plan_groups` tables exist and the Shopify Selling Plans GraphQL API is wired up, but this is **exploratory/scaffolding code** — memberships are purchased as one-time Shopify products. Appstle (or equivalent) still handles actual recurring billing externally. The Shellz Club app reacts to `orders/paid` webhooks to detect membership purchases and manage plan state.

---

## 2. Architecture Overview

### Stack
| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js (tsx for dev, esbuild for production) |
| **Server** | Express.js 4.x (single process) |
| **Client** | React 19 + Vite + Tailwind CSS + shadcn/ui + wouter (routing) + TanStack Query |
| **Database** | PostgreSQL via Drizzle ORM (`@neondatabase/serverless` + `pg` Pool) |
| **Hosting** | Heroku (`Procfile`: `web: npm run start`, `release: node dist/migrate.cjs`) |
| **Shopify API** | REST Admin API (2024-10) + GraphQL Admin API + Storefront API |
| **Email** | Klaviyo (API integration for lists, profiles, events) |
| **File uploads** | Multer (memory storage for CSV imports, icon uploads) |

### Structure: Monolith with Service Modules

```
Express app (server/index.ts)
├── routes.ts          (17,286 lines — ALL routes in one file)
├── storage.ts         (4,846 lines — database access layer / "repository")
├── shopify.ts         (3,433 lines — Shopify REST + GraphQL client)
├── billing.ts         (1,246 lines — subscription billing logic)
├── klaviyo.ts         (997 lines — Klaviyo email marketing)
├── social-oauth.ts    (736 lines — YouTube/Facebook OAuth)
├── rewards.ts         (611 lines — rewards earning logic)
├── medalBenefits.ts   (586 lines — gamification medal fulfillment)
├── pricing.ts         (303 lines — pricing engine)
├── blockchain.ts      (272 lines — future crypto token integration)
├── migrate.ts         (297 lines — Drizzle migration runner)
├── db.ts              (34 lines — database connection)
├── rewardsLabels.ts   (8 lines — shared label constants)
├── static.ts          (23 lines — static file serving)
└── vite.ts            (58 lines — dev server setup)
```

### Auth Model

**There is NO traditional auth (no sessions, no login).** The admin dashboard is **completely open** — no authentication whatsoever. Anyone who knows the Heroku URL can access the admin panel.

For storefront/portal operations:
- **Storefront endpoints** (`/api/storefront/*`) use CORS origin validation (checks against Shopify domain)
- **Portal auth** (`/api/portal/auth`) accepts a Shopify `logged_in_customer_id` from the app proxy
- **Webhook auth** uses HMAC-SHA256 verification against Shopify webhook signing secret
- **Internal API** (`/api/internal/*`) uses `X-Internal-Api-Key` header check
- **Migration endpoints** use `X-Admin-Api-Key` header check

### How It Talks to Shopify

1. **REST Admin API** — Products, customers, webhooks, price rules, discount codes, draft orders, orders, collections, fulfillments
2. **GraphQL Admin API** — Draft order creation (with pricing overrides), selling plans, subscription contracts, discount code management, product selling plans, cart validation
3. **Storefront API** — Cart queries (via storefront access token)
4. **App Proxy** — Shopify routes `https://cardshellz.com/apps/shellz-club/*` through to the Heroku app's `/api/app-proxy` endpoint
5. **Webhooks** — `orders/paid`, `orders/cancelled`, `refunds/create`, `customers/create`, `customers/update`, `products/create`, `products/update`, `products/delete`, `fulfillments/create`, `fulfillments/update`, `inventory_levels/update`, `collections/create`, `collections/update`, `collections/delete`, `subscription_contracts/create`, `subscription_contracts/update`, `subscription_billing_attempts/success`, `subscription_billing_attempts/failure`
6. **Theme Extension** — `cardshellz-membership.js` (7,700 lines) injected into `<head>` via Shopify theme app extension

### How It Talks to the Database

- **Drizzle ORM** with `pg` connection pool
- **SSL enabled in production** (Heroku/Neon)
- All DB access goes through `storage.ts` (`DatabaseStorage` class implementing `IStorage` interface)
- Mix of Drizzle query builder and raw SQL (`db.execute(sql`...`)`) for complex operations
- **No transactions** in most operations (except member merges)
- No connection pooling tuning visible

---

## 3. Directory Structure

```
shellz-club-app/
├── client/                          # React SPA (admin dashboard)
│   ├── src/
│   │   ├── App.tsx                  # Router: wouter
│   │   ├── pages/                   # 16 admin pages
│   │   │   ├── Dashboard.tsx
│   │   │   ├── Members.tsx
│   │   │   ├── Plans.tsx
│   │   │   ├── Rewards.tsx
│   │   │   ├── Discounts.tsx
│   │   │   ├── Settings.tsx
│   │   │   ├── Notifications.tsx
│   │   │   ├── AccessRules.tsx
│   │   │   ├── CollectionAlerts.tsx
│   │   │   ├── PortalConfig.tsx
│   │   │   ├── MemberPortal.tsx     # Customer-facing portal (served via app proxy)
│   │   │   ├── StorefrontPreview.tsx
│   │   │   ├── DesignComparison.tsx
│   │   │   ├── Debug.tsx
│   │   │   ├── Subscriptions.tsx    # (exists but removed from router)
│   │   │   └── Portal.tsx
│   │   ├── components/
│   │   │   ├── layout/             # AdminLayout, Sidebar
│   │   │   ├── MemberDetailSheet.tsx
│   │   │   ├── MemberDetailSheetV2.tsx
│   │   │   └── ui/                 # 60+ shadcn/ui components
│   │   ├── hooks/
│   │   └── lib/
│   └── index.html
├── server/                          # Express server
│   ├── index.ts                     # App bootstrap, HMAC middleware
│   ├── routes.ts                    # 17,286 lines — EVERYTHING
│   ├── storage.ts                   # 4,846 lines — DB access
│   ├── shopify.ts                   # 3,433 lines — Shopify API client
│   ├── billing.ts                   # 1,246 lines — Billing service
│   ├── klaviyo.ts                   # 997 lines — Klaviyo service
│   ├── social-oauth.ts             # 736 lines — OAuth flows
│   ├── rewards.ts                   # 611 lines — Rewards engine
│   ├── medalBenefits.ts            # 586 lines — Medal fulfillment
│   ├── pricing.ts                   # 303 lines — Pricing engine
│   ├── blockchain.ts               # 272 lines — Crypto (future)
│   ├── migrate.ts                   # 297 lines
│   ├── db.ts                        # 34 lines
│   ├── rewardsLabels.ts            # 8 lines
│   ├── static.ts                    # 23 lines
│   └── vite.ts                      # 58 lines
├── shared/
│   └── schema.ts                    # 1,442 lines — Drizzle schema (all tables)
├── theme-extension/                 # Shopify theme app extension
│   ├── assets/
│   │   └── cardshellz-membership.js # 7,700 lines — storefront JS
│   ├── blocks/
│   │   ├── member-price-display.liquid  # (deprecated, hidden via CSS)
│   │   └── rewards-balance.liquid
│   ├── shopify.extension.toml
│   └── SETUP-GUIDE.md
├── migrations/                      # 60+ SQL migration files
├── scripts/                         # Maintenance/backfill scripts
├── sql/                             # Ad-hoc SQL fixes
├── dist/                            # Build output (esbuild)
├── Procfile                         # Heroku: web + release
├── package.json
├── tsconfig.json
├── vite.config.ts
└── drizzle.config.ts
```

---

## 4. Database Schema — Every Table

**Source:** `shared/schema.ts` (1,442 lines)

### Core Membership Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `plans` | Membership plan definitions | `id`, `name`, `tierLevel` (0-3), `price`, `billingInterval`, `flatDiscountPercent`, `shopifyProductId`, `shopifyVariantId`, `customerTag`, `autoRenewEnabled`, `isFreeTier`, 40+ pill/badge styling columns |
| `members` | Member profiles | `id`, `shopifyCustomerId` (unique), `email`, `planId` (legacy), `status`, `startDate`, `walletAddress` |
| `member_shopify_customer_ids` | Multi-ID alias table (handles Shopify customer merges) | `shopifyCustomerId` (PK), `memberId`, `lastSeenAt` |
| `member_subscriptions` | Active subscription records | `id`, `memberId`, `planId`, `status`, `billingInterval`, `cycleStartedAt`, `cycleEndsAt`, `amountPaidCents`, trial/intro fields, `scheduledPlanId` |
| `member_current_membership` | Denormalized current-state index (fast lookups) | `memberId` (PK), `subscriptionId`, `planId`, `status`, `cycleEndsAt` |
| `subscription_ledger` | All billing events (upgrades, downgrades, refunds) | `id`, `subscriptionId`, `memberId`, `eventType`, charges/credits |

### Pricing Tables

| Table | Purpose |
|-------|---------|
| `pricing_rules` | **DEPRECATED** — Legacy per-variant pricing. Kept for migration compat. |
| `plan_variant_overrides` | Per-variant pricing overrides per plan (flat_percent, fixed_price, exclude) |
| `plan_collection_exclusions` | Collections excluded from wholesale pricing per plan |

### Orders (Source of Truth)

| Table | Purpose |
|-------|---------|
| `shopify_orders` | Order headers from webhooks. Full pricing breakdown with `planDiscountsCents`, `couponDiscountsCents` |
| `shopify_order_items` | Line items with `paidPriceCents`, `planDiscountCents`, `couponDiscountCents`, raw `discountAllocations` JSONB |
| `order_item_plan_savings_snapshots` | Potential savings calculations (what non-members would save if they joined) |

### Rewards System

| Table | Purpose |
|-------|---------|
| `reward_ledger` | **Source of truth** for all reward events. `entryType` (earn/redeem/expire/adjust/refund), signed `points`, `referenceId` for idempotency |
| `reward_redemptions` | Checkout tracking for pending redemptions (discount codes, checkout URLs) |
| `earning_activities` | Master list of ways to earn (purchase, signup, birthday, social, reviews, referrals) |
| `plan_earning_rules` | Per-plan config for each earning activity (points/multiplier, frequency caps) |
| `member_earning_events` | Tracks individual earning instances |
| `redemption_options` | Redemption catalog (store credit, discount code, free shipping, etc.) |
| `plan_redemption_rules` | Per-plan redemption availability and custom values |
| `member_stats` | Pre-calculated metrics (lifetime_savings, rewards_balance, total_orders, total_spent) |

### Gamification

| Table | Purpose |
|-------|---------|
| `reward_medals` | Medal tiers (Bronze, Silver, Gold, Platinum) with threshold rules |
| `plan_medal_benefits` | Benefits per medal per plan |
| `member_medal_achievements` | Achievement history |
| `medal_benefit_grants` | Issued benefits (discount codes, free products) |

### Subscription/Billing (Scaffolding)

| Table | Purpose | Status |
|-------|---------|--------|
| `subscription_contracts` | Shopify subscription contract tracking | **Scaffold only** — populated by webhooks but not driving billing |
| `subscription_billing_attempts` | Billing attempt tracking | **Scaffold only** |
| `selling_plan_groups` | Shopify selling plan references | **Scaffold only** |

### Shopify Cache

| Table | Purpose |
|-------|---------|
| `shopify_products` | Product cache |
| `shopify_variants` | Variant cache with prices, SKUs, `inventoryItemId` |
| `shopify_collections` | Collection cache |
| `product_collections` | Product-to-collection mapping |

### Notifications & Content

| Table | Purpose |
|-------|---------|
| `notification_templates` | Email templates (membership, rewards) |
| `access_rules` | Content gating rules (page/collection/product → plan requirements → redirect/hide/blur) |
| `portal_config` | Portal/storefront UI configuration (single row) — massive: ~60 columns for styling, upsell, fly-in |
| `app_settings` | App-level settings (Shopify credentials, Klaviyo, blockchain, badge styles) |

### Other

| Table | Purpose |
|-------|---------|
| `discounts` | Internal discount codes (separate from Shopify) |
| `reward_overrides` | SKU-level reward multiplier overrides |
| `marketplace_exclusions` | Exclude eBay/Amazon customers (by email domain or tag) |
| `back_in_stock_subscriptions` | OOS notification subscriptions |
| `back_in_stock_sends` | Send history |
| `collection_alert_settings` | Per-collection new-drop alert config |
| `collection_alert_subscriptions` | User subscriptions to collection alerts |
| `collection_alert_notification_queue` | Digest queue |
| `social_accounts` | Connected OAuth accounts (YouTube, Facebook) |
| `social_action_verifications` | Social action verification tracking |
| `blockchain_config` | Crypto token settings (future) |
| `token_transactions` | Token transaction history (future) |
| `member_referrals` | Referral relationships |

**Total: ~40 tables**

---

## 5. Server Modules

### `storage.ts` — The Data Access Layer (4,846 lines)

- Implements `IStorage` interface with **200+ methods**
- ALL database access goes through this single class
- Mix of Drizzle ORM queries and raw SQL for complex operations
- Notable patterns:
  - `normalizeShopifyCustomerIdValue()` — handles GID format, scientific notation, CSV artifacts
  - `getMemberByShopifyId()` — tries members table first, then falls back to alias table
  - `getMemberByEmail()` — case-insensitive with deterministic "best row" selection (prefers real Shopify IDs over placeholders)
  - `mergeMembers()` — full member merge in a transaction (moves all FK references)
  - `createPotentialSavingsSnapshotsForOrder()` — calculates what non-members would have saved
  - `recalculateMemberStatsBulkSQL()` — bulk SQL for stats recalculation

### `shopify.ts` — Shopify API Client (3,433 lines)

Full-featured Shopify client covering:
- Products (paginated, all, single)
- Customers (search, tags, paginated)
- Collections (smart + custom)
- Draft orders (with price overrides for member pricing)
- Discount codes (REST + GraphQL)
- Webhooks (CRUD + idempotent `ensureWebhook()`)
- Selling Plans (create/delete groups, add products/variants)
- Subscription Contracts (get, cancel, pause, resume)
- Order tracking (GraphQL + REST fallbacks)
- Variant pricing (GraphQL batch `nodes` query)
- Cart queries (Storefront API)
- Rate limiting with retry logic (429 handling, proactive throttling)

### `billing.ts` — Subscription Billing Service (1,246 lines)

Full billing lifecycle management:
- `calculateUpgrade()` / `calculateDowngrade()` — prorated pricing
- `executeUpgrade()` — creates subscription, handles trial/intro, records ledger
- `executeDowngrade()` — immediate or scheduled (end-of-term)
- `executeCancelToFreeTier()` — preserves rewards
- `executeCancelAtEndOfTerm()` — turns off auto-renew
- `executeImmediateCancellation()` — with refund calculation
- `reactivateSubscription()` — re-enables auto-renew
- `processScheduledDowngrades()` — cron-ready batch processor
- `getAvailableTransitions()` — lists all valid upgrade/downgrade paths
- Trial/intro period handling with concurrent vs sequential modes

**Important:** This service manages plan state and subscription records, but does NOT create Shopify charges. It relies on members purchasing membership products through the regular Shopify checkout (via draft orders).

### `rewards.ts` — Rewards Engine (611 lines)

- `calculateRewardsForActivity()` — checks plan eligibility, frequency caps, point values
- `processEarningEvent()` — validates and awards points
- `awardPurchaseRewards()` — called from order webhook
- `awardSignupBonus()` — called after member creation
- `awardBirthdayBonus()` / `processTodaysBirthdays()` — birthday automation
- `awardSocialActivity()` — honor-system social media clicks
- `getAvailableActivitiesForMember()` — returns eligible activities with point values
- `getMemberRewardsSummary()` — balance + history

### `pricing.ts` — Pricing Engine (303 lines)

- `calculateVariantPrice()` — determines member price for a variant:
  1. Check collection exclusions
  2. Check variant-level override (fixed_price, flat_percent, exclude)
  3. Fall back to plan's `flatDiscountPercent`
- `calculateCartPricing()` — batch calculation for full cart
- `calculateRewards()` — reward earning calculation with SKU-level overrides
- `applyDiscount()` — validates internal discount codes

### `klaviyo.ts` — Klaviyo Integration (997 lines)

- Profile management (create, update, search)
- List management (create, subscribe, unsubscribe, sync)
- Segment queries
- Member sync (individual + bulk)
- Plan list transitions (move member between plan-specific lists on upgrade/downgrade)
- Back-in-stock event tracking
- Collection alert notifications
- Chunked bulk sync with rate limiting

### `medalBenefits.ts` — Gamification Medal Fulfillment (586 lines)

- `processMedalAchievement()` — awards all benefits for a medal
- `fulfillBenefit()` — dispatches by type: discount codes, bonus points, free membership upgrades
- Creates Shopify discount codes for medal rewards
- Klaviyo notification for achievements
- `checkMedalProgress()` — evaluates member against medal thresholds

---

## 6. Every Route (Grouped)

### Storefront API (CORS-protected, served to Shopify theme)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/storefront/pricing` | GET | Get pricing for variants (by customer tags) |
| `/api/storefront/collection/:collectionId/products` | GET | Get collection products with member pricing |
| `/api/storefront/access-check` | GET | Content gating check |
| `/api/storefront/member-status` | GET | Get member status by Shopify customer ID |
| `/api/storefront/member-pricing` | GET | Bulk pricing for PDP/collection |
| `/api/storefront/plan-tags` | GET | All plan tags + styling config |
| `/api/storefront/detect-member` | GET | Detect member from customer ID |
| `/api/storefront/draft-checkout` | POST | Create draft order with member prices |
| `/api/storefront/validate-discount` | POST | Validate promo code for cart |
| `/api/storefront/redeem` | POST | Redeem rewards points at checkout |
| `/api/storefront/redeem-preview` | POST | Preview redemption calculation |
| `/api/storefront/back-in-stock/*` | POST/GET | Back-in-stock subscriptions |
| `/api/storefront/collection-alert/*` | POST/GET | Collection drop alerts |

### App Proxy (Shopify app proxy → authenticated customer context)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/app-proxy` | GET | Serves member portal HTML (Liquid-rendered via Shopify) |
| `/api/portal/auth` | GET | Authenticate member via Shopify customer ID |
| `/api/portal/featured-products` | GET | Featured products for portal |
| `/api/portal/cancellation-options/:memberId` | GET | Available cancellation options |
| `/api/portal/cancel-at-end-of-term/:memberId` | POST | Turn off auto-renew |
| `/api/portal/cancel-immediately/:memberId` | POST | Immediate cancel |
| `/api/portal/reactivate/:memberId` | POST | Re-enable auto-renew |
| `/api/portal/claim-activity/:memberId` | POST | Claim social activity points |
| `/api/portal/earning-activities/:memberId` | GET | Available earning activities |
| `/api/portal/birthday/:memberId` | POST | Update birthday |
| `/api/portal/claim-birthday/:memberId` | POST | Claim birthday bonus |

### Webhooks (HMAC-verified)
| Route | Topic | Purpose |
|-------|-------|---------|
| `/api/webhooks/orders/paid` | orders/paid | **Core:** Detect membership purchases, create/upgrade members, process order items, calculate rewards, snapshot savings |
| `/api/webhooks/orders/refunded` | refunds/create | Handle refunds: reverse rewards, adjust member stats |
| `/api/webhooks/orders/cancelled` | orders/cancelled | Handle cancellations |
| `/api/webhooks/customers/create` | customers/create | Auto-create free tier members |
| `/api/webhooks/customers/update` | customers/update | Sync customer data changes |
| `/api/webhooks/products/create` | products/create | Update product cache, collection alerts |
| `/api/webhooks/products/update` | products/update | Update product/variant cache |
| `/api/webhooks/products/delete` | products/delete | Remove from cache |
| `/api/webhooks/inventory_levels/update` | inventory_levels/update | Back-in-stock notifications |
| `/api/webhooks/collections/*` | collections/* | Update collection cache |
| `/api/webhooks/subscription-contracts/create` | subscription_contracts/create | Record contract in DB |
| `/api/webhooks/subscription-contracts/update` | subscription_contracts/update | Update contract status |
| `/api/webhooks/subscription-billing/success` | subscription_billing_attempts/success | Record billing success |
| `/api/webhooks/subscription-billing/failure` | subscription_billing_attempts/failure | Record billing failure |
| `/api/webhooks/fulfillments/*` | fulfillments/* | Update order fulfillment status |
| `/api/webhooks/register` | — | Bulk register all webhooks |

### Admin API (NO AUTH — open to anyone with the URL)
- **Plans CRUD:** `/api/plans` (GET, POST), `/api/plans/:id` (GET, PATCH, DELETE)
- **Members CRUD:** `/api/members` (GET, POST), `/api/members/:id` (GET, PATCH, DELETE)
- **Member management:** merge, subscription, ledger, transitions, upgrade/downgrade/cancel
- **Pricing:** variant overrides, collection exclusions, bulk import/export
- **Rewards:** earning activities, earning rules, earning events, redemption options
- **Medals:** reward medals, plan medal benefits, benefit grants
- **Shopify:** connect, disconnect, catalog sync, customer sync, tag sync, price rules
- **Klaviyo:** status, lists, segments, member sync, bulk sync
- **Settings:** app settings, portal config, notification templates
- **Billing:** process scheduled downgrades
- **Migration:** reward data, order import, stats recalculation
- **Debug:** draft order inspection, Shopify order inspection

### Internal API (API key protected)
| Route | Purpose |
|-------|---------|
| `/api/internal/members` | Paginated member list for Echelon |
| `/api/internal/orders` | Order data for Echelon |
| `/api/internal/rewards-balances` | Batch reward balances for Echelon |

---

## 7. Feature-by-Feature Review

### 7.1 Plans & Pricing

**How the pricing engine works:**

1. Each plan has a `flatDiscountPercent` (e.g., 20% off retail)
2. Plans can have **variant-level overrides** (`plan_variant_overrides`) that supersede the flat discount:
   - `flat_percent` — custom percentage for this variant
   - `fixed_price` — specific dollar price
   - `exclude` — no discount on this variant
3. Plans can **exclude entire collections** (`plan_collection_exclusions`)
4. Legacy `pricing_rules` table is deprecated but still in schema

**How the storefront shows member prices:**

The 7,700-line `cardshellz-membership.js` runs on every page:
1. Detects customer login via `__st.cid` (Shopify customer ID cookie)
2. Calls `/api/storefront/member-status` to get member's plan
3. Calls `/api/storefront/member-pricing` or `/api/storefront/pricing` to get prices
4. **Injects pricing UI directly into the DOM**: split pills showing member price vs retail, savings badges, upsell widgets
5. Intercepts "Add to Cart" — creates a **Shopify draft order** via `/api/storefront/draft-checkout` with `priceOverride` on each line item
6. Redirects customer to the draft order's `invoiceUrl` for checkout

**Critical:** Member pricing is NOT handled via Shopify discount codes or automatic discounts. It uses **draft orders with price overrides**, which means every member checkout goes through the app's server to create a draft order. This is a single point of failure.

### 7.2 Members

**Creation flow:**
1. Shopify `customers/create` webhook → auto-creates free tier member
2. Manual admin creation via `/api/members` POST
3. CSV bulk import via `/api/members/bulk-import`
4. Order webhook detects membership product purchase → creates/upgrades member

**Shopify customer sync:**
- `shopifyCustomerId` stored on member record (normalized from GID/numeric)
- `member_shopify_customer_ids` alias table handles Shopify customer merges
- Customer tags synced: plan's `customerTag` added/removed on upgrade/downgrade
- Shopify customer lookup: by ID first, then email fallback

**Status management:**
- Member `status`: active, paused, cancelled (but `members.planId` is legacy)
- **Source of truth** for plan: `member_subscriptions.planId` (via `member_current_membership`)
- Marketplace exclusions prevent member creation for eBay/Amazon customers

### 7.3 Subscriptions / Billing

**What exists today:**

The `billing.ts` service (1,246 lines) is **fully functional for plan management** but **does NOT handle payment collection**. It:
- Calculates prorated upgrades/downgrades
- Manages trial and intro pricing periods (concurrent and sequential modes)
- Creates subscription records with cycle dates
- Handles end-of-term cancellation scheduling
- Records everything in the subscription ledger

**How billing actually works today:**
1. Membership products are listed in the Shopify store (linked via `plans.shopifyProductId`)
2. Customer purchases membership through normal Shopify checkout (or draft order)
3. `orders/paid` webhook detects the membership product → calls `billingService.executeUpgrade()` or creates subscription directly
4. For renewals: customer re-purchases the membership product
5. **No automatic recurring billing** — the app does NOT charge customers on cycle expiry

**Subscription contract tables:**
- `subscription_contracts` — populated by `subscription_contracts/create` and `subscription_contracts/update` webhooks
- `subscription_billing_attempts` — populated by `subscription_billing_attempts/success` and `subscription_billing_attempts/failure` webhooks
- `selling_plan_groups` — stores Shopify selling plan references created via admin UI
- These are **recording** data from Shopify, not driving it

**What would it take to replace Appstle:**

This is a significant undertaking. To build native subscription billing, you need:

1. **Shopify Selling Plans** fully wired (partially done):
   - Creating selling plan groups ✅ (`shopify.ts:createSellingPlanGroup()`)
   - Adding products to selling plans ✅ (`shopify.ts:addProductsToSellingPlanGroup()`)
   - Handling subscription contract lifecycle ⚠️ (webhooks record data, but don't drive actions)

2. **Billing cycle management** (NOT done):
   - Shopify `subscriptionBillingCycleCharge` mutation to actually charge customers
   - Dunning flow for failed payments
   - Grace periods
   - Auto-retry logic

3. **Customer-facing subscription management** (partially done):
   - Portal cancellation UI ✅
   - Portal plan change UI ⚠️ (admin-driven, not self-service for billing changes)
   - Payment method update ❌ (needs Shopify Customer Account API)

4. **Billing webhooks already wired** but need action handlers:
   - `subscription_billing_attempts/success` — currently just records in DB
   - `subscription_billing_attempts/failure` — currently just records in DB

### 7.4 Rewards

**Points accrual:**
- **Purchase:** `orders/paid` webhook → calculates `multiplierValue / 100 * orderTotal`
- **Signup:** `awardSignupBonus()` → called after member creation
- **Birthday:** `processTodaysBirthdays()` → cron-ready, checks UTC date match
- **Social:** Honor-system click tracking (Facebook, Instagram, YouTube, TikTok, Pinterest, X)
- **Referral:** Scaffolded but not fully automated

**Redemption:**
- Member redeems points → Shopify discount code created (`SHELLZ-XXXXXXXX`)
- Single-use, 48-hour expiry, customer-specific
- `reward_ledger` entry with `status: 'pending'`
- When order webhook fires with the discount code → marks as `completed`
- Expired/unused codes cleaned up via `/api/admin/cleanup-expired-redemptions`

**Expiry:**
- Configurable per plan: `pointsExpiryMode` (never, custom) + `pointsExpiryDays`
- **No automatic expiry job exists** — the schema supports it but no cron runs it

**Ledger structure:**
- `reward_ledger` is the **single source of truth**
- Each entry: `entryType` (earn/redeem/expire/adjust/refund), signed `points`, `referenceId` (idempotency)
- Balance = `SUM(points) WHERE status IN ('completed', 'pending')`
- `member_stats.rewardsBalanceCents` is a cached value (multiplied by 100)

### 7.5 Content Gating

**`access_rules` table:**
- `resourceType`: page, collection, product
- `resourceId`: URL path or Shopify ID
- `requiredPlanIds`: array (null = all members)
- `gatingBehavior`: redirect, hide, blur
- `redirectUrl`: where to send non-members

**How it's enforced:**
- `/api/storefront/access-check` endpoint called from `cardshellz-membership.js`
- The JS checks the current page URL against access rules
- For `redirect`: JS redirects to `redirectUrl`
- For `hide`/`blur`: JS manipulates DOM
- **Server-side enforcement: NONE** — purely client-side JavaScript. Someone who disables JS or calls the API directly bypasses all gating.

### 7.6 Badges / Storefront UI

**The pill/badge system:**

The `cardshellz-membership.js` (7,700 lines) injects pricing badges directly into Shopify theme pages:
- **Collection pages:** Split-pill showing "SAVED $X.XX" on product cards
- **Product detail pages:** Member price display with savings
- **Upsell widgets:** For non-members, shows potential savings
- **Fly-in drawer:** Full membership sales pitch triggered from product page

**Injection method:** Theme app extension via `shopify.extension.toml`:
```toml
[[extensions.targeting]]
module = "./assets/cardshellz-membership.js"
target = "head"
```
This injects the script into `<head>` on every page. The JS uses `MutationObserver` to watch for DOM changes and re-inject pricing badges.

The legacy `member-price-display.liquid` block exists but is **hidden via CSS** (`display: none !important`).

**Pill styling** is highly configurable per plan: colors, shimmer effects, border radius, opacity, verb text ("SAVED", "SAVE", "WHOLESALE"), scale. All stored in `plans` table columns (`pillVerb`, `pillLeftBg`, `pillRightBg`, etc.)

### 7.7 Gamification / Medals

**Status: Functional but lightly used**

- `reward_medals` table stores tiers with threshold rules (lifetime points, order count)
- `plan_medal_benefits` configures per-plan rewards for each medal tier
- `medal_benefit_grants` tracks issued benefits (discount codes, bonus points, free membership)
- `medalBenefits.ts` has full fulfillment logic:
  - Creates Shopify discount codes for discount benefits
  - Awards bonus points via reward ledger
  - Can upgrade membership for free_membership benefits
  - Sends Klaviyo notification emails

The medal system appears functional in the admin UI but it's unclear if any medals are actually configured in production.

---

## 8. Shopify Integration Points

### Webhooks (registered via `/api/webhooks/register`)
All 17 topics listed in Section 6 above.

### API Calls
| Surface | Method | Purpose |
|---------|--------|---------|
| REST Admin | GET/PUT customers | Tag sync, customer lookup |
| REST Admin | GET products/collections | Catalog sync |
| REST Admin | POST webhooks | Registration |
| REST Admin | POST/DELETE price_rules | Legacy discount management |
| GraphQL Admin | `draftOrderCreate` | Member-priced checkout |
| GraphQL Admin | `discountCodeBasicCreate/Delete` | Rewards redemption codes |
| GraphQL Admin | `codeDiscountNodeByCode` | Promo code validation |
| GraphQL Admin | `sellingPlanGroupCreate/Delete` | Subscription selling plans |
| GraphQL Admin | `sellingPlanGroupAddProducts` | Attach products to selling plans |
| GraphQL Admin | `subscriptionContractCancel/Pause/Resume` | Contract management |
| GraphQL Admin | `nodes` (ProductVariant) | Batch variant price lookup |
| GraphQL Admin | `product.collections` | Product-collection relationships |
| GraphQL Admin | `order.fulfillments` | Tracking info |
| Storefront API | `cart` query | Cart validation for shipping credit |

### App Proxy
- Shopify routes `/apps/shellz-club/*` → Heroku `/api/app-proxy`
- Returns HTML that bootstraps the React member portal

### Theme Extension
- `cardshellz-membership.js` injected via app embed in `<head>`
- Rewrites product pricing DOM elements
- Intercepts Add to Cart with draft order flow
- Manages rewards redemption UI
- Shows upsell/savings badges

---

## 9. Code Quality Assessment

### The 17,286-line routes.ts

**This is the single biggest code quality issue.** It contains:
- ALL 200+ Express route handlers
- Webhook handlers with complex business logic (orders/paid is ~800 lines alone)
- CSV import/export logic
- Admin CRUD for every entity
- Storefront/portal endpoints
- Migration/backfill endpoints
- Pricing comparison tools
- Bulk sync jobs

**Should it be split?** Absolutely. Recommended groupings:
1. `routes/webhooks.ts` — All Shopify webhook handlers (~2,500 lines)
2. `routes/storefront.ts` — Storefront API endpoints (~2,000 lines)
3. `routes/admin-members.ts` — Member CRUD + management (~1,500 lines)
4. `routes/admin-plans.ts` — Plan/pricing CRUD (~1,000 lines)
5. `routes/admin-rewards.ts` — Rewards/medals/redemptions (~1,500 lines)
6. `routes/admin-shopify.ts` — Shopify sync/setup (~1,500 lines)
7. `routes/portal.ts` — Member portal endpoints (~500 lines)
8. `routes/migration.ts` — Import/export/migration (~3,000 lines)
9. `routes/admin-integrations.ts` — Klaviyo, social, blockchain (~1,500 lines)
10. `routes/internal.ts` — Internal API for Echelon (~200 lines)

### Error Handling

**Fragile.** Pattern is mostly:
```typescript
try {
  // ... business logic
} catch (error) {
  res.status(500).json({ error: "Failed to do X" });
}
```

Problems:
- Error details often swallowed in production
- No request-level error correlation (no request IDs)
- The global error handler in `index.ts` **re-throws** the error: `throw err` — this will crash the process for unhandled errors in middleware
- No structured logging
- Webhook handlers `catch` but still return 200 (Shopify retries on non-2xx)

### Database Access Patterns

- **Drizzle ORM** for most queries (parameterized, safe from SQL injection)
- Raw SQL via `db.execute(sql`...`)` for complex operations (also parameterized via Drizzle's `sql` template tag)
- **No N+1 protections** — many operations loop and query per-item:
  - `upsertShopifyProducts()` does SELECT + INSERT/UPDATE per product
  - `upsertShopifyVariants()` same pattern
  - `bulkUpsertPlanEarningRules()` queries + inserts per rule
- **Transactions only used for member merges** — other multi-step operations (like order processing) are not transactional
- **No prepared statements** cache, but Drizzle parameterizes queries

### Test Coverage

**Zero.** No test files found anywhere in the project. No test framework configured. No CI/CD pipeline visible.

### Other Quality Issues

1. **No authentication on admin panel** — anyone with the Heroku URL has full admin access
2. **Client-side content gating only** — JS-based, trivially bypassable
3. **Scientific notation detection** for Shopify IDs is clever but fragile
4. **In-memory OAuth state** (`pendingOAuthFlows` Map) — lost on deploy/restart
5. **Hardcoded Heroku URL** in `cardshellz-membership.js` as fallback: `https://shellz-club-app-c299723495c9.herokuapp.com`
6. **Global mutable state** for Klaviyo bulk sync (in-memory progress tracking)

---

## 10. Gaps & Improvements

### What's Broken
1. **Global error handler re-throws**: `server/index.ts:177` — `throw err` will crash the Node.js process
2. **No admin authentication** — the entire admin panel is open
3. **Content gating is client-side only** — trivially bypassable

### What's Incomplete/Stub
1. **Blockchain/crypto rewards** — Tables exist, config UI exists, but no actual blockchain integration
2. **Referral system** — Tables exist, code exists, but no automated referral tracking
3. **Points expiry** — Schema supports it, no cron job runs it
4. **Subscription billing** — Selling Plans wired but not driving actual charges
5. **Product review rewards** — Activity type defined but no Judge.me integration

### What Needs Refactoring Before Extending

1. **Split routes.ts** — 17K lines is unmaintainable. Extract into domain-specific route modules.
2. **Add admin authentication** — Even basic API key auth would be a massive improvement
3. **Add transactions** to multi-step operations — Order processing, plan upgrades, and redemptions should be atomic
4. **Fix the global error handler** — Remove the `throw err` that crashes the process
5. **Extract webhook business logic** from route handlers into service modules
6. **Add request IDs** for log correlation
7. **Add health check endpoint** for Heroku monitoring

### Architecture Violations (Similar to Echelon's Issues)

1. **God file**: `routes.ts` at 17K lines is the equivalent of Echelon's boundary issues
2. **Mixed concerns**: Route handlers contain business logic, data transformation, Shopify API calls, Klaviyo syncs all inline
3. **No domain boundaries**: Everything flows through `storage.ts` → routes.ts with no clean service layer separation
4. **Shared database**: Both Echelon and Shellz Club share the same Neon database without clear schema ownership boundaries
5. **In-memory state**: OAuth flows, sync progress, cache — all lost on restart

---

## 11. Dropship Integration Points

### Where Would a "Dropship" Benefit Gate Into This System?

**Access Rules** (`access_rules` table) is the natural entry point:

```
resourceType: 'collection' (or 'product')
resourceId: <dropship collection/product Shopify ID>
requiredPlanIds: [<dropship plan ID>]
gatingBehavior: 'redirect' (or 'hide')
redirectUrl: '/pages/dropship-membership'
```

However, access rules are currently **client-side only** (enforced by `cardshellz-membership.js`). For dropship, you'd need server-side enforcement:
- Draft order checkout (`/api/storefront/draft-checkout`) should **validate** that the member's plan allows dropship products before creating the order
- The `orders/paid` webhook should **verify** plan eligibility

### What access_rules Changes Are Needed

1. Add a new `resourceType`: `'dropship_benefit'` or reuse `'collection'`
2. Add server-side validation in `draft-checkout` route
3. Consider adding `gatingBehavior: 'dropship_only'` that shows dropship-specific messaging

### How Would the Add-On Subscription Work

**Option A: Separate Plan (Simple)**
- Create a "Dropship Access" plan with its own `shopifyProductId`
- Members purchase it like any other membership
- `orders/paid` webhook creates the subscription
- Access rules gate dropship products to this plan

**Option B: Add-On to Existing Plans (Better UX)**
- New table: `plan_addons` (planId, addonType: 'dropship', price, shopifyProductId)
- New table: `member_addons` (memberId, addonId, status, cycleEndsAt)
- Modify pricing engine to check member addons
- Modify draft checkout to validate addon access

**Option C: Use Existing Tier System**
- Add dropship access as a benefit of higher-tier plans (e.g., Platinum gets dropship)
- Use `planMedalBenefits` or `accessRules` to gate

**Recommended approach for MVP:** Option A (separate plan). It works within the existing architecture without schema changes. Use access rules + server-side validation in draft checkout.

---

## 12. Recommendations Before Adding Subscription Billing

### Must-Do (Before any billing work)

1. **Fix the process crash bug** — Remove `throw err` in global error handler (`server/index.ts:177`)
2. **Add admin authentication** — At minimum, API key auth on all `/api/admin/*` and `/api/plans/*` etc. routes
3. **Add transactions** — The `orders/paid` webhook handler does 10+ writes without a transaction. A mid-flight failure leaves inconsistent state.
4. **Split routes.ts** — Extract webhook handlers and storefront routes into separate files. The 17K monolith makes it dangerous to modify billing logic.

### Should-Do (Makes billing work safer)

5. **Add structured logging** — Request IDs, Shopify order IDs, member IDs in every log line
6. **Add a health check** — `/api/health` returning DB connection status + memory usage
7. **Extract the orders/paid webhook** into a dedicated `OrderProcessor` service class with clear steps: detect membership → create/upgrade member → process line items → calculate rewards → snapshot savings
8. **Add idempotency** to the orders/paid webhook — Check `processedAt` before processing (partially done but not complete)
9. **Move from in-memory state to Redis** — OAuth flows, sync progress, draft order tracking

### Nice-to-Have (Longer term)

10. **Add test coverage** — At minimum: billing calculations, pricing engine, webhook handlers
11. **Server-side content gating** — Move access rule enforcement to the draft checkout flow
12. **Consolidate Echelon/Shellz Club boundaries** — Define clear schema ownership, extract shared tables into a common schema

---

*End of deep dive. This document is current as of the codebase state on 2026-03-22.*
