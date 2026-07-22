# Purchasing Hardening Turnover Handoff - 2026-07-19

This is the cold-start continuation record for the purchasing work completed in the
July 12-19, 2026 conversation. It supersedes the older handoffs for current status,
while those files remain the detailed history for earlier COGS, recommendation, and
PO-hardening decisions:

- `docs/PURCHASING-HARDENING-HANDOFF-2026-07-12.md`
- `docs/PURCHASING-HARDENING-HANDOFF-2026-07-13.md`
- `docs/PURCHASING-HARDENING-HANDOFF-2026-07-14.md`

## Fast resume

```powershell
git fetch origin
git switch main
git pull --ff-only origin main
git log -1 --oneline
```

Then read this file and inspect current deployment/migration state before making any
production change.

## Verified checkpoint

- Repository: `cardshellz/Echelon`
- Current `origin/main` during this turnover: `1185302b`
- Current production release during the read-only check: Heroku `v2420`
- Production release commit: `1185302b`
- PR #954 merge commit: `2805ab01`
- PR #954 deployed in Heroku `v2418`
- Production migrations 148-151: present in `public._migrations` on July 19
- Current handoff branch: `agent/purchasing-hardening-handoff-2026-07-19`
- No production data, configuration, or policy was changed while creating this file.

The app deployment is current with `origin/main`. A read-only production query also
confirmed all four purchasing migration records. Recheck current deployment and
migrations after pulling newer work rather than relying indefinitely on this snapshot.

## Continuation checkpoint - 2026-07-22

- PR #982 (`codex/rfq-quantity-overrides`) is merged at `c625bc9f`. Recommendation
  quantities can be adjusted during RFQ creation with required reduction reasons and
  approved excess-allocation evidence.
- PR #984 (`codex/demand-overlay-integrity`) and corrective PR #986
  (`codex/fix-demand-event-status-filter`) are merged and deployed. Production release
  `v2449` served the authenticated Demand Planner without the prior status-filter 500;
  migration `159_demand_event_integrity.sql` applied in release `v2447`.
- Supplier email/send, response comparison, award, and supplier communication remain
  intentionally deferred. Do not make that workflow the next build until the owner
  resumes it.
- Manual and scheduled recommendation runs, urgency/status classification, historical
  demand, future-demand events, and recommendation-to-RFQ conversion already exist.
- The next active hardening block is forecast measurement. Branch
  `codex/forecast-backtesting-foundation` starts from current `origin/main` and adds
  immutable full-population forecast observations to recommendation runs. RFQ
  candidate lines are selection-biased and cannot serve as the backtest population.
- The current recommendation query forecasts one product in base pieces across all
  warehouses. Its selected variant is a receiving configuration, not the forecast
  identity. Measurement must remain explicitly `product_all_warehouses` until the
  recommendation engine itself gains a warehouse-scoped demand and supply model.
- Migration `162_purchase_forecast_observations.sql` belongs to that branch. It starts
  collecting unbiased observations only for recommendation runs created after deploy;
  do not relabel legacy candidate-only runs as complete historical forecast evidence.
- No production mutation, policy change, demand event, recommendation run, RFQ, or
  automatic purchasing pilot was performed during this continuation.

Current source migration sequence:

- `148_purchase_rfq_requests.sql`
- `149_purchasing_forecast_policy.sql`
  - `150_purchase_recommendation_run_automation.sql`
  - `151_automatic_rfq_draft_policy.sql`
  - `152_channel_order_intake_ledger.sql` (newer, unrelated channel work)
  - `153_channel_order_intake_oms_linkage.sql` through
    `155_receipt_line_idempotency.sql` (newer cross-domain work)
  - `156_landed_cost_current_row_uniqueness.sql`
  - `157_procurement_usd_financial_authority.sql`
  - `158_rfq_allocation_override_evidence.sql`
  - `159_demand_event_integrity.sql`
  - `160_shipping_rate_charge_models.sql` (newer, unrelated shipping work)
  - `161_shipping_preload_cent_adjustment.sql` (newer, unrelated shipping work)
  - `162_purchase_forecast_observations.sql` (current branch; not deployed yet)

## Executive state

The purchasing foundation is now materially hardened:

- PO quote economics are explicit, exact, and line-specific.
- Ordinary PO mutations use strict transactional commands and durable idempotency.
- Optional PO-to-supplier-catalog capture is atomic.
- PO email uses a durable delivery outbox.
- AP payment and invoice lifecycle commands use the financial command ledger.
- PostgreSQL constraints, concurrency, recovery, and named-schema integration suites
  run in CI.
- `procurement.vendor_products` is the supplier catalog and supplier-evidence table.
- Historical PO evidence was recovered into that table and production identity issues
  were repaired with attributable audits.
- Purchasing recommendations now persist immutable run/line evidence.
- The demand engine produces exact SKU and base-piece requirements without requiring
  a supplier or price.
- The RFQ workbench sits above those requirements, supports partial/multi-supplier
  allocations, and can create/reactivate a supplier catalog mapping without a price.
- Scheduled runs can conservatively prepare draft-only RFQs when policy permits.

The major unfinished boundary is the RFQ lifecycle after draft creation. The schema
anticipates sent, quoted, accepted, and ordered states, but current `main` exposes only
the RFQ queue GET/POST flow. Sending, response capture, bid comparison, award, quote
promotion, and PO conversion still need first-class commands and UI.

## Non-negotiable design decisions

### 1. Required quantity is not price-driven

The recommendation engine answers:

> Which exact SKU do we need, at which warehouse, by when, and how many base pieces?

It uses demand and supply evidence, not supplier price, to calculate the requirement.
A missing preferred supplier or missing quote must not hide that requirement.

Price is introduced later:

1. demand/supply inputs produce an exact SKU/piece recommendation;
2. the immutable recommendation becomes an RFQ sourcing requirement;
3. a supplier is assigned, creating/reactivating its catalog mapping if necessary;
4. suppliers quote the requested quantity;
5. awarded quote economics become PO economics and, when reusable, supplier catalog
   evidence.

### 2. RFQ sits on top of the recommendation

The recommendation is immutable calculation evidence. RFQ lines are sourcing
allocations against it. Operators can:

- select some or all recommendation lines;
- request less than the recommended quantity with an attributable reason;
- split one requirement across multiple suppliers;
- create one consolidated multi-line draft RFQ per supplier; and
- see the already allocated and still remaining pieces.

Active RFQ allocation is guarded across recommendation runs by exact product,
variant, and warehouse identity. A newer run cannot silently duplicate sourcing
already covered by an active RFQ from an older run.

### 3. Supplier catalog mappings do not require price

`procurement.vendor_products` represents the relationship between a supplier and an
Echelon product/receive configuration. It can exist without a reusable quote. This is
essential for assigning a supplier during RFQ preparation.

The same table also retains reusable supplier evidence when available:

- vendor SKU and receive configuration;
- preferred status;
- reusable per-piece or per-purchase-UOM quote details;
- quote reference, quote date, and validity;
- MOQ, ordering increment, lead time, and purchase UOM; and
- exact last-paid evidence (`last_cost_mills` plus its compatibility cents mirror).

It is not a table of fabricated defaults. Missing supplier, pack, lead-time, or quote
evidence remains an explicit gap.

### 4. Supplier pricing basis is per line, not a PO-wide toggle

Vendors can quote different items differently. Each product line therefore captures
the quote as the vendor issued it:

- per piece;
- per supplier purchase UOM, with its pieces-per-UOM; or
- an extended total for a fixed quantity.

The server derives normalized per-piece economics and the line total with integer
arithmetic. The original quote and its provenance remain separately visible.

An extended-total quote is specific to that PO line and quantity. It must never be
written into `vendor_products` as reusable unit pricing. A reusable per-piece or
per-purchase-UOM quote can be captured in the supplier catalog when the operator
explicitly requests that action and supplies genuine dated evidence.

Saving a manual PO quote to the catalog does not relabel the current line as if it had
originally consumed catalog pricing.

### 5. RFQ confidence and PO price confidence are separate

A missing or expired supplier quote can be a reason to prepare an RFQ; it must remain
a blocker for automatic PO creation. RFQ demand confidence evaluates the demand and
lead-time evidence. PO automation additionally requires safe, current price and
supplier evidence.

### 6. Automatic RFQs are drafts only

The default RFQ automation mode is `manual`. The optional `preferred_vendor` mode can
prepare draft RFQs only for trusted requirements with an active preferred mapping and
a quote gap. It does not send an RFQ.

Current controls include:

- mode: `manual` or `preferred_vendor`;
- minimum demand confidence: `high` or `medium`;
- require trusted forecast: default `true`; and
- maximum lines per run: default `100`, bounded from 1 to 500.

Pilot mode suppresses RFQ automation. Do not enable or broaden unattended behavior
until the manual flow and one controlled SKU have been verified end to end.

## Recommendation engine and data flow

The current engine combines:

- exact product/variant/warehouse identity;
- on-hand, committed, inbound, and open purchasing supply;
- lead time and safety-stock coverage;
- short, standard, and long demand windows;
- a same-period-last-year seasonal component;
- paid, discounted, and free demand quality evidence;
- explicit future demand events within a configurable horizon; and
- minimum order/active-day evidence used for automation trust.

The default forecast method is `weighted_blend_v1`. Warehouse policy controls the
window lengths, four weights, seasonal enablement, future-demand horizon/confidence
weights, and minimum evidence thresholds. The four forecast weights must total 100.

The output is persisted as:

- `procurement.purchase_recommendation_runs`: version, as-of time, policy snapshot,
  input summary, source, and source idempotency key; and
- `procurement.purchase_recommendation_lines`: immutable SKU identity, required date,
  recommended pieces, preferred supplier snapshot, status, and calculation evidence.

Scheduled auto-draft runs persist that snapshot before downstream PO/RFQ mutation.
This prevents a scheduler result from disappearing and makes later sourcing decisions
traceable to the exact calculation.

## Current RFQ behavior

Implemented and merged:

- read the current RFQ requirement queue;
- surface requirements with no preferred supplier;
- select line items and adjust requested pieces;
- require a reason for quantity overrides;
- assign an existing supplier;
- create or reactivate that supplier's `vendor_products` mapping without price;
- split one recommended quantity across suppliers;
- consolidate selected lines into one draft RFQ per supplier;
- make RFQ batch creation idempotent;
- prevent over-allocation transactionally, including across recommendation runs;
- show active allocations and remaining pieces; and
- automatically prepare draft RFQs only under the conservative configured policy.

Present in the schema but not yet implemented as a complete operator workflow:

- send an RFQ through a durable delivery channel;
- record partial/complete supplier responses;
- capture comparable quotes, purchase UOMs, validity, MOQ, lead time, and exceptions;
- compare suppliers and landed commercial terms;
- accept or decline individual lines and supplier splits;
- promote reusable awarded quote evidence to `vendor_products` atomically;
- convert accepted quantities into idempotent draft POs; and
- close the loop from RFQ `ordered` status to PO identity and audit evidence.

As of `1185302b`, the application routes located for this feature are:

- `GET /api/purchasing/rfq-queue`
- `POST /api/purchasing/rfq-queue`

Do not mistake lifecycle columns in migration 148 for finished lifecycle commands.

## Merged work ledger

| PR | Merge commit | Result |
| --- | --- | --- |
| [#906](https://github.com/cardshellz/Echelon/pull/906) | `952a7d7b` | Published the July 12 purchasing hardening handoff. |
| [#913](https://github.com/cardshellz/Echelon/pull/913) | `e7a389a7` | Recovered the Heroku startup incident adjacent to this work. |
| [#914](https://github.com/cardshellz/Echelon/pull/914) | `e4555ac9` | Quote-aware PO lines, strict ordinary-line commands, purchase-UOM separation, and lifecycle guards. |
| [#917](https://github.com/cardshellz/Echelon/pull/917) | `60e67587` | Durable scoped financial command results and exact retries for PO-line commands. |
| [#918](https://github.com/cardshellz/Echelon/pull/918) | `6e1bcb33` | Atomic PO plus optional supplier-catalog capture. |
| [#921](https://github.com/cardshellz/Echelon/pull/921) | `46edf8cc` | Durable PO email outbox, retries, dead letters, and delivery visibility. |
| [#922](https://github.com/cardshellz/Echelon/pull/922) | `1c378717` | Disposable PostgreSQL hardening job in CI. |
| [#924](https://github.com/cardshellz/Echelon/pull/924) | `5bf413c5` | AP payment create/void moved to durable financial commands. |
| [#926](https://github.com/cardshellz/Echelon/pull/926) | `061dbe51` | AP invoice approve/dispute/void moved to durable financial commands. |
| [#927](https://github.com/cardshellz/Echelon/pull/927) | `5fd643c7` | Command monitoring, retention, and audited one-attempt dead-command recovery. |
| [#929](https://github.com/cardshellz/Echelon/pull/929) | `2dd60733` | Rebuilt named-schema integration fixtures and fixed the stale inventory constructor/import test. |
| [#931](https://github.com/cardshellz/Echelon/pull/931) | `50c6ef02` | Fail-closed, dry-run-by-default exact-SKU automatic-purchasing pilot command. |
| [#933](https://github.com/cardshellz/Echelon/pull/933) | `9fe4860c` | Made pilot evidence tooling runnable in Heroku's dependency environment. |
| [#935](https://github.com/cardshellz/Echelon/pull/935) | `77eee7e7` | Read-only purchasing readiness discovery and deterministic blocker ranking. |
| [#936](https://github.com/cardshellz/Echelon/pull/936) | `25e42129` | Exact supplier-remediation links from Purchasing into Suppliers. |
| [#939](https://github.com/cardshellz/Echelon/pull/939) | `e6a51464` | Exact demand evidence and fail-closed operator attestations in recommendation review. |
| [#940](https://github.com/cardshellz/Echelon/pull/940) | `89dda32d` | Strict, preview-hashed supplier evidence CSV import. |
| [#941](https://github.com/cardshellz/Echelon/pull/941) | `7fe44f8c` | Corrected PO quote capture into `vendor_products` with quote-basis safety. |
| [#943](https://github.com/cardshellz/Echelon/pull/943) | `b59398f8` | Recovered exact reusable/last-paid supplier evidence from existing production POs. |
| [#944](https://github.com/cardshellz/Echelon/pull/944) | `27c93f77` | Made historical `timestamp without time zone` evidence deterministic across timezones. |
| [#945](https://github.com/cardshellz/Echelon/pull/945) | `fca07306` | Database guard for PO vendor/product/receive-configuration catalog identity. |
| [#946](https://github.com/cardshellz/Echelon/pull/946) | `5824f762` | Safe legacy PO receive-configuration remediation command and production repair. |
| [#950](https://github.com/cardshellz/Echelon/pull/950) | `c4e3612e` | Fixed exact forecast-review browser/query/deep-link behavior. |
| [#954](https://github.com/cardshellz/Echelon/pull/954) | `2805ab01` | Scalable immutable recommendations, configurable forecast policy, multi-line/multi-supplier RFQ workbench, and price-free catalog assignment. |
| [#956](https://github.com/cardshellz/Echelon/pull/956) | `d4225734` | Stacked onto #954: durable scheduled runs and conservative automatic draft RFQs. Its commits were included before #954 merged to `main`. |

## Important CI corrections made during the week

These failures were fixed and should not be reintroduced:

- The financial command trigger initially treated a dead command as an immutable
  terminal row and blocked audited re-arming. Recovery now requires matching audit
  evidence in the same transaction and grants exactly one additional attempt.
- Concurrent operator recovery is serialized so only one request can grant that
  attempt.
- The named-schema inventory integration test imported a type-only/interface-shaped
  `InventoryRepository` as a constructor. The harness/import topology was updated to
  the current implementation and schemas.
- Purchasing originally introduced migration prefix `147`, colliding with
  `147_shopify_order_bridge_checkpoint.sql` after newer `main` merged. Purchasing
  migrations were renumbered to 148-151 and the collision guard is green.
- RFQ allocation originally guarded only one recommendation-line ID. It now
  serializes against exact SKU demand identity across runs, preventing a newer run
  from duplicating an older active RFQ.
- Writer-ratchet baselines were updated for the four intended procurement tables.

Final #954 validation recorded before merge:

- TypeScript check passed.
- Production build passed.
- Broad purchasing/job gate: 807 tests passed and 14 skipped.
- Focused migration gate: 5 passed and 5 disposable-database cases skipped locally.
- Both GitHub required checks, including PostgreSQL hardening, passed before merge.

## Production data work already executed

### Historical supplier evidence

The approved historical PO backfill, excluding vendor 101 (`Test Vendor`), committed:

- 5 `vendor_products` mappings created;
- 16 mappings updated with exact last-purchase evidence;
- 16 historical PO lines linked;
- 2 conflicting links initially skipped;
- 1 zero-cost placeholder excluded; and
- 21 attributable source-evidence audit events.

A timezone defect was then found because both source and target used PostgreSQL
`timestamp without time zone`. A bounded repair corrected all 21 written timestamps
from canonical database wall-clock text and wrote 21 repair audits. Verification
reported zero timestamp mismatches.

The two remaining vendor/product conflicts were later reviewed and repaired:

- PO line 153: vendor-product 25 -> 125;
- PO line 163: vendor-product 11 -> 124.

Post-repair verification reported zero vendor/product mismatches.

### Legacy PO receive configuration

After PR #946 deployed, the explicitly approved transaction:

- stamped 10 PO lines from their linked supplier mapping;
- relinked 1 line to the evidence-backed active 750-count mapping;
- wrote 11 distinct audit events; and
- left receipts, received quantities, costs, inventory, and supplier prices
  unchanged.

The postcondition preview returned zero candidates.

Never reuse an old preview hash for any remediation. Regenerate the preview after the
current deployment, review its exact evidence, and obtain explicit approval for the
new hash.

## Production/read-only evidence

- Exact-SKU preflight for `QUAD-BOX-TOP` returned one recommendation and made no
  writes. It was correctly ineligible under `high_confidence_only`.
- A broader audit found 278 recommendations and zero policy-eligible automatic PO
  candidates at that snapshot.
- The readiness command found 32 actionable candidates, all requiring supplier
  configuration and demand review.
- Read-only durable checks found zero automatic-draft lifecycle runs, zero automatic
  POs, and zero recommendation-to-PO handoffs at that snapshot.
- The authenticated Purchasing -> Supplier Setup Gaps link for `QUAD-BOX-TOP` passed.
- The authenticated forecast-review deep link initially exposed a real browser/query
  defect; PR #950 fixed it.

There is no evidence in this conversation that a production automatic-purchasing
pilot or a production #954 RFQ batch was executed. Do not claim either occurred.

## Recommended next implementation order

### 1. Verify the deployed foundation read-only

On current `main` and Heroku release:

1. reconfirm migrations 148-151 after any newer release and inspect their
   tables/constraints;
2. repeat the authenticated exact forecast-review smoke from PR #950;
3. open the Purchasing RFQ workbench and verify a current recommendation run/queue;
4. verify missing-supplier recommendations remain visible; and
5. inspect scheduler/job logs for recommendation-run and RFQ-draft errors without
   changing RFQ policy.

### 2. Smoke the manual recommendation-to-RFQ workflow

Use a reviewed, low-risk requirement and explicit owner approval for any production
write. Prove:

- exact SKU/warehouse/piece quantity and calculation evidence;
- selection of a partial quantity with a reason;
- assignment of a supplier with no price;
- creation/reactivation of the exact catalog mapping;
- one multi-line draft per supplier;
- multi-supplier split and remaining-piece calculation;
- exact idempotent replay; and
- cross-run allocation protection.

Keep RFQs as drafts and do not enable automatic sending.

### 3. Build the RFQ lifecycle as the next major product slice

Recommended command boundaries:

1. **Send**: immutable document/recipient snapshot, transactional outbox, idempotency,
   retries, delivery status, and operator recovery.
2. **Respond**: line-level quote capture for partial responses, declined lines,
   per-piece or purchase-UOM basis, validity, MOQ, lead time, currency, freight/terms,
   attachments/references, and attributable source evidence.
3. **Compare and award**: normalized economics plus non-price terms, explicit split
   award, remaining quantity, approval thresholds, and conflict-safe concurrency.
4. **Promote evidence**: atomically update the exact `vendor_products` mapping only
   for reusable awarded quote economics; retain the original RFQ response.
5. **Create PO**: idempotent accepted-RFQ-to-draft-PO transaction with immutable
   RFQ-line/PO-line linkage, exact quantities, quote provenance, and no duplicate PO.
6. **Close/expire/cancel**: durable state transitions, reasons, audit, and release of
   active allocations where appropriate.

Do not implement lifecycle transitions as generic table patches. Use strict commands,
row locks, optimistic/concurrency guards, durable command results, and immutable
events consistent with the rest of the hardening work.

### 4. Expand forecasting without creating another purchasing writer

Current weights, seasonality, and explicit future-demand events are a sound boundary,
not the end of forecasting. Add versioned scenarios and backtesting around the same
recommendation-run contract:

- promotions, channel plans, product launches, and known one-time events;
- scenario ownership, effective dates, approval, and audit history;
- forecast-versus-actual accuracy by SKU/warehouse/horizon;
- bias/drift monitoring and policy rollback;
- model/weight comparison against a baseline; and
- explainable contribution evidence stored with every run.

All scenarios should feed the same immutable recommendation engine. They must not
create a parallel PO or RFQ writer.

### 5. Run controlled pilots before widening automation

After the manual RFQ lifecycle works:

1. run one manual recommendation -> RFQ -> response -> award -> draft PO lifecycle;
2. verify catalog evidence, quantities, financial precision, audits, and cancellation;
3. run the existing exact-SKU automatic PO pilot only when a genuinely eligible SKU
   appears and the owner explicitly approves execution;
4. separately enable automatic RFQ draft mode for a bounded preferred-supplier case;
5. keep send and PO approval manual until evidence supports broader policy.

## Important files

Recommendation and RFQ core:

- `server/modules/procurement/purchasing-recommendation.engine.ts`
- `server/modules/procurement/purchasing-recommendation-context.service.ts`
- `server/modules/procurement/purchasing-recommendation.run-detail.ts`
- `server/modules/procurement/purchasing-recommendation.routes.ts`
- `server/modules/procurement/purchase-recommendation-snapshot.service.ts`
- `server/modules/procurement/automatic-rfq-draft.service.ts`
- `server/jobs/auto-draft.job.ts`
- `server/modules/procurement/purchasing.service.ts`
- `shared/schema/procurement.schema.ts`

Client:

- `client/src/pages/PurchasingView.tsx`
- `client/src/components/purchasing/ExclusionRulesModal.tsx`

Migrations:

- `migrations/148_purchase_rfq_requests.sql`
- `migrations/149_purchasing_forecast_policy.sql`
- `migrations/150_purchase_recommendation_run_automation.sql`
- `migrations/151_automatic_rfq_draft_policy.sql`

Supplier evidence and remediations:

- `server/modules/procurement/supplier-evidence-import.service.ts`
- `server/modules/procurement/historical-po-supplier-evidence-backfill.service.ts`
- `server/modules/procurement/legacy-po-receive-config-remediation.service.ts`
- `docs/AUTOMATIC-PURCHASING-PILOT-RUNBOOK.md`

## Useful validation commands

```powershell
npm.cmd run check
npm.cmd run build
npm.cmd test
npx.cmd vitest run server/modules/procurement
git diff --check
```

Operational commands are dry-run/read-only by default unless their explicit execute
flags are supplied:

```powershell
npm.cmd run procurement:automatic-purchasing-pilot -- --list --limit=25
npm.cmd run procurement:automatic-purchasing-pilot -- --sku=EXACT-SKU
npm.cmd run procurement:backfill-historical-supplier-evidence -- --exclude-vendor-id=101
npm.cmd run procurement:remediate-legacy-po-receive-config
```

Never point disposable integration tests at production. They require both a separate
`ECHELON_TEST_DATABASE_URL` and the repository's explicit disposable-database
acknowledgment.

## Safety and operating constraints

- Pull and inspect current `main` before continuing; unrelated work has continued to
  merge after #954.
- Do not mutate production, execute a pilot, enable policy, send an RFQ, or deploy a
  migration without explicit owner approval.
- Do not invent supplier identity, price, MOQ, pack, lead time, demand, or quote date.
- Do not weaken forecast/demand controls to manufacture an eligible candidate.
- Do not use price to suppress or calculate the underlying SKU/piece requirement.
- Do not write extended-total PO quotes into reusable supplier catalog pricing.
- Keep the current line's manual provenance even when its reusable quote is also
  captured in the catalog.
- Treat PO email as honest at-least-once delivery with durable visibility; SMTP does
  not provide mathematical exactly-once delivery across the provider/database
  boundary.
- Preserve append-only recommendation/RFQ evidence and cancel with an attributable
  reason instead of deleting history.

## Cold-start resume prompt

> Pull current `origin/main` and read
> `docs/PURCHASING-HARDENING-HANDOFF-2026-07-19.md`, including the July 22
> continuation checkpoint. Verify the current branch, Heroku release, and migrations
> read-only. PR #982 is merged; recommendation-to-RFQ quantity overrides are complete.
> Supplier communication remains deferred. Resume the demand-overlay integrity and
> operator workflow from `codex/demand-overlay-integrity` if it is still open, or
> verify its merged/deployed state before proceeding. Do not mutate production, enable
> automation, create demand events/RFQs, or execute a purchasing pilot without explicit
> owner approval.
