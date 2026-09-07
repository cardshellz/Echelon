# Procurement workspace cost evidence acceptance

The initial source-preview increment was based on `6f033fe613ce21fed715a4bcd83ced437fdc0065`. The recorded-application increment depends on migration `222_procurement_cost_evidence.sql` and the integrated financial owners. This workstream reads their evidence and exposes the existing receipt-cost retry command; it does not apply costs directly or change production data.

## What the code definitely does

| Requirement | Evidence |
| --- | --- |
| Keep a purchase open while following shipments, receipts and invoices | `PurchaseLifecycleWorkspaceView` and `PurchaseRecordInspector` retain URL-backed selection and full-record return paths. `procurement-workspace.spec.ts` covers keyboard use, split/shared records, browser history, refresh and copied links. Cost-source links use that same inspector. |
| Show quoted product, packaging, fees, tax and discounts without mixing scopes | `readPurchaseCostEvidence` reads their existing source columns. `projectPurchaseLine` keeps exact extended amounts separate from rounded unit mills. The unreceived preview uses BigInt and one cents rounding; it excludes freight, tax, discounts and other charges. Non-product fees need an explicit allocation before they can be treated as inventory cost. |
| Preserve actual zero, signed credits, estimates and unknown values | `projectPurchaseCostTrace` uses amount evidence rather than document status. `formatWorkspaceMills` retains exact integer precision through four decimal places. No whole shared-shipment charge is assigned to a purchase without an exact allocation row. |
| Read immutable source revisions and historical application attempts | `readPurchaseCostApplications` joins source revisions through exact PO line IDs, applications through source revision IDs and snapshots through application/lot IDs. `projectPurchaseCostApplications` validates the contract, canonical fingerprint over the economic input and raw `source_evidence` snapshot, component, revision and exact PO/shipment scope. Latest-recorded labels refer to recorded history, not a claim that mutable sources are fully synchronized. |
| Distinguish estimated application, confirmed application and review | The projection preserves the recorded status alongside evidence issues. Invalid source authority, unsupported/missing currency, unknown source state, inconsistent snapshots or missing reporting evidence require review. The UI says “Estimate applied to captured lots” for estimates and “Processed · no lots changed” for an applied outcome with no captured lots. No successful attempt establishes complete future coverage. |
| Follow receipt and transformed lots | Original receipt detail still validates the explicit receipt transaction, lot identity and frozen receive units. Application history shows original receipt origins or immutable incoming contribution IDs, input quantities, whole-operation output denominators and output offsets. Historical before/after components are separate from current on-hand/location metadata. No SKU matching or live pack-size inference creates historical lineage. |
| Show sold-cost outcomes without implying external reporting delivery | The read returns recorded COGS row count and signed aggregate delta. Internal reporting event metadata must match the source, component, currency, versions, snapshot count and COGS outcome. UI explicitly says delivery to Archon or another external system is not verified. Individual sold-order/COGS row IDs are not available in this outcome contract. |
| Classify invoice components only from explicit evidence | Shared `invoiceCostComponentEvidenceSchema` is used by the financial owner and read model. `projectInvoiceLine` requires exact product + packaging + adjustment equality with the invoice line total. Included packaging cannot carry a separate packaging amount. Unsupported versions, invalid amounts, mismatches and nonzero adjustments require review; historical unclassified amounts are never inferred from matching totals. |
| Keep physical receiving separate from cost recovery | `readReceiptCostQueue` and `projectReceiptCostQueue` preserve each durable receipt/PO-line request and every recorded attempt. No attempt means pending; recorded success is validated against exact application IDs and PO-line scope. The UI retains the physical receipt status and explains that the stock receipt remains recorded. |
| Retry through the existing controlled owner | `useReceiptCostActions` checks `purchasing:approve`; the server retry route retains its own permission/idempotency checks. `createReceiptCostRetryClient` calls only `POST /api/receiving/:id/retry-costs`, keeps the same key after uncertain/malformed responses, validates outcome consistency and rotates only after a known command result. It refreshes the same purchase workspace and never calls physical close/repost. |
| Preserve old API consumers and complete visible history | New history fields remain additive and optional. Older DTO fixtures remain accepted. All reads run sequentially on the same read-only repeatable-read transaction. Revision/application/request histories are bounded at 1,000 rows and lot/contribution detail at 10,000; excess history fails visibly rather than hiding older records. |

## What is likely happening

No production prevalence, monetary impact or migration status is inferred. The browser data is synthetic. Real PostgreSQL tests prove the scoped read and validation behavior against migration 222; they do not establish which historical production purchases have complete lineage.

## What is not proven

- Historical costs without immutable source, original receipt or contribution evidence remain unknown or require review. A finalized shipment or false provisional flag is insufficient.
- Application snapshots cover the lots captured by that specific application. Later source changes, receipts and transformations require their own owner processing. The receipt queue's completed attempt is not a final-cost certificate.
- Non-product PO fees, taxes, discounts and invoice adjustments require explicit allocation policy/evidence. Fractional revaluations that cannot be represented exactly by the current per-unit lot owner remain review items in the financial workstream.
- Reporting events here are internal records. No Archon acknowledgement, external delivery, individual sold-order drilldown, or container telemetry is claimed.
- The unreceived quote is not a production/transit inventory valuation or cash forecast. Receipt status and on-hand quantity do not establish pickable availability or availability for sale.
- RFQ origins are a separate immutable-link workstream. This cost increment does not infer RFQ lineage.
- Historical lot currency and missing frozen units are not filled from the current PO or catalog.

## Validation

- Focused projection, repository, UI rendering, exact invoice composition and retry-intent tests: **111 passed** across five suites. Cases cover signed/zero/unsafe amounts, missing lineage, source hash/scope conflicts, unresolved authority, invalid application/reporting evidence, descendant intervals, pending/failed/completed receipt requests, wrong application references and ambiguous response key reuse.
- Real PostgreSQL: **12 passed** in `purchase-workspace.integration.test.ts`, using isolated disposable database `echelon_procurement_workspace_20260907` on local port 55436. The suite applies the actual migration 222 and verifies exact original/descendant joins, signed COGS outcomes, internal-only reporting, every queue attempt, exclusion of unrelated PO history, bounds and read-only repeatable-read isolation. It seeds immutable application outcomes for reader acceptance; financial write-owner behavior is covered separately. Owned fixture schemas are removed by teardown.
- TypeScript: `npx tsc --noEmit --incremental false` passed. Writer-ratchet: **3 passed**.
- Browser validation: **14 passed** at 1280px and 390px; application and queue screenshots were inspected. Tests use the installed Chrome with all APIs mocked. They cover exact application and contribution detail, source navigation, receipt retry permission, same idempotency key after an uncertain response, retained attempt history and no horizontal overflow.
- No production database, vendor communication, external message or deployment was used.

## Failure modes and next checks

Malformed outer data, contradictory source allocations or excessive history fail the read explicitly. The route logs `procurement.purchase_workspace.read_failed`; the client retains an already-loaded workspace after refresh failure and offers recovery. Invalid immutable evidence becomes a per-record review item without rewriting the recorded status. A cost command failure never prompts the user to receive stock again.

The integrated candidate must run all owners and reader tests against the final migration and source-loader contracts. Review current shipment allocation freshness and full source payload capture with the financial owner. Before external reporting is enabled, add delivery/acknowledgement state with its own idempotency and exact application reference.

The source-snapshot follow-up verifies the current recordCostRevision writer directly through the PostgreSQL workspace read with non-null raw evidence. Contract-only legacy hashes are accepted only when the raw payload is absent; a present snapshot must match the current full fingerprint and a changed snapshot requires review.
