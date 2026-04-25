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

import {
  enqueueShipStationRetry,
  dispatchShipStationRetry,
  recordRetryFailure,
} from "../../webhook-retry.worker";

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
  shipStationService?: { processShipNotify: (url: string) => Promise<number> } | null;
  insertThrows?: Error;
  updateThrows?: Error;
} = {}) {
  const inserts: RecordedInsert[] = [];
  const updates: RecordedUpdate[] = [];

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
  };

  if (opts.shipStationService !== undefined) {
    db.__shipStationService = opts.shipStationService;
  }

  return { db, inserts, updates };
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
