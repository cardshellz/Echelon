import { describe, expect, it } from "vitest";
import {
  createPurchasePipelineJobRunLifecycleService,
  PurchasePipelineJobRunLifecycleError,
  sanitizePurchasePipelineJobError,
  type PurchasePipelineJobRunLifecycleRepository,
  type PurchasePipelineJobRunRecord,
} from "../../purchase-pipeline-job-run-lifecycle.service";

const NOW = new Date("2026-07-26T05:00:00.000Z");

function cloneRun(run: PurchasePipelineJobRunRecord): PurchasePipelineJobRunRecord {
  return {
    ...run,
    asOf: new Date(run.asOf),
    startedAt: new Date(run.startedAt),
    heartbeatAt: new Date(run.heartbeatAt),
    leaseExpiresAt: run.leaseExpiresAt ? new Date(run.leaseExpiresAt) : null,
    finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  };
}

function buildHarness(options: {
  now?: Date;
  runs?: PurchasePipelineJobRunRecord[];
  leaseMs?: number;
} = {}) {
  let now = new Date(options.now ?? NOW);
  let nextId = Math.max(0, ...(options.runs ?? []).map((run) => run.id)) + 1;
  const runs = (options.runs ?? []).map(cloneRun);

  const repository: PurchasePipelineJobRunLifecycleRepository = {
    async transaction(work) {
      return work({
        async lockClaims() {},
        async getDatabaseTimestamp() {
          return new Date(now);
        },
        async getRunningRunsForUpdate(jobType) {
          return runs
            .filter((run) => run.jobType === jobType && run.status === "running")
            .map(cloneRun);
        },
        async getRunForUpdate(id) {
          const run = runs.find((candidate) => candidate.id === id);
          return run ? cloneRun(run) : null;
        },
        async interruptRuns(ids, values) {
          const interrupted: PurchasePipelineJobRunRecord[] = [];
          for (const run of runs) {
            if (!ids.includes(run.id) || run.status !== "running") continue;
            Object.assign(run, {
              status: "interrupted",
              finishedAt: new Date(values.finishedAt),
              heartbeatAt: new Date(values.heartbeatAt),
              leaseExpiresAt: null,
              errorCode: values.errorCode,
              errorMessage: values.errorMessage,
              updatedAt: new Date(values.updatedAt),
            });
            interrupted.push(cloneRun(run));
          }
          return interrupted;
        },
        async createRun(values) {
          const run: PurchasePipelineJobRunRecord = {
            id: nextId++,
            ...values,
            asOf: new Date(values.asOf),
            startedAt: new Date(values.startedAt),
            heartbeatAt: new Date(values.heartbeatAt),
            leaseExpiresAt: new Date(values.leaseExpiresAt),
            finishedAt: null,
            recommendationRunId: null,
            recommendationLineCount: null,
            forecastObservationCount: null,
            evaluationInsertedCount: null,
            evaluationBatchCount: null,
            evaluationBacklogMayRemain: null,
            resultJson: null,
            errorCode: null,
            errorMessage: null,
            createdAt: new Date(values.startedAt),
            updatedAt: new Date(values.updatedAt),
          };
          runs.push(run);
          return cloneRun(run);
        },
        async renewRun(id, values) {
          const run = runs.find((candidate) => candidate.id === id && candidate.status === "running");
          if (!run) return null;
          Object.assign(run, {
            heartbeatAt: new Date(values.heartbeatAt),
            leaseExpiresAt: new Date(values.leaseExpiresAt),
            updatedAt: new Date(values.updatedAt),
          });
          return cloneRun(run);
        },
        async finishRun(id, values) {
          const run = runs.find((candidate) => candidate.id === id && candidate.status === "running");
          if (!run) return null;
          Object.assign(run, {
            ...values,
            heartbeatAt: new Date(values.heartbeatAt),
            finishedAt: new Date(values.finishedAt),
            updatedAt: new Date(values.updatedAt),
          });
          return cloneRun(run);
        },
      });
    },
  };

  return {
    service: createPurchasePipelineJobRunLifecycleService(repository, {
      leaseMs: options.leaseMs ?? 60_000,
    }),
    runs,
    setNow(value: Date) {
      now = new Date(value);
    },
  };
}

function runningRun(overrides: Partial<PurchasePipelineJobRunRecord> = {}): PurchasePipelineJobRunRecord {
  return {
    id: 1,
    jobType: "recommendation_snapshot",
    triggerType: "scheduled",
    status: "running",
    asOf: new Date("2026-07-26T05:00:00.000Z"),
    startedAt: new Date("2026-07-26T04:59:00.000Z"),
    heartbeatAt: new Date("2026-07-26T04:59:00.000Z"),
    leaseExpiresAt: new Date("2026-07-26T05:01:00.000Z"),
    finishedAt: null,
    recommendationRunId: null,
    recommendationLineCount: null,
    forecastObservationCount: null,
    evaluationInsertedCount: null,
    evaluationBatchCount: null,
    evaluationBacklogMayRemain: null,
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-07-26T04:59:00.000Z"),
    updatedAt: new Date("2026-07-26T04:59:00.000Z"),
    ...overrides,
  };
}

describe("purchase pipeline job run lifecycle", () => {
  it("starts a scheduled run using the database clock and a bounded lease", async () => {
    const harness = buildHarness();

    const result = await harness.service.startRun({
      jobType: "recommendation_snapshot",
      triggerType: "scheduled",
      asOf: new Date("2026-07-26T04:58:00.000Z"),
    });

    expect(result.interruptedRunIds).toEqual([]);
    expect(result.run).toMatchObject({
      id: 1,
      jobType: "recommendation_snapshot",
      status: "running",
      startedAt: NOW,
      heartbeatAt: NOW,
      leaseExpiresAt: new Date("2026-07-26T05:01:00.000Z"),
    });
  });

  it("rejects an overlapping active run of the same job type", async () => {
    const harness = buildHarness({
      now: new Date("2026-07-26T05:00:00.000Z"),
      runs: [runningRun({
        leaseExpiresAt: new Date("2026-07-26T05:10:00.000Z"),
      })],
    });

    await expect(harness.service.startRun({
      jobType: "recommendation_snapshot",
      triggerType: "scheduled",
      asOf: NOW,
    })).rejects.toMatchObject({
      code: "PURCHASE_PIPELINE_JOB_ALREADY_RUNNING",
      statusCode: 409,
    });
  });

  it("interrupts an expired lease before starting the replacement run", async () => {
    const harness = buildHarness({
      now: new Date("2026-07-26T05:02:00.000Z"),
      runs: [runningRun()],
    });

    const result = await harness.service.startRun({
      jobType: "recommendation_snapshot",
      triggerType: "scheduled",
      asOf: new Date("2026-07-26T05:02:00.000Z"),
    });

    expect(result.interruptedRunIds).toEqual([1]);
    expect(harness.runs[0]).toMatchObject({
      status: "interrupted",
      errorCode: "PURCHASE_PIPELINE_JOB_LEASE_EXPIRED",
      leaseExpiresAt: null,
    });
    expect(result.run.id).toBe(2);
  });

  it("records exact recommendation snapshot success evidence", async () => {
    const harness = buildHarness();
    const started = await harness.service.startRun({
      jobType: "recommendation_snapshot",
      triggerType: "scheduled",
      asOf: NOW,
    });
    harness.setNow(new Date("2026-07-26T05:00:30.000Z"));

    const completed = await harness.service.completeRun({
      runId: started.run.id,
      completion: {
        jobType: "recommendation_snapshot",
        recommendationRunId: 41,
        recommendationLineCount: 32,
        forecastObservationCount: 278,
        resultJson: { reused: false },
      },
    });

    expect(completed).toMatchObject({
      status: "succeeded",
      recommendationRunId: 41,
      recommendationLineCount: 32,
      forecastObservationCount: 278,
      evaluationInsertedCount: null,
      finishedAt: new Date("2026-07-26T05:00:30.000Z"),
    });
  });

  it("rejects completion after the worker lease has expired", async () => {
    const harness = buildHarness();
    const started = await harness.service.startRun({
      jobType: "recommendation_snapshot",
      triggerType: "scheduled",
      asOf: NOW,
    });
    harness.setNow(new Date("2026-07-26T05:01:00.000Z"));

    await expect(harness.service.completeRun({
      runId: started.run.id,
      completion: {
        jobType: "recommendation_snapshot",
        recommendationRunId: 41,
        recommendationLineCount: 32,
        forecastObservationCount: 278,
        resultJson: { reused: false },
      },
    })).rejects.toMatchObject({
      code: "PURCHASE_PIPELINE_JOB_LEASE_LOST",
      statusCode: 409,
    });
    expect(harness.runs[0]?.status).toBe("running");
  });

  it("records a successful no-op forecast evaluation", async () => {
    const harness = buildHarness();
    const started = await harness.service.startRun({
      jobType: "forecast_evaluation",
      triggerType: "scheduled",
      asOf: NOW,
    });

    const completed = await harness.service.completeRun({
      runId: started.run.id,
      completion: {
        jobType: "forecast_evaluation",
        evaluationInsertedCount: 0,
        evaluationBatchCount: 1,
        evaluationBacklogMayRemain: false,
        resultJson: { batches: [{ insertedCount: 0 }] },
      },
    });

    expect(completed).toMatchObject({
      status: "succeeded",
      recommendationRunId: null,
      evaluationInsertedCount: 0,
      evaluationBatchCount: 1,
      evaluationBacklogMayRemain: false,
    });
  });

  it("rejects completion evidence for a different job type", async () => {
    const harness = buildHarness();
    const started = await harness.service.startRun({
      jobType: "recommendation_snapshot",
      triggerType: "scheduled",
      asOf: NOW,
    });

    await expect(harness.service.completeRun({
      runId: started.run.id,
      completion: {
        jobType: "forecast_evaluation",
        evaluationInsertedCount: 0,
        evaluationBatchCount: 1,
        evaluationBacklogMayRemain: false,
        resultJson: {},
      },
    })).rejects.toBeInstanceOf(PurchasePipelineJobRunLifecycleError);
    expect(harness.runs[0]?.status).toBe("running");
  });

  it("transitions a running job to failed exactly once", async () => {
    const harness = buildHarness();
    const started = await harness.service.startRun({
      jobType: "forecast_evaluation",
      triggerType: "scheduled",
      asOf: NOW,
    });

    const first = await harness.service.failRun({
      runId: started.run.id,
      errorCode: "DATABASE_UNAVAILABLE",
      errorMessage: "Database unavailable token=internal-value",
      evaluationInsertedCount: 12,
      evaluationBatchCount: 2,
      evaluationBacklogMayRemain: true,
      resultJson: { completedBatches: 2 },
    });
    const replay = await harness.service.failRun({
      runId: started.run.id,
      errorCode: "DATABASE_UNAVAILABLE",
      errorMessage: "Database unavailable token=internal-value",
    });

    expect(first.transitioned).toBe(true);
    expect(first.run).toMatchObject({
      status: "failed",
      evaluationInsertedCount: 12,
      evaluationBatchCount: 2,
      errorMessage: "Database unavailable token=[REDACTED]",
    });
    expect(replay.transitioned).toBe(false);
  });

  it("redacts credentials and normalizes persisted failure evidence", () => {
    const failure = sanitizePurchasePipelineJobError(Object.assign(
      new Error(
        "connect postgres://owner:super-secret@db.example/echelon "
        + "password=hunter2 token:abc123",
      ),
      { code: "ECONN REFUSED" },
    ));

    expect(failure).toEqual({
      errorCode: "ECONN_REFUSED",
      errorMessage:
        "connect postgres://[REDACTED]@db.example/echelon "
        + "password=[REDACTED] token:[REDACTED]",
    });
  });
});
