# Procurement browser CI capacity

## Confirmed failure

PR #1838 at `74635e1b4cb8d0c895a52a4509fa0c1456a48de1`, workflow run [39155470980](https://github.com/cardshellz/Echelon/actions/runs/39155470980), reached the procurement browser job's 15-minute execution limit. GitHub's annotation on [shard 1](https://github.com/cardshellz/Echelon/actions/runs/39155470980/job/117757837605) explicitly reports that limit. Its Playwright output reports `213 passed (14.4m)` immediately before cancellation. The final required check rejects the cancelled matrix result as intended.

| Shard | Cases reported passed | Playwright duration | Job result |
| --- | ---: | ---: | --- |
| 1/4 | 213 | 14.4 minutes | Cancelled: execution limit |
| 2/4 | 213 | 9.2 minutes | Success |
| 3/4 | 213 | 14.0 minutes | Success |
| 4/4 | 213 | 13.7 minutes | Success |

The 852 reported passing cases do not turn a cancelled job into a successful required check. Setup, dependency/browser installation and cleanup share the job budget. The logs establish the timeout; they do not explain all runtime differences between equal-size shards.

## Correction

`.github/workflows/procurement-navigation.yml` partitions the same complete suite across eight shards and gives each job a 20-minute budget. The matrix supplies the total used by both the job name and Playwright invocation. Two workers per runner, individual test/assertion timeouts, test discovery, migration/impact selection and the fail-closed required check remain unchanged. More shards reduce cases per runner; the larger timeout allows setup and runner variance. Hosted queue time and actual speedup require a new run.

`server/__tests__/unit/ci-fast-feedback.test.ts` guards contiguous shard assignment, matching total, job budget and complete fail-closed aggregation. Actual Playwright discovery is compared separately to all eight shard discoveries, avoiding extra discovery processes on every early CI guard run.

## Validation

All 207 early CI guards passed across six files; the server-test TypeScript project also passed. Actual Playwright discovery retained all 852 unique cases (426 desktop and 426 mobile), assigned exactly once across eight shards: four with 107 cases and four with 106. No missing, extra or duplicate assignments were found. The new permanent guard remains inexpensive; the nine discovery commands were a one-time validation.

## Validation limits

No application behavior, database schema or financial operation changes in this follow-up. Discovery proves assignment, not browser execution. The original run supplies the 852 passing case outputs; the corrected workflow still requires a successful hosted run at its final published commit.
