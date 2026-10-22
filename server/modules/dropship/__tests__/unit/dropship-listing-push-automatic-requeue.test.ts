import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  AUTOMATIC_REQUEUE_ACTOR,
  AUTOMATIC_REQUEUE_BATCH_SIZE,
  AUTOMATIC_REQUEUE_CODES,
  AUTOMATIC_RESEND_STORE_LIMIT,
  STOCK_LINK_AWARE_FAILURE_FIELD,
  STOCK_LINK_RESEND_CODE,
  automaticRequeueCap,
  automaticRequeueDueAt,
  automaticRequeuePolicyRows,
  isAutomaticRequeueCode,
  isRecordedWithAutomaticStockLink,
  mayRequeueAutomatically,
} from "../../domain/listing-push-automatic-requeue";
import {
  DropshipListingPushRecoveryService,
  type DropshipStockLinkRequeuePort,
  type StockLinkRequeueResult,
} from "../../application/dropship-listing-push-recovery-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  PgDropshipListingPushOpsRepository,
  readAutomaticRequeuePendingItemIds,
  type DropshipStockDestinationReader,
} from "../../infrastructure/dropship-listing-push-ops.repository";
import {
  STOCK_DESTINATION_READ_BACKOFF_MS,
  STOCK_DESTINATION_RECHECK_MS,
  STOCK_LINK_RESEND_DEFERRABLE_REASONS,
  STOCK_LINK_RESEND_RECHECK_MS,
  StockLinkResendSchedule,
} from "../../domain/stock-link-resend-schedule";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDropshipListingPushRecoveryFromEnv } from "../../infrastructure/dropship-listing-push-recovery.factory";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const FAILED_AT = new Date("2026-10-21T12:00:00.000Z");
const MINUTE = 60_000;

describe("automatic re-queue policy (plan F2 2.10, owner Q4)", () => {
  it("re-queues only the stock link's passing codes and the one-time Q4 code", () => {
    expect([...AUTOMATIC_REQUEUE_CODES].sort()).toEqual(["DROPSHIP_STOCK_LINK_BUSY", "DROPSHIP_STOCK_UPDATES_PAUSED",
      "PUBLICATION_LISTING_TARGET_UNMAPPED", "PUBLICATION_SCOPE_BUSY"]);
    expect(STOCK_LINK_RESEND_CODE).toBe("PUBLICATION_LISTING_TARGET_UNMAPPED");
    expect(AUTOMATIC_REQUEUE_ACTOR).toBe("system:dropship-stock-link-requeue");
    expect(AUTOMATIC_REQUEUE_BATCH_SIZE).toBe(25);
  });

  it.each([
    ["DROPSHIP_STOCK_LINK_BUSY", [1, 5, 15]],
    ["PUBLICATION_SCOPE_BUSY", [1, 5, 15]],
    ["DROPSHIP_STOCK_UPDATES_PAUSED", [15, 60, 240]],
  ] as const)("waits %s for %o minutes, three times, then never again", (code, minutes) => {
    expect(automaticRequeueCap(code)).toBe(3);
    minutes.forEach((wait, count) => {
      const due = automaticRequeueDueAt(code, count, FAILED_AT)!;
      expect(due.getTime() - FAILED_AT.getTime()).toBe(wait * MINUTE);
      // The boundary itself (just before vs at it) is proven over PostgreSQL, where the SQL
      // predicate decides: P3 "re-queues each passing code only after its wait, up to its cap".
    });
    expect(automaticRequeueDueAt(code, 3, FAILED_AT)).toBeNull();
  });

  it("re-sends a pre-link PUBLICATION_LISTING_TARGET_UNMAPPED failure once, at once", () => {
    expect(automaticRequeueCap(STOCK_LINK_RESEND_CODE)).toBe(1);
    expect(automaticRequeueDueAt(STOCK_LINK_RESEND_CODE, 0, FAILED_AT)).toEqual(FAILED_AT);
    expect(automaticRequeueDueAt(STOCK_LINK_RESEND_CODE, 1, FAILED_AT)).toBeNull();
  });

  it("leaves every other code alone", () => {
    for (const code of ["DROPSHIP_STOCK_DESTINATION_NOT_READY", "DROPSHIP_STOCK_LINK_FAILED", "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED",
      "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR"]) {
      expect(automaticRequeueCap(code)).toBe(0);
      expect(automaticRequeueDueAt(code, 0, FAILED_AT)).toBeNull();
    }
  });

  it("lists one SQL policy row per allowed re-queue", () => {
    expect(automaticRequeuePolicyRows()).toEqual([
      { code: "DROPSHIP_STOCK_LINK_BUSY", count: 0, delayMs: MINUTE }, { code: "DROPSHIP_STOCK_LINK_BUSY", count: 1, delayMs: 5 * MINUTE },
      { code: "DROPSHIP_STOCK_LINK_BUSY", count: 2, delayMs: 15 * MINUTE },
      { code: "PUBLICATION_SCOPE_BUSY", count: 0, delayMs: MINUTE }, { code: "PUBLICATION_SCOPE_BUSY", count: 1, delayMs: 5 * MINUTE },
      { code: "PUBLICATION_SCOPE_BUSY", count: 2, delayMs: 15 * MINUTE },
      { code: "DROPSHIP_STOCK_UPDATES_PAUSED", count: 0, delayMs: 15 * MINUTE },
      { code: "DROPSHIP_STOCK_UPDATES_PAUSED", count: 1, delayMs: 60 * MINUTE },
      { code: "DROPSHIP_STOCK_UPDATES_PAUSED", count: 2, delayMs: 240 * MINUTE },
      { code: "PUBLICATION_LISTING_TARGET_UNMAPPED", count: 0, delayMs: 0 },
    ]);
  });
});

// Reviews V2-1 / V2-2: the marker tells failures recorded after this deploy from older ones, and the item-level
// half of "will the sweep re-queue it" mirrors the SQL (the guards are the repository's).
describe("which failed items the automatic re-queue owns (reviews V2-1, V2-2)", () => {
  const marked = (extra: Record<string, unknown> = {}) => ({ push: { context: { [STOCK_LINK_AWARE_FAILURE_FIELD]: true } }, ...extra });
  const failed = (errorCode: string | null, result: Record<string, unknown> | null) => ({ status: "failed", errorCode, result });

  it("names the policy codes and reads the marker only as a strict true in result.push.context", () => {
    expect(AUTOMATIC_REQUEUE_CODES.every(isAutomaticRequeueCode)).toBe(true);
    for (const code of ["DROPSHIP_STOCK_DESTINATION_NOT_READY", "toString", "", null, undefined]) expect(isAutomaticRequeueCode(code)).toBe(false);
    expect(STOCK_LINK_AWARE_FAILURE_FIELD).toBe("recordedWithAutomaticStockLink");
    expect(isRecordedWithAutomaticStockLink(marked())).toBe(true);
    for (const result of [null, {}, { push: null }, { push: { context: null } }, { push: { context: { [STOCK_LINK_AWARE_FAILURE_FIELD]: "true" } } },
      { [STOCK_LINK_AWARE_FAILURE_FIELD]: true }]) {
      expect(isRecordedWithAutomaticStockLink(result as Record<string, unknown> | null)).toBe(false);
    }
  });

  it("may re-queue a passing code only when recorded after the stock link, below its cap and unmarked", () => {
    for (const code of ["DROPSHIP_STOCK_LINK_BUSY", "PUBLICATION_SCOPE_BUSY", "DROPSHIP_STOCK_UPDATES_PAUSED"]) {
      expect(mayRequeueAutomatically(failed(code, marked()))).toBe(true);
      expect(mayRequeueAutomatically(failed(code, marked({ automaticRequeue: { count: 2 } })))).toBe(true);
      // Recorded before this deploy (no marker): the vendor's own decision, never re-queued (V2-1).
      expect(mayRequeueAutomatically(failed(code, {}))).toBe(false);
      expect(mayRequeueAutomatically(failed(code, marked({ automaticRequeue: { count: 3 } })))).toBe(false);
      expect(mayRequeueAutomatically(failed(code, marked({ automaticRequeue: { count: 1, state: "exhausted" } })))).toBe(false);
      expect(mayRequeueAutomatically(failed(code, marked({ automaticRequeue: "corrupt" })))).toBe(false);
      expect(mayRequeueAutomatically({ status: "queued", errorCode: code, result: marked() })).toBe(false);
    }
    // The Q4 code's words never promise a retry (review TW-2); any other code is never re-queued.
    expect(mayRequeueAutomatically(failed(STOCK_LINK_RESEND_CODE, {}))).toBe(false);
    expect(mayRequeueAutomatically(failed(STOCK_LINK_RESEND_CODE, marked()))).toBe(false);
    expect(mayRequeueAutomatically(failed("DROPSHIP_STOCK_DESTINATION_NOT_READY", marked()))).toBe(false);
    expect(mayRequeueAutomatically(failed(null, marked()))).toBe(false);
  });

  it("reads one job's pending items with every guard of the due selection but its wait", async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const query = vi.fn(async (text: string, values: unknown[]) => { statements.push({ text, values }); return { rows: [{ id: 7 }, { id: 9 }] }; });

    expect(await readAutomaticRequeuePendingItemIds({ query } as unknown as Pool, 40)).toEqual([7, 9]);

    expect(statements).toHaveLength(1);
    const [{ text, values }] = statements;
    for (const guard of ["i.status = 'failed' AND i.action = 'push' AND j.job_type = 'push' AND j.status = 'failed'",
      // Rebase of PR A onto Fix PR 2a: a publish run's chunk job is never promised an automatic retry (its run reports it).
      "AND j.run_id IS NULL",
      "COALESCE(i.result -> 'automaticRequeue' ->> 'state', '') = ''", "NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items newer",
      "l.status <> 'ended'", "i.preview_hash = l.last_preview_hash", "sc.status = 'connected' AND sc.setup_status = 'ready'",
      "sc.external_account_verified_at IS NOT NULL", "v.status = 'active' AND v.entitlement_status = 'active'",
      "WHERE policy.code = i.error_code AND policy.attempt_count ="]) {
      expect(text).toContain(guard);
    }
    // No wait (the item is pending whatever its age), no lock, no limit: one job's items.
    expect(text).not.toContain("i.updated_at <=");
    expect(text).not.toMatch(/FOR UPDATE|LIMIT/);
    expect(text).toMatch(/AND i\.job_id = \$\d+::int/);
    expect(values).toContain(40);
    // Recorded after the stock link, and never the Q4 code.
    expect(text).toMatch(/AND \(i\.error_code = \$(\d+)::text OR COALESCE\(i\.result -> 'push' -> 'context' ->> \$\d+::text, ''\) = 'true'\)/);
    expect(text).toMatch(/AND i\.error_code <> \$\d+::text AND EXISTS \(SELECT 1 FROM unnest\(/);
    expect(values).toContain(STOCK_LINK_RESEND_CODE);
    expect(values).toContain(STOCK_LINK_AWARE_FAILURE_FIELD);
  });
});

describe("DropshipListingPushRecoveryService stock link step", () => {
  const NOW = new Date("2026-10-21T13:00:00.000Z");
  function setup(result: StockLinkRequeueResult | Error) {
    const order: string[] = [];
    const calls: Array<{ now: Date; workerId: string; limit: number }> = [];
    const logs: Array<DropshipLogEvent & { level: string }> = [];
    const stockLinkRequeue: DropshipStockLinkRequeuePort = { requeueAutomaticStockLinkFailures: async (input) => {
      order.push("stock_link"); calls.push(input);
      if (result instanceof Error) throw result;
      return result;
    } };
    const service = new DropshipListingPushRecoveryService({
      liveStatusRepair: { restoreDemotedLiveListings: async () => { order.push("repair"); return { restored: [], reviewRequired: [], failed: [], skipped: 0 }; } },
      accountVerificationRequeue: { requeueAccountVerificationFailures: async () => { order.push("requeue"); return { requeued: [], failed: [] }; } },
      stockLinkRequeue, stockLinkBatchSize: AUTOMATIC_REQUEUE_BATCH_SIZE,
      clock: { now: () => NOW },
      logger: { debug: (event) => logs.push({ level: "debug", ...event }), info: (event) => logs.push({ level: "info", ...event }),
        warn: (event) => logs.push({ level: "warn", ...event }), error: (event) => logs.push({ level: "error", ...event }) },
    });
    return { service, order, calls, logs };
  }
  const outcome = { jobId: 40, itemId: 7, listingId: 100, vendorId: 10, storeConnectionId: 22, productVariantId: 101 };

  it("runs after the two PR 1 steps with its own bound and the injected clock, and logs each outcome at its level", async () => {
    const { service, order, calls, logs } = setup({
      requeued: [{ jobId: 40, vendorId: 10, storeConnectionId: 22, itemIds: [7], listingIds: [100],
        items: [{ itemId: 7, errorCode: "DROPSHIP_STOCK_LINK_BUSY", attempt: 1 }] }],
      exhausted: [{ ...outcome, itemId: 8, errorCode: "PUBLICATION_SCOPE_BUSY", count: 3 }],
      skipped: [{ ...outcome, itemId: 9, errorCode: STOCK_LINK_RESEND_CODE, count: 0, reason: "zero:excluded_by_vendor_rule" }],
      deferred: [{ ...outcome, itemId: 10, errorCode: STOCK_LINK_RESEND_CODE, count: 0, reason: "zero:listing_paused" }],
      failed: [{ entity: "dropship_listing_push_job", entityId: 41, code: "40001", message: "serialization", classification: "transient", markedForReview: false },
        { entity: "dropship_store_connection", entityId: 22, code: "08006", message: "connection reset", classification: "transient",
          markedForReview: false, repeated: true }],
    });

    const result = await service.run({ workerId: "worker-1" });

    expect(order).toEqual(["repair", "requeue", "stock_link"]);
    expect(calls).toEqual([{ now: NOW, workerId: "worker-1", limit: AUTOMATIC_REQUEUE_BATCH_SIZE }]);
    expect(result).toEqual({ listingsRestored: 0, listingsNeedingReview: 0, jobsRequeued: 1, itemsRequeued: 1, rowFailures: 2, stepFailures: 0,
      stockLink: { jobsRequeued: 1, itemsRequeued: 1, itemsExhausted: 1, itemsSkipped: 1 } });
    // A deferred re-send and a repeated passing failure are expected states: DEBUG, not INFO or a repeated WARN.
    expect(logs.map(log => [log.level, log.code])).toEqual([
      ["info", "DROPSHIP_LISTING_PUSH_STOCK_LINK_REQUEUED"],
      ["error", "DROPSHIP_LISTING_PUSH_AUTOMATIC_REQUEUE_EXHAUSTED"],
      ["info", "DROPSHIP_LISTING_PUSH_STOCK_LINK_RESEND_SKIPPED"],
      ["debug", "DROPSHIP_LISTING_PUSH_STOCK_LINK_RESEND_DEFERRED"],
      ["warn", "DROPSHIP_LISTING_PUSH_RECOVERY_ROW_FAILED"],
      ["debug", "DROPSHIP_LISTING_PUSH_RECOVERY_ROW_FAILED"],
    ]);
    expect(logs[3]).toMatchObject({ context: { outcome: "deferred", itemId: 10, reason: "zero:listing_paused" } });
    expect(logs[0]).toMatchObject({ context: { action: "requeue_stock_link_failure", outcome: "requeued", jobId: 40, itemIds: [7],
      items: [{ itemId: 7, errorCode: "DROPSHIP_STOCK_LINK_BUSY", attempt: 1 }], before: { itemStatus: "failed" }, after: { itemStatus: "queued" } } });
    expect(logs[1]).toMatchObject({ context: { outcome: "requires_review", classification: "permanent", itemId: 8,
      error_code: "PUBLICATION_SCOPE_BUSY", automaticRequeues: 3, after: { state: "exhausted" } } });
    expect(logs[2]).toMatchObject({ context: { outcome: "skipped", itemId: 9, reason: "zero:excluded_by_vendor_rule" } });
  });

  it("logs a failed step for a human and still returns the other steps' results", async () => {
    const { service, logs } = setup(new Error("database unavailable"));
    const result = await service.run({ workerId: "worker-1" });
    expect(result.stepFailures).toBe(1);
    expect(result.stockLink).toEqual({ jobsRequeued: 0, itemsRequeued: 0, itemsExhausted: 0, itemsSkipped: 0 });
    expect(logs).toEqual([expect.objectContaining({ level: "error", code: "DROPSHIP_LISTING_PUSH_RECOVERY_STEP_FAILED",
      context: expect.objectContaining({ action: "requeue_stock_link_failures", error: "database unavailable" }) })]);
  });
});

describe("PgDropshipListingPushOpsRepository stock destination proof for the one-time re-send", () => {
  const T0 = new Date("2026-10-21T13:00:00.000Z");
  const at = (ms: number) => new Date(T0.getTime() + ms);
  /** A fake pool: the pre-pass store list answers `stores`; every other statement answers no rows. */
  function harness(stores: number[], read: (storeConnectionId: number) => Promise<string>, schedule = new StockLinkResendSchedule()) {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const query = vi.fn(async (statement: string | { text: string; values: unknown[] }, params?: unknown[]) => {
      const text = typeof statement === "string" ? statement : statement.text;
      const values = typeof statement === "string" ? params ?? [] : statement.values;
      statements.push({ text, values });
      if (text.startsWith("SELECT candidates.store_connection_id")) {
        // The exclusion array (when present) is the statement's int[] before the LIMIT.
        const excluded = text.includes("NOT (candidates.store_connection_id = ANY(") ? values[values.length - 2] as number[] : [];
        return { rows: stores.filter(id => !excluded.includes(id)).map(id => ({ store_connection_id: id, external_account_id: `acct-${id}` })) };
      }
      return { rows: [] };
    });
    const reads: number[] = [];
    const repository = new PgDropshipListingPushOpsRepository({ query } as unknown as Pool, async ({ storeConnectionId }) => {
      reads.push(storeConnectionId);
      return { status: await read(storeConnectionId) } as Awaited<ReturnType<DropshipStockDestinationReader>>;
    }, schedule);
    const pass = (now: Date) => repository.requeueAutomaticStockLinkFailures({ now, workerId: "worker-1", limit: 25 });
    return { statements, reads, pass };
  }
  const lost = () => Object.assign(new Error("connection reset"), { code: "08006" });

  it("reports a store whose destination read fails as a transient row failure and still serves the other stores", async () => {
    const { statements, reads, pass } = harness([22, 23], async id => { if (id === 22) throw lost(); return "live"; });

    const result = await pass(T0);

    expect(reads).toEqual([22, 23]);
    expect(result.failed).toEqual([{ entity: "dropship_store_connection", entityId: 22, code: "08006",
      message: "The stock destination could not be read for the one-time re-send: connection reset",
      classification: "transient", markedForReview: false }]);
    // Only the store with a proven live destination may have its one-time re-sends selected.
    const due = statements.find(statement => statement.text.includes("FROM unnest("))!;
    expect(due.values).toContainEqual([23]);
    expect(due.values).not.toContainEqual([22, 23]);
    expect(result.requeued).toEqual([]);
  });

  // Review MC-2 / CF-6: the stores come from the guarded re-send selection, oldest waiting re-send first.
  it("chooses the stores with the same guards as the re-send itself, oldest waiting re-send first", async () => {
    const { statements, pass } = harness([], async () => "live");
    await pass(T0);
    const stores = statements.find(statement => statement.text.startsWith("SELECT candidates.store_connection_id"))!;
    for (const guard of ["NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items newer", "l.status <> 'ended'",
      "i.preview_hash = l.last_preview_hash", "i.action = 'push' AND j.job_type = 'push'", "v.status = 'active' AND v.entitlement_status = 'active'",
      // Rebase of PR A onto Fix PR 2a: no destination is read for a publish run's item (never re-sent).
      "AND j.run_id IS NULL",
      "lc.is_active = true AND lc.listing_mode = 'live' AND lc.inventory_mode = 'managed_quantity_sync'",
      "COALESCE(i.result -> 'push' -> 'context' ->> $"]) {
      expect(stores.text).toContain(guard);
    }
    expect(stores.values).toContain("recordedWithAutomaticStockLink");
    expect(stores.text).toContain("ORDER BY MIN(candidates.updated_at) ASC, candidates.store_connection_id ASC");
    expect(stores.values.at(-1)).toBe(AUTOMATIC_RESEND_STORE_LIMIT);
  });

  // Rebase of PR A onto Fix PR 2a: every selection of a pass (the store list, the due re-queues, the at-cap marks)
  // leaves a publish run's chunk job to its run, as the account-check requeue does.
  it("never selects a publish run's chunk job in any statement of a pass", async () => {
    const { statements, pass } = harness([22], async () => "live");
    await pass(T0);
    const selections = statements.filter(statement => statement.text.includes("FROM dropship.dropship_listing_push_job_items i\n"));
    expect(selections.length).toBeGreaterThanOrEqual(3);
    for (const selection of selections) expect(selection.text).toContain("AND j.run_id IS NULL");
  });

  it("waits after a failed read, logs only the first failure in a row as new, and reads again after the backoff", async () => {
    let fail = true;
    const { reads, pass } = harness([22], async () => { if (fail) throw lost(); return "live"; });

    expect((await pass(T0)).failed).toEqual([expect.objectContaining({ entityId: 22, classification: "transient" })]);
    expect((await pass(at(STOCK_DESTINATION_READ_BACKOFF_MS[0]! - 1))).failed).toEqual([]);
    expect(reads).toEqual([22]);
    const second = await pass(at(STOCK_DESTINATION_READ_BACKOFF_MS[0]!));
    expect(second.failed).toEqual([expect.objectContaining({ entityId: 22, classification: "transient", repeated: true })]);
    expect(reads).toEqual([22, 22]);
    // The second wait is longer.
    await pass(at(STOCK_DESTINATION_READ_BACKOFF_MS[0]! + STOCK_DESTINATION_READ_BACKOFF_MS[1]! - 1));
    expect(reads).toEqual([22, 22]);
    fail = false;
    expect((await pass(at(STOCK_DESTINATION_READ_BACKOFF_MS[0]! + STOCK_DESTINATION_READ_BACKOFF_MS[1]!))).failed).toEqual([]);
    expect(reads).toEqual([22, 22, 22]);
  });

  it("reads a store whose destination is not live again only after its recheck time, and frees its place meanwhile", async () => {
    const { reads, statements, pass } = harness([22, 23], async id => id === 22 ? "missing" : "held");
    await pass(T0);
    await pass(at(STOCK_DESTINATION_RECHECK_MS - 1));
    expect(reads).toEqual([22, 23]);
    const second = statements.filter(statement => statement.text.startsWith("SELECT candidates.store_connection_id"))[1]!;
    expect(second.values).toContainEqual([22, 23]);
    await pass(at(STOCK_DESTINATION_RECHECK_MS));
    expect(reads).toEqual([22, 23, 22, 23]);
  });

  it("treats a read that fails the same way on every pass as permanent and takes the store's re-sends out for review", async () => {
    const zod = (() => { const parsed = z.object({ accountId: z.string().max(3) }).safeParse({ accountId: "too-long" });
      return parsed.success ? null : parsed.error; })();
    const { statements, pass } = harness([22], async () => { throw zod; });

    const result = await pass(T0);

    expect(result.failed).toEqual([expect.objectContaining({ entity: "dropship_store_connection", entityId: 22, classification: "permanent" })]);
    // The store's open re-sends are selected for the review mark (none in this fake).
    expect(statements.some(statement => statement.text.includes("j.store_connection_id = $") && statement.values.includes(22))).toBe(true);
  });
});

describe("StockLinkResendSchedule", () => {
  const T0 = new Date("2026-10-21T13:00:00.000Z");
  it("postpones a temporarily ineligible item for its recheck time, then lets it be read again", () => {
    const schedule = new StockLinkResendSchedule();
    schedule.deferItem(7, T0);
    expect(schedule.deferredItemIds(new Date(T0.getTime() + STOCK_LINK_RESEND_RECHECK_MS - 1))).toEqual([7]);
    expect(schedule.deferredItemIds(new Date(T0.getTime() + STOCK_LINK_RESEND_RECHECK_MS))).toEqual([]);
  });

  it("names the selection reasons that only postpone the one-time re-send", () => {
    expect([...STOCK_LINK_RESEND_DEFERRABLE_REASONS].sort()).toEqual(["listing_paused", "managed_live_publication_not_enabled"]);
    expect(STOCK_DESTINATION_RECHECK_MS).toBe(MINUTE);
    expect(STOCK_DESTINATION_READ_BACKOFF_MS).toEqual([MINUTE, 5 * MINUTE, 15 * MINUTE]);
    expect(STOCK_LINK_RESEND_RECHECK_MS).toBe(15 * MINUTE);
  });

  it("caps the read backoff at its last wait and forgets a store once it is live", () => {
    const schedule = new StockLinkResendSchedule();
    const waits = [0, 1, 2, 3, 4].map(() => schedule.recordDestinationReadFailure(22, T0).waitMs);
    expect(waits).toEqual([MINUTE, 5 * MINUTE, 15 * MINUTE, 15 * MINUTE, 15 * MINUTE]);
    schedule.recordDestinationLive(22);
    expect(schedule.waitingStoreIds(T0)).toEqual([]);
    expect(schedule.recordDestinationReadFailure(22, T0)).toEqual({ failures: 1, waitMs: MINUTE, repeated: false });
  });
});

// Review TW-5: the production wiring that turns the automatic re-queue (2.10, Q4) on. Losing it would disable the
// step silently (it is optional in the service), so it is pinned here.
describe("production wiring of the stock link re-queue", () => {
  it("gives the sweep's recovery the ops repository as its stock link re-queue, with its own batch size", () => {
    const service = createDropshipListingPushRecoveryFromEnv();
    const deps = (service as unknown as { deps: { stockLinkRequeue?: unknown; stockLinkBatchSize?: number; accountVerificationRequeue: unknown } }).deps;
    expect(deps.stockLinkRequeue).toBeInstanceOf(PgDropshipListingPushOpsRepository);
    expect(deps.stockLinkRequeue).toBe(deps.accountVerificationRequeue);
    expect(deps.stockLinkBatchSize).toBe(AUTOMATIC_REQUEUE_BATCH_SIZE);
  });

  // Review V2-2: without it the failure email silently stops saying an automatic retry is coming (never untrue, but lost).
  it("gives the push worker the guarded pending read for its failure email", () => {
    const factory = readFileSync(resolve(__dirname, "../../infrastructure/dropship-listing-push-worker.factory.ts"), "utf8");
    expect(factory).toContain('import { readAutomaticRequeuePendingItemIds } from "./dropship-listing-push-ops.repository";');
    expect(factory).toMatch(/automaticRequeueOutlook: \{ pendingItemIds: \(jobId\) => readAutomaticRequeuePendingItemIds\(pool, jobId\) \}/);
  });

  it("keeps one recovery for the life of the push worker, so the re-send schedule survives between passes", () => {
    const runner = readFileSync(resolve(__dirname, "../../infrastructure/dropship-listing-push-job-runner.ts"), "utf8");
    const start = runner.indexOf("export function startDropshipListingPushWorker");
    const created = runner.indexOf("const recovery = createDropshipListingPushRecoveryFromEnv();", start);
    const closure = runner.indexOf("const runLockedSweep = async () =>", start);
    expect(start).toBeGreaterThan(-1);
    expect(created).toBeGreaterThan(start);
    expect(closure).toBeGreaterThan(created);
    expect(runner.slice(closure)).toContain("runDropshipListingPushSweep({ recovery })");
    expect(runner.slice(closure).match(/createDropshipListingPushRecoveryFromEnv\(/g)).toBeNull();
  });
});
