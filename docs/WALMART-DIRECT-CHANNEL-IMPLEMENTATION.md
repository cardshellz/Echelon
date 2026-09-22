# Walmart US direct channel — configuration and acceptance

Updated 2026-09-22.

## Status

The owner confirmed Walmart US, direct connection in Echelon, and seller fulfillment.
The owner subsequently connected the account and requested the same configuration
structure as other channels, with automatic order intake on connection. The current
refactor is validated locally; its deployment and live provider behavior are not
proven by these tests. No production credentials or records were changed during it.

The first implementation deliberately supports one unit per order line. A
representative multi-unit US order is still required to prove charge semantics.
Unsupported cases stop with a visible exception rather than guessed money or
quantities. This limitation must be resolved or explicitly accepted before any
production activation; it will affect ordinary purchases of multiple units.

## Implemented execution paths

- Channels → Walmart → **Configure** opens `/channels/walmart/:channelId`, using
  the same full-page Store Setup / Listing Feed structure and shared header as eBay.
  Credentials appear only in Connect/Reconnect. Store Setup shows account, location,
  warehouse, import boundary, sync health and server disable reasons.
- `client/src/components/channels/ChannelCatalogFeed.tsx` provides a provider-neutral
  paginated catalog table, exact remote SKU search, bulk exact-match selection and
  an explicit Echelon variant picker. Listing creation and pricing remain in Seller Center.
- `server/modules/channels/channel-catalog.service.ts` owns matching and verified
  batch linking. `channel-catalog.repository.ts` commits shared `channel_feeds`,
  `channel_listings`, and audit records atomically. It rejects identity conflicts,
  unavailable variants, changed connections and quarantined mappings. Replays are
  idempotent; per-channel row locks serialize competing SKU assignments.
- `walmart-catalog.adapter.ts` translates authenticated Walmart catalog reads into
  this shared contract. It contains no matching rules or persistence.
- `client/src/components/WalmartConnectionPanel.tsx` verifies own-account keys,
  selects the verified seller fulfillment center, warehouse and import boundary,
  and saves the connection. There is no separate intake-enable step. Completing
  pending setup activates the channel; reconnect preserves an explicit channel pause.
- `walmart-channel.service.ts`: validates US identity and permissions, binds one
  verified partner/environment/node/warehouse to a channel, and encrypts credentials
  through the existing AES-GCM vault. Public responses contain no credentials.
- `248_walmart_direct_channel.sql`: account uniqueness, exact connection/channel FK,
  encrypted credential records, immutable setup audit events, revision controls,
  polling checkpoint and idempotent per-purchase-order receipts.
- `walmart-order-poll.service.ts`: scans creation and modification windows with a
  24-hour overlap, validates SKUs and money before acknowledgment, persists new
  observations without warehouse authority, acknowledges and reads the order back,
  then authorizes OMS/WMS work. Failures retain the checkpoint and appear in the UI.
  Per-channel PostgreSQL advisory locks serialize polling, setup and stock writes.
  Missing mappings can resolve automatically only from unique exact local SKUs,
  with current provider verification and a write-time local identity check. Unmatched
  or ambiguous SKUs stay blocked before acknowledgment and appear as order exceptions.
- `249_walmart_channel_status_authority.sql` moves previously verified Walmart
  channels from `pending_setup` to `active` with an immutable setup event. It is
  idempotent and preserves explicit pauses. The obsolete `orders_enabled` field is
  retained for compatibility; `channels.status` now governs polling. Deployment
  can therefore begin intake from an existing connection's saved import boundary.
- `walmart-order.domain.ts`: exact USD cents, quantity/status validation, purchase
  order and line identity, shipping deadline and service level, monotonic
  cancellation disposition. Existing order or line price changes require review.
- `mapWalmartOrderObservation` normalizes provider states into the OMS-owned
  `ChannelOrderObservationWriter` API. `PostgresChannelOrderObservationWriter`
  performs transactional header/cancellation reconciliation with before/after
  quantities in OMS events and verifies channel, provider, order and line identity.
  WMS uses the configured warehouse through the optional channel warehouse resolver.
- `walmart.adapter.ts`: canonical inventory outbox only; verifies the connection,
  ship node, exact SKU mapping and supply warehouse. Publishes absolute quantities
  and reads them back. Channel Inventory derives the saved Walmart node and retains
  its existing preview/activation controls. Saving the connection does not publish.
  Supply facts come through inventory-planning's `InventoryPublicationSupplyReader`;
  missing, inactive and other-warehouse sources cannot authorize positive stock.
- `walmart-fulfillment.ts`: executes existing durable fulfillment commands after
  exact persisted OMS/WMS/package lineage checks. Rejects cancelled/refunded authority
  and voided/superseded labels. Reads Walmart before retrying and confirms tracking
  after POST; it does not blindly replay ambiguous shipment writes.

Walmart commercial `Shipped` status retains paid warehouse authority for an existing
order until physical dispatch. A fulfilled header prevents creating new warehouse
work for a historical order. This preserves the existing label-time commercial
fulfillment boundary.

File names without a directory above are under
`server/modules/channels/adapters/walmart/`, except the SQL migration under
`migrations/`. Shared integrations are in `server/services/index.ts`,
`server/modules/oms/oms-line-authority.ts`, `fulfillment-push.service.ts`, and
`wms-sync.service.ts`.
The observation API and PostgreSQL writer are in `server/modules/oms/`; the supply
read API and implementation are in inventory-planning's `application/` and
`infrastructure/` directories. Channels does not write OMS tables or query the
inventory-planning foundation directly. The writer baseline adds only the three
new channel-owned Walmart tables; the existing architecture guards remain active.

## Explicit limitations and failure modes

- Multi-unit lines, replacement orders, refunds and unsupported charge shapes stop
  for review before new-order acknowledgment. No automated refund financial posting.
- Existing financial totals or line prices cannot be silently repriced on replay.
- First import of a partially shipped historical order requires reconciliation.
  Out-of-band fulfillment and refund workflows still need controlled acceptance.
- Initial tracking supports UPS, USPS, FedEx, DHL and OnTrac. Other carriers,
  partial provider acceptance, silent notifications and tracking amendments require
  review. There is no automatic Walmart void/relabel amendment workflow.
- Listing creation, price publication and seller-initiated cancellation are not
  implemented; perform those actions in Seller Center. Cancelled provider states
  are imported through the shared WMS cancellation/reconciliation path.
- A failed order holds the scan checkpoint. Persistent exceptions must be resolved
  promptly; scans are bounded to 100 pages per window to avoid unbounded work.
- Invalid credentials, rate limits, response-shape errors, account/node mismatches,
  financial drift and incomplete WMS handoffs are explicit failures, not success.
- No live or Walmart sandbox acceptance has been performed. Synthetic fixtures and
  mocked HTTP tests prove code behavior, not account permissions or provider acceptance.
- Browser interaction with a connected account, shipping configuration, downstream
  Finance/Archon attribution, and physical warehouse dispatch remain unverified.

## Deployment and connection acceptance

1. Deploy the migrations and application together. Verified pending-setup accounts
   become active; intentionally paused accounts stay paused. Preserve explicit
   server disable switches when intake must remain stopped during acceptance.
2. Configure `WALMART_CREDENTIAL_ENCRYPTION_KEY` with a 32-byte AES key in the existing
   vault's supported hex/base64 format; optionally set `WALMART_CREDENTIAL_KEY_ID`.
   Store server secrets through the deployment secret manager, not source control.
3. In Channels, add **Walmart US**, open **Configure** and verify credentials for the
   owner's own Walmart US account. Verify returned partner and fulfillment center.
   Save the explicit warehouse and import boundary. Orders then sync automatically
   while the channel is active. Use the existing Channels Active/Paused control.
4. Browse Listing Feed. Link exact matches in bulk or choose the correct variant for
   different remote SKUs. Unique exact matches can also resolve during intake.
   Unsupported, conflicting or quarantined identities require review.
5. Reconcile a real multi-unit order's charges and taxes against Seller Center.
   Complete sandbox/provider contract acceptance for profile, nodes, pagination,
   acknowledgment, inventory PUT/readback, shipping POST/readback, cancellation,
   timeout-after-success, token expiry and throttling.
6. Verify a controlled order's OMS money, SKU identity, warehouse, reservation,
   shipment command and provider tracking. Verify cancellation and physical-dispatch
   behavior, and downstream sales attribution, before general intake.
7. No affirmative server flag or second enable button is required. Explicit
   `WALMART_LIVE_ENABLED=false`, `WALMART_ORDER_POLLING_ENABLED=false`,
   `WALMART_ORDER_POLLING_DISABLED=true`, and global scheduler disable controls
   still apply and are reflected in Store Setup. Sandbox orders are prohibited
   on a production server.
8. Configure the Walmart destination separately in Channel Inventory. Its sealed
   supply binding must draw only from the configured warehouse. Review the quantity
   preview and provider readback before enabling stock publication.

Pausing order intake does not disable already-required shipment confirmations or
stock publication. Use the existing Channel Inventory hold controls for stock and
`WALMART_LIVE_ENABLED=false` for a full Walmart runtime stop. Do not delete OMS/WMS
records to recover a failed provider call; retry the receipt/command after reviewing
its provider state.

## Validation

The configuration refactor has 137 passing focused checks across nine suites,
including 16 actual PostgreSQL tests and the writer-ownership ratchet. Twelve
desktop/mobile browser scenarios verify normal page structure, bulk links,
pagination, explicit variant selection, connect/reconnect, permissions and error
states. Browser tests mock provider responses; they do not prove live acceptance.
Historical validation below belongs to the original connector implementation.

Focused tests cover authentication and secret redaction, cents boundaries, API
response validation, acknowledgment recovery, duplicate polling, unmapped SKUs,
cursor loops, warehouse-handoff failures, channel pauses, shipment lineage and
replay, cancelled/refunded/voided authority, inventory identity and zero quantities,
production activation guards, and related Shopify/eBay/OMS regression paths.

The disposable PostgreSQL suite uses the actual Walmart migration, historical
OMS/channel table DDL and actual inventory binding table DDL. It covers rollback,
account uniqueness, immutable audits, exact mappings, concurrent revision updates,
cross-session locks, cancellation monotonicity, receipts, checkpoints, exceptions,
and rejection of stock from another warehouse. No production database was used.

Application and new-test TypeScript checks and the production client/server build
are included in the validation record. Final regression run: 293 passing tests across 16 files, including nine actual
PostgreSQL tests. Production client/server build passed.
The Walmart PostgreSQL suite is registered in the explicit CI manifest (89 files,
up from 88); all 42 CI coverage/isolation guard tests also passed. The guard retains
the prior suite inventory and verifies the new suite runs in an isolated database.

The ownership-boundary follow-up passes both previously failing architecture suites,
the Walmart regression tests and 11 disposable PostgreSQL tests (including exact
order identity and rollback after a later line's financial failure). The full local
unit run passed 14,239 tests; three existing Dropship migration assertions failed on
Windows CRLF copies and all 17 tests in those three files passed with the committed
LF content. The original bytes were restored; those migrations are unchanged.
Application, full server/client test TypeScript checks, and the production build passed.

## Official contract references

- [US access token](https://developer.walmart.com/us-marketplace/reference/tokenapi)
- [Global access-token flow](https://developer.walmart.com/global-marketplace/docs/get-an-access-token-using-token-api)
- [Global all-orders reference](https://developer.walmart.com/global-marketplace/reference/getallorders)
- [US get-order guide](https://developer.walmart.com/us-marketplace/docs/get-an-order)
- [US acknowledgment reference](https://developer.walmart.com/us-marketplace/reference/acknowledgeorders)
- [US inventory update](https://developer.walmart.com/us-marketplace/reference/updateinventoryforanitem)
- [US catalog pagination](https://developer.walmart.com/us-marketplace/reference/getallitems)
- [US exact item lookup](https://developer.walmart.com/us-marketplace/reference/getanitem)
- [Global ship-order guide](https://developer.walmart.com/global-marketplace/docs/ship-an-order-mp)

The US shipping schema and Global 3.1 documentation are not fully consistent about
shipment timestamp representation. The implementation follows the US schema's
integer epoch-millisecond field; provider acceptance must verify it before launch.
