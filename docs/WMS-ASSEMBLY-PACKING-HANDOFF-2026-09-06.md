# Assembly to packing readiness

## Scope and status

This is a **packing-readiness handoff**, not package close. It fixes the gap where an assembled, fully picked order can remain `in_progress` and therefore be absent from Packing. It deliberately does not mark a parcel packed, validate/apply its label, or record carrier possession.

PR #1385 is confirmed merged at `5978befeeb82a5947115aad12f6dfa3ddb49a169`; deployment was reported by the user. Work is isolated on `codex/wms-assembly-packing-handoff`. Main's separate dropship PR #1386 was subsequently merged into this branch. Its migration used 0657, so this slice uses **0658_assembly_packing_handoff_receipts.sql**. No production data/configuration was changed, and no PR or deployment was created in this continuation.

## Confirmed trace

| Evidence | What it proves | Limitation |
| --- | --- | --- |
| `server/modules/shipping-engine/application/packing.service.ts:34`, `PACKING_ELIGIBLE_WAREHOUSE_STATUSES`; `:134`, `getPackingQueue` | Packing selects ready-to-ship/picked/packing headers and unheld orders. Completed item picks alone do not qualify an in-progress header. | Existing packing is a box/weight confirmation experience, not an audited label-to-parcel close workflow. |
| `client/src/pages/warehouse-work/AssemblyPackingHandoff.tsx:9`, `AssemblyPackingHandoff` | After output pick, the assigned assembler can explicitly continue the combined-station job to Packing. It reuses the existing retry-safe command hook and opens the returned order deep link. | This still opens the Packing page; the final single-view assembly/label/package-close experience is not implemented. No new login or station assignment is required. |
| `server/modules/warehouse/work/application/assembly-packing.service.ts:16`, `AssemblyPackingService.ready` | Uses session identity, job version/ownership, current assembly and packing permissions/scope, immutable job routing, claim status, whole-order readiness, one transaction, and a hashed idempotency receipt. | Supports the routed combined assembly/packing area only. Separate-station physical custody remains unsupported and explicitly rejected. |
| `server/modules/inventory-planning/application/assembly-packing-claim-reader.ts:6`, `lockAssemblyPackingPickEvidence` | The assembly line must also have exact fully picked canonical claim quantities, with no release, consumption, or shortfall. A WMS completed flag alone is insufficient. | Other eligible order lines retain the existing WMS full-pick checks; this is not a new shipment-wide allocation model. |
| `server/modules/wms/assembly-packing-readiness.ts:18`, `lockPackingReadiness`; `:30`, `packingReadinessBlockers` | Locks order/items and allocation blockers. Requires the order's warehouse to equal the assembly warehouse; all eligible physical lines must be completely picked with a real recorded bin. Held/cancelled/nonphysical lines are excluded, but the selected assembly line must remain eligible. Terminal, partially-shipped, exception, and unknown warehouse states reject. | This is the existing single-warehouse/order readiness model, not multi-warehouse shipment-level package close. |
| `server/modules/inventory/application/packing-replenishment-reader.ts:5`, `lockPackingReplenishmentBlockers` | Reads/locks existing shipment blockers through their inventory owner. No replenishment decision, release, cancellation, or inventory posting is performed. | Existing blocker writers must retain their own transaction discipline; this is not a replenishment redesign. |
| `server/modules/wms/assembly-packing-readiness.ts:45`, `recordAssemblyPackingReady` | Calls the existing `transitionOrderStatus` owner on the same PostgreSQL client. Time is injected. No new header writer, item quantity mutation, stock writer, or shipment writer is added. | Entering ready-to-ship makes the order eligible for existing downstream consumers; their behavior is unchanged. |
| `server/modules/warehouse/work/infrastructure/assembly-packing.repository.ts`, `replay` / `insert`; migration 0658 | One immutable receipt per command UUID; request hash binds actor/job/input. Receipt and readiness commit together. Mutation trigger forbids receipt update/delete. A failed receipt insert rolls back the header change. | Replays return historical receipts, not assertions about current order eligibility. Packing rechecks current eligibility before displaying the order. |
| `server/modules/shipping-engine/application/packing.service.ts:134`, `getPackingQueue(orderId)`; `client/src/lib/packing-order-selection.ts`, `packingOrderSelection` | A validated exact-order filter prevents the handoff target from disappearing behind the existing 200-order queue limit. Existing status/hold filters still apply. | This does not replace existing packing authorization or broaden the visible status set. |

## Example

Order 70 needs two P5. Its assembly job has produced two P5 and its canonical finished-output pick is recorded. The assembler clicks **Continue to packing**.

The server checks that this employee owns the completed job and has both assembly and packing authority at its combined area. It locks and verifies the whole eligible order, its matching warehouse, allocation exceptions and replenishment blockers. If another physical line is incomplete, the action explains the blocker and records no handoff. It does not cancel replenishment or alter picked quantities to force readiness.

If checks pass, the existing status owner advances the header to `ready_to_ship` and an immutable receipt is committed. Packing opens directly on order 70. The preprinted ShipStation label remains in use; this command does not buy another label or report dispatch. A held or shipped order that changes before the Packing read is not displayed as eligible; the page explains the changed state.

## Locking, retries, and failure modes

The assembly claim-line evidence is locked immediately after its parent claim, before replenishment and station/work locks.

Order and item locks precede claim, replenishment blocker, warehouse/identity/location, and work-item locks. No graph, inventory resource, build, pick, or release operation is called afterward. Order/item foreign-key and row locks protect the readiness read from concurrent changes; existing blocker rows are locked too. Unique command IDs fence concurrent duplicate receipts, and the status change plus receipt share the transaction.

Current permission and scope are checked even for a receipt replay. An exact replay does not update the header or insert another receipt. Reusing a command ID with another actor/job/body rejects. Stale job versions, wrong workers, inactive claims, incomplete picks, holds, warehouse mismatches, separate-station profiles and unresolved shipment blockers reject without recording readiness. Missing migration/table or database contention fails visibly through the existing structured HTTP error handler. No fallback creates a false packed/shipped result.

The new warehouse-owned receipt table is the sole new writer-baseline entry. The status owner's optional clock preserves legacy callers' behavior while allowing deterministic tests for this path.

## Assumptions, risks, and remaining work

- Assumes a completed active canonical job at a combined assembly/packing area, exact full-line output pick, and a known matching order warehouse. Actual production role grants, warehouse data, station routes and event behavior were not queried.
- No auto-activation, role grants, stock/reservation changes, recipe edits, ATP changes, channel settings, or provider configuration were performed.
- Existing `confirmParcel` still records actual box/weight and can overwrite earlier actuals. It is **not** proof of label validity, complete authorized parcel contents, or carrier possession. This slice does not harden that older endpoint or require every legacy packer to use this new receipt.
- Next: a canonical shipment/parcel contents contract plus current preprinted-label binding and audited package-close receipt, with void/reprint, missing-label, cancellation, partial/multi-parcel/multi-warehouse and concurrent-worker handling. That work should continue in the same bench view, without inventing a self-handoff.
- Do not label this slice “packing completion” or “outbound workflow complete.” The original full vertical also still includes separate custody, mixed/partial builds, recovery/reassignment, and batch-gun integration.

## Verification

Final local validation against integrated main `4f282048`: **871 unit-test files passed; 8,348 tests passed, 14 skipped**. Final `tsc --incremental false`, production build, writer-ratchet, migration-prefix guard and whitespace checks passed. The build retains the existing large-chunk warning. The final focused run passed 58 tests; all 15 PostgreSQL assembly tests were explicitly skipped locally. New unrelated main commits arrived afterward and must be refreshed/validated before publishing a PR.

- Unit coverage: readiness rules, forbidden states, worker/scope/version/claim failures, deterministic status-owner invocation, transaction rollback on receipt failure, idempotent replay, HTTP actor-injection rejection, UI action eligibility, and deep-link validation. Full-suite and final typecheck/build results are recorded in the task handoff.
- PostgreSQL tests extend the existing CI-included `assembly-work.integration.test.ts`: concurrent same-command requests, immutable receipt, changed-request rejection, real header rollback on receipt failure, and replenishment blockers staying unresolved. Fixtures represent already-picked output; they do not simulate stock/COGS math.
- PostgreSQL suite remains locally skipped without an explicitly disposable database (no Docker/psql available). CI database proof and a physical gun/bench acceptance run are required before treating the new path as production-verified.
- Existing user-owned catalog edits in the original checkout were preserved. All implementation work occurred in the separate worktree.
