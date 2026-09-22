# Shopify customer returns implementation

## First increment: order access, eligibility and authorization persistence

This increment implements the internal application/domain and persistence foundation for one customer return spanning original shipments. It does not register a public route or enable intake. The customer interface, verified access-token adapters, live Shopify source reader, operational child cases and shipping workers follow in subsequent increments.

Confirmed commercial scope is domestic U.S. Shopify orders, a 365-day purchase window, delivered quantities (or audited staff verification), optional customer reasons, and manually issued Shopify refunds. Warehouse selection is staff configuration. No new send-back deadline or automatic refund operation is introduced.

### Implemented boundaries

- `domain/customer-return-order-reference.ts` normalizes only the optional leading `#` and surrounding/prefix-adjacent whitespace. It preserves string identity, leading zeros, case and merchant affixes.
- `application/customer-return-order-access.service.ts` requires a trusted request-scoped customer principal or an exact guest order grant. Its PostgreSQL adapter matches aliases within that scope and detects ambiguity. A reference alone never grants access.
- `domain/customer-return-eligibility.ts` evaluates strict, complete source facts against an injected instant. Original fulfillment identities remain distinct from purchased lines and WMS partitions. Unknown/conflicting delivery or unresolved claims cannot grant units. A staff exception covers only its approved quantity.
- `application/customer-return-authorization.service.ts` rechecks access before replay, loads provider facts outside transactions, then reads current local claims under source locks. A versioned review fingerprint includes decision evidence, configuration and destination; polling observation timestamps do not invalidate unchanged selections. Submission allocates quantities deterministically and persists one authorization.
- `infrastructure/customer-return-authorization.repository.ts` persists the root, purchased lines, original fulfillment allocations/claims, command result, audit and outbox atomically. It checks OMS, WMS-item and fulfillment capacity under the existing return order lock and row locks. Migration `0698_customer_return_authorizations.sql` adds foreign keys, ownership guards, balanced evidence constraints and append-only history.

Optional customer reason stays null when omitted. It is not replaced with a fabricated reason. Policy and warehouse snapshots belong to the authorization. Payment execution and inventory movements are absent from this increment.

### Composition requirements

`CustomerReturnAuthorizationService` requires injected order access, source reader, transaction store, clock, actor reader, source-age limit and intake-readiness check. The readiness check must stay closed until all existing return writers participate in one entitlement contract. There is intentionally no environment switch or HTTP endpoint that enables these writes today.

The live source reader must provide complete, paginated facts and exact mappings, normalize provider identities consistently, and distinguish active original fulfillment from canceled/replacement provenance. Its external claim list must exclude Shopify Returns already mirrored from local Echelon authorizations by exact provider identity. Local claims are merged separately under lock; counting both would reserve the same units twice. Legacy expected returns without proven fulfillment allocation currently require review.

The principal adapter must verify account identity or an order-bound email token before supplying the application principal. The HTTP layer must project a restricted customer DTO from the internal eligibility model; evidence IDs, staff audit identities and warehouse configuration are internal. Never accept eligibility facts, destinations, principal identity or staff approvals from a customer request body.

Provider reads must complete before acquiring database locks. Completed command replay does not require a new source read and remains available when intake is paused. Unknown dependency errors are classified and logs contain operation/code, not raw SQL, provider payloads, email or order reference. Concrete adapters remain responsible for their own safe provider diagnostics.

### Validation

Focused unit tests exercise reference preservation, ownership/ambiguity, delivery and date boundaries, staff exceptions, split allocations, quantity conservation, stale reviews, replay and malformed ports. The two PostgreSQL suites use separate explicitly disposable local databases:

```powershell
$env:ECHELON_TEST_DATABASE_DISPOSABLE = 'true'
$env:ECHELON_TEST_DATABASE_URL = 'postgresql://returns_test@127.0.0.1:55473/returns_portal_test'
$env:RETURNS_ACCESS_TEST_DATABASE_URL = 'postgresql://returns_test@127.0.0.1:55473/returns_access_test'
node node_modules/vitest/vitest.mjs run server/modules/returns --maxWorkers=3
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

These test databases must be disposable. The tests rebuild only their dedicated schemas after checking explicit opt-in and local database identity. Order lookup applies the original OMS table definition plus its customer identity migration. Authorization tests apply the complete new migration against prerequisite schemas. Provider APIs are represented by trusted test fixtures; passing these tests does not prove live Shopify or ShipStation acceptance.

### Remaining implementation and launch gates

1. Connect verified account/guest access and a complete Shopify source reader, exact mirrored-return correlation, versioned warehouse/policy configuration and customer-safe DTOs. Validate existing orders including #63210 and #63268 using timestamped evidence, not permanent assumptions about their current status.
2. Connect all return writers to shared claims, native Shopify Return synchronization and Echelon operational child cases. Add audited cancellation/release evidence and fence refund execution for linked cases before enabling intake.
3. Implement real return parcel plans, strict ShipStation tracked-return quotes, durable label purchase/recovery/void and authorized artifacts. Verify account capabilities and package measurements; no blind retry after an ambiguous purchase.
4. Extend receiving, inspection and disposition to partial quantities; reconcile staff-issued Shopify refunds without duplicated receipts or stock effects. Verify Shopify admin restock behavior and the single inventory authority.
5. Connect the reviewed customer experience and staff exceptions, notifications and return tracking. Reconcile existing hosted-portal returns, run shadow comparison and an approved operational canary, then enable public intake.

The unresolved risks are source/correlation gaps, legacy writers bypassing new claims, provider purchase ambiguity, package-data completeness and refund/restock reconciliation. They remain explicit gates; this foundation is not a deployed or launch-ready portal.
