# Catalog convergence batch (PR 1)

This extends **Supply & Transformations**; it does not add another review page.
It prepares and reviews catalog definitions only. It does not activate canonical
authority, reserve/move stock, publish quantities, or call a provider.

## Operator workflow

1. Choose **Create missing / refresh stale drafts**, select up to 25 products, and
   preview. Only missing drafts and stale `phase3_backfill` drafts are eligible.
   Operator-authored, excluded, and blocked products stay untouched.
2. Enter an audit reason and explicitly confirm the preview. Each product commits
   through the existing serializable draft writer. A refresh supersedes its exact
   old model; it does not edit history or carry an old approval forward.
3. Start a new batch and choose **Review exact current drafts**. Inspect the
   selected definitions, including conversion and recipe evidence. Explicitly
   choose approval or changes required, provide a reason, and confirm. Review is
   never bundled with draft creation or refresh.

## Evidence and concurrency

- `POST /api/inventory-planning/admin/migration-queue/batch/preview` requires view
  permission and is read-only. The response includes product names/SKUs and exact
  proposed definitions for inspection.
- `POST /api/inventory-planning/admin/migration-queue/batch/execute` requires edit
  permission and takes the actor exclusively from the authenticated session.
- Execution submits compact source, result, definition, draft-head, and latest-review
  evidence, not the potentially large recipe graph. A SHA-256 digest binds those
  fields. The digest is an optimistic-concurrency checksum, not an authorization
  credential: existing writers replan/revalidate catalog evidence under their locks.
- Each persisted per-product idempotency key is derived from the preview hash,
  actor, action, decision, reason, and product. Existing audit events and receipts
  retain the exact actor, reason, before/after model, and review identity.
- Reviews compare the latest review ID inside the existing product-locked
  serializable transaction. Another decision after preview causes a conflict;
  duplicate receipt replay returns the original review without replacing history.
  Latest review means append order (ID), not an application timestamp.

## Failure and retry behavior

The batch is deliberately **not catalog-wide atomic**. Each product is atomic;
successful rows remain committed when another row fails. Results name each
product, outcome, error code, and failure class.

- Stale sources, drafts, or review decisions require a new preview.
- Serialization/deadlock failures can retry the unchanged batch.
- Unexpected failures stop remaining work and are logged with the preview and
  product identifiers. Investigate before retrying.
- After a lost response, the same request reuses the original review receipt keys.
  Already-converged deterministic drafts return `already_current` with no new
  write; this does not claim that this request created them.
- A previously recorded review replay is historical evidence, not a claim that it
  is still the latest decision. The refreshed migration queue shows current state.

No new migration, table writer, activation endpoint, or production setting is needed.
After deployment, run previews first. Applying/reviewing production rows remains an
explicit operator action. Topology onboarding and final activation are separate work.
