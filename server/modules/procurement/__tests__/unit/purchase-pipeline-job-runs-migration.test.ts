import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0595_purchase_pipeline_job_runs.sql"),
  "utf8",
);

describe("purchase pipeline job runs migration", () => {
  it("creates a constrained procurement-owned execution ledger", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS procurement.purchase_pipeline_job_runs");
    expect(migration).toContain("job_type IN ('recommendation_snapshot', 'forecast_evaluation')");
    expect(migration).toContain("status IN ('running', 'succeeded', 'failed', 'interrupted')");
    expect(migration).toContain("purchase_pipeline_job_runs_lifecycle_chk");
    expect(migration).toContain("purchase_pipeline_job_runs_success_result_chk");
    expect(migration).toContain("AND error_code IS NOT NULL");
    expect(migration).toContain("AND error_message IS NOT NULL");
    expect(migration).toContain("AND result_json IS NOT NULL");
  });

  it("enforces one running execution per job type and retains output linkage", () => {
    expect(migration).toContain("purchase_pipeline_job_runs_single_running_uidx");
    expect(migration).toContain("WHERE status = 'running'");
    expect(migration).toContain("REFERENCES procurement.purchase_recommendation_runs(id)");
  });
});
