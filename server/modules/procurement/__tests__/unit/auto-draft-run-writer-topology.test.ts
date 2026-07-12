import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("auto-draft run writer topology", () => {
  it("keeps generic procurement storage read-only for run history", () => {
    const storage = source("server/modules/procurement/procurement.storage.ts");
    expect(storage).not.toContain("createAutoDraftRun(");
    expect(storage).not.toContain("updateAutoDraftRun(");
  });

  it("routes run ownership through the lifecycle service", () => {
    const job = source("server/jobs/auto-draft.job.ts");
    expect(job).toContain("lifecycle.startRun(");
    expect(job).toContain("lifecycle.heartbeatRun(");
    expect(job).toContain("lifecycle.completeRun(");
    expect(job).toContain("lifecycle.failRun(");
    expect(job).not.toContain("db.insert(autoDraftRuns)");
    expect(job).not.toContain("db.update(autoDraftRuns)");
  });

  it("serializes claims and locks run rows before state transitions", () => {
    const repository = source("server/modules/procurement/auto-draft-run-lifecycle.repository.ts");
    expect(repository).toContain("pg_advisory_xact_lock");
    expect(repository).toContain('.for("update")');
    expect(repository).toContain('eq(autoDraftRuns.status, "running")');
  });

  it("finishes mutating runs inside the automatic handoff transaction", () => {
    const handoff = source("server/modules/procurement/recommendation-po-handoff.service.ts");
    expect(handoff).toContain("await completeAutomaticRun(unitOfWork, parsed, persisted, skipped, now)");
  });
});
