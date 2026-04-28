# DROPSHIP Implementation Delta

**Status:** Dev-ready planning file, no code implemented here.  
**Decision:** Start over for the dropship module implementation. Treat current dropship code as prototype/scaffold/reference, not production foundation.

---

## 1. Summary

The current dropship prototype should be replaced with a clean implementation built around Echelon's existing channel, ATP, OMS, reservation, and job patterns.

Core architecture:

- OMS channel is **Dropship**.
- Vendor eBay/Shopify/TikTok/etc. stores are source platforms under Dropship, not OMS channels.
- Card Shellz internal eBay remains its own separate OMS channel.
- One shared Dropship channel allocation pool feeds all vendors.
- Shellz Club `.ops` / configured dropship-entitled plan is the source of truth for vendor entitlement and wholesale pricing.
- Echelon snapshots plan economics at order acceptance.
- Accepted order means funded + reserved, zero credit exposure.
- Listing preview is computed fresh, listing push runs as jobs.
- Order intake runs as jobs/events, acceptance transaction stays atomic.
- Vendor/admin audit trail is mandatory.

---

## 2. Assumptions

- Existing ATP/allocation engine remains the inventory availability source.
- Existing OMS/WMS reservation and shipment flow remains the fulfillment backbone.
- Dropship-specific code can be rebuilt behind new tables/use cases while old prototype routes are retired.
- Stripe, eBay, Shopify calls are infrastructure adapters behind use cases, not route logic.
- Pending ACH funds are not spendable.
- Production business behavior must come from config/source systems, not hardcoded constants.

---

## 3. Prototype Code to Replace / Retire

Replace or heavily retire these as production surfaces:

- `server/modules/dropship/vendor-portal.routes.ts`
  - Direct SQL route logic.
  - Raw ATP from `inventory.inventory_levels`.
  - Float pricing with hardcoded discounts.
  - Product-only selection model.

- `server/modules/dropship/vendor-ebay.routes.ts`
  - Direct eBay push inside HTTP route.
  - Uses direct ATP service/global ATP instead of Dropship channel allocation output.
  - Hardcoded channel ID references.
  - OAuth state needs hardening.
  - Policy/setup failures are not first-class blockers.

- `server/modules/dropship/vendor-order-polling.ts`
  - Should become order intake job/event producer + processor.
  - Idempotency must be canonical `(Dropship channel_id, external_order_id)`.

- `server/modules/dropship/wallet.service.ts`
  - Useful locking pattern reference, but wallet needs available/pending balances and DB-level idempotency constraints.

- `server/modules/dropship/domain/*`, `application/*`, `interfaces/http/*`
  - Keep as shape inspiration only. Current active routes are not consistently routed through these layers.

- `shared/schema/dropship.schema.ts`
  - Keep naming/reference only. Current model is insufficient for store connections, pending balances, listing jobs, intake audit, SKU overrides, and idempotency.

---

## 4. Existing Systems to Reuse

- `server/modules/inventory/atp.service.ts`
  - Read-only ATP source.
  - Handles shared base-unit pool and UOM logic.

- `server/modules/channels/allocation-engine.service.ts`
  - Dropship availability must come from channel allocation output.
  - Supports channel/product/variant rules, floors/ceilings, warehouse assignments, audit logging.

- `server/services/index.ts`
  - Existing service wiring creates ATP and allocation engine.
  - Dropship use cases should consume registered services, not instantiate their own divergent services.

- OMS/WMS/reservation services
  - Dropship accepted orders should create normal OMS orders under the Dropship channel and reserve inventory via existing reservation path.

- Shipment/tracking push patterns
  - Existing shipment events should feed `PushTrackingToVendorStore` jobs.

---

## 5. Proposed Data Model / Migrations

### Core vendor/store

- `dropship_vendors`
  - vendor account, linked to Shellz Club member/subscription.
  - should not duplicate entitlement truth beyond audit/snapshot fields.

- `dropship_store_connections`
  - `id`
  - `vendor_id`
  - `source_platform` (`ebay`, `shopify`, future platforms)
  - `source_account_id`
  - encrypted token fields or secrets references
  - `status` (`connected`, `needs_reauth`, `refresh_failed`, `disconnected`)
  - setup/config JSON
  - timestamps
  - MVP entitlement constraint: one active connection per subscription/vendor.

### Selection/pricing/listings

- `dropship_vendor_product_selections`
  - product-level approval/default.
  - unique `(vendor_id, product_id)`.

- `dropship_vendor_variant_overrides`
  - SKU opt-out and SKU-level pricing override.
  - unique `(vendor_id, product_variant_id)`.

- `dropship_vendor_pricing_rules`
  - separate from selection.
  - scopes: `global`, `category`, `product`, `variant`.
  - rule types: `percent`, `fixed`.
  - enforce fixed price only for variant/SKU scope.

- `dropship_vendor_listings`
  - persisted external listing state after successful push.
  - `vendor_store_connection_id`
  - `product_variant_id`
  - external listing/offer IDs
  - pushed price/qty/status
  - unique active listing target key.

- `dropship_listing_push_jobs` + `dropship_listing_push_job_items`
  - per-job and per-SKU result trail.
  - idempotency key per `(vendor_store_connection_id, product_variant_id, target_platform)` or equivalent.

### Wallet

- `dropship_wallet_accounts` or extension to vendor wallet state
  - `available_balance_cents`
  - `pending_balance_cents`

- `dropship_wallet_ledger`
  - amount, status (`pending`, `settled`, `failed`), balance after where applicable.
  - DB unique `(reference_type, reference_id)` where `reference_id IS NOT NULL`.

### Order intake/audit

- `dropship_order_intake`
  - source event/order payload hash
  - `channel_id = Dropship`
  - `external_order_id`
  - `vendor_id`
  - `source_platform`
  - `source_account_id`
  - status: `received`, `accepted`, `rejected`, `retrying`, `failed`
  - reason codes/details
  - linked `oms_order_id` when accepted
  - unique `(channel_id, external_order_id)`.

### Store/setup/audit

- `dropship_store_setup_checks`
  - required policy/config checks and blockers.

- `dropship_audit_events`
  - vendor/store/listing/order/wallet lifecycle events.

---

## 6. Use-Case Layer Design

Routes validate DTOs/auth only, then call use cases.

Required use cases:

- `GenerateVendorListingPreview`
  - Reads selection rules, pricing rules, MAP, Shellz Club entitlement snapshot, Dropship channel allocation.
  - Returns per-SKU preview and validation errors.

- `CreateListingPushJob`
  - Accepts approved preview scope.
  - Creates idempotent job/items.

- `ProcessListingPushJob`
  - Pushes to eBay/Shopify adapter.
  - Records per-SKU result and external IDs.

- `RecordMarketplaceOrderIntake`
  - Writes/updates intake event idempotently.

- `AcceptDropshipOrder`
  - Atomic transaction: validate, create OMS order, reserve inventory, debit available wallet, ledger write, mark intake accepted.

- `CreditWalletDeposit`
  - Handles card/ACH settlement states correctly.

- `DebitWalletForOrder`
  - Available balance only, idempotent ledger reference.

- `RefreshStoreToken`
  - Token refresh, health state, audit events.

- `PushTrackingToVendorStore`
  - Push shipment tracking to source platform and retry/audit failures.

---

## 7. Job Workers

- Listing push worker
  - External API interactions.
  - Per-SKU success/failure.
  - Retry failed SKUs without duplicate listings.

- Order intake worker
  - Processes webhook/poll intake events.
  - Runs `AcceptDropshipOrder`.
  - Records accepted/rejected reason.

- Tracking push worker
  - Pushes tracking to vendor store.
  - Creates action items on failure.

- Token refresh worker
  - Refreshes expiring OAuth tokens.
  - Marks store `needs_reauth` or `refresh_failed` when needed.

---

## 8. Endpoint / API Design

Vendor portal/API:

- `GET /api/vendor/store-connections`
- `POST /api/vendor/store-connections/:platform/oauth/start`
- `GET /api/vendor/store-connections/oauth/callback`
- `GET /api/vendor/products`
- `POST /api/vendor/product-selections`
- `POST /api/vendor/variant-overrides`
- `POST /api/vendor/pricing-rules`
- `GET /api/vendor/listing-preview`
- `POST /api/vendor/listing-push-jobs`
- `GET /api/vendor/listing-push-jobs/:id`
- `GET /api/vendor/order-intake`
- `GET /api/vendor/orders`
- `GET /api/vendor/wallet`
- `POST /api/vendor/wallet/deposit`
- `POST /api/vendor/wallet/auto-reload`

Admin/ops:

- vendor health list
- rejected intake summary
- wallet pending/available summary
- store setup blockers
- push failure queue
- zero-credit-exposure checks

---

## 9. Portal UX Changes

Vendor home:

- Action Center first:
  - low available wallet / pending ACH
  - disconnected store/token issue
  - listing validation failures
  - rejected intake reasons
  - allocated ATP issues
  - tracking/listing push failures

- Performance below:
  - orders/sales
  - wallet spend
  - top products
  - accepted/rejected orders
  - fulfillment status/trends

Product/listing page:

- Product-level approval with SKU opt-outs.
- Pricing rules global/category/SKU.
- Fresh preview with MAP, price source, allocated ATP, setup/policy validation.
- Surface computed economics based on chosen price, do not suggest margin strategy.

Admin portal:

- Same audit data aggregated by vendor, severity, and blocked revenue.

---

## 10. Test Plan

Required tests:

- Shellz Club `.ops` source-of-truth pricing/entitlement adapter.
- Integer money math, no floats.
- MAP enforcement.
- Pricing rule precedence.
- Product selection + SKU opt-out.
- Listing preview validation.
- Listing push idempotency/retry.
- Order intake idempotency.
- Wallet credit/debit idempotency.
- Pending ACH not spendable.
- Zero-credit transaction rollback.
- Dropship allocated ATP path, no raw inventory ATP in dropship use cases.
- Tracking push retry/failure audit.
- OAuth state validation, nonce/expiry/one-time use.
- Token health states.

Use unit tests for domain/use-case logic and integration tests for DB constraints/transactions. Mock Stripe/eBay/Shopify.

---

## 11. Build Sequence + Acceptance Criteria

### Phase 1: Data model + migrations

Acceptance:
- All tables/indexes exist.
- DB-level unique constraints for wallet refs and OMS/intake idempotency.
- No production hardcoded channel IDs.

### Phase 2: Use-case skeleton

Acceptance:
- Routes call use cases only.
- Use cases have DTOs, structured errors, tests.

### Phase 3: Shellz Club `.ops` entitlement adapter

Acceptance:
- Wholesale/entitlement comes from Shellz Club plan config.
- Order acceptance snapshots plan values.

### Phase 4: Dropship allocation integration

Acceptance:
- Listing preview reads Dropship channel allocation output.
- Dropship code does not query raw inventory for ATP.

### Phase 5: Listing preview + pricing rules

Acceptance:
- Product selection/SKU opt-outs work.
- MAP enforcement works.
- Computed economics surfaced.

### Phase 6: Listing push jobs

Acceptance:
- Push runs out of request path.
- Per-SKU audit trail.
- Retry safe/idempotent.

### Phase 7: Wallet available/pending + idempotency

Acceptance:
- Card confirmed funds become available.
- ACH pending is not spendable.
- Duplicate webhooks do not duplicate balance.

### Phase 8: Order intake + atomic acceptance

Acceptance:
- Accepted order creates OMS order, reserve, wallet debit, ledger in one transaction.
- Rejected orders create intake audit only.
- Duplicate intake does not duplicate anything.

### Phase 9: Tracking push jobs

Acceptance:
- Shipment tracking posts to connected store.
- Failures create action items and retry.

### Phase 10: Vendor/admin portal polish

Acceptance:
- Vendor sees action center, performance, audit trail.
- Ops sees blocked revenue and failure summaries.

---

## 12. Risks / Failure Modes

- Reusing prototype route logic will reintroduce raw ATP, hardcoded discounts, and non-job external pushes.
- Shellz Club entitlement sync must be reliable and auditable.
- OAuth token handling must be encrypted and health visible.
- Marketplace APIs may partially fail; per-item job results are required.
- ACH settlement timing can create false available funds if not modeled separately.
- Missing DB idempotency constraints can cause financial loss on retries.
- If Dropship channel lookup uses hardcoded IDs, internal eBay and Dropship may be conflated.

---

## 13. Mandatory Completion Report Format for Future Engineering Agents

Every implementation pass must report:

- Summary of changes
- Assumptions made
- Risks
- Test coverage explanation
- Failure modes
