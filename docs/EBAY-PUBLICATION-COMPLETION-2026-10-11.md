# eBay publication completion and listing status

Base: `origin/main` `4a596f4c6f8e1ecd3a84c74748d63d1c3187814a`, fetched October 11, 2026. PR1747 was already merged into this base. This change continues the listing lifecycle work; it does not repeat inventory recoveries or change ATP.

## Confirmed incident

Bounded read-only production checks at 21:11 and 21:25 UTC on October 11 covered product 232 (`SHLZ-TOP-180PT-BLU`), variants 463/464 and channel 67 only. The database transaction was explicitly READ ONLY; provider calls were GET requests with no token refresh.

| Resource | Confirmed state |
|---|---|
| Pack of 10 | Saved offer 197216289011; eBay returns exactly that offer as UNPUBLISHED |
| Case of 500 | Saved offer 197216292011; eBay returns exactly that offer as UNPUBLISHED |
| Local listing rows 2152/2153 | `sync_status='synced'`; external listing IDs and external SKUs are null |
| Provider group | Both items reference `SHLZ-TOP-180PT-BLU`; its membership is exactly the two intended SKUs |
| Pictures | Catalog asset 8784 is shared (`product_variant_id IS NULL`); no eBay image overrides. Both provider inventory items and the group already contain that exact catalog image URL |
| Latest stock requests inspected | Attempts 15207/15250 successfully POSTed `bulk_update_price_quantity` September 30. These are quantity updates, not publication requests |

Sanitized local evidence is in `.codex-audits/ebay-unpublished-180pt-20261011/` in the primary checkout: `exact-state.json`, `photos-and-groups.json`, and the read-only scripts. Those files contain observations, not authorization to replay any provider request.

**Unknown:** why or when these offers became unpublished, their complete historical publication lifecycle, and whether a separate historical listing exists under different identifiers. Neither this report nor the UI should say the product was never published. No publication or production repair was performed during development.

## Root cause

1. `EbayAdapter.pushInventory` in `server/modules/channels/adapters/ebay.adapter.ts` reports a successful inventory update from the quantity acknowledgement.
2. `EchelonSyncOrchestrator.recordNonShopifyInventorySyncSuccess` wrote `syncStatus='synced'` and cleared `syncError` on that acknowledgement. Price and availability acknowledgements also overwrote listing lifecycle status.
3. `selectEbayFeedListingState` and the listing-feed route used local row presence plus that status to show Listed. The local row's primary key is not an eBay listing ID.
4. The Listed action requested existing-listing maintenance. Its identity resolver requires an actual published listing. Mapping diagnosis could report unpublished offers, but only offered manual instructions: there was no saved continuation through publication.
5. Initial publication was request-scoped. A disconnected request or a successful external publication followed by failed local persistence did not have the same durable operation owner as existing listing sync.

eBay distinguishes an offer from a published listing: publishing a group converts its eligible unpublished offers into a live variation listing. See [eBay's managing-offers contract](https://www.developer.ebay.com/api-docs/sell/static/inventory/managing-offers.html). A successful stock update cannot establish that transition.

Exact historical code references below use the recorded base, not shifting implementation line numbers:

- `server/modules/channels/echelon-sync-orchestrator.service.ts`: `recordNonShopifyInventorySyncSuccess`, lines 1683-1740; the quantity-success caller is at line 620. Price status assignment is at line 1185.
- `server/modules/channels/ebay-listing-feed-status.ts`: `selectEbayFeedListingState`, lines 15-23.
- `server/modules/channels/infrastructure/ebay-listing-push.ts`: `executeProduct`, line 56; synchronous `connector.pushListing` and immediate `repository.projectSuccess`, lines 140-142.

## Implemented change and boundaries

- Preserve eBay listing lifecycle state when inventory or price acknowledgements arrive. Continue recording acknowledged inventory and prices through their existing owners.
- Require complete, consistent saved external listing identity before the feed shows Listed. Offer-only rows open a fresh publication review.
- For the exact verified unpublished group, offer **Finish publishing**. The review states the problem, shows the existing offers, and describes the action. It does not claim that identifier repair publishes an offer.
- Admit publication as an explicit operation of the existing durable listing queue. Reuse canonical draft preparation, photo resolution, ATP, provider connector, quantity admission, response recovery and workflow locks.
- Reuse exact existing offers and the observed group. Persist the selected provider resources before writes. On retry, read and verify those resources; do not infer a group from the current product SKU.
- Verify published identity and current content, including each variant's photos and the group gallery, before atomically projecting identifiers and completion. Local quantity acknowledgements are not fabricated by that projection.
- Keep interrupted or uncertain outcomes visible and recoverable using the same saved request. An uncertain historical provider response stays uncertain until the existing evidence/recovery owner resolves or explicitly supersedes it.

Mapping review only permits continuation for complete, unambiguous unpublished offers with no saved prior listing ID and all intended variants eligible. A different saved offer, extra/missing group member, prior registered lifecycle, account mismatch or incomplete provider response cannot authorize publication. These require an accurate, specific explanation instead of a guessed mapping.

### Completion, interruption and recovery

The UI flow is **Check publication → review the exact offers → Finish publishing → saved progress → verified completion**. Ordinary initial Publish also uses the same durable queue. Existing published listings continue through the existing maintenance owner.

- **Provider acceptance saved, readback delayed:** keep checking the same offers and content. The status dialog is read-only; it does not send another publication request.
- **Publish started, final response absent:** preserve the uncertain attempt. Show its recovery review and require an explicit, revision-bound acknowledgement before requeuing the same job. An empty inventory-attempt list cannot be used to invent an inventory receipt.
- **Acknowledgement committed, response to the browser lost:** replay the same command key and both review hashes. Command receipt, immutable retry event and requeue commit together; actor or changed-review conflicts are rejected.
- **Provider succeeded, final database transaction failed:** retain the provider checkpoint and retry observation/projection. The composed worker test proves one publish request across a simulated final audit failure and worker restart.
- **Catalog pictures change while waiting:** compare the content intent. Once the listing is published, use the existing maintenance owner to update the latest content before completing the saved request.
- **Newer UI request races an older receipt:** use exact command/job identity. An older response cannot clear a newer unresolved request or replace its status.

Implementation entry points:

| Responsibility | File and function |
|---|---|
| Publication admission | `server/modules/channels/ebay-publication-admission.service.ts`, `admitEbayPublication` |
| Publication stages and delayed readback | `server/modules/channels/ebay-publication-completion.service.ts`, `EbayPublicationCompletionExecution.execute` |
| Reviewed interrupted-publication recovery | `server/modules/channels/ebay-listing-recovery.service.ts`, `resume`; `infrastructure/ebay-listing-sync.repository.ts`, `authorizePublicationRetry` |
| Final atomic mapping and completion | `server/modules/channels/infrastructure/ebay-listing-sync.repository.ts`, `projectPublication` |
| Current feed classification | `server/modules/channels/ebay-listing-feed-status.ts`, `resolveEbayFeedListingState` |
| Shared and variant pictures | Existing canonical photo resolver and connector draft remain the owners; the publication executor calls `verifyExistingListing` before completion |
| Actionable UI | `EbayMappingRepairDialog.tsx`, `EbaySyncRecoveryDialog.tsx`, `EbayListingJobStatusDialog.tsx`; orchestration in `EbayChannelPage.tsx` |

No second ATP algorithm, photo resolver or publication queue was introduced. Final mapping projection does not acknowledge or alter inventory quantities. The provider connector continues to use existing quantity admission and recovery for quantity-bearing writes.

## Validation and release evidence

Final local results on October 11:

| Check | Result and scope |
|---|---|
| Full unit suite, `vitest run unit` | 1,487 files passed; 21,935 tests passed; 1 file / 40 tests skipped. Writer-ratchet passed without a baseline change. Unchanged Windows-sensitive fixtures were temporarily normalized for the run and their exact bytes restored afterward. |
| Real disposable PostgreSQL 17 | 75 tests passed across `ebay-listing-mapping-repair.integration.test.ts` and `ebay-listing-sync-recovery.integration.test.ts`. Provider calls are mocked; database transitions, migrations, locks, rollback and restart are real. |
| Desktop/mobile browser suites | 134 tests passed across the three eBay suites. APIs are mocked; these verify messages, actions, permissions, command replay and stale-response handling. |
| TypeScript | Application, server tests and client tests passed. |
| Production build | Passed. Vite still reports the existing large client bundle warning; bundle-size optimization is outside this change. |
| Migration prefix | `0737` is unused on freshly fetched main `4a596f4c6f8e1ecd3a84c74748d63d1c3187814a`. |

Focused PostgreSQL cases cover concurrent retry replay; stale review/account/mapping conflicts; rollback of receipt, command and requeue; immutable accepted responses; excluded-member preservation; canonical ownership conflicts; newer content revisions; and final projection rollback. The composed worker case starts at line 714 of the mapping-repair integration suite and verifies exact photo URLs and exactly one publish across restart.

Migration `0737_ebay_publication_completion.sql` extends the existing queue and immutable event guards. Historical jobs default to maintenance `sync`. Its per-job event-sequence index supports checkpoint/retry lookup. DDL and final mapping projection take locks; production lock duration and throughput have not been measured. The migration itself sends no provider requests and changes no listing or inventory quantities.

Local validation does not prove GitHub CI, deployment, eBay propagation timing or a completed live publication. No global listing census or automatic production backfill was run. The exact reason these two offers became unpublished remains unknown.

No production data, quantities, account settings, offers or listings have been changed by this development work. After code and migration deployment, product 232 needs the reviewed **Finish publishing** continuation, followed by verification of its returned live listing, both variant galleries and group gallery. This report does not claim that action has occurred.
