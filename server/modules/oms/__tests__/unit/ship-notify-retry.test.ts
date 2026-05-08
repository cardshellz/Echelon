/**
 * Unit tests for SHIP_NOTIFY retry + DLQ path (§6 Commit 20).
 *
 * Two helpers under test, both exported from webhook-retry.worker.ts:
 *
 *   1. `enqueueShipStationRetry(db, payload)` — what the SS webhook
 *      handler in server/index.ts calls on `processShipNotify` failure.
 *      Inserts a single `oms.webhook_retry_queue` row.
 *
 *   2. `dispatchShipStationRetry(db, item)` — what the worker loop calls
 *      for rows with `provider='shipstation' + topic='SHIP_NOTIFY'`. Looks
 *      up the SS service via the `db.__shipStationService` stash, invokes
 *      `processShipNotify(payload.resource_url)`, and updates the row
 *      (success / retry / dead / malformed).
 *
 * Scope limits (plan §6 Commit 20):
 *   - No HTTP. The route handler itself isn't exercised; the helper is.
 *   - No real DB. We stub `db.insert().values()` and
 *     `db.update().set().where()` with vi.fn() shells.
 *   - We also assert the route-handler source literally calls the helper,
 *     as a cheap regression guard against a future refactor unwiring it.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const createShipmentForOrderMock = vi.hoisted(() => vi.fn());

// The worker's top-level `import { db } from "../../db"` would otherwise
// try to build a real Postgres client at import time and fail on
// DATABASE_URL. We never exercise that default-db path in this file — all
// tests inject their own db mock — so a no-op stand-in is sufficient.
vi.mock("../../../../db", () => ({
  db: {
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [] }),
      }),
    }),
    execute: async () => ({ rows: [] }),
  },
}));

vi.mock("../../../wms/create-shipment", () => ({
  createShipmentForOrder: createShipmentForOrderMock,
}));

import {
  enqueueShipStationRetry,
  enqueueShipStationShipmentPushRetry,
  enqueueOmsWmsSyncRetry,
  enqueueWmsShipmentCreateRetry,
  requeueDeadWebhookRetry,
  dispatchShipStationRetry,
  dispatchShipStationShipmentPushRetry,
  dispatchOmsWmsSyncRetry,
  dispatchWmsShipmentCreateRetry,
  recordRetryFailure,
  enqueueShopifyFulfillmentRetry,
  enqueueDelayedTrackingPush,
  getWebhookRetryWorkerHeartbeat,
  resetWebhookRetryWorkerHeartbeatForTest,
  runWebhookRetryWorkerTick,
  dispatchShopifyFulfillmentRetry,
  dispatchDelayedTrackingPush,
  dispatchEbayWebhookRetry,
} from "../../webhook-retry.worker";

const WEBHOOK_RETRY_WORKER_SRC = readFileSync(
  resolve(__dirname, "../../webhook-retry.worker.ts"),
  "utf8",
);

// ─── DB mock helpers ─────────────────────────────────────────────────

interface RecordedInsert {
  table: unknown;
  values: any;
}
interface RecordedUpdate {
  table: unknown;
  set: any;
  where: unknown;
}

function makeDb(opts: {
  shipStationService?: {
    processShipNotify: (url: string) => Promise<number>;
    pushShipment?: (shipmentId: number) => Promise<unknown>;
  } | null;
  fulfillmentPush?:
    | {
        pushShopifyFulfillment?: (
          shipmentId: number,
        ) => Promise<{ shopifyFulfillmentId: string | null; alreadyPushed: boolean }>;
        pushTracking?: (orderId: number) => Promise<boolean>;
        pushTrackingForShipment?: (shipmentId: number) => Promise<boolean>;
      }
    | null;
  ebayReplay?:
    | {
        omsService: unknown;
        ebayApiClient: unknown;
        reingestEbayOrder: (
          orderId: string,
          omsService: unknown,
          ebayApiClient: unknown,
        ) => Promise<{ status: string; omsOrderId: number }>;
      }
    | null;
  wmsSync?:
    | {
        syncOmsOrderToWms: (omsOrderId: number) => Promise<number | null>;
      }
    | null;
  insertThrows?: Error;
  updateThrows?: Error;
  executeRows?: Array<{ rows: any[] }>;
} = {}) {
  const inserts: RecordedInsert[] = [];
  const updates: RecordedUpdate[] = [];
  const executes: unknown[] = [];
  const remainingExecuteRows = [...(opts.executeRows ?? [])];

  const db: any = {
    insert: vi.fn((table: any) => ({
      values: vi.fn(async (values: any) => {
        if (opts.insertThrows) throw opts.insertThrows;
        inserts.push({ table, values });
        return undefined;
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((set: any) => ({
        where: vi.fn(async (where: any) => {
          if (opts.updateThrows) throw opts.updateThrows;
          updates.push({ table, set, where });
          return undefined;
        }),
      })),
    })),
    execute: vi.fn(async (query: unknown) => {
      executes.push(query);
      return remainingExecuteRows.shift() ?? { rows: [] };
    }),
  };

  if (opts.shipStationService !== undefined) {
    db.__shipStationService = opts.shipStationService;
  }
  if (opts.fulfillmentPush !== undefined) {
    db.__fulfillmentPush = opts.fulfillmentPush;
  }
  if (opts.ebayReplay !== undefined) {
    db.__ebayWebhookReplay = opts.ebayReplay;
  }
  if (opts.wmsSync !== undefined) {
    db.__wmsSyncService = opts.wmsSync;
  }

  return { db, inserts, updates, executes };
}

function postgresUniqueViolation(
  constraint: string,
  field: "constraint" | "constraint_name" = "constraint",
): Error {
  const error = new Error(
    `duplicate key value violates unique constraint "${constraint}"`,
  ) as Error & Record<string, unknown>;
  error.code = "23505";
  error[field] = constraint;
  return error;
}

// ─── enqueueShipStationRetry tests ───────────────────────────────────

describe("enqueueShipStationRetry :: happy path", () => {
  it("inserts one row with the expected columns", async () => {
    const { db, inserts } = makeDb();
    const before = Date.now();

    await enqueueShipStationRetry(db, { resource_url: "https://ss.example/shipments?batch=42" });

    const after = Date.now();

    expect(inserts).toHaveLength(1);
    const row = inserts[0]!.values;

    expect(row.provider).toBe("shipstation");
    expect(row.topic).toBe("SHIP_NOTIFY");
    expect(row.payload).toEqual({ resource_url: "https://ss.example/shipments?batch=42" });
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    // next_retry_at ≈ NOW + 5 minutes, allow generous clock slop
    expect(row.nextRetryAt).toBeInstanceOf(Date);
    const nextMs = (row.nextRetryAt as Date).getTime();
    expect(nextMs).toBeGreaterThanOrEqual(before + 5 * 60_000 - 50);
    expect(nextMs).toBeLessThanOrEqual(after + 5 * 60_000 + 50);
  });

  it("does not leak extra keys from the caller-supplied payload", async () => {
    const { db, inserts } = makeDb();

    await enqueueShipStationRetry(db, {
      resource_url: "https://ss.example/a",
      // deliberately pass an extra field — the helper must strip it so the
      // DLQ row only carries what the retry actually needs
      ...({ shouldNotSurvive: "yes" } as any),
    });

    expect(inserts[0]!.values.payload).toEqual({ resource_url: "https://ss.example/a" });
    expect((inserts[0]!.values.payload as any).shouldNotSurvive).toBeUndefined();
  });

  it("does not enqueue duplicate pending ShipStation retry rows for the same resource URL", async () => {
    const { db, inserts } = makeDb({
      executeRows: [{ rows: [{ id: 22 }] }],
    });

    await enqueueShipStationRetry(db, { resource_url: "https://ss.example/shipments?batch=42" });

    expect(inserts).toHaveLength(0);
  });
});

describe("webhook retry worker heartbeat", () => {
  beforeEach(() => {
    resetWebhookRetryWorkerHeartbeatForTest();
  });
  afterEach(() => {
    resetWebhookRetryWorkerHeartbeatForTest();
    vi.restoreAllMocks();
  });

  it("exposes null heartbeat timestamps before the worker starts", () => {
    expect(getWebhookRetryWorkerHeartbeat()).toMatchObject({
      startedAt: null,
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastSkippedAt: null,
      inFlight: false,
    });
  });

  it("records successful tick heartbeat state", async () => {
    const result = await runWebhookRetryWorkerTick(vi.fn(async () => undefined));

    expect(result).toBe("success");
    expect(getWebhookRetryWorkerHeartbeat()).toMatchObject({
      lastError: null,
      lastSkippedAt: null,
      inFlight: false,
    });
    expect(getWebhookRetryWorkerHeartbeat().lastRunAt).toEqual(expect.any(String));
    expect(getWebhookRetryWorkerHeartbeat().lastSuccessAt).toEqual(expect.any(String));
  });

  it("skips overlapping ticks without running the second processor", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let releaseFirstRun: (() => void) | undefined;
    const firstProcessor = vi.fn(() => new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    }));
    const secondProcessor = vi.fn(async () => undefined);

    const firstRun = runWebhookRetryWorkerTick(firstProcessor);
    await Promise.resolve();

    const secondRun = await runWebhookRetryWorkerTick(secondProcessor);
    releaseFirstRun?.();
    const firstResult = await firstRun;

    expect(firstResult).toBe("success");
    expect(secondRun).toBe("skipped");
    expect(firstProcessor).toHaveBeenCalledTimes(1);
    expect(secondProcessor).not.toHaveBeenCalled();
    expect(getWebhookRetryWorkerHeartbeat().lastSkippedAt).toEqual(expect.any(String));
    expect(getWebhookRetryWorkerHeartbeat().inFlight).toBe(false);
  });

  it("records tick errors without leaving the worker stuck in-flight", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runWebhookRetryWorkerTick(vi.fn(async () => {
      throw new Error("database unavailable");
    }));

    expect(result).toBe("error");
    expect(getWebhookRetryWorkerHeartbeat()).toMatchObject({
      lastError: "database unavailable",
      inFlight: false,
    });
  });
});

describe("enqueueShipStationRetry :: validation", () => {
  it("throws when resource_url is missing", async () => {
    const { db, inserts } = makeDb();
    await expect(enqueueShipStationRetry(db, {} as any)).rejects.toThrow(/resource_url required/);
    expect(inserts).toHaveLength(0);
  });

  it("throws when resource_url is non-string", async () => {
    const { db, inserts } = makeDb();
    await expect(
      enqueueShipStationRetry(db, { resource_url: 123 as any })
    ).rejects.toThrow(/resource_url required/);
    expect(inserts).toHaveLength(0);
  });

  it("throws when resource_url is an empty string", async () => {
    const { db, inserts } = makeDb();
    await expect(enqueueShipStationRetry(db, { resource_url: "" })).rejects.toThrow(
      /resource_url required/
    );
    expect(inserts).toHaveLength(0);
  });
});

describe("enqueueShipStationRetry :: DB failure", () => {
  it("propagates when the underlying insert throws", async () => {
    const { db } = makeDb({ insertThrows: new Error("connection refused") });
    await expect(
      enqueueShipStationRetry(db, { resource_url: "https://ss.example/x" })
    ).rejects.toThrow(/connection refused/);
  });
});

// ─── dispatchShipStationRetry tests ──────────────────────────────────

describe("webhook retry enqueue unique constraint races", () => {
  const retryScopeCases: Array<[string, string, (db: any) => Promise<void>]> = [
    [
      "ShipStation resource URL",
      "uq_webhook_retry_pending_shipstation_resource_url",
      (db) => enqueueShipStationRetry(db, { resource_url: "https://ss.example/x" }),
    ],
    [
      "Shopify fulfillment shipment",
      "uq_webhook_retry_pending_shopify_fulfillment_shipment",
      (db) => enqueueShopifyFulfillmentRetry(db, 501, new Error("shopify 500")),
    ],
    [
      "delayed tracking shipment",
      "uq_webhook_retry_pending_delayed_tracking_shipment",
      (db) => enqueueDelayedTrackingPush(db, 77, 501),
    ],
    [
      "delayed tracking order",
      "uq_webhook_retry_pending_delayed_tracking_order",
      (db) => enqueueDelayedTrackingPush(db, 77),
    ],
    [
      "OMS/WMS sync order",
      "uq_webhook_retry_pending_oms_wms_sync_order",
      (db) => enqueueOmsWmsSyncRetry(db, 10, "manual fix"),
    ],
    [
      "WMS shipment create order",
      "uq_webhook_retry_pending_wms_shipment_create_order",
      (db) => enqueueWmsShipmentCreateRetry(db, 15, "shipstation unavailable"),
    ],
    [
      "ShipStation shipment push",
      "uq_webhook_retry_pending_shipstation_shipment_push",
      (db) => enqueueShipStationShipmentPushRetry(db, 45, "shipstation unavailable"),
    ],
  ];

  it.each(retryScopeCases)(
    "treats a %s duplicate insert race as already enqueued",
    async (_label, constraint, enqueue) => {
      const { db, inserts } = makeDb({
        insertThrows: postgresUniqueViolation(constraint),
      });

      await expect(enqueue(db)).resolves.toBeUndefined();

      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(inserts).toHaveLength(0);
    },
  );

  it("recognizes wrapped pg errors and constraint_name fields", async () => {
    const cause = postgresUniqueViolation(
      "uq_webhook_retry_pending_delayed_tracking_shipment",
      "constraint_name",
    );
    const wrapped = Object.assign(new Error("query failed"), { cause });
    const { db, inserts } = makeDb({ insertThrows: wrapped });

    await expect(enqueueDelayedTrackingPush(db, 77, 501)).resolves.toBeUndefined();

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(0);
  });

  it("propagates unrelated unique violations", async () => {
    const { db } = makeDb({
      insertThrows: postgresUniqueViolation("users_email_key"),
    });

    await expect(enqueueDelayedTrackingPush(db, 77, 501)).rejects.toThrow(
      /users_email_key/,
    );
  });
});

describe("enqueueOmsWmsSyncRetry", () => {
  it("inserts an immediately due internal OMS/WMS sync row", async () => {
    const { db, inserts } = makeDb();
    const before = Date.now();

    await enqueueOmsWmsSyncRetry(db, 10, "manual fix");

    const after = Date.now();
    expect(inserts).toHaveLength(1);
    const row = inserts[0]!.values;
    expect(row.provider).toBe("internal");
    expect(row.topic).toBe("oms_wms_sync");
    expect(row.payload).toEqual({ omsOrderId: 10 });
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBe("manual fix");
    expect(row.nextRetryAt).toBeInstanceOf(Date);
    const nextMs = (row.nextRetryAt as Date).getTime();
    expect(nextMs).toBeGreaterThanOrEqual(before - 50);
    expect(nextMs).toBeLessThanOrEqual(after + 50);
  });

  it("does not enqueue duplicate pending OMS/WMS sync rows for the same OMS order", async () => {
    const { db, inserts } = makeDb({
      executeRows: [{ rows: [{ id: 41 }] }],
    });

    await enqueueOmsWmsSyncRetry(db, 10, "manual fix");

    expect(inserts).toHaveLength(0);
  });

  it("rejects invalid OMS order ids", async () => {
    const { db, inserts } = makeDb();

    await expect(enqueueOmsWmsSyncRetry(db, 0, "bad")).rejects.toThrow(
      /positive integer/,
    );

    expect(inserts).toHaveLength(0);
  });
});

describe("enqueueWmsShipmentCreateRetry", () => {
  it("inserts an immediately due internal shipment-create row", async () => {
    const { db, inserts } = makeDb();
    const before = Date.now();

    await enqueueWmsShipmentCreateRetry(db, 200, "manual fix");

    const after = Date.now();
    expect(inserts).toHaveLength(1);
    const row = inserts[0]!.values;
    expect(row.provider).toBe("internal");
    expect(row.topic).toBe("wms_shipment_create");
    expect(row.payload).toEqual({ wmsOrderId: 200 });
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBe("manual fix");
    expect(row.nextRetryAt).toBeInstanceOf(Date);
    const nextMs = (row.nextRetryAt as Date).getTime();
    expect(nextMs).toBeGreaterThanOrEqual(before - 50);
    expect(nextMs).toBeLessThanOrEqual(after + 50);
  });

  it("does not enqueue duplicate pending shipment-create rows for the same WMS order", async () => {
    const { db, inserts } = makeDb({
      executeRows: [{ rows: [{ id: 42 }] }],
    });

    await enqueueWmsShipmentCreateRetry(db, 200, "manual fix");

    expect(inserts).toHaveLength(0);
  });

  it("rejects invalid WMS order ids", async () => {
    const { db, inserts } = makeDb();

    await expect(enqueueWmsShipmentCreateRetry(db, 0, "bad")).rejects.toThrow(
      /positive integer/,
    );

    expect(inserts).toHaveLength(0);
  });
});

describe("enqueueShipStationShipmentPushRetry", () => {
  it("inserts an immediately due internal ShipStation shipment push row", async () => {
    const { db, inserts } = makeDb();

    await enqueueShipStationShipmentPushRetry(db, 300, "manual fix");

    expect(inserts).toHaveLength(1);
    const row = inserts[0]!.values;
    expect(row.provider).toBe("internal");
    expect(row.topic).toBe("shipstation_shipment_push");
    expect(row.payload).toEqual({ shipmentId: 300 });
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBe("manual fix");
  });

  it("does not enqueue duplicate pending ShipStation shipment push rows", async () => {
    const { db, inserts } = makeDb({
      executeRows: [{ rows: [{ id: 42 }] }],
    });

    await enqueueShipStationShipmentPushRetry(db, 300, "manual fix");

    expect(inserts).toHaveLength(0);
  });

  it("rejects invalid shipment ids", async () => {
    const { db, inserts } = makeDb();

    await expect(enqueueShipStationShipmentPushRetry(db, 0, "bad")).rejects.toThrow(
      /positive integer/,
    );

    expect(inserts).toHaveLength(0);
  });
});

describe("requeueDeadWebhookRetry", () => {
  it("resets a dead retry row to pending", async () => {
    const { db } = makeDb();
    db.execute.mockResolvedValueOnce({
      rows: [{
        id: 99,
        provider: "internal",
        topic: "delayed_tracking_push",
        previous_status: "dead",
      }],
    });

    const result = await requeueDeadWebhookRetry(db, 99, "ops");

    expect(result).toEqual({
      retryQueueId: 99,
      provider: "internal",
      topic: "delayed_tracking_push",
      previousStatus: "dead",
    });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("returns not found when no retry row exists", async () => {
    const { db } = makeDb();
    db.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(requeueDeadWebhookRetry(db, 100, "ops")).rejects.toThrow(/not found/);
  });

  it("rejects rows that are not dead-lettered", async () => {
    const { db } = makeDb();
    db.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 101, provider: "shopify", topic: "orders/paid", status: "pending" }] });

    await expect(requeueDeadWebhookRetry(db, 101, "ops")).rejects.toThrow(/not dead-lettered/);
  });
});

describe("dispatchShipStationRetry :: happy path", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls processShipNotify with payload.resource_url and marks row success", async () => {
    const ship = vi.fn(async () => 1);
    const { db, updates } = makeDb({ shipStationService: { processShipNotify: ship } });

    const outcome = await dispatchShipStationRetry(db, {
      id: 501,
      provider: "shipstation",
      topic: "SHIP_NOTIFY",
      payload: { resource_url: "https://ss.example/shipments?batch=42" },
      attempts: 0,
    });

    expect(ship).toHaveBeenCalledTimes(1);
    expect(ship).toHaveBeenCalledWith("https://ss.example/shipments?batch=42");
    expect(outcome).toBe("success");

    // One UPDATE marking the row success
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.status).toBe("success");
    expect(updates[0]!.set.updatedAt).toBeInstanceOf(Date);
  });
});

describe("dispatchEbayWebhookRetry", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reingests the order and marks the retry row successful", async () => {
    const omsService = { name: "oms" };
    const ebayApiClient = { name: "ebay" };
    const reingest = vi.fn(async () => ({ status: "ingested", omsOrderId: 123 }));
    const { db, updates } = makeDb({
      ebayReplay: { omsService, ebayApiClient, reingestEbayOrder: reingest },
    });

    const outcome = await dispatchEbayWebhookRetry(db, {
      id: 901,
      provider: "ebay",
      topic: "ORDER.CREATED",
      payload: { notification: { data: { orderId: "12-34567-89012" } } },
      attempts: 0,
    });

    expect(outcome).toBe("success");
    expect(reingest).toHaveBeenCalledWith("12-34567-89012", omsService, ebayApiClient);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.status).toBe("success");
  });

  it("marks the source inbox row succeeded when a replay retry succeeds", async () => {
    const reingest = vi.fn(async () => ({ status: "already_existed", omsOrderId: 124 }));
    const { db, executes } = makeDb({
      ebayReplay: {
        omsService: {},
        ebayApiClient: {},
        reingestEbayOrder: reingest,
      },
    });

    const outcome = await dispatchEbayWebhookRetry(db, {
      id: 904,
      provider: "ebay",
      topic: "ORDER.CREATED",
      payload: { notification: { data: { orderId: "12-34567-89012" } } },
      attempts: 0,
      sourceInboxId: 55,
    });

    expect(outcome).toBe("success");
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(executes).toHaveLength(1);
  });

  it("keeps the row pending without burning an attempt when boot has not wired eBay replay", async () => {
    const { db, updates } = makeDb({ ebayReplay: null });

    const outcome = await dispatchEbayWebhookRetry(db, {
      id: 902,
      provider: "ebay",
      topic: "ORDER.CREATED",
      payload: { notification: { data: { orderId: "12-34567-89012" } } },
      attempts: 3,
    });

    expect(outcome).toBe("pending");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.lastError).toMatch(/eBay replay service not available/);
    expect(updates[0]!.set.attempts).toBeUndefined();
    expect(updates[0]!.set.status).toBeUndefined();
  });

  it("dead-letters malformed eBay rows immediately", async () => {
    const reingest = vi.fn();
    const { db, updates } = makeDb({
      ebayReplay: {
        omsService: {},
        ebayApiClient: {},
        reingestEbayOrder: reingest,
      },
    });

    const outcome = await dispatchEbayWebhookRetry(db, {
      id: 903,
      provider: "ebay",
      topic: "ORDER.CREATED",
      payload: { notification: { data: {} } },
      attempts: 0,
    });

    expect(outcome).toBe("malformed");
    expect(reingest).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.status).toBe("dead");
    expect(updates[0]!.set.lastError).toMatch(/orderId missing/);
  });

  it("marks the source inbox row dead when replay payload is malformed", async () => {
    const { db, executes } = makeDb();

    const outcome = await dispatchEbayWebhookRetry(db, {
      id: 905,
      provider: "ebay",
      topic: "ORDER.CREATED",
      payload: { notification: { data: {} } },
      attempts: 0,
      sourceInboxId: 56,
    });

    expect(outcome).toBe("malformed");
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(executes).toHaveLength(1);
  });
});

describe("dispatchOmsWmsSyncRetry", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls syncOmsOrderToWms and marks the row successful", async () => {
    const sync = vi.fn(async () => 200);
    const { db, updates } = makeDb({ wmsSync: { syncOmsOrderToWms: sync } });

    const outcome = await dispatchOmsWmsSyncRetry(db, {
      id: 910,
      provider: "internal",
      topic: "oms_wms_sync",
      payload: { omsOrderId: 10 },
      attempts: 0,
    });

    expect(outcome).toBe("success");
    expect(sync).toHaveBeenCalledWith(10);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.status).toBe("success");
  });

  it("keeps pending without incrementing attempts when WMS sync is not wired", async () => {
    const { db, updates } = makeDb({ wmsSync: null });

    const outcome = await dispatchOmsWmsSyncRetry(db, {
      id: 911,
      provider: "internal",
      topic: "oms_wms_sync",
      payload: { omsOrderId: 10 },
      attempts: 3,
    });

    expect(outcome).toBe("pending");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.lastError).toMatch(/WMS sync service not available/);
    expect(updates[0]!.set.attempts).toBeUndefined();
    expect(updates[0]!.set.status).toBeUndefined();
  });

  it("dead-letters malformed payloads immediately", async () => {
    const sync = vi.fn();
    const { db, updates } = makeDb({ wmsSync: { syncOmsOrderToWms: sync } });

    const outcome = await dispatchOmsWmsSyncRetry(db, {
      id: 912,
      provider: "internal",
      topic: "oms_wms_sync",
      payload: { omsOrderId: "10" as any },
      attempts: 0,
    });

    expect(outcome).toBe("malformed");
    expect(sync).not.toHaveBeenCalled();
    expect(updates[0]!.set.status).toBe("dead");
    expect(updates[0]!.set.lastError).toMatch(/omsOrderId missing or invalid/);
  });
});

describe("dispatchWmsShipmentCreateRetry", () => {
  beforeEach(() => {
    createShipmentForOrderMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the WMS order/items, creates a shipment, and marks success", async () => {
    createShipmentForOrderMock.mockResolvedValue({ shipmentId: 300, created: true });
    const { db, updates } = makeDb();
    db.execute
      .mockResolvedValueOnce({ rows: [{ id: 200, channel_id: 7 }] })
      .mockResolvedValueOnce({ rows: [
        { id: 901, quantity: 2, product_variant_id: 50 },
        { id: 902, quantity: 1, product_variant_id: null },
      ] });

    const outcome = await dispatchWmsShipmentCreateRetry(db, {
      id: 913,
      provider: "internal",
      topic: "wms_shipment_create",
      payload: { wmsOrderId: 200 },
      attempts: 0,
    });

    expect(outcome).toBe("success");
    expect(createShipmentForOrderMock).toHaveBeenCalledWith(
      db,
      200,
      7,
      [
        { id: 901, quantity: 2, productVariantId: 50 },
        { id: 902, quantity: 1, productVariantId: null },
      ],
    );
    expect(updates[0]!.set.status).toBe("success");
  });

  it("allows remediation when all existing outbound shipments are voided", () => {
    expect(WEBHOOK_RETRY_WORKER_SRC).toMatch(
      /WHERE os\.order_id = wo\.id\s+AND os\.status <> 'voided'/,
    );
  });

  it("marks success when the order no longer needs shipment remediation", async () => {
    const { db, updates } = makeDb();
    db.execute.mockResolvedValueOnce({ rows: [] });

    const outcome = await dispatchWmsShipmentCreateRetry(db, {
      id: 914,
      provider: "internal",
      topic: "wms_shipment_create",
      payload: { wmsOrderId: 201 },
      attempts: 0,
    });

    expect(outcome).toBe("success");
    expect(createShipmentForOrderMock).not.toHaveBeenCalled();
    expect(updates[0]!.set.status).toBe("success");
  });

  it("dead-letters malformed payloads immediately", async () => {
    const { db, updates } = makeDb();

    const outcome = await dispatchWmsShipmentCreateRetry(db, {
      id: 915,
      provider: "internal",
      topic: "wms_shipment_create",
      payload: { wmsOrderId: "201" as any },
      attempts: 0,
    });

    expect(outcome).toBe("malformed");
    expect(createShipmentForOrderMock).not.toHaveBeenCalled();
    expect(updates[0]!.set.status).toBe("dead");
    expect(updates[0]!.set.lastError).toMatch(/wmsOrderId missing or invalid/);
  });
});

describe("dispatchShipStationShipmentPushRetry", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pushes the WMS shipment to ShipStation and marks success", async () => {
    const pushShipment = vi.fn().mockResolvedValue({ shipstationOrderId: 123 });
    const { db, updates } = makeDb({
      shipStationService: {
        processShipNotify: vi.fn(),
        pushShipment,
      },
    });

    const outcome = await dispatchShipStationShipmentPushRetry(db, {
      id: 950,
      provider: "internal",
      topic: "shipstation_shipment_push",
      payload: { shipmentId: 300 },
      attempts: 0,
    });

    expect(outcome).toBe("success");
    expect(pushShipment).toHaveBeenCalledWith(300);
    expect(updates[0]!.set.status).toBe("success");
  });

  it("keeps the row pending when ShipStation push service is not wired", async () => {
    const { db, updates } = makeDb({
      shipStationService: {
        processShipNotify: vi.fn(),
      },
    });

    const outcome = await dispatchShipStationShipmentPushRetry(db, {
      id: 951,
      provider: "internal",
      topic: "shipstation_shipment_push",
      payload: { shipmentId: 300 },
      attempts: 0,
    });

    expect(outcome).toBe("pending");
    expect(updates[0]!.set.lastError).toMatch(/ShipStation shipment push service not available/);
    expect(updates[0]!.set.status).toBeUndefined();
  });

  it("records retry failure when ShipStation push throws", async () => {
    const pushShipment = vi.fn().mockRejectedValue(new Error("ShipStation 500"));
    const { db, updates } = makeDb({
      shipStationService: {
        processShipNotify: vi.fn(),
        pushShipment,
      },
    });

    const outcome = await dispatchShipStationShipmentPushRetry(db, {
      id: 952,
      provider: "internal",
      topic: "shipstation_shipment_push",
      payload: { shipmentId: 300 },
      attempts: 0,
    });

    expect(outcome).toBe("pending");
    expect(pushShipment).toHaveBeenCalledWith(300);
    expect(updates[0]!.set).toMatchObject({
      attempts: 1,
      status: "pending",
      lastError: "ShipStation 500",
    });
  });
});

describe("dispatchShipStationRetry :: malformed payload", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dead-letters immediately when resource_url is missing", async () => {
    const ship = vi.fn();
    const { db, updates } = makeDb({ shipStationService: { processShipNotify: ship } });

    const outcome = await dispatchShipStationRetry(db, {
      id: 777,
      provider: "shipstation",
      topic: "SHIP_NOTIFY",
      payload: {} as any,
      attempts: 0,
    });

    expect(outcome).toBe("malformed");
    expect(ship).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.status).toBe("dead");
    expect(String(updates[0]!.set.lastError)).toContain("malformed payload");
  });

  it("dead-letters when payload is null", async () => {
    const { db, updates } = makeDb({ shipStationService: { processShipNotify: vi.fn() } });

    const outcome = await dispatchShipStationRetry(db, {
      id: 778,
      provider: "shipstation",
      topic: "SHIP_NOTIFY",
      payload: null as any,
      attempts: 0,
    });

    expect(outcome).toBe("malformed");
    expect(updates[0]!.set.status).toBe("dead");
  });
});

describe("dispatchShipStationRetry :: failure path", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("increments attempts and pushes next_retry_at forward on a transient failure", async () => {
    const ship = vi.fn(async () => {
      throw new Error("SS 503");
    });
    const { db, updates } = makeDb({ shipStationService: { processShipNotify: ship } });

    const before = Date.now();
    const outcome = await dispatchShipStationRetry(db, {
      id: 42,
      provider: "shipstation",
      topic: "SHIP_NOTIFY",
      payload: { resource_url: "https://ss.example/x" },
      attempts: 1, // → becomes 2, still < MAX_ATTEMPTS (5)
    });
    const after = Date.now();

    expect(outcome).toBe("pending");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.status).toBe("pending");
    expect(updates[0]!.set.attempts).toBe(2);
    expect(updates[0]!.set.lastError).toBe("SS 503");

    // Backoff is 2^attempts minutes = 2^2 = 4 minutes from now
    const nextMs = (updates[0]!.set.nextRetryAt as Date).getTime();
    expect(nextMs).toBeGreaterThanOrEqual(before + 4 * 60_000 - 50);
    expect(nextMs).toBeLessThanOrEqual(after + 4 * 60_000 + 50);
  });

  it("marks the row dead when attempts reach MAX_ATTEMPTS (5)", async () => {
    const ship = vi.fn(async () => {
      throw new Error("still failing");
    });
    const { db, updates } = makeDb({ shipStationService: { processShipNotify: ship } });

    const outcome = await dispatchShipStationRetry(db, {
      id: 99,
      provider: "shipstation",
      topic: "SHIP_NOTIFY",
      payload: { resource_url: "https://ss.example/x" },
      attempts: 4, // → becomes 5, exactly MAX_ATTEMPTS
    });

    expect(outcome).toBe("dead");
    expect(updates[0]!.set.status).toBe("dead");
    expect(updates[0]!.set.attempts).toBe(5);
    expect(updates[0]!.set.lastError).toBe("still failing");
  });
});

describe("dispatchShipStationRetry :: service not wired", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a transient failure (not dead) when db.__shipStationService is missing", async () => {
    const { db, updates } = makeDb({ shipStationService: null });

    const outcome = await dispatchShipStationRetry(db, {
      id: 1,
      provider: "shipstation",
      topic: "SHIP_NOTIFY",
      payload: { resource_url: "https://ss.example/x" },
      attempts: 0,
    });

    // attempts becomes 1, not yet at MAX_ATTEMPTS (5) → pending
    expect(outcome).toBe("pending");
    expect(updates[0]!.set.status).toBe("pending");
    expect(updates[0]!.set.attempts).toBe(1);
    expect(String(updates[0]!.set.lastError)).toMatch(/shipStation service not available/i);
  });
});

// ─── recordRetryFailure tests ────────────────────────────────────────

describe("recordRetryFailure :: MAX_ATTEMPTS boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps row pending at attempts=4 with backoff=2^4 minutes", async () => {
    const { db, updates } = makeDb();
    const before = Date.now();

    const result = await recordRetryFailure(db, { id: 1, attempts: 3 }, "boom");

    const after = Date.now();
    expect(result.attempts).toBe(4);
    expect(result.status).toBe("pending");
    const expectedDelayMs = Math.pow(2, 4) * 60_000;
    expect(result.nextRetryAt.getTime()).toBeGreaterThanOrEqual(before + expectedDelayMs - 50);
    expect(result.nextRetryAt.getTime()).toBeLessThanOrEqual(after + expectedDelayMs + 50);

    expect(updates[0]!.set.status).toBe("pending");
    expect(updates[0]!.set.attempts).toBe(4);
    expect(updates[0]!.set.lastError).toBe("boom");
  });

  it("marks row dead exactly when attempts would reach 5", async () => {
    const { db, updates } = makeDb();
    const result = await recordRetryFailure(db, { id: 1, attempts: 4 }, "final");
    expect(result.status).toBe("dead");
    expect(result.attempts).toBe(5);
    expect(updates[0]!.set.status).toBe("dead");
  });

  it("emits CRITICAL: log on dead-letter for shopify_fulfillment_push topic", async () => {
    const errSpy = vi.spyOn(console, "error");
    const { db } = makeDb();
    await recordRetryFailure(
      db,
      { id: 88, attempts: 4 },
      "final boom",
      { topic: "shopify_fulfillment_push", shipmentId: 501 },
    );
    const critical = errSpy.mock.calls.find((args) =>
      String(args[0] ?? "").startsWith("CRITICAL:"),
    );
    expect(critical).toBeDefined();
    expect(String(critical![0])).toContain(
      "CRITICAL: Shopify Fulfillment Push Dead-Lettered",
    );
    expect(String(critical![0])).toContain("Shipment ID: 501");
    expect(String(critical![0])).toContain("Queue Row ID: 88");
    expect(String(critical![0])).toContain("Attempts: 5");
    expect(String(critical![0])).toContain("final boom");
  });

  it("does NOT emit CRITICAL on transient failures (status=pending)", async () => {
    const errSpy = vi.spyOn(console, "error");
    const { db } = makeDb();
    await recordRetryFailure(
      db,
      { id: 12, attempts: 1 },
      "transient",
      { topic: "shopify_fulfillment_push", shipmentId: 9 },
    );
    const critical = errSpy.mock.calls.find((args) =>
      String(args[0] ?? "").startsWith("CRITICAL:"),
    );
    expect(critical).toBeUndefined();
  });
});

// ─── enqueueShopifyFulfillmentRetry tests (C22d) ───────────────────

describe("enqueueShopifyFulfillmentRetry :: happy path", () => {
  it("inserts a single internal/shopify_fulfillment_push row with shipmentId payload", async () => {
    const { db, inserts } = makeDb();
    const before = Date.now();

    await enqueueShopifyFulfillmentRetry(db, 501, new Error("shopify 500"));

    const after = Date.now();
    expect(inserts).toHaveLength(1);
    const row = inserts[0]!.values;
    expect(row.provider).toBe("internal");
    expect(row.topic).toBe("shopify_fulfillment_push");
    expect(row.payload).toEqual({ shipmentId: 501 });
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBe("shopify 500");
    const nextMs = (row.nextRetryAt as Date).getTime();
    expect(nextMs).toBeGreaterThanOrEqual(before + 5 * 60_000 - 50);
    expect(nextMs).toBeLessThanOrEqual(after + 5 * 60_000 + 50);
  });

  it("records a string cause as-is", async () => {
    const { db, inserts } = makeDb();
    await enqueueShopifyFulfillmentRetry(db, 7, "transport down");
    expect(inserts[0]!.values.lastError).toBe("transport down");
  });

  it("handles a non-Error/non-string cause via String() coercion", async () => {
    const { db, inserts } = makeDb();
    await enqueueShopifyFulfillmentRetry(db, 7, { code: 503 } as any);
    // Object → String() → "[object Object]"; the helper just records it,
    // it is not the helper's job to format unknown causes.
    expect(typeof inserts[0]!.values.lastError).toBe("string");
  });

  it("coerces a null cause to null lastError", async () => {
    const { db, inserts } = makeDb();
    await enqueueShopifyFulfillmentRetry(db, 7, null);
    expect(inserts[0]!.values.lastError).toBeNull();
  });

  it("does not enqueue duplicate pending Shopify fulfillment retry rows for the same shipment", async () => {
    const { db, inserts } = makeDb({
      executeRows: [{ rows: [{ id: 88 }] }],
    });

    await enqueueShopifyFulfillmentRetry(db, 501, new Error("shopify 500"));

    expect(inserts).toHaveLength(0);
  });
});

describe("enqueueShopifyFulfillmentRetry :: validation", () => {
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["float", 1.5],
    ["NaN", Number.NaN],
    ["string", "5" as any],
    ["undefined", undefined as any],
  ])("throws on %s shipmentId", async (_label, shipmentId) => {
    const { db, inserts } = makeDb();
    await expect(
      enqueueShopifyFulfillmentRetry(db, shipmentId as any, new Error("x")),
    ).rejects.toThrow(/positive integer/);
    expect(inserts).toHaveLength(0);
  });
});

describe("enqueueShopifyFulfillmentRetry :: DB failure", () => {
  it("propagates when the underlying insert throws", async () => {
    const { db } = makeDb({ insertThrows: new Error("db down") });
    await expect(
      enqueueShopifyFulfillmentRetry(db, 1, new Error("x")),
    ).rejects.toThrow(/db down/);
  });
});

// ─── dispatchShopifyFulfillmentRetry tests (C22d) ─────────────────────

describe("dispatchShopifyFulfillmentRetry :: happy path", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls pushShopifyFulfillment(shipmentId) and marks row success", async () => {
    const push = vi.fn(async (_id: number) => ({
      shopifyFulfillmentId: "gid://shopify/Fulfillment/9",
      alreadyPushed: false,
    }));
    const { db, updates } = makeDb({
      fulfillmentPush: { pushShopifyFulfillment: push },
    });

    const outcome = await dispatchShopifyFulfillmentRetry(db, {
      id: 501,
      provider: "internal",
      topic: "shopify_fulfillment_push",
      payload: { shipmentId: 42 },
      attempts: 0,
    });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(42);
    expect(outcome).toBe("success");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.status).toBe("success");
  });

  it("treats alreadyPushed=true as success (idempotent skip)", async () => {
    const push = vi.fn(async (_id: number) => ({
      shopifyFulfillmentId: "gid://shopify/Fulfillment/preexisting",
      alreadyPushed: true,
    }));
    const { db, updates } = makeDb({
      fulfillmentPush: { pushShopifyFulfillment: push },
    });

    const outcome = await dispatchShopifyFulfillmentRetry(db, {
      id: 502,
      provider: "internal",
      topic: "shopify_fulfillment_push",
      payload: { shipmentId: 43 },
      attempts: 0,
    });

    expect(outcome).toBe("success");
    expect(updates[0]!.set.status).toBe("success");
  });
});

describe("dispatchShopifyFulfillmentRetry :: malformed payload", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["missing", undefined as any],
    ["negative", -1],
    ["zero", 0],
    ["float", 1.5],
    ["string", "42" as any],
  ])("dead-letters immediately when shipmentId is %s", async (_label, badId) => {
    const push = vi.fn();
    const { db, updates } = makeDb({
      fulfillmentPush: { pushShopifyFulfillment: push as any },
    });

    const outcome = await dispatchShopifyFulfillmentRetry(db, {
      id: 600,
      provider: "internal",
      topic: "shopify_fulfillment_push",
      payload: badId === undefined ? {} : { shipmentId: badId },
      attempts: 0,
    });

    expect(outcome).toBe("malformed");
    expect(push).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.status).toBe("dead");
    expect(String(updates[0]!.set.lastError)).toContain("malformed payload");
  });

  it("dead-letters when payload is null", async () => {
    const { db, updates } = makeDb({
      fulfillmentPush: { pushShopifyFulfillment: vi.fn() as any },
    });
    const outcome = await dispatchShopifyFulfillmentRetry(db, {
      id: 601,
      provider: "internal",
      topic: "shopify_fulfillment_push",
      payload: null as any,
      attempts: 0,
    });
    expect(outcome).toBe("malformed");
    expect(updates[0]!.set.status).toBe("dead");
  });
});

describe("dispatchShopifyFulfillmentRetry :: failure path", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("increments attempts and pushes next_retry_at on transient failure", async () => {
    const push = vi.fn(async () => {
      throw new Error("shopify 503");
    });
    const { db, updates } = makeDb({
      fulfillmentPush: { pushShopifyFulfillment: push },
    });

    const before = Date.now();
    const outcome = await dispatchShopifyFulfillmentRetry(db, {
      id: 700,
      provider: "internal",
      topic: "shopify_fulfillment_push",
      payload: { shipmentId: 11 },
      attempts: 1,
    });
    const after = Date.now();

    expect(outcome).toBe("pending");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.status).toBe("pending");
    expect(updates[0]!.set.attempts).toBe(2);
    expect(updates[0]!.set.lastError).toBe("shopify 503");

    const nextMs = (updates[0]!.set.nextRetryAt as Date).getTime();
    expect(nextMs).toBeGreaterThanOrEqual(before + 4 * 60_000 - 50);
    expect(nextMs).toBeLessThanOrEqual(after + 4 * 60_000 + 50);
  });

  it("keeps pending without incrementing attempts when Shopify client is not initialized", async () => {
    const push = vi.fn(async () => {
      const err = new Error("shopify client not initialized") as any;
      err.context = { code: "shopify_push_client_not_set" };
      throw err;
    });
    const { db, updates } = makeDb({
      fulfillmentPush: { pushShopifyFulfillment: push },
    });

    const outcome = await dispatchShopifyFulfillmentRetry(db, {
      id: 702,
      provider: "internal",
      topic: "shopify_fulfillment_push",
      payload: { shipmentId: 257 },
      attempts: 4,
    });

    expect(outcome).toBe("pending");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.status).toBeUndefined();
    expect(updates[0]!.set.attempts).toBeUndefined();
    expect(updates[0]!.set.lastError).toBe(
      "shopify fulfillment push client not initialized",
    );
  });

  it("marks dead and emits CRITICAL: log when attempts hit MAX_ATTEMPTS", async () => {
    const errSpy = vi.spyOn(console, "error");
    const push = vi.fn(async () => {
      throw new Error("still failing");
    });
    const { db, updates } = makeDb({
      fulfillmentPush: { pushShopifyFulfillment: push },
    });

    const outcome = await dispatchShopifyFulfillmentRetry(db, {
      id: 701,
      provider: "internal",
      topic: "shopify_fulfillment_push",
      payload: { shipmentId: 99 },
      attempts: 4, // → 5 = MAX_ATTEMPTS
    });

    expect(outcome).toBe("dead");
    expect(updates[0]!.set.status).toBe("dead");
    expect(updates[0]!.set.attempts).toBe(5);

    const critical = errSpy.mock.calls.find((args) =>
      String(args[0] ?? "").startsWith("CRITICAL:"),
    );
    expect(critical).toBeDefined();
    expect(String(critical![0])).toContain(
      "CRITICAL: Shopify Fulfillment Push Dead-Lettered",
    );
    expect(String(critical![0])).toContain("Shipment ID: 99");
  });
});

describe("dispatchShopifyFulfillmentRetry :: service not wired", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps row pending without incrementing attempts when fulfillmentPush stash missing", async () => {
    // No fulfillmentPush key at all on db.
    const { db, updates } = makeDb();

    const outcome = await dispatchShopifyFulfillmentRetry(db, {
      id: 800,
      provider: "internal",
      topic: "shopify_fulfillment_push",
      payload: { shipmentId: 51 },
      attempts: 2,
    });

    expect(outcome).toBe("pending");
    expect(updates).toHaveLength(1);
    // attempts NOT incremented — graceful degrade.
    expect(updates[0]!.set.attempts).toBeUndefined();
    expect(updates[0]!.set.status).toBeUndefined();
    expect(String(updates[0]!.set.lastError)).toMatch(
      /fulfillment push service not available/,
    );
  });

  it("keeps pending when stash exists but pushShopifyFulfillment fn is missing", async () => {
    const { db, updates } = makeDb({
      fulfillmentPush: {} as any,
    });

    const outcome = await dispatchShopifyFulfillmentRetry(db, {
      id: 801,
      provider: "internal",
      topic: "shopify_fulfillment_push",
      payload: { shipmentId: 52 },
      attempts: 0,
    });

    expect(outcome).toBe("pending");
    expect(updates[0]!.set.attempts).toBeUndefined();
  });

  it("retries delayed tracking push when pushTracking returns false", async () => {
    const pushTracking = vi.fn(async () => false);
    const { db, updates } = makeDb({
      fulfillmentPush: { pushTracking } as any,
    });

    const outcome = await dispatchDelayedTrackingPush(db, {
      id: 900,
      provider: "internal",
      topic: "delayed_tracking_push",
      payload: { orderId: 77 },
      attempts: 1,
    });

    expect(outcome).toBe("pending");
    expect(pushTracking).toHaveBeenCalledWith(77);
    expect(updates[0]!.set.status).toBe("pending");
    expect(updates[0]!.set.attempts).toBe(2);
    expect(updates[0]!.set.lastError).toContain("fulfillment push returned false");
  });

  it("enqueues delayed tracking push with shipment scope when provided", async () => {
    const { db, inserts } = makeDb();

    await enqueueDelayedTrackingPush(db, 77, 501);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values.payload).toEqual({ orderId: 77, shipmentId: 501 });
  });

  it("does not enqueue duplicate pending delayed tracking push for the same shipment", async () => {
    const { db, inserts } = makeDb({
      executeRows: [{ rows: [{ id: 123 }] }],
    });

    await enqueueDelayedTrackingPush(db, 77, 501);

    expect(inserts).toHaveLength(0);
  });

  it("does not enqueue duplicate pending delayed tracking push for the same order-level scope", async () => {
    const { db, inserts } = makeDb({
      executeRows: [{ rows: [{ id: 124 }] }],
    });

    await enqueueDelayedTrackingPush(db, 77);

    expect(inserts).toHaveLength(0);
  });

  it("dispatches delayed tracking push through shipment-scoped handler first", async () => {
    const pushTracking = vi.fn(async () => true);
    const pushTrackingForShipment = vi.fn(async () => true);
    const { db, updates } = makeDb({
      fulfillmentPush: { pushTracking, pushTrackingForShipment } as any,
    });

    const outcome = await dispatchDelayedTrackingPush(db, {
      id: 901,
      provider: "internal",
      topic: "delayed_tracking_push",
      payload: { orderId: 77, shipmentId: 501 },
      attempts: 0,
    });

    expect(outcome).toBe("success");
    expect(pushTrackingForShipment).toHaveBeenCalledWith(501);
    expect(pushTracking).not.toHaveBeenCalled();
    expect(updates[0]!.set.status).toBe("success");
  });
});

// ─── Source-of-truth assertion on server/index.ts ────────────────────
//
// A cheap regression guard: the SS webhook route must (a) import and
// (b) actually call `enqueueShipStationRetry` inside its error branch.
// Without this, a future refactor could silently unwire the retry path.

describe("ship-notify retry :: wiring in server/index.ts", () => {
  const SRC = readFileSync(resolve(__dirname, "../../../../index.ts"), "utf8");

  it("imports enqueueShipStationRetry from the webhook-retry worker", () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*enqueueShipStationRetry[^}]*\}\s*from\s*["']\.\/modules\/oms\/webhook-retry\.worker["']/
    );
  });

  it("calls enqueueShipStationRetry inside the ship-notify handler", () => {
    // Ensure the call site is present and references resource_url
    expect(SRC).toMatch(/enqueueShipStationRetry\s*\(\s*db\s*,\s*\{\s*resource_url\s*\}\s*\)/);
  });

  it("stashes the ShipStation service on db for the retry worker to find", () => {
    expect(SRC).toMatch(/__shipStationService\s*=\s*services\.shipStation/);
  });
});
