import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("dropship eBay order-intake runner", () => {
  it("checks the previous heartbeat before polling can record a new success", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      "server/modules/dropship/infrastructure/dropship-ebay-order-intake-runner.ts",
    ), "utf8");
    const cycleStart = source.indexOf("const runLockedSweep = async () => {");
    const cycleEnd = source.indexOf("setTimeout(runLockedSweep", cycleStart);

    expect(cycleStart).toBeGreaterThanOrEqual(0);
    expect(cycleEnd).toBeGreaterThan(cycleStart);

    const cycleSource = source.slice(cycleStart, cycleEnd);
    const healthMonitorCall = cycleSource.indexOf("runDropshipEbayOrderIntakeHealthMonitor()");
    const pollCall = cycleSource.indexOf("runDropshipEbayOrderIntakeSweep()");

    expect(healthMonitorCall).toBeGreaterThanOrEqual(0);
    expect(pollCall).toBeGreaterThan(healthMonitorCall);
  });
});
