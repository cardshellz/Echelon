# Sync one product's inventory through ATP

Use **Sync inventory** from the catalog product's Channels panel, a Shopify
product-feed row, or Channel Inventory's selected product stock preview. Each
entry point selects the catalog product only. Opening it from a Shopify page does
not restrict the sync to Shopify.

The review recalculates availability for this product using the canonical ATP
publisher. The publisher determines the variants, destinations, source warehouses,
listing eligibility, reservations, holdbacks, shares and publication limits.
The action does not accept quantities or destination overrides. It does not create
listings or change stock rules, publication controls or warehouse inventory.

The review shows calculated quantities for eligible destinations and reasons for
blocked or skipped destinations. Existing ATP isolation applies: a blocked
destination remains blocked; supported destinations with an individual missing
stock link may still receive their other eligible variants. Global pause prevents
the command. Missing ATP registrations can be checked by the sync even when no
destination is publishable yet.

**Sync eligible inventory** records a durable request for this product using the
current ATP rules. In the acceptance transaction it wakes only the selected
product's missing registrations, including old draft rejections. A worker checks
them through the existing channel-specific stock-link owners. Opening the dialog
or reading its status does not make these changes.

After registration settles, the worker captures a fresh ATP review and persists
the exact publication command before executing it. Changed stock or rules cause
an automatic replan under the same request identity. Publication, exact outbox
identities and its audit record commit together. Provider calls do not run inside
the request transaction. Worker leases and saved state survive process restarts.

Delivery happens through the existing provider admission and outbox workers.
Queued or acknowledged work is not verified inventory. Verification requires the
receipt's exact outbox record, a matching observed quantity and a readback time.
A later inventory update can supersede an earlier queued revision; that earlier
receipt reports superseded rather than claiming the later command succeeded.

The browser retains an actor-scoped retry identity before submitting. After an
uncertain response or reload, **Retry same sync** recovers that command. Replaying
the same command does not make another desired revision. A fresh explicit sync
after completed verification can request a fresh publication even when the
calculated quantity is unchanged.

## Missing stock links

A catalog listing identity and an active ATP stock-publication link are separate
records. The stock-link owner establishes the latter from provider evidence; this
sync does not manufacture a link from a catalog mapping.

For Shopify, verified products with status `ACTIVE` or `DRAFT` can qualify for a
stock link. `ARCHIVED` and unknown statuses do not qualify. Draft eligibility does
not bypass the stock-link owner's identity and duplicate checks, or ATP's saved
inventory rules. Linking and inventory synchronization leave Shopify product
status unchanged: preparing a draft product's inventory does not publish it.

A saved `STOCK_LINK_NOT_ON_SALE` diagnostic may predate support for draft products.
The explicit product sync requests a fresh check automatically; the operator does
not need to visit a second screen or run Sync All. Existing live claims, permanent
errors, pauses, holds, automatic-link switches and channel rules remain enforced.
Provider failures keep their retry backoff. The workflow allows up to 30 minutes
for registration before reporting any destinations still blocked. Failed or
uncertain publication can be recovered with **Retry same sync**, which retains its
original publication command instead of creating another revision.

## Compatibility and permissions

The previous Shopify-only action is replaced at normal entry points. Its API and
receipt reader remain available for existing saved commands; their retry identity
must never be converted into a new all-channel command.

Review and progress require `inventory_planning:view`; synchronization requires
`inventory_planning:activate`. The request contains only the product identity,
and idempotency key. The worker derives the reviewed publication hash internally;
the previous reviewed-command API remains available for saved commands. The implementation is bounded to 1,000 product
variants, 1,000 configured targets and 10,000 target/variant review rows, and
refuses oversized operations explicitly.

The product workflow shares the stock-link engine's cluster lock and kill
switches. Its database migration adds only operational request state and indexes;
it does not backfill links or alter warehouse inventory. Disabling the workflow
leaves durable requests available for recovery and does not disable delivery of
already admitted outbox work.
