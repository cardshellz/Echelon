# OMS/WMS Control Tower Turnover Handoff - 2026-07-19

## Purpose

This document hands off the OMS/WMS and Operations Control Tower hardening
completed from 2026-07-13 through 2026-07-19. It is intended to let work resume
from another computer without reconstructing the decisions, incidents, and
safety rules from the original Codex conversation.

This is a dated operational snapshot. Recheck production before mutating an
order, shipment, fulfillment, or inventory record.

## Repository And Production Baseline

- Repository: `cardshellz/Echelon`
- Production app: `cardshellz-echelon`
- `origin/main` at handoff creation: `1185302b74ca91d532237e3203341792514d694b`
- Production release: `v2420`
- Production deployed commit: `1185302b`
- Production deployment time: `2026-07-19 08:09:56 -0400`
- Handoff branch: `agent/oms-wms-control-tower-handoff-2026-07-19`

Verified production recovery configuration:

| Variable | Value | Meaning |
| --- | --- | --- |
| `SYNC_RECOVERY_SCHEDULER_DISABLED` | `false` | Unified recovery is enabled. |
| `SHOPIFY_RECONCILIATION_SCHEDULER_DISABLED` | `true` | Legacy Shopify reconciliation scheduler is disabled. |
| `SHOPIFY_BRIDGE_LISTENER_DISABLED` | `true` | Legacy bridge listener is disabled. |

Do not enable either legacy Shopify owner while unified recovery is active.
That would recreate competing ingestion ownership.

Read these documents after this handoff:

- `docs/OMS-WMS-CONTROL-TOWER-HANDOFF-2026-07-11.md`
- `docs/OMS-WMS-AUTHORITY-REMEDIATION-DESIGN.md`
- `docs/OMS-WMS-AUTHORITY-OPERATIONS-RUNBOOK.md`
- `docs/OPERATIONS-CONTROL-TOWER-DESIGN.md`
- `docs/OPERATIONS-CONTROL-TOWER-RUNBOOK.md`
- `docs/OMS-PROVIDER-FULFILLMENT-TEST-PLAN.md`

## Current State In Plain English

The flow now begins at the sales channel rather than at OMS. Shopify and eBay
orders are durably recorded when Echelon first observes them, before OMS
creation is attempted. The Control Tower can therefore distinguish:

1. The channel order was observed.
2. OMS received it.
3. WMS received the physical work.
4. A shipment was created.
5. The channel was updated.

Only physical, shippable orders belong in this funnel. Digital or otherwise
non-shippable orders are intentionally excluded.

The major incidents from this week now have durable prevention or visible
recovery paths:

- A later Shopify update can no longer erase paid line authority during a
  duplicate-ingest race.
- A paid event can be replayed from its canonical stored payload, with visible
  replay progress and outcome.
- eBay polling has a durable checkpoint, overlap, deep scan, retry, heartbeat,
  and alerting instead of a four-hour memory window.
- Shopify recovery has one scheduler owner, a durable checkpoint, oldest-first
  replay, explicit per-order failures, and correct Shopify GID identity.
- ShipStation replacements, concessions, and legitimate split shipments have
  purpose-specific inventory authority instead of being forced through normal
  customer-fulfillment semantics.
- ShipStation target evidence is resolved by exact shipment ID. Order number is
  not accepted as proof of the physical package being remediated.

This does not prove every historical Control Tower row is already repaired.
Several fixes prevent recurrence or make remediation safe, while old corrupted
shipment rows still require current evidence and an explicit repair action.

## Merged Work This Week

| PR | Outcome |
| --- | --- |
| [#910](https://github.com/cardshellz/Echelon/pull/910) Fix OMS duplicate ingest authority race | Locks the existing order line and derives the update from the locked row, preventing a concurrent/later `orders/updated` event from overwriting paid authority with stale zero values. |
| [#911](https://github.com/cardshellz/Echelon/pull/911) Fix Control Tower paid order replay | Replays the canonical succeeded Shopify `orders/paid` inbox payload instead of queueing an ineffective generic OMS/WMS sync. |
| [#912](https://github.com/cardshellz/Echelon/pull/912) Show Control Tower replay status | Adds durable queued, retrying, reached-WMS, failed, still-blocked, and unavailable replay states and live polling while pending. |
| [#913](https://github.com/cardshellz/Echelon/pull/913) Fix production startup after cartonizer deploy | Bundles `binpackingjs` into the server build after its CommonJS/ESM packaging caused a Node 24 production startup failure. |
| [#920](https://github.com/cardshellz/Echelon/pull/920) Add ShipStation reship adoption workflow | Adds operator-reviewed adoption of a real replacement shipment, original-package lineage, and replacement-only inventory deduction. |
| [#925](https://github.com/cardshellz/Echelon/pull/925) Fix crossed ShipStation reship identity | Resolves the exact active package by tracking and SKU quantities and restores original WMS identity when a duplicate callback crossed original/replacement tracking. |
| [#930](https://github.com/cardshellz/Echelon/pull/930) Complete empty-line ShipStation reship adoption | Supports provider replacements whose ShipStation payload omits package lines by requiring explicit original WMS item confirmation. |
| [#932](https://github.com/cardshellz/Echelon/pull/932) Clarify replacement shipments and support concession items | Replaces technical UI language with operator decisions and supports different/free items that were never on the order. |
| [#938](https://github.com/cardshellz/Echelon/pull/938) Fix concession shipment recording | Adds item typeahead, makes notes optional because structured choices are the evidence, and fixes the integer/boolean `is_primary` database error. |
| [#942](https://github.com/cardshellz/Echelon/pull/942) Prevent silent eBay order ingestion gaps | Adds durable polling checkpoint, overlap, 30-day deep scan, per-order retry, non-overlap lock, heartbeat, critical alerts, and idempotent recovery. |
| [#947](https://github.com/cardshellz/Echelon/pull/947) Harden ShipStation split reconciliation authority | Discovers all provider packages, uses the authoritative resolver, ignores reviewed rows, and removes ship-by lateness from technical exception buckets. |
| [#948](https://github.com/cardshellz/Echelon/pull/948) Fix ShipStation reship evidence lookup | Makes the target lookup exact-shipment-ID-only and rewrites operator summaries in plain English. |
| [#949](https://github.com/cardshellz/Echelon/pull/949) Fix replacement shipment item authority | Replaces the old blanket `order_item_id` constraint with purpose-specific customer, replacement, and concession authority. |
| [#951](https://github.com/cardshellz/Echelon/pull/951) Fix ShipStation split authority and queue false positives | Makes partial-package creation and quantity transfer atomic, repairs exact historical split evidence, and prevents canonical ShipStation identity from being mistaken for a second package. |
| [#955](https://github.com/cardshellz/Echelon/pull/955) Harden Shopify order ingestion recovery | Adds durable recovery ownership, oldest-first replay, paid/physical qualification, durable failures, Control Tower intake monitors, and pagination hardening. |
| [#957](https://github.com/cardshellz/Echelon/pull/957) Fix Shopify recovery source identity | Normalizes numeric Shopify IDs to GIDs, fixes source comparisons, drains raw orders before source polling, and exposes stage-specific failures. |
| [#958](https://github.com/cardshellz/Echelon/pull/958) Add durable channel order intake visibility | Adds the channel intake ledger, source capture for Shopify/eBay, backfill, per-channel status, and the `Sales channel observed -> OMS received` Control Tower stage. |

## Incident And Case Outcomes

### Paid Shopify Orders Missing WMS

Orders `#60237`, `#60238`, `#60279`, and `#60286` were paid but had zero WMS
authority because a duplicate-ingest race let stale line data overwrite the paid
event. PRs #910-#912 fixed the cause, replay path, and operator visibility.

The replayed orders were verified as reaching WMS:

| Order | WMS order |
| --- | ---: |
| `#60286` | `205423` |
| `#60279` | `205424` |
| `#60238` | `205425` |
| `#60237` | `205426` |

### Missing eBay Orders

These orders were absent from OMS, WMS, inbox, and retry state after an outage:

- `24-14885-40737`
- `15-14885-86879`
- `09-14896-18269`
- `25-14868-58537`
- `05-14903-41324`

The old poll used a four-hour lookback and had no persistent recovery boundary,
so an outage longer than that could permanently hide an order. PR #942 fixed
the systemic gap. All five orders were recovered through OMS, WMS, shipment,
and ShipStation creation during the incident response.

### Missing Shopify Range

Shopify orders `#60303` through `#60319` existed in raw source storage but had
not reached OMS/WMS. The prior recovery schedulers were disabled, channel
resolution failures could be swallowed, and attempted rows could be counted as
successfully bridged.

PRs #955 and #957 established one recovery owner and corrected Shopify source
identity. The range was verified after deployment as 17 candidates, 17
bridged, zero failed, with all 17 present in OMS/WMS and ready for warehouse
processing.

### ShipStation Replacement And Concession Cases

- Order `#59966` exposed crossed identity: original tracking
  `9434650106151100685645` had been overwritten with replacement tracking
  `9400150206217777416795`. The adoption flow now restores original identity
  before recording the replacement.
- Order `#59384` exposed the obsolete database constraint that required
  `order_item_id` even for a replacement. Migration
  `0589_outbound_shipment_item_purpose_authority.sql` fixes the authority model.
- Orders `#59826` and `#59875` exposed reconciliation that queried only a
  parent/internal ShipStation order ID and then mutated from one package.
  PR #947 fixes discovery and authority; historical rows must still be
  rechecked rather than assumed repaired.
- Order `#59834` exposed a false second-package interpretation when ShipStation
  reused the canonical Echelon order key. PR #951 fixes queue matching and
  stale review cleanup.
- ShipStation shipment `446104678` existed but the remediation UI could not
  find it because target lookup mixed shipment and order identity. PR #948
  makes target evidence exact-shipment-ID-based.

The conversation did not record a final successful operator submission for
every historical row above. Treat the code path as fixed and the row state as
unverified until it is re-read in production.

## Authority Rules That Must Not Regress

### Channel Intake

- Persist the channel observation before attempting OMS creation.
- One row represents one provider plus external order ID.
- Preserve the richest known raw payload when observations are merged.
- A failed order remains visible and retryable; do not advance a checkpoint as
  though it succeeded.
- Only physical, shippable orders count in the fulfillment funnel.
- Digital/non-shippable orders may be retained as source evidence but must not
  inflate operational backlog.

### Paid Event Replay

- Replay the exact canonical succeeded `orders/paid` inbox payload.
- Do not synthesize a replacement paid payload from current OMS state.
- Lock and deduplicate the replay scope.
- Show the operator whether the replay is queued, retrying, failed, blocked, or
  has actually reached WMS.

### ShipStation Identity

- The physical target is identified by exact ShipStation shipment ID.
- Tracking, order number, and provider order ID are corroborating evidence,
  not substitutes for target shipment identity.
- Sibling packages may be loaded only after the exact target is established.
- Voided, deleted, and active packages must not be collapsed into one fact.
- Fail closed when package identity or line authority is ambiguous.

### Shipment Item Purpose

- Customer fulfillment uses `order_item_id` authority.
- Replacement fulfillment uses `replacement_for_order_item_id` authority.
- Concession/free-item fulfillment uses `product_variant_id` authority.
- A replacement or concession deducts physical inventory but does not increase
  ordered quantity, customer fulfilled quantity, demand, revenue, reservation,
  or channel fulfillment.
- Only the explicitly confirmed quantities are deducted, and only from
  available/unreserved stock.
- Every adoption must remain idempotent and auditable.

## Current Channel Intake Architecture

Migration `152_channel_order_intake_ledger.sql` creates
`oms.channel_order_intakes` and the canonical
`oms.record_channel_order_intake(...)` function.

The ledger records:

- provider and channel identity;
- external order ID and human order number;
- first and latest observation method;
- source event/inbox identity;
- raw payload;
- physical/shippable classification;
- observed, processing, ingested, failed, or ignored status;
- observation and attempt counts;
- source, first-observed, latest-observed, failure, and ingestion timestamps;
- resulting OMS order ID and latest error.

Source coverage:

- Shopify raw/webhook storage is captured by database triggers.
- Shopify bridge and recovery paths update the same ledger record.
- eBay poll, webhook, and manual reingest record the complete source order
  before OMS processing.
- Migration backfill covers source orders from `2026-07-01` forward.
- Control Tower groups seen, OMS received, awaiting OMS, missing, failed, and
  latest observation by sales channel.

The Control Tower funnel labels are now:

- `Sales channel observed`
- `OMS received`
- subsequent WMS/shipment/channel stages

This is the requested visibility boundary. A channel order can now be visible
even when no OMS order exists yet.

## Code Map

| Area | Primary files |
| --- | --- |
| Channel intake ledger | `migrations/152_channel_order_intake_ledger.sql`, `server/modules/oms/channel-order-intake.service.ts` |
| Control Tower funnel/intake monitor | `server/modules/oms/flow-waterfall.service.ts`, `client/src/pages/FlowMonitor.tsx` |
| eBay ingestion/recovery | `server/modules/oms/ebay-order-ingestion.ts`, `migrations/145_ebay_order_ingestion_checkpoint.sql` |
| Shopify bridge/recovery | `server/modules/oms/shopify-bridge.ts`, `server/modules/orders/shopify-order-reconciliation.ts`, `server/modules/sync/shopify-bridge-wrapper.ts`, `migrations/147_shopify_order_bridge_checkpoint.sql` |
| ShipStation replacement/concession adoption | `server/modules/oms/shipstation-unmapped-remediation.service.ts`, `migrations/0587_shipment_replacement_authority.sql`, `migrations/143_shipment_concession_item_authority.sql`, `migrations/0589_outbound_shipment_item_purpose_authority.sql` |
| Split/shipment reconciliation | `server/modules/oms/ship-notify-reconciliation.service.ts`, related `ship-notify*.test.ts` files |
| Control Tower persistent queue/runbook | `docs/OPERATIONS-CONTROL-TOWER-RUNBOOK.md` and the `operations` schema migrations/services |

Focused tests are colocated under
`server/modules/oms/__tests__/unit/`, including:

- `channel-order-intake-ledger.test.ts`
- `flow-waterfall.service.test.ts`
- `flow-waterfall-invariants.test.ts`
- `shopify-order-bridge-recovery.test.ts`
- `shipstation-unmapped-remediation.service.test.ts`
- `ship-notify-reconciliation.service.test.ts`

## Test Baseline At Handoff

PR #958 reported:

- `npm.cmd run check`: passed.
- `npm.cmd run build`: passed.
- Focused intake/Control Tower tests: 33 passed.
- Full suite: 4,327 passed, 74 skipped, 8 todo.

Three full-suite failures were reported as pre-existing and unrelated to #958:

- `shipment-item-purpose-authority-migration.test.ts`
- `line-fulfillment-reconcile-classify.test.ts`
- `ship-notify-v2.test.ts`

Do not normalize those failures as permanently acceptable. Re-run them from
current `main`, determine whether they are still present, and either fix them
or document the exact current ownership.

Migration prefix collisions occurred during this week because concurrent work
used the same numeric prefixes. The merged names are now unique, including
`0587`, `0589`, `143`, `145`, `147`, and `152`. Always run the migration prefix
collision test before opening another database PR.

## Immediate Continuation Plan

### 1. Verify The New Source-To-OMS View

- Open the Control Tower after release `v2420` has completed startup and its
  projector/snapshot has refreshed.
- Confirm `Sales channel observed` appears before `OMS received`.
- Inspect the per-channel Shopify and eBay counts.
- Confirm digital/non-shippable orders are absent from every physical funnel
  stage.
- Open every `awaiting OMS`, `missing`, or `failed` source-order bucket and
  prove whether it is a live failure, a recoverable delay, or historical data.

### 2. Validate Ledger Population

- Verify migration `152` exists in production.
- Query `oms.channel_order_intakes` by provider, status, and `is_shippable`.
- Check that recent channel orders have source evidence even when OMS creation
  fails.
- Confirm the Shopify and eBay incidents above appear as ingested/recovered,
  not open failures.
- Confirm raw payload merging did not replace richer provider evidence with a
  thinner later observation.

### 3. Continue Current Shipment Exception Review

- Re-open the remaining `Split shipments we couldn't match up` rows.
- For each row, begin with exact provider shipment ID and current live
  ShipStation evidence.
- Distinguish normal split, true replacement, concession/free item, voided or
  deleted provider artifact, and actual malformed duplicate.
- Use the adoption flow only for a confirmed physical replacement/concession.
- Record the operator result and verify inventory movement and queue removal.
- Root-cause any row that cannot be explained; do not add another status-only
  workaround.

### 4. Recheck Historical Cases

- Recheck `#59966`, `#59384`, `#59826`, `#59875`, and `#59834` in current
  production.
- Confirm fixed rows disappear only because their authoritative state is now
  correct, not because a monitor stopped reporting them.
- If stale review rows remain, use the owning remediation workflow and retain
  the audit trail.

### 5. Close Test Debt

- Re-run the three reported baseline failures.
- Fix any failure caused by the new purpose-specific shipment authority.
- Keep migration prefix collision coverage green before every PR.

## Read-Only Verification Queries

Run through `heroku pg:psql` when local PostgreSQL tooling is installed, or use
an approved read-only application script.

```sql
SELECT
  provider,
  status,
  is_shippable,
  COUNT(*) AS orders,
  MAX(last_observed_at) AS latest_observation
FROM oms.channel_order_intakes
GROUP BY provider, status, is_shippable
ORDER BY provider, status, is_shippable;

SELECT
  provider,
  external_order_number,
  status,
  is_shippable,
  last_observation_method,
  oms_order_id,
  last_error,
  source_ordered_at,
  last_observed_at
FROM oms.channel_order_intakes
WHERE is_shippable IS TRUE
  AND oms_order_id IS NULL
  AND status IN ('observed', 'processing', 'failed')
ORDER BY COALESCE(source_ordered_at, first_observed_at);
```

These queries are evidence only. Do not update the ledger to hide a missing
order; repair the owning ingestion path.

## Resume On The Other Computer

After this handoff PR is merged:

```powershell
git clone https://github.com/cardshellz/Echelon.git
cd Echelon
git checkout main
git pull --ff-only origin main
Get-Content docs/OMS-WMS-CONTROL-TOWER-HANDOFF-2026-07-19.md
npm.cmd ci
npm.cmd run check
```

To inspect this branch before merge:

```powershell
git fetch origin
git checkout agent/oms-wms-control-tower-handoff-2026-07-19
git pull --ff-only origin agent/oms-wms-control-tower-handoff-2026-07-19
Get-Content docs/OMS-WMS-CONTROL-TOWER-HANDOFF-2026-07-19.md
```

Suggested first prompt in the new Codex task:

> Read `docs/OMS-WMS-CONTROL-TOWER-HANDOFF-2026-07-19.md` and the linked
> Control Tower/authority documents. Pull latest `main`, verify the current
> Heroku release and recovery flags, then inspect the new per-channel
> `Sales channel observed -> OMS received` view. Root-cause every current
> missing/failed physical order before continuing the ShipStation exception
> buckets. Do not mutate production without exact provider and authority
> evidence.

## Not Proven At Handoff Creation

- The initial production row counts in `oms.channel_order_intakes` were not
  captured in this document. Release `v2420` was verified, but the local
  machine did not have `psql`; query the table as the first production check.
- The Control Tower UI was not manually opened after the `v2420` deployment,
  so the first projector/snapshot refresh and rendered per-channel counts still
  need operator verification.
- The current production disposition of every historical ShipStation exception
  listed above was not re-read after the final deployment.
- The July 11 handoff's older unresolved cases should not be assumed resolved
  solely because later monitor taxonomy changed. Re-query authoritative source
  and domain state before acting.
