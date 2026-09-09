# Inventory reconciliation batch — September 9, 2026

## PR publication update

The user subsequently requested publication. This isolated branch was refreshed
to `75c6159dbfc0e0fbe0f7a87d55521c8da7b2652a` (merged PR1427). None of the 52
incoming paths overlapped this ten-file batch, and SHA-256 checks confirmed all
ten batch files were unchanged during the fast-forward. The unrelated shipping
work is part of the base, not this PR's change set.

Fresh publication validation passed: **11,721 unit tests, 37 skipped, across
1,000 passing files and one skipped file; 50 PostgreSQL tests across four suites;
typecheck; production build; and four explicit writer/migration guard assertions.**
Logs are retained locally as `.codex-artifacts/shipment-pr-{unit,postgres,typecheck,build,guards}.log`.
The task-owned PostgreSQL cluster was verified to have no other clients and was
stopped after testing. Remote CI is separate from these local results.

The implementation and production observations below remain the original
September 9 record against `3b1bbcd31`; no production census, configuration write,
provider action, or activation was performed during PR publication. Do not use
the retained investigation snapshot as current activation approval.

## Implementation outcome — before PR publication

One local shipment-correctness batch is implemented and validated. A fresh,
read-only cutover census and consolidated evidence package are also complete.
**Canonical authority is still inactive; this batch does not clear historical
exceptions or perform production reconciliation.** No commit, push, PR,
deployment, provider request, or production mutation was performed in this turn.

The isolated worktree is `C:/Users/owner/Echelon/worktrees/inventory-cutover-reconciliation-batch`,
branch `codex/inventory-cutover-reconciliation-batch`, based on refreshed
`origin/main` at `3b1bbcd31b07d869bdb0255f1c113cb431bc3f95`.
PR1426 is merged at that commit; all three GitHub checks passed. Heroku release
v2896 successfully deployed `3b1bbcd3` on September 9 at approximately 18:07 UTC.
The original checkout's unrelated catalog/UOM changes were not edited.

## What the code definitely does

Paths and lines below refer to this worktree. Historical baseline references are
explicitly identified; local changes are not represented as deployed behavior.

### Confirmed live-code defect and local correction

At baseline `3b1bbcd31`, `InventoryUseCases.recordShipmentInsideTransaction`
selected picked versus on-hand stock, honored `deductFromOnHandOnly` and
`releaseReservation: false`, then passed **only total quantity** to
`InventoryLotService.shipFromLots`. The lot service independently depleted
picked lots first, then on-hand lots with reservation release. It never rejected
an unsatisfied final remainder. Therefore the two layers could consume different
buckets, and incomplete lot work could commit with the aggregate debit.

This is demonstrated code behavior, not attribution of a particular historical
production discrepancy to that writer.

| Local change | Exact implementation / proof |
| --- | --- |
| Aggregate and lot writers share the exact `fromPicked`, `fromOnHand`, and `reservedToRelease` amounts. | `server/modules/inventory/application/inventory.use-cases.ts:737`, `recordShipmentInsideTransaction`; explicit lot call at `:809`. Replacement's already-picked split is passed at `:996`. |
| New shipment journals record the actual reservation counter delta, including explicit zero. Existing total shipment/on-hand snapshot semantics remain unchanged. | Same file `:837` and `:1015`. No historical journal update or new migration. |
| A pure validated plan exhausts each authorized bucket, protects remaining reservations, and fails before lot updates on any shortfall. | `server/modules/inventory/domain/shipment-lot-depletion.ts:55`, `planShipmentLotDepletion`; shortage rejection at `:103`. |
| FIFO ordering is deterministic within each bucket: received time, then lot ID. Releasing a specified reservation can require a newer reserved lot before an older unreserved lot. | Same planner `:64`, `:87`, `:96`. It does not infer an order-to-lot identity. |
| The lot writer locks nonempty rows by ID, plans completely, then applies compare-and-set updates and checks the complete returned row count. | `server/modules/inventory/lots.service.ts:571`, `shipFromLots`; planning at `:601`, update result at `:620`. Empty historical lots do not exhaust the 10,000 nonempty-lot bound; negative balances remain subject to validation. |
| Aggregate debit, lot debit, and journal share the caller transaction; late journal/CAS failures roll back the full shipment. | `recordShipment:728`; `server/modules/inventory-planning/infrastructure/inventory-availability-runtime-shipment.repository.ts:31`, `PostgresInventoryShipmentRuntimeExecutor.execute`; real tests below. |
| Production composition supplies the lot owner. Canonical shipments continue using their existing canonical dispatcher rather than this legacy writer. | `server/services/index.ts:169–172`, `createServices`; `server/modules/inventory-planning/application/inventory-availability-runtime-shipment.service.ts:69`, `AuthorityAwareInventoryShipmentRecorder.recordShipment`. |
| Ingress preserves a failed inventory posting as an explicit failure rather than claiming successful inventory reconciliation. | `server/modules/oms/channel-fulfillment-ingress.service.ts:155`, `recordInventory`, and `:125`, failure context containing the underlying code; ShipStation propagates the deduction error in `recordInventoryForShipment`, `server/modules/oms/shipstation.service.ts:2508–2584`. |

Concrete example, matching the real PostgreSQL regression:

- Before: on-hand **5**, reserved **3**, picked **2** at both the level and lot.
- Ship two never-picked units: both become on-hand **3**, reserved **1**, picked **2**.
- Ship two unreserved concession units instead: both become **3 / 3 / 2**.
- Ship two already-picked units instead: both become **5 / 3 / 0**.
- If the required lot bucket cannot supply the request, neither layer nor its
  journal commits. The provider's physical shipment fact is not undone by this failure.

### Validation

| Check | Final result |
| --- | --- |
| Full unit suite, `npm run test:unit -- --maxWorkers=4` | **11,682 passed, 37 skipped; 996 files passed, 1 skipped.** |
| Actual PostgreSQL shipment parity, legacy authority fence, runtime shipment routing, and full cutover composition | **50 passed, zero skipped**, across four suites. |
| `npm run check` and `npm run build` | Passed. Existing large-client-bundle warning remains. |
| Explicit writer-ratchet and migration-prefix guards | **4 passed**. No baseline expansion or migration. |
| `git diff --check` | Passed. |

`server/modules/inventory/__tests__/unit/shipment-lot-depletion.test.ts` covers
each bucket, mixed allocation, deterministic ordering, invalid inputs, maximum
integer quantities, immutable inputs, and exhaustive small-request conservation.
`server/modules/inventory/__tests__/integration/shipment-lot-parity.integration.test.ts:58`
covers actual aggregate/lot/journal parity; `:71` shortages; `:91` census bounds;
`:104` late journal rollback; `:112` partial CAS rollback; `:123` retries;
`:129` competing shipments; `:140` retained transaction/lot locks; `:159` authority.
The existing replacement unit regression verifies its exact bucket call.

The PostgreSQL fixture uses actual owner services and Drizzle against reduced
named schemas, not a complete production clone. The broader cutover-composition
suite exercises its existing real migrations and mocked provider transport.
The new parity suite is registered in CI. Remote CI has not run for this local batch.

## Consolidated production evidence — not an execution manifest

The inventory snapshot was captured **2026-09-09T18:13:59.580Z**, before this local
fix, through `PostgresInventoryCutoverReconstructionRepository.capture:33` and
`planCutoverReconstruction:35`. One REPEATABLE READ, READ ONLY transaction covered
the census. Writer ports were forbidden; provider calls were not available.

Evidence hash: `fbb2b6f18a5b66334151e4177da780f25e538f3ff10792c926a902a34be29393`.
This is an investigation snapshot, not fresh activation approval.

### 1. Current inventory and historical custody

| Measure | Snapshot result |
| --- | ---: |
| Current inventory levels / captured lots | 341 / 2,371 |
| Proposed current orders / lines | 117 / 268, all warehouse 1 |
| Lines with reserved / picked / fresh demand | 266 / 0 / 3; these categories can overlap |
| Journal owner-position groups | 27,311 |
| Unknown journal groups | 18,871 across 312 variant/location keys |
| Unknown groups with zero / nonzero signed reservation or picked residual | 15,086 / 3,785 |
| Levels differing from lot sums: on-hand / reserved / picked | 2 / 30 / 2 |
| Levels with reservations greater than on-hand | 18 |
| All overlapping planner blocker flags | 39,300; **not 39,300 independent incidents** |
| Source-review rows / distinct outbound shipments | 3,333 / 1,721 |
| Physical-review rows / distinct physical packages | 40 / 19 |
| Uncovered accepted OMS demand rows | 68 |
| Eligible whole-position empty-bin promise handoffs | 0 |

The complete offline grouping covers **484 distinct variant/location keys** across
all current levels, retained lots, and journals, including historical keys without
a current level. It preserves every journal group, level and lot exactly once;
unknown warehouse/owner identities remain null rather than guessed. Shipment and
OMS cases remain separate linked evidence rather than merging unrelated owners.

Two concrete current counter discrepancies:

| Level / location / variant / SKU | Aggregate on-hand / picked | Lot sum on-hand / picked |
| --- | --- | --- |
| 1054 / 1201 / 179 / SHLZ-BNDR-TOP-BLK-P1 | 3 / 10 | 4 / 9 |
| 1949 / 1170 / 265 / EG-SLV-STD-5PCK-B500 | 9 / 23 | 10 / 22 |

These observations do **not** establish which counter reflects physical stock.
They must not be repaired by selecting the more convenient number.

A separate bounded read-only journal query found 24,717 missing-reservation-delta
records: 11,573 picks, 1,224 unreserves, and 11,920 reserves. Their latest timestamps
were July 2, July 2, and July 3 respectively. Historical transaction 15506 records
order 53468 with item 29435, whose stored parent is order 46833. This is an actual
conflict, not a NULL that exact foreign-key completion can fill.

The current planner deliberately blocks unknown journal custody even at zero
signed residual (`inventory-cutover-reconstruction.ts:241–250`), terminal residuals
(`:134`), and unexplained level/lot ownership (`:289–299`). Grouping does not relax
those checks. Original lot costs are not reconstructed from today's FIFO.

### 2. Outstanding eBay publication evidence

The same snapshot retains attempts **2729, 3237, 4416, 4417, 6523, 7495, 7531, 7600,
7603** as running or uncertain, all for channel 67 / connection 34. Their exact
SKU/scope rows are retained in the grouped package. No recovery was submitted.

The earlier correlated provider rejection logs remain investigation evidence,
not proof of every transport attempt's terminal outcome. The existing recovery
contract requires either provider terminal-request evidence or owner-process and
request-termination evidence, an authenticated actor, reason, hash and idempotency
key (`shared/types/inventory-publication-recovery.ts:9–17`). Clearing attempts can
permit background publication catch-up; it is a production action.

### 3. Channel/source and safety configuration

The inventory snapshot has zero canonical targets, source-binding heads,
mapping heads, or exposure-policy heads. Non-secret routing identities and draft
safety pointers were refreshed separately at **18:39–18:40 UTC** in read-only
transactions; these later observations are not the earlier census snapshot.

| Destination | Verified current identity | Proposed cutover treatment, not saved |
| --- | --- | --- |
| Shopify US | Channel 36, connection 4, `card-shellz.myshopify.com`, location 67892347039; warehouse 1 enabled, 34 disabled | Exact destination target with LEON as its reviewed Echelon-owned source. |
| Shopify Canada | Channel 37, connection 5, `cardshellz-ca.myshopify.com`, location 94220746788; warehouse 35 enabled | Preserve external control; do not publish LEON inventory into ShipMonk's location. |
| eBay Card Shellz | Channel 67, connection 34; no warehouse assignment; retained request account scope `uvchzdfrtkc` | Exact account target. Warehouse source selection is awaiting the user's answer; no all-warehouse fallback. |
| Dropship eBay | Store connection 1 / vendor 1, connected and ready, production provider-user identity verified September 6 | Separate `dropship_store_connection` destination with its own account identity and reviewed source binding/policy channel; never reuse Card Shellz's eBay credentials or target. |

LEON node 1 / warehouse 1 and SM-CA node 2 / warehouse 35 are both draft. LEON's
inventory/fulfillment authority is Echelon; SM-CA's is external provider. SM-CA's
provider-account/location registry pointers are null. Draft business safety
policy 1 is `fixed_units: 0`, with no active safety head. This is observed draft
configuration, not an instruction to activate zero safety everywhere.

The mapping review found 204 physical, tracked, active, sellable US Shopify feeds;
five have no stored inventory-item ID: variants **205, 208, 463, 464, 509**. One US
physical feed is quarantined. Do not exclude variant 509 merely because its SKU
contains `TEST`; its recorded eligibility is physical and sellable. Resolve exact
provider identities and the quarantine before approving the managed set.

Canada has 12 such feeds, ten without stored inventory-item IDs; preserve its
external-control boundary. eBay has 194 physical feeds with external SKUs but
without Shopify-style inventory-item IDs. Those null IDs alone are **not proof
of missing eBay identity**; use the adapter's SKU contract and exact account scope.
No provider listing was read or changed in this turn.

## What is likely happening / what is not proven

**HYPOTHESIS:** the mismatched legacy shipment bucket writer can contribute to
current level/lot differences. Reproduction proves the mechanism, not the cause
or correct physical quantity for levels 1054 and 1949.

Historical missing deltas/owner conflicts, current physical custody, original cost
lineage, external request termination, and the exact missing provider mappings
are not resolved by this code change. No claim is made that another deployment
alone will make the cutover ready.

Risks and compatibility: inconsistent lot evidence now produces a visible,
atomic shipment failure instead of partial success. Existing ingress review and
retry handling retains that failure. This may expose additional operational
exceptions; it must not be bypassed by replaying old shipments to fabricate costs.
The legacy FIFO pool still does not prove exact historic order-to-lot ownership;
canonical claim dispatch is unchanged. No COGS ledger is rewritten, no historical
shipment is replayed, and no picker workflow or customer order is edited.

## Next checks and execution boundary

1. Review/publish this one shipment-correctness batch. It prevents the demonstrated
   new bucket inconsistency; it does not automatically repair old records.
2. Use the single grouped evidence package to reconcile **current** inventory,
   active demand, and physical shipment custody, preserving historical exceptions
   and original cost evidence. Any proposed counter adjustment needs an exact
   before/after preview and explicit production approval through its owner.
3. Resolve the nine provider attempts through the existing reviewed recovery
   service only when the required terminal evidence and operator authorization exist.
4. Prepare the whole channel configuration manifest together: exact destinations,
   warehouse source bindings, per-physical-SKU mappings, chosen safety mode and
   exposure dials. Preserve Canada/3PL authority and separate Dropship accounts.
5. Capture a fresh full cutover review, then use the existing fenced commit and
   latest-publication verification workflow. No historical blocker exemption,
   opening-balance reset, canary rollout, new checkout block, or live activation
   was added or approved here.

## Local evidence retention

All paths below are under this worktree's `.codex-artifacts/` and are deliberately
not source-controlled:

- `current-cutover-readonly.ts` and `current-cutover-readonly-20260909.json`: actual
  read-only capture, strict evidence and complete planner result.
- `group-cutover-evidence.ts` and `grouped-cutover-review-20260909.json`: offline
  grouping; checks the original evidence hash and exact group/level/lot coverage.
- `channel-configuration-readonly-20260909-verified.log` and
  `channel-mapping-scope-readonly-20260909.log`: bounded non-secret configuration facts.
- `shipment-full-unit-final.log`, `shipment-postgres-final-verified.log`,
  `shipment-typecheck-final.log`, `shipment-build-final.log`, and
  `shipment-architecture-guards.log`: final local verification.

Tests used the task-owned disposable PostgreSQL 17 cluster on `127.0.0.1:55443`,
with `ECHELON_TEST_DATABASE_DISPOSABLE=true` and unique per-suite databases.
Production credentials were never used for tests. Test data and logs are retained;
the task cluster is stopped after verification.
