import { describe, expect, it } from "vitest";

import type { ControlTowerSourceAdapter, QueryClient } from "../../control-tower-v2.domain";
import { runControlTowerProjectionJob } from "../../control-tower-v2.job";

describe("Control Tower V2 projection job", () => {
  it("reports a source with invalid rows as failed in dry-run mode", async () => {
    const adapter: ControlTowerSourceAdapter<{ id: number }> = {
      name: "invalid_source",
      sourceNamespace: "test.invalid_source",
      sourceType: "test_finding",
      projectionVersion: 1,
      loadRows: async () => [{ id: 1 }],
      projectRow: () => {
        throw new Error("invalid source row");
      },
    };

    const result = await runControlTowerProjectionJob({
      client: { query: async () => ({ rows: [] }) } as QueryClient,
      execute: false,
      adapters: [adapter],
      clock: () => new Date("2026-07-10T12:00:00.000Z"),
    });

    expect(result.failedSources).toBe(1);
    expect(result.sources[0]).toMatchObject({
      sourceName: "invalid_source",
      status: "preview",
      completeScan: false,
      rowsFailed: 1,
    });
  });
});
