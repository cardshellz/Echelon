# Dropship Phase 1 Engineer Brief — Data Model + Constraints Only

## Mandatory first reads

1. `/home/cardshellz/.openclaw/workspace/memory/coding-standards.md`
2. `DROPSHIP-DESIGN.md`
3. `DROPSHIP-IMPLEMENTATION-DELTA.md`

Treat the coding standards as binding. This is financial/inventory/order code. Correctness, idempotency, auditability, and rollback safety matter more than speed.

---

## Scope

Implement **Phase 1 only**:

- Data model
- Migrations
- Schema/types
- DB-level constraints/indexes
- Tests for constraints and basic model behavior

Do **not** implement:

- Vendor UI
- eBay/Shopify push
- Listing preview logic
- Order acceptance
- Wallet debit/credit use cases
- Tracking push jobs
- Production DB migration execution

---

## Branch / safety

- Create a feature branch before code changes.
- Do not run migrations against staging/production.
- Do not change `DATABASE_URL`.
- Do not touch unrelated modules unless required for schema exports/tests.

Recommended branch name:

```bash
feature/dropship-phase1-data-model
```

---

## Core locked decisions

- Dropship gets one OMS channel named **Dropship**.
- Vendor eBay/Shopify/TikTok/etc. are `source_platform` surfaces under Dropship, not OMS channels.
- Card Shellz internal eBay store remains its own separate OMS channel.
- One shared Dropship channel allocation pool feeds all vendors.
- Shellz Club `.ops` / configured dropship-entitled plan is pricing/entitlement source of truth.
- Echelon snapshots plan economics at order acceptance, but does not own the source plan config.
- Zero credit exposure: accepted order must be funded + reserved.
- Pending ACH is not spendable.
- DB-level idempotency is mandatory.
- Avoid hardcoded business rules and hardcoded channel IDs.

---

## Phase 1 deliverables

### 1. Dropship store connections

Create model/table for vendor store connections.

Required fields/concepts:

- `id`
- `vendor_id`
- `source_platform`, e.g. `ebay`, `shopify`, future `tiktok`, `instagram`, `bigcommerce`
- `source_account_id`, e.g. eBay username, Shopify domain
- token storage fields or encrypted/secrets-reference placeholders, depending existing project patterns
- `status`, minimum: `connected`, `needs_reauth`, `refresh_failed`, `disconnected`
- setup/config JSON where appropriate
- timestamps

MVP rule:

- One active store connection per subscription/vendor, but make this entitlement/config-ready. Do not hardcode future impossibility.

### 2. Product selection and SKU overrides

Product-level default selection with SKU-level exceptions.

Tables/concepts:

`dropship_vendor_product_selections`

- `vendor_id`
- `product_id`
- `enabled`
- timestamps
- unique `(vendor_id, product_id)`

`dropship_vendor_variant_overrides`

- `vendor_id`
- `product_variant_id`
- nullable `enabled_override`
- nullable `price_override_type`, allowed `percent`, `fixed`
- nullable/integer `price_override_value`
- timestamps
- unique `(vendor_id, product_variant_id)`

### 3. Pricing rules

Keep pricing rules separate from selection.

`dropship_vendor_pricing_rules`

- `vendor_id`
- `scope`, allowed `global`, `category`, `product`, `variant`
- nullable `scope_id`
- `rule_type`, allowed `percent`, `fixed`
- integer `value`
- timestamps

Constraints/validation:

- Global/category/product rules should only allow `percent`.
- `fixed` should only be valid for variant/SKU scope.
- Do not use floating point for pricing/money.

### 4. Vendor listings

Persist external listing state only after successful push.

`dropship_vendor_listings`

- `vendor_store_connection_id`
- `product_variant_id`
- external listing/offer IDs as nullable text fields
- pushed price cents
- pushed qty
- status
- timestamps

Need uniqueness for active listing target, likely:

- `(vendor_store_connection_id, product_variant_id)` active/current uniqueness

### 5. Listing push jobs

Job and item tables for future worker.

`dropship_listing_push_jobs`

- `vendor_id`
- `vendor_store_connection_id`
- status
- requested scope/payload JSON
- timestamps

`dropship_listing_push_job_items`

- job id
- product variant id
- status
- result/error JSON/text
- idempotency key
- timestamps

Need uniqueness/idempotency support so retries do not duplicate target listings.

### 6. Wallet available/pending model

Current single wallet balance is insufficient if ACH exists.

Add/adjust model for:

- `available_balance_cents`
- `pending_balance_cents`

Ledger must support:

- `status`: `pending`, `settled`, `failed`
- `reference_type`
- `reference_id`
- DB unique `(reference_type, reference_id)` where `reference_id IS NOT NULL`

Do not implement full wallet use cases yet, just schema/constraints/tests.

### 7. Order intake audit

Create intake/audit table separate from OMS orders.

`dropship_order_intake`

- `channel_id`, should point to Dropship OMS channel when used later
- `external_order_id`
- `vendor_id`
- `source_platform`
- `source_account_id`
- `source_order_id`
- status: `received`, `accepted`, `rejected`, `retrying`, `failed`
- reason code/details
- linked `oms_order_id` nullable
- raw payload or payload hash as appropriate
- timestamps

Mandatory DB uniqueness:

- unique `(channel_id, external_order_id)`

`vendor_id` is ownership metadata, not part of primary OMS/order-intake idempotency.

### 8. Store setup checks / blockers

Create a table or model for setup blockers.

Purpose:

- Required eBay/Shopify policy/config checks must not silently fail.
- Vendor and ops portal later need to surface setup blockers.

Fields/concepts:

- vendor/store connection
- check key/type
- status
- message/details
- timestamps

### 9. Audit events

Add a dropship audit/event table if no suitable existing table exists.

Should support events for:

- store connected/disconnected/reauthorized
- token refresh success/failure
- setup blocker created/resolved
- listing push job item success/failure
- intake accepted/rejected
- wallet ledger idempotency events later

---

## Existing code to inspect/reuse patterns from

Reuse concepts/patterns, not prototype business logic:

- `server/modules/inventory/atp.service.ts`
- `server/modules/channels/allocation-engine.service.ts`
- `server/services/index.ts`
- `server/modules/oms/webhook-retry.worker.ts`
- `server/modules/channels/reservation.service.ts`
- existing migration naming/numbering style under `migrations/`
- existing Drizzle schema export conventions under `shared/schema/`

Prototype/reference only:

- `server/modules/dropship/vendor-portal.routes.ts`
- `server/modules/dropship/vendor-ebay.routes.ts`
- `server/modules/dropship/vendor-order-polling.ts`
- `server/modules/dropship/wallet.service.ts`
- `shared/schema/dropship.schema.ts`

---

## Tests required in Phase 1

Add tests for:

- wallet ledger unique `(reference_type, reference_id)` behavior
- order intake unique `(channel_id, external_order_id)` behavior
- product selection unique `(vendor_id, product_id)`
- variant override unique `(vendor_id, product_variant_id)`
- pricing rule constraints, especially fixed only at variant scope
- pending/available wallet fields are integer cents, not floats
- store connection status enum/constraint
- listing target uniqueness/idempotency key shape

Use integration-style DB tests where existing project patterns support it. Mock external APIs. Do not call Stripe/eBay/Shopify.

---

## Acceptance criteria

Phase 1 is complete when:

- Migrations compile and follow existing migration conventions.
- Shared schema/types are updated consistently.
- DB constraints enforce the idempotency guarantees above.
- Tests cover critical constraints.
- No route-level business logic is added.
- No raw ATP/drop-ship availability logic is added.
- No hardcoded discounts/channel IDs are introduced.
- No production migration is run.

---

## Required completion report

Return exactly these sections:

1. Summary of changes
2. Assumptions made
3. Risks
4. Test coverage explanation
5. Failure modes
