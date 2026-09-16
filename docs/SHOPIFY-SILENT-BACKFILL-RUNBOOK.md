# Silent Shopify fulfillment backfill

## Scope and behavior

Use `--silent` for the requested manual historical Shopify backfill. This suppresses
Shopify's fulfillment-creation customer notification; it does not suppress logs,
audit records, or failures. Normal shipment notifications remain unchanged.
No production backfill was executed as part of implementing this option.

The backfill script saves `notifyCustomer: false` on each newly materialized
command. The request hash includes silent intent, while the existing command key
is unchanged. The leased worker reads that saved setting on every attempt and
sends `notifyCustomer: false` to Shopify. Successful attempt metadata records the
setting. An ordinary webhook or sweep replay cannot change it; supplemental
commands retain the saved silent setting.

Catch-up commands from the outbound sweeper, missing-Shopify-writeback job,
Shopify reconciler, shipped-package repair, default legacy reconciliation, and
Operations repair actions are also silent. The shared notification policy uses
their durable source identifiers, not a guessed shipment-age cutoff. These
identifiers are centralized in `CHANNEL_FULFILLMENT_REPAIR_SOURCES` and
`CHANNEL_FULFILLMENT_OPERATOR_REPAIR_PREFIX` in
`server/modules/oms/channel-fulfillment-notification.policy.ts`.

New catch-up entry points must use this registry and add notification-policy
coverage. Unregistered sources retain the legacy live-shipping default; do not
infer repair intent from a date, tracking number, or missing source alone.

The planner applies that policy only to Shopify groups; a mixed Shopify/eBay
package does not disable eBay tracking or require unsupported notification
suppression. Source is passed through initial and supplemental planning, and the
resulting boolean is saved in the existing metadata and request hash.

An explicit attempt to change an existing command's notification setting fails
closed. Malformed settings and silent requests to unsupported providers also
fail closed. Existing live-shipping commands retain their saved notifying
behavior, including retries; legacy shipping-event retry paths are not classified
as catch-up jobs. A repair observing such a live command does not rewrite it, and
any newly discovered repair remainder is silent.

Older catch-up commands with notifications enabled (or missing the setting) are
held by the executor before any Shopify request, with error code
`SILENT_REPAIR_NOTIFICATION_REVIEW_REQUIRED`. Their request hashes and saved
settings are not changed, and the failed attempt is audited. Already-completed
commands are not re-executed. These held commands require supported review, not
a direct metadata edit. No database migration is required.

Implementation: `runBackfill` in `scripts/backfill-channel-fulfillment-authority.ts`,
`planChannelFulfillmentCommands` in `server/modules/oms/channel-fulfillment-command.ts`,
`reconcileChannelFulfillmentCommandSet` in
`server/modules/oms/channel-fulfillment-command-reconciliation.ts`, and
`createCompatibilityChannelFulfillmentProviderExecutor` in
`server/modules/oms/channel-fulfillment-authority.service.ts`.
New and stored requests use separate policy functions:
`resolveNewChannelFulfillmentNotifyCustomer` selects the creation default;
`resolvePersistedChannelFulfillmentNotifyCustomer` validates immutable intent
without replacing it when a worker claims a request.
The actual mutation is built by `pushSingleShipmentFulfillment` in
`server/modules/oms/fulfillment-push.service.ts`.

## Split-package provider order aliases

ShipStation can assign a different provider order ID to another physical package
while retaining the same stable shipping order key. The manual backfill uses
`providerOrderIdentityPolicy: "stable_key_alias"` independently of
`legacyHeaderPolicy: "strict"`. This permits the new ID only when the existing
canonical parent is unambiguous and its nonempty stable key equals the incoming
key (or that ID is already a recorded alias). It does not infer identity from
SKU, customer order number, or tracking alone.

The original canonical parent ID and provider order ID are preserved. Successful
materialization records the alternate ID, resolution, and source in the existing
`wms.shipping_engine_order_provider_refs` table within the same transaction as
the package and command. No new table or migration is needed. Other callers keep
their existing defaults; the established aggregate-projection behavior is
unchanged.

The legacy package's own provider order ID, order key, physical package identity,
tracking, and carrier still undergo the existing strict checks. Conflicting
headers or multiple matching canonical parents fail closed. Missing or different
stable keys cannot establish a new alias for a conflicting parent order ID.

`validatePhysicalPackageIdentity` uses a read-only, repeatable-read transaction
and the same parent-identity validation as `findOrCreateShippingEngineOrder` in
`server/modules/oms/channel-fulfillment-authority.repository.ts`. It never inserts
an alias. Materialization repeats the identity checks with locks; an earlier
preview does not override changes made before execution. Quantity/cancellation
checks, saved notification intent, and command idempotency are unchanged.

## Production sequence

1. Verify that every fulfillment dispatcher and repair scheduler is running the
   deployed build with the automatic-repair policy. Older workers can still send
   notification-enabled repair commands; the original manual-only silent build
   does not close the automatic-repair gap.
2. Refresh the read-only Shopify/package assessment for the intended cohort.
   Exclude held records and packages already fulfilled exactly. Prior preview
   totals are not permission to expand the scope or force conflicting commands.
3. Run a scoped dry-run with `--silent`. For example, replacing the placeholder
   with an approved legacy WMS shipment ID:

   ```text
   npx tsx scripts/backfill-channel-fulfillment-authority.ts --dry-run --silent --wms-shipment-id=<approved-id> --json
   ```

   This script resolves lineage and validates the strict package headers and
   canonical shipping-order identity, including the alias gate. It does not
   materialize commands, invoke Shopify, or prove that all subsequent quantity
   checks, writes, and provider calls will succeed. After deploying this fix,
   refresh the preview; do not execute unmerged local code against production.
4. Before execution, explain the exact packages and quantities, records changed
   and untouched, inventory impact, and audit trail; obtain explicit approval of
   that scope. Use `--execute --silent` only for those approved package IDs. Do
   not substitute an unrestricted `--limit=all` run. Although the script itself
   makes no Shopify calls, its pending commands are eligible for live dispatch.
5. Verify saved notification settings, command/attempt outcomes, and exact
   Shopify fulfillment quantities and tracking. Report held or failed records
   separately; do not manually rewrite command metadata or mark failures done.

## Rollback and limits

Do not roll a dispatcher or scheduler back to a version without this policy
while repair work remains dispatchable or eligible for later requeue. An older
scheduler may create notifying repairs, and an older worker may send them. Pause
affected work only with explicit operational approval and resolve that queue
before such a rollback. This is a rollout dependency, not a new global
notification setting.

This option does not change ordinary re-label/tracking-update behavior. It does
not establish what third-party Shopify apps or workflows do in response to a
fulfillment event. Shopify documents the native notification field in
[FulfillmentV2Input](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/FulfillmentV2Input).

## Validation

- Unit coverage: repair-source policy, CLI dry-run/execute behavior, immutable
  intent, original request-hash compatibility, mixed-provider packages, actual
  Shopify mutation payloads, originating store, existing scheduler/reconciler
  callers, normal shipping retries, and malformed/unsupported requests.
- Disposable PostgreSQL coverage: each repair source through the real authority
  handoff, concurrent materialization, normal replay, worker restart/retry,
  pre-deployment notifying-command holds, attempt auditing, and unchanged
  inventory transactions/WMS order-item quantities.
- Alias regression coverage: a different provider order ID under the same stable
  parent key, read-only dry-run with unchanged rows, concurrent CLI execution,
  silent dispatch and attempt audit, replay without command/hash changes, strict
  package-header conflicts, changed-after-preview tracking, and ambiguous parents.
- PostgreSQL results: 70 shipping ledger tests and 14 shipment omission/
  materialization compatibility tests passed. The old-command fixtures insert
  the pre-deployment shape directly with all immutability triggers enabled.
- Focused backfill CLI, parent identity, repository, and service regression run:
  59 tests passed. Actual Shopify request regressions are included in the full
  unit suite; provider calls in the PostgreSQL suite are mocked.
- Full CI unit command: 13,111 passed, 39 skipped, zero failures.
- TypeScript check, production build, and final `git diff --check` passed.

The Windows full-unit run temporarily normalized three unchanged fixture-sensitive
source files to Linux-style line endings, then restored their original bytes.
That test-only formatting left no tracked changes. Tests used a disposable local
PostgreSQL database, never production. Passing tests are not production backfill
acceptance.
