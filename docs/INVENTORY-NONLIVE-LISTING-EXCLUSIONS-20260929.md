# Approved non-live listing exclusions — 2026-09-29

## Confirmed production result

At **23:22:00 UTC**, the owner's approved four-link exclusion committed in one transaction:

| Destination | Variant | SKU | Membership version |
| --- | --- | --- | --- |
| Shopify, target 1 / channel 36 | 141 | SHLZ-MAG-35PT-P1 | 2, excluded (430) |
| Shopify, target 1 / channel 36 | 175 | SHLZ-TOP-TCG-SLIM-CLR-P25 | 2, excluded (431) |
| Shopify, target 1 / channel 36 | 176 | SHLZ-TOP-TCG-SLIM-CLR-C1000 | 2, excluded (432) |
| eBay, target 3 / channel 67 | 65 | ARM-ENV-GRD-C60 | 2, excluded (433) |

Both target revisions advanced from 3 to 4. They remain **preview** targets. Initial scope receipts, mappings, historical publication results and old membership versions were retained. The application appended membership decisions, per-target receipts and before/after audit events.

The authenticated provider GETs at **23:20:53 UTC** confirmed three missing Shopify inventory items/variants (404) and exact eBay offer `136412200011` remaining `UNPUBLISHED`, quantity zero, without a listing ID. These observations are not fabricated zero-publication acknowledgements.

The post-commit readback at **23:22:01 UTC** proved:

- Exactly the four selected membership heads are excluded.
- All **403 other membership heads** are unchanged.
- Affected SKU catalog records, inventory levels, lots and mapping heads are unchanged.
- All **10 previously identified held C1000 order lines** are unchanged, with zero picked/fulfilled quantities.
- Other publication targets are unchanged. The selected targets changed only revision/update timestamp.
- Runtime authority remains **legacy, revision 1**, with no configuration run. This is **not a completed ATP cutover**.
- No provider write, listing creation, outbox enqueue, inventory adjustment or order correction was performed.

## Implementation and execution boundary

`InventoryPublicationPrecutoverExclusionService` is an operator-only, configuration-only command. There is no new HTTP endpoint or UI. It uses the existing inventory membership tables; **no migration** is required. It was executed locally against the approved production connection, not by deploying or activating new runtime behavior.

`reviewPrecutoverExclusion` requires legacy authority, no open activation/freeze or publication suppression, initially prepared explicit Echelon-owned preview targets, matching destination and inventory identities, no pending publication, and fresh authenticated non-live provider evidence. Generic provider failures and published eBay offers do not qualify. The trusted operator adapter supplies GET evidence; the command is not exposed as an endpoint accepting public assertions about listing state.

`PostgresPrecutoverExclusionStore.apply` validates the semantic command, acquires the existing authority/admission fence before source locks, rechecks the reviewed hash, refuses active provider-scope locks, and appends all decisions/receipts/audits atomically. Retries replay the receipt; changed actors, inputs or a partial target set conflict. It never alters initial-scope receipts or pretends the canonical/live membership removal contract applies before cutover.

The existing canonical/live membership service retains its hold-and-verified-zero requirement. The new maintenance command rejects canonical authority and live destinations.

## Verification

- **108 tests passed** across the domain tests, real disposable PostgreSQL initial-scope/membership/scope suites, and writer ownership guard. No skips in the combined run.
- Application TypeScript and server/client test TypeScript checks passed.
- Integration tests cover unchanged protected records, immutable history, stale revisions, audit-failure rollback, cross-destination batch rollback, concurrent/idempotent retries, held provider locks, and rejection after canonical activation.
- An operational comparison initially compared PostgreSQL `Date` objects to persisted ISO strings. The transaction had already committed. The helper was corrected to normalize serialization, and the already-captured database readback passed the complete before/after comparison. **The production command was not repeated or reversed.**

## Operational evidence

Local artifacts under `C:/Users/owner/Echelon/.codex-artifacts/`:

- `atp-provider-reference-diagnostics-2026-09-29T23-20-53-763Z.json`
- `atp-nonlive-exclusion-review-2026-09-29T23-20-57-130Z.json`
- `atp-nonlive-exclusion-receipt-2026-09-29T23-22-01-142Z.json`
- `atp-nonlive-exclusion-readback-2026-09-29T23-22-01-283Z.json`
- Exact bounded operator: `atp-exclude-nonlive-20260929.mts`

Review hash: `6106ad964fc3353f62202549a55dd8e2e0198327875a1dd41c19b1a1d4fe9dd2`.
Actor: `codex-owner-approved-four-link-exclusion-20260929`.
Command key: `owner-four-nonlive-channel-links-20260929`.

## Consequences and remaining work

The exclusions persist after cutover. Products, inventory and other destinations remain available; only these exact outbound SKU/destination pairs are excluded. Once the correct listing exists and its exact mapping is reviewed, explicitly re-enroll it using the canonical membership workflow. Creating/publishing a listing is not the ATP quantity writer's job.

This removes these four pairs from future publication planning. It does not prove all other provider requests will succeed. Historical eBay errors for variants 7/64 remain unexplained; their latest GETs show published offers, not proof of a successful future quantity write.

The next cutover review must use target revisions **4**, not reuse a pre-exclusion selection manifest. No final cutover, additional inventory reconciliation, held-order change, Canada configuration change, PR creation, merge or deployment occurred in this exclusion operation.
