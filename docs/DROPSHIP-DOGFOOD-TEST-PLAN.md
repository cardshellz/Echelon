# Dropship Dogfood Test Plan

Last updated: 2026-05-20

Audience: Card Shellz internal operators dogfooding the Dropship v2 program.

Primary surface: Echelon internal admin at `/dropship`.

Customer-facing portal: `/dropship-portal`. Do not use the portal as the first dogfood control surface.

## Scope

This plan verifies one complete dropship flow from admin readiness through marketplace listing, order intake, wallet handling, WMS fulfillment, ShipStation shipment, marketplace tracking push, notifications, and return handling.

The first dogfood pass should use:

- One vendor membership.
- One marketplace store connection.
- One low-risk SKU or variant.
- One small test order.
- One real fulfillment path through WMS and ShipStation.

Expand to additional SKUs, split shipments, and multiple stores only after the first path is clean.

## Safety Rules

- Start in Echelon internal admin at `/dropship`.
- Use the `Dogfood readiness` tab before testing any marketplace flow.
- Stop if the dogfood launch gate is blocked.
- Do not run manual worker sweeps unless you are intentionally testing that specific worker.
- Do not retry financial, inventory, fulfillment, or marketplace actions blindly. First capture the failing record IDs and audit event.
- Use one controlled vendor/store/SKU until the first full path is proven.
- Do not use broad catalog exposure until a single-SKU exposure path has passed.
- Do not continue using a test order if money, inventory, fulfillment, or tracking state is unclear.

## Prerequisites

Before starting, confirm:

- The latest Echelon main deployment is live.
- The static internal `Dropship OMS` source/channel initialization is deployed.
- You can log in to Echelon as an `admin` or `lead`.
- The vendor has a Shellz Club identity and the required `.ops` entitlement.
- The vendor has exactly one dogfood store connection for the first test.
- Marketplace OAuth is configured for the selected platform.
- Token encryption config is present in production.
- ShipStation API credentials are present.
- ShipStation webhook security is configured.
- Email notification config is present.
- At least one catalog item is eligible for controlled exposure.
- Shipping config has boxes, package profiles, rate tables, markup policy, insurance policy, and return policy configured enough for the test SKU.
- Wallet funding is available or the manual credit path is ready for a controlled test.

## Test Record

Fill this in as you test. These IDs are the evidence trail.

| Field | Value |
| --- | --- |
| Test started at |  |
| Tester |  |
| Environment URL |  |
| Vendor member ID |  |
| Store connection ID |  |
| Platform | eBay / Shopify |
| Product ID |  |
| Product variant ID |  |
| SKU |  |
| Marketplace listing ID |  |
| External order ID |  |
| Dropship intake ID |  |
| OMS order ID |  |
| WMS order ID |  |
| ShipStation order ID |  |
| Shipment ID |  |
| Tracking number |  |
| Tracking push ID |  |
| Notification event IDs |  |
| Return/RMA ID |  |
| Final result | Pass / Fail |

## Phase 0: Admin Readiness

Goal: prove the admin control surface is ready before touching marketplace flows.

Steps:

1. Open Echelon internal admin at `/dropship`.
2. Open `Dogfood readiness`.
3. Confirm the `Dropship OMS source` panel is ready.
4. If the source is missing, run the source initialization action once.
5. Confirm `System readiness` has no blockers.
6. Confirm the dogfood launch gate is not blocked.
7. Confirm at least one vendor/store row is ready for dogfood.
8. Record any warnings that remain.

Pass criteria:

- Internal source is ready.
- No launch-blocking readiness checks remain.
- One vendor/store row is available for controlled testing.

Stop conditions:

- Missing token vault config.
- Missing OAuth config for the selected platform.
- Missing ShipStation credentials or webhook security.
- Missing email config if notification testing is in scope.
- Launch gate is blocked.

## Phase 1: Catalog Exposure

Goal: expose exactly the intended catalog item to the vendor.

Steps:

1. Open `Catalog exposure`.
2. Create a narrow include rule for one product, SKU, or variant.
3. Avoid `Entire catalog` for the first dogfood pass.
4. Save the rule set.
5. Use the preview table to confirm the intended row is exposed.
6. Confirm unrelated rows remain blocked.
7. Record product ID, product variant ID, and SKU.

Pass criteria:

- Exactly the intended product or variant is exposed.
- The preview explains blocked rows clearly.
- Echelon remains the source of truth for SKU, inventory, and product identity.

Stop conditions:

- The preview exposes broad unintended catalog.
- The intended SKU has no usable variant identity where variant identity is required.
- ATP is unavailable or unclear for the test SKU.

## Phase 2: Shipping Configuration

Goal: prove the test SKU can calculate a shipping charge and fulfillment policy before order intake.

Steps:

1. Open `Shipping config`.
2. Confirm at least one box/package profile applies to the SKU.
3. Confirm rate table coverage for the destination you will use.
4. Confirm markup and insurance policies are configured.
5. Confirm return policy is configured.
6. Record any assumptions in the test record.

Pass criteria:

- The test SKU has enough package and rate data for a deterministic shipping quote.
- Insurance fee behavior is configured.
- Return policy behavior is configured.

Stop conditions:

- Missing package/carton data blocks a quote.
- No rate table applies to the test destination.
- Shipping fee behavior is unclear.

## Phase 3: Store Connection

Goal: prove the vendor store connection is ready before listing or order intake.

Steps:

1. Open `Store connections`.
2. Find the selected vendor/store connection.
3. Confirm platform, external store identity, and status.
4. Confirm OAuth status is healthy.
5. Confirm listing configuration is present if listing push is in scope.
6. Confirm order processing config is present.
7. Record store connection ID.

Pass criteria:

- Store connection is active.
- OAuth is valid.
- Order processing config is ready.
- Listing config is ready if listing pushes are being tested.

Stop conditions:

- OAuth is missing or expired.
- Store identity does not match the intended vendor account.
- Store connection status is not active.

## Phase 4: Listing Push

Goal: list the exposed SKU to the vendor marketplace store.

Steps:

1. Use the vendor/store listing path for the selected SKU.
2. Trigger the listing push through the normal UI path.
3. Open `Listing pushes`.
4. Confirm the job is queued, processing, then succeeded.
5. Confirm the external marketplace listing exists.
6. Record marketplace listing ID and listing push job ID.

Pass criteria:

- Listing push completes without manual database intervention.
- External listing maps back to the Echelon SKU/product variant.
- Listing push audit events are understandable.

Stop conditions:

- Listing push fails without a retryable reason.
- External listing identity is not stored.
- SKU mapping is ambiguous.

## Phase 5: Order Intake

Goal: ingest a marketplace order from the vendor store into dropship order intake.

Steps:

1. Place a small marketplace test order for the listed SKU.
2. Open `Order intake`.
3. Find the intake row by external order ID, platform, or store connection.
4. Confirm vendor, store connection, platform, and external order ID are correct.
5. Confirm line item SKU and quantity are correct.
6. Confirm order status moves through the expected intake state.
7. Record intake ID and external order ID.

Pass criteria:

- One intake row exists for the external order.
- The intake row is tied to the correct vendor and store connection.
- Line items map to Echelon SKU/product variant identity.
- Duplicate intake is not created by retries or webhooks.

Stop conditions:

- Order is missing from intake.
- Duplicate intake rows are created.
- Line item cannot map to Echelon product identity.
- Cancellation or exception status appears without a clear reason.

## Phase 6: Wallet And Acceptance

Goal: prove the order can be financially authorized and accepted into fulfillment.

Steps:

1. Review the order's wallet or funding state.
2. If funding is insufficient, use a controlled manual credit or confirmed funding path.
3. Process or retry the intake row only after funding is clear.
4. Confirm the order is accepted.
5. Record wallet transaction or credit evidence.

Pass criteria:

- Funding behavior is deterministic.
- Any hold, debit, or credit is traceable.
- Accepted order has a clear audit trail.

Stop conditions:

- Funding state is unclear.
- Order acceptance can be retried into duplicate financial effects.
- Wallet transaction evidence is missing.

## Phase 7: OMS And WMS Handoff

Goal: prove accepted dropship orders create the correct internal order records.

Steps:

1. Confirm the accepted order has an OMS order ID.
2. Confirm the OMS order has correct source/channel tagging for dropship.
3. Confirm the WMS order exists.
4. Confirm line items, quantities, SKU, and variant identity match the intake row.
5. Confirm pick/pack/ship workflow can start normally.
6. Record OMS and WMS order IDs.

Pass criteria:

- OMS and WMS records exist.
- Source/channel identity marks the order as dropship without pretending the customer marketplace store is the internal OMS source.
- Line item identity is complete enough for fulfillment and inventory deduction.

Stop conditions:

- WMS order is missing.
- OMS and WMS line items disagree.
- SKU or variant identity is missing.
- Order is blocked without an operator-visible reason.

## Phase 8: ShipStation Fulfillment

Goal: prove fulfillment flows through WMS and ShipStation.

Steps:

1. Confirm the WMS order is pushed or visible in ShipStation as expected.
2. Ship the order in ShipStation.
3. For first dogfood, use one shipment unless split-shipment testing is intentional.
4. Record ShipStation order ID, shipment ID, carrier, service, and tracking number.
5. Confirm the ShipStation webhook is ingested.
6. Confirm WMS shipment status updates.
7. Confirm OMS fulfillment status updates.
8. Confirm inventory shipment recording occurs.

Pass criteria:

- ShipStation shipment is ingested once.
- WMS and OMS statuses update correctly.
- Inventory movement is recorded.
- Shipment line items preserve SKU/variant identity.

Stop conditions:

- Webhook is missing.
- Webhook fails without retry visibility.
- OMS is shipped but WMS is not, or the reverse.
- Inventory deduction is skipped.

## Phase 9: Split Shipment Test

Goal: prove multiple shipments on one order are preserved and pushed correctly.

Run this only after the single-shipment path passes.

Steps:

1. Create a test order with at least two line items or quantities that can be split.
2. Ship part of the order in ShipStation.
3. Confirm WMS records a partial shipment.
4. Confirm OMS remains partially fulfilled.
5. Confirm marketplace tracking push includes only the shipped items.
6. Ship the remaining item or quantity.
7. Confirm WMS and OMS move to fully shipped.
8. Confirm marketplace tracking shows each tracking number against the correct items.

Pass criteria:

- Multiple shipments are represented as separate shipment records.
- Partial shipment does not mark the full order complete too early.
- eBay or Shopify receives item-specific tracking.
- Final order status becomes fully shipped only after all shipped quantities are accounted for.

Stop conditions:

- First shipment closes the whole order incorrectly.
- Tracking is pushed without item association.
- Second shipment overwrites the first tracking record.
- Marketplace customer view cannot distinguish the shipments.

## Phase 10: Tracking Push

Goal: prove tracking is communicated back to the marketplace.

Steps:

1. Open `Tracking pushes`.
2. Find the push row for the test shipment.
3. Confirm queued, processing, and completed states.
4. Verify the marketplace order shows tracking.
5. For Shopify, confirm customer-visible fulfillment/tracking.
6. For eBay, confirm fulfillment/tracking is visible on the eBay order.
7. Record tracking push ID.

Pass criteria:

- Tracking push completes.
- Marketplace order shows the correct carrier/tracking.
- Split-shipment item associations are correct if tested.

Stop conditions:

- Push fails and retry reason is unclear.
- Marketplace shows no tracking after completed push.
- Wrong shipment, carrier, tracking, or line item is pushed.

## Phase 11: Notifications

Goal: prove operational and vendor-facing notifications fire for meaningful events.

Steps:

1. Open `Notifications`.
2. Confirm events exist for the tested order lifecycle.
3. Confirm failed notifications are visible and retryable.
4. Confirm the vendor receives expected notices if vendor notification delivery is enabled.
5. Record notification event IDs.

Pass criteria:

- Notification events are created for important state changes.
- Failures are visible in admin.
- Retry behavior is explicit.

Stop conditions:

- No notification event appears for a required event.
- Failure is silent.
- Notification content points to the wrong order, store, or vendor.

## Phase 12: Returns

Goal: prove the return policy and inspection/credit workflow can be tested safely.

Run this after order, fulfillment, and tracking pass.

Steps:

1. Open `Returns`.
2. Create or ingest a controlled return/RMA for the test order.
3. Confirm return policy selection is correct.
4. Confirm fault classification is correct.
5. If item inspection occurs, complete inspection once.
6. Confirm credit/release behavior after inspection when warranted.
7. For lost package, misdelivery, or carrier-fault cases, confirm the insurance-pool policy is represented correctly.
8. Record RMA ID and final outcome.

Pass criteria:

- Return state is visible.
- Fault classification is explicit.
- Vendor/customer/marketplace fault fees are applied according to policy.
- Inspection result drives credit/release where inspection applies.

Stop conditions:

- Return policy is missing.
- Fault classification cannot be recorded.
- Credit/release can occur without the required state.
- A lost package scenario incorrectly waits for item inspection.

## Phase 13: Audit Evidence

Goal: prove dogfood outcomes are traceable.

Steps:

1. Open `Audit events`.
2. Search for the test order, store connection, listing push, tracking push, and return IDs.
3. Confirm critical actions have useful audit records.
4. Capture unresolved errors or warnings.
5. Return to `Dogfood readiness`.
6. Confirm the dogfood smoke/readiness view reflects the completed test.

Pass criteria:

- Key actions are audit-visible.
- Errors are operator-visible.
- Dogfood readiness reflects current state.
- The final test record has enough IDs to debug later.

Stop conditions:

- Critical actions leave no audit trail.
- Dogfood readiness says ready while known blockers remain.
- Errors are only visible in logs and not in admin.

## Manual Worker Sweep Rules

Manual worker sweeps are for intentional worker testing only.

Use a manual worker sweep when:

- You have a specific stuck record.
- You have captured the record ID and current status.
- You know which worker owns that record type.
- You are verifying retry behavior.

Do not use manual worker sweeps when:

- You are only exploring the admin UI.
- The launch gate is blocked.
- The record has unclear money, inventory, or fulfillment state.
- The same action may already be running.

After a manual sweep:

1. Record worker name.
2. Record before and after status.
3. Check audit events.
4. Check the related tab for retry or failure status.
5. Do not repeat the sweep without understanding the first result.

## Failure Capture Template

Use this for every failure.

| Field | Value |
| --- | --- |
| Failed phase |  |
| Time observed |  |
| Admin tab |  |
| Error message |  |
| Entity IDs |  |
| Expected result |  |
| Actual result |  |
| Retry attempted | Yes / No |
| Worker sweep run | Yes / No |
| Screenshot captured | Yes / No |
| Audit event IDs |  |
| Logs checked | Yes / No |
| Current blocker |  |

## Dogfood Exit Criteria

Dogfood MVP is ready for broader internal use when:

- One eBay or Shopify store completes listing, order intake, acceptance, fulfillment, tracking push, notification, and audit evidence.
- One split-shipment case completes correctly if split shipments are in launch scope.
- Wallet funding behavior is traceable and idempotent.
- ShipStation webhook ingestion is reliable for the tested order.
- Marketplace tracking is customer-visible.
- No dogfood launch-blocking readiness checks remain.
- Any warnings are documented with owner and follow-up.
- No unresolved financial, inventory, fulfillment, or marketplace state ambiguity remains for the test order.

## Recommended First Dogfood Sequence

Use this exact order for the first live dogfood pass:

1. `Dogfood readiness`: clear blockers.
2. `Catalog exposure`: expose one SKU or variant.
3. `Shipping config`: confirm package/rate/policy coverage.
4. `Store connections`: confirm one vendor store is active.
5. `Listing pushes`: list one SKU.
6. Marketplace: place one small test order.
7. `Order intake`: verify intake and process acceptance.
8. `Wallet ops`: verify funding and ledger evidence.
9. WMS: pick and fulfill the order.
10. ShipStation: ship the order.
11. `Tracking pushes`: verify marketplace tracking.
12. `Notifications`: verify event delivery or retry visibility.
13. `Audit events`: capture evidence.
14. `Dogfood readiness`: confirm final state.

## Notes For Interpreting The Internal Source

The internal `Dropship OMS` source is a static Echelon source marker. It is not the vendor's eBay or Shopify store connection.

Use it to confirm accepted dropship orders are tagged as dropship inside Echelon after marketplace intake. Vendor marketplace accounts remain separate store connections under `Store connections`.

If the internal source check fails, it means the expected `channels.channels` source marker is missing or inactive. That is an internal configuration problem, not a vendor OAuth problem.
