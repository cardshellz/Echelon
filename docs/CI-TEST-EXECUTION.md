# Pull-request test execution

CI keeps the regression coverage while distributing independent work across runners.
This changes test scheduling, not application behavior or production configuration.

## Required check and database isolation

`Typecheck + unit tests` retains its existing name and commands. This change does
not modify repository merge rules.

PostgreSQL hardening runs on every PR and push to main. The explicit inventory in
`scripts/ci/postgres-test-manifest.ts` preserves the 70 integration files previously
listed in the workflow. The runner partitions that inventory deterministically
across eight shards. Each GitHub matrix job gets its own PostgreSQL service. Each
test file gets a fresh, runner-owned database and a fresh Vitest process, and files
within a shard remain serial. Many fixtures create or rebuild the same named
schemas; some also leave baseline objects behind. Neither concurrent execution nor
arbitrary reordering against one shared database is safe.

`PostgreSQL hardening tests` is an aggregate check. It succeeds only if every shard
succeeds. A failed shard does not cancel the remaining shards, preserving diagnostic
results. Superseded workflow runs are still cancelled.

To run a shard locally, first create a **disposable local database** and explicitly
set `ECHELON_TEST_DATABASE_URL` and `ECHELON_TEST_DATABASE_DISPOSABLE=true`, then run:

```text
node --import tsx scripts/ci/postgres-tests.ts 1/8
```

Use a disposable local PostgreSQL service and a role allowed to create databases.
The connection URL identifies the administrative connection; tests only receive
their newly created database URL. The runner rejects remote database URLs, URL
query overrides, missing disposable consent, invalid shard numbers, duplicate
paths, and missing test files. It drops only a generated database whose creation
it confirmed; setup, execution, and cleanup failures fail the shard. Do not point
these tests at an application database.

Add new PostgreSQL CI suites to the manifest and update its coverage contract with
an explicit explanation. Do not add standalone serial commands back to the workflow.

## Browser suites

Procurement uses four runner shards; Dropship uses two. Both desktop and mobile
projects and the existing test patterns remain enabled. Tests within each runner
retain the original single-worker configuration. Test failures and traces are
associated with distinct shard artifacts.

Browser selection follows the relevant suite entrypoints and their transitive
source imports. Shared UI, app-shell, style, and toolchain changes run both suites.
Uncertain imports or changed-file information run tests rather than skipping them.
Manual workflow dispatch runs the complete selected suite.

Procurement currently loads `App.tsx`, which eagerly imports the application pages.
Those imports remain dependencies even when a test does not navigate to their
routes: a module initialization failure can break startup. Consequently many
frontend edits still require procurement coverage. This CI change does not
introduce lazy-loaded application routes just to make the filter narrower.

The selector does not claim that a server behavior change is proven by mocked
browser tests. Database and unit coverage remain separate and are not path-filtered
by the browser selector.

## Measuring the result

Compare the slowest shard and aggregate completion time against the previous job,
not the sum of durations across runners. Per-shard test reports retain failure and
timing evidence. Runner queue time, dependency setup, and the longest individual
test file still impose a lower bound on completion time. More runners also add
setup work; these changes optimize feedback latency, not a guaranteed reduction in
billable runner minutes.

Validate the first GitHub run before claiming a specific speedup. Local disposable
PostgreSQL and browser runs prove execution and coverage but do not reproduce hosted
runner capacity or queueing.

## Implementation validation

Validated on the clean implementation branch based on `bf044f8ec`:

- All eight database shards executed: **70 distinct files, 1,131 tests**, zero
  failures, errors, or skips. Per-file JUnit reports were checked for duplicate
  files and coverage loss. All runner-owned databases were removed afterward.
- All browser shards executed: **220 procurement tests** (56/54/56/54) and
  **60 Dropship tests** (30/30), including desktop and mobile.
- **83 CI contract tests** passed, covering dependency selection, coverage
  preservation, database ownership, setup/execution/cleanup failures, and gates.
- Repository TypeScript, strict standalone CI-helper TypeScript, actionlint
  workflow syntax, and whitespace checks passed.

The first attempted regrouping exposed legacy fixture leftovers (for example,
RFQ schema creation collided with catalog objects from an earlier file). The
fresh-per-file database design passed those same tests without modifying their
assertions or application code. Local validation used PostgreSQL 17; GitHub's
existing PostgreSQL 16 service version remains unchanged and must pass CI.

References: [Playwright sharding](https://playwright.dev/docs/test-sharding) and
[GitHub matrix jobs](https://docs.github.com/en/actions/using-jobs/using-a-matrix-for-your-jobs).
