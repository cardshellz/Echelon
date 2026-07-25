import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("purchase pipeline job run writer topology", () => {
  it("routes both scheduled jobs through the lifecycle service", () => {
    for (const path of [
      "server/jobs/purchase-recommendation-snapshot.job.ts",
      "server/jobs/purchase-forecast-backtesting.job.ts",
    ]) {
      const job = source(path);
      expect(job).toContain("jobLifecycle.startRun(");
      expect(job).toContain("jobLifecycle.heartbeatRun(");
      expect(job).toContain("jobLifecycle.completeRun(");
      expect(job).toContain("jobLifecycle.failRun(");
      expect(job).not.toContain("purchasePipelineJobRuns");
    }
  });

  it("keeps writes in the procurement lifecycle repository", () => {
    const repository = source(
      "server/modules/procurement/purchase-pipeline-job-run-lifecycle.repository.ts",
    );
    expect(repository).toContain("pg_advisory_xact_lock");
    expect(repository).toContain('.for("update")');
    expect(repository).toContain("purchasePipelineJobRuns");
    expect(repository).toContain('eq(purchasePipelineJobRuns.status, "running")');
  });
});
