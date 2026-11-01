# PR #1971 deployment verification

Verified on 2026-11-01 using read-only GitHub and Heroku metadata. This receipt records deployment evidence, not production financial acceptance.

| Evidence | Observed result |
| --- | --- |
| PR | [#1971](https://github.com/cardshellz/Echelon/pull/1971), merged 2026-11-01T20:29:27Z |
| Final PR head | `be1d01944183eb573431825a8b3455cbd788bfc3`: all 75 checks succeeded |
| Merge / observed main | `e5d69368639528cdf9c73d60799184591f8d8e88`; fetched `origin/main` matches; merge ancestry check passed |
| Application | `cardshellz-echelon` |
| Release | v3437, status `succeeded`, description `Deploy e5d69368`, created 2026-11-01T20:30:39Z |
| Release ID | `9f8d31a5-94fb-41fd-840c-cd3c9242a512` |
| Deployed slug | `4130dfeb-9c06-429e-b9d8-6737cfa93bbc`; full commit equals the merge |
| Release migration | `900000046000019710001_purchase_tax_treatments.sql` reported successful; release phase complete; optional drizzle push skipped |
| Running processes | `web.1` and `inventory-capture.1` are `up`; both reference release ID/version above |
| Post-merge CI | All 27 checks succeeded; both workflows completed successfully |

The [post-merge CI workflow](https://github.com/cardshellz/Echelon/actions/runs/41347109668) and [post-merge returns workflow](https://github.com/cardshellz/Echelon/actions/runs/41347109640) are distinct from final PR-head checks. Both workflows completed successfully on the exact merge commit; no failed, skipped or pending check remains in that snapshot.

The final PR head adds only the integration of #1976 after the previously reviewed `28d523a7a472381971f55710cfba54652ab54cb1`. `git diff --stat` reports seven customer-account/returns files; scoped procurement/receiving/shared purchasing/migration comparison is empty. This supports retaining the existing tax implementation trace while separately checking the final head.

## Exact read paths

- GitHub PR metadata, commit check-runs and workflow runs for the final head and merge.
- `git fetch origin main`, `git merge-base --is-ancestor <merge> origin/main`, and the exact commit comparison above.
- `heroku releases:info --app cardshellz-echelon --json`.
- `heroku ps --app cardshellz-echelon --json`.
- `heroku releases:output v3437 --app cardshellz-echelon`, filtered to the named migration and release completion.
- Heroku Platform API `GET /apps/cardshellz-echelon/slugs/4130dfeb-9c06-429e-b9d8-6737cfa93bbc` for the full commit. The installed CLI lacks `slugs:info`; its unsupported-command output is not treated as evidence. Authentication stayed in process memory and was not recorded.

## What remains unproven

No authenticated live tax approval, production receipt posting, historical repair or record-level money/stock audit was performed. A successful migration/release and healthy processes do not establish those outcomes. This verification changed no live financial or inventory records and did not configure tax eligibility.

The next implementation remains the existing plan's explicit invoice-to-receipt allocation adapter: each receipt retains its approved invoice cost, and uncovered quantities retain provisional PO costs. Multi-invoice changes that require that adapter remain guarded. Whole Stage 2 completion is not claimed.
