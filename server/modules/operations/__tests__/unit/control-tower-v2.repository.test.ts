import { describe, expect, it, vi } from "vitest";

import {
  controlTowerFingerprint,
  type ControlTowerSourceAdapter,
  type ProjectedControlTowerWorkItem,
  type QueryClient,
} from "../../control-tower-v2.domain";
import { runControlTowerSourceProjection } from "../../control-tower-v2.repository";

function item(sourceKey: string): ProjectedControlTowerWorkItem {
  const base = {
    sourceNamespace: "test.source",
    sourceType: "test_finding",
    sourceKey,
    projectionVersion: 1,
    domain: "wms" as const,
    code: "test_finding",
    entityType: "wms_order",
    entityId: sourceKey,
    entityRef: `Order ${sourceKey}`,
    correlationId: null,
    rootCauseGroupKey: "test:test_finding",
    title: "Test finding",
    summary: "Test finding summary",
    expectedState: "Expected state",
    actualState: "Actual state",
    severity: "high" as const,
    urgency: "normal" as const,
    impactTags: ["order_flow"],
    actionability: "investigate" as const,
    sourceStatus: "open" as const,
    ownerTeam: "Warehouse",
    recommendedAction: "Investigate",
    responseDueAt: null,
    firstSeenAt: "2026-07-10T12:00:00.000Z",
    lastSeenAt: "2026-07-10T12:00:00.000Z",
    lastChangedAt: "2026-07-10T12:00:00.000Z",
    occurrenceCount: 1,
    recurrenceCount: 0,
    worsenedCount: 0,
    evidenceSummary: { id: sourceKey },
    detailLocator: {},
    availableActions: [],
    sourceUpdatedAt: "2026-07-10T12:00:00.000Z",
    observedMetric: "1",
  };
  return { ...base, sourceFingerprint: controlTowerFingerprint(base) };
}

function fakeClient(resolvedCount = 0) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }] };
    if (sql.includes("FILTER (WHERE existing.id IS NULL)")) {
      return { rows: [{ created: "1", updated: "0" }] };
    }
    if (sql.includes("FROM control_tower_projection_resolved") && sql.includes("COUNT(*)")) {
      return { rows: [{ count: String(resolvedCount) }] };
    }
    return { rows: [] };
  });
  return { client: { query } as unknown as QueryClient, query, statements };
}

function clock(...values: string[]) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}

describe("Control Tower V2 projection persistence", () => {
  it("does not resolve absent work when any source row is invalid", async () => {
    const db = fakeClient();
    const adapter: ControlTowerSourceAdapter<{ id: string; valid: boolean }> = {
      name: "test_source",
      sourceNamespace: "test.source",
      sourceType: "test_finding",
      projectionVersion: 1,
      loadRows: async () => [{ id: "1", valid: true }, { id: "2", valid: false }],
      projectRow: (row) => {
        if (!row.valid) throw new Error("invalid row");
        return item(row.id);
      },
    };

    const result = await runControlTowerSourceProjection({
      client: db.client,
      adapter,
      idGenerator: () => "00000000-0000-0000-0000-000000000001",
      clock: clock(
        "2026-07-10T12:00:00.000Z",
        "2026-07-10T12:00:01.000Z",
        "2026-07-10T12:00:02.000Z",
      ),
    });

    expect(result.status).toBe("partial");
    expect(result.completeScan).toBe(false);
    expect(result.rowsFailed).toBe(1);
    expect(db.statements.some(({ sql }) => sql.includes("control_tower_projection_resolved"))).toBe(false);
    expect(db.statements.some(({ sql, values }) => sql.startsWith("UPDATE operations.control_tower_source_runs") && values[1] === "partial")).toBe(true);
  });

  it("resolves absent items only after a complete source scan", async () => {
    const db = fakeClient(3);
    const adapter: ControlTowerSourceAdapter<Record<string, never>> = {
      name: "test_source",
      sourceNamespace: "test.source",
      sourceType: "test_finding",
      projectionVersion: 1,
      loadRows: async () => [],
      projectRow: () => {
        throw new Error("no rows expected");
      },
    };

    const result = await runControlTowerSourceProjection({
      client: db.client,
      adapter,
      idGenerator: () => "00000000-0000-0000-0000-000000000002",
      clock: clock(
        "2026-07-10T12:00:00.000Z",
        "2026-07-10T12:00:01.000Z",
        "2026-07-10T12:00:02.000Z",
      ),
    });

    expect(result.status).toBe("succeeded");
    expect(result.completeScan).toBe(true);
    expect(result.rowsResolved).toBe(3);
    expect(db.statements.some(({ sql }) => sql.startsWith("CREATE TEMP TABLE control_tower_projection_resolved"))).toBe(true);
  });

  it("rolls back projection writes and marks the durable run failed", async () => {
    const db = fakeClient();
    const adapter: ControlTowerSourceAdapter<Record<string, never>> = {
      name: "test_source",
      sourceNamespace: "test.source",
      sourceType: "test_finding",
      projectionVersion: 1,
      loadRows: async () => {
        throw new Error("source unavailable");
      },
      projectRow: () => {
        throw new Error("not reached");
      },
    };

    await expect(runControlTowerSourceProjection({
      client: db.client,
      adapter,
      idGenerator: () => "00000000-0000-0000-0000-000000000003",
      clock: clock("2026-07-10T12:00:00.000Z", "2026-07-10T12:00:01.000Z"),
    })).rejects.toThrow("source unavailable");

    expect(db.statements.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
    expect(db.statements.some(({ sql, values }) => sql.startsWith("UPDATE operations.control_tower_source_runs") && values[1] === "failed")).toBe(true);
  });
});
