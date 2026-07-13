# Dropship Dogfood Checklist

Last updated: 2026-07-05

Primary admin surface: Echelon internal admin at `/dropship`.

Production customer-facing portal: `https://www.cardshellz.io`.

Customer-facing portal route: `/dropship-portal`.

Use this document as the working checklist for the first internal dropship dogfood run. Check each row as it passes. If a row fails or needs follow-up, leave it unchecked and add an exception ID in the `Exception / correction needed` column and in the `Exception Log`.

## Run Header

| Field | Value |
| --- | --- |
| Run date | 2026-06-28 to 2026-06-29 |
| Tester | Brett / Codex assist |
| Environment URL | Echelon production admin `/dropship`; customer portal `https://www.cardshellz.io/dropship-portal` |
| Echelon deploy/version/commit | Latest repo main observed at `22ef5f41`; dropship-relevant fixes through PR #796 / commit `214c10ac`; confirm deployed production commit before marketplace order testing |
| Acquisition path | Existing `.core` customer upgraded to `.ops` through admin UI for dogfood setup |
| Card Shellz customer email | `bseager6@gmail.com` for portal login; original membership row began as `nwscards@gmail.com` |
| Starting membership plan | `.core` |
| Target membership plan | `.ops` |
| Checkout session / payment ID | Not tested yet; admin/manual upgrade used for current dogfood customer |
| Subscription ID | `b92ddb72-422c-4c20-b02d-f9861b1c369f` |
| Vendor name |  |
| Vendor member ID | Member ID `42226465-6f54-4723-9204-057a5d38657e`; `.ops` plan ID `14d8698f-09d8-4dea-8089-fa9a1ec0fb28` |
| Store connection ID | `9f2a4919-ed4a-4130-b2fc-62ce0f91f51b` observed in portal/admin; confirm numeric DB ID if needed |
| Marketplace | eBay |
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
| Final result | In progress; paused before package-data verification, final catalog exposure, listing push, and marketplace order test |

## Current Working Status - 2026-07-05

Resume point: confirm production has the latest intended `main` deploy, then continue at Phase 3/4 with readiness verification, package-data verification for one test SKU, and narrow variant-level catalog exposure.

Confirmed so far:

- `.ops` entitlement exists for the dogfood customer: active/current `.ops` subscription `b92ddb72-422c-4c20-b02d-f9861b1c369f`, plan ID `14d8698f-09d8-4dea-8089-fa9a1ec0fb28`, `includes_dropship=true`.
- Portal login worked for `bseager6@gmail.com` after the auth-flow fixes and password reset flow landed.
- eBay connection flow worked after OAuth/connect-change-store fixes. Connected store is `marzcards`; do not accept fallback labels like `eBay connection 1` as final evidence.
- Default warehouse has been set to warehouse ID `1` for the connected store. This is the 20 Leonberg ship-from warehouse.
- Shipping config exists for a single-carton dogfood SKU: default warehouse, box, product shipping/profile data, zone/rate, markup, insurance, and return policy were created through the admin UI. Production profile `COGS-TEST-001-P1` is bounded at 4 units/package, but box `8X6X4` still needs a maximum loaded weight before final quote validation.
- Latest relevant merged work after the prior 2026-06-29 status:
  - PR #746 simplified catalog preview row actions to one Expose/Hide action.
  - PR #748 clarified catalog exposure published/unpublished state.
  - PR #750 added catalog preview pagination and clearer rule labels.
  - PR #751 added visible/hidden and active/inactive preview filters.
  - PR #758 removed non-useful shipping config search behavior.
  - PR #762 organized shipping config into tabs.
  - PR #765 and PR #768 simplified store connections admin and clarified readiness columns.
  - PR #785 shared eBay listing payload construction across admin and dropship paths.
  - Commit `5b058adb` refactored marketplace listing connectors.
  - Commit `f7b2f741` uses retail cache as the listing price source.
  - PR #794 moved package tools to Catalog > Variants.
  - PR #796 added a per-SKU package line editor instead of same-value bulk package editing.

Not yet proven:

- Customer-facing `.ops` purchase/checkout path. Current dogfood customer was upgraded manually/admin-side.
- Final dogfood readiness gate screenshot after latest deploy.
- Production browser verification of the Catalog > Variants package line editor.
- Package weight/dimensions for the chosen test SKU.
- Narrow catalog exposure for the chosen SKU.
- Listing push, marketplace order placement, order intake, wallet debit, OMS/WMS handoff, ShipStation fulfillment, tracking push, notifications, and returns.

Next operator steps:

1. Pull latest `main` on the testing computer and confirm the deployment includes dropship-relevant changes through PR #796.
2. Re-open Echelon `/dropship` and verify the dogfood row for `bseager6@gmail.com` / `marzcards`.
3. Pick one test SKU and confirm package weight/dimensions are saved from Catalog > Variants > Package Editor.
4. Expose only that product variant. Do not use broad entire-catalog exposure for the first marketplace order.
5. Validate Catalog preview filters and the vendor portal catalog show that SKU and only the intended SKU.
6. Continue with listing push and order intake phases below.

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
| [ ] | STOP-01 | Admin dogfood launch gate is not blocked before marketplace listing or order testing starts. |  |  |
| [ ] | STOP-02 | Token encryption and OAuth configuration are present. |  |  |
| [ ] | STOP-03 | ShipStation credentials and webhook security are configured. |  |  |
| [x] | STOP-04 | Test vendor and store connection identity are known and correct. | eBay store `marzcards`; portal email `bseager6@gmail.com`; store connection UUID `9f2a4919-ed4a-4130-b2fc-62ce0f91f51b` observed | Reconfirm after latest deploy |
| [x] | STOP-05 | Customer acquisition path has proven an active `.ops` entitlement before store setup. | Member `42226465-6f54-4723-9204-057a5d38657e`; subscription `b92ddb72-422c-4c20-b02d-f9861b1c369f`; plan `.ops` / `includes_dropship=true` | Customer-facing checkout path still unproven; see EX-001 |
| [ ] | STOP-06 | Test catalog exposure is narrow. Do not use broad catalog exposure for the first pass. | Pending test SKU selection | Resume here next |
| [ ] | STOP-07 | No unclear wallet, inventory, fulfillment, or tracking state exists before retrying any action. |  |  |
| [ ] | STOP-08 | Manual worker sweeps are only run for a specific stuck record with captured evidence. |  |  |
| [x] | STOP-09 | Production proxy/session config and automatic order processing are enabled. | Release `v2366`; `TRUST_PROXY=true`; `DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true` verified 2026-07-13 | Complete one authenticated portal login after the config restart |
| [ ] | STOP-10 | The test SKU has canonical positive weight and all three dimensions; the chosen box has accurate inner dimensions and tare; cartonizer v3 returns no fallback parcel. | Legacy `COGS-TEST-001-P1.max_units_per_package=4` and `8X6X4.max_weight_grams=NULL` are not blockers after PR #909 | Verify package data and capture the multi-unit carton/quote result before listing testing |

## Master Checklist

| Done | Phase | Required before moving on | Blocking exception |
| --- | --- | --- | --- |
| [ ] | 0. Membership acquisition | Direct `.ops` signup and `.club` to `.ops` upgrade paths are understood and at least one path is proven for the dogfood customer. | Partial: `.core` to `.ops` entitlement proven by admin/manual upgrade; customer-facing checkout path still unproven |
| [x] | 1. Portal bootstrap | The `.ops` customer can access the dropship portal and Echelon provisions the vendor profile. | Relogin worked for `bseager6@gmail.com`; vendor profile present |
| [x] | 2. Store connection | Vendor OAuth, store identity, and order/listing config are correct. | eBay store `marzcards` connected; verify one more time after latest deploy |
| [ ] | 3. Admin readiness gate | Internal source, system readiness, launch gate, and one ready vendor/store are clean. | Need final readiness screenshot/evidence after latest deploy |
| [ ] | 4. Catalog exposure | Exactly the intended SKU or variant is exposed. | Resume here after package-data verification |
| [ ] | 5. Shipping config | Package, rate, markup, insurance, and return policies cover the test SKU. | Verify canonical SKU/box measurements, then complete final carton and quote validation |
| [ ] | 6. Listing push | One marketplace listing is created and mapped back to Echelon identity. |  |
| [ ] | 7. Order intake | One external marketplace order ingests once with correct vendor/store/line identity. |  |
| [ ] | 8. Wallet and acceptance | Funding/hold/debit behavior is traceable and order acceptance is idempotent. |  |
| [ ] | 9. OMS and WMS | Accepted order creates correct OMS and WMS records. |  |
| [ ] | 10. ShipStation | Shipment ingests back into WMS/OMS and inventory is recorded. |  |
| [ ] | 11. Tracking push | Marketplace customer-facing tracking is correct. |  |
| [ ] | 12. Split shipment | Multiple shipments preserve correct item-level tracking. Required only if in dogfood scope. |  |
| [ ] | 13. Notifications | Required vendor/internal notification events are visible and retryable. |  |
| [ ] | 14. Returns | Return policy, fault, inspection, and credit behavior are correct. Required only if in dogfood scope. |  |
| [ ] | 15. Audit and exit | Evidence trail is complete and final readiness reflects the run. |  |

## Phase 0: Membership Acquisition And Entitlement

Goal: prove a customer can become `.ops` entitled before dropship portal bootstrap, store connection, catalog selection, or wallet.

Echelon dropship entitlement is consumed from the Card Shellz membership tables. The portal email must resolve to a Card Shellz member, the selected subscription must be active/current or active/past_due grace, and the selected plan must include dropship access. If any of those are unclear, stop before marketplace setup.

Use this phase twice when possible:

- First pass: walk through the expected steps without creating the customer yet. Fill `Expected evidence / ID` with where the proof should come from.
- Second pass: execute with the real dogfood customer. Fill the actual evidence and leave failed rows unchecked.

### Path A: New Or `.core` Customer Directly To `.ops`

This path covers a brand-new customer and an existing `.core` customer who signs up directly for `.ops` without buying `.club` first.

| Done | ID | Check | Expected evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [x] | ACQ-DIRECT-01 | Choose the test email and confirm whether the starting state is new customer or existing `.core` customer. | `bseager6@gmail.com`; existing `.core` customer/member migrated from earlier `nwscards@gmail.com` test identity |  |
| [ ] | ACQ-DIRECT-02 | Confirm the customer-facing purchase path lets the customer select `.ops` directly. | Not tested | EX-001 |
| [ ] | ACQ-DIRECT-03 | Confirm checkout labels the purchased plan as `.ops` and does not require `.club` first. | Not tested | EX-001 |
| [ ] | ACQ-DIRECT-04 | Complete the purchase or upgrade with the test payment method. | Not tested; admin/manual upgrade used | EX-001 |
| [x] | ACQ-DIRECT-05 | Confirm the Card Shellz member email exactly matches the email used in the dropship portal. | `bseager6@gmail.com` used for portal login after email correction |  |
| [x] | ACQ-DIRECT-06 | Confirm the customer has one intended member identity. Existing `.core` customers should not create a duplicate member. | Member ID `42226465-6f54-4723-9204-057a5d38657e` | Reconfirm no duplicate after customer-facing checkout test |
| [x] | ACQ-DIRECT-07 | Confirm the active subscription points to the `.ops` plan. | Subscription `b92ddb72-422c-4c20-b02d-f9861b1c369f`; plan `14d8698f-09d8-4dea-8089-fa9a1ec0fb28` |  |
| [x] | ACQ-DIRECT-08 | Confirm the `.ops` plan is active and includes dropship access. | `.ops`, active/current, `includes_dropship=true` |  |

Path A pass criteria:

- A new or `.core` customer can buy `.ops` directly.
- The same Card Shellz member identity will be used by the dropship portal.
- The `.ops` plan is the entitlement source and includes dropship access.

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

Path B pass criteria:

- A `.club` customer can upgrade to `.ops`.
- The same Card Shellz member identity is preserved.
- The entitlement resolver selects the `.ops` subscription/plan after upgrade.

Phase pass criteria:

- At least one real dogfood customer path has a proven `.ops` entitlement.
- Direct `.ops` signup and `.club` to `.ops` upgrade have either passed or have explicit exceptions.
- Do not proceed to Phase 1 until the customer email has a known Card Shellz member, active/current `.ops` subscription, and dropship-enabled plan.

## Phase 1: Portal Bootstrap And Vendor Provisioning

Goal: prove the `.ops` customer can access the dropship portal and Echelon creates or syncs the vendor profile before store setup.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [x] | PORTAL-01 | Open `https://www.cardshellz.io`. | Customer portal reached at `/dropship-portal` |  |
| [x] | PORTAL-02 | Start setup or login with the same Card Shellz customer email from Phase 0. | `bseager6@gmail.com` |  |
| [x] | PORTAL-03 | Complete portal bootstrap or login. | Relogin worked after auth flow/password reset fixes |  |
| [x] | PORTAL-04 | Confirm the portal identity maps to the expected Card Shellz member. | Member ID `42226465-6f54-4723-9204-057a5d38657e` |  |
| [ ] | PORTAL-05 | Confirm Echelon created or synced the dropship vendor profile from that entitlement. | Vendor profile visible; exact numeric vendor ID still needs capture | Capture in admin/db before order test |
| [x] | PORTAL-06 | Confirm the vendor profile is not lapsed, suspended, or blocked. | Portal/admin showed active/onboarding-ready state | Reconfirm after latest deploy |
| [x] | PORTAL-07 | Confirm onboarding shows store connection as the next required step. | Onboarding advanced to store connection before eBay OAuth |  |

### Portal Entitlement Failure Checks

Run these negative checks once during dogfood setup. They prevent false positives before money and marketplace flows are involved.

| Done | ID | Check | Expected evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | PORTAL-FAIL-01 | Try portal setup with a non-member email and confirm access is denied. | Error/status: |  |
| [ ] | PORTAL-FAIL-02 | Try portal setup with a `.core` or `.club` member that has not upgraded to `.ops` and confirm access is denied. | Error/status: |  |
| [ ] | PORTAL-FAIL-03 | Confirm failed entitlement does not create an active dropship vendor. | Vendor lookup result: |  |
| [ ] | PORTAL-FAIL-04 | Confirm failed setup produces an operator-visible reason, not a generic crash. | Error code/message: |  |

Phase pass criteria:

- Portal access works for the `.ops` customer.
- Echelon provisions or syncs the dropship vendor profile.
- Failed entitlement cases are rejected cleanly.
- Do not proceed to Phase 2 until the vendor profile exists.

## Phase 2: Store Connection

Goal: prove the selected vendor and marketplace store are the intended dogfood target.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [x] | STORE-01 | Open `Store connections` in the dropship portal. | Store connection page opened during dogfood setup |  |
| [x] | STORE-02 | Confirm selected store connection belongs to the intended vendor. | `bseager6@gmail.com` / store connection UUID `9f2a4919-ed4a-4130-b2fc-62ce0f91f51b` observed | Capture exact numeric ID if needed |
| [x] | STORE-03 | Connect the intended marketplace store. | eBay connected |  |
| [x] | STORE-04 | Confirm external store identity matches the vendor account. | eBay store name `marzcards` after store-name ingestion/reauth | Do not accept `eBay connection 1` fallback as final evidence |
| [x] | STORE-05 | Confirm OAuth status is healthy. | Store showed connected / token status available | Reconfirm token expiry before listing push |
| [x] | STORE-06 | Confirm store status is connected. | Status `connected` |  |
| [x] | STORE-07 | Confirm setup status is ready. | Setup ready / launch ready shown after warehouse set | Reconfirm in Dogfood readiness |
| [x] | STORE-08 | Confirm order processing config is present. | Default warehouse ID `1` set for 20 Leonberg |  |
| [x] | STORE-09 | Confirm listing config is present if listing push is in scope. | Listing config active / draft-first observed | Reconfirm before listing push |

Phase pass criteria:

- Store connection is active and tied to the correct vendor.
- OAuth is valid.
- Listing and order processing configuration match the intended platform.

## Phase 3: Admin Readiness Gate

Goal: prove the internal admin control surface recognizes the vendor/store row before touching marketplace flows.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | READY-01 | Open Echelon internal admin at `/dropship`. | Screenshot / URL: |  |
| [ ] | READY-02 | Open `Dogfood readiness`. |  |  |
| [ ] | READY-03 | Confirm `Dropship OMS source` is ready. | Source status: |  |
| [ ] | READY-04 | If source is missing, run the source initialization action once. | Result: |  |
| [ ] | READY-05 | Confirm `System readiness` has no blockers. | Blockers count: |  |
| [ ] | READY-06 | Confirm launch gate is not blocked. | Gate status: looked ready enough before earlier UI fixes | Capture final after latest deploy |
| [ ] | READY-07 | Confirm one vendor/store row is ready for dogfood. | Vendor/store row should be `bseager6@gmail.com` / `marzcards` | Capture final after latest deploy |
| [ ] | READY-08 | Record any remaining warnings. | Warning IDs/count: |  |

Phase pass criteria:

- Internal source is ready.
- No launch-blocking readiness checks remain.
- One vendor/store row is ready for controlled testing.

## Phase 4: Catalog Exposure

Goal: expose exactly the intended catalog item to the vendor.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | CAT-01 | Open `Catalog exposure`. |  |  |
| [ ] | CAT-02 | Create a narrow include rule for one product, SKU, or variant. | Rule ID/scope: pending | Resume here after package-data verification |
| [ ] | CAT-03 | Do not use `Entire catalog` for the first dogfood pass. | Confirmed: pending | The UI allows broad exposure, but first test should stay narrow |
| [ ] | CAT-04 | Save the rule set. | Save result: |  |
| [ ] | CAT-05 | Use preview to confirm intended variant row is exposed. | Product/variant/SKU: | Verify visible/hidden filters after PR #751 |
| [ ] | CAT-06 | Confirm unrelated rows remain blocked. | Blocked count/sample: | Verify hidden-only filter shows expected unrelated rows |
| [ ] | CAT-07 | Confirm Echelon SKU/product variant identity is available for the row. | Product variant ID: |  |
| [ ] | CAT-08 | Confirm ATP is available and believable for the test quantity. | ATP value: |  |

Phase pass criteria:

- Exactly the intended product or variant is exposed.
- Unrelated catalog remains blocked.
- Echelon remains the source of truth for product, SKU, variant, and inventory identity.

## Phase 5: Shipping Configuration

Goal: prove the test SKU can calculate shipping and use the intended policy stack.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [x] | SHIPCFG-01 | Open `Shipping config`. | Shipping config page used during setup |  |
| [ ] | SHIPCFG-02 | Confirm package or carton data applies to the test SKU. | Catalog variant package editor is available through PR #796 | Enter/save weight and dimensions for the chosen test SKU and capture evidence |
| [x] | SHIPCFG-03 | Confirm box configuration exists. | Box created through admin UI | Full view/edit boxes UI still needed; see EX-008 |
| [ ] | SHIPCFG-03A | Confirm cartonizer v3 uses the SKU's canonical dimensions and can place the requested quantity inside the box without overlap. Confirm every carton is under 50 lb or a lower box-specific limit. | `max_units_per_package` is deprecated; NULL `max_weight_grams` uses the automatic 22,679 g handling ceiling | Quote one unit and a multi-unit quantity; record carton count, selected box, packed weight, and any blocker |
| [ ] | SHIPCFG-04 | Confirm rate table covers the test destination. | Zone/rate table created | Needs final quote validation |
| [x] | SHIPCFG-05 | Confirm markup policy is configured. | Markup policy created | Capture policy ID if needed |
| [x] | SHIPCFG-06 | Confirm insurance policy is configured. | Insurance policy created | Capture policy ID if needed |
| [x] | SHIPCFG-07 | Confirm return policy is configured. | Return policy created | Capture policy ID if needed |
| [ ] | SHIPCFG-08 | Record the quoted or expected shipping charge. | Amount: |  |

Phase pass criteria:

- Shipping quote path has canonical package data, verified 3D carton output, and rate coverage.
- Markup, insurance, and return policies are explicit.
- No hardcoded shipping behavior is needed for this test.

## Phase 6: Listing Push

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

## Phase 7: Order Intake

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

## Phase 8: Wallet And Acceptance

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

## Phase 9: OMS And WMS Handoff

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

## Phase 10: ShipStation Fulfillment

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

## Phase 11: Tracking Push

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

## Phase 12: Split Shipment Test

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

## Phase 13: Notifications

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

## Phase 14: Returns

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

## Phase 15: Audit And Exit

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
| EX-001 | P2 | Phase 0 / ACQ-DIRECT-02 to ACQ-DIRECT-04 | `bseager6@gmail.com` | Customer-facing `.ops` acquisition path not proven. Current dogfood customer was upgraded manually/admin-side. | Customer can choose `.ops` monthly/annual, checkout labels `.ops`, and subscription persists correctly. | Manual/admin upgrade created active `.ops`; real checkout path remains untested. | Test customer-facing `.ops` signup/upgrade; membership edit modal also needs billing interval and auto-renew controls. | Product/engineering | Open |
| EX-002 | P3 | Portal/admin theme |  | `.ops` color scheme is inconsistent in parts of the portal/admin. | Dropship portal/admin should use `.ops` purple design tokens consistently. | Purple applied in some areas, but full theme needs verification/update. | Audit dropship portal/admin styles and align to `.ops` palette. | Frontend | Open |
| EX-003 | P2 | Phase 1 / auth setup | PR #709, PR #715 | Login/setup flow was confusing for new/returning users; password reset was missing. | Eligible users see a clear setup vs login flow and can reset password. | Auth flow and password reset were added; relogin worked. | Verify on latest deploy with `bseager6@gmail.com` and an ineligible email. | Frontend/backend | Fixed / verify |
| EX-004 | P2 | Phase 2 / eBay OAuth | PR #723 | eBay connection/reconnect flow was unclear and did not provide explicit change-store behavior. | User can connect first store, refresh same account, change store via marketplace login, or disconnect. | Explicit connect/refresh/change/disconnect flow added. | Verify change-store opens eBay account selection and does not silently reuse the same account. | Backend/frontend | Fixed / verify |
| EX-005 | P2 | Phase 2 / store identity | PR #726, PR #728, PR #732 | Connected eBay store displayed as `eBay connection 1` instead of `marzcards`. | Portal/admin should show the actual connected store name. | eBay store name ingestion and pending-name fallback added; `marzcards` displayed after reauth. | Reconfirm after latest deploy and fresh eBay authorization. | Backend/frontend | Fixed / verify |
| EX-006 | P2 | Phase 4 / catalog exposure UX | PR #739 | Admin catalog exposure rules were confusing: include/exclude language, decision column, priority number, draft rule set. | Admin can expose/hide catalog with clear rule run order and modal-based add rule flow. | Catalog exposure redesigned with expose/hide language and reorderable rules. | Verify deployed UI before setting narrow SKU exposure. | Frontend/backend | Fixed / verify |
| EX-007 | P2 | Phase 4/5/8/14 / raw ID fields | PR #741 | Several admin modals required raw database IDs. | Operators select named records via dropdown/typeahead. | Selectors added for catalog targets, warehouses, wallet vendors/funding methods, and RMA references. | Verify deployed UI no longer asks for raw IDs in these flows. | Frontend/backend | Fixed / verify |
| EX-008 | P2 | Phase 5 / boxes UI |  | Shipping boxes can be created, but there is no complete UI to view/edit/manage boxes. | Admin can list, edit, archive, and inspect shipping boxes. | Existing UI only surfaces created boxes in limited places. | Build full boxes management UI. | Frontend/backend | Open |
| EX-009 | P2 | Phase 5 / cartonization | PR #909 | Current shipping setup was too simplistic for real product/box optimization. | Standalone cartonization engine chooses box(es), orientations, and packing based on ordered SKUs and dimensions; usable by dropship and other channels. | Shared cartonizer v3 performs non-overlapping 3D placement with six rotations, emits coordinates/orientations, co-packs compatible SKUs, splits on geometry or weight, and now powers dropship. Maximum units/package is ignored. Rider/void consolidation remains off until void dimensions are modeled. | Merge/deploy PR #909, then verify one-unit, multi-unit, mixed-SKU, long-item rejection, and packed-weight behavior in production. | Architecture/engineering | Fixed / verify |
| EX-010 | P2 | Phase 5 / box code structure |  | Box `code` is free-form and the meaning versus name is unclear. | Operational code has a documented or generated structure; name remains human-readable. | Free-form code exists today. | Define box code convention/generator and validation. | Product/engineering | Open |
| EX-011 | P2 | Phase 5 / product shipping profile model | PR #794, PR #796 | Current "package profile" concept is confusing and asks for variant IDs; SKU dimensions belong in catalog and should feed shipping. | Product/SKU dimensions live in catalog; shipping engine consumes them for box optimization. | Package tools moved to Catalog > Variants and per-SKU package line editor was added. | Verify deployed editor persists package data and confirm shipping/listing flows consume catalog variant package fields. | Architecture/engineering | Fixed / verify |
| EX-012 | P2 | Phase 5 / rate zones strategy |  | Shipping zones/rate tables may be the wrong long-term model if carrier API rating is available. | Decide between rate table by zone/weight/package dimensions versus carrier API rating. | For dogfood, static config is created enough to continue. | Document and choose long-term carrier/rate architecture. | Product/architecture | Open |
| EX-013 | P2 | Phase 4 / vendor catalog selection UX | PR #735, PR #737 | Vendor catalog selection UX mixed filters and selection actions; blank catalog was confusing when exposure was missing. | Filters narrow the table; selection happens in the table; product search is typeahead/search, not a dropdown. | Vendor catalog selection was redesigned. | Verify after narrow exposure that portal shows only the intended SKU. | Frontend/backend | Fixed / verify |
| EX-014 | P2 | Phase 4/5 / package editor UX | PR #794, PR #796 | Bulk package editor applied one set of measurements to every selected SKU. | Operator can edit weight/dimensions per SKU line item and save only changed rows. | Per-SKU package editor exists in Catalog > Variants. | Verify in production with the selected dogfood SKU before listing push. | Frontend/backend | Fixed / verify |
| EX-015 | P1 | Phase 6 / listing push proof | PR #785, commit `5b058adb`, commit `f7b2f741` | Shared listing connector/build path has been refactored, but no dogfood listing push has been proven in the test plan. | One eBay listing push creates or updates the external listing and records Echelon listing identity. | Not tested after connector/pricing/package changes. | Run one SKU listing push after catalog exposure, package data, and shipping readiness are verified. | Backend/frontend | Open |

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
