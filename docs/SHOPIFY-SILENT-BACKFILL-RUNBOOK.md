# Silent Shopify fulfillment backfill

## Scope and behavior

Use `--silent` for the requested historical Shopify backfill. This suppresses
Shopify's fulfillment-creation customer notification; it does not suppress logs,
audit records, or failures. Normal shipment notifications remain unchanged.
No production backfill was executed as part of implementing this option.

The backfill script saves `notifyCustomer: false` on each newly materialized
command. The request hash includes silent intent, while the existing command key
is unchanged. The leased worker reads that saved setting on every attempt and
sends `notifyCustomer: false` to Shopify. Successful attempt metadata records the
setting. An ordinary webhook or sweep replay cannot change it; supplemental
commands retain the saved silent setting.

An explicit attempt to change an existing command's notification setting fails
closed. Malformed settings and silent requests to unsupported providers also
fail closed. Commands predating this option, which omit the setting, retain
their previous notifying behavior. No database migration is required.

Implementation: `runBackfill` in `scripts/backfill-channel-fulfillment-authority.ts`,
`planChannelFulfillmentCommands` in `server/modules/oms/channel-fulfillment-command.ts`,
`reconcileChannelFulfillmentCommandSet` in
`server/modules/oms/channel-fulfillment-command-reconciliation.ts`, and
`createCompatibilityChannelFulfillmentProviderExecutor` in
`server/modules/oms/channel-fulfillment-authority.service.ts`.
The actual mutation is built by `pushSingleShipmentFulfillment` in
`server/modules/oms/fulfillment-push.service.ts`.

## Production sequence

1. Verify that every fulfillment dispatcher is running the deployed build with
   this option. Older workers ignore the new metadata and can send notifications.
2. Refresh the read-only Shopify/package assessment for the intended cohort.
   Exclude held records and packages already fulfilled exactly. Prior preview
   totals are not permission to expand the scope or force conflicting commands.
3. Run a scoped dry-run with `--silent`. For example, replacing the placeholder
   with an approved legacy WMS shipment ID:

   ```text
   npx tsx scripts/backfill-channel-fulfillment-authority.ts --dry-run --silent --wms-shipment-id=<approved-id> --json
   ```

   This script validates lineage only. It does not materialize commands, invoke
   Shopify, or prove that subsequent writes and provider calls will succeed.
4. Before execution, explain the exact packages and quantities, records changed
   and untouched, inventory impact, and audit trail; obtain explicit approval of
   that scope. Use `--execute --silent` only for those approved package IDs. Do
   not substitute an unrestricted `--limit=all` run. Although the script itself
   makes no Shopify calls, its pending commands are eligible for live dispatch.
5. Verify saved notification settings, command/attempt outcomes, and exact
   Shopify fulfillment quantities and tracking. Report held or failed records
   separately; do not manually rewrite command metadata or mark failures done.

## Rollback and limits

Do not roll a dispatcher back to a version that ignores notification metadata
while silent commands remain dispatchable or eligible for later requeue. Pause
dispatch through the supported operational controls and resolve that queue before
such a rollback. This is a rollout dependency, not a new global notification
setting.

This option does not change ordinary re-label/tracking-update behavior. It does
not establish what third-party Shopify apps or workflows do in response to a
fulfillment event. Shopify documents the native notification field in
[FulfillmentV2Input](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/FulfillmentV2Input).

## Validation

- 216 focused regression tests: CLI dry-run/execute behavior, immutable intent,
  legacy defaults, original request-hash compatibility, exact Shopify mutation
  payloads, originating store, and fail-closed malformed/unsupported requests.
- 68 disposable PostgreSQL integration tests: persisted settings, concurrent
  materialization, rejected setting changes with rollback, retries after worker
  restart, attempt auditing, and existing shipment compatibility. New tests
  verify inventory transactions and WMS order-item quantities remain unchanged.
- Full CI unit command: 13,035 passed, 39 skipped, zero failures.
- TypeScript check and production build passed; `git diff --check` clean.

The Windows full-unit run temporarily normalized three unchanged fixture-sensitive
source files to Linux-style line endings, then restored their original bytes.
That test-only formatting left no tracked changes. Tests used a disposable local
PostgreSQL database, never production. Passing tests are not production backfill
acceptance.
