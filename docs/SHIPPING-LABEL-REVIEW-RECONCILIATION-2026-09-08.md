# Label fulfillment review reconciliation

## Scope

Follow-up to deployed PR 1412. Fix the proven package/source quantity mismatch
without relaxing exact identity checks or sending more items than the label owns.
No production retry, review resolution, provider mutation, inventory mutation,
migration, writer-baseline change, new page, or Dropship work is included.

## Production evidence: Shopify

The read-only investigation compared the saved push item, its physical item and
allocation source, and the current WMS shipment/order/OMS line. All IDs matched;
only the package quantity and full source quantity differed.

| Order | Command | Legacy item | Allocated quantity | Frozen/current source quantity | Allocation |
|---|---|---|---|---|---|
| #62807 | 3024 | 21996 | 1 | 2 / 2 | Plan 213, entry 518, intent 1448 |
| #62814 | 3025 | 22014 | 1 | 2 / 2 | Plan 214, entry 520, intent 1452 |

In each persisted plan, a separate one-unit entry remains `awaiting_relabel`.
The first order's SKU is SHLZ-SEMI-OVR-C2000; the second is
ESS-TOP-STD-SLV-CLR-C1000. The legacy items were completed, not cancelled.

`assertExactChannelCommandLineage` in `fulfillment-push.service.ts` compared each
saved one-unit command against the two-unit legacy source row. It therefore
raised `channel_fulfillment_lineage_mismatch` before sending the package.
Simply allowing a smaller quantity would not suffice: downstream Shopify
request planning also consumed the full source quantity, including a separate
stored-fulfillment-order fast path that reread the legacy row.

The connected PostgreSQL regression then reproduced a second split defect:
package one's successful writeback saves a fulfillment ID on the shared legacy
shipment row. Package two incorrectly treated that sibling ID as its own known
provider identity and failed with `shopify_push_package_state_conflict`.
Canonical expected fulfillment IDs must be scoped to the same physical package
and OMS order; the legacy header remains a compatibility projection, not authority
for a different package. The strict provider package comparison stays unchanged.

## Correction contract

- Carry the immutable allocation entry and effect-intent IDs from the claimed
  command into the provider boundary. They are not an unverified metadata flag.
- Prove the exact saved command/push item/physical item/entry/source/effect and
  commercial activation relationships before accepting a partial package.
- Require current source quantity to equal its frozen original quantity; keep
  original shipment, item, OMS line, channel line, provider and order checks.
- Build both Shopify fulfillment paths from the same validated package quantity.
- Use only same-package canonical fulfillment records as known provider IDs;
  do not import a sibling package's legacy-header ID into the comparison.
- Preserve exact full-source equality for legacy commands without allocation
  authority. Missing or conflicting evidence stays in existing review.
- The eBay canonical provider boundary shares the allocation-quantity validation;
  this does not change eBay's external fulfillment idempotency matching rules.

## eBay cases remain separately unproven

Commands 3018 / order 08-15140-13597 and 3019 / order 14-15129-29548 do not have
the Shopify quantity discrepancy. Their saved and current source tuples agree:

- 08-15140-13597: line 10083776958108, EG-SLV-PF-P100, quantity 3.
- 14-15129-29548: line 10084705501414, SHLZ-SEMI-OVR-C2000, quantity 1.

Both stopped with `ebay_fulfillment_idempotency_conflict`: eBay returned matching
fulfillment/tracking identity that did not satisfy the exact package comparison.
Which provider field differs has not been established.

The existing recent Heroku log window contained no matching diagnostic log;
there were no matching persisted inbound fulfillment receipts. Saved order
snapshots contained the expected order lines but no fulfillment references.
Those old order snapshots do not prove present-day package contents or status.

Direct credential-backed eBay reads were blocked by the permission check.
Explicit approval was requested to read only these two orders using the existing
connection, without fulfillment creation or token refresh. No such provider
request or credential read was performed in this investigation.

## Verification and operational follow-up

Final local verification:

- Full non-integration sweep: **11,969 passed, zero failed, 23 skipped**, across
  1,109 test files. Machine-readable report:
  `C:/Users/owner/Echelon/.codex-audits/shipping-label-review-final-unit-20260908.json`.
- Connected shipping-ledger PostgreSQL suite: **35/35 passed** using only the
  explicitly disposable `127.0.0.1:55439/echelon_warehouse_source_test` database;
  production database URLs were cleared from the test process.
- Provider and authority focused suites: **68/68 passed**.
- Typecheck, production build, ownership/migration guards (four tests), and
  diff whitespace check: **passed**.
- Independent review found and closed omitted/mixed allocation-provenance test
  gaps; it found no remaining scoped code blocker.

The PostgreSQL regression covers both stored and live Shopify line mapping,
two one-unit packages from a two-unit source, exclusion of an unrelated same-SKU
line, real attempt persistence, and replay with no additional provider mutation.
Provider transport is mocked; owner/database reads and writes are real. It is
sequential coverage, not a new concurrent provider-lock proof. Existing production
locking is unchanged. Existing build chunk-size, PostgreSQL concurrent-query, and
unrelated test-mock-hoisting warnings remain visible. No remote CI run or deployment
has been performed for this new branch.

No new business-policy assumptions were introduced: only persisted package
authority can permit a quantity different from its unchanged original source.
Local tests are not proof that terminal production reviews have been corrected. After deployment,
the two Shopify commands still require an explicitly authorized scoped requeue
through the existing owner API, with provider readback and exact quantity checks.
No direct SQL status update or automatic bulk retry is authorized by this change.

The eBay conflicts must not be blindly retried or considered resolved by this
Shopify correction. Inspect the exact provider records after read approval.
