# Dropship Dogfood Checklist

Last updated: 2026-05-21

Primary admin surface: Echelon internal admin at `/dropship`.

Production customer-facing portal: `https://www.cardshellz.io`.

Customer-facing portal route: `/dropship-portal`.

Use this document as the working checklist for the first internal dropship dogfood run. Check each row as it passes. If a row fails or needs follow-up, leave it unchecked and add an exception ID in the `Exception / correction needed` column and in the `Exception Log`.

## Run Header

| Field | Value |
| --- | --- |
| Run date |  |
| Tester |  |
| Environment URL |  |
| Echelon deploy/version/commit |  |
| Acquisition path | New `.ops` / `.core` to `.ops` / `.club` to `.ops` |
| Card Shellz customer email |  |
| Starting membership plan | None / `.core` / `.club` |
| Target membership plan | `.ops` |
| Checkout session / payment ID |  |
| Subscription ID |  |
| Vendor name |  |
| Vendor member ID |  |
| Store connection ID |  |
| Marketplace | eBay / Shopify |
| Test SKU |  |
| Product ID |  |
| Product variant ID |  |
| Marketplace listing ID |  |
| External order ID |  |
| Dropship intake ID |  |
| OMS order ID |  |
| WMS order ID |  |
| ShipStation order ID |  |
| Shipment ID(s) |  |
| Tracking number(s) |  |
| Tracking push ID(s) |  |
| Notification event ID(s) |  |
| Return/RMA ID |  |
| Final result | Pass / Fail / Blocked |

## Severity Guide

| Severity | Meaning | Action |
| --- | --- | --- |
| P0 | Money, inventory, fulfillment, customer tracking, or data security is wrong or ambiguous. | Stop the run. Do not retry blindly. Fix before continuing. |
| P1 | The dogfood path is blocked or cannot be trusted without manual intervention. | Stop the affected phase. Fix before broader dogfood. |
| P2 | Operator-visible problem, confusing UI, missing evidence, or retry issue that does not corrupt state. | Record and decide whether it blocks dogfood expansion. |
| P3 | Cosmetic, wording, or low-risk usability issue. | Record and batch later unless it creates operator confusion. |

## Hard Stop Rules

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | STOP-01 | Dogfood launch gate is not blocked before marketplace testing starts. |  |  |
| [ ] | STOP-02 | Token encryption and OAuth configuration are present. |  |  |
| [ ] | STOP-03 | ShipStation credentials and webhook security are configured. |  |  |
| [ ] | STOP-04 | Test vendor and store connection identity are known and correct. |  |  |
| [ ] | STOP-05 | Customer acquisition path has proven an active `.ops` entitlement before store setup. | Member/subscription/plan evidence: |  |
| [ ] | STOP-06 | Test catalog exposure is narrow. Do not use broad catalog exposure for the first pass. |  |  |
| [ ] | STOP-07 | No unclear wallet, inventory, fulfillment, or tracking state exists before retrying any action. |  |  |
| [ ] | STOP-08 | Manual worker sweeps are only run for a specific stuck record with captured evidence. |  |  |

## Master Checklist

| Done | Phase | Required before moving on | Blocking exception |
| --- | --- | --- | --- |
| [ ] | -1. Membership acquisition | Direct `.ops` signup and `.club` to `.ops` upgrade paths are understood and at least one path is proven for the dogfood customer. |  |
| [ ] | 0. Readiness | Internal source, system readiness, launch gate, and one ready vendor/store are clean. |  |
| [ ] | 1. Vendor and store | Vendor identity, entitlement, OAuth, and order/listing config are correct. |  |
| [ ] | 2. Catalog exposure | Exactly the intended SKU or variant is exposed. |  |
| [ ] | 3. Shipping config | Package, rate, markup, insurance, and return policies cover the test SKU. |  |
| [ ] | 4. Listing push | One marketplace listing is created and mapped back to Echelon identity. |  |
| [ ] | 5. Order intake | One external marketplace order ingests once with correct vendor/store/line identity. |  |
| [ ] | 6. Wallet and acceptance | Funding/hold/debit behavior is traceable and order acceptance is idempotent. |  |
| [ ] | 7. OMS and WMS | Accepted order creates correct OMS and WMS records. |  |
| [ ] | 8. ShipStation | Shipment ingests back into WMS/OMS and inventory is recorded. |  |
| [ ] | 9. Tracking push | Marketplace customer-facing tracking is correct. |  |
| [ ] | 10. Split shipment | Multiple shipments preserve correct item-level tracking. Required only if in dogfood scope. |  |
| [ ] | 11. Notifications | Required vendor/internal notification events are visible and retryable. |  |
| [ ] | 12. Returns | Return policy, fault, inspection, and credit behavior are correct. Required only if in dogfood scope. |  |
| [ ] | 13. Audit and exit | Evidence trail is complete and final readiness reflects the run. |  |

## Phase -1: Membership Acquisition And Entitlement

Goal: prove a customer can become `.ops` entitled before setting up the dropship vendor account, store connection, catalog selection, or wallet.

Echelon dropship entitlement is consumed from the Card Shellz membership tables. The portal email must resolve to a Card Shellz member, the selected subscription must be active/current or active/past_due grace, and the selected plan must include dropship access. If any of those are unclear, stop before marketplace setup.

Use this phase twice when possible:

- First pass: walk through the expected steps without creating the customer yet. Fill `Expected evidence / ID` with where the proof should come from.
- Second pass: execute with the real dogfood customer. Fill the actual evidence and leave failed rows unchecked.

### Path A: New Or `.core` Customer Directly To `.ops`

This path covers a brand-new customer and an existing `.core` customer who signs up directly for `.ops` without buying `.club` first.

| Done | ID | Check | Expected evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | ACQ-DIRECT-01 | Choose the test email and confirm whether the starting state is new customer or existing `.core` customer. | Email / starting member ID: |  |
| [ ] | ACQ-DIRECT-02 | Confirm the customer-facing purchase path lets the customer select `.ops` directly. | Page/URL/screenshot: |  |
| [ ] | ACQ-DIRECT-03 | Confirm checkout labels the purchased plan as `.ops` and does not require `.club` first. | Checkout/session ID: |  |
| [ ] | ACQ-DIRECT-04 | Complete the purchase or upgrade with the test payment method. | Payment/checkout ID: |  |
| [ ] | ACQ-DIRECT-05 | Confirm the Card Shellz member email exactly matches the email used in the dropship portal. | Member email: |  |
| [ ] | ACQ-DIRECT-06 | Confirm the customer has one intended member identity. Existing `.core` customers should not create a duplicate member. | Member ID: |  |
| [ ] | ACQ-DIRECT-07 | Confirm the active subscription points to the `.ops` plan. | Subscription ID / plan ID: |  |
| [ ] | ACQ-DIRECT-08 | Confirm the `.ops` plan is active and includes dropship access. | `includes_dropship=true`: |  |
| [ ] | ACQ-DIRECT-09 | Open `https://www.cardshellz.io` and start portal setup with the same email. | Portal screenshot/status: |  |
| [ ] | ACQ-DIRECT-10 | Complete portal bootstrap or login. | Auth identity / session result: |  |
| [ ] | ACQ-DIRECT-11 | Confirm Echelon created or synced the dropship vendor profile from that member entitlement. | Vendor ID / entitlement status: |  |

Path A pass criteria:

- A new or `.core` customer can buy `.ops` directly.
- The same Card Shellz member identity is used by the dropship portal.
- The `.ops` plan is the entitlement source and includes dropship access.
- Echelon provisions a dropship vendor profile after portal setup.

### Path B: Existing `.club` Customer Upgrades To `.ops`

This path covers an existing `.club` customer upgrading into the dropship benefit.

| Done | ID | Check | Expected evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | ACQ-UPGRADE-01 | Choose an existing `.club` test customer and record the current member identity. | Email / member ID: |  |
| [ ] | ACQ-UPGRADE-02 | Confirm the current subscription is `.club` before upgrade starts. | Current subscription / plan ID: |  |
| [ ] | ACQ-UPGRADE-03 | Confirm the customer-facing upgrade path offers `.ops`. | Page/URL/screenshot: |  |
| [ ] | ACQ-UPGRADE-04 | Confirm upgrade pricing, proration, or replacement behavior is clear before payment. | Checkout/session details: |  |
| [ ] | ACQ-UPGRADE-05 | Complete the upgrade with the test payment method. | Payment/checkout ID: |  |
| [ ] | ACQ-UPGRADE-06 | Confirm the upgrade preserves the same Card Shellz member identity. | Same member ID confirmed: |  |
| [ ] | ACQ-UPGRADE-07 | Confirm the active/current subscription selected for entitlement is now `.ops`. | Subscription ID / plan ID: |  |
| [ ] | ACQ-UPGRADE-08 | Confirm old `.club` state does not remain the selected entitlement source for dropship. | Old subscription status: |  |
| [ ] | ACQ-UPGRADE-09 | Confirm the `.ops` plan is active and includes dropship access. | `includes_dropship=true`: |  |
| [ ] | ACQ-UPGRADE-10 | Open `https://www.cardshellz.io` and start portal setup or login with the same email. | Portal screenshot/status: |  |
| [ ] | ACQ-UPGRADE-11 | Complete portal bootstrap or login. | Auth identity / session result: |  |
| [ ] | ACQ-UPGRADE-12 | Confirm Echelon created or synced the dropship vendor profile from that upgraded entitlement. | Vendor ID / entitlement status: |  |

Path B pass criteria:

- A `.club` customer can upgrade to `.ops`.
- The same Card Shellz member identity is preserved.
- The entitlement resolver selects the `.ops` subscription/plan after upgrade.
- Echelon provisions or syncs the dropship vendor profile after portal setup.

### Acquisition Failure Checks

Run these negative checks once during dogfood setup. They prevent false positives before money and marketplace flows are involved.

| Done | ID | Check | Expected evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | ACQ-FAIL-01 | Try portal setup with a non-member email and confirm access is denied. | Error/status: |  |
| [ ] | ACQ-FAIL-02 | Try portal setup with a `.core` or `.club` member that has not upgraded to `.ops` and confirm access is denied. | Error/status: |  |
| [ ] | ACQ-FAIL-03 | Confirm failed entitlement does not create an active dropship vendor. | Vendor lookup result: |  |
| [ ] | ACQ-FAIL-04 | Confirm failed setup produces an operator-visible reason, not a generic crash. | Error code/message: |  |

Phase pass criteria:

- At least one real dogfood customer path has a proven `.ops` entitlement.
- Direct `.ops` signup and `.club` to `.ops` upgrade have either passed or have explicit exceptions.
- Failed entitlement cases are rejected cleanly.
- Do not proceed to Phase 0 until the dogfood customer can log into the dropship portal and Echelon has a vendor profile for that member.

## Phase 0: Readiness

Goal: prove the internal admin control surface is ready before touching marketplace flows.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | READY-01 | Open Echelon internal admin at `/dropship`. | Screenshot / URL: |  |
| [ ] | READY-02 | Open `Dogfood readiness`. |  |  |
| [ ] | READY-03 | Confirm `Dropship OMS source` is ready. | Source status: |  |
| [ ] | READY-04 | If source is missing, run the source initialization action once. | Result: |  |
| [ ] | READY-05 | Confirm `System readiness` has no blockers. | Blockers count: |  |
| [ ] | READY-06 | Confirm launch gate is not blocked. | Gate status: |  |
| [ ] | READY-07 | Confirm one vendor/store row is ready for dogfood. | Vendor/store row: |  |
| [ ] | READY-08 | Record any remaining warnings. | Warning IDs/count: |  |

Phase pass criteria:

- Internal source is ready.
- No launch-blocking readiness checks remain.
- One vendor/store row is ready for controlled testing.

## Phase 1: Vendor And Store Connection

Goal: prove the selected vendor and marketplace store are the intended dogfood target.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | STORE-01 | Confirm vendor has Shellz Club identity. | Member ID: |  |
| [ ] | STORE-02 | Confirm vendor has required `.ops` entitlement. | Entitlement evidence: |  |
| [ ] | STORE-03 | Open `Store connections`. |  |  |
| [ ] | STORE-04 | Confirm selected store connection belongs to the intended vendor. | Store connection ID: |  |
| [ ] | STORE-05 | Confirm marketplace platform is correct. | eBay / Shopify: |  |
| [ ] | STORE-06 | Confirm external store identity matches the vendor account. | External store/account ID: |  |
| [ ] | STORE-07 | Confirm OAuth status is healthy. | OAuth status: |  |
| [ ] | STORE-08 | Confirm order processing config is present. | Config ID/status: |  |
| [ ] | STORE-09 | Confirm listing config is present if listing push is in scope. | Config ID/status: |  |

Phase pass criteria:

- Store connection is active and tied to the correct vendor.
- OAuth is valid.
- Listing and order processing configuration match the intended platform.

## Phase 2: Catalog Exposure

Goal: expose exactly the intended catalog item to the vendor.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | CAT-01 | Open `Catalog exposure`. |  |  |
| [ ] | CAT-02 | Create a narrow include rule for one product, SKU, or variant. | Rule ID/scope: |  |
| [ ] | CAT-03 | Do not use `Entire catalog` for the first dogfood pass. | Confirmed: |  |
| [ ] | CAT-04 | Save the rule set. | Save result: |  |
| [ ] | CAT-05 | Use preview to confirm intended row is exposed. | Product/variant/SKU: |  |
| [ ] | CAT-06 | Confirm unrelated rows remain blocked. | Blocked count/sample: |  |
| [ ] | CAT-07 | Confirm Echelon SKU/product variant identity is available for the row. | Product variant ID: |  |
| [ ] | CAT-08 | Confirm ATP is available and believable for the test quantity. | ATP value: |  |

Phase pass criteria:

- Exactly the intended product or variant is exposed.
- Unrelated catalog remains blocked.
- Echelon remains the source of truth for product, SKU, variant, and inventory identity.

## Phase 3: Shipping Configuration

Goal: prove the test SKU can calculate shipping and use the intended policy stack.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | SHIPCFG-01 | Open `Shipping config`. |  |  |
| [ ] | SHIPCFG-02 | Confirm package or carton data applies to the test SKU. | Package/profile ID: |  |
| [ ] | SHIPCFG-03 | Confirm box configuration exists. | Box ID/name: |  |
| [ ] | SHIPCFG-04 | Confirm rate table covers the test destination. | Rate table/zone: |  |
| [ ] | SHIPCFG-05 | Confirm markup policy is configured. | Policy ID: |  |
| [ ] | SHIPCFG-06 | Confirm insurance policy is configured. | Policy ID / fee: |  |
| [ ] | SHIPCFG-07 | Confirm return policy is configured. | Policy ID: |  |
| [ ] | SHIPCFG-08 | Record the quoted or expected shipping charge. | Amount: |  |

Phase pass criteria:

- Shipping quote path has package data and rate coverage.
- Markup, insurance, and return policies are explicit.
- No hardcoded shipping behavior is needed for this test.

## Phase 4: Listing Push

Goal: create one marketplace listing and prove it maps back to Echelon identity.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | LIST-01 | Trigger listing push through the normal admin path. | Trigger action/time: |  |
| [ ] | LIST-02 | Open `Listing pushes`. |  |  |
| [ ] | LIST-03 | Confirm listing job is created. | Job ID: |  |
| [ ] | LIST-04 | Confirm job moves through queued/processing/succeeded. | Final status: |  |
| [ ] | LIST-05 | Confirm external marketplace listing exists. | Marketplace listing ID: |  |
| [ ] | LIST-06 | Confirm external listing maps to Echelon SKU/product variant. | Mapping evidence: |  |
| [ ] | LIST-07 | Confirm listing push audit event exists. | Audit event ID: |  |

Phase pass criteria:

- Listing push completes without manual database intervention.
- Marketplace listing identity is stored.
- Listing maps to the correct Echelon SKU/product variant.

## Phase 5: Order Intake

Goal: ingest one marketplace order into dropship order intake exactly once.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | ORDER-01 | Place one small marketplace test order for the listed SKU. | Marketplace order ID: |  |
| [ ] | ORDER-02 | Open `Order intake`. |  |  |
| [ ] | ORDER-03 | Find intake row by external order ID, platform, or store connection. | Intake ID: |  |
| [ ] | ORDER-04 | Confirm vendor identity is correct. | Vendor/member ID: |  |
| [ ] | ORDER-05 | Confirm store connection identity is correct. | Store connection ID: |  |
| [ ] | ORDER-06 | Confirm platform and external order ID are correct. | Platform/order ID: |  |
| [ ] | ORDER-07 | Confirm line item SKU and quantity are correct. | SKU/qty: |  |
| [ ] | ORDER-08 | Confirm line item maps to Echelon product variant identity. | Product variant ID: |  |
| [ ] | ORDER-09 | Confirm duplicate intake is not created by webhook or retry behavior. | Duplicate check: |  |
| [ ] | ORDER-10 | Confirm cancellation/exception state is absent unless expected. | Status: |  |

Phase pass criteria:

- One intake row exists for the external order.
- Vendor, store connection, platform, order ID, SKU, quantity, and variant identity are correct.
- Duplicate intake is prevented.

## Phase 6: Wallet And Acceptance

Goal: prove order funding and acceptance are traceable and idempotent.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | WALLET-01 | Review wallet or funding state for the order. | Wallet state: |  |
| [ ] | WALLET-02 | If funding is insufficient, use controlled manual credit or confirmed funding path. | Credit/funding ID: |  |
| [ ] | WALLET-03 | Confirm hold, debit, credit, or release is traceable. | Ledger/transaction ID: |  |
| [ ] | WALLET-04 | Process or retry intake only after funding state is clear. | Action/time: |  |
| [ ] | WALLET-05 | Confirm order is accepted. | Accepted status/time: |  |
| [ ] | WALLET-06 | Confirm repeated process/retry does not create duplicate financial effects. | Idempotency evidence: |  |
| [ ] | WALLET-07 | Confirm audit event exists for critical wallet action. | Audit event ID: |  |

Phase pass criteria:

- Funding behavior is deterministic.
- Wallet effects are traceable.
- Acceptance cannot duplicate financial effects.

## Phase 7: OMS And WMS Handoff

Goal: prove accepted dropship orders create correct internal order records.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | HANDOFF-01 | Confirm accepted order has an OMS order. | OMS order ID: |  |
| [ ] | HANDOFF-02 | Confirm OMS order has dropship source/channel tagging. | Source/channel: |  |
| [ ] | HANDOFF-03 | Confirm WMS order exists. | WMS order ID: |  |
| [ ] | HANDOFF-04 | Confirm OMS and WMS line items agree. | Line comparison: |  |
| [ ] | HANDOFF-05 | Confirm SKU, quantity, and product variant identity are complete. | SKU/qty/variant: |  |
| [ ] | HANDOFF-06 | Confirm WMS pick/pack/ship workflow can start normally. | WMS status: |  |
| [ ] | HANDOFF-07 | Confirm blocked state is absent or operator-visible. | Blocker status: |  |
| [ ] | HANDOFF-08 | Confirm audit event exists for handoff. | Audit event ID: |  |

Phase pass criteria:

- OMS and WMS records exist.
- Line items match.
- Dropship source tagging is internal to Echelon and separate from vendor store connection identity.

## Phase 8: ShipStation Fulfillment

Goal: prove fulfillment flows through WMS and ShipStation and returns cleanly.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | FULFILL-01 | Confirm WMS order is pushed or visible in ShipStation as expected. | ShipStation order ID: |  |
| [ ] | FULFILL-02 | Ship the order in ShipStation. | Shipment ID: |  |
| [ ] | FULFILL-03 | Record carrier, service, and tracking number. | Carrier/service/tracking: |  |
| [ ] | FULFILL-04 | Confirm ShipStation webhook is ingested. | Webhook/inbox ID: |  |
| [ ] | FULFILL-05 | Confirm WMS shipment status updates. | WMS status: |  |
| [ ] | FULFILL-06 | Confirm OMS fulfillment status updates. | OMS status: |  |
| [ ] | FULFILL-07 | Confirm shipment line items preserve SKU/variant identity. | Line evidence: |  |
| [ ] | FULFILL-08 | Confirm inventory shipment recording occurs. | Inventory movement ID: |  |
| [ ] | FULFILL-09 | Confirm no duplicate shipment is created by webhook retry. | Duplicate check: |  |

Phase pass criteria:

- ShipStation shipment is ingested once.
- WMS and OMS status update correctly.
- Inventory shipment recording is not skipped.

## Phase 9: Tracking Push

Goal: prove customer-visible tracking is pushed back to the marketplace.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | TRACK-01 | Open `Tracking pushes`. |  |  |
| [ ] | TRACK-02 | Find tracking push row for the test shipment. | Tracking push ID: |  |
| [ ] | TRACK-03 | Confirm push moves through queued/processing/completed. | Final status: |  |
| [ ] | TRACK-04 | Confirm carrier and tracking number are correct. | Carrier/tracking: |  |
| [ ] | TRACK-05 | For Shopify, confirm customer-visible fulfillment/tracking. | Shopify evidence: |  |
| [ ] | TRACK-06 | For eBay, confirm order fulfillment/tracking is visible. | eBay evidence: |  |
| [ ] | TRACK-07 | Confirm retry path is visible if push fails. | Retry status: |  |
| [ ] | TRACK-08 | Confirm audit event exists for tracking push. | Audit event ID: |  |

Phase pass criteria:

- Marketplace order shows the correct tracking.
- Push completion matches the actual marketplace customer view.
- Failures are visible and retryable.

## Phase 10: Split Shipment Test

Run this only after the single-shipment path passes. Required if split shipments are in dogfood launch scope.

Goal: prove multiple shipments on one order are preserved and pushed with correct item associations.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | SPLIT-01 | Create a test order with at least two shippable lines or quantities. | External order ID: |  |
| [ ] | SPLIT-02 | Ship only part of the order in ShipStation. | First shipment ID: |  |
| [ ] | SPLIT-03 | Confirm WMS records partial shipment only. | WMS status: |  |
| [ ] | SPLIT-04 | Confirm OMS remains partially fulfilled. | OMS status: |  |
| [ ] | SPLIT-05 | Confirm marketplace tracking push includes only shipped items. | Push/item evidence: |  |
| [ ] | SPLIT-06 | Ship remaining line or quantity. | Second shipment ID: |  |
| [ ] | SPLIT-07 | Confirm WMS and OMS move to fully shipped only after final shipment. | Final statuses: |  |
| [ ] | SPLIT-08 | Confirm marketplace shows each tracking number against correct item(s). | Marketplace evidence: |  |
| [ ] | SPLIT-09 | Confirm second shipment does not overwrite first tracking record. | Tracking comparison: |  |

Phase pass criteria:

- Multiple shipments are represented as separate shipment records.
- Partial shipment does not close the full order early.
- Marketplace tracking is item-specific.

## Phase 11: Notifications

Goal: prove required vendor and internal notifications are visible and retryable.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | NOTIFY-01 | Open `Notifications`. |  |  |
| [ ] | NOTIFY-02 | Confirm notification events exist for tested order lifecycle. | Event IDs: |  |
| [ ] | NOTIFY-03 | Confirm event payload points to correct vendor/store/order. | Payload evidence: |  |
| [ ] | NOTIFY-04 | Confirm failed notifications are visible. | Failure evidence: |  |
| [ ] | NOTIFY-05 | Confirm failed notifications are retryable. | Retry evidence: |  |
| [ ] | NOTIFY-06 | Confirm vendor receives expected notice if delivery is enabled. | Delivery evidence: |  |
| [ ] | NOTIFY-07 | Confirm audit event exists for notification action. | Audit event ID: |  |

Phase pass criteria:

- Important state changes create notification events.
- Failures are visible and retryable.
- Notification identity is correct.

## Phase 12: Returns

Run this after order, fulfillment, and tracking pass. Required if returns are in dogfood launch scope.

Goal: prove return policy, fault, inspection, and credit/release behavior.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | RETURN-01 | Open `Returns`. |  |  |
| [ ] | RETURN-02 | Create or ingest controlled return/RMA for the test order. | RMA ID: |  |
| [ ] | RETURN-03 | Confirm return policy selection is correct. | Policy ID: |  |
| [ ] | RETURN-04 | Confirm fault classification is explicit. | Fault type: |  |
| [ ] | RETURN-05 | If item inspection applies, complete inspection once. | Inspection ID/result: |  |
| [ ] | RETURN-06 | Confirm credit/release behavior follows inspection result where inspection applies. | Credit/release ID: |  |
| [ ] | RETURN-07 | For lost package, misdelivery, or carrier fault, confirm no item inspection is incorrectly required. | Outcome evidence: |  |
| [ ] | RETURN-08 | Confirm vendor/customer/marketplace fault fees follow policy. | Fee evidence: |  |
| [ ] | RETURN-09 | Confirm audit event exists for return action. | Audit event ID: |  |

Phase pass criteria:

- Return state is visible.
- Fault classification is explicit.
- Credit/release behavior follows the configured policy.

## Phase 13: Audit And Exit

Goal: prove the dogfood run has a usable evidence trail and no unresolved launch blockers.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | AUDIT-01 | Open `Audit events`. |  |  |
| [ ] | AUDIT-02 | Search by vendor/store/order/listing/tracking IDs. | Search terms: |  |
| [ ] | AUDIT-03 | Confirm catalog exposure audit evidence exists. | Audit event ID: |  |
| [ ] | AUDIT-04 | Confirm listing push audit evidence exists. | Audit event ID: |  |
| [ ] | AUDIT-05 | Confirm order intake audit evidence exists. | Audit event ID: |  |
| [ ] | AUDIT-06 | Confirm wallet audit evidence exists. | Audit event ID: |  |
| [ ] | AUDIT-07 | Confirm WMS/ShipStation handoff audit evidence exists. | Audit event ID: |  |
| [ ] | AUDIT-08 | Confirm tracking push audit evidence exists. | Audit event ID: |  |
| [ ] | AUDIT-09 | Confirm notification/return audit evidence exists if tested. | Audit event ID: |  |
| [ ] | AUDIT-10 | Return to `Dogfood readiness` and confirm final readiness state. | Final gate status: |  |
| [ ] | AUDIT-11 | Confirm all P0/P1 exceptions are resolved or explicitly accepted before broader dogfood. | Exception IDs: |  |

Phase pass criteria:

- Critical actions have audit evidence.
- Final readiness reflects the run.
- No unresolved P0/P1 exception remains.

## Manual Worker Sweep Checklist

Manual worker sweeps are for intentional worker testing only. Do not use them as a general "try again" button.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | SWEEP-01 | Specific stuck record is identified. | Record ID: |  |
| [ ] | SWEEP-02 | Current status and failure reason are captured before sweep. | Before status: |  |
| [ ] | SWEEP-03 | Correct owning worker is known. | Worker name: |  |
| [ ] | SWEEP-04 | Sweep is run once. | Run time/result: |  |
| [ ] | SWEEP-05 | After status is captured. | After status: |  |
| [ ] | SWEEP-06 | Related tab and audit events are checked. | Audit/event IDs: |  |
| [ ] | SWEEP-07 | Sweep is not repeated unless the first result is understood. | Confirmed: |  |

## Exception Log

Use one row per issue. Reference the exception ID in the related checklist row.

| Exception ID | Severity | Phase/check ID | Record IDs | What failed | Expected result | Actual result | Correction needed | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EX-001 |  |  |  |  |  |  |  |  | Open / Fixed / Accepted |
| EX-002 |  |  |  |  |  |  |  |  | Open / Fixed / Accepted |
| EX-003 |  |  |  |  |  |  |  |  | Open / Fixed / Accepted |
| EX-004 |  |  |  |  |  |  |  |  | Open / Fixed / Accepted |
| EX-005 |  |  |  |  |  |  |  |  | Open / Fixed / Accepted |

## Final Dogfood Exit Checklist

| Done | ID | Exit condition | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | EXIT-01 | One marketplace store completes listing, order intake, acceptance, fulfillment, tracking push, notification, and audit evidence. |  |  |
| [ ] | EXIT-02 | Split shipment case completes correctly if split shipments are in launch scope. |  |  |
| [ ] | EXIT-03 | Wallet funding behavior is traceable and idempotent. |  |  |
| [ ] | EXIT-04 | ShipStation webhook ingestion is reliable for tested order(s). |  |  |
| [ ] | EXIT-05 | Marketplace tracking is customer-visible and correct. |  |  |
| [ ] | EXIT-06 | Return flow passes if returns are in dogfood scope. |  |  |
| [ ] | EXIT-07 | No launch-blocking dogfood readiness checks remain. |  |  |
| [ ] | EXIT-08 | All P0/P1 exceptions are fixed or explicitly accepted. |  |  |
| [ ] | EXIT-09 | P2/P3 exceptions are logged with owner and follow-up. |  |  |
| [ ] | EXIT-10 | Final test record is complete enough to debug later. |  |  |

## Internal Source Note

The internal `Dropship OMS` source is a static Echelon source marker. It is not the vendor's eBay or Shopify store connection.

Use it to confirm accepted dropship orders are tagged as dropship inside Echelon after marketplace intake. Vendor marketplace accounts remain separate store connections under `Store connections`.

If the internal source check fails, the expected `channels.channels` source marker is missing or inactive. Treat that as an internal configuration issue, not a vendor OAuth issue.
