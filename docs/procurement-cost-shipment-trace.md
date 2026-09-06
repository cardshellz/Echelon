# Shipment cost source and application audit

Baseline: `d836adc228897ca16f0dbb2416d15a2f7e6a36db` (after receiving unit integrity, PR #1387). All source references below refer to this checkout. This is a read-only design audit; only this note was added. No production business records were queried, no financial writers were changed, and no deployment was performed.

Read together with `docs/procurement-receiving-cost-followup.md`. Its older line references predate the receiving quantity work. The current receipt schema now has exact shipment-line identity and a frozen conversion; the shipment financial application still does not consume either field.

## What the code definitely does

### 1. Allocation and finalization own a mutable current snapshot

- `runAllocationInTransaction` selects shipment lines and charge rows under a shipment-header lock. Each charge uses `actualCents ?? estimatedCents ?? 0`; negative values fail with `INVALID_LANDED_COST_AMOUNT`. It distributes integer cents through `allocateCentsByBasis`, with a deterministic largest-remainder tie break by line ID. See `server/modules/procurement/shipment-tracking.service.ts:58–100, 937–1005`.
- Allocation reads the current PO line's rounded `unitCostCents`, defaults absent PO cost to zero, calculates the all-in cents projection, deletes current allocations, and rewrites allocation rows and shipment-line mirrors. It does not capture an immutable PO component-cost version. See `shipment-tracking.service.ts:1028–1079`.
- `finalizeAllocationsInTransaction` permits `costing` or `closed`, checks missing dimension issues, and reruns allocation. It builds a snapshot per exact shipment line using charge category totals and current PO cents. An unchanged snapshot preserves its existing row; a changed set deletes all current shipment snapshots and creates replacements. Closed changes record an amount-only adjustment. See `shipment-tracking.service.ts:1440–1573`.
- `landed_cost_snapshots` has one current row per non-null shipment line, cents-based values, quantity, and timestamps. It has no revision, currency, original charge versions, full immutable inputs, or application state. Adjustments have amount/reason/actor but no before/after source revision. See `shared/schema/procurement.schema.ts:1704–1740`; deletion is `procurement.storage.ts:1254–1258`.
- Estimated charges and wholly unknown amounts can enter a snapshot through the effective-amount expression. The inspected finalization gate checks status and missing dimensions, not that every charge has a final actual amount. Currency/FX is absent from the snapshot and allocation computation; the generic charge command's USD guard is not a historical-currency conversion mechanism. See `shipment-tracking.service.ts:973, 1444–1471`; `shared/procurement/shipment-cost-command.ts:28–30`.

### 2. Closing and applying to inventory are separate phases

`close` commits finalization, the closed header, and status history in one transaction. It then invokes `pushLandedCostsToLots` separately. Thrown push failures are logged; its returned skipped records are not included in the close response. A closed shipment therefore proves procurement closure, not completed inventory valuation. See `shipment-tracking.service.ts:734–769`.

The push:

1. Locks the shipment header and selects only lots whose shipment ID matches and `cost_provisional = 1`. It includes depleted lots, because no lot-status condition is applied. See `shipment-tracking.service.ts:1582–1592`; `procurement.storage.ts:1283–1288`.
2. Reads exact shipment-line snapshots but pools their quantities and freight/duty/insurance/other totals by PO line. A finalized row for a PO line can mask an unfinalized sibling because the unfinalized set is only examined when the finalized map has no entry. See `shipment-tracking.service.ts:1593–1640, 1663–1670`.
3. Uses each lot's current catalog variant factor, not its receipt's frozen factor. It clamps the combined non-product charge to zero and also clamps/truncates inputs in `computeLotLandedMills`. See `shipment-tracking.service.ts:44–55, 1613–1621, 1680–1691`.
4. Preflights all candidate lots. Any skipped mapping blocks the whole batch with a successful `{updated:0, skipped:[...]}` result. Otherwise it calls transactional COGS once per candidate. See `shipment-tracking.service.ts:1643–1737`.
5. Relies on clearing `cost_provisional` to suppress later calls. There is no durable `(lot, source revision)` receipt, expected application version, or claim that a changed finalized source should reapply to already-finalized lots. The manual route does not pass an actor or a durable command descriptor. See `inbound-shipment.routes.ts:404–431`.

The source lookup used by receiving remains PO-line-only `LIMIT 1`, and its mills variant re-reads current PO mills. Neither is a stable exact shipment-line component source. See `procurement.storage.ts:1234–1236`; `shipment-tracking.service.ts:1744–1770`.

### 3. COGS has a useful transaction boundary, but no application identity

`updateLotLandedCostMills` delegates to `revalueLotCostMills`, which locks the lot, preserves unspecified product/packaging layers, validates every layer as nonnegative, updates lot mills/cents, clears provisional by default, recosts matching `oms.order_item_costs`, and inserts an adjustment log. It does not receive the shipment revision, actor, expected component version, or immutable lineage proof. It writes an adjustment even for a repeated equal-value landed call. See `server/modules/inventory/cogs.service.ts:207–310, 488–498`.

The COGS cascade only follows `oms.order_item_costs.inventory_lot_id`; it does not traverse transfer, conversion, or build descendants. See `cogs.service.ts:150–204`. AP reconciliation locks lots in ascending ID, uses the live variant factor, and calls the same revalue method without `clearProvisional:false`, so a changed product reconciliation can clear freight-pending state. See `cogs.service.ts:568–638`.

The existing durable command mechanism is reusable rather than inventing another replay system: `shipment-cost-commands.ts:58–78` validates owner scope and actor and executes the domain transaction through `runTransactionalFinancialCommand`. Finalize/push currently bypass this wrapper. Its exact new command scope and result DTO remain a design decision, not an implemented contract.

### 4. Receipt identity is now available for original receipt lots

- `receiving_lines.units_per_variant_snapshot` and `inbound_shipment_line_id` are persisted, legacy-null, and guarded by the quantity owner. See `shared/schema/procurement.schema.ts:395–424`.
- `receiveInventory` replay-checks the exact receiving line before any balance/lot write, creates a lot if a lot service is installed, and records `receivingLineId` plus the exact `inventoryLotId` on the receipt ledger row. See `server/modules/inventory/application/inventory.use-cases.ts:166–185, 212–264`.
- The lot itself retains only receipt-header/PO/shipment-header/PO-line IDs, not receipt-line ID or a frozen factor. See `shared/schema/inventory.schema.ts:903–955`; `lots.service.ts:92–169`.

For original lots, a bounded loader can prove an exact path through a non-voided `receipt` transaction, receiving line/header, and shipment line. It must reject multiple conflicting receipt rows, missing lots, header/product/source mismatches, or unknown unit evidence. The existing receiving unit resolver offers a narrowly proven closed-history posting-ratio fallback; current catalog data is not evidence of an old receipt's factor. Neither a closed receipt nor shared SKU/PO line alone proves a particular lot mapping.

### 5. Transfers preserve header provenance but lose exact lineage

`InventoryLotService.transferLots` prepares one layer per source lot and creates one destination lot per layer. It copies component costs, provisional status, receipt header, shipment header, PO, and PO line. It does not persist the source lot ID or exact receipt line on the output lot. The input layer contains the source lot ID only in memory. See `lots.service.ts:819–940`.

The generic transfer ledger records the level movement, not every source/output lot pair (`inventory.use-cases.ts:1755–1775`). Thus two receipt lines for the same PO line cannot be distinguished on a historical transferred lot by joining the original receipt transaction. New immutable source fields must propagate through transfers, or a new exact application will leave valid moved inventory unresolvable.

There is also a cost-copy race to account for: `getLotsAtLocation` reads without `FOR UPDATE` (`lots.service.ts:187–201`); transfer prepares costs before its conditional source update (`:852–878, 896–940`). A revalue can commit between those steps, leaving the destination with prepared old costs. An eventual application design must fix source cost capture/locking in this physical owner or retain durable pending descendant work; adding a read-time lineage join alone does not close this race.

Do not sum `qtyReceived` over original and transferred lots to calculate freight coverage. A transfer represents the same physical units again in a new lot record; original received quantity remains historical.

### 6. Legacy break/assembly loses the cost/source graph

`BreakAssemblyUseCases.breakVariant` and `assembleVariant` decrement source inventory, use only returned `consumedCostCents`, divide and round to target cents, then increment target inventory through generic adjustment. They do not pass their generated batch ID into the adjustment calls. See `server/modules/inventory/application/break-assembly.use-cases.ts:179–226, 284–335`.

`adjustInventory` forwards only the cents result from lot adjustment and records a generic adjustment transaction without source/output lot IDs. Positive `adjustLots` creates a fresh lot from cents without PO, receipt, shipment, parent-lot, or component evidence. Negative `adjustLots` already computes component mills, but this caller does not use or expose them. See `inventory.use-cases.ts:950–1050`; `lots.service.ts:660–715`.

Consequently a later freight update of the original receipt lot cannot reach these outputs through proven lineage. This is a confirmed structural limitation. It is not permission to infer old lineage from notes, matching quantities, adjacent timestamps, or SKUs.

### 7. Build and canonical transformation have stronger immutable operation evidence

The standard build owner records each consumed input lot, its quantity, and product/packaging/landed/total mills in `build_run_consumptions`, then produces output lots tied to that build run. It conserves component totals through `allocateBuildCostLayers`, including deterministic remainder layers. See `server/modules/inventory/infrastructure/build-execution.repository.ts:633–645, 711–778`; `server/modules/inventory/domain/build.domain.ts:359–405`.

However, build output lots receive `cost_provisional = 0` and no shipment/receipt root fields (`build-execution.repository.ts:747–762`). Late COGS revaluation does not traverse build consumption edges. The original input cost snapshots are valuable immutable history and must not be overwritten to simulate later application. Schema evidence: `shared/schema/inventory.schema.ts:1008–1033`.

Canonical transformations/builds lock source levels and lots and validate claimed component costs against current lot costs, rejecting `CLAIM_LOT_COST_CHANGED` rather than executing a stale plan. Their input/output inventory transactions share an exact `availability_claim_operation` reference, and their output lots retain build IDs when applicable. They also create outputs with provisional zero and no receipt/shipment root. See `server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts:1723–1795, 1809–1858, 1867–1938, 1978–2099`.

These operations are many-to-many cost transformations, potentially across products. A single `receivingLineId` on a finished build lot cannot truthfully represent all inputs. The canonical transaction operation identity and build-run consumption facts are admissible lineage evidence; SKU similarity is not.

## Confirmed signed-credit boundaries

Current charge DTO cents are signed safe integers, and AP's shipment payment projection intentionally preserves signed credits. See `shared/procurement/shipment-cost-command.ts:13–15`; `ap-ledger.service.ts:81–101, 3800–3813`.

That support does not extend through capitalization:

- Allocation rejects every negative charge (`shipment-tracking.service.ts:973–979`).
- Push clamps the combined landed layer to zero (`:1614–1619`).
- COGS rejects negative landed components (`cogs.service.ts:256–261`).
- Build cost layer allocation rejects negative component totals (`build.domain.ts:367–378`), and `build_run_consumptions` has a nonnegative landed constraint (`inventory.schema.ts:1026–1032`).

Proposal: preserve each charge's sign and distribute its absolute integer cents with the existing deterministic basis/remainder rule, then restore the sign. Validate the signed sum exactly. Do not take an absolute value of a credit or clamp it to zero. A negative individual charge with a nonnegative net landed component is distinct from a negative net landed component. The latter needs an explicitly chosen component policy and aligned COGS/build constraints before execution; until then return review-required and preserve the source unchanged.

## Proposed smallest coherent design

This section is a proposal, not a description of implemented behavior.

### Source and component contracts

1. Introduce an immutable shipment-cost revision header plus exact per-shipment-line rows. Persist currency/FX evidence, source charge IDs and versions, effective amount basis (actual/estimate/unknown), allocation method/basis, signed component totals, shipped base quantity, algorithm version, actor, timestamp, and a deterministic content hash. Use append-only revisions and an explicit current revision pointer. Keep existing snapshot/history rows readable as legacy projections; do not backfill them from today's PO/catalog.
2. Freight source rows should describe freight components. They must not smuggle a mutable PO blend into the product component. Product/AP and packaging authorities need separate exact component provenance, coordinated with the receiving/AP design. `total = product + packaging + landed` remains invariant before and after each owner changes its own component.
3. Carry authoritative extended money and base quantity as a rational source. Derive lot-unit mills with a documented deterministic rounding/remainder policy using integers/Decimal. Store residual evidence; a rounded per-unit mirror alone cannot prove source total conservation. An exact-only first execution boundary can reject unsupported residual cases, but must report them rather than silently declare all costs applied.

### Lineage projection and compatible history

4. Stamp new original receipt lots with immutable receiving-line ID, exact shipment-line ID when present, frozen lot-unit factor, and the receipt ledger identity. Validate all redundant IDs against the owning receipt/source transaction. A side table keyed by lot ID is acceptable if it is written atomically by the inventory owner; a mutable UI field is not.
5. Record transformation operations with exact input/output lot edges and frozen quantity units. A transfer edge is one source layer to one output layer and carries its full component/source state. Break and case assembly must expose exact consumed lots/component mills and record output links in their owner transaction. Build-run and canonical-operation evidence can supply the operation identity and input set, with an immutable output cost-share/remainder mapping. Do not replace many-input build lineage with a guessed single root receipt.
6. Preserve original consumption snapshots and append component-cost adjustment/application records. History should show the initial build valuation and subsequent source-driven delta. A lineage adapter may expose already-proven build or canonical edges without changing historical economics. Legacy transfer/break outputs with insufficient proof remain explicitly review-required; no broad historical backfill is proposed.

### Application status and retries

7. Persist a desired source revision and current applied component version per lot/contribution, separately from product/AP state. An application record should include command identity, source revision, lineage version, before/after component mills, exact quantity basis, residual, actor/time, and COGS result. Enforce unique application identity such as `(lot, component, source revision, lineage version)`; validate an expected prior version for competing corrections.
8. Expose pending, applied, review-required, and retryable-failure outcomes with reasons and affected records. A finalized shipment with no receipts is awaiting receipt, not evidence that all inventory was costed. Missing mappings must persist actionable work rather than disappear inside a success-shaped skipped array. `cost_provisional` may remain a compatibility projection, but AP must not clear freight-pending state.
9. Reuse the durable financial command wrapper for external requests. The business transaction must commit lot component changes, descendant adjustments, OMS recost, application receipts, and audit together. Infrastructure failure rolls everything back and remains retryable; a successful replay returns the stored outcome. Equal component values with a new proven source revision still need an application receipt, without a duplicate value-adjustment event.
10. Descendant creation must either capture current source component versions under locks and inherit all pending source work, or conflict and retry. Finalization/application must not mark a source graph complete while a concurrent transfer/build can create an untracked stale descendant. Coalesced background work alone is insufficient without this transactional handoff.

### Lock order implications

- Current push locks shipment then individual lots in whatever order its unordered provisional query returns. AP locks lots ascending ID. This admits the usual opposing two-lot wait cycle; no concurrent PostgreSQL proof for this combination was run by this audit. See `procurement.storage.ts:1283–1288`, `shipment-tracking.service.ts:1707–1711`, `cogs.service.ts:568–589`.
- Receipt close locks receipt header, PO header/lines, catalog variants, then inventory posting; receipt creation additionally begins with shipment/source serialization. A new receiving path must not lock shipment after holding a receipt header if application holds shipment and waits for that receipt. Immutable revision reads and a transactionally recorded application request can avoid this inversion; alternatively all callers must adopt a proven common order. See `receiving.service.ts:1206–1258` and `purchasing.service.ts:4125–4204`.
- Build and canonical inventory owners lock inventory levels before source lots; canonical lot order is location/variant/FIFO/ID, not AP's plain ID. Standard build source selection is FIFO within components. See `build-execution.repository.ts:564–606`; `canonical-claim-inventory.repository.ts:1723–1795`.
- Proposal: separate revision creation (shipment/charge authority) from cost graph application (inventory authority). Before any application writes, discover the bounded graph, acquire all required cost locks in a common documented order, revalidate graph/component versions, and only then revalue. Do not lock inventory levels, operational build headers, or source shipment headers after acquiring lots unless the full physical-owner order has been reconciled. Select by business FIFO and lock by a canonical ordering are separate operations.
- Transfer's unlocked cost capture must be corrected, and graph creation/application needs a common lock/version protocol. This audit cannot claim that adding `ORDER BY lot.id` to the push alone establishes deadlock-free behavior across builds, transfers, AP, reversal, and receiving. Actual opposing-operation PostgreSQL tests are required.

## Business policy that code does not decide

The existing denominator is shipped pieces, not accepted undamaged pieces (`shipment-tracking.service.ts:1510–1552, 1685–1688`). Receiving records received and damaged quantities separately; close posts the received count rather than computing a new good-stock denominator (`receiving.service.ts:1256–1258`; schema `:387–393`). This evidence does not establish the intended accounting treatment.

Decisions needed before automatically resolving these exceptions:

- Partial receipt still in progress versus a permanently short delivery: retain unreceived freight outside warehouse inventory, expense it, assign it to a claim, or redistribute it to surviving goods? When is the shortage final?
- Damaged goods accepted into stock versus rejected/quarantined/written off: which quantities absorb product, packaging, freight, duty, and insurance, and does a carrier claim offset expense or inventory?
- Receipt reversal or vendor return after freight was applied: should freight stay with remaining goods, follow returned goods, or become a separate expense/claim? The current source denominator does not encode this answer.
- Credits that exceed the positive freight component: reduce another component, create an expense recovery, or permit a signed landed layer? The existing build/COGS contracts prohibit the last option.
- May an estimate be explicitly approved as a provisional capitalization source, and what evidence makes a shipment's costs final? A missing amount must remain unknown rather than become an approved zero.
- The receiving/AP audit must also resolve genuine manual cost overrides and whether approved invoice prices include separately recorded packaging. Shipment source identity cannot decide those component policies.

## Proof requirements and safe delivery boundary

No runtime change should claim complete landed-cost application until source identity, component authority, pending state, and the relevant descendant owners are coherent together. A separately releasable read-only readiness report or lineage foundation is possible; a new root-lot-only push presented as complete would miss known paths above.

Required tests include:

1. Same PO line on two shipments and twice on one shipment; unfinalized sibling; direct PO receipt; exact 501-piece fallback; mismatched and absent legacy source evidence.
2. Receive→AP→freight, freight→receive→AP, and changed freight revision after prior application, all with nonzero product/packaging/freight. Compare final components using real inventory and AP owners, not isolated callback mocks.
3. Receipt→transfer→transfer, break, case assembly, standard build, canonical transform/build, mixed inputs from two shipments, and sold descendants. Verify pending state, exact contributions, and late OMS recost across every branch.
4. Component totals that require remainder layers. Existing `allocateBuildCostLayers` creates differently priced output lots to preserve exact money. A later revision must preserve immutable output IDs/quantities and account for non-divisible residuals; uniformly rounding each existing lot's unit cost is not proof of conservation.
5. Signed credits, zero net, negative net review outcome, missing currency/FX, actual versus estimate versus unknown. Assert no credit is silently removed or made positive.
6. Concurrent AP/push, receive/finalize, transfer/revalue, build/revalue, claim execution/revalue, and reversal/application with real PostgreSQL blocking/rollback checks. Include a new descendant appearing during graph discovery, stale component versions, second-lot failure, OMS failure, audit failure, and lost response/replay.
7. Preserve historical migration rows and original build/receipt evidence. Review-required records must be visible in the purchase workspace and shipment costing details rather than hidden behind a closed status.

Existing useful fixtures are `shipment-tracking-landed-cost.test.ts` (current PO-line pooling and push), `shipment-cost-commands.integration.test.ts` (procurement close lock/rollback), `receiving-unit-integrity.integration.test.ts` (actual receipt inventory/reversal), `invoice-variance-cogs.integration.test.ts` (lot/OMS transaction), `break-assembly-cost.test.ts`, `build.use-cases.test.ts`, `build.domain.test.ts`, and canonical claim/build tests. They do not collectively prove the new cross-owner graph merely because individual suites pass. This audit has read code/tests but has not executed a new financial integration scenario or measured affected production inventory.
