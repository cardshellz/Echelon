# Receiving quarantine: pending physical custody

This batch starts at main `d5964e3b90a3665f37e30c9a97c00058c1195002` and was refreshed to `9c3ab37bb63fd437bad631426721b52ec453a441` before full local validation. Publication also incorporates main `3aa15cd601e1e77a09f6c5e1487a967e8ba58340`, whose only intervening changes are the Shopify line-item discount normalizer and its test. Purchasing PR1771 and CI PR1784 are merged; their deployment was confirmed by the operator. This document does not certify a production readback.

## Operator workflow

Normal receipt counts mean accepted goods. For damaged goods on an unposted line, an inventory adjuster explicitly reviews the accepted quantity and held quantity, physical holding location, reason and evidence reference. The command retains the entire previous count/source snapshot and clears the old ambiguous damaged count. It never assumes that historical damaged counts were included in, or additional to, received counts.

Unexpected goods can be recorded without a product, SKU, unit factor or financial owner. The observation retains the operator's description and observed unit label. Both types remain visible after the receipt closes. A third-party virtual availability slot is not a physical holding location.

A purchasing approver can resolve part or all of the unallocated custody:

- **Prepare acceptance:** select an exact existing normal receiving source and review units and destination. Known goods preserve their base product, purchase/shipment source and exact piece count. Unknown goods require an explicit reviewed mapping from observed containers to receiving units. The receiving owner appends a dedicated line to a mutable receipt, or creates a normal source-linked draft after source close. Current catalog, location, source, count and cost evidence are rechecked. No stock, lot, AP payment or supplier credit is created at preparation.
- **Finalize the normal receipt:** existing receiving/cost/inventory owners post the accepted quantity. The same transaction completes its custody allocation. Until this commit, those goods remain physically held.
- **Cancel preparation:** before posting, zero the dedicated receiving line and retain its source/evidence history. The quantity becomes available for a different explicit resolution; no source line is deleted.
- **Record physical return:** retain collection evidence and reduce physical custody. This does not claim that a supplier credit, refund, writeoff or AP settlement occurred.

The source receipt and any target acceptance receipt show the same custody history. Resolution starts from the source receipt; the target uses normal receiving finalization. Commands preserve their exact idempotency key and payload after an ambiguous response or navigation.

## Integrity boundaries

Procurement owns four new tables: `receiving_custody_fence`, `receiving_quarantine_observations`, `receiving_quarantine_acceptances`, and append-only `receiving_quarantine_dispositions`. Original observation/source evidence cannot change. Database constraints reconcile balances and versions to the complete immutable disposition sequence and require exact receipt evidence for completed acceptance. Deletion, truncation, source reassignment, ordinary recounting, and bulk acceptance cannot erase or recreate held goods.

All custody commands use the existing durable financial-command owner, current locked Identity grants, an injected clock, the cost-graph lock and a persisted custody fence. Failures roll back custody, receiving preparation and success receipt together. Permissions are `inventory:adjust` for observation and `purchasing:approve` for resolution; role labels and scoped grants do not silently become global authority.

Physical held quantity is observed minus normally received minus physically returned; awaiting acceptance remains held. Count/manual-stock writers consult the public procurement reader inside their write transaction before inventory-level locks. Known custody blocks every pack of its base product at the holding location; unknown custody blocks the location. The persisted fence rejects stale serializable snapshots instead of permitting an older count to add the held goods to saleable stock.

This is pending-recognition intake. It does not move an already posted lot into quarantine, infer historical discrepancies, activate the quantity ledger, create arbitrary catalog products, or introduce a separate costing formula. The earlier recognized-lot quarantine foundation remains a separate unpublished workstream. Correction of already posted stock must continue through its existing correction authority until that workstream is integrated and validated.

## Release order and recovery

Draft PR1789 owns `migrations/900000004000017890001_receiving_quarantine.sql` and its generated sidecar under `migrations/metadata/`. It depends on `900000003000017710001_procurement_policy_revision.sql`. Allocation preserved the tested SQL bytes (SHA256 `14e13ba62f62a52e54ab86c52bda668b960b7d7d2237dfbb30e7ceb9b11f7ea2`); all fixtures load the allocated filename. The migration catalog check passes against current main with PR1789 ownership.

Use a maintenance window that drains receiving and inventory-count/manual-stock writers across every application and worker instance. Apply the allocated migration before starting the new code. Resume only the new fleet: an older binary does not enforce the custody reader and must not continue writing counts after custody is recorded.

After deployment, use a controlled non-production acceptance environment first: record held goods, prepare a partial acceptance, confirm available stock is unchanged, finalize normal receiving, and inspect the custody history and exact inventory/cost effects. Verify ordinary receipt counting still works and physical return has no AP side effect. Local test results are not this runtime proof.

If an operation is ambiguous, retry the original saved command. Refresh after a stale-version rejection and review before submitting a new command. If finalization fails, leave custody held; correct the normal receiving prerequisite or cancel its preparation. A missing custody table/fence fails closed. Do not disable guards or manually alter counters to recover.

Application rollback after custody exists requires keeping writers stopped and a reviewed compatibility plan. Do not drop the custody tables, reverse their immutable history or restart old count writers. Historical damage needs explicit physical review; there is no automatic backfill.

## Validation scope

Regression coverage includes quantity/unit boundaries, current authority, malformed requests, durable duplicate replay, changed-payload rejection, stale revisions, concurrent partial returns, immutable evidence, failed close, source/cost changes, normal close, all-held receipts, acceptance after source close, prepared acceptance count blocking, unknown/base-product count scope, no-op counts, and a stale serializable snapshot.

Browser acceptance covers desktop and phone layouts, normal receiving controls, explicit accepted/held counts, unknown custody, partial resolution, pending recovery across navigation, malformed/lost responses, capability controls, and source-receipt traceability. Existing receiving, quantity, cost-flow and CI guard suites remain registered. PostgreSQL tests use disposable local databases; they do not exercise production integrations or certify historical data.
