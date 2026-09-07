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

## Confirmed trace / remaining work

- `sync.service.ts::discoverFeeds`: copies catalog Shopify variant IDs to all channels.
- `channels.routes.ts`: feed enable and Shopify setup seed global IDs.
- `product-push.service.ts`: global product/variant ID fallback on update; response
  mappings on create need complete validation and transactional local persistence.
- `echelon-sync-orchestrator.service.ts`: listing push/pull still use global IDs.
- `sync.service.ts::pushToShopify`: global inventory ID and environment location fallback.
- `inventory.use-cases.ts::syncWarehouse`: global reverse lookup; unchecked quantities;
  raw provider access inside inventory owner; force-negative adjustment.
- `catalog-backfill.service.ts` and catalog routes need producer verification before
  declaring that no unsafe mapping writers remain.

## Release gates and recovery

Code rollback is separate from data recovery. Each PR needs fresh-main checks, exact
head verification, unit/type validation and applicable disposable PostgreSQL tests.
Verify deployed code before running a production preview. Review its exact scope
before apply. Data recovery must compare current state with the applied snapshot;
never overwrite intervening edits or reactivate known bad mappings. Pause affected
sync targets when safe recovery cannot be established. Do not claim that all live
connections work until provider readback and end-to-end checks establish it.
