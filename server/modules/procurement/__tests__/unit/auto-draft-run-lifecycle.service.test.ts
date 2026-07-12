import { describe, expect, it } from "vitest";
import {
  createAutoDraftRunLifecycleService,
  type AutoDraftRunLifecycleRepository,
  type AutoDraftRunRecord,
  type AutoDraftRunTerminalValues,
} from "../../auto-draft-run-lifecycle.service";

const NOW = new Date("2026-07-12T02:00:00.000Z");
const LEASE_MS = 10 * 60 * 1_000;

function cloneRun(run: AutoDraftRunRecord): AutoDraftRunRecord {
  return {
    ...run,
    runAt: new Date(run.runAt),
    heartbeatAt: new Date(run.heartbeatAt),
    leaseExpiresAt: run.leaseExpiresAt ? new Date(run.leaseExpiresAt) : null,
    finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
  };
}

function runningRun(overrides: Partial<AutoDraftRunRecord> = {}): AutoDraftRunRecord {
  return {
    id: 1,
    runAt: new Date("2026-07-12T01:55:00.000Z"),
    triggeredBy: "scheduler",
    triggeredByUser: null,
    status: "running",
    heartbeatAt: new Date("2026-07-12T01:55:00.000Z"),
    leaseExpiresAt: new Date("2026-07-12T02:05:00.000Z"),
    itemsAnalyzed: 0,
    posCreated: 0,
    posUpdated: 0,
    linesAdded: 0,
    skippedNoVendor: 0,
    skippedOnOrder: 0,
    skippedExcluded: 0,
    errorMessage: null,
    summaryJson: null,
    finishedAt: null,
    ...overrides,
  };
}

function buildHarness(initialRuns: AutoDraftRunRecord[] = []) {
  const state = { runs: initialRuns.map(cloneRun), now: new Date(NOW), lockCount: 0 };
  const repository: AutoDraftRunLifecycleRepository = {
    async transaction(work) {
      const staged = state.runs.map(cloneRun);
      const result = await work({
        async lockClaims() {
          state.lockCount += 1;
        },
        async getDatabaseTimestamp() {
          return new Date(state.now);
        },
        async getRunningRunsForUpdate() {
          return staged.filter((run) => run.status === "running").map(cloneRun);
        },
        async getRunForUpdate(id) {
          const run = staged.find((candidate) => candidate.id === id);
          return run ? cloneRun(run) : null;
        },
        async interruptRuns(ids, values) {
          const interrupted: AutoDraftRunRecord[] = [];
          for (const run of staged) {
            if (!ids.includes(run.id) || run.status !== "running") continue;
            Object.assign(run, {
              status: "interrupted",
              finishedAt: values.finishedAt,
              heartbeatAt: values.heartbeatAt,
              leaseExpiresAt: null,
              errorMessage: values.errorMessage,
            });
            interrupted.push(cloneRun(run));
          }
          return interrupted;
        },
        async createRun(values) {
          const created = runningRun({
            ...values,
            id: Math.max(0, ...staged.map((run) => run.id)) + 1,
          });
          staged.push(created);
          return cloneRun(created);
        },
        async renewRun(id, values) {
          const run = staged.find((candidate) => candidate.id === id && candidate.status === "running");
          if (!run) return null;
          Object.assign(run, values);
          return cloneRun(run);
        },
        async finishRun(id, values: AutoDraftRunTerminalValues) {
          const run = staged.find((candidate) => candidate.id === id && candidate.status === "running");
          if (!run) return null;
          Object.assign(run, values);
          return cloneRun(run);
        },
      });
      state.runs = staged.map(cloneRun);
      return result;
    },
  };
  return { state, service: createAutoDraftRunLifecycleService(repository, { leaseMs: LEASE_MS }) };
}

const completion = {
  itemsAnalyzed: 12,
  skippedNoVendor: 2,
  skippedOnOrder: 1,
  skippedExcluded: 3,
  summaryJson: { version: 1 },
};

describe("auto-draft run lifecycle", () => {
  it("claims a database-timed lease for the first run", async () => {
    const harness = buildHarness();

    const result = await harness.service.startRun({ triggeredBy: "manual", triggeredByUser: "buyer-1" });

    expect(result.interruptedRunIds).toEqual([]);
    expect(result.run).toMatchObject({
      id: 1,
      runAt: NOW,
      heartbeatAt: NOW,
      leaseExpiresAt: new Date("2026-07-12T02:10:00.000Z"),
      status: "running",
      triggeredBy: "manual",
      triggeredByUser: "buyer-1",
    });
    expect(harness.state.lockCount).toBe(1);
  });

  it("rejects a second run while the current lease is active", async () => {
    const harness = buildHarness([runningRun()]);

    await expect(harness.service.startRun({ triggeredBy: "scheduler" })).rejects.toMatchObject({
      statusCode: 409,
      code: "AUTO_DRAFT_RUN_ALREADY_RUNNING",
      context: { runId: 1, leaseExpiresAt: "2026-07-12T02:05:00.000Z" },
    });
    expect(harness.state.runs).toHaveLength(1);
    expect(harness.state.runs[0].status).toBe("running");
  });

  it("classifies a nested single-running unique-index violation as an active-run conflict", async () => {
    const repository: AutoDraftRunLifecycleRepository = {
      async transaction() {
        const postgresError = Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint: "auto_draft_runs_single_running_uidx",
        });
        throw Object.assign(new Error("query failed"), {
          code: "23505",
          cause: postgresError,
        });
      },
    };
    const service = createAutoDraftRunLifecycleService(repository, { leaseMs: LEASE_MS });

    await expect(service.startRun({ triggeredBy: "scheduler" })).rejects.toMatchObject({
      statusCode: 409,
      code: "AUTO_DRAFT_RUN_ALREADY_RUNNING",
    });
  });

  it("interrupts an expired lease before claiming the next run", async () => {
    const harness = buildHarness([runningRun({
      leaseExpiresAt: new Date("2026-07-12T01:59:59.000Z"),
    })]);

    const result = await harness.service.startRun({ triggeredBy: "scheduler" });

    expect(result.interruptedRunIds).toEqual([1]);
    expect(result.run.id).toBe(2);
    expect(harness.state.runs[0]).toMatchObject({
      status: "interrupted",
      finishedAt: NOW,
      leaseExpiresAt: null,
      errorMessage: expect.stringContaining("lease expired"),
    });
    expect(harness.state.runs[1].status).toBe("running");
  });

  it("renews only a currently owned lease", async () => {
    const harness = buildHarness([runningRun()]);
    harness.state.now = new Date("2026-07-12T02:03:00.000Z");

    const renewed = await harness.service.heartbeatRun({ runId: 1 });

    expect(renewed).toMatchObject({
      heartbeatAt: new Date("2026-07-12T02:03:00.000Z"),
      leaseExpiresAt: new Date("2026-07-12T02:13:00.000Z"),
    });
    harness.state.runs[0].status = "interrupted";
    harness.state.runs[0].finishedAt = new Date(harness.state.now);
    harness.state.runs[0].leaseExpiresAt = null;
    await expect(harness.service.heartbeatRun({ runId: 1 })).rejects.toMatchObject({
      code: "AUTO_DRAFT_RUN_LEASE_LOST",
    });
  });

  it("completes an analysis-only run with compare-and-set terminal state", async () => {
    const harness = buildHarness([runningRun()]);

    const completed = await harness.service.completeRun({ runId: 1, completion });

    expect(completed).toMatchObject({
      status: "success",
      itemsAnalyzed: 12,
      posCreated: 0,
      linesAdded: 0,
      summaryJson: { version: 1 },
      finishedAt: NOW,
      heartbeatAt: NOW,
      leaseExpiresAt: null,
    });
    await expect(harness.service.completeRun({ runId: 1, completion })).rejects.toMatchObject({
      code: "AUTO_DRAFT_RUN_LEASE_LOST",
    });
  });

  it("records failure without replacing an existing terminal status", async () => {
    const harness = buildHarness([runningRun()]);

    const failed = await harness.service.failRun({
      runId: 1,
      errorMessage: "analysis failed",
      progress: { ...completion, summaryJson: null },
    });

    expect(failed.transitioned).toBe(true);
    expect(failed.run).toMatchObject({ status: "error", errorMessage: "analysis failed", finishedAt: NOW });
    const second = await harness.service.failRun({
      runId: 1,
      errorMessage: "late failure",
      progress: { ...completion, summaryJson: null },
    });
    expect(second).toMatchObject({ transitioned: false, run: { status: "error", errorMessage: "analysis failed" } });
  });

  it("never downgrades an atomically successful PO run to error", async () => {
    const harness = buildHarness([runningRun({
      status: "success",
      finishedAt: new Date("2026-07-12T01:59:00.000Z"),
      leaseExpiresAt: null,
      posCreated: 1,
      linesAdded: 2,
    })]);

    const result = await harness.service.failRun({
      runId: 1,
      errorMessage: "late process failure",
      progress: { ...completion, summaryJson: null },
    });

    expect(result).toMatchObject({
      transitioned: false,
      run: { status: "success", posCreated: 1, linesAdded: 2, errorMessage: null },
    });
  });
});
