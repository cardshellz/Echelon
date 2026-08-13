# Return Policy Scope Test Plan

Last updated: 2026-08-13

Purpose: validate the simplified return-policy scope model introduced by PR #1212, including policy creation, target selection, precedence, versioning, auditability, and failure behavior.

Admin surface: `/return-policies`

## Run Record

| Field | Value |
| --- | --- |
| Test date |  |
| Tester |  |
| Environment |  |
| Deployed commit / release |  |
| Test sales channel |  |
| Test dropship vendor |  |
| Test dropship store |  |
| All-orders policy ID |  |
| Channel policy ID |  |
| Vendor policy ID |  |
| Store policy ID |  |
| Final result | Not started |

## Severity Guide

| Severity | Meaning |
| --- | --- |
| P0 | Security, data corruption, cross-vendor leakage, or incorrect policy resolution affecting live returns. Stop testing. |
| P1 | A scope cannot be created, an incorrect policy wins, or a required validation can be bypassed. Stop launch. |
| P2 | Incorrect status, copy, search behavior, or recoverable workflow defect. |
| P3 | Cosmetic or low-impact usability issue. |

## Safety Rules

- Use an isolated test environment when exercising fail-closed configuration tests.
- In production, create only harmless, inactive, or future-effective test versions and deactivate them after verification.
- Record policy IDs and screenshots before changing policy state.
- Do not retry a failed create request blindly. Capture the response and confirm whether a version was created first.
- Do not remove or modify the canonical Dropship OMS channel in production.
- Stop immediately if a vendor search exposes another vendor's private store data.

## Phase 0: Baseline

Goal: prove the deployed UI and prerequisites match the intended public model before creating policies.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | BASE-01 | Open `/return-policies` without console or API errors. |  |  |
| [ ] | BASE-02 | Open `Create return policy`. Confirm `Applies to` contains exactly: `All orders`, `One sales channel`, `One dropship vendor`, and `One dropship store`. |  |  |
| [ ] | BASE-03 | Confirm internal ranks, account IDs, and legacy scope names are not exposed in the create form. |  |  |
| [ ] | BASE-04 | Confirm existing legacy policies remain visible with a `Legacy scope` badge. |  |  |
| [ ] | BASE-05 | Confirm a legacy policy cannot create a new version and explains that it must be replaced with a simplified policy. |  |  |
| [ ] | BASE-06 | Confirm exactly one active canonical `Dropship OMS` channel exists with the expected internal/manual identity. | Channel ID: |  |
| [ ] | BASE-07 | Identify a test vendor and one store that belongs to it. | Vendor/store: |  |

## Phase 1: All Orders

Goal: prove the global fallback is simple, valid, and target-free.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | ALL-01 | Select `All orders`. Confirm no channel, vendor, or store picker is shown. |  |  |
| [ ] | ALL-02 | Leave the policy name blank. Confirm creation is disabled. |  |  |
| [ ] | ALL-03 | Enter an invalid return window below 0 or above 3650. Confirm the policy cannot be created. | Value/result: |  |
| [ ] | ALL-04 | Create a uniquely named all-orders test policy with known decisions. | Policy ID: |  |
| [ ] | ALL-05 | Confirm the policy list identifies the scope as `All orders` without a target. | Screenshot: |  |
| [ ] | ALL-06 | Resolve a return that has no more-specific policy. Confirm this policy supplies the effective decisions. | Order/resolution: |  |

## Phase 2: One Sales Channel

Goal: prove a channel policy targets one active channel and overrides only the global fallback.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | CHAN-01 | Select `One sales channel`. Confirm the sales-channel picker appears and vendor/store pickers do not. |  |  |
| [ ] | CHAN-02 | Confirm the picker lists active channels by readable name, not only numeric ID. |  |  |
| [ ] | CHAN-03 | Do not select a channel. Confirm creation is disabled. |  |  |
| [ ] | CHAN-04 | Select the test channel and create a policy with a decision that differs from the all-orders policy. | Policy ID: |  |
| [ ] | CHAN-05 | Confirm the policy list shows `One sales channel` and the selected channel name. | Screenshot: |  |
| [ ] | CHAN-06 | Resolve an order on the selected channel. Confirm the channel policy wins over `All orders`. | Order/resolution: |  |
| [ ] | CHAN-07 | Resolve an order on a different channel. Confirm it does not use this channel policy. | Order/resolution: |  |

## Phase 3: One Dropship Vendor

Goal: prove a vendor policy uses searchable vendor identity and applies across that vendor's dropship stores.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | VEND-01 | Select `One dropship vendor`. Confirm a vendor search appears and no store picker appears. |  |  |
| [ ] | VEND-02 | Search by business name, email, and member ID. Confirm each supported identifier finds the expected vendor. | Search terms/result: |  |
| [ ] | VEND-03 | Search for a nonexistent vendor. Confirm the empty state is clear and creation remains disabled. |  |  |
| [ ] | VEND-04 | Select the test vendor and create a policy with a decision that differs from the channel policy. | Policy ID: |  |
| [ ] | VEND-05 | Confirm the policy list shows `One dropship vendor` and a readable vendor identity. | Screenshot: |  |
| [ ] | VEND-06 | Resolve a dropship return for this vendor. Confirm the vendor policy wins over channel and all-orders policies. | Return/resolution: |  |
| [ ] | VEND-07 | Resolve a dropship return for another vendor. Confirm this vendor policy does not apply. | Return/resolution: |  |

## Phase 4: One Dropship Store

Goal: prove store targeting is constrained by vendor ownership and is the most-specific public scope.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | STORE-01 | Select `One dropship store`. Confirm the vendor search appears first and the store search is unavailable until a vendor is selected. |  |  |
| [ ] | STORE-02 | Select the test vendor. Confirm only stores owned by that vendor are returned. | Vendor/store results: |  |
| [ ] | STORE-03 | Search stores by display name, domain, and platform. Confirm supported identifiers find the expected store. | Search terms/result: |  |
| [ ] | STORE-04 | Change or clear the selected vendor. Confirm the previously selected store is cleared. |  |  |
| [ ] | STORE-05 | Select the vendor and store, then create a policy with a decision that differs from the vendor policy. | Policy ID: |  |
| [ ] | STORE-06 | Confirm the policy list shows `One dropship store` with readable vendor and store identities. | Screenshot: |  |
| [ ] | STORE-07 | Resolve a return for this store. Confirm the store policy wins over vendor, channel, and all-orders policies. | Return/resolution: |  |
| [ ] | STORE-08 | Resolve a return for another store owned by the same vendor. Confirm it falls back to the vendor policy. | Return/resolution: |  |

## Phase 5: Precedence Matrix

Goal: prove the resolver consistently applies the most-specific matching policy.

| Done | ID | Return context | Expected winner | Actual winner / evidence | Exception / correction needed |
| --- | --- | --- | --- | --- | --- |
| [ ] | PREC-01 | No matching target | All orders |  |  |
| [ ] | PREC-02 | Matching sales channel only | One sales channel |  |  |
| [ ] | PREC-03 | Matching dropship vendor | One dropship vendor |  |  |
| [ ] | PREC-04 | Matching dropship store | One dropship store |  |  |
| [ ] | PREC-05 | Same vendor, different store | One dropship vendor |  |  |
| [ ] | PREC-06 | Different vendor on same internal dropship channel | One sales channel or all orders, according to configured matches |  |  |

Expected precedence:

`All orders < One sales channel < One dropship vendor < One dropship store`

## Phase 6: Versioning and Audit

Goal: prove policies remain immutable, retry-safe, and attributable.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | AUDIT-01 | Create a new version of a simplified policy. Confirm the original effective version is not mutated in place. | Old/new IDs: |  |
| [ ] | AUDIT-02 | Confirm the new version retains the intended public scope and target. |  |  |
| [ ] | AUDIT-03 | Confirm the audit record identifies the authenticated actor, action, timestamp, and policy/version IDs. | Audit ID: |  |
| [ ] | AUDIT-04 | Repeat an identical create request with the same idempotency key in an API/integration test. Confirm only one version exists. | Test/log: |  |
| [ ] | AUDIT-05 | Reuse the same idempotency key with different input in an API/integration test. Confirm the request is rejected as a conflict. | Test/log: |  |

## Phase 7: Fail-Closed and Isolation Tests

Run these in an isolated environment only.

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | SAFE-01 | Submit a store policy whose store belongs to another vendor. Confirm the server rejects it. | Response/test: |  |
| [ ] | SAFE-02 | Submit internal scope fields through the public API. Confirm the boundary rejects them. | Response/test: |  |
| [ ] | SAFE-03 | Remove the canonical Dropship OMS channel in an isolated environment. Confirm vendor/store policy creation fails with a classified configuration error. | Response/test: |  |
| [ ] | SAFE-04 | Configure duplicate canonical Dropship OMS channels in an isolated environment. Confirm vendor/store policy creation fails as ambiguous. | Response/test: |  |
| [ ] | SAFE-05 | Force a repository/database failure. Confirm no partial policy version is committed and the error is logged with actionable context. | Test/log: |  |
| [ ] | SAFE-06 | Attempt cross-vendor store search through the API. Confirm results remain constrained to the selected vendor. | Test/log: |  |

## Phase 8: Cleanup and Exit

| Done | ID | Check | Evidence / ID | Exception / correction needed |
| --- | --- | --- | --- | --- |
| [ ] | EXIT-01 | Deactivate or replace every temporary test policy created during this run. | Policy IDs: |  |
| [ ] | EXIT-02 | Re-run the precedence matrix against the intended production policy set. | Evidence: |  |
| [ ] | EXIT-03 | Confirm no unresolved P0 or P1 defects remain. | Defect links: |  |
| [ ] | EXIT-04 | Confirm automated return-policy unit and route suites pass. | CI run: |  |
| [ ] | EXIT-05 | Confirm the production build passes. | CI run: |  |
| [ ] | EXIT-06 | Record the final result and any accepted P2/P3 exceptions. | Result: |  |

## Exception Log

| ID | Severity | Test ID | Description | Owner | Resolution / follow-up |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

## Launch Acceptance

The simplified scope model is acceptable only when:

- all four public scopes can be created with the correct target requirements;
- vendor and store searches do not leak data across vendor ownership;
- the most-specific matching policy wins deterministically;
- legacy policies remain readable but cannot be extended through the new model;
- retries cannot create duplicate versions;
- policy writes are atomic and audited; and
- no P0 or P1 defects remain open.
