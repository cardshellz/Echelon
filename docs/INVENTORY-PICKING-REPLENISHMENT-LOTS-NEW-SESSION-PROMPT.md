Work in C:\Users\owner\Echelon.

Continue the picking, replenishment, and inventory-lot code architecture review. This is a focused continuation, not a new ATP engine, another cutover, a channel UI redesign, or an instruction to repeat completed order recoveries.

First read these files in full:

1. C:\Users\owner\Echelon\docs\INVENTORY-PICKING-REPLENISHMENT-LOTS-HANDOFF-2026-10-04.md
2. C:\Users\owner\Echelon\docs\INVENTORY-PICKING-REPLENISHMENT-LOTS-REVIEW-2026-10-01.md
3. C:\Users\owner\Echelon\BOUNDARIES.md

Read applicable AGENTS.md files if present. The handoff preserves my engineering requirements from the previous chat; do not claim a missing file was read. These three documents are published together under docs; in another checkout, use its corresponding paths. Supporting recovery records, audit artifacts, and uncommitted code are local-only and are not included in the documentation publication. If unavailable, record the evidence gap and continue the repository-based review without inventing their contents or recreating operational repairs.

Purpose and nonnegotiable principles:

- One source of truth for quantities, decisions, and operations. Do not keep duplicate algorithms and merely check that they match.
- Keep the existing ATP engine, quantity journal, and transaction protections. Build on small, focused primitives with clear domain/application/infrastructure/interface boundaries; avoid giant mixed-responsibility services and speculative abstractions.
- Honor physical-only, package-hierarchy, and build-managed behavior everywhere. Automatic conversions must use an authorized server-side path. Replenishment is rules/resolver driven, not picker-UI policy.
- Preserve exact SKU/warehouse/location/claim identity, quantity units, cost lineage, auditability, permissions, and recorded physical work. Do not invent receipts, picks, shipments, or zero costs to bypass a guard.
- Prove every conclusion with exact files, functions, and relevant lines. Label hypotheses and unknowns. Passing tests, merged code, deployment, and current production behavior are separate evidence.
- Use explicit contracts and validation, exact money, stable idempotency, transactional rollback, concurrency-safe transitions, and durable follow-up work. Remove verified dead paths rather than adding more wrappers around duplicate owners.

Begin with a bounded current-code revalidation:

1. Inspect Git status/worktrees and fetch origin/main. Record the exact main commit. Do not switch, reset, clean, or broadly stage the dirty primary checkout.
2. Preserve C:\Users\owner\Echelon\.codex-worktrees\order-63721-investigation and its uncommitted recovery code. Read the two recovery documents listed in the handoff before touching overlapping code. Orders 63721 and 63764 were already recovered; do not rerun their scripts. Their recovery did not prove the general architecture findings fixed.
3. Revalidate F01-F15 and relevant conditional/cleanup findings against current main, including the later commits identified in the handoff. Trace actual callers, inputs, conditions, transaction boundaries, side effects, and failure/retry paths. Use focused tests where needed; no production census or cutover checks.
4. Save a separate current-status addendum. For each finding mark open, partially fixed, fixed with evidence, superseded, or not yet verified; cite current evidence and the remaining proof needed. Keep the original October 1 report unchanged. Its audit counterexamples intentionally assert buggy behavior and must not be mistaken for passing regression tests of a fix.
5. Recommend the first coherent implementation batch, using the original A/B/C grouping where still appropriate. Identify overlap with existing local work. Ask only genuinely unresolved questions, with concrete examples; do not reopen settled decisions. In particular, get explicit agreement on F11's unresolved-cost policy before changing physical admission.

This initial task is revalidation and remediation planning. Do not implement application changes or mutate production data/configuration/quantities, run incident recoveries, merge, deploy, or activate anything. Present the remaining gaps and proposed batch for approval. When implementation is approved, use a suitable clean worktree and dedicated codex/ branch, preserve unrelated work, and deliver large coherent changes with focused unit, real disposable PostgreSQL, and relevant browser tests. Prove replay, concurrent actions, rollback, and post-commit recovery. Check migration-prefix collisions against fresh main and verify the actual PR URL/branch instead of reusing another effort's PR.

Keep updates concise. Lead with what remains and the next concrete action, not a retelling of the old thread. Report assumptions, risks, test limits, and failure modes honestly. Do not make me reconstruct the earlier investigation.
