# Web memory investigation: bounded production diagnostics

## Confirmed evidence and remaining question

Read-only Heroku checks on September 23 found release `v3002`, commit
`81e5d9bb`, serving the web process. At `2026-09-23T13:34:13Z`, Heroku reported
`memory_total=816.23MB`, `memory_rss=460.63MB`, `memory_cache=6.30MB`, and
`memory_swap=349.30MB` against a `512MB` quota, with repeated R14 warnings.
This confirms memory pressure, not which application object or job caused it.

A later read-only check found another deployment (`v3003`, `c5cf4d96`, released
at `2026-09-23T13:48:57Z`). The replacement web dyno reported `567.82MB` total
at `14:02:01Z` and was already emitting R14 warnings. The smaller number belongs
to a different process: it is not evidence that the earlier process released its
memory. This investigation did not deploy or restart either process.

The previous September 22 sample fell from approximately 353MB to 274MB while
the fulfillment sweep was running, then grew again after the sweep finished.
Its many reconciliation errors are not proof that the sweep or its logs leaked.
No live heap/object-retention profile or per-workload measurements were available.
The earlier WMS page-loading incident and its changes are documented separately
in `page-loading-memory-fix-2026-09-17.md`; this is not evidence of a recurrence
of that specific defect.

`package.json` starts Node with `--max-old-space-size=384`. That is a V8
old-space setting, not a cap on all process memory or a measurement of its use.
Do not increase it on a 512MB dyno as a supposed fix for the unexplained excess.

## Implementation and boundaries

`server/index.ts` starts `startRuntimeMemoryTelemetry` before HTTP body parsing
and scheduled jobs. It takes a startup sample and one sample every 60 seconds.
`server/platform/observability/runtime-memory.ts` collects process measurements
and existing in-memory PostgreSQL pool counters; it executes no database query.
Its observer in `runtime-memory-observer.ts` maintains at most 64 fixed-size
counter groups. It does not retain work results, errors, request bodies, URL
parameters, order identifiers, or a historical sample array.

Each interval emits one `runtime.memory` record and up to 64
`runtime.work_memory` records, only for groups active during that window.
There are no per-request or per-job-start log messages. Requests get fixed
categories and counts/durations, not per-request memory samples. A job gets two
process-memory readings, around its existing callback. Timers, single-flight
guards, locks, limits, retries, service binding, results and exception behavior
remain owned by the existing workers.

The production default is enabled. `RUNTIME_MEMORY_TELEMETRY_ENABLED=false`
disables it; `true` explicitly enables it outside production. The optional
`RUNTIME_MEMORY_TELEMETRY_INTERVAL_MS` accepts an integer from 10000 to 300000;
missing or invalid values use 60000. These are startup settings, not an HTTP
admin endpoint. No production settings were changed during implementation.
The interval is unreferenced and is cleared when the HTTP server closes.

## Reading the output

Memory values are **bytes**, durations are milliseconds. Existing logger `ts`,
`pid`, `uptimeSeconds`, and `reportSequence` identify each process/window.
Pair records within the same dyno/process lifetime; sequence restarts on reboot.

| Field | Meaning and interpretation limit |
| --- | --- |
| `rss` | Resident memory of this Node process; not all dyno processes combined. |
| `swapBytes` | This process's `/proc/self/status` `VmSwap`; `null` means unavailable, never zero. |
| `heapUsed`, `heapTotal`, `heapPhysical`, `heapLimit` | V8 heap readings to distinguish growing live heap from capacity retained by V8. A sample is not a retained-object profile. |
| `external`, `arrayBuffers` | External allocation counters; array buffers are included in external, so do not add them together. These categories also overlap RSS. |
| `malloced`, `nativeContexts`, `detachedContexts` | Additional V8 indicators, not a complete account of every native allocation. |
| `stdoutQueuedBytes`, `stderrQueuedBytes` | Node's pending writable-stream buffers, not the size of Heroku's remote log retention. |
| `peakStdoutQueuedBytes`, `peakStderrQueuedBytes` | Highest queue reading at periodic sample attempts since the previous reported sample, including skipped attempts. Not continuous peak measurement. |
| `databasePool`, `schedulerPool` | Main pool and advisory-lock pool connections/waiters; scheduler snapshot also lists held lock IDs. No additional queries. |
| `activeWork` | Number of observed in-flight wrappers/requests; nested observations are not unique units of work. |
| Work `started`, `completed`, `failed`, `active`, `peakActive` | Callback counts and concurrency. Completed means returned, not that every business record in a batch succeeded. |
| Work `maxRssDelta`, `maxHeapDelta`, `maxExternalDelta` | Largest signed before/after difference among jobs completed in the window. Null means unsampled/unavailable. Different maxima can belong to different runs. |
| Work `overlappingStarts` | Starts with some other observed work already active, including nested observations. Zero does not exclude later overlap or uninstrumented activity. |
| `telemetryFailures`, `samplingFailures`, `skippedReports` | Missing diagnostic evidence; never reinterpret missing measurements as zero usage. |

Work deltas are labeled `whole_process_not_exclusive`: GC, concurrent work,
unobserved work and native allocation can affect them. **Do not add job deltas
together or call a positive delta a proven leak.** Reporting resets window
counters but preserves in-flight gauges. Work spanning several windows reports
its entire elapsed time and process delta when it completes.

### Observed work

Named groups cover channel fulfillment, label lifecycle, ShipStation void and WMS
reconciliation, carrier reconciliation, webhook retries, eBay/Walmart order
polling, eBay listing/fulfillment reconciliation, Shopify mapping reconciliation,
OMS/WMS and sync-recovery sweeps, and inventory publication workers/sweeps.

The shared advisory-lock runner records acquired work as `scheduler.lock_<id>`,
not failed acquisition or work skipped because another process holds the lock.
Known shipping-related IDs from `fulfillment-sweeper.scheduler.ts` are:

| Group | Work |
| --- | --- |
| `scheduler.lock_8484` | Outbound fulfillment sweep |
| `scheduler.lock_8485` | Inbound fulfillment sweep |
| `scheduler.lock_8486` | Inbound receipt recovery |
| `scheduler.lock_8487` | ShipStation label recovery |
| `scheduler.lock_736207` | Operations Control Tower projection |

Other lock domains use that same shared runner without domain-behavior changes.
This is not a complete trace of every async callback in the application. HTTP
categories intentionally do not identify individual orders, paths, or customers.
New/invalid work names exceeding the bounded group capacity aggregate into
`other`, rather than allocating an unbounded map.

## Production acceptance after a separately approved deployment

1. Verify the deployed commit; confirm a startup `runtime.memory` entry and
   subsequent entries one minute apart. If missing, check the enable setting and
   existing `LOG_LEVEL` before interpreting the silence.
2. Correlate entries with Heroku's memory samples for the **same web dyno**.
   Separate startup, busy periods and periods after jobs finish. Do not compare
   two different processes as one memory trend.
3. Establish which category grows: V8 heap, external buffers, pending output,
   process swap, or an RSS/heap gap. Compare overlapping job counts and pool
   waiters. Capture several cycles; a single positive delta does not establish
   cause.
4. Trace the correlated owner's allocations and retention with focused evidence.
   If these counters cannot identify the allocator, reproduce/profile that path
   in isolation before changing its behavior. A live heap dump or attaching a
   profiler is a separate decision; neither is introduced here.
5. Confirm normal fulfillment and HTTP response behavior and reasonable log
   volume. Disabling the probe requires a separately authorized configuration
   change/restart. It does not repair the original memory growth.

A bounded read-only log query is:

```powershell
heroku logs --app cardshellz-echelon --dyno web.1 --num 1500 |
  Select-String 'runtime.memory|runtime.work_memory|sample#memory_total|Error R14'
```

Do not run broad backfills or repeated expensive endpoints to induce memory
pressure in production. No production restart, config mutation, heap dump,
forced garbage collection, database write, provider call, or deployment is part
of this diagnostic implementation.

## Failure modes and validation

Collectors and log-sink exceptions do not fail work; counters report the missing
evidence on a later successful window. If either Node output queue exceeds 64KiB,
the periodic report is skipped. Work counters and numeric queue peaks are kept,
not queued log objects. This limits the diagnostic contribution to backpressure;
it does not bound other application logging. A blocked event loop can delay the
timer, and process death can lose the last incomplete reporting window.

Tests cover configuration bounds/opt-out, cardinality/output limits, numerical
validation, concurrency across windows, identity-preserving return/error paths,
failing collectors and log sinks, output backpressure, process swap parsing,
timer cleanup, privacy, and both HTTP finish/abort paths. Wiring tests use a real
local Express/HTTP request, a fake advisory-lock client, and actual fulfillment
and void-recovery workers with diagnostic failures injected. There are no new
database schemas, queries or writes needing a PostgreSQL migration test.

Local validation against base `81e5d9bbf`:

- Full non-database suite: **16,967 passed, 23 skipped, zero failed**, across
  1,398 files. The report is in the ignored local artifact
  `test-results/runtime-memory-full-suite-final.json`.
- Final focused diagnostics/affected-worker run: **88 passed** in 11 files,
  including the final defensive regression for untyped work names.
- Production and server-test TypeScript checks and production build passed.
- Windows source-contract fixtures that depend on literal LF were normalized
  locally to repository LF contents. They have no Git diff and are not part of
  the patch. Two touched scheduler source guards were updated to recognize and
  assert the observed wrapper without weakening their original safety checks.
- No browser journeys or live PostgreSQL tests were run: no UI, SQL, schema or
  financial-state behavior changed. The HTTP wiring test uses a local server.

The later deployed `c5cf4d96e` adds an unrelated returns-preview change; a fetch
and path comparison showed no overlap with these diagnostic files. Production
measurement must still verify the exact diagnostic commit after deployment.

Production root-cause attribution remains **pending deployment and measurement**.
