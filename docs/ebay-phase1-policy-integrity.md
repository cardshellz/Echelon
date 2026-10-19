# Phase 1: eBay business policy integrity

This change repairs policy selection and publication within the existing eBay feature. Phase 2's multi-channel orchestration and schema redesign are outside this change.

## Confirmed problem

The selectors already loaded the same eBay business policy catalog. A saved ID absent from that catalog could remain in form state while the selector appeared blank. The publisher separately resolved policy fields, and the generic adapter also read a legacy nested `businessPolicies` object. A blank display therefore did not prove inheritance. Historical data alone does not establish who selected or introduced an unavailable ID.

## Responsibility and writer inventory

| Responsibility | Owner | Retired or guarded path |
| --- | --- | --- |
| Policy ID, inheritance and availability contract | `shared/ebay-business-policies.ts` | Per-screen interpretations of blank or unknown values |
| Read current eBay policy catalog | `EbayBusinessPolicyProvider.readCatalog` | Separate route catalog readers and error-to-empty-list behavior |
| Resolve store -> product type/category -> product -> variant | `createEbayBusinessPolicyService.resolveProductPolicies` | Resolution in publication, active-listing sync and the generic eBay adapter |
| Validate policy changes and stale edits | `patchPolicies` / `saveCategoryMappings` on the same service | Direct policy updates in settings, category, product and variant routes; legacy listing-rule policy writes |
| Own legacy product/variant SQL | Catalog's `catalog-ebay-policy-fields.ts` published interface | Raw Catalog policy SQL in Channels and routes |
| Transaction and audit orchestration | `PgEbayBusinessPolicyRepository.withScope` | Uncoordinated field saves without their audit record |
| Render every policy selector | `EbayPolicyFields` | Independent store, desktop/mobile category, product and variant controls; the unmounted legacy listing-rule editor |
| Publication state and recovery | Existing listing job, diagnostic and progress owners | Treating a rejected publication as still checking earlier requests |

The registered legacy listing-rule APIs reject policy writes, omit their historical policy columns from the rule editor DTO, and delegate SKU policy resolution to the same owner. Their category-rule behavior remains available. The unreferenced `EbayListingRules` component is retired so its misleading policy controls cannot be mounted again. Historical legacy rule values are not copied into the active policy hierarchy.

The Catalog persistence interface is narrow: Channels makes the policy decision, while Catalog writes its own legacy columns using the caller's transaction. This does not introduce interchangeable internal domain adapters.

## Persisted values and recovery

Omission preserves a field. Explicit null inherits. A newly selected non-null ID must exist in the current verified account, environment and marketplace catalog. An existing unavailable ID remains visible with its exact identity and source until explicitly corrected; it is never silently replaced. Store null means unconfigured, so publication requires a complete effective set after inheritance.

Writes validate actor and target, check the expected policy snapshot and optional editing scope, lock the verified connection and credential binding, preserve unrelated metadata, and commit changes and audit together. Category batch saves are atomic. Generic product/variant APIs reject policy writes before other mutations; generic connection updates cannot replace policy metadata. Duplicating a product creates a draft inheriting category/store policies rather than copying product/variant policy overrides invisibly.

Both publication preparation and active-listing sync obtain the validated per-variant map from the owner before provider mutations. The generic adapter and test-listing route use that owner as well. The failed saved publication retains policy source information for an actionable editor link; correcting the selection and Sync resumes the existing publication lifecycle.

The PostgreSQL publication boundary also converts bigint price cents using strict safe-integer checks. Overflow or malformed cents fail before policy/provider activity.

## Regression evidence

Local verification passed all 288 tests in the 16 Channels PostgreSQL suites, including the 39-case policy writer suite and the eight-case metadata/concurrency suite. Application and server-test typechecks and the production build passed. Desktop/mobile policy and saved-job recovery browser coverage and the final published-commit CI are completed separately before handoff; their exact results are recorded in the pull request. Coverage includes actual PostgreSQL transactions, concurrency, audit rollback, four policy levels and three policy kinds, stale account/marketplace changes, malformed and partial provider catalogs, composed publication correction/retry, and desktop/mobile selector behavior. The composed test uses the real policy and listing-job repositories, publication executor/connector, quantity reader, readiness/admission and journals against PostgreSQL. Provider HTTP and unrelated media, pricing and credential inputs are fixtures; no eBay requests are made.

## Release and acceptance

Deploy `900000012000018420001_ebay_category_policy_identity_capacity.sql` with the application. It widens columns only and does not choose, clear or rewrite any policy. No production data repair, eBay mutation or deployment is performed as part of preparing this pull request.

After deployment, verify the connected account and policy list; confirm saved unavailable IDs are visible at every relevant scope; explicitly choose inheritance or an available policy; save; then Sync the affected product. Confirm eBay listing and pictures, saved job completion and audit evidence. Existing production publication recovery remains unverified until that acceptance is performed. This change does not prove when or why the historical unavailable ID was stored.
