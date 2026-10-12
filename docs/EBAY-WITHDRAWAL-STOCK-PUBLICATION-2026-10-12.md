# eBay withdrawal and publication stock enrollment

## Verified incident scope

The two 180PT products are different catalog products and provider resources.
Bounded, read-only production SQL and eBay GETs were captured on October 12,
2026, at approximately 13:03–13:04 UTC. The local evidence is
`.codex-audits/ebay-target-unmapped-232-20261012/exact-state-current.json` in the
primary checkout. It is not committed because it contains operational records.
No production configuration, inventory, listing, or job was changed by this work.

| Product | Exact saved resources | Observed state |
| --- | --- | --- |
| Clear, product 3, `SHLZ-TOP-180PT-CLR` | Provider SKUs `SHLZ-TOP-180PT-P10` / `SHLZ-TOP-180PT-C500`; offers `136406510011` / `136406511011`; listing `298148206427` | Both offers `PUBLISHED`, listing `OUT_OF_STOCK`, quantities zero. A zero quantity is not a confirmed withdrawal. |
| Blue Hint, product 232, `SHLZ-TOP-180PT-BLU` | SKUs `SHLZ-TOP-180PT-BLU-P10` / `SHLZ-TOP-180PT-BLU-C500`; offers `197216289011` / `197216292011` | Both offers `UNPUBLISHED`, no listing ID. Inventory mappings 401/402 existed only as drafts, with no active mapping heads. |

Blue's job `3e780fd9-6c5f-47b3-ad41-64382759c1d4` successfully updated two offers
and two inventory items with zero preparation quantities. It then failed at the
group stage with `PUBLICATION_LISTING_TARGET_UNMAPPED`. It never reached Publish.
The existing active stock model, seller target, and source were already present.
This evidence does not support a photo failure, a need to invent inventory, or a
need to repeat an inventory cutover.

Reviewed base: `b57fdde9b0b2c011eaf1b3987dd36bd1982a6d0d` (merged PR 1751).
Subsequently fetched main: `0c3750b7cd61de127bbe23a0782c336fb6fd5683`.

## What caused the failures

1. The old `withdrawProductListings` in
   `server/routes/ebay/ebay-listing-state.ts` filtered by local `synced` status,
   addressed groups using the current catalog SKU, and projected local ending
   separately from the product exclusion change. Clear's renamed catalog SKU
   is different from its saved eBay identity. The old product toggle also did
   not give the browser a durable provider-operation result to recover.
2. `planCurrentCanonicalListingQuantity` in
   `server/modules/inventory-planning/infrastructure/quantity-publication-runtime.ts`
   requires exactly one active sealed mapping for the seller, connection, and
   provider SKU. That requirement is correct. Publication could previously
   prepare zero-quantity resources before discovering the missing stock mapping.
   The earlier publication worker tests substituted its inventory admission
   boundary, so their passing result did not prove this composition worked.

## Changes and ownership

`PostgresEbayListingExclusionRepository.set` atomically saves catalog/channel
exclusion intent, its immutable command receipt, and a withdrawal operation in
the existing listing queue. The catalog mirror is changed through
`setCatalogEbayProductExclusion`; routes do not write catalog state.

`EbayListingWithdrawalExecution.execute` resolves the actual offer/group through
the canonical eBay inspector, uses the existing quantity-reducing admission
path, and verifies the exact offers are unpublished before local `ended`
projection. It preserves identifiers and recorded quantity acknowledgements.
Accepted or interrupted sends retain their evidence and recovery path rather
than allowing a new positive operation to replace them.

`EbayPublicationCompletionExecution.execute` now calls its mandatory inventory
readiness port before provider preparation writes. Accepted publication can
still finish read-only verification. Each write continues to use the existing
canonical quantity planner and request journal.

`EbayPublicationStockService` presents a combined review of provider identity and
the inventory owner's stock proposal. `withEbayPublicationReadinessApplied`
reuses existing mapping draft creation/promotion, membership, canonical planning,
and durable stock work. Only matching draft mappings or missing exact mappings
are eligible. Holds, explicit exclusions, conflicting identities, and different
pending drafts block the plan with concrete directions. Active models, policies,
and sources are not automatically changed.

`PostgresEbayPublicationStockRepository.commit` saves the existing publication
job in the same transaction as enrollment. It acquires the inventory fence,
nonblocking listing locks, then the registration account prefix before catalog
locks. Source identity and ownership are rechecked through commit. Immutable
success and refusal receipts share a command lock; an ambiguous response keeps
the original command, and a definitive refusal cannot race a late successful
apply behind a discarded command ID.

## Operator flow after deployment

- Clear: turn the product off. The feed shows removal queued/in progress, then
  removal confirmed after eBay readback. Local exclusion alone does not claim
  eBay ended the listing. A saved request remains checkable after reload.
- Blue: use **Review stock setup**, inspect the exact SKUs, quantities, and
  proposed changes, then **Connect stock and publish**. This requires channel
  edit and inventory activation permissions. Follow the saved publishing result;
  a queued job is not publication confirmation.
- If a request response is lost, **Check saved request** and **Retry same
  request** retain its original UUID. A stock plan that has definitively changed
  requires a fresh review. Completed publication verifies listing content and
  the resolved pictures through the existing photo owner.
- An unprovable provider mapping is not silently replaced. For removal, keep
  the product excluded and inspect the specific offer/listing in Seller Hub;
  manual ending there can be followed by verification of the saved withdrawal.
  Re-enabling an unwanted listing is not a repair instruction.

## Validation and remaining limits

Local tests exercise the application contracts, actual HTTP authorization and
validation, real disposable PostgreSQL transactions, and desktop/mobile browser
journeys. PostgreSQL coverage includes atomic job-save rollback, concurrent
commands, replay after source changes, final refusal races, stock scope locks,
and provider-success/local-persistence recovery. The route-client composition
uses the real admission, canonical planner, and request journal; only provider
HTTP is substituted. Its two SKUs receive independently planned quantities
17 and 8 instead of an untrusted caller quantity of 999.

This is code and synthetic test evidence. It is not evidence that these changes
have deployed or that either live listing has changed. Live eBay content,
propagation delay, credential health, and current stock must be rechecked by the
normal reviewed workflow after deployment. Migrations 0741/0742 add operation
contracts and immutable receipts; they do not enroll products or publish stock
by themselves. The original failed Blue job and prior provider evidence remain
available; the reviewed follow-up uses its own explicit command.
