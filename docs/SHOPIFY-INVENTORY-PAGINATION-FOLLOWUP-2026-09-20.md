# Shopify inventory pagination follow-up

Date: September 20, 2026. Base: `origin/main` at `b49c74bbbacfcb4331a53107605b0a69f2a5e09a` (merged PR #1503). Branch: `codex/shopify-pagination-readback-20260920`.

## Summary of changes

This is a narrow correction to `ShopifyIdentityReader.inventoryLevels`, not an ATP change, migration or activation. Shopify can serve a newer API version while retaining the requested version in its next-page link. The previous reader rejected that live response shape before reading page 2.

The reader now captures the version of each outgoing request ([line 87](../server/modules/channels/adapters/shopify-identity.reader.ts#L87)) and accepts a next-link resource path using either that request version or the trusted response version ([line 116](../server/modules/channels/adapters/shopify-identity.reader.ts#L116)). Only the cursor is carried forward. The next request is constructed locally using the pinned served version; the provider URL and its other query parameters are not followed. The connection's saved API version is not edited.

## Confirmed live behavior

At `2026-09-20T13:57:04Z–13:57:06Z`, the **local patched reader** made two GET requests against Shopify US connection 4, location `67892347039`:

| Page | Requested API | Served API header | Next-link API | Result |
| --- | --- | --- | --- | --- |
| 1 | `2024-01` | `2025-10` | `2024-01` | Accepted cursor; did not follow the URL |
| 2 | `2025-10` | `2025-10` | None | Completed scan |

Result: **429 inventory items**, including **10 untracked/null quantities**, and valid numeric quantities for **all 197 approved mapped items**. Unknown quantities stayed unknown, not zero. Read-only before/after database captures confirmed unchanged activation controls and target states: runtime remained legacy and the new target remained disabled.

The local evidence file is `test-results/shopify-pagination-live-2026-09-20T13-57-06-508Z.json` (ignored diagnostic output, no credentials). SHA-256: `d5a2aeafcae885e755272d60e7140790a2b9cceec8b50a6380524c2813517d80`.

This proves the patched reader can consume the observed provider response. It is **not deployed-application acceptance**, a physical stock count, a quantity write test or an inventory cutover approval.

## Test coverage

- Added the live requested-version-Link case, served-version-Link compatibility, three-page version pinning and unchanged input configuration: [`channel-identity.test.ts:64`](../server/modules/channels/__tests__/unit/channel-identity.test.ts#L64).
- Tested rejection of unrelated versions, wrong resources/hosts, HTTP, nonstandard ports, embedded credentials, fragments, missing/duplicate/empty cursors, repeated cursors and a later changed served version. No partial quantities are returned on these errors.
- Exercised the actual reader through `ChannelIdentityService.externalInventory` with two mocked provider pages. Mapped stock on page 2 is returned, unmapped untracked stock is separated, and DB writes/transactions are not called: [`channel-identity.service.test.ts:112`](../server/modules/channels/__tests__/unit/channel-identity.service.test.ts#L112).
- Before the implementation, the new tests reproduced six failures. Afterward, **46/46 focused tests passed**.
- Full Channels unit suite: **874 tests across 55 files passed**.
- `npm run check:tests`: passed for both server and client.
- `npm run check` and `npm run check -- --incremental false`: passed. An initial cached run reported `TS2589` in untouched `historical-order-line-identity-repair.repository.ts:34`; neither the unchanged base, fresh non-incremental patched check, nor subsequent standard patched check reproduced it. The cause of that initial diagnostic is not established, and no OMS code was changed or error suppressed.
- All 112 installed direct dependencies matched this branch's lockfile. The initial sandbox test-runner directory restriction was resolved by an approved rerun; it was not an application test failure.

## Assumptions, risks and failure modes

- The code change is grounded in the observed header/Link combination, not an assumed API upgrade. It accepts only the request/response versions for that page, not arbitrary or indefinitely retained old versions.
- Existing same-store HTTPS, exact resource, version-stability, cursor uniqueness, identity/quantity validation and bounded page-count protections remain. Failed/incomplete scans still throw instead of returning partial stock.
- External quantities can change during a multi-page read. This patch does not claim an atomic provider snapshot or establish physical inventory accuracy.
- No new database behavior or schema was introduced. The service test uses a mocked database; no disposable PostgreSQL write integration test was required for this read-parser change.
- No inventory, recipes, reservations, ATP policies, channel settings, Shopify quantities, token refreshes or production activation were changed. The clean-worktree workflow kept the patch separate from the existing catalog edits.

## Next checks

Review and deploy this isolated patch through the normal PR process, then repeat the full-location read using the deployed implementation. Inventory cutover remains a separate reviewed action requiring verified opening and accepted-order reconstruction evidence; these provider read tests do not replace that evidence.
