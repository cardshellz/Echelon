import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const jobSource = readFileSync(
  resolve(process.cwd(), "server/jobs/purchase-recommendation-snapshot.job.ts"),
  "utf8",
);
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
const procfile = readFileSync(resolve(process.cwd(), "Procfile"), "utf8");

describe("purchase recommendation snapshot scheduler contract", () => {
  it("exposes scheduler commands that collect observations before evaluating them", () => {
    expect(packageJson.scripts["procurement:snapshot-recommendations"])
      .toBe("tsx server/jobs/run-purchase-recommendation-snapshot.ts");
    expect(procfile).toContain("recommendations: npm run procurement:snapshot-recommendations");
    expect(procfile).toContain("forecast-evaluations: npm run procurement:evaluate-forecasts");
  });

  it("cannot import RFQ or PO mutation services", () => {
    expect(jobSource).toContain("createPurchaseRecommendationSnapshotService");
    expect(jobSource).not.toContain("automatic-rfq-draft.service");
    expect(jobSource).not.toContain("recommendation-po-handoff.service");
    expect(jobSource).not.toContain("purchasing.service");
  });
});
