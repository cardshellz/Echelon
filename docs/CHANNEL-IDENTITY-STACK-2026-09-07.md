# Channel identity repair stack

One coordinated development effort; deployments remain ordered. Production changes
are not authorized by this development task. Base: main at 445efdc7, including PR 1393.

## Contract

Echelon variant IDs identify internal items. External IDs belong to a destination
channel/account; SKU text is evidence for verifying a link, not the relationship key.
Warehouses, source accounts, and destination locations are distinct scopes. No US/CA
special cases. Existing legacy feeds are keyed by channel + internal variant; they
cannot represent multiple accounts inside one channel. Legacy operations must reject
that ambiguity. Canonical publication targets retain explicit connection/location scope.

## Ordered development and deployment checkpoints

1. Mapping producers and shared identity boundary: no catalog-global ID fan-out;
   provider-verified links, explicit connection selection, auditable owner writes.
2. Remaining consumers: product/listing push and pull, legacy quantity push, and
   external warehouse imports use scoped identities. Bad quantities or ambiguous
   identities fail before inventory mutation. Preserve allocation and source rules.
3. Existing-data repair: bounded read-only preview, explicit apply, compare-and-set
   protection, immutable audit, replay protection, and safe recovery. No automatic
   product creation, inventory adjustment, or publication activation during repair.
4. Validate the full stack, including two stores sharing an internal variant,
   multiple warehouses, missing/duplicate identities, pagination, partial failures,
   retries, stale previews, and rollback. Split commits into ordered PR branches.

Do not stop development between these checkpoints to wait for deployment.

## Implemented trace

- `sync.service.ts::discoverFeeds` and `channels.routes.ts`: no global-ID feed seeding.
  Explicit enable/discovery verifies the selected store's existing listing, enforces
  product-line eligibility, and preserves quarantine/review gates. Listing reads are
  batched to avoid an unbounded SQL parameter list.
- `channel-identity.service.ts`: unique account resolution, exact external identities,
  channel-serialized feed creation, audit persistence, and transactional import recheck.
- `product-push.service.ts::getResolvedProductForChannel` and the orchestrator's listing
  push/pull resolve channel listing IDs, not catalog-global IDs. Routine product sync
  is update-only and verifies the destination product before PUT. Existing HTTP product
  push restrictions remain unchanged.
- `sync.service.ts::pushToShopify`: destination feed inventory IDs, explicit assigned
  warehouse locations, no environment fallback in this caller. Normal `syncProduct`
  continues to delegate to the allocation orchestrator; it does not revive legacy allocation.
- `inventory.use-cases.ts::syncWarehouse`: provider-neutral read dependency, scoped
  reverse mappings, complete observation validation, pinned warehouse lock, 100-item
  serializable batches, reserved-stock protection, and post-commit notifications.
- `catalog-backfill.service.ts`: validates provider IDs and persists per-channel inventory
  IDs. Backfill/catalog credential reads reject ambiguous accounts and validate domains.
- `channel-identity-repair.service.ts`: read-only preview, one-feed durable apply, fresh
  provider verification, stale-preview rejection, atomic mapping/audit/receipt writes,
  and compare-and-set recovery into disabled review state.

## Repair operator contract (no new UI)

All endpoints require channel edit permission. Apply/recover require an authenticated
session actor and an `Idempotency-Key` header. Never fabricate provider IDs or use SKU
search as an automatic mapping authority.

1. `POST /api/channels/:channelId/identity-repair/preview` with `{ "feedIds": [123] }`.
   Limit 25 distinct feeds; prefer small previews because provider reads are sequential.
   No DB or provider writes. Review the exact account, internal variant, before state,
   provider evidence, action, and expectedHash.
2. `POST .../apply` with `{ "feedId": 123, "expectedHash": "<preview hash>" }` and a
   unique idempotency key for that exact command. One feed per command bounds the
   transaction and failure scope. A timeout must be retried with the SAME key and body.
   Save the returned commandId and receipt.
3. `POST .../recover` with `{ "applyCommandId": 456 }` and a new recovery idempotency key.
   Recovery requires an unchanged account and unchanged applied mapping. It restores
   previous identity fields but keeps the feed disabled/quarantined and listing in review.
   It does not reactivate a known-bad mapping or overwrite subsequent edits.

Exact destination 404s can disable the affected feed and mark an existing listing for
review. Authentication, throttling, malformed evidence, SKU conflicts, and existing
quarantine are NOT permission to create products, guess links, or zero stock. Transient
provider failures remain retryable. Unmapped imported items are reported as unresolved;
they are never interpreted as zero quantity.

Apply/recover are blocked if runtime authority is not confirmed legacy or an active
canonical publication target exists for the channel. Canonical target revisions must
use their existing owner workflow. No authority, target, sync switch, or production
mapping is activated automatically by deploying this stack.

## Validation and limits

- Real disposable PostgreSQL coverage exercises scoped repair/replay, concurrent commands,
  stale evidence, audit rollback, safe recovery, quarantine, duplicate ownership, and
  canonical-authority refusal. Warehouse coverage exercises actual inventory/ledger
  writes, concurrent replay, post-commit notification, and whole-batch rollback on a
  reserved-stock conflict. Provider HTTP responses are controlled test fixtures.
- Unit coverage exercises provider pagination/validation, channel-specific product IDs,
  missing-mapping no-create behavior, import validation, and HTTP permission/actor/key gates.
- Existing full catalog-product reconciliation remains a separate workflow. This narrow
  repair deliberately does not rewrite catalog-global legacy metadata or enqueue
  shipping-group/provider mutations. Global metadata is not removed by this stack.
- Legacy feeds still cannot represent two accounts within one channel; ambiguity is
  rejected. Canonical account/location targets are the network-scale path. Legacy
  warehouse location fields and legacy adapter fallback behavior outside the changed
  callers are not a claim of arbitrary multi-account warehouse support.
- No new Amazon/eBay connector is implemented here. Internal IDs and provider-neutral
  import contracts avoid a US/Canada special case; each marketplace still needs its
  existing adapter's own verified integration coverage.
- Code validation does not prove current production data or all live store connections.
  After ordered deployment: verify the deployed heads, run fresh read-only previews,
  obtain approval for their exact mutations, then apply bounded commands and verify
  selected-store readback plus unchanged other-store state. Inventory/publication
  activation remains a separate explicitly authorized step.

## Release gates and recovery

Code rollback is separate from data recovery. Each PR needs fresh-main checks, exact
head verification, unit/type validation and applicable disposable PostgreSQL tests.
Verify deployed code before running a production preview. Review its exact scope
before apply. Data recovery must compare current state with the applied snapshot;
never overwrite intervening edits or reactivate known bad mappings. Pause affected
sync targets when safe recovery cannot be established. Do not claim that all live
connections work until provider readback and end-to-end checks establish it.
