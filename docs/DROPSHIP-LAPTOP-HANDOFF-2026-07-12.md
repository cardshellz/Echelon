# Dropship Laptop Handoff - 2026-07-12

This is a current pickup checkpoint for continuing the dropship program on another machine. It does not replace the design or work-order documents below.

## Read in this order

1. `docs/DROPSHIP-DEV-HANDOFF-2026-07-09.md` - authoritative sequenced work order and recorded decisions.
2. `DROPSHIP-V2-CONSOLIDATED-DESIGN.md` - product and platform design of record.
3. `docs/DROPSHIP-DEEP-REVIEW-2026-07-05.md` - evidence and file-level traces behind the work order.
4. `docs/DROPSHIP-DOGFOOD-TEST-PLAN.md` and `docs/DROPSHIP-DOGFOOD-HANDOFF.md` - operator testing sequence and evidence requirements.
5. `docs/DROPSHIP-MARGIN-FIRST-CATALOG-DESIGN.md` - margin catalog implementation specification.

## Current checkpoint

- PR #903, `fix(dropship): make catalog variants the package-data authority`, is merged into `main` at merge commit `2120dc36`.
- Batch 0 items 0.1 through 0.5 are implemented in code. Each still carries the production-verification notes recorded in `docs/DROPSHIP-DEV-HANDOFF-2026-07-09.md`.
- Item 0.5 now makes `catalog.product_variants` the runtime source for package weight and dimensions across dropship cartonization, listing readiness, dogfood readiness, and eBay listing weight.
- `dropship.dropship_package_profiles` remains only for optional dropship packing/service overrides. Its physical columns are compatibility snapshots and are not runtime authority.
- The Dropship Shipping Config UI now exposes variant overrides and links package-data editing back to Catalog Variants.
- A fresh eBay listing preview now snapshots catalog weight into the listing intent. Old queued jobs without that field fail explicitly and must be recreated from a fresh preview.
- No migration was required for item 0.5.
- Batch 0 item 0.6 is implemented and deployed through PR #908: Stripe card/ACH plus auto-reload can satisfy wallet readiness without a USDC method.
- USDC remains a planned optional funding rail. Its funding-method, atomic-unit ledger, idempotency, audit, and admin-assisted credit foundations remain intact.
- Provider-backed USDC verification is explicitly not applicable to launch readiness until the provider/custody/settlement milestone is implemented.
- PR #908 is merged and deployed: release `v2365` runs merge commit `fe5c13f8`; config release `v2366` set `TRUST_PROXY=true`.
- `DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true` remains pinned. The production login screen loads after the restart; an authenticated login remains a manual check.
- Batch 0 item 0.8 is implemented in PR #909 plus its rollout-safety follow-up as standalone cartonizer v3.1: real 3D unit placement, all six rotations, geometry/weight-driven carton splitting, persisted WMS placements, and an automatic 22,679 g (under 50 lb) packed-carton ceiling. Dropship, checkout, and WMS test paths use the same module. It is not a required WMS path: explicit generation and opt-in shadow observation are available for validation, default off, and cannot block or change order status.
- Maximum units/package is no longer a cartonization input or UI setting. Box maximum weight is an optional lower structural limit; a NULL value uses the automatic handling ceiling.
- Production profile `COGS-TEST-001-P1` still contains legacy `max_units_per_package=4` and active box `8X6X4` has no lower maximum weight. Neither blocks quote testing after PR #909; canonical SKU dimensions, box inner dimensions, tare, and the generated quote do.

## Verification already completed for PR #903

- GitHub CI: passed.
- TypeScript: `npm run check` passed.
- Unit suite: 330 files and 3,135 tests passed; 14 skipped and 8 todo.
- Focused dropship package/listing/config suite: 9 files and 116 tests passed.
- Production build: `npm run build` passed.
- Full `npm test` reached 3,768 passing tests. Three unrelated integration suites could not start without `ECHELON_TEST_DATABASE_URL`; one unchanged line-fulfillment classifier expectation also failed.

## Required live checks before calling item 0.5 complete

1. Confirm the deployed release contains merge commit `2120dc36` or a descendant.
2. In Catalog Variants, verify the dogfood SKU has positive weight, length, width, and height.
3. Confirm Dropship listing readiness reports catalog package data as complete without requiring a profile row.
4. Confirm an eBay listing preview and push send a positive package weight.
5. Run the `SHIPCFG-04` and `SHIPCFG-08` quote checks from the dogfood test plan and record the evidence.
6. Inspect the authenticated Shipping Config > Variant overrides UI after deployment.

## Verification completed for item 0.6

- Focused provisioning and readiness suite: 3 files and 58 tests passed.
- TypeScript: `npm run check` passed.
- No migration or production data change is required.

After deployment, verify an eligible vendor with a Stripe card/ACH method and usable auto-reload reaches wallet-ready status without a USDC method. Confirm portal onboarding, Settings, admin dogfood readiness, and system prerequisites all agree; the system prerequisite should show USDC as `not applicable`, not blocked or ready.

Do not treat the July 9 production row counts, the `marzcards` listing mode, or channel 103 assignments as current without re-reading production config/data.

## Next implementation work

After PR #909 is merged and deployed:

1. Sign in to the production portal once to close the manual item 0.7 session check.
2. In Catalog Variants, verify the dogfood SKU has positive weight plus length, width, and height; verify `8X6X4` has accurate inner dimensions and tare.
3. Resume the dogfood plan at Phase 3/4. Verify readiness, narrow catalog exposure, and then use `SHIPCFG-04`/`SHIPCFG-08` to prove carton count and shipping price.
4. Do not begin a listing push while any hard-stop row remains open.

## Working agreement

- Fetch and inspect current `origin/main` before making claims; multiple agents may have advanced it.
- Do not add commits to merged PR branches.
- Keep one independently reviewable concern per PR, but make each concern complete across domain, application, infrastructure, HTTP/UI, tests, and docs.
- Do not infer production state from this file. Re-query it.
- Preserve exact money, idempotency, transaction, audit, and concurrency requirements in `AGENTS.md`.
- Never use production `DATABASE_URL` as the integration-test database.

## Laptop bootstrap

```powershell
git clone https://github.com/cardshellz/Echelon.git
cd Echelon
git switch main
git pull origin main
git log -1 --oneline
```

If the repository already exists:

```powershell
git fetch origin
git switch main
git pull --ff-only origin main
```

## Pickup prompt for Codex

> Continue the Echelon dropship program. First read `docs/DROPSHIP-LAPTOP-HANDOFF-2026-07-12.md`, then the authoritative documents it lists. Fetch `origin/main` and verify the item 0.8 change is present. Do not assume the recorded production state is current. Report the exact current branch/commit and deployment state, complete the authenticated login and box-capacity checks, then resume the dogfood plan at Phase 3/4. Do not reuse a merged PR branch.
