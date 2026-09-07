# Assembly package evidence: connected read path

## Outcome

The assigned assembler can now inspect linked provider labels and their exact declared contents from the selected assembly job, after its finished-output pick. This is connected application code: authenticated GET, scoped task owner, read-only database transaction, existing shipping evidence owner, strict response validation, and bench UI.

**Package Close is not connected.** No completion receipt, stock allocation, label purchase, commercial fulfillment, carrier dispatch, or activation is performed here. The user subsequently requested a PR for this checkpoint. Publish it as scoped read-only package-evidence review, not as completed Package Close; the close transaction and correction behavior remain future work.

Worktree: `worktrees/wms-assembly-package-close`, branch `codex/wms-assembly-package-close`. Integrated main `66e64a92` includes the unrelated eBay token PR #1390. PR #1389's merge and user-reported deployment remain the assembly-readiness baseline. Unrelated original-checkout changes are preserved.

## Confirmed trace

| Code / function | Evidence and consequence |
| --- | --- |
| `server/modules/warehouse/work/interfaces/assembly-work.routes.ts:61`, `registerAssemblyWorkRoutes` | GET `/:id/packages` authenticates, validates the bigint job ID, injects the session actor, and validates output. Caller query parameters cannot supply actor or warehouse authority. |
| `server/modules/warehouse/work/application/assembly-package-review.service.ts:11`, `review` | Calls existing `AssemblyWorkService.get` for permission/warehouse/station checks, requires the assigned worker, then opens a repeatable-read READ ONLY transaction with a 15-second statement timeout. Both evidence owners share that client. Errors roll back; failed rollback discards the client. |
| `server/modules/wms/packing-source-reader.ts:12`, `readOrderPackingSources` | WMS resolves customer-fulfillment source IDs for the exact order and warehouse. Requires shipment header and item to agree on order, validates rows, and rejects more than 500 sources. No source or stock writes. |
| `server/modules/shipping/package-allocation-ledger.repository.ts:468`, `readObservedPackagesForSources` | Published shipping read reuses bounded existing relationship discovery and persisted-label history. It never invokes group creation, source registration, plan append, or effect execution. Empty inputs do not query or fabricate packages. |
| `server/modules/warehouse/work/domain/assembly-package-review.ts:9`, `buildAssemblyPackageReview` | Uses the existing persisted lifecycle projector, requires current active/open evidence and authoritative contents for display, checks every declared source against the scoped WMS sources and source quantity. Any issue suppresses the entire instruction list; no partial list is presented as a complete package. |
| `shared/assembly-package-review.ts:5`, `assemblyPackageReviewSchema` | Strict DTO says `readOnly: true`, `closesPackage: false`, and `discoveryComplete: false`. Returned evidence hashes identify observed snapshots, not close authority. No provider account, integer label revision, or live allocation mode is invented. |
| `client/src/pages/warehouse-work/AssemblyPackageReview.tsx:18`, `AssemblyPackageEvidence`; `:34`, `AssemblyPackageReview` | Shows current observed tracking/label status and provider-declared quantities at the same bench. Refreshes the read periodically/manually. Missing, voided, foreign-source, conflicting, or closed-shipment evidence shows explicit review text. A refresh error hides the stale evidence. No Close button is offered. |
| `server/services/index.ts:180`, service construction | Runtime dependency container supplies the actual task owner and database pool. This is not a mock-only endpoint. |

## Corrections to the earlier checkpoint

The initial pure close contract required `providerAccountId`, an integer label revision/package version, and exclusively assigned picked-source quantities. Those fields are proposed requirements, **not current persisted facts**. They remain unimplemented in that contract's runtime producer. Do not adapt observed provider IDs into a fabricated account ID, force a constant revision, or copy the entire order-line picked count onto multiple shipment sources.

The new read path does not make those substitutions. It displays the existing label owner's `(provider, provider_label_id)` identity and validated event history, without claiming multi-account identity or allocation authority.

The current canonical unpick path already rejects a packing/packed/shipped or held order: `server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts:5228`, `unpickClaimLine`. However, the existing status owner permits `packing` only from `picked`: `server/modules/orders/order-status-core.ts:50`, `TRANSITION_MATRIX`. Assembly readiness currently uses `ready_to_ship`. A closing command must explicitly integrate the appropriate owner transition and quantity fences; merely appending a receipt would not protect picked stock.

## Risks, assumptions, and remaining checks

- Permission to view a scoped assembly job is not permission to close a parcel. Closing still requires current packing capability, worker/task fencing, and its owning transaction.
- Relationship discovery can miss labels with no persisted relationship. Empty results mean no linked observed package was found, not proof that no physical label exists. Label latency and actual production link coverage were not inspected.
- Cross-order combined packages are displayed as requiring review, with no leaked partial contents. They are not silently limited, reallocated, or rewritten. Closing combined/multi-warehouse packages requires the appropriate exact owner contract.
- Observed provider contents are not proof that those units were physically assembled, picked, or packed. The existing assembly/output-pick workflow stays authoritative for that work.
- Label void/reprint, source changes, competing package closes, and carrier possession must participate in a reviewed fence/invalidation contract before Close is enabled. No final write-lock order is asserted here.
- The original full close policy remains unwired. Its source-balance assumption needs resolution through actual pick ownership or a single guarded order-item balance across all package receipts—not repeated per-package copies of a picked total.

## Tests

- Focused route, owner-read, real lifecycle-projector, service transaction, and server-rendered UI checks: **54 passed**.
- Full unit regression: **886 files passed, 1 skipped; 8,760 tests passed, 37 skipped**.
- Final typecheck (including the added PostgreSQL test cases) and production build passed; build retains its existing large-chunk warning.
- Two CI-included PostgreSQL suites were explicitly skipped locally: **39 tests skipped**, no disposable database available. Added proof checks SELECT-only package discovery with unchanged allocation-ledger counts and exact order/warehouse source isolation under READ ONLY.
- No physical gun/bench acceptance, production inventory experiment, or live label mutation was performed. Database guarantees remain pending CI.

Failure behavior is explicit: malformed evidence rejects; unknown/missing/conflicting facts show review; permissions fail before provider-evidence reads; query failure rolls back; rollback failure discards the connection. No failure path fabricates successful completion.
