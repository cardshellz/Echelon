# Dropship and Shipping Weekly Handoff - 2026-07-19

This is the current turnover checkpoint for continuing the Echelon dropship dogfood and shared shipping-engine work on another computer. It records the decisions, merged work, production snapshot, known gaps, and exact resume sequence from the working session that ended July 19, 2026.

This file supersedes the status and next-step sections in the July 12 laptop handoff and the July 16 shipping handoff. Those documents remain useful for history and deeper design detail, but their production counts and build-board states are not current.

## One-minute status

- Current GitHub `main` when this handoff was prepared: `1185302b` (`Merge pull request #958 from cardshellz/agent/channel-order-intake-ledger`).
- Current Heroku release: `v2420`, deployed from `1185302b` on July 19, 2026.
- Shared service-level pricing PR #952 is merged and deployed. It first reached Heroku in release `v2415` at merge commit `fed75315`.
- Migration `0590_shipping_service_level_pricing.sql` is applied in production.
- Production has two active pricing programs:
  - `shopify-retail-default`, assigned to Shopify customer checkout and internal customer checkout.
  - `dropship-vendor-default`, assigned to dropship vendor fulfillment charges.
- Production has four Card Shellz-owned shipping options:
  - Standard Shipping: active, parcel, 3-7 business days.
  - Priority Shipping: inactive future option, parcel, 2-3 business days.
  - Overnight Shipping: inactive future option, parcel, 1 business day.
  - Pallet Freight: inactive future option, freight.
- Production currently has **zero rows in `shipping.rate_tables`**. The pricing-program framework is deployed, but no shared Standard rate revision has been created or activated.
- The 49-state, four-band, 196-row Standard rate table was a local interactive preview only. It was not written to production.
- The existing dropship quote path still uses `CachedRateTableDropshipShippingRateProvider` and the legacy dropship rate configuration. Do not switch it directly to the shared engine. First create shared dropship rates, dual-run old and new quotes, and prove parity.
- Dogfood portal login and eBay connection are working for the existing test identity. The controlled dogfood run remains paused before final readiness evidence, narrow catalog exposure, package-data verification, listing push, and marketplace order intake.

## Read in this order

1. This file.
2. `docs/DROPSHIP-DOGFOOD-TEST-PLAN.md` for the phase-by-phase operator checklist and evidence fields.
3. `docs/SHIPPING-ENGINE-HANDOFF.md` for the two-plane architecture and runtime invariants.
4. `docs/SHIPPING-ENGINE-DESIGN.md` for the design record.
5. `docs/SHIPPING-RATE-MANAGEMENT-UX-DESIGN-SPEC.md` for the pricing-program admin experience.
6. `docs/DROPSHIP-DEV-HANDOFF-2026-07-09.md` and `docs/DROPSHIP-LAPTOP-HANDOFF-2026-07-12.md` for historical decisions and prior production evidence.

Do not treat counts or next-step text in an older handoff as current without re-querying production.

## Locked product and architecture decisions

### One shared rating engine, independently priced programs

The reusable abstraction is `shipping.*`, not `dropship.*`. Shopify checkout, future first-party websites, and dropship vendor fulfillment use the same rating engine while resolving independently assigned pricing programs.

Sharing the engine does not mean sharing prices:

| Flow | Buyer/vendor price owner | Current intended behavior |
| --- | --- | --- |
| Shopify checkout | Shared shipping engine | Shopify retail pricing program |
| First-party/internal checkout | Shared shipping engine | Explicit internal assignment, currently the Shopify retail program |
| eBay buyer checkout | eBay channel adapter | eBay fulfillment/business policies remain buyer-facing authority |
| Dropship vendor fulfillment | Shared shipping engine after parity cutover | Dropship vendor pricing program, followed by dropship insurance, handling, snapshot, and wallet policy |

An eBay-sourced dropship order still uses the dropship vendor program for the backend amount charged to the vendor. eBay controls only what the marketplace buyer sees.

### Shipping options are not carrier methods

Pricing is attached to Card Shellz-owned shipping options such as Standard, Priority, Overnight, and Pallet Freight. Carrier-owned service codes such as USPS Ground Advantage are not pricing identities and must not be free-form inputs in the rate-table flow.

Provider method discovery, account-specific eligibility, and enforcement are intentionally deferred. Later, connected carrier/provider accounts will populate a canonical method catalog and map eligible methods to each service level. The fulfillment engine must then prevent selection of a method that cannot satisfy the sold promise.

For the current rollout:

- Standard Shipping is the only supported live option.
- Priority, Overnight, and Pallet Freight remain correctly modeled but inactive.
- No provider-method assignment is required to create or activate Standard prices.

### Geography is direct and operator-readable

Operators price by destination state with optional ZIP-prefix overrides. The ordinary UI does not require operators to understand or maintain abstract shipping zones.

Rules:

- Statewide rows are the default.
- A matching ZIP prefix is a more-specific override.
- Warehouse-specific rows may override all-warehouse rows.
- Draft validation must expose missing coverage, overlaps, and invalid bands before activation.
- CSV remains an optional accelerator, not the primary interface.

### Weight behavior favors completing the sale

Echelon `catalog.product_variants.weight_grams` is canonical for the shared engine. Shopify request weight is a warned transition fallback. If both are missing, the line contributes zero, the quote snapshot records a warning, and checkout is deliberately underquoted rather than blocked. An all-missing cart uses the minimum rate-band floor.

Variant dimensions are not required for the weight-only shipping rollout.

### Cartonization is standalone and optional

Cartonization belongs in `server/modules/cartonization`, not dropship. It is reusable by every physical WMS order and by channel adapters.

The current cartonizer:

- performs real non-overlapping 3D placement;
- tries all six orthogonal rotations;
- rejects long items that cannot physically fit even when aggregate volume would fit;
- splits cartons based on geometry or packed weight;
- persists coordinates and orientations in test/shadow pack plans;
- uses an automatic 22,679 g handling ceiling, just under 50 lb, unless a box has a lower structural limit;
- ignores legacy `max_units_per_package` as a cartonization input.

It is not a required production WMS path. Explicit plan generation and opt-in shadow observation are allowed; neither may block fulfillment, change order status, or route an order to exception. Shipping-engine launch does not wait for cartonization.

### USDC remains planned but optional

USDC is not a launch-readiness requirement. Stripe card/ACH and auto-reload can satisfy wallet readiness.

Deferral does not discard the correct foundations: funding-method identity, atomic-unit ledger handling, idempotency, auditability, and future provider/custody/settlement boundaries remain part of the design. Do not add fake provider verification simply to make USDC appear ready.

## Merged work from this workflow

### Portal, eBay, catalog, and setup UX foundations

These earlier changes were exercised during this dogfood workflow and remain relevant to the current test identity:

| PR | Result |
| --- | --- |
| [#703](https://github.com/cardshellz/Echelon/pull/703) | Fixed dropship eBay OAuth callback routing. |
| [#705](https://github.com/cardshellz/Echelon/pull/705) | Replaced default-warehouse raw ID entry with a named warehouse selector and improved shipping setup controls. |
| [#707](https://github.com/cardshellz/Echelon/pull/707) | Changed packaging setup to operator-facing inches and pounds. |
| [#709](https://github.com/cardshellz/Echelon/pull/709) | Updated product shipping setup and the new/returning portal authentication flow. |
| [#715](https://github.com/cardshellz/Echelon/pull/715) | Added password reset, removed non-useful login cards, applied `.ops` purple, and polished auth copy. |
| [#718](https://github.com/cardshellz/Echelon/pull/718) | Fixed the initial eBay reconnect flow. |
| [#723](https://github.com/cardshellz/Echelon/pull/723) | Added explicit connect, refresh, change-store, and disconnect actions. |
| [#726](https://github.com/cardshellz/Echelon/pull/726) | Ingested and displayed the connected eBay store name. |
| [#732](https://github.com/cardshellz/Echelon/pull/732) | Clarified pending/fallback store identity while the real name is being resolved. |
| [#735](https://github.com/cardshellz/Echelon/pull/735) | Redesigned vendor catalog selection so filters narrow the table and selection happens on rows. |
| [#739](https://github.com/cardshellz/Echelon/pull/739) | Redesigned admin catalog exposure around clear expose/hide rules and ordered execution. |
| [#741](https://github.com/cardshellz/Echelon/pull/741) | Replaced raw database-ID inputs with named selectors/typeaheads in the identified dropship admin flows. |
| [#748](https://github.com/cardshellz/Echelon/pull/748) | Clarified published versus unpublished catalog exposure state. |

The intended login state model is:

- eligible + new: verify email, then create credentials;
- eligible + returning: password, passkey, or email-code login;
- ineligible: no account setup, explain that `.ops` is required, and offer a signup link;
- eligibility lookup failure: retryable error, not an ineligible upsell state.

The temporary upsell target is `https://www.cardshellz.com/pages/club`. A dedicated `.ops` landing page is still required before launch.

eBay credentials must be entered only in eBay's authorization portal. Echelon should open OAuth, receive the authorized account identity, and show the actual store username. It should never collect an eBay password itself.

### Package authority and cartonization

| PR | Result |
| --- | --- |
| [#903](https://github.com/cardshellz/Echelon/pull/903) | Made catalog variants the package weight/dimension authority. Dropship package profiles are optional overrides, not physical-data authority. |
| [#908](https://github.com/cardshellz/Echelon/pull/908) | Made USDC optional for launch readiness. |
| [#909](https://github.com/cardshellz/Echelon/pull/909) | Added shared 3D cartonization for dropship. |
| [#913](https://github.com/cardshellz/Echelon/pull/913) | Fixed production startup after the cartonizer deployment. |
| [#915](https://github.com/cardshellz/Echelon/pull/915) | Established standalone cartonization with a non-blocking WMS shadow rollout. |

### Shared shipping pricing architecture

| PR | Result |
| --- | --- |
| [#916](https://github.com/cardshellz/Echelon/pull/916) | Decoupled checkout shipping rates from cartonization, preferred Echelon weights, allowed warned underquote for missing weight, and established channel/purpose quote contracts. |
| [#919](https://github.com/cardshellz/Echelon/pull/919) | Added shared rate books and deterministic channel/warehouse assignments. |
| [#923](https://github.com/cardshellz/Echelon/pull/923) | Added direct state pricing with optional ZIP-prefix overrides. |
| [#928](https://github.com/cardshellz/Echelon/pull/928) | Added draft-first rate-table lifecycle, review, explicit activation, supersession, and detail UI. |
| [#934](https://github.com/cardshellz/Echelon/pull/934) | Discarded unused legacy drafts and rebuilt rate tables around direct geography instead of carrying an unnecessary compatibility layer. |
| [#937](https://github.com/cardshellz/Echelon/pull/937) | Added the independently assigned dropship vendor rate book. |
| [#952](https://github.com/cardshellz/Echelon/pull/952) | Built pricing-program administration, Card Shellz-owned service levels, Standard-only rollout controls, visual destination/rate editing, ZIP overrides, CSV-assisted import, review/activation, and pallet-freight schema support. |

PR #952 validation before merge:

- 48 focused Vitest tests passed.
- Migration-prefix collision guard passed.
- Writer-ratchet guard passed.
- `npm run check` passed.
- `npm run build` passed.
- A local browser walkthrough completed draft creation, 49-state destination assignment, four weight bands, 196 generated rows, review, activation, and active coverage display.

## Production snapshot - queried July 19, 2026

### Deployment

- Heroku app: `cardshellz-echelon`.
- Current release: `v2420`.
- Current deployed commit: `1185302b`.
- PR #952 deployment: release `v2415`, merge commit `fed75315`.
- Migration `0590_shipping_service_level_pricing.sql`: present in `_migrations`.

### Service levels

| Code | Display | Mode | Active | Promise |
| --- | --- | --- | --- | --- |
| `standard` | Standard Shipping | parcel | yes | 3-7 business days |
| `expedited` | Priority Shipping | parcel | no | 2-3 business days |
| `express` | Overnight Shipping | parcel | no | 1 business day |
| `pallet_freight` | Pallet Freight | freight | no | unset |

### Pricing-program assignments

| Program | Channel | Purpose | Warehouse scope |
| --- | --- | --- | --- |
| `shopify-retail-default` | Shopify | customer checkout | all warehouses |
| `shopify-retail-default` | internal | customer checkout | all warehouses |
| `dropship-vendor-default` | dropship | vendor fulfillment charge | all warehouses |

Both programs are active. Production has no `shipping.rate_tables` rows, so neither program currently has a live shared-engine price revision.

### Runtime cutover state

The shared engine and admin model are deployed, but the live dropship quote factory still constructs `CachedRateTableDropshipShippingRateProvider` from:

- `server/modules/dropship/infrastructure/dropship-shipping-quote.factory.ts`
- `server/modules/dropship/infrastructure/dropship-cached-rate-table.provider.ts`

The shared runtime service is in:

- `server/modules/shipping-engine/application/shipment-quote.service.ts`
- `server/modules/shipping-engine/application/rate-quote.service.ts`
- `server/modules/shipping-engine/application/shipping-rate-provider.ts`

This separation is intentional for now. Build a dual-run comparison before changing the dropship factory.

## Dogfood identity and completed evidence

Use this existing controlled target unless the owner explicitly chooses a new run:

| Item | Value |
| --- | --- |
| Portal email | `bseager6@gmail.com` |
| Card Shellz member ID | `42226465-6f54-4723-9204-057a5d38657e` |
| Active `.ops` subscription | `b92ddb72-422c-4c20-b02d-f9861b1c369f` |
| `.ops` plan ID | `14d8698f-09d8-4dea-8089-fa9a1ec0fb28` |
| Connected eBay store | `marzcards` |
| Store connection UUID | `9f2a4919-ed4a-4130-b2fc-62ce0f91f51b` |
| Default warehouse | ID `1`, 20 Leonberg ship-from location |

Confirmed:

- Active/current `.ops` entitlement exists and `includes_dropship=true`.
- No duplicate member was observed during the manual upgrade check.
- Portal setup/login and later relogin worked after the auth/password-reset fixes.
- eBay OAuth completed and the portal showed `marzcards` rather than `eBay connection 1`.
- The store reached setup-ready after default warehouse assignment.
- A box and the required legacy dropship shipping policies were created sufficiently to continue controlled testing.

Still unproven:

- Real customer-facing `.ops` purchase or upgrade, including monthly versus annual selection and auto-renew behavior.
- Negative portal entitlement cases.
- Final admin dogfood-readiness screenshot after the latest deployment.
- Canonical package data for the selected first dogfood SKU.
- Narrow exposure of exactly one SKU/variant.
- Listing push, marketplace purchase, intake, wallet accounting, OMS/WMS handoff, ShipStation fulfillment, tracking push, notifications, and return flow.

## Open issues and deferred work

### Blocks or gates the next controlled run

1. Select the first dogfood SKU and save positive weight plus length, width, and height in Catalog > Variants.
2. Confirm the chosen box has accurate inner dimensions and tare.
3. Capture final Dogfood readiness evidence with `bseager6@gmail.com` and `marzcards`.
4. Publish a narrow catalog exposure rule for only the chosen SKU/variant.
5. Create real production Standard rates for the dropship vendor pricing program before shared-engine quote comparison.
6. Prove one-unit and representative multi-unit quote behavior before listing push.

### Product and UX backlog

- Membership admin edit needs billing interval and auto-renew controls. The customer-facing `.ops` checkout/upgrade path still needs a real test.
- Build a dedicated `.ops` landing page; the current Club URL is only a temporary upsell destination.
- Audit `.ops` purple across the full portal and related admin surfaces.
- Redesign the vendor dashboard. The current signed-in/security cards do not provide useful operating information. The post-launch dashboard should prioritize orders, spend/margin, listings, wallet, and actionable exceptions.
- Build complete box catalog management: list, view, edit, archive, warehouse stock, and inspection detail.
- Define/generate a box-code convention. `code` should be a stable operational identifier; `name` remains human-readable.
- Finish visual verification of product-line -> category -> product typeahead filtering and row-level catalog selection.
- Verify the reordered exposure-rule UI and named selectors on the deployed admin surface.

### Correctly deferred architecture

- Provider/carrier account connections and canonical method discovery.
- Service-level-to-carrier-method eligibility and fulfillment enforcement.
- Priority and Overnight activation.
- Pallet Freight pricing and fulfillment activation.
- USDC provider/custody/settlement integration.
- Mandatory WMS cartonization.
- Full box-fit optimization measurement and enforcement.
- ShipStation replacement.

## Exact continuation sequence

### A. Bootstrap the other computer

```powershell
git clone https://github.com/cardshellz/Echelon.git
cd Echelon
git switch main
git pull --ff-only origin main
git log -1 --oneline
npm ci
```

For an existing clone:

```powershell
git fetch origin
git switch main
git pull --ff-only origin main
git status -sb
git log -1 --oneline
```

Expected baseline when this file was written: `1185302b` or a descendant. Never resume work on a merged feature branch.

### B. Reconfirm production before changing anything

1. Run `heroku releases --app cardshellz-echelon --num 8`.
2. Confirm the deployed commit is `1185302b` or a descendant.
3. Open Echelon Shipping > Settings > Pricing programs.
4. Confirm Shopify retail default and Dropship vendor fulfillment are both visible.
5. Open Dropship vendor fulfillment and confirm Standard Shipping is the only available active option.
6. Confirm whether a rate revision now exists. At handoff time, production had none.

### C. Configure the first real dropship Standard rate revision

Do not invent prices. Obtain the owner-approved dropship Standard rate schedule first.

1. Open Dropship vendor fulfillment.
2. Choose Standard Shipping.
3. Create a draft revision.
4. Add named destination groups using bulk state selection.
5. Enter contiguous, non-overlapping shipment-weight bands in pounds and charges in USD.
6. Add ZIP-prefix overrides only where an actual business exception exists.
7. Review coverage, gaps, overlaps, warehouse scope, and rate changes.
8. Save the draft and capture evidence.
9. Activate only after the owner confirms the prices and coverage.
10. Re-query production and record the new table ID, row count, status, state coverage, ZIP override count, and weight coverage.

Do not create Priority, Overnight, or Pallet Freight rates in this slice.

### D. Build dropship dual-run parity before cutover

The next engineering PR after real rates exist should compare, not replace:

1. Keep the current `CachedRateTableDropshipShippingRateProvider` as the charged result.
2. Add a shared-engine dropship adapter using pricing channel `dropship` and purpose `vendor_fulfillment_charge`.
3. For controlled quotes, compute both legacy and shared results from the same order, destination, warehouse, and canonical Echelon weight.
4. Persist or log a structured comparison with old amount, new amount, selected band/table, warnings, and mismatch reason.
5. Do not double-write wallet, quote snapshot, or idempotency records.
6. Do not expose the shared result to the vendor until parity criteria are agreed and met.
7. Test state default, ZIP override, missing-weight underquote, boundary weights, no-coverage, and warehouse override behavior.
8. Switch the factory only in a separate reviewed cutover PR.

### E. Resume the dogfood checklist in parallel

Resume `docs/DROPSHIP-DOGFOOD-TEST-PLAN.md` at Phases 3 through 5:

1. Capture final admin Dogfood readiness evidence.
2. Choose one test SKU.
3. Save canonical package data in Catalog > Variants.
4. Confirm one intended box can physically contain one unit.
5. Create and save a narrow exposure rule for only the test SKU/variant.
6. Confirm the vendor catalog shows that SKU and unrelated rows remain hidden.
7. Quote one unit and a representative multi-unit quantity.
8. Record selected rate source, charge, carton result, warnings, and IDs.
9. Stop before listing push if any readiness, identity, package, rate, or wallet state is ambiguous.
10. Once clean, continue Phase 6 with one eBay listing push and capture every external/internal ID.

The shared-engine rollout and the dogfood order can progress independently while legacy dropship rates remain authoritative. Do not silently mix the two paths.

## Guardrails that repeatedly mattered

- Fetch current `origin/main` before choosing a migration number. Duplicate numeric prefixes abort deployment.
- Run `server/__tests__/unit/migration-prefix-collision.test.ts` before every migration PR.
- New table writers require a reviewed update to `scripts/writer-ratchet/baseline.json`.
- Do not regenerate the writer baseline wholesale on Windows.
- Draft tables are inert. Runtime reads active, effective revisions only.
- Do not use production `DATABASE_URL` for integration tests.
- Never put eBay credentials into Echelon; OAuth belongs on eBay.
- Do not accept fallback labels such as `eBay connection 1` as store-identity evidence.
- Do not use raw database IDs when a named selector or typeahead can resolve the record.
- Do not make dimensions or cartonization a checkout prerequisite.
- Do not activate future service levels merely because their schema rows exist.
- Do not infer production rate coverage from the local 49-state preview.
- Preserve exact money, idempotency, audit, transaction, and concurrency requirements in `AGENTS.md`.

## Pickup prompt for Codex

> Continue the Echelon dropship and shared shipping-engine workflow. First read `docs/DROPSHIP-SHIPPING-WEEKLY-HANDOFF-2026-07-19.md`, then the documents in its read order. Fetch current `origin/main`, confirm the exact current branch/commit and Heroku release, and do not reuse a merged PR branch. Re-query production rather than trusting historical counts. Production had active Shopify and dropship pricing programs but zero shared rate tables at the handoff. The next shipping task is to configure owner-approved Dropship Standard rates, then build a non-charging dual-run comparison between the legacy dropship provider and the shared engine. In parallel, resume dogfood at Phases 3-5 with final readiness evidence, one SKU's canonical package data, and narrow exposure. Do not cut over dropship pricing or make cartonization mandatory without separate measured approval.
