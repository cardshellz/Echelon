# Echelon to Archon order projection

Echelon owns provider connections and orders. Archon consumes one order feed; no
new Shopify, eBay or TikTok authorization is introduced here.

- Connector identity comes from channels.provider, with the explicit dropship
  acceptance/configuration marker taking precedence over vendor store platforms.
- Shopify source_name (also inside the legacy bridge's raw_payload.order) identifies
  its sales channel. Explicit tiktok maps to TikTok Shop; web maps to online store;
  pos maps to POS. Numeric/unrecognized app identifiers remain Other Shopify channel
  with their raw source identifier retained. UTMs and tags never establish TikTok Shop.
- Dropship totals come from the OMS wholesale charge, including recorded shipping
  and fees. Partner retail line revenue and shipping-recipient marketing identity
  are not exported as Card Shellz customer sales.

Migration 0672 creates an OMS-owned durable projection outbox. Order/line changes
queue revisions in the same transaction. A worker claims leased rows, reads a
consistent order snapshot, validates the versioned outbound contract, and requires
an explicit snapshot acknowledgement from Archon. Concurrent revisions cannot be
lost by acknowledgement; expired leases recover after crashes. Network/server
errors retry after five minutes. Invalid snapshots, unsupported connectors and
identity conflicts remain pending with next_attempt_at=infinity and a safe error
code until reviewed/requeued. New order changes also requeue the latest revision.

The worker reuses missionControlConnection, the same existing URL/secret resolution
as the legacy webhook sender. This PR does not replace the existing authentication
scheme. Legacy Shopify events continue during rollout; Archon stops allowing those
unversioned events to overwrite an order after snapshot adoption.
The worker respects the global scheduler switch and its dedicated
ARCHON_ORDER_DELIVERY_DISABLED switch, independently of billing.

Deploy Archon's snapshot receiver and migration 0049 first, then Echelon migration
0672 and this worker. An older receiver's unsupported-event response is retried,
not acknowledged. Historical orders are NOT automatically queued by the migration.

Preview historical replay (UTC dates, exclusive end, maximum 10,000 orders):

    npx tsx scripts/replay-archon-orders.ts --from 2026-08-15 --to 2026-09-15

Review the counts and date range before applying the same command with --apply.
Application queues current snapshots; it can create missing Archon orders and
refresh their recorded financial amounts, classification and CRM links. It does
not alter Echelon orders, inventory, wallets or marketplace configuration. Existing
Archon order identity and source remain stable. A replay is not a classification-only
historical rewrite: review its financial/customer projection effects before running.
No historical replay or production write was performed during implementation.

Read-only production inspection on 2026-09-14 confirmed Shopify, eBay and Dropship
OMS channels; Dropship OMS had zero orders. Recent OMS payloads included explicit
source_name=tiktok. Unrecognized app ids were deliberately not renamed from guesses.

Tests cover the classifier, transactional queue rollback, all three connectors,
concurrent claims, changes during delivery, retry, permanent review states and
read-only replay previews and repeat applications without source-order changes, plus
receiver projection idempotency in the companion Archon PR. CI includes the new
PostgreSQL suite in the sharded manifest and updates its coverage inventory guard.
