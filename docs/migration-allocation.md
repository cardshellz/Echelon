# Migration allocation and validation

The release runner still executes top-level SQL files in lexical filename order and identifies applied migrations by filename or SQL hash. Existing SQL filenames and bytes must remain unchanged. `migrations/legacy-migrations.json` freezes the 509 files present when this policy was introduced; it is not a place to register new migrations.

## New work

Create a draft pull request before assigning final migration filenames. Refresh the branch with current main and declare dependencies on migrations from other workstreams. Then run:

```sh
npm run migration:create -- --pr 1800 --name receiving_audit_guard
npm run migration:create -- --pr 1800 --name followup --after <dependency-filename.sql>
npm run migration:check
node scripts/migrations/check-migrations.mjs --base origin/main --pr 1800
```

The generator creates SQL and a JSON sidecar under `migrations/metadata/`. Add the actual SQL to a newly generated template before review. Commit both files. The generator makes no database or network calls; refresh main explicitly before using it. Its default dependency is the latest lexical migration visible in the checkout. Repeat `--after` for additional dependencies.

The prefix is `9` + eight-digit dependency generation + eight-digit PR number + four-digit ordinal. The full prefix must remain a string because it exceeds JavaScript's exact integer range. The generation is one greater than the largest dependency generation; frozen legacy files have generation zero. Different PRs cannot claim the same prefix, while separate files in one PR have separate ordinals. An older PR can depend on a newer PR because dependency generation precedes PR identity in the sort order. All new files sort after frozen legacy history.

Names, metadata, dependencies and field bounds are validated. The generator uses exclusive writes and a directory lock. A concurrent local allocation fails with `MIGRATION_ALLOCATION_BUSY`; retry after the first finishes. A lock left after process termination needs inspection before removal. Separate worktrees contributing to the same PR must coordinate ordinals; the lock is local, not a distributed reservation service. CI rejects duplicate PR/ordinal identities even across generations.

## Adopting an unmerged migration

Only an unmerged SQL file may change filename. For an existing pending migration:

```sh
git fetch origin main
npm run migration:create -- --pr 1800 --name receiving_audit_guard --adopt migrations/0750_receiving_integrity_audit_guard.sql
```

The command verifies that the source is absent from `origin/main` (or explicit `--base <ref>`), excludes only that source during allocation, and preserves its exact SQL bytes. Metadata lives in a sidecar so adding ownership/dependency evidence does not change the SQL content hash. Update every fixture, runbook and prose reference to the returned filename. The command restores the original source and removes its own new files if a later operation fails. A process or machine crash can interrupt multiple filesystem writes: inspect both paths and the lock before recovery; do not treat filesystem allocation as a database transaction.

If an unmerged migration's dependencies change, it may be adopted again with the new dependencies before merging. Once a migration is on the base branch, create a successor migration instead. Never rename or edit an applied migration merely to pass validation.

## CI and release

`node scripts/migrations/check-migrations.mjs` needs only Node built-ins. It checks duplicate numeric prefix strings first, the frozen legacy allowlist, names, sidecars, PR/ordinal uniqueness, dependency existence, cycles, and lexical execution order. Release uses the same policy and unchanged SQL execution order.

`--ci` reads GitHub event evidence. Pull requests additionally enforce the owner PR on newly added migrations and reject changes to base SQL, sidecars, or the frozen manifest. The PR checkout must match `GITHUB_SHA` at `refs/pull/<number>/merge`, have exactly two parents, and identify the event's PR head as its second parent. The first parent is the comparison base and must descend from the event's base SHA. This accounts for main advancing between the event snapshot and GitHub's merge checkout without attributing already-merged migrations to the current PR. The success record includes the effective `base` and original `eventBase` for diagnosis. Missing or inconsistent checkout evidence fails closed; a workflow that explicitly checks out the PR head must use the synthetic merge checkout for this guard.

For a stacked PR that inherits migrations from another merged PR, the CI CLI verifies provenance through GitHub's read-only pull-request API. The owning PR must be merged in the event repository, its recorded merge commit must be an ancestor of the event's PR head, and every migration SQL file and sidecar owned by that PR must still match the merge exactly. Historical additions are inspected even when an inherited file has since been deleted or replaced. Obsolete draft allocations are ignored only when both files are absent from the PR head, merge checkout and disk, and the owning PR record confirms they were never merged or its exact merge tree contains only the final allocation. A commit message or an allocation number alone is not proof. This preserves original allocation identities when main or a merged child PR contributes migrations to a dependency branch.

Only the migration preflight jobs receive a step-scoped `GITHUB_TOKEN`, with `contents: read` and `pull-requests: read`. API requests are bounded and cached per owner within the check. Missing credentials, unavailable Git history, unavailable GitHub evidence, or changed inherited files fail closed with a diagnostic; retry transient API failures after recovery. No API request is needed when there is no foreign allocation history. Local `--base ... --pr ...` checks remain strict and offline: they do not grant inherited ownership exceptions. The release runner and SQL execution order are unchanged.

Push events use `before`; merge groups use `base_sha`. These checks require the base commit locally, so CI checks out full history. A missing base fails closed. A manual `workflow_dispatch` validates only its checked-out catalog because that event does not establish a PR owner or comparison base. A stacked PR should target its actual dependency branch or wait for that dependency to merge; it cannot claim another PR's added migration as its own.

On first introduction only, CI verifies that the legacy allowlist exactly equals the base's SQL inventory. After it exists on the base, the allowlist is immutable. A new legacy migration that reaches main before this policy is merged must be included in that initial inventory after refreshing the policy branch; do not change its SQL.

Declared dependencies are checked, but SQL semantics cannot be proven from filenames. Authors must declare cross-PR dependencies, and review/integration tests must prove the schema and data assumptions. The policy does not prove a migration was applied in production. Production application evidence remains in the migration ledger and release logs.
