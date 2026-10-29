# Purchase-based historical returns and mixed-box receiving

## Summary of changes

The normal customer return path now uses the verified Shopify purchase and purchased-line IDs. Original outbound warehouse orders, picking records, fulfillment links, delivery scans and package contents are not prerequisites. Missing optional warehouse history cannot make otherwise eligible purchased units unavailable.

Each accepted RMA creates its own expected inbound receiving header and purchased-line items. Their original outbound order/item fields are explicitly null; the authorization is their source. No fictional outbound order, shipment, fulfillment ID, original price or zero-dollar monetary snapshot is created. Existing fulfillment-based authorizations and receiving cases remain compatible.

The immutable return-box manifest owns which purchased units are inside each new return parcel. Customers can mix items across the original shipments. Staff receive an exact return label against this new manifest, then use the existing receipt, inspection and disposition owners. Refunds remain separately reviewed in Shopify.

## Concrete normal flow

1. Verify the signed-in customer's exact channel/order/purchase ownership and native purchased lines.
2. Apply the existing return policy to physical purchased units, subtracting existing physical return authorizations and exact historical physical claims. Money-only refunds and refundable dollar quantities do not reduce physical entitlement.
3. Share purchased-line preparation across selection, review and submission. Reserve locally claimed quantities under the existing order locks and durable command identity.
4. Create the RMA, its expected inbound receiving work, case items and immutable parcel manifests atomically. Do not require any original outbound warehouse rows.
5. Quote and generate one label per new return box using existing shipping owners. An uncertain purchase is recovered using its original identity, never purchased again blindly.
6. Receive any mixed box by its exact return tracking label. Receipt commands, quantities, parcel allocations and audit records commit together; retries replay the recorded result.
7. Continue inspection and disposition through the existing owners. Native receiving can retain missing sold-cost evidence as the existing durable cost follow-up; it does not invent original costs.

Catalog weights normally calculate postage weight. If they are missing, the customer enters the actual sealed box weight in ounces. Shared validation converts it to whole grams, enforces the known product-weight subtotal and checks carrier limits. Changing contents or box size clears the old scale measurement. The measured weight survives review, submission, lost-response recovery and retry.

Unrelated warehouse/delivery/refund observations no longer invalidate a purchased return review. Ownership, policy, purchase quantities, physical return claims, shipping address and relevant package measurements still do. Cached account options refresh through the normal bounded invalidation worker after deployment.

## Code trace and evidence

| Responsibility | Exact file and function |
|---|---|
| Purchase entitlement, retained policy and quantity limits | `server/modules/returns/domain/customer-return-eligibility.ts`, `evaluatePurchasedCustomerReturnEligibility` |
| Physical claims separated from money | `server/modules/returns/application/customer-return-live-claims.ts`, `readPurchasedCustomerReturnClaims` |
| Shared selection/review/submission preparation | `server/modules/returns/application/customer-return-intake-preparation.ts`, `prepareCustomerReturnSelectedLines` |
| Stable decision revision independent of warehouse/refund observations | `server/modules/returns/application/customer-return-live.service.ts`, `purchasedReturnSource` |
| Locked purchased capacity and exactly-once authorization | `server/modules/returns/infrastructure/customer-return-authorization.repository.ts`, `lockSource`, `assertCapacity`, `persist` |
| New inbound work from the RMA | `server/modules/returns/infrastructure/customer-return-intake.repository.ts`, `materializePurchasedReturnCase`; `server/modules/wms/expected-return-commands.ts`, `createExpectedWmsReturn` |
| Nullable outbound provenance with exact parent/line guards | `migrations/900000040000019450002_purchase_return_receiving.sql` |
| Shared measured-weight validation | `shared/returns/customer-return-parcel.ts`, `resolveCustomerReturnParcelWeight`; `server/modules/returns/application/customer-return-box-plan.ts`, `validateCustomerReturnBoxPlan` |
| Useful saved rejection reasons | `server/modules/returns/application/customer-return-submission.service.ts`, `execute`, `completed`, `definitiveFailureCode`; `shared/returns/customer-return-errors.ts`, `customerReturnRejectionMessage` |
| Mixed-box receipt owner | `server/modules/returns/application/return-parcel-receiving.service.ts`, `receive`; `server/modules/returns/infrastructure/return-parcel-receiving.repository.ts`, `load`, `save` |
| Receiving UI and HTTP boundary | `client/src/components/returns/ReturnParcelReceivingCard.tsx`, `receive`; `server/modules/returns/interfaces/http/return-parcel-receiving.routes.ts`, `registerReturnParcelReceivingRoutes` |
| Explicit unknown sold-cost provenance and stock replay | `server/modules/inventory/application/return-restock.use-case.ts`, `applyReturnedStock`, `validateReplay` |

## Assumptions and retained rules

The existing US destination, physical-item, cancellation and return-window policies remain in force. A verified purchase supplies entitlement; it does not bypass ownership or authorize excess units, duplicate claims or refunds. Separate native Shopify returns and local RMA records remain separate claims unless a durable mirror link proves otherwise; identical SKU or quantity is not correlation.

Known historical claims are assigned only to exact purchased lines. Missing optional warehouse identities are not grounds for denying the verified purchase. The original outbound order and all historical money snapshots remain untouched. Broad Club/Echelon money-storage changes remain deferred.

## Synthetic acceptance and test coverage

The large synthetic purchase contains nineteen physical units across four purchased lines plus a membership. Two purchased sleeve lines deliberately share a SKU. The customer returns thirteen units, repacked across two mixed boxes, from an original three-shipment order.

| Purchased line | Purchased | Return box A | Return box B |
|---|---:|---:|---:|
| Sleeves A | 9 | 4 | 2 |
| Toploaders | 6 | 1 | 3 |
| Storage boxes | 3 | 1 | 1 |
| Separate sleeve purchase | 1 | 0 | 1 |

Real local PostgreSQL services execute ownership reads, policy/configuration, preparation, claims, intake, receiving cases, parcel manifests, label orchestration, receipt, inspection and disposition. Shopify and carrier quote/purchase/recovery ports are synthetic. The no-history scenario removes all original warehouse orders and physical shipments and supplies no Shopify fulfillment records. It still accepts purchased items, creates two labels, receives both mixed boxes and completes inspection/disposition with same-key retries.

Validation on the current implementation:

- 31 connected complex PostgreSQL scenarios passed.
- 138 existing PostgreSQL authorization, inspection, intake and label regressions passed.
- 1,725 affected unit/contract/HTTP checks passed in one final current-main run. Earlier development encountered a Node fetch blocked ephemeral port before application handling; no application assertion was weakened.
- Ten desktop/mobile browser cases passed; the two measured-weight cases also passed again with packing-form screenshots. Visual inspection confirmed the desktop/mobile form fits its viewport.
- Both server and client TypeScript checks passed on the final source.
- All 432 architecture/CI guards passed after allocating the migrations to draft PR #1945. No migration guard was bypassed.

Synthetic tests assert that original OMS orders/lines, outbound warehouse orders/items and shipments do not change. Customer acceptance/receiving tests assert no financial or inventory posting. One scenario seeds an existing synthetic physical-return journal row solely to prove correct remaining quantity; the application does not post another row. The stock-owner unit tests separately prove null outbound provenance, unresolved-cost follow-up and no second stock delta on replay.

## Failure modes and remaining release work

Actual ownership mismatch, excess/duplicate quantities and configured policy exclusions still prevent a return. Invalid or incomplete measured box weights prompt measurement; oversized/heavy boxes use the existing shipping guidance. Rate-service failures remain retriable. Unknown intake/label/receipt outcomes preserve the saved key and intent. Ambiguous return tracking cannot select a customer's box. Manual receipts without parcel attribution require staff reconciliation rather than invented box assignments.

The new receiving records explicitly allow missing original monetary snapshots; admin UI says they are reviewed in Shopify. No automatic refund derives a zero price from absent evidence. No real order, points, payment, refund, inventory balance, return or label command was submitted during validation.

These are local staging tests, not hosted deployment or live acceptance. Draft PR #1945 owns three forward-only migrations with explicit dependencies, allocated through the repository tool: historical purchased-line resolution, purchase-based inbound receiving, and parcel receipt evidence. Migration policy validates all 570 migration files against current main. Hosted CI is reported separately against the final published commit; no merge or deployment is included. Private customer diagnostics and logs under `.codex-artifacts` are excluded from publication.

## Reproduce

Use dedicated disposable local databases with `ECHELON_TEST_DATABASE_DISPOSABLE=true`; never point these schema-recreating fixtures at shared or production data.

```text
node node_modules/vitest/vitest.mjs run server/modules/returns/__tests__/integration/customer-return-complex-flow.test.ts
node node_modules/vitest/vitest.mjs run server/modules/returns/__tests__/unit
node node_modules/@playwright/test/cli.js test --config playwright.returns-preview.config.ts returns-customer.spec.ts --grep "mixed-box receiving|owned selection|uncertain creation|changed review|missing item weights"
node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p tsconfig.tests.server.json --pretty false
node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p tsconfig.tests.client.json --pretty false
node scripts/ci/run-test-lane.mjs guards
```
