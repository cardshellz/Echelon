# Shopify customer returns implementation

## First increment: order access, eligibility and authorization persistence

The foundation implements internal application/domain and persistence for one customer return spanning original shipments. A private standalone portal now exercises the proposed customer flow with fictional sample orders. Neither increment registers public customer intake. Verified customer access-token adapters, the live Shopify source reader, operational child cases and shipping workers remain implementation gates.

### Private standalone testing and customer visibility

Private testing uses the customer-facing standalone experience, outside Echelon's application shell, while customer access stays closed until launch. `Router` in `client/src/App.tsx` handles `/return-portal` and `/return-portal/access` before `AppShell`. `CustomerReturnPortalPreview` supplies the private testing controls and an injected gateway to `CustomerReturnFlow`; the scenario selector and integration notices sit outside that shared customer flow. The same flow component is intended for eventual customer use when the access and live-service adapters are ready.

`CustomerReturnPortalAccess` renders only the staff sign-in page at `/return-portal/access`, using the existing Echelon login service. It requires fresh authorization from `/api/returns/admin/portal-preview` after authentication, then performs a fixed full navigation to `/return-portal`, where the HTML gate checks again. `registerCustomerReturnPreviewRoutes` protects the portal page and every method under that API prefix before the SPA fallback. An unauthenticated portal visit redirects to the fixed access page; an authorized visit to legacy `/returns/portal-preview` redirects to the fixed standalone root. Query-supplied destinations are rejected. The access page grants neither order lookup nor API access. Separate tester invitations are not implemented.

The gate uses the session user ID to read current identity records. Stored session role strings, customer/Dropship sessions and internal API keys do not grant preview access.

Preview access requires an active account with both the current `users.role = admin` and the built-in system `Administrator` membership. Existing `seedRBACUseCase` assigns that membership for existing admin users. Those fields are independently editable, so either demotion denies access; incomplete admin configuration also denies access rather than auto-granting a role. The owner's production account configuration has not been read or changed by this work.

All preview responses and the portal/access pages have private/no-store and no-index headers. `client/public/sw.js` treats `/return-portal`, `/returns/portal-preview` and `/api/returns/admin/portal-preview`, including their subpaths, as network-only with no cache fallback. The client waits for fresh preview authorization, keeps data in component state rather than the shared query cache, and clears the flow when the authenticated identity changes or an API denies access. There is no customer launch, preview bearer token, live submit endpoint, or public bypass. Serving the sign-in page does not expose the customer journey.

`CustomerReturnPreviewService` serves five deterministic fictional scenarios: delivered split shipments, partially delivered quantities, in-transit items, already claimed units and an elapsed return window. It calls the same `evaluateCustomerReturnEligibility` function as the authorization foundation. The sample clock is fixed at September 22, 2026, so test outcomes do not silently change with calendar time. Sample references are `TEST-1001` through `TEST-1005`; these are not current readings of orders #63210 or #63268.

The preview walks through order reference entry, item quantities with optional reasons, exact contents for one or several return boxes, and server-validated review. Sample order lookup accepts an optional `#` using the existing reference normalizer. Review validates every selection against freshly evaluated sample eligibility and requires each selected unit to appear in exactly one box. No warehouse address, staff delivery evidence or internal provider identity is included in the preview DTO. Warehouse selection remains a future admin configuration capability, never a customer question.

The preview has no authorization repository, shipping client, notification sender, inventory writer or refund executor. Finishing review creates no RMA, label, reservation or financial effect; the label action is unavailable and the separate private testing controls identify the missing live integrations. There is no persistence or cross-device resume for a sample session. A real-order read-only inspection slice can precede write integration behind this same fresh-admin boundary. Actual return creation and label purchase require the shared-claim and operational gates below. Customer launch remains a separate explicitly approved change after those gates are satisfied; a standalone page or deployed private gate does not establish live end-to-end readiness.

Confirmed commercial scope is domestic U.S. Shopify orders, a 365-day purchase window, delivered quantities (or audited staff verification), optional customer reasons, and manually issued Shopify refunds. Warehouse selection is staff configuration. No new send-back deadline or automatic refund operation is introduced.

### Implemented boundaries

- `domain/customer-return-order-reference.ts` normalizes only the optional leading `#` and surrounding/prefix-adjacent whitespace. It preserves string identity, leading zeros, case and merchant affixes.
- `application/customer-return-order-access.service.ts` requires a trusted request-scoped customer principal or an exact guest order grant. Its PostgreSQL adapter matches aliases within that scope and detects ambiguity. A reference alone never grants access.
- `domain/customer-return-eligibility.ts` evaluates strict, complete source facts against an injected instant. Original fulfillment identities remain distinct from purchased lines and WMS partitions. Unknown/conflicting delivery or unresolved claims cannot grant units. A staff exception covers only its approved quantity.
- `application/customer-return-authorization.service.ts` rechecks access before replay, loads provider facts outside transactions, then reads current local claims under source locks. A versioned review fingerprint includes decision evidence, configuration and destination; polling observation timestamps do not invalidate unchanged selections. Submission allocates quantities deterministically and persists one authorization.
- `infrastructure/customer-return-authorization.repository.ts` persists the root, purchased lines, original fulfillment allocations/claims, command result, audit and outbox atomically. It checks OMS, WMS-item and fulfillment capacity under the existing return order lock and row locks. Migration `0699_customer_return_authorizations.sql` adds foreign keys, ownership guards, balanced evidence constraints and append-only history.

Optional customer reason stays null when omitted. It is not replaced with a fabricated reason. Policy and warehouse snapshots belong to the authorization. Payment execution and inventory movements are absent from this increment.

### Composition requirements

`CustomerReturnAuthorizationService` requires injected order access, source reader, transaction store, clock, actor reader, source-age limit and intake-readiness check. The readiness check must stay closed until all existing return writers participate in one entitlement contract. There is intentionally no environment switch or HTTP endpoint that enables these writes today.

The live source reader must provide complete, paginated facts and exact mappings, normalize provider identities consistently, and distinguish active original fulfillment from canceled/replacement provenance. Its external claim list must exclude Shopify Returns already mirrored from local Echelon authorizations by exact provider identity. Local claims are merged separately under lock; counting both would reserve the same units twice. Legacy expected returns without proven fulfillment allocation currently require review.

One provider fulfillment line may contain several exact WMS allocations. Their original purchased quantities must sum to the provider quantity; current claims retain both provider and WMS identity. A native external claim against such a split also needs exact quantity-bearing WMS attribution. If that evidence is absent, the service requires reconciliation rather than assigning the claim to whichever warehouse record appears first.

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

Both database suites are also registered in `scripts/ci/postgres-test-manifest.ts`. CI creates a fresh database and process per test file. The returns test guard accepts that exact owned-name convention, rejects remote/query-override/application targets and keeps the two local suite databases separate.

The private preview adds no schema or database writer. Real HTTP tests exercise its actual Express gate with injected Identity reads, including both independent demotions, direct page access, login-only access, fixed legacy redirects, rejected redirect/query overrides, unsupported methods, malformed payloads and sanitized dependency failures. Unit tests cover sample eligibility, exact line/box conservation and service-worker cache isolation. Desktop/mobile browser tests use the real sample service through intercepted HTTP for packing, optional reasons, identical product names, Back, scenario reset, denied access, malformed responses and delayed responses. They also verify standalone branding and layout, sign-in requiring fresh API authorization, recovery after denied/unavailable access, case and trailing-slash routes, and absence of Echelon service-worker registration. Results are recorded in the pull request; these application tests do not prove live provider acceptance or the owner's production permissions.

```powershell
node node_modules/vitest/vitest.mjs run server/modules/returns/__tests__/unit client/src/lib/__tests__/unit/customer-return-preview.test.ts client/src/lib/__tests__/unit/customer-return-preview-cache.test.ts
node node_modules/@playwright/test/cli.js test --config playwright.returns-preview.config.ts
```

The browser suite uses its own local Vite port and fictional API responses; it never starts the application server, connects a database or contacts Shopify/ShipStation. On Windows an installed Chromium executable can be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. CI installs an isolated browser and runs the same desktop/mobile suite.

### Verified integration boundaries

The following source findings determine the next increment; they are not claims about current production records:

- `mapShopifyFulfillmentIngress` in `server/modules/oms/shopify-fulfillment-ingress.adapter.ts` assigns the REST line ID to both purchased-line and source-fulfillment-line fields. `ShopifyFulfillmentSnapshotReader.fetch` in `server/modules/oms/shopify-fulfillment-snapshot.ts` queries GraphQL `FulfillmentLineItem.id` separately from `lineItem.id`. The reader must prove provider identity provenance and exact quantity-bearing WMS mappings; a similarly named receipt column is insufficient. Existing readers do not supply complete paginated delivery and native Return evidence.
- `loadSourceItems` in `infrastructure/open-return-case.repository.ts` and `createExpectedReturn` in `server/modules/oms/shopify-refund-cascade.service.ts` subtract legacy expected quantities without the new claims. Materializing an expected child also requires an exact allocation-to-child-item link so its units are not counted twice. No existing writer has been changed in this increment.
- `ReturnCaseFinancialService.issueCustomerRefund` can resume a reserved intent before deriving current action availability. Its `resumeCustomerRefund` invokes the provider. The manual-refund fence must therefore cover quote, reservation, pending execution and case association races; hiding the action alone is insufficient. `ReturnsService.processReturn` also needs a canonical receiving boundary for linked merchandise.
- Canonical child cases require a policy ID and operational snapshot in `shared/schema/returns.schema.ts`. The eligibility snapshot stored here is not that operational policy contract. Pin both to the authorization before materializing children; do not silently resolve a different policy later.
- Echelon staff sessions and Dropship member challenges are not retail customer proof. The adjacent `shellz-club-app` has a Shopify App Proxy and member JWT flow in `server/routes/portal.ts` and `server/portal-jwt.ts`, but no dedicated audience/shop/channel-bound handoff to Echelon. Its active-membership requirement also cannot cover retail guests. Dedicated customer and order-bound guest adapters are still required.
- Warehouse address records exist in `shared/schema/warehouse.schema.ts`, but fields are nullable and there is no versioned return-destination selection. The outbound default warehouse is not an approved return destination. Add staff configuration with a validated address and snapshot its version.

### Next increment: real-order read-only inspection

Add a separate inspection application service behind the current private admin gate, with only read ports for a configured Shopify channel, exact local order/line mappings, claims and delivery provenance. Reuse the reference normalizer and pure eligibility evaluator, then project customer-safe data into the shared flow. Staff selection of a test order is test authorization, not proof that a retail customer owns it. Do not fabricate a customer principal or call authorization submission, fulfillment ingress, repair jobs or shipping operations from this service.

The channel-specific client construction in `server/modules/channels/channel-fulfillment-provider-clients.service.ts` and the existing Shopify snapshot reader provide reusable connection/query boundaries. They do not constitute a complete return source. The adapter must prove pagination completeness, normalize each identity from its actual source, distinguish active/canceled/replacement allocations, correlate native Shopify Returns already mirrored locally, and tie delivered or audited staff-verified quantities to exact purchased-line allocations. `createCarrierTrackingProjectionReader` in `server/modules/shipping/carrier-tracking-projection.repository.ts` supplies package-level tracking evidence; it does not establish complete purchased-line delivery entitlement by itself. Missing, ambiguous or conflicting evidence must produce unavailable/reconciliation results, not inferred delivery or a first-WMS/SKU match.

Acceptance for this slice is a timestamped, read-only view of real selected orders, including #63210 and #63268, with exact split-shipment quantities, explicit uncertainty and no side effects. Order statuses must be observed afresh. Live lookup, item selection, packing and review can then be tested privately; return authorization, labels, receiving and refunds remain unavailable. Production channel access, provider scopes, source completeness and account configuration have not been verified by this work.

### Remaining write-integration and customer-launch gates

1. Complete the live source and exact mirrored-return correlation, verified account/order-bound guest access, and versioned staff warehouse/policy configuration. Reuse the shared customer flow with the appropriate access/gateway adapters; do not expose the private testing controls or trust customer-supplied evidence, destinations or identities.
2. Connect every existing return writer to one shared entitlement contract before enabling authorization intake. Add exact root-allocation-to-child-item links so materialized Echelon cases do not consume the same quantity twice; create operational children transactionally using pinned policy/destination snapshots. Add audited cancellation/release, native Shopify Return reconciliation and a manual-refund fence covering quotes, reservation, pending provider execution and case-association races.
3. Implement real return parcel plans, strict ShipStation tracked-return quotes, durable label purchase/recovery/void and authorized artifacts. Verify account capabilities and package measurements; no blind retry after an ambiguous purchase. The existing rating boundary does not provide return-label orchestration.
4. Extend receiving, inspection and disposition to partial quantities; reconcile staff-issued Shopify refunds without duplicated receipts or stock effects. Verify Shopify admin restock behavior and the single inventory authority. Link legacy receiving paths to the canonical return before they can process the same merchandise.
5. Complete audited staff delivery exceptions, notifications and return tracking. Reconcile existing hosted-portal returns, run shadow comparison and an approved operational canary behind the private gate, then separately approve customer launch. Moving or deploying the page alone must not open public intake or enable money/inventory effects.

The unresolved risks are source/correlation gaps, legacy writers bypassing new claims, provider purchase ambiguity, package-data completeness and refund/restock reconciliation. They remain explicit gates; this foundation is not a deployed or launch-ready portal.
