import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runners = [
  ["dropship-ebay-order-intake-runner.ts", "ebayOrderIntake"],
  ["dropship-listing-push-job-runner.ts", "listingPush"],
  ["dropship-order-processing-runner.ts", "orderProcessing"],
  ["dropship-return-intake-runner.ts", "returnIntake"],
  ["dropship-returns-maintenance-runner.ts", "returnsMaintenance"],
] as const;

describe("dropship worker runner scheduling", () => {
  it.each(runners)("uses shared non-overlapping scheduling for %s", (file, scheduleName) => {
    const source = readFileSync(resolve(
      process.cwd(),
      "server/modules/dropship/infrastructure",
      file,
    ), "utf8");

    expect(source).toContain("startDropshipWorkerSchedule({");
    expect(source).toContain(`name: "${scheduleName}"`);
    expect(source).toContain("schedulingMode: \"completion_delayed_non_overlapping\"");
    expect(source).toContain("buildSchedulerFailureContext(error)");
    expect(source).not.toContain("setTimeout(runLockedSweep");
    expect(source).not.toContain("setInterval(runLockedSweep");
  });
});
