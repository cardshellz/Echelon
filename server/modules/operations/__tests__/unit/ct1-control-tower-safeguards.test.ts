import express from "express";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../../infrastructure/scheduler-lock", () => ({ withAdvisoryLock: vi.fn() }));
vi.mock("../../../identity", () => ({ hasPermission: vi.fn(async () => true) }));
vi.mock("../../../../routes/middleware", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

import {
  executeObservationCleanup,
  OBSERVATION_CLEANUP_ADVISORY_LOCK_ID,
  type ObservationCleanupQueryClient,
} from "../../../../../scripts/cleanup-control-tower-observations";
import { withAdvisoryLock } from "../../../../infrastructure/scheduler-lock";
import { HistoricalShipStationContentsReviewServiceError } from "../../../shipping/historical-shipstation-contents.api";
import { decideHistoricalContentsReview } from "../../application/control-tower-historical-contents.actions";
import {
  controlTowerFingerprint,
  type ControlTowerSourceAdapter,
  type ProjectedControlTowerWorkItem,
  type QueryClient,
} from "../../domain/control-tower-v2.domain";
import {
  previewControlTowerSource,
  resolveControlTowerMaxSourcePages,
  resolveControlTowerSourceStatementTimeoutMs,
  runControlTowerSourceProjection,
} from "../../infrastructure/control-tower-v2.repository";
import { startControlTowerProjectionScheduler } from "../../application/control-tower-v2.scheduler";
import { registerOperationsControlTowerRoutes } from "../../interfaces/http/control-tower.routes";
import { ControlTowerActionError, executeOperationsControlTowerAction } from "../../application/control-tower.service";
import { spyLoggerJson } from "../../../../__tests__/helpers/logger-spy";

interface SimRow {
  id: number;
  keep: boolean;
  visibleInBaseCopy: boolean;
}

function createSimulatedCleanupDb(options: {
  initialRows: SimRow[];
  postCopyRows?: SimRow[];
  advisoryLockAcquired?: boolean;
  forceVerificationMismatch?: boolean;
}) {
  let liveTable = options.initialRows.map((row) => ({ ...row }));
  let cloneTable: SimRow[] = [];
  let legacyTable: SimRow[] = [];
  let baseCopyCompleted = false;
  const statements: string[] = [];

  const client: ObservationCleanupQueryClient = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      statements.push(normalized);

      if (normalized.startsWith("SELECT count(*)::bigint AS total")) {
        const visible = liveTable.filter((row) => baseCopyCompleted || row.visibleInBaseCopy);
        const keep = visible.filter((row) => row.keep).length;
        const maxId = visible.reduce((max, row) => Math.max(max, row.id), 0);
        return {
          rows: [{ total: String(visible.length), keep: String(keep), max_id: String(maxId), size: "10 MB" }],
        };
      }

      if (normalized.startsWith("SELECT pg_try_advisory_lock")) {
        expect(values[0]).toBe(OBSERVATION_CLEANUP_ADVISORY_LOCK_ID);
        return { rows: [{ acquired: options.advisoryLockAcquired ?? true }] };
      }

      if (normalized.startsWith("SELECT pg_advisory_unlock")) {
        expect(values[0]).toBe(OBSERVATION_CLEANUP_ADVISORY_LOCK_ID);
        return { rows: [{ pg_advisory_unlock: true }] };
      }

      if (normalized.startsWith("CREATE TABLE operations.control_tower_observations_clean")) {
        cloneTable = [];
        return { rows: [] };
      }

      if (
        normalized.startsWith("INSERT INTO operations.control_tower_observations_clean OVERRIDING SYSTEM VALUE SELECT * FROM operations.control_tower_observations WHERE")
        && normalized.includes("AND id <= $1")
      ) {
        const watermark = Number(values[0]);
        const copied = liveTable.filter((row) => row.visibleInBaseCopy && row.keep && row.id <= watermark);
        cloneTable.push(...copied.map((row) => ({ ...row })));
        // Simulate in-flight pre-watermark rows committing + post-watermark inserts arriving right after base copy.
        baseCopyCompleted = true;
        for (const row of liveTable) row.visibleInBaseCopy = true;
        if (options.postCopyRows) {
          liveTable.push(...options.postCopyRows.map((row) => ({ ...row, visibleInBaseCopy: true })));
        }
        return { rows: [], rowCount: copied.length };
      }

      if (
        normalized.startsWith("INSERT INTO operations.control_tower_observations_clean OVERRIDING SYSTEM VALUE SELECT * FROM operations.control_tower_observations WHERE id > $1")
      ) {
        const watermark = Number(values[0]);
        const existingIds = new Set(cloneTable.map((row) => row.id));
        const delta = liveTable.filter((row) => row.id > watermark && row.keep && !existingIds.has(row.id));
        cloneTable.push(...delta.map((row) => ({ ...row })));
        return { rows: [], rowCount: delta.length };
      }

      if (
        normalized.startsWith("INSERT INTO operations.control_tower_observations_clean OVERRIDING SYSTEM VALUE SELECT source_row.* FROM operations.control_tower_observations AS source_row")
      ) {
        const lowerFloor = Number(values[0]);
        const watermark = Number(values[1]);
        const existingIds = new Set(cloneTable.map((row) => row.id));
        const gap = liveTable.filter(
          (row) => row.id > lowerFloor && row.id <= watermark && row.keep && !existingIds.has(row.id),
        );
        cloneTable.push(...gap.map((row) => ({ ...row })));
        return { rows: [], rowCount: gap.length };
      }

      if (normalized === "SELECT COALESCE(max(id), 0)::bigint AS max_id FROM operations.control_tower_observations") {
        const maxId = liveTable.reduce((max, row) => Math.max(max, row.id), 0);
        return { rows: [{ max_id: String(maxId) }] };
      }

      if (normalized === "ALTER TABLE operations.control_tower_observations RENAME TO control_tower_observations_legacy") {
        legacyTable = liveTable;
        return { rows: [] };
      }

      if (normalized === "ALTER TABLE operations.control_tower_observations_clean RENAME TO control_tower_observations") {
        liveTable = cloneTable;
        return { rows: [] };
      }

      if (normalized.startsWith("SELECT count(*) FILTER (WHERE") && normalized.endsWith("FROM operations.control_tower_observations_legacy")) {
        const keep = legacyTable.filter((row) => row.keep).length;
        return { rows: [{ keep: String(keep) }] };
      }

      if (normalized.startsWith("SELECT count(*) FILTER (WHERE id <= $1") && normalized.endsWith("FROM operations.control_tower_observations")) {
        if (options.forceVerificationMismatch) {
          return { rows: [{ keep: "0" }] };
        }
        const swapMaxId = Number(values[0]);
        const keep = liveTable.filter((row) => row.id <= swapMaxId && row.keep).length;
        return { rows: [{ keep: String(keep) }] };
      }

      if (
        normalized.startsWith("INSERT INTO operations.control_tower_observations OVERRIDING SYSTEM VALUE SELECT legacy_row.* FROM operations.control_tower_observations_legacy")
      ) {
        if (options.forceVerificationMismatch) {
          return { rows: [], rowCount: 0 };
        }
        const existingIds = new Set(liveTable.map((row) => row.id));
        const missing = legacyTable.filter((row) => row.keep && !existingIds.has(row.id));
        liveTable.push(...missing.map((row) => ({ ...row })));
        return { rows: [], rowCount: missing.length };
      }

      if (normalized.startsWith("SELECT indexname, indexdef FROM pg_indexes")) {
        return { rows: [] };
      }

      if (normalized.startsWith("SELECT pg_size_pretty(pg_database_size")) {
        return { rows: [{ db: "100 MB" }] };
      }

      return { rows: [], rowCount: 0 };
    }),
  };

  return {
    client,
    statements,
    getLiveKeeperIds: () => liveTable.filter((row) => row.keep).map((row) => row.id).sort((a, b) => a - b),
  };
}

function projectedItem(sourceKey: string): ProjectedControlTowerWorkItem {
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

function fakeProjectionClient() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }] };
    if (sql.includes("FILTER (WHERE existing.id IS NULL)")) {
      return { rows: [{ created: "1", updated: "0" }] };
    }
    if (sql.includes("FROM control_tower_projection_resolved") && sql.includes("COUNT(*)")) {
      return { rows: [{ count: "2" }] };
    }
    return { rows: [] };
  });
  return { client: { query } as unknown as QueryClient, statements };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(withAdvisoryLock).mockReset();
});

describe("CT-1 Control Tower Safeguards & Residual Closure", () => {
  describe("PWF-02: Observation cleanup watermark gap & maintenance lock", () => {
    it("preserves late-committing pre-watermark keeper rows (id=99 < maxId=100) inside the bounded swap", async () => {
      const noiseRows: SimRow[] = Array.from({ length: 20 }, (_, idx) => ({
        id: idx + 1,
        keep: false,
        visibleInBaseCopy: true,
      }));
      const sim = createSimulatedCleanupDb({
        initialRows: [
          ...noiseRows,
          { id: 50, keep: true, visibleInBaseCopy: true },
          // Allocated sequence id=99 before survey(maxId=100), but uncommitted during Step [2/5]
          { id: 99, keep: true, visibleInBaseCopy: false },
          { id: 100, keep: true, visibleInBaseCopy: true },
        ],
        postCopyRows: [
          { id: 101, keep: true, visibleInBaseCopy: true },
        ],
      });

      const result = await executeObservationCleanup(
        sim.client,
        { execute: true, keepLegacy: false, force: false },
        { log: () => undefined, lookbackIds: 50 },
      );

      expect(result).toMatchObject({
        mode: "rebuilt",
        beforeKeep: 2,
        swapMaxId: 101,
        legacyKeep: 4,
        liveKeepAtSwap: 4,
        reconciledPostSwapRows: 0,
      });
      expect(sim.getLiveKeeperIds()).toEqual([50, 99, 100, 101]);
      expect(sim.statements).toContain("SET LOCAL lock_timeout = '15s'");
      expect(sim.statements).toContain("DROP TABLE operations.control_tower_observations_legacy");
      expect(sim.statements.at(-1)).toBe("SELECT pg_advisory_unlock($1)");
    });

    it("reconciles ultra-old straggler keeper rows outside lookbackIds from frozen LEGACY before drop", async () => {
      const noiseRows: SimRow[] = Array.from({ length: 20 }, (_, idx) => ({
        id: idx + 10,
        keep: false,
        visibleInBaseCopy: true,
      }));
      const sim = createSimulatedCleanupDb({
        initialRows: [
          // id=5 is older than maxId(100) - lookbackIds(10) = 90
          { id: 5, keep: true, visibleInBaseCopy: false },
          ...noiseRows,
          { id: 100, keep: true, visibleInBaseCopy: true },
        ],
      });

      const result = await executeObservationCleanup(
        sim.client,
        { execute: true, keepLegacy: false, force: false },
        { log: () => undefined, lookbackIds: 10 },
      );

      expect(result).toMatchObject({
        mode: "rebuilt",
        legacyKeep: 2,
        liveKeepAtSwap: 2,
        reconciledPostSwapRows: 1,
      });
      expect(sim.getLiveKeeperIds()).toEqual([5, 100]);
    });

    it("fails closed when singleton advisory lock is held or verification mismatches, preserving LEGACY", async () => {
      const lockedSim = createSimulatedCleanupDb({
        initialRows: [
          ...Array.from({ length: 10 }, (_, idx) => ({ id: idx + 1, keep: false, visibleInBaseCopy: true })),
          { id: 100, keep: true, visibleInBaseCopy: true },
        ],
        advisoryLockAcquired: false,
      });
      await expect(
        executeObservationCleanup(lockedSim.client, { execute: true, keepLegacy: false, force: false }, { log: () => undefined }),
      ).rejects.toThrow("Another control_tower_observations cleanup is already running");
      expect(lockedSim.statements.some((s) => s.includes("CREATE TABLE"))).toBe(false);

      const mismatchSim = createSimulatedCleanupDb({
        initialRows: [
          ...Array.from({ length: 10 }, (_, idx) => ({ id: idx + 1, keep: false, visibleInBaseCopy: true })),
          { id: 100, keep: true, visibleInBaseCopy: true },
        ],
        forceVerificationMismatch: true,
      });
      await expect(
        executeObservationCleanup(mismatchSim.client, { execute: true, keepLegacy: false, force: false }, { log: () => undefined }),
      ).rejects.toThrow("Verification failed: keeper rows mismatch against frozen legacy table");
      expect(mismatchSim.statements).not.toContain("DROP TABLE operations.control_tower_observations_legacy");
      expect(mismatchSim.statements.at(-1)).toBe("SELECT pg_advisory_unlock($1)");
    });
  });

  describe("PWF-03 & PLAT-12: Bounded source statement_timeout and maxPages budget", () => {
    it("validates maxPages and statementTimeoutMs bounds", () => {
      expect(resolveControlTowerMaxSourcePages(undefined)).toBe(200);
      expect(resolveControlTowerMaxSourcePages("50")).toBe(50);
      expect(() => resolveControlTowerMaxSourcePages("0")).toThrow();
      expect(() => resolveControlTowerMaxSourcePages("2001")).toThrow();

      expect(resolveControlTowerSourceStatementTimeoutMs(undefined)).toBe(30_000);
      expect(resolveControlTowerSourceStatementTimeoutMs("15000")).toBe(15_000);
      expect(() => resolveControlTowerSourceStatementTimeoutMs("4999")).toThrow();
      expect(() => resolveControlTowerSourceStatementTimeoutMs("120001")).toThrow();
    });

    it("stops scanning at maxPages, marks run partial (SOURCE_SCAN_BUDGET_EXCEEDED), and preserves unseen items", async () => {
      const db = fakeProjectionClient();
      const loadPage = vi.fn(async (_client, _now, page: { cursor: string | null; limit: number }) => {
        const nextId = page.cursor === null ? 1 : Number(page.cursor) + 1;
        return {
          rows: [{ id: String(nextId) }],
          nextCursor: String(nextId),
        };
      });
      const adapter: ControlTowerSourceAdapter<{ id: string }> = {
        name: "bounded_source",
        sourceNamespace: "test.source",
        sourceType: "test_finding",
        projectionVersion: 1,
        loadPage,
        projectRow: (row) => projectedItem(row.id),
      };

      const result = await runControlTowerSourceProjection({
        client: db.client,
        adapter,
        pageSize: 1,
        maxPages: 2,
        statementTimeoutMs: 12_000,
        idGenerator: () => "00000000-0000-0000-0000-000000000099",
        clock: () => new Date("2026-07-10T12:00:00.000Z"),
      });

      expect(loadPage).toHaveBeenCalledTimes(2);
      expect(result.status).toBe("partial");
      expect(result.completeScan).toBe(false);
      expect(result.rowsScanned).toBe(2);
      expect(result.rowsResolved).toBe(0);
      expect(db.statements.some(({ sql }) => sql === "SET LOCAL statement_timeout = '12000ms'")).toBe(true);
      expect(db.statements.some(({ sql }) => sql.includes("control_tower_projection_resolved"))).toBe(false);
      expect(
        db.statements.some(
          ({ sql, values }) =>
            sql.startsWith("UPDATE operations.control_tower_source_runs")
            && values[1] === "partial"
            && values[11] === "SOURCE_SCAN_BUDGET_EXCEEDED",
        ),
      ).toBe(true);
    });

    it("runs dry-run preview inside a READ ONLY repeatable-read transaction with statement_timeout", async () => {
      const db = fakeProjectionClient();
      const adapter: ControlTowerSourceAdapter<{ id: string }> = {
        name: "preview_source",
        sourceNamespace: "test.source",
        sourceType: "test_finding",
        projectionVersion: 1,
        loadPage: async () => ({ rows: [{ id: "1" }], nextCursor: null }),
        projectRow: (row) => projectedItem(row.id),
      };

      const summary = await previewControlTowerSource({
        client: db.client,
        adapter,
        statementTimeoutMs: 10_000,
      });

      expect(summary.completeScan).toBe(true);
      expect(db.statements.map((s) => s.sql)).toEqual([
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        "SET LOCAL statement_timeout = '10000ms'",
        "COMMIT",
      ]);
    });
  });

  describe("PW-10: Singleton & non-overlapping projection scheduler", () => {
    it("reuses active scheduler handle on duplicate start and skips overlapping ticks while inFlight", async () => {
      vi.useFakeTimers();
      spyLoggerJson("log");
      const warn = spyLoggerJson("warn");

      let resolveFirstRun!: () => void;
      const runMock = vi.mocked(withAdvisoryLock)
        .mockImplementationOnce(
          () => new Promise<null>((resolve) => {
            resolveFirstRun = () => resolve(null);
          }),
        )
        .mockResolvedValue(null);

      const handleA = startControlTowerProjectionScheduler({
        environment: { CONTROL_TOWER_PROJECTOR_INTERVAL_MS: "60000" },
      });
      const handleB = startControlTowerProjectionScheduler({
        environment: { CONTROL_TOWER_PROJECTOR_INTERVAL_MS: "60000" },
      });
      expect(handleB).toBe(handleA);

      // Initial phase delay for 60s interval is 30s
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runMock).toHaveBeenCalledTimes(1);

      // Next interval fires at +60s while first run is still inFlight -> skipped!
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runMock).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("skipping overlapping tick"),
      );

      // Complete first run -> subsequent interval runs normally
      resolveFirstRun();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runMock).toHaveBeenCalledTimes(2);

      handleA.stop();
    });
  });

  describe("PWF-04: Historical package-content wms_confirmed post-commit enqueue recovery", () => {
    it("classifies post-commit enqueue failure as 503 and allows idempotent wms_confirmed replay after item is projected resolved", async () => {
      spyLoggerJson("error");
      let workItemResolved = false;
      let workItemVersion = 3;
      const pool = {
        query: vi.fn(async (statement: string) => {
          if (statement.includes("control_tower_work_items")) {
            return {
              rows: [{
                source_namespace: "wms.reconciliation_exceptions",
                source_type: "reconciliation_exception",
                source_key: "501",
                code: "historical_shipstation_contents_review",
                row_version: workItemVersion,
                source_status: workItemResolved ? "resolved" : "open",
              }],
            };
          }
          return { rows: [{ provider_order_id: "78002", current_authoritative: true }] };
        }),
      } as unknown as Pool;

      const decide = vi.fn(async () => ({
        kind: workItemResolved ? "replayed" : "created",
        exceptionId: "501",
        shippingProviderLabelId: "41",
      }));
      const enqueueReprocess = vi.fn()
        .mockRejectedValueOnce(new Error("transient queue timeout"))
        .mockResolvedValueOnce(undefined);

      // 1st attempt: decision commits in shipping, enqueue fails -> classified 503
      await expect(decideHistoricalContentsReview({
        pool,
        workItemId: 71,
        version: 3,
        actorUserId: "lead-1",
        expectedPreviewEvidenceHash: "a".repeat(64),
        decision: "wms_confirmed",
        reason: "WMS packing record verified.",
        reviewService: { preview: vi.fn(), decide },
        enqueueReprocess,
      })).rejects.toMatchObject({
        statusCode: 503,
        code: "HISTORICAL_CONTENTS_REPROCESS_ENQUEUE_FAILED",
      });

      // Projector marks the Control Tower item resolved before the operator retries
      workItemResolved = true;
      workItemVersion = 4;

      // 2nd attempt: exact wms_confirmed replay succeeds even though source_status === 'resolved'
      await expect(decideHistoricalContentsReview({
        pool,
        workItemId: 71,
        version: 4,
        actorUserId: "lead-1",
        expectedPreviewEvidenceHash: "a".repeat(64),
        decision: "wms_confirmed",
        reason: "WMS packing record verified.",
        reviewService: { preview: vi.fn(), decide },
        enqueueReprocess,
      })).resolves.toMatchObject({
        kind: "replayed",
        exceptionId: "501",
        shippingProviderLabelId: "41",
      });
      expect(enqueueReprocess).toHaveBeenCalledTimes(2);
      expect(enqueueReprocess).toHaveBeenLastCalledWith("78002");

      // Non-wms_confirmed or unmatched resolved items still return 409 WORK_ITEM_RESOLVED
      await expect(decideHistoricalContentsReview({
        pool,
        workItemId: 71,
        version: 4,
        actorUserId: "lead-1",
        expectedPreviewEvidenceHash: "a".repeat(64),
        decision: "cannot_prove",
        reason: "Attempted change after resolution.",
        reviewService: { preview: vi.fn(), decide },
      })).rejects.toMatchObject({
        statusCode: 409,
        code: "WORK_ITEM_RESOLVED",
      });

      const unmatchedDecide = vi.fn(async () => {
        throw new HistoricalShipStationContentsReviewServiceError(
          "REVIEW_NOT_FOUND",
          "Historical contents review is no longer open",
        );
      });
      await expect(decideHistoricalContentsReview({
        pool,
        workItemId: 71,
        version: 4,
        actorUserId: "lead-2",
        expectedPreviewEvidenceHash: "b".repeat(64),
        decision: "wms_confirmed",
        reason: "Different actor/hash on already resolved item.",
        reviewService: { preview: vi.fn(), decide: unmatchedDecide },
      })).rejects.toMatchObject({
        statusCode: 409,
        code: "WORK_ITEM_RESOLVED",
      });
    });
  });

  describe("Legacy Control Tower action classification & route sanitization", () => {
    it("classifies action validation errors with ControlTowerActionError and sanitizes unexpected route errors to 500", async () => {
      spyLoggerJson("error");

      await expect(executeOperationsControlTowerAction({
        deps: { db: { execute: vi.fn(async () => ({ rows: [] })) } },
        id: "wms:missing:1",
        actionId: "execute",
        operator: "ops-user",
        detail: undefined,
      })).rejects.toBeInstanceOf(ControlTowerActionError);

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).session = { user: { id: "user-1", username: "ops" } };
        next();
      });
      (app.locals as any).services = {
        operationsDashboard: {
          getPickReplenHealth: vi.fn(async () => ({
            total: 1,
            items: [{
              id: "7",
              type: "pick_bin_needs_replen",
              priority: 1,
              sku: "SKU-1",
              detail: "Needs replen",
              action: "queue_replen",
              variantId: 10,
              locationId: 11,
            }],
          })),
        },
        replenishment: {
          queueMissingPickBinReplen: vi.fn(async () => {
            throw new Error("SELECT * FROM secret_internal_relation syntax error");
          }),
          cleanupHealthIssues: vi.fn(),
        },
      };
      registerOperationsControlTowerRoutes(app);

      const server = app.listen(0);
      try {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;

        const overlongRes = await fetch(
          `http://127.0.0.1:${port}/api/operations/control-tower/${"x".repeat(201)}/actions/execute`,
          { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        );
        expect(overlongRes.status).toBe(400);

        const internalErrRes = await fetch(
          `http://127.0.0.1:${port}/api/operations/control-tower/wms:pick_bin_needs_replen:7/actions/execute`,
          { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        );
        expect(internalErrRes.status).toBe(500);
        const body = await internalErrRes.json();
        expect(body).toEqual({
          error: "Failed to execute control tower action",
          code: "CONTROL_TOWER_ACTION_INTERNAL_ERROR",
        });
      } finally {
        server.close();
      }
    });
  });
});
