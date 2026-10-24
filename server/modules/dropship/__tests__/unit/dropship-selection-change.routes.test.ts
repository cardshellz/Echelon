import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropshipSelectionAtpService } from "../../application/dropship-selection-atp-service";
import {
  DropshipSelectionChangeService,
  SELECTION_CHANGE_PLAN_MOVED,
  seededJitterSource,
} from "../../application/dropship-selection-change-service";
import { CATALOG_READ_WORDS } from "../../domain/catalog-read-words";
import { DROPSHIP_CATALOG_CODE_VERSION } from "../../domain/catalog-code-version";
import { DropshipError } from "../../domain/errors";
import { PgDropshipSelectionChangeRepository } from "../../infrastructure/dropship-selection-change.repository";
import {
  DROPSHIP_BULK_JSON_LIMIT_BYTES,
  SELECTION_CHANGE_TOO_LARGE_MESSAGE,
} from "../../interfaces/http/dropship-bulk-json.middleware";
import {
  SELECTION_CHANGE_PREVIEW_RATE_LIMIT,
  SELECTION_CHANGE_RATE_LIMIT,
  registerDropshipVendorCatalogRoutes,
  selectionChangeLogger,
  statusForDropshipVendorCatalogError,
} from "../../interfaces/http/dropship-vendor-catalog.routes";
import { installGlobalJsonBodyParser } from "../../../shipping-engine/interfaces/http/rate-table-admin-body.middleware";
import { logger } from "../../../../platform/observability/logger";
import { SELECTION_CHANGE_ERROR_CODES } from "../../../../../shared/dropship/vendor-selection-changes";

/**
 * Step 1's picks save at the HTTP boundary (PLAN-B v4.1 §8, §14, §15.1): the page version before the strict body,
 * the bulk parser and the budgets, the retired PUT, a preview that writes nothing, and every §14 code's status,
 * header, log level and class (SAFETY-14, TESTS-9).
 */
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository", () => ({
  createAuthorityAwareInventoryAtpService: () => ({}),
}));

const HASH = "a".repeat(64);
const PREVIEW = "/api/dropship/catalog/selection/changes/preview";
const CHANGES = "/api/dropship/catalog/selection/changes";

const PREVIEW_ANSWER = {
  headRevisionId: 41, toAdd: 1, toRemove: 0, alreadySelected: 0, alreadyNotSelected: 0, skipped: { count: 0, first: [] },
  selectedBefore: 3, selectedAfter: 4, cap: 10_000, overCapAfter: false, refused: null,
  effects: [{ storeConnectionId: 22, storeName: "Shop", platform: "ebay", goesToZero: 0, startsSelling: 1 }], effectsHash: HASH,
};
const { headRevisionId: _head, refused: _refused, ...PLANNED } = PREVIEW_ANSWER;
const CHANGE_ANSWER = { revisionId: 42, ...PLANNED, confirmedEffectsHash: HASH, drifted: false };

class FakeAtpService {
  vendorReads = 0;
  async requireVendorForMember(memberId: string) {
    this.vendorReads += 1;
    return { vendorId: 10, memberId, status: "active", entitlementStatus: "active" };
  }
}

class FakeChangeService {
  previewInputs: unknown[] = [];
  changeInputs: unknown[] = [];
  failure: unknown = null;
  replay = false;
  async preview(input: unknown) {
    this.previewInputs.push(input);
    if (this.failure) throw this.failure;
    return PREVIEW_ANSWER;
  }
  async applyChange(input: unknown) {
    this.changeInputs.push(input);
    if (this.failure) throw this.failure;
    return { answer: CHANGE_ANSWER, idempotentReplay: this.replay };
  }
}

function previewBody(patch: Record<string, unknown> = {}) {
  return { clientVersion: 2, expectedRevisionId: 41, add: { productVariantIds: [7] }, remove: { productVariantIds: [] }, ...patch };
}

function changeBody(patch: Record<string, unknown> = {}) {
  return { ...previewBody(), idempotencyKey: "catalog-selection:0001", expectedEffectsHash: HASH, ...patch };
}

describe("the picks save routes (PLAN-B v4.1 §8)", () => {
  let server: { url: string; close: () => Promise<void> } | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
    vi.restoreAllMocks();
  });

  async function start(atp: FakeAtpService, changes: unknown, authenticated = true) {
    server = await startServer(buildApp(atp as unknown as DropshipSelectionAtpService, changes as DropshipSelectionChangeService, authenticated));
    return server.url;
  }

  it("sends the vendor, the member and the body to the service, and answers a save 201, its replay 200", async () => {
    const atp = new FakeAtpService();
    const changes = new FakeChangeService();
    const url = await start(atp, changes);

    const preview = await post(url + PREVIEW, previewBody());
    expect(preview).toMatchObject({ status: 200, body: PREVIEW_ANSWER });
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect(changes.previewInputs).toEqual([{ vendorId: 10, body: previewBody() }]);

    const saved = await post(url + CHANGES, changeBody());
    expect(saved).toMatchObject({ status: 201, body: CHANGE_ANSWER });
    expect(changes.changeInputs).toEqual([{ vendorId: 10, actor: { actorType: "vendor", actorId: "member-1" }, body: changeBody() }]);
    changes.replay = true;
    const replayed = await post(url + CHANGES, changeBody());
    expect(replayed.status).toBe(200);
    expect(replayed.text).toBe(saved.text);
  });

  it(`answers a page newer than version ${DROPSHIP_CATALOG_CODE_VERSION} with 503 before the strict body, the vendor read or the service`, async () => {
    const atp = new FakeAtpService();
    const changes = new FakeChangeService();
    const url = await start(atp, changes);
    const newer = DROPSHIP_CATALOG_CODE_VERSION + 1;

    for (const [path, body] of [
      [PREVIEW, previewBody({ clientVersion: newer, aFieldOfPrC: { ends: true } })],
      [CHANGES, changeBody({ clientVersion: newer, aFieldOfPrC: { ends: true } })],
    ] as const) {
      const response = await post(url + path, body);
      expect(response.status, path).toBe(503);
      expect(response.headers.get("retry-after"), path).toBe("5");
      expect(response.body.error, path).toMatchObject({ code: "DROPSHIP_SELECTION_WRITES_PAUSED", message: CATALOG_READ_WORDS.pageNewerThanServer,
        context: { reason: "page_newer_than_server", clientVersion: newer, serverVersion: DROPSHIP_CATALOG_CODE_VERSION } });
    }
    expect(atp.vendorReads).toBe(0);
    expect([...changes.previewInputs, ...changes.changeInputs]).toEqual([]);

    // This release's page with an unknown field is the strict schema's to refuse (the real service's, below).
    const real = realService(scriptedPool().pool);
    await server?.close();
    const realUrl = await start(new FakeAtpService(), real);
    const unknown = await post(realUrl + PREVIEW, previewBody({ aFieldOfPrC: true }));
    expect(unknown).toMatchObject({ status: 400, body: { error: { code: "DROPSHIP_SELECTION_CHANGE_INVALID_INPUT" } } });
  });

  it("parses a 20,000-id body with the bulk parser and answers 413 above 1 MiB with the save's words", async () => {
    const changes = new FakeChangeService();
    const url = await start(new FakeAtpService(), changes);
    const big = changeBody({
      add: { productVariantIds: Array.from({ length: 10_000 }, (_, index) => index + 1) },
      remove: { productVariantIds: Array.from({ length: 10_000 }, (_, index) => index + 20_001) },
    });
    expect(JSON.stringify(big).length).toBeGreaterThan(100 * 1024);
    expect((await post(url + CHANGES, big)).status).toBe(201);
    expect(changes.changeInputs).toHaveLength(1);
    expect((await post(url + PREVIEW, { ...big, idempotencyKey: undefined })).status).toBe(200);

    const tooLarge = await post(url + CHANGES, changeBody({ padding: "x".repeat(DROPSHIP_BULK_JSON_LIMIT_BYTES + 1) }));
    expect(tooLarge).toMatchObject({ status: 413, body: { error: { code: "DROPSHIP_REQUEST_TOO_LARGE", message: SELECTION_CHANGE_TOO_LARGE_MESSAGE } } });
    expect(changes.changeInputs).toHaveLength(1);
  });

  it(`spends ${SELECTION_CHANGE_PREVIEW_RATE_LIMIT}/min on previews and ${SELECTION_CHANGE_RATE_LIMIT}/min on saves, per member`, async () => {
    const url = await start(new FakeAtpService(), new FakeChangeService());
    for (let call = 0; call < SELECTION_CHANGE_RATE_LIMIT; call += 1) expect((await post(url + CHANGES, changeBody())).status).toBe(201);
    expect(await post(url + CHANGES, changeBody())).toMatchObject({ status: 429, body: { error: { code: "DROPSHIP_CATALOG_READ_RATE_LIMITED" } } });
    for (let call = 0; call < SELECTION_CHANGE_PREVIEW_RATE_LIMIT; call += 1) expect((await post(url + PREVIEW, previewBody())).status).toBe(200);
    expect((await post(url + PREVIEW, previewBody())).status).toBe(429);
  });

  it("refuses both routes without a vendor session before the budget, the parser or a service call", async () => {
    const changes = new FakeChangeService();
    const url = await start(new FakeAtpService(), changes, false);
    expect((await post(url + PREVIEW, previewBody())).status).toBe(401);
    expect((await post(url + CHANGES, changeBody())).status).toBe(401);
    expect([...changes.previewInputs, ...changes.changeInputs]).toEqual([]);
  });

  it("answers the old rules PUT 410 with the reload words and calls no service", async () => {
    const atp = new FakeAtpService();
    const changes = new FakeChangeService();
    const url = await start(atp, changes);
    const response = await request(url + "/api/dropship/catalog/selection-rules", "PUT", JSON.stringify({ rules: [] }));
    expect(response).toMatchObject({ status: 410, body: { error: { code: "DROPSHIP_SELECTION_RULES_RETIRED", message: CATALOG_READ_WORDS.retired } } });
    expect(atp.vendorReads).toBe(0);
    expect([...changes.previewInputs, ...changes.changeInputs]).toEqual([]);
  });

  it("previews in one read-only snapshot: BEGIN REPEATABLE READ READ ONLY, reads, COMMIT, and nothing else", async () => {
    const scripted = scriptedPool();
    const url = await start(new FakeAtpService(), realService(scripted.pool));
    const response = await post(url + PREVIEW, previewBody({ add: { productVariantIds: [7, 8] }, remove: { productVariantIds: [9] } }));
    expect(response).toMatchObject({ status: 200, body: { headRevisionId: 41, toAdd: 0, toRemove: 0, skipped: { count: 2, first: [7, 8] },
      alreadyNotSelected: 1, effects: [] } });
    const statements = scripted.statements;
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements.at(-1)).toBe("COMMIT");
    for (const statement of statements.slice(1, -1)) {
      expect(statement, statement).toMatch(/^(SELECT|WITH)\b/i);
      expect(statement, statement).not.toMatch(/\b(INSERT|UPDATE|DELETE|LOCK TABLE|FOR UPDATE|FOR KEY SHARE|pg_advisory)/i);
    }
    expect(statements.length).toBeGreaterThan(5);
    expect(scripted.released()).toBe(1);
  });
});

describe("every §14 code's answer (SAFETY-14, TESTS-9)", () => {
  let server: { url: string; close: () => Promise<void> } | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
    vi.restoreAllMocks();
  });

  type Row = {
    label: string; code: string; status: number; context: Record<string, unknown>;
    level: "debug" | "info" | "warn" | "error"; errorClass: "transient" | "permanent" | "fatal"; retryAfter: boolean;
    /** Correlation the line carries besides the session vendor and the page's revision (SRV-2). */
    log?: Record<string, unknown>;
  };
  const ROWS: Row[] = [
    { label: "invalid input", code: SELECTION_CHANGE_ERROR_CODES.invalidInput, status: 400, context: { classification: "permanent" },
      level: "debug", errorClass: "permanent", retryAfter: false },
    { label: "conflicting", code: SELECTION_CHANGE_ERROR_CODES.conflicting, status: 400, context: { classification: "permanent" },
      level: "debug", errorClass: "permanent", retryAfter: false },
    { label: "reserved key", code: SELECTION_CHANGE_ERROR_CODES.keyReserved, status: 400, context: { classification: "permanent" },
      level: "debug", errorClass: "permanent", retryAfter: false },
    { label: "key conflict", code: SELECTION_CHANGE_ERROR_CODES.keyConflict, status: 409,
      context: { vendorId: 10, revisionId: 39, classification: "permanent" },
      level: "debug", errorClass: "permanent", retryAfter: false, log: { revision_id: 39 } },
    { label: "revision conflict", code: SELECTION_CHANGE_ERROR_CODES.revisionConflict, status: 409,
      context: { vendorId: 10, expectedRevisionId: 41, currentRevisionId: 43, classification: "permanent" },
      level: "debug", errorClass: "permanent", retryAfter: false, log: { current_revision_id: 43 } },
    { label: "effects changed", code: SELECTION_CHANGE_ERROR_CODES.effectsChanged, status: 409, context: { classification: "permanent" },
      level: "debug", errorClass: "permanent", retryAfter: false },
    { label: "busy", code: SELECTION_CHANGE_ERROR_CODES.busy, status: 409, context: { classification: "transient", retryable: true },
      level: "debug", errorClass: "transient", retryAfter: false },
    { label: "too large", code: SELECTION_CHANGE_ERROR_CODES.tooLarge, status: 422, context: { classification: "permanent" },
      level: "debug", errorClass: "permanent", retryAfter: false },
    { label: "paused: older version", code: SELECTION_CHANGE_ERROR_CODES.writesPaused, status: 503,
      context: { reason: "older_version_running", classification: "transient" }, level: "debug", errorClass: "transient", retryAfter: true },
    { label: "paused: disabled", code: SELECTION_CHANGE_ERROR_CODES.writesPaused, status: 503,
      context: { reason: "disabled", classification: "transient" }, level: "debug", errorClass: "transient", retryAfter: true },
    { label: "a count the reads disagree on", code: "DROPSHIP_SELECTION_COUNT_INCONSISTENT", status: 500,
      context: { classification: "fatal" }, level: "error", errorClass: "fatal", retryAfter: false },
  ];

  it.each(ROWS)("$label: $code answers $status", async (row) => {
    const levels = {
      debug: vi.spyOn(logger, "debug").mockImplementation(() => undefined),
      info: vi.spyOn(logger, "info").mockImplementation(() => undefined),
      warn: vi.spyOn(logger, "warn").mockImplementation(() => undefined),
      error: vi.spyOn(logger, "error").mockImplementation(() => undefined),
    };
    const changes = new FakeChangeService();
    changes.failure = new DropshipError(row.code, "Refused.", row.context);
    server = await startServer(buildApp(new FakeAtpService() as unknown as DropshipSelectionAtpService,
      changes as unknown as DropshipSelectionChangeService));

    for (const [path, body] of [[PREVIEW, previewBody()], [CHANGES, changeBody()]] as const) {
      for (const level of Object.values(levels)) level.mockClear();
      const response = await post(server.url + path, body);
      expect(response.status, path).toBe(row.status);
      expect(response.body.error.code, path).toBe(row.code);
      expect(response.headers.get("retry-after"), path).toBe(row.retryAfter ? "5" : null);
      // Every line carries the session vendor and the revision ids (PLAN-B v4.1 §14; SRV-2), whatever the error's context holds.
      expect(levels[row.level], path).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        error_code: row.code, error_class: row.errorClass, status: row.status, actor_id: "member-1",
        vendor_id: 10, expected_revision_id: 41, current_revision_id: null, revision_id: null, ...row.log }));
      for (const [name, spy] of Object.entries(levels)) if (name !== row.level) expect(spy, `${path} ${name}`).not.toHaveBeenCalled();
    }
  });

  // SRV-3 / TST-5: the third paused reason, refused by the routes' own body check before the vendor read or the service.
  it("paused: page newer than server answers 503 with Retry-After 5 and logs DEBUG transient, with no vendor read yet", async () => {
    const levels = {
      debug: vi.spyOn(logger, "debug").mockImplementation(() => undefined),
      info: vi.spyOn(logger, "info").mockImplementation(() => undefined),
      warn: vi.spyOn(logger, "warn").mockImplementation(() => undefined),
      error: vi.spyOn(logger, "error").mockImplementation(() => undefined),
    };
    const atp = new FakeAtpService();
    const changes = new FakeChangeService();
    server = await startServer(buildApp(atp as unknown as DropshipSelectionAtpService, changes as unknown as DropshipSelectionChangeService));
    const newer = DROPSHIP_CATALOG_CODE_VERSION + 1;

    for (const [path, body] of [[PREVIEW, previewBody({ clientVersion: newer })], [CHANGES, changeBody({ clientVersion: newer })]] as const) {
      for (const level of Object.values(levels)) level.mockClear();
      const response = await post(server.url + path, body);
      expect(response.status, path).toBe(503);
      expect(response.headers.get("retry-after"), path).toBe("5");
      expect(response.body.error, path).toMatchObject({ code: SELECTION_CHANGE_ERROR_CODES.writesPaused,
        context: { reason: "page_newer_than_server", classification: "transient" } });
      expect(levels.debug, path).toHaveBeenCalledWith("dropship.vendor_catalog.request_refused", expect.objectContaining({
        error_code: SELECTION_CHANGE_ERROR_CODES.writesPaused, error_class: "transient", status: 503, outcome: "deferred",
        actor_id: "member-1", vendor_id: null, expected_revision_id: 41 }));
      for (const name of ["info", "warn", "error"] as const) expect(levels[name], `${path} ${name}`).not.toHaveBeenCalled();
    }
    expect(atp.vendorReads).toBe(0);
    expect([...changes.previewInputs, ...changes.changeInputs]).toEqual([]);
  });

  it("logs a revision id from the body only when it is a whole positive id; anything else is null (the body is untrusted)", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const changes = new FakeChangeService();
    changes.failure = new DropshipError(SELECTION_CHANGE_ERROR_CODES.invalidInput, "Refused.", { classification: "permanent" });
    server = await startServer(buildApp(new FakeAtpService() as unknown as DropshipSelectionAtpService,
      changes as unknown as DropshipSelectionChangeService));
    for (const expectedRevisionId of ["41", 1.5, -1, 0, 2 ** 31, null, { id: 41 }]) {
      debug.mockClear();
      expect((await post(server.url + CHANGES, changeBody({ expectedRevisionId }))).status).toBe(400);
      expect(debug, JSON.stringify(expectedRevisionId)).toHaveBeenCalledWith("dropship.vendor_catalog.request_refused",
        expect.objectContaining({ vendor_id: 10, expected_revision_id: null }));
    }
  });

  it("a server fault (500) logs ERROR with the session vendor and the page's revision", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const changes = new FakeChangeService();
    changes.failure = new Error("Stored picks change result of revision 7 failed its contract.");
    server = await startServer(buildApp(new FakeAtpService() as unknown as DropshipSelectionAtpService,
      changes as unknown as DropshipSelectionChangeService));
    const response = await post(server.url + CHANGES, changeBody());
    expect(response).toMatchObject({ status: 500, body: { error: { code: "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR" } } });
    expect(error).toHaveBeenCalledWith("dropship.vendor_catalog.request_failed", expect.objectContaining({
      error_class: "fatal", actor_id: "member-1", vendor_id: 10, expected_revision_id: 41 }));
  });

  it("names every save code: none falls through to the default 400 by accident", () => {
    const expected: Record<string, number> = {
      [SELECTION_CHANGE_ERROR_CODES.invalidInput]: 400,
      [SELECTION_CHANGE_ERROR_CODES.conflicting]: 400,
      [SELECTION_CHANGE_ERROR_CODES.keyReserved]: 400,
      [SELECTION_CHANGE_ERROR_CODES.keyConflict]: 409,
      [SELECTION_CHANGE_ERROR_CODES.revisionConflict]: 409,
      [SELECTION_CHANGE_ERROR_CODES.effectsChanged]: 409,
      [SELECTION_CHANGE_ERROR_CODES.busy]: 409,
      [SELECTION_CHANGE_ERROR_CODES.tooLarge]: 422,
      [SELECTION_CHANGE_ERROR_CODES.writesPaused]: 503,
      [SELECTION_CHANGE_ERROR_CODES.rulesRetired]: 410,
      DROPSHIP_SELECTION_COUNT_INCONSISTENT: 500,
      // Internal and retried inside the request; if one ever escaped it is the server's fault.
      [SELECTION_CHANGE_PLAN_MOVED]: 500,
    };
    for (const [code, status] of Object.entries(expected)) expect(statusForDropshipVendorCatalogError(code), code).toBe(status);
    // Every code of the contract has a row above, except the two no route of this server answers through the map:
    // the bulk parser's own 413 (asserted above) and PR C's page-outdated 409.
    const answeredElsewhere = new Set([SELECTION_CHANGE_ERROR_CODES.requestTooLarge, SELECTION_CHANGE_ERROR_CODES.pageOutdated]);
    for (const code of Object.values(SELECTION_CHANGE_ERROR_CODES)) {
      if (!answeredElsewhere.has(code as never)) expect(expected, code).toHaveProperty([code]);
    }
  });

  it("answers the retired PUT 410, logged at INFO as permanent", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    server = await startServer(buildApp(new FakeAtpService() as unknown as DropshipSelectionAtpService,
      new FakeChangeService() as unknown as DropshipSelectionChangeService));
    const response = await request(server.url + "/api/dropship/catalog/selection-rules", "PUT", "{}");
    expect(response.status).toBe(410);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(info).toHaveBeenCalledWith("dropship.selection.rules_retired_refused", expect.objectContaining({
      error_code: "DROPSHIP_SELECTION_RULES_RETIRED", error_class: "permanent", status: 410 }));
  });
});

describe("the picks save's log lines", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("writes each event under its own name with its context, at its level; a context can never rename or re-level it", () => {
    const spies = {
      debug: vi.spyOn(logger, "debug").mockImplementation(() => undefined),
      info: vi.spyOn(logger, "info").mockImplementation(() => undefined),
      warn: vi.spyOn(logger, "warn").mockImplementation(() => undefined),
      error: vi.spyOn(logger, "error").mockImplementation(() => undefined),
    };
    const lines = selectionChangeLogger();
    lines.info({ code: "dropship.selection.changed", message: "Changed.", context: { vendor_id: 10, revision_id: 42, action: "x", level: "error" } });
    lines.warn({ code: "dropship.selection.change_busy", message: "Busy.", context: { error_class: "transient" } });
    lines.debug?.({ code: "dropship.selection.change_retry", message: "Retry." });
    expect(spies.info).toHaveBeenCalledWith("dropship.selection.changed", { message: "Changed.", vendor_id: 10, revision_id: 42 });
    expect(spies.warn).toHaveBeenCalledWith("dropship.selection.change_busy", { message: "Busy.", error_class: "transient" });
    expect(spies.debug).toHaveBeenCalledWith("dropship.selection.change_retry", { message: "Retry." });
    expect(spies.error).not.toHaveBeenCalled();
  });
});

/** The real service and repository on a pool whose every query answers an empty result (or the one row a count needs). */
function realService(pool: Pick<Pool, "connect">): DropshipSelectionChangeService {
  return new DropshipSelectionChangeService({
    repository: new PgDropshipSelectionChangeRepository(pool),
    clock: { now: () => new Date("2026-10-24T12:00:00.000Z") },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    sleep: async () => undefined,
    random: seededJitterSource(1),
    picksWritesDisabled: () => false,
  });
}

function scriptedPool() {
  const statements: string[] = [];
  let released = 0;
  const client = {
    query: vi.fn(async (sql: string) => {
      const text = sql.trim().replace(/\s+/g, " ");
      statements.push(text);
      if (/max\(id\) AS id/.test(text)) return { rows: [{ id: 41 }], rowCount: 1 };
      if (/AS untouched_pick_count/.test(text)) return { rows: [{ untouched_pick_count: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    release: () => { released += 1; },
  };
  const pool = { connect: async () => client } as unknown as Pick<Pool, "connect">;
  return { pool, statements, released: () => released };
}

function buildApp(atp: DropshipSelectionAtpService, changes: DropshipSelectionChangeService, authenticated = true): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = authenticated
      ? { dropship: { authIdentityId: 1, memberId: "member-1", authMethod: "password", entitlementStatus: "active" } }
      : {};
    next();
  });
  // Production's global parser (100 KiB), which skips the bulk paths (server/index.ts).
  installGlobalJsonBodyParser(app);
  registerDropshipVendorCatalogRoutes(app, atp, changes);
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => { listener.close((error) => (error ? reject(error) : resolve())); }),
  };
}

async function post(url: string, body: unknown) {
  return request(url, "POST", JSON.stringify(body));
}

/** An answer's JSON: a refusal's `error`, or an answer's fields. */
interface AnswerBody { error: { code: string; message?: string; context?: unknown }; [field: string]: unknown }

async function request(url: string, method: string, body: string): Promise<{ status: number; headers: Headers; text: string; body: AnswerBody }> {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
}
