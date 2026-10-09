# Existing eBay listing sync: durable completion and recovery

Base and revalidation: `origin/main` `11f01c5af69489561046abb45b3dee9d24d77595` (October 9). Implementation branch: `codex/ebay-sync-lifecycle`. Migration `0729` is unused on that fetched main. Original inventory reports and recovery worktrees are unchanged.

## Confirmed cause and ownership

`PostgresQuantityPublicationAdmission.execute` in `server/modules/inventory-planning/infrastructure/quantity-publication-admission.repository.ts` fences overlapping running/uncertain attempts before provider I/O. Its `listDue` excludes those scopes. The old route helper and the independent sync-stream implementation attempted the listing update again without a durable owner for the entire listing operation. A retained uncertain quantity request could therefore prevent every later listing Sync, even when its final eBay error response was already recorded.

The retained 200/200/500 example is not evidence that all historical quantities were delivered or that the 500 had no side effects. The original 500 response body is unavailable; its underlying provider validation failure is still unknown. No photo cause is inferred.

## New flow

1. `syncActiveListings`, published by `server/modules/channels/ebay-listing-sync.ts`, resolves the exact current channel, verified account, connection, product, SKU, offer/listing identities and group. It commits jobs and immutable commands before responding. Provider HTTP no longer runs inside the Sync request.
2. `EbayListingSyncService.processDue` uses the existing listing-publication worker runner. A PostgreSQL session advisory lock protects each job across provider I/O; a token and claimed revision fence every checkpoint and final projection. HTTP runs without an open database transaction. Restarting can reclaim an abandoned job after its session owner is gone.
3. `EbayExistingListingSyncExecution.execute` rebuilds current catalog content, prices and the existing authority-aware quantity plan. Inventory's published `quantityProviderResponseRecovery` checks prior response evidence before any listing write. Offer, inventory-item, group and verification stages are retained independently.
4. Every quantity-bearing request still uses `executeAdmittedEbayQuantityRequest` and the existing inventory admission/journal. Current canonical replanning and global/channel/cooldown controls remain authoritative. No stored quantity payload is blindly replayed.
5. `EbayMarketplaceListingConnector.verifyExistingListing` checks current inventory-item/group content and exact PUBLISHED offer/listing identities. Prices compare as exact decimals. Quantity is omitted from content readback because its owner may refresh the current plan after draft preparation.
6. `PostgresEbayListingSyncRepository.finish` commits listing price/status projection, job completion and immutable completion event together. It validates the exact saved provider projection identity. It never writes `last_synced_qty` or warehouse inventory. A failed transaction rolls all these local writes back; retained external request receipts support the next run.
7. The channel page polls the saved public job view. Queued/running/recovering jobs are shown as retained work, not a completed listing. Closing the progress modal stops observation, not the accepted work. An interrupted request with missing proof displays `awaiting_evidence`; after the existing authorized evidence-resolution path resolves it, the saved job resumes without another Sync command.

The separate sync-stream algorithm is removed. Route compatibility exports point to the same implementations now located in Channels; Infrastructure does not import the HTTP route directory. Writer baseline changes remove the old sync-helper route writer and add only the four new tables under Channels/Inventory Planning ownership.

## Automatic recovery proof

`terminalEbayResponseEvidence` is the sole policy for final synchronous eBay response proof. It requires every immutable request/response receipt, complete ordinal sequence, response hashes and recorded timestamps. It supports synchronous inventory-item/group/offer PUTs and bulk quantity POSTs. Completed synchronous responses and validated top-level eBay error responses can prove request termination.

[eBay's REST error contract](https://developer.ebay.com/develop/guides/sell/using-ebay-restful-apis#handling-errors) states that processing stops when an error is encountered. This supports releasing request ownership, not claiming successful delivery, no effect, or a quantity acknowledgement. Recovery preserves the original request outcomes/error codes and an immutable before-record, then atomically records `provider_response_terminal` and wakes retained current-state work. It handles existing legacy/listing and outbox owners with the same policy. Installation of the migration performs no recovery or provider write.

No response, HTTP 202, incomplete/ambiguous 2xx, unsupported lifecycle endpoints, gateway pages without validated eBay errors, or an active local admission owner cannot satisfy automatic proof. Age and matching quantity readback are not termination evidence. Existing operator attestation remains separately permission controlled; it is not fabricated by the worker.

## Failure and deployment limits

Provider transport/verification failures use bounded retry/backoff (five failures; waits for known publication controls do not exhaust that budget). Provider cooldowns retain their retry deadline. Permanent identity/configuration conflicts and exhausted failures require attention. Missing request termination proof remains fenced while the job periodically checks for authorized resolution. A fresh request can still expose the original provider validation error; its validated error code/category/message is now retained and sanitized for the job view.

The worker honors the existing scheduler disable controls and `LISTING_PUBLICATION_DISABLED`. Global quantity publication controls still deny quantity writes. This change does not activate inventory authority, change warehouse quantities/costs, repeat incident recoveries, merge or deploy. Tests use a real disposable local PostgreSQL cluster and mocked provider HTTP; current production execution, buyer-facing eBay pages and provider acceptance after deployment are not proven by those tests.

## Validation

Validation results and the exact review commit are recorded in the PR. Coverage includes stable-key replay, concurrent coalescing/owner fencing, new requests arriving during execution, restart, partial 200/200/500 response recovery, current quantity rebuilding, absent-response fencing and authorized evidence resumption, rollback of completion/projection/audit, rollback of response recovery, lost stage checkpoint recovery, immutable audit and desktop/mobile saved-job states. Existing canonical admission/catch-up suites verify the unchanged quantity authority path. The new isolated lifecycle fixture directly exercises legacy listing admission; it does not claim a full canonical activation or live outbox-worker deployment.

Windows source-byte tests must use Git's LF snapshot. The ordinary Windows checkout showed unrelated CRLF-sensitive migration/golden-file failures. Broad line-ending rewriting was rejected by automatic approval review; validation instead uses an exported Git snapshot without modifying those files.
