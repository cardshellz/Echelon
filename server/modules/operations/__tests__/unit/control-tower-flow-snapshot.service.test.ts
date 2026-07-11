import { beforeEach, describe, expect, it, vi } from "vitest";

const { getFlowWaterfall } = vi.hoisted(() => ({ getFlowWaterfall: vi.fn() }));

vi.mock("../../../oms/flow-waterfall.service", () => ({ getFlowWaterfall }));

import {
  getControlTowerFlowOverview,
  refreshControlTowerFlowSnapshotIfDue,
} from "../../control-tower-flow-snapshot.service";

function waterfall(generatedAt = "2026-07-11T12:00:01.000Z") {
  return {
    generatedAt,
    windowDays: 30,
    funnel: { entered: 100, reachedWms: 99, hasShipment: 98, shipped: 95, trackingConfirmed: 94 },
    channels: [],
    volumePerDay: [],
    wmsBuckets: [],
    eventSpine: [],
    intakeModel: [],
    duplicates: { omsToPicking: 0, overShippedItems: 0, unmappedEngineSplits: 0, blockedDupOrders: 0, sample: [] },
    deadLetterCauses: [],
    crossSystem: { wmsShippedOmsOpen: 1, omsNotUpdated: 1, sample: [] },
    sla: { breached: 2, sample: [] },
    issues: [],
    health: { generatedAt, status: "degraded", counts: { critical: 0, warning: 1, info: 0 } },
    channelWriteback: {},
  };
}

function fakeClient(row: Record<string, unknown> | null) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  return {
    statements,
    client: {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        statements.push({ text: text.replace(/\s+/g, " ").trim(), values });
        if (text.includes("SELECT") && text.includes("FROM operations.control_tower_flow_snapshots")) {
          return { rows: row ? [row] : [] };
        }
        return { rows: [] };
      }),
    },
  };
}

function sequence<T>(...values: T[]): () => T {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

describe("Control Tower flow snapshot", () => {
  beforeEach(() => {
    getFlowWaterfall.mockReset();
  });

  it("persists a successful snapshot without serving the live waterfall in the request path", async () => {
    const database = fakeClient(null);
    getFlowWaterfall.mockResolvedValue(waterfall());

    const result = await refreshControlTowerFlowSnapshotIfDue({
      client: database.client,
      db: {} as never,
      clock: sequence(new Date("2026-07-11T12:00:00.000Z"), new Date("2026-07-11T12:00:01.000Z")),
      monotonicNowMs: sequence(1_000, 2_000),
    });

    expect(result).toMatchObject({ outcome: "refreshed", durationMs: 1_000 });
    expect(getFlowWaterfall).toHaveBeenCalledTimes(1);
    expect(database.statements.some(({ text }) => text.startsWith("INSERT INTO operations.control_tower_flow_snapshots"))).toBe(true);
    const success = database.statements.find(({ text }) => text.startsWith("UPDATE operations.control_tower_flow_snapshots"));
    expect(success?.values[1]).toContain('"trackingConfirmed":94');
  });

  it("preserves the last good payload and records a failed refresh", async () => {
    const existing = {
      snapshot_key: "order-flow-30d",
      window_days: 30,
      status: "succeeded",
      payload: waterfall("2026-07-10T12:00:00.000Z"),
      started_at: "2026-07-10T11:59:59.000Z",
      generated_at: "2026-07-10T12:00:00.000Z",
      completed_at: "2026-07-10T12:00:01.000Z",
      duration_ms: 1_000,
      error_code: null,
      error_message: null,
      updated_at: "2026-07-10T12:00:01.000Z",
    };
    const database = fakeClient(existing);
    getFlowWaterfall.mockRejectedValue(Object.assign(new Error("statement timeout"), { code: "57014" }));

    const result = await refreshControlTowerFlowSnapshotIfDue({
      client: database.client,
      db: {} as never,
      clock: sequence(new Date("2026-07-11T12:00:00.000Z"), new Date("2026-07-11T12:00:02.000Z")),
      monotonicNowMs: sequence(2_000, 4_000),
    });

    expect(result).toMatchObject({
      outcome: "failed",
      generatedAt: "2026-07-10T12:00:00.000Z",
      errorCode: "57014",
      errorMessage: "statement timeout",
    });
    const failure = database.statements.at(-1);
    expect(failure?.text).toContain("status = 'failed'");
    expect(failure?.text).not.toContain("payload =");
  });

  it("reports an in-flight refresh as refreshing while serving the prior payload", async () => {
    const database = fakeClient({
      snapshot_key: "order-flow-30d",
      window_days: 30,
      status: "running",
      payload: waterfall("2026-07-11T11:58:00.000Z"),
      started_at: "2026-07-11T11:59:30.000Z",
      generated_at: "2026-07-11T11:58:00.000Z",
      completed_at: null,
      duration_ms: null,
      error_code: null,
      error_message: null,
      updated_at: "2026-07-11T11:59:30.000Z",
    });

    const result = await getControlTowerFlowOverview(database.client, new Date("2026-07-11T12:00:00.000Z"));
    expect(result).toMatchObject({ status: "refreshing", stale: false });
    expect(result.snapshot?.funnel.trackingConfirmed).toBe(94);
    expect(getFlowWaterfall).not.toHaveBeenCalled();
  });
});
