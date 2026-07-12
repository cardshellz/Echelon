import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("automatic recommendation writer topology", () => {
  it("routes scheduled and direct runs through the atomic handoff service", () => {
    const job = source("server/jobs/auto-draft.job.ts");
    const routes = source("server/modules/procurement/purchasing-recommendation.routes.ts");

    expect(job).toContain("handoffService.createAutomaticHandoff");
    expect(job).not.toContain("bulkCreatePurchaseOrderLines");
    expect(job).not.toContain("purchasing.createPO");
    expect(job).not.toContain("storage.updatePurchaseOrder");
    expect(routes.match(/runAutoDraftJob\(/g)).toHaveLength(2);
    expect(routes).not.toContain("createPOFromReorder");
  });

  it("removes the legacy reorder writer from the purchasing service", () => {
    const purchasing = source("server/modules/procurement/purchasing.service.ts");
    expect(purchasing).not.toContain("createPOFromReorder");
  });
});
