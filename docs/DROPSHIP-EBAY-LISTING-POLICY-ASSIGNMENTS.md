# eBay listing policy assignments

## Authority and inheritance

- Card Shellz fulfillment capabilities remain operational limits, not vendor shipping prices.
- The connected store supplies reusable eBay fulfillment, return, and payment policies.
- Store defaults are optional fallbacks for each policy field. Each store/product-variant assignment can override any of the three independently.
- Listing-policy search and the effective-fulfillment-policy filter organize the existing assignments. They do not create another group or routing authority.
- Editing an assignment does not publish a listing or edit the policy inside eBay. The existing preview, push validation, wallet/activation gates, and push MFA remain in place.

The policy resolver is `applyEbayListingPolicyOverride` in `server/modules/dropship/application/dropship-listing-preview-service.ts`. The preview regression tests include complete per-listing choices with empty store policy defaults. A store listing configuration and other marketplace prerequisites are still required; this does not bypass them.

## Ground Advantage evidence

A read-only eBay production `GeteBayDetails` response on 2026-09-04 (site 0, compatibility level 1475, `ShippingServiceDetails`, Ack Success) returned:

| Description | ShippingService | ShippingServiceID | ValidForSellingFlow |
| --- | --- | --- | --- |
| USPS Ground Advantage | USPSParcel | 8 | true |
| US Postal Service Ground | USPSGround | 17 | false |

Ground Advantage metadata had detail version 1024 and update time `2026-07-20T19:26:46.000Z`. The production fulfillment-policy response also used `USPSParcel` for the vendor's Ground Advantage policy. Sanitized service metadata is retained in `server/modules/dropship/__tests__/fixtures/ebay-us-ground-advantage-evidence.ts`.

`mapRoutedServicesToEbay` now maps configured ShipStation `usps_ground_advantage` methods to `USPSParcel`. It does not alias USPS First Class, eBay Standard Envelope, UPS SurePost, or the non-sellable `USPSGround` identity. The domain compatibility validator still requires every offered service to be backed by allowed routing evidence.

## Bulk-edit contract

`PUT /api/dropship/ebay/listing-policy-overrides/bulk` requires the existing authenticated dropship session and a connected eBay store owned by that vendor. It accepts 1–500 distinct product variants, each with three explicit nullable policy choices and its expected assignment revision, plus one idempotency key.

- UI **Leave unchanged** copies that row's existing choice into the request. Explicit **Store default** sends null. No patch is inferred on the server.
- The service validates all explicit policy IDs against the store's current options before requesting persistence.
- The repository locks the request key and store, then writes all assignment revisions and before/after audit events in one transaction. Any missing variant, stale current revision, or persistence failure rolls back the whole batch.
- The first sorted target reserves the original key; subsequent targets have deterministic child keys. Every revision carries the hash of the entire sorted request. Reusing a key with changed targets, values, or expected revisions conflicts.
- A complete replay returns immutable revision snapshots without rewriting current assignments. Partial replay evidence fails closed. The UI refreshes current assignments after a successful response instead of installing an old replay snapshot into the cache.
- Lost-response retries reuse the same key. A confirmed save followed by a failed refresh retries only the refresh.

The existing assignment tables and ownership boundaries are reused. No new database migration is required.

## Explicit saves and synchronized defaults

The store-default save and listing-policy view have separate React Query caches. Previously,
`EbayListingSetupPanel.saveSetup` updated only the setup cache; the sibling assignment
response still contained its old `defaults` until another fetch or browser reload.

`synchronizeSavedEbayListingSetup` now cancels superseded reads, publishes the confirmed
selection and policy options into both caches, preserves assignment IDs/revisions, and
refetches the current store's policy view. Saving clears the old listing preview. A failed
refetch is reported as **saved, refresh failed**, with a refresh-only retry; it does not
repeat the confirmed write. The setup panel is keyed by store connection to isolate
draft and pending state when switching stores.

Listing rows show effective policy names and **Store default** or **Override** as the
source. **Edit policies** opens the same revision-safe editor used for bulk assignment.
Dropdown changes remain local until **Save policies**; **Cancel** does not submit them.
Inheriting a policy still sends null, not a copied default ID. The panel also provides
**Refresh policies** with explicit loading and error states.

## Scale boundary and follow-on read architecture

The table mounts at most 50 rows per page, instead of three dropdowns for every selected
listing. Checking the header selects only the current page; the checked count includes
other pages and filtered-out rows. Bulk saves retain the 500-listing transaction bound.

This is a rendering improvement, **not a claim of server-side scalability**:

- `fetchAllSelectedCatalogRows` in `client/src/pages/dropship/DropshipPortalCatalog.tsx`
  still preloads all selected rows using sequential 200-row page requests.
- `DropshipSelectionAtpService.previewCatalog` evaluates catalog candidates before
  slicing a page. Repeated page requests therefore repeat broad evaluation work.
- `DropshipEbayListingPolicyOverrideService.listForMember` and the repository's
  `listAssignmentsWithClient` still load all assignments for the store.

For genuinely large catalogs, add a dedicated paginated listing-policy read endpoint:
bounded rows, deterministic ordering, server-side search/effective-policy/status filters,
and counts. Fetch only that page's assignments and keep shared defaults/options separate.
Policy editing should not require recomputing ATP for every selected catalog page.
Keep inheritance in one resolver; do not copy defaults into thousands of assignments.

An **all matching listings** action beyond 500 needs an explicit target snapshot and an
audited background job with progress, retry, and partial-failure semantics. Do not silently
split an operation described as atomic into independently committed batches. Saved filters
or policy-group views can organize targets without creating another policy authority.

## Execution gap: not changed here

Do not equate valid policy assignment with end-to-end buyer-service enforcement:

1. `buildEbayDropshipOrderIntakeInput` in `infrastructure/dropship-ebay-order-intake.mapper.ts` retains the raw eBay order but does not include the buyer-selected shipping service in its normalized payload.
2. `createOmsOrderWithClient` in `infrastructure/dropship-order-acceptance.repository.ts` retains that raw marketplace payload but does not populate OMS shipping-method fields.
3. The WMS `pushShipment` payload in `server/modules/oms/shipstation.service.ts` supplies address, items, totals, and store/warehouse routing, but not an exact requested carrier/service choice.

Follow-on work must capture the actual provider shipping-selection fields, preserve that choice through OMS/WMS, and constrain execution to the corresponding supported service. Unknown or incompatible choices must not silently fall back to an unrelated method. This change does not implement that execution contract or new delivery promises.

## Verification

- Unit/HTTP tests cover service mapping, independent defaults, bulk validation, authorization, revision conflicts, request identity, and transaction boundaries.
- `dropship-ebay-listing-policy-bulk.integration.test.ts` runs the real repository and existing migration in an isolated schema, testing concurrency, rollback, replay, clearing, and audit retention. CI includes it in the PostgreSQL hardening job.
- Local browser smoke testing uses mocked API data only: check two listings, change fulfillment while leaving return/payment unchanged, confirm only checked rows change, and retry a simulated lost response with the same key.
- Save/refresh regression tests use real QueryClient observers for stale in-flight reads,
  cache isolation, preserved overrides, and refresh failure/retry. An SSR test verifies
  that 10,000 supplied rows mount only 50 table rows and one shared filter combobox.
- Local headless-browser verification on 2026-09-05 used 10,000 synthetic rows: save
  defaults without reloading, cancel a single edit without writing, save an override,
  preserve it through a default change, recover a failed default refresh without a second
  PUT, select 51 targets across two pages, recover a failed bulk refresh without repeating
  the write, and search for the last row. No production or eBay mutations were performed.
  This verifies UI behavior with in-memory fixtures, not production load capacity.

After deployment, test the real Ground Advantage policy, one listing-specific policy override, and a multi-listing assignment. Preview before pushing. No new authorization should be needed solely for this code change.
