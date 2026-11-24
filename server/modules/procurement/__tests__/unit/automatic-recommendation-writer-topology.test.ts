import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

function purchasingServiceSource(): string {
  const subDir = join(process.cwd(), "server/modules/procurement/purchasing");
  const subFiles = existsSync(subDir)
    ? readdirSync(subDir)
        .filter((name) => name.endsWith(".ts"))
        .sort()
        .map((name) => readFileSync(join(subDir, name), "utf8"))
    : [];
  return [source("server/modules/procurement/application/purchasing.service.ts"), ...subFiles].join("\n");
}

describe("automatic recommendation writer topology", () => {
  it("routes scheduled and direct runs through the atomic handoff service", () => {
    const job = source("server/jobs/auto-draft.job.ts");
    const routes = source("server/modules/procurement/interfaces/http/purchasing-recommendation.routes.ts");

    expect(job).toContain("handoffService.createAutomaticHandoff");
    expect(job).not.toContain("bulkCreatePurchaseOrderLines");
    expect(job).not.toContain("purchasing.createPO");
    expect(job).not.toContain("storage.updatePurchaseOrder");
    expect(routes.match(/runAutoDraftJob\(/g)).toHaveLength(1);
    expect(routes.match(/startAutoDraftJob\(/g)).toHaveLength(1);
    expect(routes).not.toContain("createPOFromReorder");
  });

  it("removes the legacy reorder writer from the purchasing service", () => {
    const purchasing = purchasingServiceSource();
    expect(purchasing).not.toContain("createPOFromReorder");
  });
});
