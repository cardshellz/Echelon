# Shellz Club Membership System — Comprehensive Code Audit

> **Date:** 2026-03-22  
> **Auditor:** Systems Architect (read-only)  
> **Scope:** Every file, feature, table, and gap in the Shellz Club membership system  
> **Status:** COMPLETE

---

## 0. Critical Finding: Two Separate Codebases

**The Shellz Club membership system spans TWO independent applications sharing the SAME database:**

| System | Location | Deployed To | Role |
|--------|----------|-------------|------|
| **Shellz Club App** | `/workspace-webmaster/shellz-club-app/` | Heroku (separate dyno) | Original membership app — plans, members, rewards, pricing, badges, content gating, billing, Shopify storefront integration |
| **Echelon WMS** | `/workspace-engineer/echelon/` | Heroku (`cardshellz-echelon`) | Warehouse/ops platform — recently added subscription management module that duplicates and extends the same tables |

**Both apps write to the same `plans`, `members`, `member_subscriptions`, and `member_current_membership` tables.** This is the single most dangerous architectural issue in the system.

---

## 1. Complete File Inventory

### 1A. Shellz Club App (Original Membership App)

**Server files:**
| File | Lines | Purpose |
|------|-------|---------|
| `server/routes.ts` | 17,286 | Monolithic route file — ALL membership endpoints (plans, members, rewards, pricing, access rules, badges, portal, billing, webhooks, storefront API) |
| `server/storage.ts` | 4,846 | Database operations via Drizzle ORM — CRUD for all membership tables |
| `server/pricing.ts` | 303 | `PricingEngine` class — wholesale price calculation with flat discount, variant overrides, collection exclusions |
| `server/rewards.ts` | 611 | `RewardsService` class — points calculation, earning activities, social activities, birthday/signup bonuses |
| `server/billing.ts` | 1,246 | `BillingService` class — subscription lifecycle, proration, trial/intro phases, upgrade/downgrade logic |
| `server/shopify.ts` | 3,433 | Shopify Admin API wrapper — order webhooks, customer tagging, discount code creation (GraphQL), draft orders, selling plans |
| `server/medalBenefits.ts` | 586 | Medal achievement processing — creates Shopify discounts, awards bonus points, sends Klaviyo notifications |
| `server/klaviyo.ts` | — | Klaviyo email marketing integration |
| `server/blockchain.ts` | — | Blockchain/crypto token integration (future feature) |
| `server/social-oauth.ts` | — | Social media OAuth for earning activities |
| `shared/schema.ts` | ~1,500 | Drizzle schema — 40+ tables defined |

**Client pages:**
| File | Purpose |
|------|---------|
| `client/src/pages/Dashboard.tsx` | Admin dashboard — member counts, MRR, recent activity |
| `client/src/pages/Members.tsx` | Member list + detail management |
| `client/src/pages/Plans.tsx` | Plan CRUD — pricing, features, badges, rewards config |
| `client/src/pages/Rewards.tsx` | Rewards configuration — earning activities, redemption options |
| `client/src/pages/Subscriptions.tsx` | Subscription management (billing cycles, upgrades, downgrades) |
| `client/src/pages/AccessRules.tsx` | Content gating rules management |
| `client/src/pages/Discounts.tsx` | Discount code management |
| `client/src/pages/Portal.tsx` | Member portal preview/config |
| `client/src/pages/PortalConfig.tsx` | Portal configuration (hero, benefits, styling) |
| `client/src/pages/MemberPortal.tsx` | Public member portal (login, dashboard, rewards, pricing) |
| `client/src/pages/StorefrontPreview.tsx` | Badge/pill design preview |
| `client/src/pages/Settings.tsx` | App settings (Shopify, Klaviyo, blockchain) |
| `client/src/pages/CollectionAlerts.tsx` | Collection drop notifications |
| `client/src/pages/Notifications.tsx` | Email notification templates |
| `client/src/components/MemberDetailSheet.tsx` | Member detail slide-out panel |
| `client/src/components/MemberDetailSheetV2.tsx` | V2 of member detail (expanded) |

### 1B. Echelon WMS (New Subscription Module)

**Server files:**
| File | Lines | Purpose |
|------|-------|---------|
| `server/modules/subscriptions/subscription.types.ts` | 102 | TypeScript interfaces for subscription engine |
| `server/modules/subscriptions/subscription.storage.ts` | 400 | Raw SQL database operations for subscriptions |
| `server/modules/subscriptions/subscription.service.ts` | 350 | Core lifecycle logic — webhook handlers, billing, cancellation |
| `server/modules/subscriptions/subscription.routes.ts` | 175 | Admin API routes for subscription management |
| `server/modules/subscriptions/subscription.scheduler.ts` | 85 | Billing scheduler (hourly cron) |
| `server/modules/subscriptions/subscription.webhooks.ts` | 70 | Shopify subscription webhook routes |
| `server/modules/subscriptions/selling-plan.service.ts` | 340 | Shopify Selling Plans GraphQL API wrapper |
| `migrations/050_subscription_engine.sql` | 70 | Schema migration for subscription engine |

**Client page:**
| File | Purpose |
|------|---------|
| `client/src/pages/Subscriptions.tsx` | Subscription dashboard, subscriber list, billing log, plans management |

---

## 2. Database Schema — Full Table Inventory

### Tables Defined in Shellz Club App Schema (`shared/schema.ts`)

| Table | Drizzle Name | Key Columns | Purpose |
|-------|-------------|-------------|---------|
| `plans` | `plans` | `id` (UUID), `name`, `tierLevel`, `price`, `billingInterval`, `pricingMode` (DEPRECATED), `flatDiscountPercent`, `rewardsMultiplier`, `customerTag`, `shopifyProductId`, `shopifyVariantId`, `trialDays`, `introPrice`, `pointsExpiryMode`, `klaviyoListId`, badge/pill styling (~50 columns) | Membership tier definitions |
| `members` | `members` | `id` (UUID), `shopifyCustomerId`, `email`, `planId` (FK→plans), `status`, `birthday`, `walletAddress` | Member profiles |
| `member_subscriptions` | `memberSubscriptions` | `id` (UUID), `memberId` (FK→members), `planId` (FK→plans), `status`, `billingInterval`, `cycleStartedAt`, `cycleEndsAt`, `amountPaidCents`, `isInTrial`, `trialEndsAt`, `isInIntro`, `scheduledPlanId`, `shopifySubscriptionId` | Subscription records with billing cycle tracking |
| `member_current_membership` | `memberCurrentMembership` | `memberId` (PK, FK→members), `subscriptionId` (FK→memberSubscriptions), `planId`, `status`, `billingInterval`, `cycleEndsAt`, `scheduledPlanId` | Denormalized active plan lookup |
| `reward_ledger` | `rewardLedger` | `id`, `memberId`, `entryType` (earn/redeem/expire/adjust/refund), `sourceType`, `points`, `orderId`, `discountCode`, `status`, `expiresAt` | Unified rewards ledger — source of truth for points |
| `reward_redemptions` | `rewardRedemptions` | `id`, `memberId`, `pointsUsed`, `discountValue`, `discountCode`, `shopifyPriceRuleId`, `status`, `promoCode`, `totalCombinedValue` | Discount code generation for reward redemptions |
| `access_rules` | `accessRules` | `id`, `resourceType` (page/collection/product), `resourceId`, `requiredPlanIds[]`, `gatingBehavior` (redirect/hide/blur), `redirectUrl` | Content gating rules |
| `plan_medal_benefits` | `planMedalBenefits` | `id`, `planId`, `medalId`, `benefits` (JSONB), `isActive` | Per-plan benefits for each medal tier |
| `medal_benefit_grants` | `medalBenefitGrants` | `id`, `memberId`, `medalId`, `benefitType`, `discountCode`, `shopifyDiscountId`, `status`, `expiresAt` | Individual benefit instances issued to members |
| `reward_medals` | `rewardMedals` | `id`, `name`, `lifetimePointsThreshold`, `orderCountThreshold`, `benefits` (JSONB), `isActive` | Gamification medal tiers |
| `member_medal_achievements` | `memberMedalAchievements` | `id`, `memberId`, `medalId`, `achievedAt`, `pointsAtAchievement` | Tracks when members achieve medals |
| `pricing_rules` | `pricingRules` | — | **DEPRECATED** — replaced by `plan_variant_overrides` |
| `plan_variant_overrides` | `planVariantOverrides` | `id`, `planId`, `variantId`, `overrideType` (flat_percent/fixed_price/exclude), `discountPercent`, `fixedPrice` | Per-variant pricing overrides per plan |
| `plan_collection_exclusions` | `planCollectionExclusions` | `planId`, `collectionId` | Collections excluded from wholesale pricing |
| `earning_activities` | `earningActivities` | `id`, `activityType`, `category`, `displayName`, `isRepeatable`, `automationSource` | Master list of ways to earn rewards |
| `plan_earning_rules` | `planEarningRules` | `planId`, `activityId`, `isEnabled`, `rewardType`, `pointsValue`, `multiplierValue` | Per-plan earning activity configuration |
| `redemption_options` | `redemptionOptions` | `id`, `name`, `pointsCost`, `valueAmount`, `shopifyDiscountType`, `expiryDays` | Redemption catalog |
| `plan_redemption_rules` | `planRedemptionRules` | `planId`, `redemptionOptionId`, `isEnabled`, `customPointsCost`, `customExpiryDays` | Per-plan redemption configuration |
| `member_earning_events` | `memberEarningEvents` | `memberId`, `activityId`, `status`, `pointsAwarded` | Individual earning event tracking |
| `member_stats` | `memberStats` | `memberId` (PK), `lifetimeSavingsCents`, `rewardsBalanceCents`, `totalOrders`, `totalSpentCents` | Pre-calculated member metrics |
| `shopify_orders` | `shopifyOrders` | `id` (Shopify GID), `memberId`, `totalPriceCents`, `planDiscountsCents`, `rewardsProcessed` | Order mirror for savings tracking |
| `shopify_order_items` | `shopifyOrderItems` | Line items with plan/coupon discount breakdown | |
| `order_item_plan_savings_snapshots` | — | Per-item potential savings by plan | |
| `subscription_ledger` | `subscriptionLedger` | `subscriptionId`, `memberId`, `eventType`, `chargeCents`, `creditCents` | Billing event audit trail |
| `subscription_contracts` | `subscriptionContracts` | `shopifyContractId`, `memberId`, `planId`, `status`, `nextBillingDate` | Shopify subscription contract tracking |
| `subscription_billing_attempts` | `subscriptionBillingAttempts` | `contractId`, `status`, `amountCents`, `errorCode` | Billing attempt tracking |
| `selling_plan_groups` | `sellingPlanGroups` | `shopifySellingPlanGroupId`, `planId`, `billingInterval` | Selling plan Shopify mapping |
| `notification_templates` | `notificationTemplates` | `name`, `type`, `subject`, `bodyHtml`, `klaviyoListId` | Email templates |
| `discounts` | `discounts` | `code`, `type`, `value`, `planIds[]`, `usageLimit` | Discount codes |
| `reward_overrides` | `rewardOverrides` | `sku`, `rewardsMultiplier` | SKU-level reward overrides |
| `portal_config` | `portalConfig` | 60+ styling/config columns for member portal | |
| `app_settings` | `appSettings` | Shopify credentials, Klaviyo keys, blockchain config | |
| `marketplace_exclusions` | `marketplaceExclusions` | Exclude eBay/Amazon customers from membership | |
| `back_in_stock_subscriptions` | — | Out-of-stock notification subscriptions | |
| `collection_alert_*` | — | Collection drop notification system | |
| `social_accounts` | — | OAuth-connected social accounts | |
| `social_action_verifications` | — | Social action verification tracking | |
| `blockchain_config` | — | Crypto token configuration | |
| `token_transactions` | — | On-chain token operation log | |

### Tables Added by Echelon Migration (`050_subscription_engine.sql` + `db.ts`)

| Table | Purpose | Relationship to Shellz Club App Tables |
|-------|---------|---------------------------------------|
| `subscription_billing_log` | Payment history with idempotency | **Overlaps** with `subscription_billing_attempts` in Shellz Club App |
| `subscription_events` | Audit trail for subscription lifecycle | **Overlaps** with `subscription_ledger` in Shellz Club App |
| `selling_plan_map` | Maps Shopify selling plans to plan IDs | **Overlaps** with `selling_plan_groups` in Shellz Club App |
| Columns on `plans`: `shopify_selling_plan_id`, `billing_interval`, `price_cents`, `tier`, `includes_dropship` | Extend plans for native billing | **Conflict risk** — Shellz Club App uses `price` (decimal), Echelon uses `price_cents` (integer) |
| Columns on `member_subscriptions`: `shopify_subscription_contract_id`, `next_billing_date`, `billing_status`, etc. | Extend for billing scheduler | **Conflict risk** — different column names/types than Shellz Club App's schema |
| Columns on `members`: `shopify_customer_id` (BIGINT), `tier` | Extend for subscription engine | **Conflict risk** — Shellz Club App stores `shopifyCustomerId` as TEXT |

---

## 3. Feature Analysis

### 3A. Plans & Pricing

**How plans are defined:**
- Shellz Club App: `shared/schema.ts` defines `plans` table with ~50 columns including `tierLevel` (integer 0-3), `price` (decimal), `billingInterval` (monthly/yearly/lifetime), `flatDiscountPercent`, extensive badge/pill styling config, rewards multiplier, trial/intro pricing, cancellation policies
- Echelon: Added `tier` (varchar: standard/gold), `price_cents` (integer), `billing_interval` (month/year), `includes_dropship` (boolean) via ALTER TABLE

**Pricing mode system (`pricing_mode`):**
- `pricing_mode` column exists on `plans` table but is marked **DEPRECATED** in schema.ts comment: `"DEPRECATED: No longer used - all plans use flatDiscountPercent + plan_variant_overrides"`
- Current pricing hierarchy (in `server/pricing.ts`):
  1. Check `plan_variant_overrides` for variant-specific override (`flat_percent`, `fixed_price`, `exclude`)
  2. Check `plan_collection_exclusions` — if product is in excluded collection, no discount
  3. Fall back to `plans.flatDiscountPercent` — base percentage off retail

**Per-product pricing:**
- `plan_variant_overrides` table: per-variant, per-plan pricing overrides
- `plan_collection_exclusions` table: exclude entire collections from wholesale pricing
- Both managed via the Plans page in Shellz Club App admin

**How plan changes affect pricing:**
- `billing.ts:BillingService` handles upgrade/downgrade proration
- Immediate plan changes via `changePlanImmediately()` in routes.ts
- Scheduled downgrades via `pending_downgrade` status on `member_subscriptions`
- When plan changes, `member_current_membership` is updated as denormalized index
- Customer tags on Shopify are updated to reflect new plan (`customerTag` column on plans)

### 3B. Member Management

**Member creation triggers:**
1. **Shopify order webhook** (`server/routes.ts`): When an order contains a membership product (`shopifyProductId`/`shopifyVariantId` match on plans), member is auto-created
2. **Manual admin creation** (Members page in admin UI)
3. **Portal self-signup** (MemberPortal.tsx → API)
4. **CSV import** (bulk import endpoint in routes.ts)

**Member-Shopify sync:**
- `members.shopifyCustomerId` stores the Shopify customer ID (as TEXT in Shellz Club App, as BIGINT in Echelon)
- `member_shopify_customer_ids` table handles Shopify customer ID merges/aliases
- Customer tags applied via Shopify Admin API (GraphQL `tagsAdd`/`tagsRemove`)
- Tags used for automatic discount eligibility on storefront (e.g., `shellz-club`, `shellz-club-gold`)
- Klaviyo list sync on member creation/plan change (`klaviyo.ts`)

**Member deactivation:**
- `members.status` set to `cancelled`
- `member_current_membership` row updated/deleted
- Shopify customer tags removed
- Discount eligibility revoked
- Rewards points preserved but earning stops

### 3C. Subscriptions

**Current subscription flow (Appstle-dependent):**
- Appstle manages Selling Plan Groups on the membership product
- Customer selects a plan at Shopify checkout → Appstle creates subscription contract
- Appstle handles all billing, dunning, and customer portal
- Shellz Club App tracks subscription state in `member_subscriptions` table
- The app does NOT currently initiate billing — Appstle does

**Shellz Club App's own subscription system (`server/billing.ts`):**
- `BillingService` class with full trial/intro/regular phase management
- Proration calculation for upgrades/downgrades
- `subscription_ledger` for billing event tracking
- `subscription_contracts` table for Shopify contract tracking
- `subscription_billing_attempts` table for billing attempt tracking
- `selling_plan_groups` table for selling plan mapping
- Draft order-based billing via Shopify Admin API (`shopify.ts`)
- This system exists but it's unclear how much is actively used vs. Appstle

**Echelon's new subscription module (`server/modules/subscriptions/`):**
- Complete reimplementation of subscription lifecycle management
- Raw SQL (no Drizzle) — uses `pool.query()` directly
- Webhook handlers for `subscription_contracts/create`, `subscription_contracts/update`, `subscription_billing_attempts/success`, `subscription_billing_attempts/failure`
- Billing scheduler running hourly via `setInterval` (not cron)
- GraphQL Selling Plan creation and management
- Admin API routes for dashboard, subscriber list, plan management, manual billing
- Customer tagging on create/cancel/plan-change

**Gap between current state and owning subscriptions:**
1. **Dual system problem:** Both apps have subscription management code that writes to the same tables
2. **Schema mismatch:** Shellz Club App uses UUIDs for IDs; Echelon's subscription module uses integer IDs for some columns (e.g., `member_subscriptions.id` assumed as integer in Echelon's `subscription.storage.ts`)
3. **Column type conflict:** `members.shopify_customer_id` is TEXT in Shellz Club schema, BIGINT in Echelon migration
4. **Missing coordination:** No locking or coordination between the two apps when writing to shared tables
5. **Echelon's module doesn't know about:** trial periods, intro pricing, proration, scheduled downgrades, subscription ledger, or the `subscription_contracts` table from the Shellz Club App
6. **Pricing is not handled:** Echelon's subscription module creates subscriptions but doesn't interact with `plan_variant_overrides`, `plan_collection_exclusions`, or the pricing engine
7. **Rewards not integrated:** Echelon's billing success handler doesn't award reward points (the spec mentions it should — `subscription.service.ts` line ~143 has no reward ledger call)
8. **No email notifications:** Echelon's module has no Klaviyo/email integration for subscription events

### 3D. Rewards

**How rewards accrue (Shellz Club App):**
- `server/rewards.ts:RewardsService` — `calculateRewardsForActivity()` and `awardPurchaseRewards()`
- On Shopify order webhook, the app:
  1. Identifies the member by `shopifyCustomerId`
  2. Calculates points using `plan_earning_rules` config (multiplier × order total)
  3. Creates `member_earning_events` record (status=pending)
  4. Processes event → creates `reward_ledger` entry (entryType=earn)
  5. Updates `member_stats.rewardsBalanceCents`
- SKU-level overrides via `reward_overrides` table
- Per-plan earning rules via `plan_earning_rules` table (which activities enabled, multiplier per plan)
- Social activities (Facebook follow, Instagram, etc.) — honor system with `social_action_verifications`
- Birthday bonus — annual, checked via `processTodaysBirthdays()`
- Signup bonus — automatic on member creation

**How rewards are redeemed:**
- Member selects from `redemption_options` catalog
- Points deducted via `reward_ledger` entry (entryType=redeem, negative points)
- Shopify discount code created via GraphQL API
- Code stored in `reward_redemptions` with status tracking
- Combined redemptions supported: promo code + rewards + shipping credit → single Shopify discount
- Checkout URL tracking for rollback if order not placed
- Code expiry via `expiresAt` on both `reward_redemptions` and `reward_ledger`

**Points expiry logic:**
- Per-plan configuration: `plans.pointsExpiryMode` (never/custom) and `plans.pointsExpiryDays`
- Per-redemption-rule: `plan_redemption_rules.customExpiryDays`
- `reward_ledger.expiresAt` set on earn entries
- Expiry processing not visible in current code — may need a scheduled job

**Shopify discount integration:**
- `server/shopify.ts:ShopifyService.createDiscountCodeGraphQL()` — creates Shopify discount codes via Admin API
- Used for: reward redemptions, medal benefits, combined promo+rewards discounts
- Price rules created with customer-specific targeting (via `customerGid`)

### 3E. Content Gating

**`access_rules` table:**
- Defined in `shared/schema.ts` as `accessRules`
- Columns: `resourceType` (page/collection/product), `resourceId` (URL path or Shopify ID), `requiredPlanIds[]` (array of plan IDs), `gatingBehavior` (redirect/hide/blur), `redirectUrl`
- Managed via `client/src/pages/AccessRules.tsx` admin page

**What checks the rules:**
- Server-side: API endpoint in `server/routes.ts` checks rules and returns gating status
- Client-side: The storefront theme app embed calls the Shellz Club API via app proxy to check access
- The app exposes a public API endpoint (likely via Shopify app proxy) that the storefront Liquid theme calls
- Customer is identified by Shopify customer ID from the logged-in session

**Where enforced:**
- Storefront JavaScript (injected via theme app embed or script tag) calls the API
- The API checks `access_rules` against the member's plan
- If member doesn't have required plan: redirect to URL, hide content, or blur it
- `app_settings.contentGatingEnabled` global toggle

**Current state:** 
- The table schema exists and the admin UI for managing rules exists
- Enforcement depends on storefront-side code (theme app embed) which is not in this codebase
- No evidence of how many rules are active or if the feature is being used

### 3F. Badges & UI

**Badge/pill system on products:**
- Extensive per-plan configuration: `pillVerb`, `pillLeftBg`, `pillLeftTextColor`, `pillRightBg`, `pillRightTextColor`, `pillShimmerStyle`, `pillBorderRadius`, `pillUpsellVerb`, `pillScale`, `pillBorderColor`, `pillBorderWidth`, `pillBorderOpacity`
- Collection badge styles: `ribbon`, `mission_badge`, `hud`, `progress`
- Product badge styles: `supply_drop`, `mission_badge`, `hud`, `ribbon_medal`, `progress`
- Ribbon variants: `orange_on_black`, `white_on_orange`, `white_orange_border`, `glowing_orange`
- Savings badge template: `plans.savingsBadgeTemplate` with `{percent}` and `{amount}` placeholders
- Member price color: `plans.memberPriceColor`
- UI accent color: `plans.uiAccentColor`

**How storefront shows member-specific pricing:**
- The Shellz Club App exposes a storefront API (likely via Shopify app proxy)
- Storefront JavaScript injected via **Shopify theme app embed** (based on the `server/static.ts` and `portal_config` styling options)
- The app serves a JavaScript bundle that:
  1. Detects logged-in Shopify customer
  2. Calls Shellz Club API to get member's plan
  3. Calculates and displays member pricing, savings badges, and upsell widgets
  4. Renders the split-pill badge on product cards and detail pages
- Non-members see upsell widgets ("Save {savings} with {planName}") configured in `portal_config`
- Portal config has extensive upsell widget styling: colors, headlines, fly-in drawer config, button styling

**Storefront preview:**
- `client/src/pages/StorefrontPreview.tsx` — live preview of badge designs
- `client/src/pages/DesignComparison.tsx` — A/B comparison of badge designs

---

## 4. Shopify Integration Points

### 4A. Webhooks (Shellz Club App)

| Webhook | Handler | Purpose |
|---------|---------|---------|
| `orders/create` | `server/routes.ts` | Order ingestion → member identification → savings tracking → reward accrual |
| `orders/updated` | `server/routes.ts` | Financial status changes, refund handling, reward reversal |
| `orders/cancelled` | `server/routes.ts` | Reward reversal, savings adjustment |
| `customers/update` | `server/routes.ts` | Customer data sync |
| `products/update` | `server/routes.ts` | Product cache sync |
| `inventory_levels/update` | `server/routes.ts` | Back-in-stock notification trigger |

### 4B. Webhooks (Echelon Subscription Module)

| Webhook | Handler | Purpose |
|---------|---------|---------|
| `subscription_contracts/create` | `subscription.webhooks.ts` → `subscription.service.ts:handleContractCreated` | New subscription processing |
| `subscription_contracts/update` | `subscription.webhooks.ts` → `subscription.service.ts:handleContractUpdated` | Plan change, pause, cancel |
| `subscription_billing_attempts/success` | `subscription.webhooks.ts` → `subscription.service.ts:handleBillingSuccess` | Billing period advance |
| `subscription_billing_attempts/failure` | `subscription.webhooks.ts` → `subscription.service.ts:handleBillingFailure` | Dunning sequence |

### 4C. Shopify Admin API Usage

| Action | App | Method | Purpose |
|--------|-----|--------|---------|
| Customer tagging | Both | GraphQL `tagsAdd`/`tagsRemove` | Discount eligibility |
| Discount code creation | Shellz Club | GraphQL `discountCodeBasicCreate` | Reward redemptions, medal benefits |
| Draft order creation | Shellz Club | GraphQL | Membership purchase with member pricing |
| Product/variant read | Shellz Club | REST + GraphQL | Product cache sync |
| Selling plan creation | Echelon | GraphQL `sellingPlanGroupCreate` | Native subscription setup |
| Billing attempt | Echelon | GraphQL `subscriptionBillingAttemptCreate` | Recurring billing |
| Contract read | Echelon | GraphQL | Contract line item inspection |
| Webhook registration | Both | GraphQL `webhookSubscriptionCreate` | Event subscription |

---

## 5. Data Observations (from SYSTEM.md)

| Table | Rows | Assessment |
|-------|------|------------|
| `plans` | 5 | Active plans defined — likely Free, Standard Monthly, Standard Annual, + Gold tiers |
| `members` | 273 | Active member base |
| `member_subscriptions` | 279 | Slightly more subs than members (some have multiple historical subs) |
| `member_current_membership` | 273 | 1:1 with active members — correct |
| `reward_ledger` | 642 | Active reward activity |
| `reward_redemptions` | 375 | Healthy redemption rate |
| `subscription_billing_log` | 0* | Echelon's table — **empty** (module not yet processing real subscriptions) |
| `subscription_events` | 0* | Echelon's table — **empty** |
| `selling_plan_map` | 0* | Echelon's table — **empty** (selling plans not yet created via Echelon) |
| `dropship_vendors` | — | References `members(id)` via `shellz_club_member_id` |

*Echelon subscription tables are newly created and contain no data yet.

---

## 6. Identified Gaps

### 6A. Critical: Dual-Write Database Conflict

**The biggest risk in the entire system.** Both apps write to:

- `plans` — Shellz Club App manages plan definitions; Echelon adds columns and can update plan details via `subscription.storage.ts:updatePlanDetails()`
- `members` — Both upsert members; Shellz Club uses UUID IDs, Echelon's storage functions use `findMemberByEmail()` and `upsertMember()` which assume integer IDs
- `member_subscriptions` — Shellz Club App tracks full billing cycle state; Echelon adds columns for native billing
- `member_current_membership` — Both apps write to this denormalized table

**Type conflicts:**
- `plans.id`: UUID (Shellz Club) vs integer (Echelon's code assumes `planId: number`)
- `members.id`: UUID (Shellz Club) vs assumed integer in Echelon
- `members.shopify_customer_id`: TEXT (Shellz Club) vs BIGINT (Echelon migration)
- `member_subscriptions.id`: UUID (Shellz Club) vs assumed integer in Echelon

**This will cause runtime errors when Echelon's subscription module tries to process real webhooks.**

### 6B. Subscription Engine Gaps (Echelon Module)

1. **No trial/intro period support** — Shellz Club App has full trial/intro phase logic in `billing.ts`; Echelon's module assumes subscriptions start immediately
2. **No proration** — Plan changes in Echelon happen immediately with no proration logic
3. **No scheduled downgrades** — Shellz Club App supports `pending_downgrade` status; Echelon's `changePlan()` is immediate
4. **No email notifications** — No Klaviyo integration in Echelon's subscription module
5. **No reward points on renewal** — `handleBillingSuccess()` doesn't award points (SUBSCRIPTION-APP-SPEC.md §6.3 step 5-6 not implemented)
6. **Billing scheduler uses `setInterval`** — Not robust for production (dies on process restart); should use proper job queue or at minimum persist last-run timestamp
7. **No reconciliation job** — If webhooks are missed, there's no periodic check against Shopify to reconcile contract states
8. **No customer self-service** — No customer portal for managing their subscription (pause, cancel, update payment method)
9. **`cancelShopifyContract()` uses draft→cancel→commit pattern** — This works but is verbose; could use `subscriptionContractUpdate` directly
10. **Hardcoded plan prices** in `selling-plan.service.ts:PLAN_CONFIGS` — Prices ($4.99, $49.99, $19.99, $199.99) don't match SUBSCRIPTION-APP-SPEC.md ($9.99, $79.99, $99.00, $499.00) or the existing plans

### 6C. Features Not Connected / Unused

1. **`access_rules`** — Schema and admin UI exist, but enforcement depends on storefront-side code not in this repo. Unknown if active.
2. **Blockchain/crypto integration** — `blockchain_config`, `token_transactions` tables and `server/blockchain.ts` exist but marked as future
3. **`pricing_rules`** table — Deprecated, replaced by `plan_variant_overrides`
4. **Points expiry** — Configuration exists (`pointsExpiryMode`, `pointsExpiryDays`) but no visible cron job to process expired points
5. **Social OAuth** — `social_accounts`, `social_action_verifications` tables exist; social activities use honor system (click-to-claim)
6. **Medal benefit claim tracking** — `medalBenefitService.syncBenefitClaims()` is a stub: `return { checked: 0, claimed: 0 }`
7. **Referral system** — `member_referrals` table and schema exist; `RewardsService.processReferralSignup()` exists; unclear if actively used

### 6D. Code Quality Issues

1. **`server/routes.ts` is 17,286 lines** — This is a monolith that should be split into domain-specific route modules
2. **Echelon subscription module uses raw SQL** while the rest of Echelon uses Drizzle ORM — inconsistent data access pattern
3. **Echelon subscription module doesn't use transactions** — `handleContractCreated()` performs 6+ DB operations without a transaction; if any step fails, state is partially committed
4. **No request validation** on many Echelon subscription API endpoints (e.g., `POST /api/subscriptions/:id/cancel` doesn't validate `id` is a number)
5. **`getContractSellingPlan()`** makes a GraphQL call to Shopify on every webhook — should cache the selling plan mapping
6. **Dynamic imports** — `subscription.service.ts` uses `await import("../../db")` in multiple functions instead of importing at module level
7. **Error swallowing** — Many `catch` blocks in Echelon's module log warnings but don't propagate errors (e.g., tag operations fail silently)

### 6E. Missing Error Handling

1. **No dead letter queue** for failed webhook processing
2. **No alerting** when billing scheduler fails repeatedly
3. **No health check** endpoint for subscription system
4. **Dunning retry** schedules next_billing_date 3 days out but doesn't validate it's not past the period end
5. **`setBillingInProgress`** can get stuck if the process crashes between setting it and clearing it (no timeout/cleanup)

### 6F. BOUNDARIES.md Violations

The `BOUNDARIES.md` defines system ownership rules. The subscription module doesn't violate WMS/OMS boundaries (it's a new domain), but:

1. **Echelon's subscription module writes directly to tables owned by the Shellz Club App** — there's no defined boundary between these two systems
2. **The dropship vendor auth (`vendor-auth.ts`) reads from `member_current_membership` and `plans`** — this is a cross-system read that should go through a defined interface
3. **`channels.storage.ts:getMemberPlanByEmail()`** joins `members` to `plans` directly — cross-domain query from Channel management into Membership

---

## 7. Dropship Add-On Analysis

### 7A. Current State

- `dropship_vendors` table has `shellz_club_member_id` FK → `members(id)`
- Vendor registration in `vendor-auth.ts`:
  1. Finds member by email match
  2. Checks `member_current_membership` → `plans` for `includes_dropship` and `tier`
  3. Requires Gold tier for dropship access
  4. Sets vendor tier to match plan tier
- `plans.includes_dropship` column (added by Echelon migration) — boolean flag
- Customer tags: Gold tier gets `shellz-club-dropship` tag

### 7B. What's Needed for Add-On Subscriptions Per Plan

1. **Plan structure change:** Instead of `includes_dropship` boolean, need a plan add-on system:
   - New table: `plan_addons` — defines available add-ons (dropship, priority support, etc.)
   - New table: `member_addon_subscriptions` — tracks which add-ons a member has
   - Allow add-ons to be purchased independently or bundled with plans
   
2. **Pricing:** Each add-on needs its own price, billing interval, and Shopify selling plan
   
3. **Shopify integration:** Additional selling plans for add-on products, separate subscription contracts per add-on

### 7C. Where `access_rules` Needs Extending

Currently `access_rules` only supports `resourceType` of page/collection/product. For dropship gating:

1. Add `resourceType: 'feature'` or `'addon'` for app features (not Shopify resources)
2. Add ability to check add-on subscriptions, not just plan membership
3. The gating check needs to support: "has Plan X AND Add-on Y" compound rules
4. `requiredPlanIds` could be extended to include add-on IDs, or add `requiredAddonIds[]`

### 7D. How a "Dropship" Benefit Would Be Gated

Current flow already works for plan-level gating:
1. Vendor registers → checks `member_current_membership` → verifies Gold tier
2. Vendor portal login → `requireVendorAuth()` middleware checks vendor status

For add-on model:
1. Check `member_addon_subscriptions` for active dropship add-on
2. Gate vendor portal access on active add-on (not just plan tier)
3. Add add-on status check to `requireVendorAuth()` middleware
4. On add-on cancellation → set vendor status to `suspended` with grace period

---

## 8. Recommendations

### 8A. Immediate (Pre-Migration)

1. **Choose ONE subscription engine** — either build on Shellz Club App's existing `billing.ts` + `subscription_contracts` system, or use Echelon's new module, but NOT both. The Shellz Club App's system is more mature (trials, proration, ledger). Echelon's module has better Shopify Selling Plans integration.

2. **Fix the type conflicts** — `plans.id` is UUID in the Shellz Club schema. Echelon's subscription module assumes integer plan IDs everywhere. This must be resolved before any real webhooks flow through.

3. **Add a transaction wrapper** to `handleContractCreated()` — 6 DB operations need atomicity.

4. **Fix the billing scheduler** — Replace `setInterval` with a proper scheduling mechanism that survives process restarts and handles the billing-in-progress cleanup.

5. **Add points expiry cron job** — The configuration exists but no processor runs.

### 8B. Architecture (For Subscription Rebuild)

1. **Define system boundaries** — Add a "Membership" section to `BOUNDARIES.md` that defines who owns which tables and the interface between Echelon and the Shellz Club App.

2. **API-mediated access** — Instead of both apps writing to the same tables, have one app own the membership domain and expose an API for the other.

3. **Consolidate or separate** — Either:
   - Move ALL membership logic into the Shellz Club App (including billing scheduler), and have Echelon consume via API
   - Move ALL membership logic into Echelon, and make the Shellz Club App a thin storefront proxy

4. **Split `routes.ts`** — The 17K-line monolith needs to be broken into modules: `member.routes.ts`, `plan.routes.ts`, `reward.routes.ts`, `portal.routes.ts`, `webhook.routes.ts`, etc.

### 8C. Feature Gaps to Fill

1. **Reward points on renewal** — Add `rewardLedger.earn` entry in billing success handler
2. **Email notifications** — Connect Klaviyo to subscription lifecycle events
3. **Customer self-service portal** — Let members pause/cancel/change plan from the member portal
4. **Subscription reconciliation job** — Periodic check against Shopify to catch missed webhooks
5. **Medal benefit claim sync** — Implement `syncBenefitClaims()` to track when discount codes are used
6. **Points expiry processor** — Scheduled job to expire points based on plan configuration

---

## 9. File Reference Index

### Shellz Club App
| Domain | Key Files |
|--------|-----------|
| Schema | `shared/schema.ts` |
| All routes | `server/routes.ts:1-17286` |
| Storage | `server/storage.ts` |
| Pricing | `server/pricing.ts:PricingEngine` |
| Rewards | `server/rewards.ts:RewardsService` |
| Billing | `server/billing.ts:BillingService` |
| Shopify | `server/shopify.ts:ShopifyService` |
| Medals | `server/medalBenefits.ts:MedalBenefitService` |
| Klaviyo | `server/klaviyo.ts` |
| Migrations | `migrations/0000-0060_*.sql` |

### Echelon
| Domain | Key Files |
|--------|-----------|
| Subscription types | `server/modules/subscriptions/subscription.types.ts` |
| Subscription storage | `server/modules/subscriptions/subscription.storage.ts` |
| Subscription service | `server/modules/subscriptions/subscription.service.ts` |
| Subscription routes | `server/modules/subscriptions/subscription.routes.ts` |
| Billing scheduler | `server/modules/subscriptions/subscription.scheduler.ts` |
| Webhook handlers | `server/modules/subscriptions/subscription.webhooks.ts` |
| Selling plans | `server/modules/subscriptions/selling-plan.service.ts` |
| Migration | `migrations/050_subscription_engine.sql` |
| Startup migrations | `server/db.ts:runStartupMigrations()` |
| Route registration | `server/routes.ts` (barrel) |
| Subscription UI | `client/src/pages/Subscriptions.tsx` |
| Dropship vendor auth | `server/modules/dropship/vendor-auth.ts:67-86` |
| Member plan lookup | `server/modules/channels/channels.storage.ts:566-576` |
| App shell nav | `client/src/components/layout/AppShell.tsx:136` |
| Spec document | `SUBSCRIPTION-APP-SPEC.md` |

---

*End of audit. This document should be the foundation for deciding the subscription rebuild architecture.*
