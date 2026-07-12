import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "migrations", "133_auto_draft_run_lifecycle.sql"),
  "utf8",
);

describe("auto-draft run lifecycle migration", () => {
  it("adds lease ownership and one-running-run enforcement", () => {
    expect(migration).toContain("heartbeat_at TIMESTAMP");
    expect(migration).toContain("lease_expires_at TIMESTAMP");
    expect(migration).toContain("auto_draft_runs_single_running_uidx");
    expect(migration).toContain("WHERE status = 'running'");
  });

  it("repairs duplicate running rows before creating the unique index", () => {
    const repairPosition = migration.indexOf("WITH ranked_running AS");
    const indexPosition = migration.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS auto_draft_runs_single_running_uidx");
    expect(repairPosition).toBeGreaterThanOrEqual(0);
    expect(indexPosition).toBeGreaterThan(repairPosition);
    expect(migration).toContain("ranked.run_rank > 1");
    expect(migration).toContain("status = 'interrupted'");
  });

  it("enforces terminal timestamps and clears terminal leases", () => {
    expect(migration).toContain("auto_draft_runs_status_chk");
    expect(migration).toContain("auto_draft_runs_lifecycle_chk");
    expect(migration).toContain("status <> 'running'");
    expect(migration).toContain("finished_at IS NOT NULL");
    expect(migration).toContain("lease_expires_at IS NULL");
  });
});
