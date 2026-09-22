# Product 102 removal: implementation, evidence and runbook

## Status / short version

**Implemented and tested locally; not applied to production.** Product **5** remains the real Blue Toploader. The guarded command will remove duplicate product **102** from the live catalog while preserving its original catalog, purchasing and forecast history.

No production migration, cleanup, inventory movement, receiving-size change, ATP activation or channel change has been performed. PR publication does not authorize production execution; merge, deployment and cleanup remain separate steps.

Implementation baseline: refreshed `origin/main` **1a5012901e33d668a56f18e25dbc46d23874437f**. Isolated worktree: `.codex-worktrees/product-102-history-preserving-cleanup`; branch: `codex/product-102-history-preserving-cleanup`. Unrelated root-checkout work was preserved. Migration **0695** was selected during PR preparation because refreshed main already contains 0694 for a separate inventory-tracking-policy change. That upstream work is not part of this PR.

**Delivery boundary:** review/PR and deploy the history-support migration first; then obtain a fresh executable preview and explicit owner approval before the separate production cleanup. Deployment alone does not remove product 102.

## Exact eventual changes and protected records

| Records | Command behavior |
| --- | --- |
| PO 7 / line 39 | Change only product 102 to **5**. |
| PO 134 / line 221 | Change product 102 to **5** and supplier mapping 25 to **125** together. Preserve every quantity, price, status and receiving-size field. |
| Ten cycle-count entries | Correct only their product link to **5**. Variant 206 already belongs to product 5. Do not change counts or post an adjustment. |
| Supplier mapping 25 | Preserve the complete original row in the immutable receipt, then remove it after line 221 is relinked. Keep mapping 125 unchanged. |
| Product-line membership 71 | Preserve its complete original row, then remove it. Keep existing product-5 membership 105 unchanged. |
| Product 102 | Preserve its full row and source-to-target identity in the receipt; delete the live catalog row after resolving the reviewed dependencies. |
| 38 forecast observations and 66 evaluations for 102 | Preserve all IDs and existing fields. Do not merge with product 5's forecasts, rewrite product IDs or change cohort denominators. |
| Paid invoice 9 and its line 43, linked to PO line 39 | Preserve the full header and line, their link, amounts, payment status and matching state. No recalculation or rematching. |
| Four WMS lines containing numeric ID 102 | Leave unchanged: they identify **variant 102 of product 50**, not product 102. |
| Stock, lots, inventory transactions, variants, received PO line 153, mapping 125, product 5, authority and configuration | No intended changes. Exact captured before/after comparison rejects changes outside the approved projection. |
| Audit | Add one immutable command receipt, one audit event and two PO events, atomically with the corrections/deletions. |

The owning write functions are [correctProduct102PurchasingIdentity](../server/modules/procurement/product-102-identity-cleanup.repository.ts#L10), [correctProduct102CountIdentity](../server/modules/inventory/infrastructure/product-102-count-identity.repository.ts#L10), and catalog [mutate](../server/modules/catalog/infrastructure/product-102-cleanup.repository.ts#L410). The exact permitted after-state is calculated in PostgreSQL by [expectedAfter](../server/modules/catalog/infrastructure/product-102-cleanup.repository.ts#L323). No generic product-merge API or new inventory-quantity writer was added.

## Confirmed production evidence

Latest read-only preview: **2026-09-21T23:19:20.994Z**, using verified TLS and an explicit REPEATABLE READ READ ONLY transaction. Result:

- Status: **blocked**; the only reported data/schema blocker is `CLEANUP_MIGRATION_REQUIRED`.
- The history migration (now numbered 0695) was not installed. `executableHash` is **null**.
- Evidence hash: `800b6a1b6f580bec196c2c8fb1815b2b1e919f7897c1e6f75a1e0e816055ee50`.
- **73 foreign-key checks**: 37 incoming product constraints, four supplier-mapping constraints, and 16 incoming constraints for each of the two PO lines.
- Nonzero references: one product-line membership, ten count entries, 38 forecasts, two PO lines and one supplier mapping on product 102; one PO line on mapping 25; one invoice line on PO line 39. All other inspected incoming references were zero.

This is evidence, **not approval and not an execution token**. Preview does not select or authorize an operator. Execution independently requires a permitted active user and an administrative database session.

The same evidence hash was observed at **22:54:32.701Z**. The earlier detailed inspection at **22:07:32.464408+00** had evidence hash `13d48e48b7c880941b12c9a52b871f792600d5c4cf814da2691bc2e34ddc1da1`; its inspection scope differed and it is retained only as provenance.

Evidence-producing paths:

- [Product102CleanupService.preview](../server/modules/catalog/application/product-102-cleanup.service.ts#L147) returns schema readiness, blockers, the exact fingerprint and dependency counts without mutation.
- [Product102CleanupTransaction.capture](../server/modules/catalog/infrastructure/product-102-cleanup.repository.ts#L136) captures complete relevant rows, forecast/evaluation evidence, stock/lot state, an inventory-transaction digest, authority, and actual FK/index/trigger definitions.
- [inspect-product-102-cleanup.ts](../scripts/inspect-product-102-cleanup.ts#L25) is the earlier detailed read-only diagnostic; it has no apply mode.

### Record facts behind the scope

| Confirmed fact | Evidence section / validation |
| --- | --- |
| Product 102 is archived and inactive, SKU `ZZ-DUPE-SHLZ-TOP-35PT-BLU`, with no variants. Product 5 is active, SKU `SHLZ-TOP-35PT-BLU`. | Inspector `products` / `variants`, [lines 30–32](../scripts/inspect-product-102-cleanup.ts#L30); command [assertProduct102ReviewedRows](../server/modules/catalog/domain/product-102-cleanup.ts#L56). |
| Blue case variant 206 belongs to 5 and contains 1,000 units. Pack 232 contains 25; inactive variants 9/10/731 also remain with 5. No variant creation or reparenting is required. | Inspector `variants`; repository `capture` preserves all these rows. |
| Count IDs **3062, 3140, 3277, 3354, 3718, 3796, 3901, 3949, 4063, 4112** already select variant 206 and the correct Blue C1000 SKU. Each is counted, expected/count 80, variance 0, with no adjustment transaction or related mismatch item. These are historical readings, not ten inventories to sum. | Inspector [counts](../scripts/inspect-product-102-cleanup.ts#L34); exact-ID and field assertions in `assertProduct102ReviewedRows`. |
| WMS IDs **302040, 302869, 310633, 320232** have SKU `GLV-GRD-SGC-VNT-C10000`, resolving to variant 102/product 50. All four were completed on shipped orders. | Inspector [orders](../scripts/inspect-product-102-cleanup.ts#L40); the earlier interpretation as product-102 dependencies was incorrect. |
| PO line 39 is cancelled, ordered/cancelled 400,000, received 0, supplier link NULL. Line 221 is open, ordered 352,000, received/cancelled 0, mapping 25. Both variant fields select 206 but saved receiving size is **1**. | Inspector [purchaseLines](../scripts/inspect-product-102-cleanup.ts#L45); exact assertions and unchanged after-state projection. |
| Already-received PO 113 / line 153 uses mapping 125 and is excluded from edits. Mappings 25/125 both select vendor 2 and variant 206 but different products. Mapping 25 has pack size 1,000 / 7 cents / NULL mills; mapping 125 has pack size 1 / 6 cents / 580 mills. These prices are not substituted for each other. | Inspector [supplierMappings and supplierIndexes](../scripts/inspect-product-102-cleanup.ts#L50); `capture` includes original rows and line 153. |
| Membership 71 links 102 to product line 1; membership 105 already links 5 to that same product line. | Inspector [productLines](../scripts/inspect-product-102-cleanup.ts#L55). |
| All 38 source observations collide with a product-5 observation in the same run/scope. Captured forecast/baseline/forward quantities are zero; receive variant is NULL; no source overlay contributions exist. There are 66 source evaluations. | Inspector [forecasts](../scripts/inspect-product-102-cleanup.ts#L57); command validates this population before apply. |
| Invoice line **43** belongs to paid vendor invoice **9** and PO line 39, variant 206. Its quantity invoiced/ordered is 400,000, received 0; legacy unit cost 7 cents, mills NULL, line total 2,603,167 cents, match pending. Invoice 9 is USD, vendor 2, invoiced and paid 7,164,050 cents, balance zero. | Inspector [linkedInvoice](../scripts/inspect-product-102-cleanup.ts#L27). Both complete rows are locked/fingerprinted/preserved; these values are not recalculated by this effort. |
| Runtime authority remains `legacy`, activation run NULL, no active freeze, no ledger opening, positive admission-fence epoch. | Repository `capture` and `assertProduct102ReviewedRows`. This is a checked precondition, not authority to activate the new inventory model. |

## Why this implementation is necessary: existing-code trace

1. [buildWmsLineItemFromOmsLine](../server/modules/oms/wms-sync.service.ts#L366) writes **productId: variantId** at [line 422](../server/modules/oms/wms-sync.service.ts#L422). [resolveShipmentItemDefaults](../server/modules/wms/create-shipment.ts#L104) reads that field as a variant; [lockSourceForPreparation](../server/modules/wms/canonical-claim-dispatch-source.ts#L65) also handles mixed legacy meanings. A numeric match alone is not a product reference.
2. [guard_po_line_vendor_product_identity](../migrations/146_po_vendor_product_identity_guard.sql#L55) requires the PO product/vendor/receive variant to agree with its active supplier mapping. Hence line 221's product and mapping change together. [guard_linked_vendor_product_identity_change](../migrations/146_po_vendor_product_identity_guard.sql#L201) and supplier uniqueness prevent simply reparenting mapping 25 over existing 125.
3. [purchase_forecast_observations](../migrations/162_purchase_forecast_observations.sql#L10) has a direct product FK, a unique run/product/scope key, and a separate selected-variant/product FK. Its update/delete guards use the immutable-evidence functions in [migration 148](../migrations/148_purchase_rfq_requests.sql#L213). This command never disables those guards.
4. [loadMaturedCandidates](../server/modules/procurement/purchase-forecast-backtesting.repository.ts#L581) uses the original product identity to match later demand. Replacing 102 with 5 would change the question that a historical forecast measures. [loadRecent](../server/modules/procurement/purchase-forecast-backtesting.repository.ts#L797) uses captured SKU/name, not a mandatory live-product join. The real readers are exercised before and after cleanup in the [PostgreSQL regression](../server/modules/catalog/__tests__/integration/product-102-cleanup.integration.test.ts#L286).
5. [findExisting](../server/modules/procurement/purchase-recommendation-snapshot.service.ts#L559) replays saved run observations; [createRun](../server/modules/procurement/purchase-recommendation-snapshot.service.ts#L588) inserts new observations transactionally. Historical rows remain in place; new forecasts must still identify a current product.
6. [getInvoiceLines](../server/modules/procurement/ap-ledger.service.ts#L2908) reads stored invoice lines. [recalculateInvoiceFromLines](../server/modules/procurement/ap-ledger.service.ts#L2916) is a distinct financial mutation, not called here. The [PO matching fingerprint](../server/modules/procurement/purchase-order-invoice-match.ts#L69) and [matching evaluator](../server/modules/procurement/purchase-order-invoice-match.ts#L164) use line IDs, quantities and financial inputs, which this cleanup preserves.
7. [planReceiptUnits](../server/modules/procurement/receiving-unit-contract.ts#L44) separately rejects saved receiving size 1 against variant size 1,000. **Removing product 102 does not fix that receiving discrepancy.** The earlier size repair is not silently reinstated.

## Implemented history and authorization contract

[Migration 0695](../migrations/0695_catalog_forecast_identity_history.sql#L1) is schema/history support, not the cleanup command:

- `catalog.forecast_product_identities` stores an immutable ID and exact catalog snapshot at **registration time**. It is neither a live product nor an inventory balance. Each forecast's own captured fields remain authoritative for that forecast's original run.
- Existing forecast identities are registered; only the observation's direct product FK is redirected to the registry. Observation/evaluation values and IDs, run/product/scope uniqueness, immutable-evidence guards and selected-variant/product ownership remain intact.
- [register_current_forecast_identity](../migrations/0695_catalog_forecast_identity_history.sql#L71) requires and key-share-locks a current product before every new observation. A retained history ID cannot be used to create a new forecast for deleted product 102.
- `catalog.product_cleanup_receipts` stores the non-expiring command key, exact request/evidence hashes, source/target, operator and database actor, owning transaction, approval, timestamp, complete before/after data, schema manifest, result and audit reference. Receipts and historical identities reject update/delete/truncate.
- [guard_product_cleanup_receipt](../migrations/0695_catalog_forecast_identity_history.sql#L95) requires the receipt-table **database owner**, the current SERIALIZABLE read-write transaction, a current exact source snapshot, and matching audit evidence. The selected application user must be active and hold an unrestricted `inventory:delete` permission through current RBAC tables. The grant/account rows are SHARE-locked until commit. A legacy role name alone is insufficient.
- The command is an authenticated **administrative CLI**, not an HTTP endpoint: the database login is authenticated and the supplied actor ID is validated attribution. It is not a cryptographically signed application-user session. The DB owner remains trusted, since that role can already alter/drop database protections; the design does not claim protection against a malicious DB owner.
- [guard_product_history_removal](../migrations/0695_catalog_forecast_identity_history.sql#L137) allows removal only with a matching same-transaction receipt; retired product-ID reuse is blocked. [require_completed_product_cleanup](../migrations/0695_catalog_forecast_identity_history.sql#L172) prevents committing a receipt without completing the deletion. These history guards protect other forecast-linked products too.
- Trigger functions used by restricted normal forecast/catalog writers have fixed `pg_catalog` search paths and no public EXECUTE grant. Tests prove those writers can continue normal work without direct access to the history tables.

Schema deployment leaves product 102 and all operational rows intact. It does add registration snapshots and strengthens deletion safeguards; those are the migration's intended runtime effects.

## Command trace, ownership and locks

| Stage | Exact implementation | Contract |
| --- | --- | --- |
| CLI boundary | [main](../scripts/remove-duplicate-product-102.ts#L10), [parseProduct102CleanupArguments](../server/modules/catalog/interfaces/product-102-cleanup-command.ts#L13) | Preview default; mutually exclusive preview/verify/execute; no arbitrary IDs or fallback app database; verified TLS; sanitized structured errors. |
| Data/schema preview | [preview](../server/modules/catalog/application/product-102-cleanup.service.ts#L147), [capture](../server/modules/catalog/infrastructure/product-102-cleanup.repository.ts#L136) | Read-only, actual dependency census, exact raw PostgreSQL JSONB fingerprint; missing history foundation cannot yield an executable hash. |
| Eligibility | [assertProduct102CleanupEligible](../server/modules/catalog/domain/product-102-cleanup.ts#L38), [assertCleanupReferenceScope](../server/modules/catalog/domain/product-102-cleanup.ts#L227) | Exact reviewed identities/rows, required guards, inactive source, no source variants, legacy authority, no active freeze/opening, no unexpected dependencies. |
| Apply / idempotency | [apply](../server/modules/catalog/application/product-102-cleanup.service.ts#L213) | Exact hash rechecked after locks. Matching completed request replays its receipt; changed actor/approval/hash on the same command key is rejected. No automatic reapproval. |
| Owning writers | [Purchasing correction](../server/modules/procurement/product-102-identity-cleanup.repository.ts#L10), [count-link correction](../server/modules/inventory/infrastructure/product-102-count-identity.repository.ts#L10), [catalog mutation](../server/modules/catalog/infrastructure/product-102-cleanup.repository.ts#L410) | Each module retains its writes. Purchasing/count functions require the approved receipt in the current transaction. All expected affected-row counts are checked. |
| Audit / exact comparison | [record](../server/modules/catalog/infrastructure/product-102-cleanup.repository.ts#L360), [recordProduct102PurchasingCleanupAudit](../server/modules/procurement/product-102-identity-cleanup.repository.ts#L43), [assertAudit](../server/modules/catalog/infrastructure/product-102-cleanup.repository.ts#L430) | Raw PostgreSQL JSONB financial snapshots never round-trip through JS numbers; audit/event IDs remain decimal strings, including values above 2^53. |
| Transaction / readback | [transaction](../server/modules/catalog/infrastructure/product-102-cleanup.repository.ts#L468), [verify](../server/modules/catalog/application/product-102-cleanup.service.ts#L277) | SERIALIZABLE writes; independent READ ONLY verification; rollback on failure; ambiguous commit explicitly requires receipt verification. |

The implemented [lock order](../server/modules/catalog/infrastructure/product-102-cleanup.repository.ts#L254) is:

1. Admission fence SHARE NOWAIT; runtime authority SHARE.
2. Command advisory lock; existing inventory cost-graph lock.
3. PO headers **7, 113, 134**, then all their lines, sorted, FOR UPDATE.
4. Paid invoice **9** and invoice line **43** / reviewed PO-linked invoice lines, sorted, FOR SHARE.
5. Products **5, 50, 102**, then relevant variants, supplier mappings **25/125**, ten count rows, and memberships, each sorted FOR UPDATE.
6. During receipt admission, the actual application-user/RBAC grant rows are locked FOR SHARE.

[runApCostTransaction](../server/modules/procurement/ap-ledger.service.ts#L4096) takes the same cost-graph lock before AP financial mutations. Waits are bounded to two seconds and individual statements to 30 seconds. New conflicts cause a failed/retryable transaction, not weaker checks. The current code and tests support this lock sequence; no claim is made that every future writer will follow it automatically.

## Failure modes and recovery

- Missing migration/guards, a changed quantity/price/invoice, new dependency, source variant, active freeze, ledger opening or authority change blocks execution. Fix or review the changed evidence; do not bypass the check.
- Permission denial or revocation cannot leave partial changes. Revocation races serialize against the locked grant used by receipt admission.
- A failure after any intended mutation rolls back the data changes, receipt and audit writes together. A deferred completion guard also rejects an orphan authorization receipt.
- Competing identical commands cannot double-post. A serialization loser may retry the **identical** approved command after checking the receipt. A different approval must not reuse the completed key.
- A lost COMMIT acknowledgement is **not proof of rollback**. Run `--verify` using the same database before any retry; never invent a new command key.
- Independent verification reports later legitimate stock/forecast changes as changed sections, separately from the immutable completed receipt. Such drift is not permission to reapply.
- Recovery after a committed cleanup is a reviewed compensating operation from preserved snapshots, not blind reversal after subsequent business activity.

## Validation completed

| Check | Result |
| --- | --- |
| Full repository Vitest run before the final main refresh | **1,377 files / 16,518 tests passed**; 101 files / 1,564 tests skipped under the normal no-database environment. No failures. |
| First full run on refreshed main | 1,375 files / 16,531 tests passed; three HTTP route tests failed with `TypeError: fetch failed`, caused by `Error: bad port`; 102 files / 1,589 tests skipped. All 19 tests in those three unchanged files passed when rerun together in isolation. A complete repeat is recorded separately below. |
| Complete full-suite repeat on refreshed main | **1,378 files / 16,534 tests passed**, no failures; 102 files / 1,589 tests skipped under the normal no-database environment. No route-test or runtime code was changed to obtain this result. |
| Dedicated local PostgreSQL + command/ownership/CI/prefix run on refreshed main | **5 files / 109 tests passed, none skipped**: 46 real PostgreSQL tests, 13 command/unit tests, 42 CI-manifest checks, seven writer-ownership checks, one migration-prefix guard. |
| Application and server/client test TypeScript checks | `npm run check` and `npm run check:tests` passed. |
| Separate CLI TypeScript check | Both standalone scripts passed strict checking with ES2019 target. This caught and fixed a CLI discriminated-union issue not included in the repository's default source glob. |
| Final parser/prefix rerun after that type-only fix | 14 tests passed. |
| Production evidence | Read-only preview above; no production mutation or migration. CI, deployment and a production apply are **not** claimed. |

The [PostgreSQL suite](../server/modules/catalog/__tests__/integration/product-102-cleanup.integration.test.ts#L1) uses disposable databases on the task-only local PostgreSQL 17 server. Its [fixture](../server/modules/catalog/__tests__/fixtures/product-102-cleanup.fixture.ts#L28) uses reduced supporting tables plus actual migrations 146, 162, 163, 168, 169, 170, 172 and the real immutable-evidence functions from 148. Migration 0695 runs through the actual migration executor. This replaces the earlier 19-test experimental design; that prototype is not the implementation proof.

Coverage includes exact row/quantity/price/invoice preservation, 38 colliding forecasts and 66 evaluations, actual backtesting-reader equality, unsafe-JS-integer fidelity, stale preview, extra/missing dependencies, permission and restricted DB-role enforcement, grant revocation, real concurrent sessions, cutover locking, rollback after writes, migration-runner rollback, immutable history, ID reuse, same-transaction owner admission, receipt replay/conflict, a real commit with simulated lost acknowledgement, and independent readback.

The [CI manifest](../scripts/ci/postgres-test-manifest.ts) includes this suite; the manifest now has 91 files. The [writer ratchet regression](../server/__tests__/unit/writer-ratchet.test.ts#L99) keeps Purchasing/count/audit writes with their existing owners. Only the new catalog receipt and catalog-owned membership operation add catalog ownership entries.

Seven unchanged upstream files needed LF normalization in this Windows worktree because existing source-contract tests compare literal newlines. Each normalized blob was verified identical to HEAD. They contribute **no content diff**; no Dropship/UI fix is included.

## Remaining runbook — not authorization to execute

1. Review the PR and require passing CI before merge. This branch was refreshed to the baseline above; the migration prefix and complete CI manifest were rechecked during publication preparation.
2. Deploy migration 0695 through the normal migration runner. It registers historical identity and installs guards only; do not bundle the cleanup invocation into deployment.
3. With an explicit scoped database connection, run:
   `node --import tsx scripts/remove-duplicate-product-102.ts --preview`
   The only connection variable is `ECHELON_PRODUCT_CLEANUP_DATABASE_URL`; do not print or commit its value. Review all blockers and preserve the new executable fingerprint.
4. Identify the real active operator with unrestricted `inventory:delete`, confirm the administrative DB login owns the receipt table, and obtain explicit owner approval of the **fresh executable hash and exact scope**. The pre-migration hash above is not usable.
5. Only after that approval, invoke the fixed command with `--execute --expected-hash <approved-hash> --actor-id <verified-user-id> --approval <exact-approval-text>`. The CLI performs independent readback after apply.
6. Run `--verify` again independently. Require a valid receipt and initially matching current state; investigate any discrepancy without rerunning under a new key. Record the real operator, timestamp, hash and result in this record after execution.

## Assumptions, unknowns and exclusions

**Confirmed:** the identities and dependency population above passed the current read-only preview; the implementation passed local checks. **Hypotheses:** none are required to authorize the exact implemented field projection.

**Not proven:** who originally created/renamed product 102; an exhaustive census of arbitrary JSON/text references or every analytics consumer; compatibility with an untested full production-schema restore; remote CI results, deployed DB-owner/operator grants, or production post-cleanup behavior. The actual FK census and schema fingerprints are necessary evidence, not a claim that arbitrary application references cannot exist.

**Required next checks:** PR/CI, deployed migration readiness and real grants, a fresh approved preview, then transactional apply and independent readback. Ongoing legitimate activity can invalidate a preview and require review again.

**Explicitly separate:** PO line 221's saved receiving size **1** versus case size **1,000** remains unresolved. No loose-piece configuration, physical receipt shape, quantity adjustment, price repair, invoice rematch, new ATP model, channel publication change or production cutover is inferred from this cleanup.
