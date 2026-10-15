# Shipment invoice replacement validation

Reproduction base: `079d4274b2c8ed42ae3f1e8a6b6eb7dc9acf01af`. Final implementation base: `9e09d41dad4dbee0575d0bc7db10d692ebb9e61c`, refreshed on 2026-10-15. Incoming PR1795 changes Dropship/CI paths; procurement implementation is unchanged by that refresh. Publication additionally merges main `7c1a9c266712690be721c408a3536a1cb9c3b8d2` (PR1796 order-edit changes); all 31 approved file blobs remain identical across that merge.

## Reproduced behavior and correction

Three disposable PostgreSQL characterization cases reproduced the original void/replacement dead end through actual application owners. The original foreign key and freight lines remain after void, both available-cost selectors exclude them, generic same-number recreation is rejected, and unlink rejects the terminal invoice. Clearing the foreign key alone does not establish new cost authority.

The correction is an explicit received successor, with immutable lineage and the same supplier number, complete locked charge reassignment, durable command replay and an audit record in the same transaction. The original is preserved. The shipment detail read now uses enriched/versioned cost rows, and the invoice detail plus replacement version share one read-only repeatable-read transaction.

## Executed checks

- Procurement unit suite: **2,831 passed**, **14 existing skips**, across 205 files. Includes the new eligibility/contract and invoice-lineage tests. This is a complete clean rerun after updating two assertions that described the original misleading voided status.
- PostgreSQL: **214 passed**, no failures or skips, across nine suites. The eight existing regression suites were rerun completely after adding the new read dependency to the invoice-PO comparison fixture. The new replacement suite passed all **19 cases**.
- Browser: **38 passed**, no failures or skips, across desktop/mobile. Includes 18 replacement cases and 20 existing AP safeguards. A first run exposed a test navigation mistake; the corrected complete run passed. Screenshots were inspected at both sizes. The final saved-request wording change does not alter behavior.
- Focused UI/recovery/route units: **48 passed**, including storage failures, lost responses, strict HTTP input, permissions, replay headers, composed shipment reads, existing navigation and detail-load recovery. Some route cases also belong to the procurement count; counts are not additive.
- CI/migration guards: **226 passed** across six suites. Includes all five preflight suites plus migration-allocation tests. The three affected browser/typing/workflow guards passed again after refreshing main.

- All three TypeScript projects passed on the refreshed base: application, server tests and client tests. The new browser spec also passed a direct typing check.
- The production build passed on the refreshed base. Vite retains its existing large-chunk warning.
- PR1798 adds `900000006000017980001_invoice_replacement_lineage.sql` and its generated metadata, bringing the validated catalog to 516 migrations. The SQL remains byte-identical to the reviewed candidate.

After merging publication base `7c1a9c266712690be721c408a3536a1cb9c3b8d2` and allocating PR1798, the allocated migration passed all **19 replacement PostgreSQL cases**, the **226 guard tests** passed, and all **three TypeScript projects** passed again. The 214-case PostgreSQL regression suite and production build above were run before this allocation; procurement production files are unchanged by the merge and allocation.

The exact commands, raw logs and final readiness receipt are retained in the local review output `outputs/procurement-invoice-recovery-2026-10-15`.

## Hosted CI fixture correction

The first hosted run on `af97ab28f` exposed a gap in the local regression selection: `procurement-payment-controlled-acceptance.integration.test.ts` was registered in CI but absent from the nine local PostgreSQL suites above. All six failing cases called the actual invoice detail route; `getInvoiceById()` called `readInvoiceReplacementDetail()`, whose freight-footprint query required `procurement.inbound_freight_costs`. `PaymentAcceptanceFixture.TABLES` omitted that table. The six failures were reproduced locally before changing the fixture.

The fixture now creates the canonical `schema.inboundFreightCosts` through its existing schema/FK/reset owner. An additional HTTP test checks ordinary product-invoice detail, explicit replacement ineligibility, unchanged balances/history, and an unchanged financial graph. Existing payment assertions and production error handling are preserved.

The same hosted run also failed a quarantine browser checkbox action. Its trace shows the location popup still mounted in its closed/exit-animation state when the next action began. The location helper now asserts the selected value and waits for the option to unmount; native clicks/checks and payload assertions remain unchanged. Ten baseline local repetitions passed, so exclusive causality for the hosted failure is not established. No arbitrary delay or forced click is added.

The correction includes a clean merge of main `b6fb3883061662c17733740f466448331b8062fb` (shipment cost workflow). Independent review verified that the merged routes retain invoice-enriched shipment reads and that the UI retains replacement links alongside the new cost-review workflow.

Validation on the merged correction: **92 PostgreSQL cases** passed (13 payment, 19 replacement, 60 receiving/cost-application), **315 unit tests** across 19 affected server/client suites, and **78 desktop/mobile cases** across quarantine, replacement, shipment cost workflow and summary. No failures or skips occurred in these runs. All **three TypeScript projects** and the **516-migration ownership check** passed. The owned PostgreSQL cluster and frontend server were stopped after testing. These counts overlap prior runs and are not additive. Logs are retained under `outputs/procurement-invoice-recovery-2026-10-15/ci-correction`. Hosted rerun and deployment remain unverified.

## Database coverage

The new suite exercises exact retained original data, same-number creation, fresh approval/payment state, cloned legitimate PO links, atomic charge reassignment, durable replay, rollback after injected audit failure, concurrent distinct commands, stale previews, generic duplicate protection, immutable identity/deletion/attachments, zero values, closed shipments, payment history including voided payments, invalid source ownership and amounts, strict inputs, repeated replacement generations and current cost authority.

A deterministic race commits a separate header edit immediately after the actual detail header SELECT. The returned display and replacement token both retain the original snapshot; the next GET sees the new state. Real cost revisions retain all historical invoice rows while selecting only the approved successor as invoice authority. The PO shipment-cost reader agrees. No inventory cost application is created by replacement.

Existing regression suites cover AP financial safeguards (13), invoice PO comparisons (8), invoice cost review (10), exact value allocation (15), receiving cost application (54), controlled procurement flow (3), shipment cost commands (40), and shipment line commands (52). All writes use fresh databases on the verified owned local PostgreSQL17 cluster. Generated databases were dropped, and the server was stopped after verifying that no other clients remained.

## Review, assumptions and limits

An independent reviewer traced the command, migration, database mutation bypasses, both cost readers and UI boundary, and independently ran the 52 eligibility/lineage tests. Identified gaps in identity editing, tail deletion, original attachments, strict input and detail snapshot consistency were fixed before completion.

No payment allocation policy or historical inventory correction is assumed. This recovery supports complete unpaid shipment-charge invoices without any payment history. Mixed/product/unmapped sources, signed or inconsistent amounts, broken ownership, cancelled shipments and unsupported PO links remain explicit review cases. They are not silently cloned, cleared or renumbered.

PR1798 supplies the generated migration identity. Allocation preserves the reviewed SQL SHA256 `7d30a023e38e79016a771696ef810f4c647a3848c64d05742f6c8e582f586331` and Git blob `607a18b66cc883b9394757afee4ea0d4c39bb7dd`. Local tests do not prove hosted CI, migration application, deployment, live acceptance or production prevalence. The shared graph-lock throughput has not been benchmarked. F19 and the remaining F23 shipment-detail recovery work remain separate.
