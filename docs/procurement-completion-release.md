# Procurement completion release

This coordinated batch implements the five coding items remaining after the procurement foundation, cost lineage, daily planning and connected lifecycle releases. Echelon and Archon require separate pull requests because they are separate repositories. Both target `main`; there is no remaining procurement feature-branch deployment stack.

## What changed

| Capability | Implementation and review evidence |
| --- | --- |
| Quantity-based supplier prices | [Supplier sourcing contract](../shared/procurement/supplier-sourcing.ts), `selectSupplierPriceTier`, retains quote reference, currency, validity, quantity threshold and purchase-unit conversion. The supplier catalog editor saves immutable policy revisions. The selected tier is captured with the recommendation and revalidated before a new purchase handoff. Quantity is determined by demand and purchasing rules, without increasing it solely to obtain a discount. |
| Ranked alternate suppliers | [Supplier selection](../server/modules/procurement/supplier-sourcing-selection.ts) evaluates eligible mappings and each supplier's lead time and purchasing rules before ranking. Daily review exposes the candidates and selected evidence. An alternate can become a reviewable RFQ proposal; creating a PO requires explicit supplier acceptance. Existing final RFQ quotation and exact replay remain separate authorities. |
| Carrier and container tracking | [Inbound tracking guide](procurement-inbound-tracking.md) covers SeaRates ocean and ShipStation parcel adapters, retained observations, source timestamps, provider failures and fenced polling. Tracking expands inside the purchase's shipment inspector and has a shipment detail tab. Telemetry never posts a warehouse receipt or makes inventory available for sale. |
| Archon reporting delivery | [Cost reporting service](../server/modules/procurement/cost-reporting.service.ts), `CostReportingService.tick`, delivers immutable source events through a destination-bound outbox with retries and exact acknowledgements. The companion Archon `CostReportInbox.accept` transaction retains evidence within its configured tenant/entity. The lifecycle workspace shows attempts, failure state and Archon's receipt/hash. Accepted cost evidence is available to Archon's reporting APIs; it does not create accounting journals. |
| Automatic receipt-cost recovery | [Receipt recovery guide](procurement-receipt-cost-recovery.md) describes bounded retries through the existing approved financial owner, with lease fencing, immutable history and visible exhaustion. Physical receiving stays committed when a subsequent cost operation fails. Review-required outcomes remain stopped for an operator. |

The [reporting delivery runbook](procurement-cost-reporting-delivery.md) and [supplier sourcing guide](procurement-sourcing-completion.md) provide the detailed contracts and setup.

The [integrated acceptance ledger](procurement-integrated-acceptance.md) covers the full procurement lifecycle and its remaining operational checks.

## Deployment order

1. Deploy [Archon receiver PR #276](https://github.com/cardshellz/archon-finance/pull/276) with migration `0082_procurement_cost_report_inbox.sql`. Keep `COST_REPORT_RECEIVER_ENABLED` unset or false until its source, destination, tenant/entity and credential are configured.
2. Deploy the Echelon completion PR. The existing release runner applies additive migrations `228` through `231`; it does not backfill or rewrite historical financial evidence. Keep tracking, report delivery and receipt-cost recovery activation flags unset or false for the initial code deployment.
3. Configure supplier priorities and current quote tiers in the supplier catalog. Existing supplier mappings continue to work; tier pricing is optional. Review representative imported and domestic recommendations against their stock, demand, lead times, MOQ and final quote evidence.
4. Configure the external services with actual account and entity information, then enable each independently. Track one known shipment and reconcile one accepted cost report before relying on ongoing delivery. Receipt-cost recovery can be enabled independently of carrier and Archon setup.

No live settings, provider credentials, financial records or vendor-send automation were changed while developing this batch.

## Configuration boundaries

| Worker | Activation and stop controls | Required operational input |
| --- | --- | --- |
| Receipt-cost recovery | `RECEIPT_COST_RECOVERY_ENABLED=true`; stop with `RECEIPT_COST_RECOVERY_DISABLED=true` or `DISABLE_SCHEDULERS=true`. | Inspect unresolved cost requests and existing component evidence. Review-required records remain manual. |
| Inbound tracking | `PROCUREMENT_TRACKING_POLLING_ENABLED=true`; stop scheduling with `PROCUREMENT_TRACKING_DISABLED=true` or `DISABLE_SCHEDULERS=true`. | Provider entitlement and credentials plus shipment reference/carrier. See the exact keys and supported references in the tracking guide. |
| Echelon report delivery | `COST_REPORT_DELIVERY_ENABLED=true`; stop scheduling with `COST_REPORT_DELIVERY_DISABLED=true` or `DISABLE_SCHEDULERS=true`. | `COST_REPORT_DESTINATION_ID`, `ECHELON_COST_REPORT_SOURCE_ID`, `ARCHON_COST_REPORT_URL`, `COST_REPORT_ALLOWED_HOSTS` and `ARCHON_COST_REPORT_TOKEN`. |
| Archon report receiver | `COST_REPORT_RECEIVER_ENABLED=true`. | Matching `COST_REPORT_DESTINATION_ID`, `ECHELON_COST_REPORT_SOURCE_ID`, `ECHELON_COST_REPORT_TOKEN`, and the verified `COST_REPORT_ARCHON_USER_ID` / `COST_REPORT_ARCHON_ENTITY_ID`. |

The reporting endpoint is `/api/integrations/procurement-cost-reports`. The sender requires an allowlisted HTTPS hostname resolving exclusively to public IPv4 addresses and does not follow redirects. Credential rotation can retain the same source/destination binding. Changing a bound tenant, accounting entity or destination identity requires a separately reviewed migration; ordinary retries cannot retarget old events.

## Verification and failure handling

Focused unit tests exercise exact currency arithmetic, source validation, supplier decisions, transport limits and scheduler behavior. Disposable PostgreSQL tests execute the real procurement/inventory owners, immutable constraints, concurrent claims, expired leases, replay and transaction rollback. The sender and receiver share a fixed canonical contract vector. Browser tests exercise the actual frontend with explicitly fictional API responses on desktop and mobile; they do not establish live provider connectivity.

Before merging, inspect CI on the exact heads of both PRs. Echelon's normal CI includes the new sourcing, tracking and reporting PostgreSQL suites along with the existing receiving/RFQ/planning suites. Its procurement browser workflow includes the new tracking, sourcing and reporting journeys.

If a provider times out or rate-limits a request, retained attempts explain the retry. Out-of-order tracking observations remain inspectable without replacing newer evidence. Invalid report source evidence is quarantined visibly and does not block later valid events. Unknown acknowledgements never mark delivery complete. A response lost after receiver acceptance reuses the same retained report and receipt. Receipt-cost review and exhausted retries remain visible in the purchase workspace with the existing authorized manual recovery path.

For rollback, stop affected workers first and preserve the additive tables and all evidence. An older application version must not erase new source or delivery records. Code rollback cannot reverse inventory or costs already posted through their owners; those require their existing reviewed correction paths.

## Operational acceptance still required

Coding completion does not supply real supplier quotes, forecast assumptions, provider subscriptions or Archon tenant credentials. Reconcile representative live products and historical exceptions before treating recommendations as a stock guarantee. Missing historical lineage, unsupported accounting classifications and inventory-count discrepancies remain visible review work. No production forecast accuracy, carrier coverage or accounting posting is asserted by the synthetic tests.
