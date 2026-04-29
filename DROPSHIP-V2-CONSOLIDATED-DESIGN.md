# Card Shellz .ops Dropship Platform - V2 Consolidated Design

Status: Authoritative build design draft  
Date: 2026-04-28  
Purpose: Merge the prior dropship and .ops portal design docs into one forward design.

This document supersedes the prior working docs for implementation decisions:

- `DROPSHIP-DESIGN.md`
- `DROPSHIP-IMPLEMENTATION-DELTA.md`
- `DROPSHIP-PHASE1-ENGINEER-BRIEF.md`
- `DROPSHIP-PHASE1-MIMO-BRIEF.md`
- `DROPSHIP-PHASE0-SPEC.md`
- `ops-portal-design-spec.md`
- `ops-portal.jsx`

The older docs remain useful only for historical context and detailed UX inspiration. The removed legacy `dropship.md` file must not be used as an implementation source. This file is the source of truth for new dropship work.

---

## 1. Design Principles

The .ops dropship platform is a Card Shellz-powered reseller and fulfillment system. Vendors use their own external storefronts while Card Shellz controls product catalog exposure, wholesale economics, inventory allocation, fulfillment, shipping calculation, wallet funding, and auditability.

Core rules:

- Echelon has one internal Dropship OMS channel.
- Vendor eBay and Shopify stores are external store connections, not Echelon OMS channels.
- Shellz Club is the login identity source.
- The `.ops` membership plan is the dropship entitlement source.
- Accepted order means funded, validated, reserved, and OMS-created.
- No dropship code should use raw inventory as vendor-facing ATP.
- All financial and inventory transitions must be idempotent and auditable.
- Current Phase 0 prototype code is reference only unless explicitly revalidated.

---

## 2. Product Phases vs Engineering Builds

Product phases define user-facing capability. Engineering builds are implementation slices that feed product phases and do not need to map 1:1.

Product Phase 0 may require several engineering builds before launch. A product phase is not complete until every required engineering slice for that product capability is complete.

### Product Phase 0 - Launch Foundation

Required capabilities:

- Shellz Club SSO into Card Shellz .ops.
- `.ops` membership entitlement.
- One active store connection per `.ops` membership.
- eBay and Shopify store connection support.
- Admin-defined dropship catalog.
- Vendor product/category/catalog selection within the exposed catalog.
- Listing preview and approval.
- Bulk listing push.
- Shopify draft-first listings.
- eBay live listings after vendor approval.
- Shared Dropship allocation pool.
- Admin-configured marketplace quantity caps.
- Wallet with ACH, card, and USDC funding rails.
- Auto-reload required.
- Real cost-based shipping quote using admin-managed rate tables.
- Multiwarehouse quote and reservation alignment.
- Order intake, atomic acceptance, fulfillment, and tracking push.
- Returns/RMA visibility.
- Email and in-app notifications.
- Portal settings with Phase 2 areas labeled "Coming soon."

### Product Phase 1 - Self-Service Hardening

Likely capabilities:

- Stronger onboarding automation.
- Better admin setup checks and blockers.
- Wallet statements and receipts.
- Expanded operational dashboards.
- Return and claim workflow refinement.
- More automated reconciliation.

### Product Phase 2 - Scale Features

Planned capabilities:

- SMS notifications.
- Vendor API keys.
- Outbound webhooks.
- Public API docs.
- Advanced vendor automation.
- Multi-store add-on entitlement.
- Live ATP webhooks/API.
- Analytics.
- Optional auto-listing for new matching SKUs.

### Engineering Build Sequence

Recommended build order:

1. Data model, migrations, schema/types, constraints, and tests.
2. Clean use-case layer skeleton.
3. Shellz Club SSO and `.ops` entitlement adapter.
4. Admin dropship catalog exposure model.
5. Dropship allocation and ATP integration.
6. Shipping/cartonization/rate table foundation.
7. Listing preview and marketplace push jobs.
8. Wallet, funding rails, auto-reload, and ledger.
9. Order intake and atomic acceptance.
10. Tracking push, returns, and notifications.
11. Vendor portal and admin/ops surfaces.

---

## 3. Identity, Entitlement, and Membership Lapse

Shellz Club is the source of login identity for .ops. Echelon does not maintain standalone dropship vendor passwords.

Identity rules:

- Vendor signs in through Card Shellz / Shellz Club SSO.
- Portal login copy: "Sign in with Card Shellz."
- Echelon stores a local `dropship_vendors` record for operational state.
- Echelon links the vendor to the internal `membership.members.id`.
- Email may be stored for display/audit, but it is not the canonical identity key.

Entitlement rules:

- Dropship access is a benefit of the `.ops` membership plan.
- Shellz Club membership data is the entitlement source of truth.
- Echelon may cache entitlement state for performance/audit, but must re-check before important actions.
- Echelon snapshots plan economics at order acceptance.

Membership lapse policy:

- If `.ops` membership lapses, use immediate pause with grace.
- Existing accepted orders continue.
- Vendor can still view history, wallet, returns, tracking, and statements.
- New product selection, listing push, and new order acceptance are blocked.
- Active marketplace listings are pushed to quantity zero or paused where supported.
- If membership is restored during grace, listings can be reactivated.
- If grace expires, listings are ended or moved to manual cleanup if API ending fails.
- Default grace period should align with store disconnect policy at 72 hours, but remain admin-configurable.

---

## 4. Store Connections and OMS Channel Model

There is exactly one Echelon Dropship OMS channel. Vendor stores are not Echelon OMS channels.

Launch platforms:

- eBay
- Shopify

Store connection rules:

- Vendor stores are modeled as `dropship_store_connections`.
- One active store connection is allowed per `.ops` membership at launch.
- Future multi-store support is driven by entitlement/add-on configuration.
- Store connections hold platform, external account identity, OAuth/secrets references, token health, setup state, disconnect state, and sync timestamps.

Store disconnect policy:

- Voluntary disconnect requires confirmation and explains the grace behavior.
- Involuntary disconnect includes OAuth revocation, password changes, token refresh failure, or platform account access loss.
- Vendor receives email and in-portal alert immediately.
- During disconnect grace, new orders from that store are rejected.
- Reconnect during grace preserves listings and resumes ATP sync.
- After grace, listings are ended where the platform API allows it.
- If final listing end fails, create an ops exception/manual cleanup task.
- Default disconnect grace is 72 hours and should be admin-configurable.

Order identity rules:

- Dropship intake uniqueness is `store_connection_id + external_order_id`.
- OMS orders use the one Dropship OMS channel.
- OMS external order keys should be generated/normalized so different vendor stores cannot collide under the single Dropship channel.

Do not implement:

- One Echelon channel per vendor store.
- `dropship_vendor_channels` as the production model.
- Hardcoded Dropship channel IDs in route or business logic.

---

## 5. Admin Dropship Catalog and Vendor Selection

Vendors do not get access to the full Echelon backend catalog. Card Shellz admin defines the available dropship catalog first.

Echelon is the source of truth for product, category, line, SKU, and variant data.

### Admin Catalog Exposure

Admin controls must support inclusion and exclusion by:

- Entire active catalog.
- Product line.
- Category.
- Product/SKU.
- SKU variant.
- Active/inactive state.

The resulting exposed catalog is the only catalog vendors can browse or select in .ops.

### Vendor Selection

Within the exposed dropship catalog, vendors can select:

- All available catalog.
- Category.
- Product.
- Variant/SKU.
- Opt-out exceptions.

Selection should be modeled as rules, not only product rows. A vendor who selects a category should stay connected to that category as Echelon catalog changes.

New SKUs matching an existing vendor selection rule are automatically connected to the vendor's selected catalog, but are not automatically pushed live by default.

Live listing push requires vendor approval unless a future explicit auto-list setting is enabled.

### Product Content

Launch allows vendors to edit:

- Retail price.
- Selection/listing state.

Launch does not allow vendors to edit:

- Product title.
- Description.
- Images.
- Brand language.
- Product content.

Marketplace-side content edits are treated as drift/audit. Card Shellz content remains the source of truth.

---

## 6. Listing Preview, Listing Push, and Marketplace Drift

Listing push must be job-based and auditable. Routes should validate input and call use cases; they should not push directly to eBay or Shopify inline.

Listing preview:

- Must be computed fresh before every push job executes.
- Does not require redundant vendor approval solely because time passed.
- Validates current catalog eligibility, selection, store health, pricing, ATP, shipping readiness, setup blockers, and marketplace requirements.

Listing behavior:

- Shopify creates draft listings first.
- eBay lists live immediately after vendor approval.
- Bulk push is supported.
- No extra admin approval gate by default.
- Push jobs must record per-item success/failure and be retry-safe.

Listing states should include:

- `not_listed`
- `preview_ready`
- `queued`
- `pushing`
- `active`
- `paused`
- `ended`
- `failed`
- `blocked`
- `drift_detected`

Marketplace drift policy:

- Retail price drift is adopted into .ops as the current store/listing price, with audit.
- Warn-only pricing violations are surfaced but not blocked at launch.
- Quantity drift is corrected from Echelon Dropship ATP/allocation.
- Content drift is detected and warned; Card Shellz content remains source of truth.
- Ended or unpublished listings are marked inactive and surfaced to the vendor.
- Severe drift creates audit/setup blocker events.

---

## 7. Pricing and Economics

Separate the following concepts:

- Wholesale cost: what vendor owes Card Shellz.
- Suggested retail: Card Shellz recommendation.
- Vendor retail: what vendor chooses to sell for.
- Pricing policy: admin-defined guardrails and warnings.

Pricing decisions:

- Vendor controls retail price.
- Card Shellz controls wholesale cost.
- Wholesale pricing comes from the `.ops` membership benefit / Shellz Club economics.
- Vendor retail price is stored per store/listing, not globally per vendor SKU.
- Marketplace-side retail price changes are adopted into .ops with audit because vendors control retail.
- Echelon snapshots economics at order acceptance.

Launch enforcement:

- MAP/floor/ceiling rules are warn-only at launch.
- There are no hard legal MAP obligations currently.
- Future enforcement modes should be configurable:
  - `off`
  - `warn_only`
  - `block_listing_push`
  - `block_order_acceptance`

Order acceptance should snapshot:

- Wholesale unit cost.
- Vendor retail price observed/submitted.
- Dropship fees.
- Shipping charge.
- Insurance pool charge where applicable.
- Membership plan/tier used.
- Pricing rule version used.

---

## 8. Inventory Allocation and ATP

Launch uses one shared Dropship allocation pool. There are no per-vendor allocation limits at launch.

Inventory rules:

- Vendor-facing availability comes from Dropship channel allocation output.
- Dropship code must not query raw inventory for ATP.
- Vendor marketplace listing quantity is admin-configured/capped, not blindly equal to full ATP.
- Quantity sync should happen on every ATP change.
- Scheduled reconciliation can exist as a safety net.

Oversell/race policy:

- First funded and reserved accepted order wins.
- If two vendors sell the last unit at nearly the same time, the second order is rejected before acceptance if possible.
- If the second order already exists from the marketplace, it moves to exception/refund/payment handling.

Future:

- Per-vendor allocation limits may be added in Product Phase 2 if abuse or imbalance appears.

---

## 9. Order Intake, Acceptance, and Rejection

Marketplace orders first land in dropship intake. They do not become accepted OMS/WMS orders until they pass funding and reservation.

Intake flow:

1. eBay or Shopify order arrives via webhook/polling.
2. System writes or updates `dropship_order_intake`.
3. Idempotency checks `store_connection_id + external_order_id`.
4. Intake stores raw payload, normalized payload, vendor, store, status, and errors.
5. Acceptance use case validates entitlement, store health, listing ownership, SKU eligibility, address, economics, wallet funding, shipping quote, and ATP.
6. Atomic acceptance creates/debits/reserves together:
   - economics snapshot
   - wallet debit/ledger write
   - OMS order under the single Dropship channel
   - inventory reservation
   - intake accepted status
   - audit events
7. Fulfillment proceeds through normal Echelon/WMS flow.
8. Tracking is pushed back to the vendor store.

Accepted order invariant:

- Accepted means funded, validated, reserved, and OMS-created.
- Incomplete/problem orders remain in intake, not committed OMS/WMS.

Rejection policies:

- Membership lapsed or grace-paused means new orders are rejected except admin override.
- If marketplace lag allows a sale after quantity should have been zero, accept it if ATP and funds are valid.
- Rejections should attempt marketplace cancellation where supported.
- If cancellation fails, create an ops exception.

---

## 10. Wallet, Funding Rails, Auto-Reload, and Payment Holds

Wallet is required at launch.

Funding rails at launch:

- Stripe ACH.
- Stripe card.
- USDC on Base.

Wallet rules:

- Auto-reload is required from launch.
- Pending ACH is not spendable.
- Echelon wallet ledger is authoritative for spendable balance.
- Funding rails create ledger entries; they do not replace the ledger.
- Wallet must track available and pending balances.
- Card and USDC can become available after confirmed success.
- ACH becomes available only after settlement.
- Wallet debit and inventory reservation happen as one atomic acceptance unit.

Payment hold:

- `payment_hold` lives in order intake, not OMS/WMS.
- No inventory reservation while an order is in `payment_hold`.
- Payment hold timeout is admin-configurable, default 48 hours.
- Vendor is notified immediately.
- Auto-reload/funding can be retried according to payment rules.
- If funding resolves before timeout, acceptance retries.
- If timeout expires, the system attempts marketplace cancellation.
- If cancellation fails, the order moves to ops exception queue.

USDC:

- USDC on Base is launch-blocking.
- Implementation should support allowance/pull or equivalent confirmed transfer flow.
- The ledger, not the chain event alone, remains the spendability source.

---

## 11. Shipping, Cartonization, Rates, and Quote API

.ops uses real cost-based shipping, not flat dropship tiers and not free shipping.

Launch approach:

- Use cached/admin-updatable rate tables.
- Put rate calculation behind a provider abstraction so live carrier APIs can be added later.
- Internal quote API exists at launch.
- Public quote API can wait until vendor API keys are available.
- Multiwarehouse is required at launch.

Shipping quote inputs:

- Fulfillment warehouse.
- Customer destination/zone.
- SKU dimensions and weight.
- SKU package profile.
- Cartonization result.
- Box/mailer catalog.
- Carrier/service/rate table.
- Admin markup.
- Insurance pool fee.
- Dunnage/box handling rules.

Shipping quote rules:

- Missing package, cartonization, warehouse, zone, or rate data blocks listing push and order acceptance.
- Vendor is charged the accepted quoted shipping amount even if final label cost differs.
- Vendor sees total shipping cost and package count.
- Vendor does not see insurance pool allocation, dunnage breakdown, or Card Shellz margin.
- Quote, wallet debit, and inventory reservation must agree on the same fulfillment warehouse/source.

Admin controls:

- Carrier/service rate tables.
- Effective dates and versioning.
- Zone definitions.
- Box catalog.
- Per-SKU packaging profiles.
- Shipping markup.
- Insurance pool percent.
- Dunnage/box allocation.

---

## 12. Returns, RMA, Refunds, and Insurance Pool

Return window:

- .ops return window defaults to 30 days.
- Return window is admin-configurable.

RMA policy:

- Vendor does not approve returns.
- RMA is notification/status, not permission.
- Card Shellz does not generate return labels at launch.
- eBay returns generally use marketplace return process/label.
- Shopify returns are vendor-managed unless later label support is added.
- Card Shellz records label source/tracking when available.

Inspection:

- One inspection only.
- Final inspection outcome triggers wallet adjustment if warranted.
- No second admin approval gate after final inspection.
- Inspection notes/photos should be visible to the vendor where relevant.

Fault categories:

- Card Shellz fault: Card Shellz bears cost.
- Vendor fault: vendor bears cost.
- Customer fault: vendor bears cost.
- Marketplace fault: vendor bears cost.
- Carrier fault/loss: paid from insurance pool according to policy.

Fees:

- All return/refund fees are configurable.
- Vendor/customer/marketplace fault may share the same configurable fee treatment.
- No return/refund fee amount should be hardcoded.

Insurance pool:

- Carrier fault/loss is covered through an insurance pool.
- Insurance pool is funded by a configurable fee baked into shipping, for example 2%.
- Lost, misdelivered, or no-inspection carrier cases can be credited from the insurance pool according to configured policy.
- Carrier claims can be tracked, but vendor credit does not necessarily wait for claim payout.

Return statuses should include:

- `requested`
- `in_transit`
- `received`
- `inspecting`
- `approved`
- `rejected`
- `credited`
- `closed`

---

## 13. Notifications, SMS, API Keys, and Webhooks

Launch notification channels:

- Email.
- In-app notifications/alerts.

Phase 2 channels/features:

- SMS.
- Vendor API keys.
- Outbound webhooks.
- Public API docs.
- Full webhook event catalog.
- HMAC-signed webhook delivery.

Settings:

- Settings should show all sections.
- Unavailable Phase 2 sections should be clearly labeled "Coming soon."

Critical notifications:

Critical operational, financial, and account-health notifications cannot be disabled.

Critical launch events include:

- Membership/entitlement paused or lapsed.
- Store disconnected or unhealthy.
- Listing push failed.
- Order rejected.
- Payment hold created.
- Payment hold expiring/expired.
- Wallet funding failed.
- Auto-reload failed.
- Return/RMA opened.
- Refund/credit posted.

Non-critical notifications can have preferences:

- Daily digest.
- Weekly performance summary.
- Low-priority catalog updates.
- Product announcements.
- Non-urgent price warnings.

---

## 14. Portal UX Scope

Portal brand:

- Brand: Card Shellz .ops.
- Domain: `cardshellz.io`.
- Login: "Sign in with Card Shellz."
- Visual direction: light, professional, business-forward.
- Primary brand color: `#C060E0`.

Launch portal pages:

- Dashboard.
- Catalog.
- Orders.
- Wallet.
- Returns.
- Settings.
- Onboarding.

Dashboard:

- Alerts/action items first.
- Metrics second.
- Recent orders, wallet activity, store sync status, top SKUs.

Catalog:

- Browse exposed Card Shellz dropship catalog.
- Search/filter by Echelon catalog data.
- Select all available catalog, category, product, or variant.
- Edit retail price.
- Bulk push listings.

Orders:

- View marketplace orders and fulfillment status.
- Show full ship-to PII in order detail.
- Show wallet debit breakdown.
- Show tracking when shipped.

Wallet:

- Available and pending balances.
- Funding methods.
- Auto-reload settings.
- Transaction history with running balance.
- Receipts/statements when implemented.

Returns:

- Submit RMA notification.
- Track inspection.
- See final credit/rejection details.

Settings:

- Account.
- Store connection.
- Wallet and payment.
- Notifications.
- API keys - Coming soon until Phase 2.
- Webhooks - Coming soon until Phase 2.
- Return/contact display.

Onboarding:

1. Welcome.
2. Connect store.
3. Pick products.
4. Fund wallet and configure auto-reload.
5. Done/activate.

Account remains in onboarding until required steps are complete.

---

## 15. Admin and Ops Tooling

Admin tooling is required for safe launch.

Admin must be able to manage:

- Dropship catalog exposure rules.
- Vendor membership/entitlement status view.
- Store connection health.
- Setup blockers.
- Listing push failures.
- Product/package profiles.
- Box catalog.
- Rate tables and effective dates.
- Zone definitions.
- Shipping markup and insurance pool settings.
- Return windows and fees.
- Payment hold timeout.
- Wallet/funding exceptions.
- Order intake exceptions.
- Marketplace cancellation failures.
- Audit event search.

Admin views should prioritize blocked revenue and operational risk:

- Payment holds.
- Store disconnects.
- Token failures.
- Listing push errors.
- Missing package/rate data.
- Rejected intake.
- Reservation failures.
- Return/claim exceptions.

---

## 16. Data Model Direction

The exact migration names/types should follow Echelon conventions, but the production model should include these concepts.

Core:

- `dropship_vendors`
- `dropship_store_connections`
- `dropship_audit_events`

Catalog and selection:

- `dropship_catalog_rules`
- `dropship_catalog_rule_items` if needed
- `dropship_vendor_selection_rules`
- `dropship_vendor_variant_overrides`

Pricing/listings:

- `dropship_vendor_listings`
- `dropship_listing_push_jobs`
- `dropship_listing_push_job_items`
- `dropship_listing_sync_events`

Wallet/funding:

- `dropship_wallet_accounts`
- `dropship_wallet_ledger`
- `dropship_funding_methods`
- `dropship_auto_reload_settings`

Order intake:

- `dropship_order_intake`
- `dropship_order_economics_snapshots`
- `dropship_order_acceptance_events` if not covered by audit.

Shipping:

- `dropship_package_profiles`
- `dropship_box_catalog`
- `dropship_rate_tables`
- `dropship_rate_table_rows`
- `dropship_zone_rules`
- `dropship_shipping_quote_snapshots`
- `dropship_insurance_pool_config`

Returns:

- `dropship_rmas`
- `dropship_rma_items`
- `dropship_rma_inspections`
- `dropship_carrier_claims`

Notifications:

- `dropship_notification_events`
- `dropship_notification_preferences`
- future `dropship_webhook_endpoints`
- future `dropship_webhook_deliveries`
- future `dropship_api_keys`

Store/setup:

- `dropship_store_setup_checks`
- `dropship_setup_blockers`

Critical constraints:

- Intake unique on `store_connection_id + external_order_id`.
- Store connection active uniqueness enforces one active connection per membership at launch.
- Listing active uniqueness by `store_connection_id + product_variant_id`.
- Wallet ledger idempotency by reference type/reference ID.
- No floating point money.
- All money in integer cents or exact decimal for crypto units as appropriate.
- No hardcoded Dropship channel ID.

---

## 17. Implementation Rules

Do not carry forward prototype behavior without revalidation.

Retire or replace production use of:

- `vendor-portal.routes.ts` direct SQL/business logic.
- `vendor-ebay.routes.ts` direct listing push.
- `vendor-order-polling.ts` hardcoded channel/order flow.
- Old `wallet.service.ts` as authoritative wallet behavior.
- Current `shared/schema/dropship.schema.ts` if it preserves old store/channel assumptions.
- Startup DDL that creates or mutates old dropship tables outside proper migrations.

Required use-case boundaries:

- Routes validate DTOs/auth and call use cases.
- External APIs are infrastructure adapters.
- Use cases own transactions and business invariants.
- Job workers own retryable external calls.
- Audit events are written for important lifecycle transitions.

Required use cases:

- `GenerateVendorListingPreview`
- `CreateListingPushJob`
- `ProcessListingPushJob`
- `RecordMarketplaceOrderIntake`
- `AcceptDropshipOrder`
- `QuoteDropshipShipping`
- `CreditWalletFunding`
- `DebitWalletForOrder`
- `HandleAutoReload`
- `RefreshStoreToken`
- `PushTrackingToVendorStore`
- `ProcessReturnInspection`
- `SendDropshipNotification`

---

## 18. Test Requirements

Minimum required coverage:

- Shellz Club `.ops` identity/entitlement adapter.
- `.ops` membership lapse behavior.
- Store connection active uniqueness.
- Intake idempotency by `store_connection_id + external_order_id`.
- Wallet ledger idempotency.
- Pending ACH not spendable.
- Atomic acceptance rollback when wallet debit fails.
- Atomic acceptance rollback when reservation fails.
- No raw inventory ATP in dropship use cases.
- Admin dropship catalog exposure rules.
- Vendor selection rule resolution.
- New matching SKU auto-connect behavior.
- Listing push idempotency and retry.
- Shopify draft-first behavior.
- eBay live-after-approval behavior.
- Marketplace price drift adoption.
- Quantity drift correction.
- Warn-only pricing rules.
- Shipping quote blocks missing package/rate data.
- Quote/reservation warehouse alignment.
- Payment hold timeout/cancellation.
- Return fault category financial behavior.
- Insurance pool credit behavior.
- Critical notification muting prevention.

External APIs must be mocked in tests:

- eBay.
- Shopify.
- Stripe.
- USDC/Base provider.
- Carrier/rate provider.

---

## 19. Remaining Implementation Details

These are not conceptual design blockers, but must be specified during implementation:

- Exact SSO protocol between cardshellz.com and cardshellz.io.
- Exact `.ops` plan identifier/feature flag shape in Shellz Club.
- Exact Dropship OMS channel lookup key or configuration mechanism.
- Exact Echelon catalog fields used for product line/category selection.
- Exact multiwarehouse allocation and reservation API integration.
- Exact USDC smart contract and custody/settlement flow.
- Exact notification provider for email.
- Exact PDF receipt/statement generator.
- Exact frontend state/routing/form libraries.

---

## 20. Non-Goals for Launch

Launch does not include:

- Standalone Echelon vendor passwords.
- Vendor content editing for title/description/images.
- Multiple active store connections per membership.
- Per-vendor allocation limits by default.
- SMS notifications.
- Self-service vendor API keys.
- Outbound webhooks.
- Public API docs.
- Live carrier API dependency for every quote.
- Public quote API.
- Automatic live listing of newly matching SKUs without explicit future setting.
