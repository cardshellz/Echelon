# Controlled procurement acceptance — 2026-09-10

Started September 10; final review and regression execution continued September 11.

## Scope and evidence

This batch continues the procurement walkthrough after the six deployed read/UI
repairs in PR1437. It adds reproducible service and PostgreSQL acceptance checks
and fixes defects those checks expose. Every record used here is synthetic and
every write targets a separately created, explicitly disposable local database.
No live purchase, stock, payment, supplier communication, or provider setting is
changed by this work.

The frontend Playwright configuration serves Vite and intercepts APIs. Those tests
prove presentation and interaction. The integration scenarios below call actual
owners, repositories, command-result persistence, and PostgreSQL. They do not
replace operator acceptance or demonstrate external provider behavior.

## Connected scenarios

| Scenario | Actual owner chain and assertions | Limits |
| --- | --- | --- |
| Planning through RFQ conversion | `procurement-rfq-controlled-acceptance.integration.test.ts`: save +50% growth policy; run `generatePurchasingRecommendations`; persist the recommendation snapshot; create one manual RFQ; capture and revise vendor quotes; convert selected lines to two draft POs. Requested quantities remain 1,000/500 pieces; explicit acceptance of the revised quote creates 1,200/500 and reserves those actual quantities. Source snapshots, quote history, exact product/packaging cents, receiving UOM, PO links, audit records and repeated commands reconcile. Stale workflow versions, stale quotes and an unexplained quantity change create no PO. | Catalog, demand and starting stock are declared synthetic observations. This does not test sales ingestion, scheduled runs, emails, or the user's chosen production policy. |
| RFQ through receipts and sold costs | `procurement-flow-cost-controlled-acceptance.integration.test.ts` uses the same RFQ helper to create its actual POs, then actual shipment creation and add-from-PO commands, invoice approval, five receipts, `InventoryUseCases` pick/ship, and a freight amendment. It reads the resulting lot, invoice, COGS and revision records; it does not insert the sold-cost result directly. | The receiving fixture explicitly uses pre-opening quantity authority. Activated quantity-ledger behavior has separate integration suites; this scenario does not certify a complete procurement chain after cutover, browser station actions or channel publication. |
| Payment and delegated controls | `procurement-payment-controlled-acceptance.integration.test.ts` mounts real AP HTTP routes with real command and SQL owners. It tests $1,000 then $1,100 against a $2,100 invoice, rejects $1,100.01 after the first payment, preserves balances and inventory, exercises concurrent requests, idempotent replay, payload mismatch, audit rollback, cross-invoice allocations and void history. Actual login/session tests retain a cookie while deactivating its account. | Payment method is a synthetic internal record; no bank settlement or provider payment is attempted. Product invoice prerequisites are explicitly seeded in this separate payment scenario. |

The shared helper `rfq-controlled-acceptance-helper.ts` creates recommendations,
RFQs, quote revisions and POs through their owners in both purchasing scenarios.
The fixture helpers redirect legacy module SQL to the same private test database;
they do not substitute business-service results. Schema and command migrations
are applied explicitly, and existing application schemas are refused.

## FLOW arithmetic

The fixture records USD, no taxes/FX/discounts, 100 pieces per receiving carton,
and an initially empty stock position. Product A is 1,000 pieces at $2.00 plus
$0.10 packaging per piece; B is 500 at $4.00 plus $0.20 packaging. Each product
invoice is $2,100.

Shipment X contains 600 A and 500 B, with $220 freight allocated by weight (6/5 kg):
$120 to A and $100 to B. Shipment Y contains the other 400 A and $80 freight.
Five physical receipts post 500 A, 400 B, 100 A, 100 B and 400 A. Initial inventory
is 1,500 pieces valued at $4,500. Selling 100 A from X records $230 COGS and leaves
$4,270 inventory.

Revising X freight from $220 to $330 adds $60 to A and $50 to B. Of that additional
cost, $10 follows the already sold A pieces and $100 stays in stock:

| Checkpoint | Inventory | Sold COGS | Combined cost |
| --- | ---: | ---: | ---: |
| Before sale | $4,500 | $0 | $4,500 |
| After 100 A sold | $4,270 | $230 | $4,500 |
| After late freight | $4,370 | $240 | $4,610 |

The sale has a recorded $300 order total, so the lookup reports $70 margin before
the adjustment and $60 after it. Repeated and concurrent unchanged cost pushes
must preserve the same quantities, amounts, applications and history.

## Defects found and corrected

### Recorded order revenue was reported as zero

`COGSService.getOrderCOGS` read `item.priceCents` and `order.totalAmount`.
`shared/schema/orders.schema.ts` instead stores `totalPriceCents` and `totalCents`;
`buildWmsItemFinancialSnapshot` in `wms-sync-financials.ts` maps the actual extended
line amount. A real SQL regression returned zero revenue and a negative $4.05
margin for a recorded $15 order with $4.05 COGS.

The reader now uses those recorded cent fields, preserves an explicit zero
quantity, uses the recorded order-line name, and associates cost rows by their
order-item identity. `buildOrderCOGSReport` validates source values and performs
money sums and differences with integer arithmetic. Invalid/missing or unsafe
amounts fail explicitly. Authoritative extended mills are summed before rounding
to display cents; exact mills remain available as strings in the response. For
example, two 49-mill rows report 98 mills and one cent, instead of losing both rows
by summing their independently rounded zero-cent mirrors. The documented legacy
zero-mills/nonzero-cents fallback is preserved.

The header, lines and cost rows use one read-only repeatable-read transaction.
A concurrent-writer regression commits an additional line and cost during the
read: the first response retains the old complete snapshot and the next sees both.
Unsupported non-USD order totals return an explicit error because no recorded FX
basis relates them to USD inventory costs. No currency conversion is invented.

The shared response schema validates successful JSON at the browser boundary.
The dashboard distinguishes a failed read from a missing order and can retry the
same search. These are costs recorded so far: an unpicked order can have no COGS
rows, and default-zero historical financial snapshots are not backfilled by this
change. The API still uses the recorded order total
as its existing margin basis; this change does not redefine that field as an
accounting net-revenue measure or backfill missing historical financial snapshots.

### A deactivated account retained purchasing permission

`identity.repository.getUserPermissions` previously resolved retained roles
without checking `identity.users.active`. A real login plus retained session
cookie could record another AP payment after the identity owner deactivated the
account. Permission resolution now requires an active account. The regression
denies new payment, void and saved-result replay requests after deactivation,
preserves all financial records, and verifies active-account access still works.

This is fresh enforcement at permission-protected routes. It does not destroy
every session or change routes guarded only by authentication; it also does not
redesign permission constraint semantics.

### Invoice linkage downgraded confirmed freight evidence

The connected FLOW test exposed a cost-source classification regression after
creating and approving freight invoices. `createInvoiceFromShipmentCosts` changes
a charge to `invoiced`, while `recordShipmentCostRevisions` previously recognized
only `confirmed`/`finalized` charge labels. Numeric inventory and sold COGS still
reconciled, but confirmed landed sources became estimated.

`resolveShipmentChargeEvidence` now evaluates the complete linked invoice and its
charge lines: vendor, shipment, currency, status, quantity, unit price, extended
amount and document total must reconcile. An unchanged immutable finalized charge
can retain its proof while AP progresses; exact approved invoice evidence can
establish confirmation for a prior estimate. `invoiced` or `paid` labels alone
cannot establish confirmation. Missing, disputed or conflicting evidence requires
review and cannot silently replace inventory cost. Source revisions retain the
supporting invoice references and snapshots. Older snapshots lacking matching
source details are not granted invented confirmation.

## Validation and remaining acceptance

The CI manifest retains its original 70-suite digest, preserves the two previous
read regressions, and includes these three controlled scenarios: 75 PostgreSQL
files across eight deterministic shards. Each file receives its own database and
process. See `CI-TEST-EXECUTION.md` for the safe execution contract.

Before these changes, the full 72-file PostgreSQL baseline passed (1,148 tests).
The final expanded run passed all **75 files / 1,169 tests**, with no failures,
errors or skips. The cost dashboard passed **30 desktop/mobile browser tests**.
Full TypeScript and the production client/server build passed. The shared cost
contract, domain, routes and money-helper run passed **144 focused unit tests**.

One broad unit run encountered an unrelated Node `fetch` failure (`bad port`)
before a Dropship test request reached its HTTP route; the unchanged isolated
two-case test then passed. No Dropship code was modified.

The complete rerun passed 12,366 tests, with 39 existing skips and one failure in
the Git-based browser dependency selector: its `git ls-files` inventory omitted
the new, then-untracked shared contract. After explicitly staging the new files,
all 41 selector tests passed without changing application or test code. All
observed failures therefore have passing targeted retests; there was no single
all-green full unit invocation. Logs retain both full runs and targeted results.

Still not proven by this batch: the complete activated quantity-authority chain;
actual carrier/container tracking; live historical cost completeness; all
warehouse/capability combinations in the browser; or the user's daily buying
decisions over successive real operating days. Earlier walkthrough failures and
unexecuted manual cases retain their history. The controlled evidence adds to
that record without turning all manual cases into automatic passes.
