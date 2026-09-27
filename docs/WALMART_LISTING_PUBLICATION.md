# Selective Walmart listing publication

## Operator flow

Open the connected Walmart channel. Listing Feed selects exact catalog variants; no catalog-wide selection is implied. Save a draft, set the shared channel markup or an item price override, complete Walmart's product-type fields, and review the resulting USD prices. Existing Walmart items retain the shared remote catalog mapping flow.

Publication consumes the reviewed draft atomically and shows a separate Activity record. The review expires after 15 minutes and is invalidated by changes to the selected catalog, price, account, or inventory destination. MP_ITEM and MP_ITEM_MATCH use separate persisted feed commands. Existing listings are not repriced by this initial-publication action.

New items carry explicitly zero inventory at the configured seller fulfillment center. Initial item setup still requires the inventory owner's active canonical destination, warehouse/source/model readiness, global publication control and exact SKU admission. Connection verification alone does not satisfy these conditions.

Once Walmart accepts an item, Echelon verifies its SKU, price, lifecycle and product identity, then links it through Channels. Review stock publishing selects exact verified variants. Inventory Planning requires sealed mappings/source definitions, previews the canonical policy quantities and queues the reviewed selection. A queued stock update is not evidence of provider readback. Removing an included SKU requires an existing hold and a current verified zero before exclusion.

## Ownership and contracts

| Owner | Responsibilities | Primary code |
| --- | --- | --- |
| Channels | Catalog projection, shared price rules, verified listing/feed identity | `server/modules/channels/channel-listing-catalog.repository.ts`, `channel-catalog.service.ts` |
| Marketplace Listings | Revisioned drafts, immutable reviews, item claims, durable operations, worker leases, per-item outcomes | `server/modules/marketplace-listings/application/listing-publication.service.ts`, `infrastructure/pg-listing-publication.repository.ts` |
| Walmart adapter | Official product schemas, identifier validation, MP_ITEM/MP_ITEM_MATCH translation, feed status and item reads | `server/modules/channels/adapters/walmart/walmart-listing.provider.ts` |
| Inventory Planning | Explicit target membership, zero setup admission, supply/policy evaluation, stock outbox and readback | `inventory-publication-membership.service.ts`, `quantity-publication-admission.repository.ts` |

The composition root is `server/listing-publication.composition.ts`. HTTP controllers perform permission/input handling and delegate commands. Channel viewing/editing governs listing work; `inventory_planning.activate` is required to apply stock membership. No controller writes database tables.

Prices use safe integer cents with integer half-up markup rounding. Explicit channel prices must be USD. Catalog/retail base amounts follow the existing shared pricing resolver's cents convention; it does not perform currency conversion. Verify the source catalog's USD denomination during account commissioning. A reviewed per-item USD override is available.

## Failure behavior

- Command replay returns the original operation before rechecking mutable state. Concurrent item claims permit one owner; a new claim requires a definitively failed predecessor and a fresh review.
- Each batch retains its own correlation UUID and feed receipt. The worker renews and checks its lease through provider preflight and immediately before the feed HTTP request. Provider I/O runs outside database transactions.
- Known no-request failures and recorded terminal rejections require a fresh review before retry. Timeouts, ambiguous responses and lost receipts cannot trigger blind feed POST retries.
- Feed completion does not imply item completion. Pending review and missing item details stay pollable; successful items can finish independently of rejected items.
- A missing submission receipt remains a reconciliation exception even if the same SKU and price are observed. This release does not provide an operator action to attach an unproven receipt or force replay.
- A product-ID disagreement blocks mapping. The Channels owner checks the expected product identity again during its own provider read.
- Membership, target revision, outbox replacement and audit commit together. Excluded variants produce no publication rows. Existing targets retain whole-product semantics; new Walmart targets begin explicitly empty.

## Rollout and verification limits

Apply migrations `0707_channel_listing_publication.sql`, `0708_inventory_publication_membership.sql`, then `0709_walmart_quantity_admission.sql` before starting the new worker. Migration 0708 also corrects the existing target guard so a live destination can retain its state while advancing its revision; identity and activation-transition restrictions remain enforced.

`LISTING_PUBLICATION_DISABLED=true` stops this worker; the existing global scheduler switch also applies. Stopping the worker is not a request to zero existing provider inventory. Use the established Inventory Planning hold/stop flow for that operation.

Migrations add no selected products, activate no inventory authority and submit no provider request. Production migration execution, global inventory cutover, permission provisioning, live Walmart listing acceptance and stock readback must be verified separately. No production operation is authorized by this implementation document.

An active canonical Walmart publication target is a rollout prerequisite, including for zero-stock item setup. The existing destination-creation flow creates a disabled target; definition Review/Apply alone does not activate it. A target created after the initial canonical cutover has no existing first-activation workflow (resume requires an audited prior stop). Such an account needs a separately reviewed Inventory Planning activation path before this publisher can operate. Do not bypass that owner or describe connection verification as publication readiness.

New PostgreSQL coverage is included in the CI manifest: listing persistence/concurrency, catalog projection/pricing and Walmart membership/admission. Tests execute migrations against disposable PostgreSQL and mock external Walmart calls. Browser tests cover desktop/mobile selection, drafts, pricing, requirements, review, activity, failed-item editing and stock membership. They do not establish live Walmart readiness.

## Local validation record (2026-09-27)

- Production source and both server/client test TypeScript checks pass. The production build passes; its existing large-bundle warning remains.
- The three new PostgreSQL suites pass together: 29 tests, with real PostgreSQL 17 transactions and migrations. The inventory regression run also covers existing publication admission and request evidence.
- Walmart workspace browser checks pass on desktop and mobile: 28 tests. Publication UI unit checks pass: 12 tests.
- Final publication service checks pass: 35 tests, including mixed-feed continuation after provider outages and per-batch invalidation of stale reviews.
- The broad unit run passes 15,960 tests, skips 39, and fails 14. One failure is this feature's pending writer-ratchet registration; see `WALMART_WRITER_REGISTRATION_REVIEW.md`. Eleven failures are literal-LF assertions in six unchanged Dropship migration suites on a CRLF checkout. They reproduce unchanged from the base; all 36 tests in those suites pass when only the reads are normalized in memory. Two returns HTTP tests selected a restricted ephemeral port; the unchanged returns suite subsequently passes all 76 tests.

The writer-ratchet baseline remains unchanged pending the specific owner-registration approval. Local checks do not establish CI results, production schema state, account eligibility, or live listing/stock acceptance.
