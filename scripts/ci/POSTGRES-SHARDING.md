# PostgreSQL shard timing evidence

`postgres-test-manifest.ts` remains the coverage authority. Every listed file runs
once across eight jobs, serially within its job, with its own database and Vitest
process. Timing data affects placement only; it cannot add or remove coverage.

`postgres-shard-planner.ts` assigns longest estimated files first to the currently
lightest shard. Equal durations use ASCII path order; equal shard loads use the
lowest shard index. The planner copies inputs, makes no network requests, and
does not depend on a runner-local cache, locale, clock, or manifest ordering.

`postgres-test-timings.snapshot.json` records the Vitest **Duration** summary for
each file in successful [CI run 38490362642](https://github.com/cardshellz/Echelon/actions/runs/38490362642),
head `ca148634e8c4abf105e6dec37b42111da61de871`. Every row identifies its successful
source job. The snapshot contains all 163 suites present in that run. Values are
milliseconds converted from the printed `ms`/`s` summaries, not invented estimates
or test-count proxies. These summaries include Vitest startup/import/test work,
but do not include outer database creation/cleanup, dependency installation,
service startup, or GitHub scheduling delays.

Using those identical measurements, the old shard assignments totaled
73,339–233,562 ms per shard. The new plan totals 147,184–147,605 ms, preserving the
1,178,833 ms total. This is a planning comparison, not proof of equivalent hosted
wall-clock savings. Suites can change and shared runner resources vary.

## New, renamed, and retired tests

A manifest file without a measurement receives the **largest measured duration
in the snapshot** (currently 107,440 ms). This explicit conservative fallback keeps
new coverage running immediately. It is reported as unmeasured in the shard-start
event; it is not recorded as an observed timing. Retired timing rows are reported
as unused and never restore files removed from the manifest. Renamed files use
the same fallback until a successful run measures the new path.

The snapshot parser rejects missing/unknown fields, failed-run provenance,
duplicate suites or source jobs, untraceable job IDs, invalid paths, and invalid
durations. A duration must be a positive integer no greater than the existing
twenty-minute job timeout. The existing fast CI guard imports and validates this
artifact before any PostgreSQL shard can start.

## Refreshing evidence

1. Choose one successful core CI run with all eight PostgreSQL shards successful.
   Save its run/head/job metadata and each job log with `gh run view`.
2. For each job, read the `postgres_ci_shard_start.files` array and
   `postgres_ci_shard_complete` record. Require zero failed files and exactly one
   successful Vitest file summary and Duration value per listed file. The serial
   runner gives these summaries the same order as the file array.
3. Convert printed seconds to integer milliseconds, preserving the source run,
   head and job IDs. Require each file exactly once across all eight logs. Sort
   measurement rows by ASCII file path; do not edit timings to achieve a desired
   balance. Review the complete diff against the previous snapshot.
4. Run `postgres-ci-shards.test.ts`. Confirm all current manifest paths remain
   assigned exactly once and inspect unmeasured/unused paths. Compare planned
   loads against the former modulo assignment using the same measurements; also
   inspect actual source-job durations. Later source runs already use balancing.
5. Run all eight hosted shards before claiming a measured runtime improvement.

Do not combine files into a shared database or process to reduce startup cost.
Existing suites intentionally exercise schema changes, immutable history,
transaction concurrency, and in some cases cluster-level roles; their isolation
contract is unchanged by this planner.
