# Shellz Club Subscription App — Technical Specification

**Version:** 1.0  
**Date:** 2026-03-22  
**Author:** Systems Architecture / Echelon Team  
**Status:** DRAFT — Awaiting Review

---

## 1. Executive Summary

Replace Appstle with native Shopify subscription management built into the Shellz Club app. Customers subscribe through normal Shopify checkout via Selling Plans. Shopify handles recurring billing. The Shellz Club app manages the subscription lifecycle, syncs membership state into Echelon, and provides admin tooling.

**Key principle:** Shopify is the billing engine. Echelon is the membership engine. The Shellz Club app is the bridge.

---

## 2. Current State

### 2.1 What Exists in Echelon

| Table | Rows | Purpose |
|---|---|---|
| `plans` | 5 | Membership tier definitions |
| `members` | 273 | Member profiles (email, name, Shopify customer ID) |
| `member_subscriptions` | 279 | Subscription records (plan, status, dates) |
| `member_current_membership` | 273 | Denormalized active plan lookup |
| `reward_ledger` | — | Points earned/spent |
| `reward_redemptions` | — | Reward claim records |
| `dropship_vendors` | — | References `members(id)` via `shellz_club_member_id` |

### 2.2 What Exists in the Shellz Club Shopify App

- Installed on the Card Shellz store
- Has Shopify Admin API access (REST + GraphQL)
- Manages membership data in the tables above
- Currently does **not** create Selling Plans or handle subscription contracts
- Appstle handles all recurring billing via its own Selling Plans

### 2.3 What Appstle Does Today

- Creates Selling Plan Groups + Selling Plans on the membership product(s)
- Manages subscription contracts (create, renew, cancel)
- Handles billing attempts and dunning
- Provides its own customer portal for subscription management
- Owns the `SellingPlanGroup` records — these get **deleted 48 hours after uninstall**

### 2.4 Echelon Shopify Integration (server/modules/integrations/shopify.ts)

- Uses `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_API_SECRET` env vars
- REST API (2024-01) for products, orders, inventory
- `verifyShopifyWebhook()` / `verifyWebhookWithSecret()` for HMAC validation
- Existing webhook patterns: ShipStation ship_notify, eBay order webhooks, Stripe webhooks

---

## 3. Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Shopify Store   │────▶│  Shopify Checkout │────▶│ Subscription    │
│  (Product page)  │     │  (Payment)        │     │ Contract Created│
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                           │
                                                    Webhook │
                                                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Shellz Club App (Echelon)                      │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐   │
│  │ Webhook       │  │ Subscription │  │ Selling Plan          │   │
│  │ Handlers      │──│ Lifecycle    │  │ Management (GraphQL)  │   │
│  │ (Express)     │  │ Service      │  │                       │   │
│  └──────────────┘  └──────┬───────┘  └───────────────────────┘   │
│                           │                                        │
│                    ┌──────▼───────┐                                │
│                    │  PostgreSQL   │                                │
│                    │  (Echelon DB) │                                │
│                    └──────────────┘                                │
└──────────────────────────────────────────────────────────────────┘
```

**Flow:**
1. App creates Selling Plan Groups + Plans via GraphQL Admin API
2. Selling Plans are assigned to the membership product
3. Customer selects a plan at checkout → Shopify creates a subscription contract
4. Shopify sends webhooks → App processes lifecycle events → Updates Echelon DB
5. App initiates billing attempts at renewal time → Shopify charges the customer
6. Admin manages subscriptions through Echelon UI

---

## 4. Required Shopify App Scopes

The Shellz Club app needs these scopes (request via Partner Dashboard):

| Scope | Purpose | Status |
|---|---|---|
| `write_products` | Assign selling plans to products | Likely already granted |
| `read_products` | Read product/variant data | Likely already granted |
| `read_own_subscription_contracts` | Read subscription contracts created by this app | **NEW — requires approval** |
| `write_own_subscription_contracts` | Create/update/cancel subscription contracts | **NEW — requires approval** |
| `read_customer_payment_methods` | Access customer payment methods for billing | **NEW — requires approval** |
| `read_customers` | Look up customer data | Likely already granted |

> **Important:** The `_own_` scopes mean the app can only access subscription contracts created by itself — not Appstle's contracts. This is a critical constraint for migration (see §10).

> **Important:** Subscription API access must be requested through the Shopify Partner Dashboard. Shopify reviews and approves access. This is not automatic — plan for 1-2 weeks lead time.

---

## 5. Selling Plan Configuration

### 5.1 Selling Plan Group

One group: **"Shellz Club Membership"**

**GraphQL Mutation — Create Selling Plan Group:**

```graphql
mutation sellingPlanGroupCreate($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput!) {
  sellingPlanGroupCreate(input: $input, resources: $resources) {
    sellingPlanGroup {
      id
      sellingPlans(first: 10) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}
```

**Variables:**

```json
{
  "input": {
    "name": "Shellz Club Membership",
    "merchantCode": "shellz-club",
    "options": ["Membership Tier"],
    "position": 1,
    "sellingPlansToCreate": [
      {
        "name": "Shellz Club Standard — Monthly",
        "options": ["Standard Monthly"],
        "category": "SUBSCRIPTION",
        "billingPolicy": {
          "recurring": {
            "interval": "MONTH",
            "intervalCount": 1
          }
        },
        "deliveryPolicy": {
          "recurring": {
            "interval": "MONTH",
            "intervalCount": 1
          }
        },
        "pricingPolicies": [
          {
            "fixed": {
              "adjustmentType": "PRICE",
              "adjustmentValue": {
                "fixedValue": "9.99"
              }
            }
          }
        ]
      },
      {
        "name": "Shellz Club Standard — Annual",
        "options": ["Standard Annual"],
        "category": "SUBSCRIPTION",
        "billingPolicy": {
          "recurring": {
            "interval": "YEAR",
            "intervalCount": 1
          }
        },
        "deliveryPolicy": {
          "recurring": {
            "interval": "YEAR",
            "intervalCount": 1
          }
        },
        "pricingPolicies": [
          {
            "fixed": {
              "adjustmentType": "PRICE",
              "adjustmentValue": {
                "fixedValue": "79.99"
              }
            }
          }
        ]
      },
      {
        "name": "Shellz Club Gold — Monthly",
        "options": ["Gold Monthly"],
        "category": "SUBSCRIPTION",
        "billingPolicy": {
          "recurring": {
            "interval": "MONTH",
            "intervalCount": 1
          }
        },
        "deliveryPolicy": {
          "recurring": {
            "interval": "MONTH",
            "intervalCount": 1
          }
        },
        "pricingPolicies": [
          {
            "fixed": {
              "adjustmentType": "PRICE",
              "adjustmentValue": {
                "fixedValue": "99.00"
              }
            }
          }
        ]
      },
      {
        "name": "Shellz Club Gold — Annual",
        "options": ["Gold Annual"],
        "category": "SUBSCRIPTION",
        "billingPolicy": {
          "recurring": {
            "interval": "YEAR",
            "intervalCount": 1
          }
        },
        "deliveryPolicy": {
          "recurring": {
            "interval": "YEAR",
            "intervalCount": 1
          }
        },
        "pricingPolicies": [
          {
            "fixed": {
              "adjustmentType": "PRICE",
              "adjustmentValue": {
                "fixedValue": "499.00"
              }
            }
          }
        ]
      }
    ]
  },
  "resources": {
    "productIds": ["gid://shopify/Product/MEMBERSHIP_PRODUCT_ID"]
  }
}
```

### 5.2 Selling Plans to Create

| Plan Name | Interval | Price | `plans` Table Mapping |
|---|---|---|---|
| Shellz Club Standard — Monthly | MONTH / 1 | $9.99/mo | Map to existing Standard plan row |
| Shellz Club Standard — Annual | YEAR / 1 | $79.99/yr | Map to existing Annual plan row |
| Shellz Club Gold — Monthly | MONTH / 1 | $99.00/mo | **New** plan row |
| Shellz Club Gold — Annual | YEAR / 1 | $499.00/yr | **New** plan row |

> **Note on pricing:** Selling plan pricing uses `adjustmentType: PRICE` with `fixedValue` because the membership product is a fixed-price subscription, not a discount off a base product price. The membership product variant price should be set to $0 (or any value) — the selling plan overrides it.

### 5.3 Delivery Policy

Since memberships are digital (no physical fulfillment), set `deliveryPolicy` to match `billingPolicy`. The membership product should have `requires_shipping: false`. Inventory policy: `ON_FULFILLMENT` (default).

### 5.4 Important Selling Plan Constraints

- Selling Plans are **owned by the app** that created them. Only that app can modify them.
- Selling Plans are **deleted 48 hours after app uninstall**. Back up configuration.
- Changes to a Selling Plan do **not** retroactively modify existing subscription contracts.
- The `interval` must be consistent within a single selling plan (can't mix WEEK and MONTH).
- `category` must be `SUBSCRIPTION` for recurring billing.

---

## 6. Subscription Contract Lifecycle

### 6.1 Contract Creation (Customer Subscribes)

**Trigger:** Customer completes checkout with a selling plan → Shopify creates a subscription contract.

**Webhook:** `subscription_contracts/create`

**Payload Example:**

```json
{
  "admin_graphql_api_id": "gid://shopify/SubscriptionContract/9998878778",
  "id": 9998878778,
  "billing_policy": {
    "interval": "month",
    "interval_count": 1,
    "min_cycles": 1,
    "max_cycles": null
  },
  "currency_code": "USD",
  "customer_id": 1234567890,
  "admin_graphql_api_customer_id": "gid://shopify/Customer/1234567890",
  "delivery_policy": {
    "interval": "month",
    "interval_count": 1
  },
  "status": "active",
  "admin_graphql_api_origin_order_id": "gid://shopify/Order/9876543210",
  "origin_order_id": 9876543210,
  "revision_id": "9998878778"
}
```

**App Action:**
1. Look up Shopify customer by `customer_id` → get email
2. Query the selling plan on the contract to determine which tier (Standard/Gold)
3. Upsert `members` row (by email / Shopify customer ID)
4. Insert `member_subscriptions` row with:
   - `shopify_subscription_contract_id` (new column)
   - `shopify_customer_id`
   - `plan_id` (mapped from selling plan)
   - `status: 'active'`
   - `started_at: NOW()`
   - `current_period_start`, `current_period_end`
5. Update `member_current_membership` to reflect active tier
6. Apply Shopify customer tag (`shellz-club`, `shellz-club-gold`) for discount eligibility
7. If Gold tier → flag member for dropship portal access

### 6.2 Billing Attempt (Renewal)

**Critical:** The app is responsible for initiating billing attempts. Shopify does not auto-charge.

**The app must:**
1. Track `next_billing_date` for each active contract
2. Run a scheduled job (cron) that checks for contracts due for billing
3. Call `subscriptionBillingAttemptCreate` mutation to charge the customer

**GraphQL Mutation — Create Billing Attempt:**

```graphql
mutation subscriptionBillingAttemptCreate(
  $subscriptionContractId: ID!,
  $subscriptionBillingAttemptInput: SubscriptionBillingAttemptInput!
) {
  subscriptionBillingAttemptCreate(
    subscriptionContractId: $subscriptionContractId,
    subscriptionBillingAttemptInput: $subscriptionBillingAttemptInput
  ) {
    subscriptionBillingAttempt {
      id
      ready
      originTime
    }
    userErrors {
      field
      message
    }
  }
}
```

**Variables:**

```json
{
  "subscriptionContractId": "gid://shopify/SubscriptionContract/9998878778",
  "subscriptionBillingAttemptInput": {
    "idempotencyKey": "billing-9998878778-2026-04-22",
    "originTime": "2026-04-22T00:00:00Z"
  }
}
```

> **`idempotencyKey`** prevents duplicate charges. Format: `billing-{contractId}-{billingDate}`.  
> **`originTime`** is the billing cycle anchor — use the subscription's billing date.

### 6.3 Billing Attempt Success

**Webhook:** `subscription_billing_attempts/success`

**Payload Example:**

```json
{
  "id": "gid://shopify/SubscriptionBillingAttempt/1234",
  "admin_graphql_api_id": "gid://shopify/SubscriptionBillingAttempt/1234",
  "subscription_contract_id": 9998878778,
  "admin_graphql_api_subscription_contract_id": "gid://shopify/SubscriptionContract/9998878778",
  "ready": true,
  "order_id": 1111222233,
  "admin_graphql_api_order_id": "gid://shopify/Order/1111222233",
  "error_message": null,
  "error_code": null
}
```

**App Action:**
1. Find `member_subscriptions` by `shopify_subscription_contract_id`
2. Update `current_period_start` and `current_period_end`
3. Calculate and set `next_billing_date`
4. Insert into `subscription_billing_log` (new table) with payment details
5. Award reward points for renewal (if applicable)
6. Log in `reward_ledger`

### 6.4 Billing Attempt Failure

**Webhook:** `subscription_billing_attempts/failure`

**Payload Example:**

```json
{
  "id": "gid://shopify/SubscriptionBillingAttempt/1235",
  "admin_graphql_api_id": "gid://shopify/SubscriptionBillingAttempt/1235",
  "subscription_contract_id": 9998878778,
  "admin_graphql_api_subscription_contract_id": "gid://shopify/SubscriptionContract/9998878778",
  "ready": false,
  "order_id": null,
  "error_message": "Card declined",
  "error_code": "card_declined"
}
```

**App Action:**
1. Find subscription by contract ID
2. Increment `failed_billing_attempts` counter (new column)
3. Set `billing_status: 'past_due'`
4. **Dunning sequence:**
   - Attempt 1 fail → Wait 3 days, retry billing
   - Attempt 2 fail → Wait 3 days, retry billing + send warning email
   - Attempt 3 fail → Wait 3 days, retry billing + send final warning
   - Attempt 4 fail → Cancel subscription, set status to `'cancelled'`, remove customer tags
5. Each retry: call `subscriptionBillingAttemptCreate` again with same `originTime`

### 6.5 Subscription Cancelled

**Webhook:** `subscription_contracts/update` (with `status: "cancelled"`)

Can also be triggered by admin action in the app.

**App Action:**
1. Set `member_subscriptions.status = 'cancelled'`
2. Set `cancelled_at = NOW()`
3. Update `member_current_membership` — if no other active subscription, clear membership
4. Remove Shopify customer tags (`shellz-club`, `shellz-club-gold`)
5. If Gold tier → revoke dropship portal access
6. Remove wholesale pricing eligibility
7. Send cancellation confirmation email

### 6.6 Plan Change (Upgrade/Downgrade)

**Triggered by:** Admin action in Echelon or customer request.

**GraphQL Mutation — Update Subscription Contract:**

```graphql
mutation subscriptionContractUpdate($contractId: ID!) {
  subscriptionDraftCommit(draftId: $draftId) {
    contract {
      id
      status
    }
    userErrors {
      field
      message
    }
  }
}
```

**Process:**
1. Create a draft from the existing contract: `subscriptionDraftUpdate`
2. Modify the draft: change line item (plan variant), update pricing
3. Commit the draft: `subscriptionDraftCommit`
4. Update `member_subscriptions.plan_id`
5. Update `member_current_membership`
6. Adjust customer tags if tier changed

**Proration strategy:** No proration for now — plan changes take effect on next billing cycle. Can implement proration later if needed.

---

## 7. Billing Scheduler (Cron Job)

**This is the most critical new component.** Shopify does not auto-bill subscription contracts. The app must initiate billing.

### 7.1 Design

```
Job: subscription-billing-scheduler
Schedule: Every 1 hour
```

**Logic:**
1. Query all `member_subscriptions` where:
   - `status = 'active'` OR `status = 'past_due'`
   - `next_billing_date <= NOW()`
   - `billing_in_progress = false`
2. For each subscription:
   - Set `billing_in_progress = true`
   - Call `subscriptionBillingAttemptCreate` on Shopify
   - The result comes back async via webhook
   - `billing_in_progress` is cleared when webhook is received
3. Rate limit: Shopify GraphQL has a cost-based throttle. Process in batches with delays.
4. Idempotency: Use `billing-{contractId}-{billingDate}` as idempotency key.

### 7.2 Failure Handling

If the billing attempt API call itself fails (network error, 500, etc.):
- Log the error
- Leave `next_billing_date` unchanged so the next cron run retries
- Set `billing_in_progress = false`
- Alert admin after 3 consecutive API failures for the same contract

---

## 8. Data Model Changes

### 8.1 Modified Tables

**`plans` table — Add columns:**

```sql
ALTER TABLE plans ADD COLUMN IF NOT EXISTS shopify_selling_plan_id BIGINT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS shopify_selling_plan_gid VARCHAR(100);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS billing_interval VARCHAR(20); -- 'month', 'year'
ALTER TABLE plans ADD COLUMN IF NOT EXISTS billing_interval_count INTEGER DEFAULT 1;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_cents INTEGER;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS tier VARCHAR(30) DEFAULT 'standard'; -- 'standard', 'gold'
ALTER TABLE plans ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
```

**`member_subscriptions` table — Add columns:**

```sql
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS shopify_subscription_contract_id BIGINT;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS shopify_subscription_contract_gid VARCHAR(100);
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS shopify_customer_id BIGINT;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS next_billing_date TIMESTAMP;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMP;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMP;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS billing_status VARCHAR(30) DEFAULT 'current'; -- 'current', 'past_due', 'cancelled'
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS failed_billing_attempts INTEGER DEFAULT 0;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS billing_in_progress BOOLEAN DEFAULT false;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE member_subscriptions ADD COLUMN IF NOT EXISTS revision_id VARCHAR(50); -- Shopify contract revision tracking

CREATE UNIQUE INDEX IF NOT EXISTS idx_ms_shopify_contract 
  ON member_subscriptions(shopify_subscription_contract_id) 
  WHERE shopify_subscription_contract_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ms_next_billing 
  ON member_subscriptions(next_billing_date) 
  WHERE status = 'active' AND billing_in_progress = false;
```

**`members` table — Add columns (if not present):**

```sql
ALTER TABLE members ADD COLUMN IF NOT EXISTS shopify_customer_id BIGINT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS tier VARCHAR(30) DEFAULT 'standard';

CREATE UNIQUE INDEX IF NOT EXISTS idx_members_shopify_customer 
  ON members(shopify_customer_id) 
  WHERE shopify_customer_id IS NOT NULL;
```

### 8.2 New Tables

**`subscription_billing_log` — Payment history:**

```sql
CREATE TABLE IF NOT EXISTS subscription_billing_log (
  id SERIAL PRIMARY KEY,
  member_subscription_id INTEGER NOT NULL REFERENCES member_subscriptions(id),
  shopify_billing_attempt_id VARCHAR(100),
  shopify_order_id BIGINT,
  amount_cents INTEGER NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  status VARCHAR(30) NOT NULL, -- 'success', 'failed', 'pending'
  error_code VARCHAR(100),
  error_message TEXT,
  idempotency_key VARCHAR(200),
  billing_period_start TIMESTAMP,
  billing_period_end TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sbl_subscription ON subscription_billing_log(member_subscription_id);
CREATE INDEX IF NOT EXISTS idx_sbl_status ON subscription_billing_log(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sbl_idempotency ON subscription_billing_log(idempotency_key);
```

**`subscription_events` — Audit trail:**

```sql
CREATE TABLE IF NOT EXISTS subscription_events (
  id SERIAL PRIMARY KEY,
  member_subscription_id INTEGER REFERENCES member_subscriptions(id),
  shopify_subscription_contract_id BIGINT,
  event_type VARCHAR(50) NOT NULL, -- 'created', 'renewed', 'failed', 'cancelled', 'plan_changed', 'reactivated'
  event_source VARCHAR(30) NOT NULL, -- 'webhook', 'admin', 'cron', 'migration'
  payload JSONB,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_se_subscription ON subscription_events(member_subscription_id);
CREATE INDEX IF NOT EXISTS idx_se_contract ON subscription_events(shopify_subscription_contract_id);
CREATE INDEX IF NOT EXISTS idx_se_type ON subscription_events(event_type);
```

**`selling_plan_map` — Maps Shopify selling plans to Echelon plans:**

```sql
CREATE TABLE IF NOT EXISTS selling_plan_map (
  id SERIAL PRIMARY KEY,
  shopify_selling_plan_gid VARCHAR(100) NOT NULL UNIQUE,
  shopify_selling_plan_group_gid VARCHAR(100) NOT NULL,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  plan_name VARCHAR(100) NOT NULL,
  billing_interval VARCHAR(20) NOT NULL,
  price_cents INTEGER NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

---

## 9. Webhook Handlers

### 9.1 Webhook Registration

Register webhooks via GraphQL (or app configuration TOML):

```graphql
mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription {
      id
    }
    userErrors {
      field
      message
    }
  }
}
```

**Topics to register:**

| Topic | Endpoint |
|---|---|
| `SUBSCRIPTION_CONTRACTS_CREATE` | `/api/webhooks/subscription-contracts/create` |
| `SUBSCRIPTION_CONTRACTS_UPDATE` | `/api/webhooks/subscription-contracts/update` |
| `SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS` | `/api/webhooks/subscription-billing/success` |
| `SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE` | `/api/webhooks/subscription-billing/failure` |

### 9.2 Webhook Route Registration (Express)

New file: `server/modules/subscriptions/subscription.webhooks.ts`

These routes must be registered **before** body-parsing middleware (same pattern as Stripe webhooks in the codebase) to access the raw body for HMAC verification.

```
POST /api/webhooks/subscription-contracts/create    → handleContractCreated
POST /api/webhooks/subscription-contracts/update    → handleContractUpdated
POST /api/webhooks/subscription-billing/success     → handleBillingSuccess
POST /api/webhooks/subscription-billing/failure     → handleBillingFailure
```

Each handler:
1. Verify HMAC using `verifyShopifyWebhook()` from `server/modules/integrations/shopify.ts`
2. Parse payload
3. Process event (idempotent — use `revision_id` for contracts, `idempotency_key` for billing)
4. Log to `subscription_events`
5. Return 200 immediately (async processing if needed)

### 9.3 Idempotency

- **Contract webhooks:** Use `revision_id` — if stored `revision_id` >= incoming, skip.
- **Billing webhooks:** Use `shopify_billing_attempt_id` — deduplicate in `subscription_billing_log`.
- All webhook handlers must be safe to call multiple times with the same payload.

---

## 10. Migration from Appstle

### 10.1 The Core Problem

Appstle's subscription contracts are **owned by Appstle**. Our app has `_own_` scopes — we cannot read or modify Appstle's contracts. When Appstle is uninstalled, its selling plans and contracts are deleted after 48 hours.

### 10.2 Migration Strategy

**Phase 1: Preparation (Week 1-2)**
1. Request subscription API scopes via Partner Dashboard
2. Build and test all webhook handlers and the billing scheduler
3. Create new Selling Plan Group and Selling Plans via our app
4. Assign selling plans to membership product(s) — product now has BOTH Appstle and our selling plans
5. Snapshot all current member data from Echelon (backup)

**Phase 2: New Subscribers (Week 3+)**
1. Update the product page to show OUR selling plans (hide Appstle's via Liquid/theme customization)
2. New subscribers go through our selling plans → our webhooks → our system
3. Existing Appstle subscribers continue on Appstle's contracts
4. Monitor for 2-4 weeks to validate the system works end-to-end

**Phase 3: Migrate Existing Subscribers (Week 5-6)**

There are two approaches:

**Option A: Graceful Re-Subscribe (Recommended)**
1. Export all active Appstle subscribers (email, plan, billing date, Shopify customer ID)
2. For each subscriber, the app creates a new subscription contract via `subscriptionContractAtomicCreate` using their existing payment method
3. Cancel the Appstle contract (or let Appstle uninstall handle it)
4. Map Echelon member records to new contract IDs

```graphql
mutation subscriptionContractAtomicCreate($input: SubscriptionContractAtomicCreateInput!) {
  subscriptionContractAtomicCreate(input: $input) {
    subscriptionContract {
      id
      status
    }
    userErrors {
      field
      message
    }
  }
}
```

> **Limitation:** `subscriptionContractAtomicCreate` can only use payment methods the customer has on file. If the customer's payment method is only associated with Appstle's contract, we may not be able to access it with `_own_` scopes.

**Option B: Customer Re-Enrollment (Fallback)**
1. Email all existing subscribers with a link to re-subscribe through the new checkout
2. Offer an incentive (bonus reward points, free month, etc.)
3. Cancel Appstle contracts after re-enrollment
4. Set a deadline; after deadline, remaining users are manually migrated or churned

**Recommended: Option A first, Option B for any that fail.**

**Phase 4: Decommission Appstle (Week 7-8)**
1. Verify all subscribers are on our contracts
2. Uninstall Appstle
3. Appstle's selling plans auto-delete after 48 hours (our plans remain because our app is still installed)
4. Remove any Appstle-specific theme code

### 10.3 Data Mapping During Migration

For each migrated subscriber:

| Source (Appstle/Current) | Target (New System) |
|---|---|
| Member email | `members.email` (already exists) |
| Shopify customer ID | `members.shopify_customer_id` (new column) |
| Plan name | Map to `plans.id` via `selling_plan_map` |
| Subscription status | `member_subscriptions.status` |
| Next billing date | `member_subscriptions.next_billing_date` |
| Contract ID | `member_subscriptions.shopify_subscription_contract_id` (new) |

### 10.4 Risk Mitigation

- **Never uninstall Appstle before migration is complete**
- Back up all member/subscription data before each phase
- Run parallel monitoring: compare Appstle dashboard vs Echelon data daily
- Have a rollback plan: if our system fails, Appstle is still running
- Test with a small batch (10 subscribers) before full migration

---

## 11. Gold / Dropship Tier

### 11.1 New Plan Definition

```sql
INSERT INTO plans (name, tier, billing_interval, price_cents, is_active)
VALUES 
  ('Shellz Club Gold — Monthly', 'gold', 'month', 9900, true),
  ('Shellz Club Gold — Annual', 'gold', 'year', 49900, true);
```

### 11.2 Gold Tier Benefits

| Feature | Standard | Gold |
|---|---|---|
| Wholesale pricing (15-30% off) | ✅ | ✅ |
| 3% rewards | ✅ | ✅ |
| Reduced free shipping ($69) | ✅ | ✅ |
| Exclusive wax products | ✅ | ✅ |
| Dropship portal access | ❌ | ✅ |
| Priority support | ❌ | ✅ |
| Early access to new products | ❌ | ✅ |

### 11.3 Dropship Portal Integration

The vendor registration flow in `server/modules/dropship/vendor-auth.ts` already checks `member_current_membership.plan_name` to derive the vendor tier. Changes needed:

1. Add Gold tier check: if `plan_name` includes "gold" → `tier = 'gold'` on `dropship_vendors`
2. On subscription webhook (contract create/update): if plan is Gold and vendor exists, update vendor tier
3. On cancellation: if downgraded from Gold, set vendor status to `suspended` with grace period
4. Vendor portal login should verify active Gold membership

### 11.4 Customer Tagging

When a subscription is created or changed, apply Shopify customer tags:

| Plan | Tags Applied |
|---|---|
| Standard | `shellz-club`, `shellz-club-standard` |
| Gold | `shellz-club`, `shellz-club-gold`, `shellz-club-dropship` |
| Cancelled | Remove all `shellz-club-*` tags |

Tags are used by Shopify for:
- Automatic discount eligibility (wholesale pricing)
- Customer segmentation
- Email marketing targeting

**GraphQL Mutation — Tag Customer:**

```graphql
mutation tagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    userErrors {
      field
      message
    }
  }
}
```

---

## 12. Admin UI (Echelon)

### 12.1 New Pages

**Subscription Dashboard** (`/subscriptions`)
- Total active subscribers (by tier)
- MRR (Monthly Recurring Revenue) calculation
- Churn rate (30/60/90 day)
- Failed payments requiring attention
- Recent subscription events feed

**Subscription List** (`/subscriptions/list`)
- All subscriptions with filters: status, tier, billing status
- Search by member name/email
- Columns: Member, Plan, Status, Billing Status, Next Billing, Started, Actions
- Actions: View details, Cancel, Change plan, Retry billing

**Subscription Detail** (`/subscriptions/:id`)
- Member info
- Plan details
- Billing history (from `subscription_billing_log`)
- Event timeline (from `subscription_events`)
- Actions: Cancel, Pause (future), Change plan, Manual retry

**Selling Plan Management** (`/subscriptions/plans`)
- View all selling plans with Shopify sync status
- Create/edit plans (calls Shopify GraphQL to sync)
- Enable/disable plans
- Price management

### 12.2 Existing Page Changes

**Members list** — Add subscription status column, filter by plan  
**Member detail** — Show subscription info inline, link to subscription detail

---

## 13. New Module Structure

```
server/modules/subscriptions/
├── subscription.service.ts       # Core business logic
├── subscription.storage.ts       # Database operations
├── subscription.webhooks.ts      # Webhook handlers (Express routes)
├── subscription.routes.ts        # Admin API routes
├── subscription.scheduler.ts     # Billing cron job
├── selling-plan.service.ts       # Shopify Selling Plans API wrapper
└── subscription.types.ts         # TypeScript interfaces
```

### 13.1 Key Service Methods

```typescript
// subscription.service.ts
interface SubscriptionService {
  // Lifecycle
  handleContractCreated(payload: ContractWebhookPayload): Promise<void>;
  handleContractUpdated(payload: ContractWebhookPayload): Promise<void>;
  handleBillingSuccess(payload: BillingWebhookPayload): Promise<void>;
  handleBillingFailure(payload: BillingWebhookPayload): Promise<void>;
  
  // Admin actions
  cancelSubscription(subscriptionId: number, reason: string): Promise<void>;
  changePlan(subscriptionId: number, newPlanId: number): Promise<void>;
  retryBilling(subscriptionId: number): Promise<void>;
  
  // Billing scheduler
  processDueBillings(): Promise<{ processed: number; failed: number }>;
  
  // Sync
  syncContractFromShopify(contractGid: string): Promise<void>;
  syncAllContracts(): Promise<{ synced: number; errors: number }>;
}

// selling-plan.service.ts
interface SellingPlanService {
  createSellingPlanGroup(input: SellingPlanGroupInput): Promise<string>; // returns GID
  updateSellingPlan(planGid: string, input: SellingPlanInput): Promise<void>;
  assignToProduct(groupGid: string, productGid: string): Promise<void>;
  listSellingPlans(): Promise<SellingPlan[]>;
}
```

---

## 14. Environment Variables

New variables needed:

```env
# Already exist — no change
SHOPIFY_SHOP_DOMAIN=card-shellz.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxx
SHOPIFY_API_SECRET=shpss_xxx

# New
SHOPIFY_SELLING_PLAN_GROUP_GID=gid://shopify/SellingPlanGroup/xxx  # After creation
SHOPIFY_MEMBERSHIP_PRODUCT_GID=gid://shopify/Product/xxx            # The membership product
SUBSCRIPTION_BILLING_CRON=0 * * * *                                  # Every hour
SUBSCRIPTION_DUNNING_MAX_RETRIES=4
SUBSCRIPTION_DUNNING_RETRY_DAYS=3
```

---

## 15. API Version

All Shopify GraphQL calls should use API version **2024-10** or later. The codebase currently uses REST `2024-01`. Subscription APIs are GraphQL-only — the app will use both REST (existing functionality) and GraphQL (subscriptions).

GraphQL endpoint: `https://{store}.myshopify.com/admin/api/2024-10/graphql.json`

---

## 16. Risks and Limitations

| Risk | Mitigation |
|---|---|
| Scope approval delay (1-2 weeks) | Request immediately; parallelize dev work |
| `_own_` scope limits migration options | Snapshot Appstle data before uninstall; use Option B fallback |
| Billing scheduler downtime = missed charges | Run scheduler on reliable infrastructure; alert on missed runs |
| Shopify rate limits (GraphQL cost) | Batch operations, implement backoff, spread billing across the hour |
| 48-hour deletion on app uninstall | Never uninstall; back up all selling plan config |
| Customer payment method access during migration | Test with small batch; prepare re-enrollment flow |
| Webhook delivery failures | Implement webhook retry (Shopify retries 19 times over 48h); add reconciliation job |

---

## 17. Implementation Phases

| Phase | Scope | Duration | Dependencies |
|---|---|---|---|
| **Phase 0** | Request API scopes from Shopify | 1-2 weeks | Partner Dashboard access |
| **Phase 1** | Schema migrations + data model | 1 week | None |
| **Phase 2** | Selling Plan service + creation | 1 week | Phase 0 (scopes approved) |
| **Phase 3** | Webhook handlers + lifecycle service | 1-2 weeks | Phase 1 |
| **Phase 4** | Billing scheduler | 1 week | Phase 3 |
| **Phase 5** | Admin UI (dashboard + management) | 1-2 weeks | Phase 3 |
| **Phase 6** | Gold tier + dropship integration | 1 week | Phase 3 |
| **Phase 7** | Testing + parallel run with Appstle | 2-4 weeks | Phase 4 |
| **Phase 8** | Migration execution | 1-2 weeks | Phase 7 |
| **Phase 9** | Appstle decommission | 1 week | Phase 8 |

**Total estimated timeline: 10-16 weeks**

---

## 18. Success Criteria

- [ ] All new subscribers processed through our system without Appstle
- [ ] Billing scheduler runs reliably with <1% missed billing attempts
- [ ] 100% of existing subscribers migrated to new contracts
- [ ] Dunning sequence reduces involuntary churn vs Appstle baseline
- [ ] Admin can manage all subscriptions from Echelon
- [ ] Gold tier gates dropship portal access correctly
- [ ] Appstle fully uninstalled, zero dependency on third-party subscription app
- [ ] MRR tracking visible in Echelon dashboard
