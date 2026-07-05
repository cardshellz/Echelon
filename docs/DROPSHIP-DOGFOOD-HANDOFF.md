# Dropship Dogfood Handoff

Last updated: 2026-07-05

Audience: Echelon and Card Shellz developers taking over dropship dogfood testing.

Primary docs:

- Authoritative build design: `DROPSHIP-V2-CONSOLIDATED-DESIGN.md`
- Working dogfood checklist: `docs/DROPSHIP-DOGFOOD-TEST-PLAN.md`
- Historical design context only: `DROPSHIP-DESIGN.md` and older phase briefs

## Current State

Dogfood is not complete. The run is paused before the first live marketplace listing/order test.

The current test customer path has proven enough to reach store setup and admin configuration, but it has not proven the full customer-facing `.ops` purchase path or the end-to-end marketplace order lifecycle.

Known dogfood identity:

| Item | Current value |
| --- | --- |
| Portal domain | `https://www.cardshellz.io/dropship-portal` |
| Echelon admin surface | `/dropship` |
| Test customer email | `bseager6@gmail.com` |
| Original test identity note | Earlier setup started from `nwscards@gmail.com`; current portal login evidence uses `bseager6@gmail.com` |
| Member ID | `42226465-6f54-4723-9204-057a5d38657e` |
| `.ops` plan ID | `14d8698f-09d8-4dea-8089-fa9a1ec0fb28` |
| Subscription ID | `b92ddb72-422c-4c20-b02d-f9861b1c369f` |
| Connected marketplace | eBay |
| Connected store display name | `marzcards` |
| Store connection UUID observed in UI | `9f2a4919-ed4a-4130-b2fc-62ce0f91f51b` |
| Default warehouse | Warehouse ID `1`, 20 Leonberg |

## What Is Proven

- `.ops` entitlement exists for the current dogfood customer through the active/current subscription noted above.
- Dropship portal login worked for `bseager6@gmail.com` after auth/password reset work.
- eBay OAuth/store connection worked and the expected store name is `marzcards`.
- Default warehouse was assigned for the connected store.
- Initial shipping configuration exists for a controlled single-SKU test, but the exact final quote still needs validation.
- Admin catalog exposure, shipping config, store connections, listing connector, eBay listing builder, and catalog package editor flows have received multiple fixes after the 2026-06-29 test-plan update.

## What Is Not Proven

These are still open and should not be treated as passed:

- Customer-facing `.ops` checkout/signup/upgrade path.
- Final dogfood readiness gate after the latest production deploy.
- Exact narrow catalog exposure for the selected test variant.
- Vendor portal shows only the intended exposed SKU.
- Variant package dimensions/weight have been entered and verified for the chosen test SKU.
- Shipping quote for the chosen SKU and destination.
- Listing push creates a marketplace listing and stores the external listing identity.
- Marketplace order intake.
- Wallet debit/hold/funding behavior.
- OMS/WMS creation and line identity.
- ShipStation fulfillment return path.
- Tracking push back to the marketplace.
- Notifications, returns, and audit exit evidence.

## Recent Relevant Mainline Changes Since The 2026-06-29 Test Plan

Use this as orientation only; always verify deployed production state before testing.

| PR / commit | Area | Why it matters for dogfood |
| --- | --- | --- |
| PR #746 / `36108b70` | Catalog exposure preview action | Simplified preview row action to one Expose/Hide action per row. |
| PR #748 / `4083bd3d` | Catalog exposure publish state | Clarified published vs unpublished exposure rule state. |
| PR #750 / `abcffd7d` | Catalog exposure pagination/labels | Added catalog preview pagination and clearer labels. |
| PR #751 / `4a66d4c3` | Catalog exposure filters | Added visible/hidden and active/inactive preview filter modes. |
| PR #758 / `105bd00f` | Shipping config | Removed non-useful search behavior from shipping config. |
| PR #762 / `56e304dd` | Shipping config | Organized shipping config into tabs. |
| PR #765 / `7e397e51` | Store connections admin | Simplified connected-store admin page. |
| PR #768 / `aaecf328` | Store connection readiness | Clarified store readiness columns. |
| PR #785 / `f1b2dbee` | eBay listing builder | Shared eBay listing payload construction across internal admin and dropship listing paths. |
| Commit `5b058adb` | Marketplace listing connectors | Refactored listing connectors toward shared marketplace paths. |
| Commit `f7b2f741` | Channel pricing | Uses retail cache as listing price source. |
| PR #794 / `b138d4c4` | Catalog package tools | Moved package bulk tools to Catalog > Variants. |
| PR #796 / `214c10ac` | Catalog package editor | Added per-SKU package line editor instead of same-value bulk modal. |

## Current Resume Point

Resume at Phase 3/4 of `docs/DROPSHIP-DOGFOOD-TEST-PLAN.md`, not at a later phase.

Do this in order:

1. Confirm production has the latest intended deploy from `main`.
2. Open Echelon `/dropship` and confirm Dogfood readiness for `bseager6@gmail.com` / `marzcards`.
3. In Catalog > Variants, use Package Editor to enter and save weight/dimensions for the chosen test SKU/variant.
4. In Dropship admin > Catalog exposure, publish a narrow variant-level exposure rule for exactly the chosen test variant.
5. Verify Catalog preview filters:
   - Visible only shows the chosen exposed row.
   - Hidden only shows unrelated rows.
   - Active/inactive filtering behaves as expected.
6. Open the customer-facing dropship portal and confirm the vendor catalog shows only the intended SKU.
7. Run one listing push for that SKU.
8. Confirm the listing job, external marketplace listing ID, and Echelon SKU/product variant mapping before placing any marketplace order.
9. Place one small marketplace test order only after listing identity and package/shipping readiness are proven.

## Hard Stops

Stop and fix before continuing if any of these occur:

- Dogfood readiness is blocked or unclear.
- Store connection is not `marzcards`.
- Package weight/dimensions are missing for the test SKU.
- Shipping quote cannot be produced for the test SKU.
- Catalog exposure shows more than the intended SKU in the vendor portal.
- Listing push succeeds externally but no Echelon listing identity is stored.
- Any wallet, reservation, OMS, WMS, or tracking state is ambiguous.

## Developer Notes

- The internal `Dropship OMS` source is a static Echelon source marker, not the vendor eBay/Shopify connection.
- Vendor store connections live under dropship store connection records and carry marketplace identity, OAuth/token state, warehouse assignment, and setup status.
- Package weight/dimensions should be managed from Catalog > Variants. The old product shipping profile mental model should not be used as the primary SKU package-data source.
- Listing push should use shared marketplace connector paths, not separate admin-only and dropship-only payload builders.
- The first dogfood listing should be one SKU/variant only. Do not start with entire-catalog exposure.

## Required Evidence To Capture

Add evidence back into `docs/DROPSHIP-DOGFOOD-TEST-PLAN.md` as each item passes:

- Production deploy/version/commit.
- Dogfood readiness screenshot or status counts.
- Test SKU, product ID, product variant ID.
- Package editor save result.
- Catalog exposure rule ID/scope.
- Portal catalog screenshot/evidence.
- Listing push job ID and final status.
- Marketplace listing ID.
- External order ID.
- Dropship intake ID.
- Wallet ledger IDs.
- OMS order ID and WMS order ID.
- ShipStation order/shipment IDs.
- Tracking push ID and marketplace customer-visible tracking evidence.
- Audit event IDs for critical steps.

## Ownership Recommendation

Assign one operator to drive the checklist and one engineer to trace failures. Do not let multiple people retry workers or marketplace pushes without recording current state first.
