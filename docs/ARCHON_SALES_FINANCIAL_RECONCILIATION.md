# Reconciled Archon financial snapshots

The exporter uses one internally reconciled Shopify raw snapshot: original merchandise and allocations, discounted shipping, added/included tax, original duties/fees, tips and total. Current/after-refund values are never substituted. Refunds remain the recorded OMS amount. Provider lines come from the same snapshot; operational OMS orders/lines, inventory and fulfillment are not modified. Other connectors retain their current export. Incomplete provider evidence does not claim reconciled detail.

Deploy the companion Archon receiver/report first, then Echelon. Normal outbox delivery enriches subsequent snapshots. Deployment does not automatically replay history.

Read-only preview:

```text
node --import tsx scripts/preview-archon-sales-financials.ts START_DATE END_DATE WORKSPACE_ID OUTPUT_JSON
```

Supply ECHELON_PREVIEW_DATABASE_URL and ARCHON_PREVIEW_DATABASE_URL securely. Dates are inclusive Eastern dates, USD, at most 31 days/1,000 orders. Both transactions are repeatable-read READ ONLY; there is no apply mode. TLS verification defaults on; operators may explicitly set PREVIEW_ALLOW_UNVERIFIED_TLS=true for managed Heroku certificates unavailable to the local runtime. Never commit credentials or production preview rows.

The preview records IDs, monetary before/after headers, source revisions/evidence and fingerprint, without customer contact data. The databases are separate snapshots. Re-preview after deployment before approved replay. The existing replay refreshes the entire order projection (also line items, statuses, classification and attribution); approval must cover exact IDs and full projection scope. A monetary preview alone is not authorization to enqueue replay. Ambiguous identity/rejected snapshots remain review items. Archon records accepted financial changes in immutable crm.audit_log within the projection transaction.

Read-only sample: September 23, 2026 has 43 qualifying USD orders, all 43 reconcilable from stored provider evidence. One order changes by +400 cents; refunds unchanged. Recorded total 252913 cents, proposed total 253313 cents. No production write/replay performed. This dated sample does not establish all historical coverage or reconciled payments.
