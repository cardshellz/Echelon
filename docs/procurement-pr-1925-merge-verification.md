# PR 1925: current-main reconciliation and CI recovery

Final PR #1925 workflow/release observations and the follow-up performance measurements are recorded in [the cost-read closeout](procurement-cost-read-performance-closeout.md). The evidence below retains its original source and timing attribution.

## Changes and authority

Merge main `b8379059706a8bc0bd976bf8a1864364e80a3354` into the procurement verification branch. The only textual conflicts were `client/src/pages/Receiving.tsx` and `test/browser/procurement-receiving-units.spec.ts`.

`Receiving: adjustmentBlocked` and `assertReceiptAdjustmentAllowed` retain the existing inventory adjustment grant for counts, locations, pack changes and receipt state. The resolution retains main's compact workspace, sticky command bar and progressive disclosure. Its new Start, location and SKU controls receive the same guards. `skuResolutionBlocked` preserves catalog-only metadata creation without granting receipt adjustments. The catalog creation fixture retains its explicit inventory creation permission. No procurement server/shared financial owner changed from the previously published commit.

`procurement-cost-reporting.spec.ts: setup` supplies purchasing:view, which `App: ProtectedRoute` requires for PO detail; retry authority remains a separate purchasing:approve grant. `procurement-purchase-order-entry-recovery.spec.ts` now verifies editor denial after permission revocation and recovers through the read-authorized PO detail. Its original command equality, disabled recovery and restoration assertions remain.

Connected `fixtures: backend` closes its owned browser context before requesting server shutdown. Strict child-exit, output-close, database ownership and fallback-cleanup failure checks remain. `server: stop` records HTTP/database shutdown stages. The earlier hosted editor failure occurred during teardown; its artifact did not identify the exact stalled stage. Both editor viewport cases now complete with clean shutdown, but the old hang's precise internal cause remains unproven. Connected draft and SKU tests exercise main's More actions disclosure and Link SKU label.

## Local validation

- Eight affected browser specs: 259 passed, one new mobile test left More actions open and tried to click behind its popup. Close the menu normally; the complete workspace rerun passed 16/16. The identity union covers all 260 desktop/mobile cases successfully.
- Full connected suite: 42 passed, four cases used the old SKU button label. Update those two selectors; their complete desktop/mobile rerun passed 4/4. The identity union covers all 46 real login/HTTP/database cases successfully. No retries, skips, forced-cleanup acceptance or missing test identities were used.
- 424 official guard tests, five typechecks, build and migration policy passed. Connected and browser typechecks were repeated after the final test-only changes.
- Every run recorded stable source inputs. The built frontend stayed unchanged during all connected runs. Only two test files changed between the broad passes and focused reruns. Build, application/server/client types and guards retain their earlier source attribution.

Frozen pending merge at published HEAD `bba44c7b70982ba78ca3b172719b5521e3175d1d`: initial patch SHA256 `943d126ce3be400cdc20e680bc92d203b6654ebb2df0a1318d0795c54671b112`; final code/test patch SHA256 `65289f5196bb92cc62b48d0dbbf4946f65ff1921b1678556cb97367199013aeb`. This report is the only documentation added after that final patch was validated. Local raw reports and the case-identity collector are retained with the PR conflict-verification outputs.

## Limits and excluded work

No business-policy assumptions, new SQL migration, historical repair or live-record access is included. The tests use the verified local disposable database; they do not establish production role assignments, Linux/Node 20 acceptance or deployed behavior. The broader AP snapshot and cost-health evidence remains in the earlier closeout reports; it was not rerun or relabeled as new evidence. Posted-PO query fanout and extreme health child-row capacity remain separate scale investigations. Hosted checks must validate this new PR head.
