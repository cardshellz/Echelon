import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DropshipCatalogArrivalsService,
  type CatalogAcknowledgeTransaction,
  type CatalogNewForVendorFacts,
  type DropshipCatalogArrivalsRepository,
} from "../../application/dropship-catalog-arrivals-service";
import type { DropshipSelectionAtpService } from "../../application/dropship-selection-atp-service";
import type { DropshipSelectionChangeService } from "../../application/dropship-selection-change-service";
import { CATALOG_ARRIVALS_ERROR_CODES, type CatalogNoticeMark } from "../../domain/catalog-arrivals";
import { CATALOG_READ_WORDS } from "../../domain/catalog-read-words";
import { DROPSHIP_CATALOG_CODE_VERSION } from "../../domain/catalog-code-version";
import { DropshipError } from "../../domain/errors";
import { isDropshipBulkJsonRequest } from "../../interfaces/http/dropship-bulk-json.middleware";
import {
  CATALOG_NEW_ITEMS_RATE_LIMIT,
  CATALOG_NOTICE_ACKNOWLEDGE_RATE_LIMIT,
  registerDropshipVendorCatalogRoutes,
  statusForDropshipVendorCatalogError,
  type DropshipCatalogNewItemsRouteService,
} from "../../interfaces/http/dropship-vendor-catalog.routes";
import { GLOBAL_JSON_LIMIT_BYTES, installGlobalJsonBodyParser } from "../../../shipping-engine/interfaces/http/rate-table-admin-body.middleware";
import { logger } from "../../../../platform/observability/logger";
import { DROPSHIP_CATALOG_READ_ERROR_CODES } from "../../../../../shared/dropship/vendor-catalog-reads";

/**
 * Step 1's new-items notice at the HTTP boundary (PLAN-B v4.1 §11.4, §14, §15.1; TESTS-8): both routes read the
 * page version first (SAFETY-13), spend their own member budgets, answer the session vendor's notice only, parse
 * their answers outbound, and "Got it" stays on the global body parser. The real arrivals service runs on an
 * in-memory repository where a case needs its audit row or its idempotency.
 */
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository", () => ({
  createAuthorityAwareInventoryAtpService: () => ({}),
}));

const NEW_ITEMS = "/api/dropship/catalog/new-items";
const ACKNOWLEDGE = "/api/dropship/catalog/new-items/acknowledge";
const SESSION_VENDOR = 10;
const NOW = new Date("2026-10-24T12:00:00.000Z");

const NEW_ITEMS_ANSWER = {
  categories: [{ categoryId: 7, categoryName: "Armalope", productCount: 2, sizeCount: 3, throughArrivalId: 41 }],
};

class FakeAtpService {
  vendorReads: string[] = [];
  async requireVendorForMember(memberId: string) {
    this.vendorReads.push(memberId);
    return { vendorId: memberId === "member-2" ? 20 : SESSION_VENDOR, memberId, status: "active", entitlementStatus: "active" };
  }
}

class FakeNewItemsService implements DropshipCatalogNewItemsRouteService {
  readInputs: unknown[] = [];
  acknowledgeInputs: unknown[] = [];
  readAnswer: unknown = NEW_ITEMS_ANSWER;
  acknowledgeAnswer: unknown = { outcome: "acknowledged", categoryId: 7, seenThroughArrivalId: 41 };
  failure: unknown = null;
  async readNewItems(input: unknown) {
    this.readInputs.push(input);
    if (this.failure) throw this.failure;
    return this.readAnswer as Awaited<ReturnType<DropshipCatalogNewItemsRouteService["readNewItems"]>>;
  }
  async acknowledge(input: unknown) {
    this.acknowledgeInputs.push(input);
    if (this.failure) throw this.failure;
    return this.acknowledgeAnswer as Awaited<ReturnType<DropshipCatalogNewItemsRouteService["acknowledge"]>>;
  }
}

/**
 * The marks, arrivals and audit rows of one database, for the real service's "Got it" and its read. Every call
 * records the vendor it was asked for, so a case can prove nothing outside the session vendor is read or written.
 */
class InMemoryNoticeRepository implements DropshipCatalogArrivalsRepository {
  marks = new Map<string, { seen: number; notified: number }>();
  maxArrivalId = 41;
  audits: Array<Record<string, unknown>> = [];
  vendorsTouched: number[] = [];

  runLedgerTransaction(): Promise<never> { throw new Error("not used"); }
  ledgerOnPool(): never { throw new Error("not used"); }
  async readMaxArrivalId() { return this.maxArrivalId; }
  async listVendorsWithPicks(): Promise<Array<{ vendorId: number; status: string }>> { throw new Error("not used"); }
  async readSellFromCategoryIds({ vendorId }: { vendorId: number }) {
    this.vendorsTouched.push(vendorId);
    return [7];
  }
  async listMarks(): Promise<CatalogNoticeMark[]> { throw new Error("not used"); }
  async insertFirstMarks(): Promise<number> { throw new Error("not used"); }
  async readNewForVendorFacts({ vendorId }: { vendorId: number }): Promise<CatalogNewForVendorFacts> {
    this.vendorsTouched.push(vendorId);
    const mark = this.marks.get(`${vendorId}:7`);
    return {
      marks: mark ? [{ categoryId: 7, seenThroughArrivalId: mark.seen, notifiedThroughArrivalId: mark.notified }] : [],
      arrivals: [41, 40].map((arrivalId) => ({ arrivalId, productVariantId: arrivalId + 100, productId: 5, categoryId: 7, baseline: false,
        picked: false, turnedOff: false })),
      subjects: [140, 141].map((productVariantId) => ({ productVariantId, productId: 5, productLineIds: [], category: "Armalope",
        categoryId: 7, productIsActive: true, variantIsActive: true })),
      exposureRules: [{ id: 1, scopeType: "catalog", action: "include" }],
      categoryNames: [{ categoryId: 7, name: "Armalope" }],
    };
  }
  async advanceNotifiedMarks(): Promise<number> { throw new Error("not used"); }
  async runAcknowledge<T>(work: (tx: CatalogAcknowledgeTransaction) => Promise<T>): Promise<T> {
    const staged = new Map(this.marks);
    const audits: Array<Record<string, unknown>> = [];
    const tx: CatalogAcknowledgeTransaction = {
      readMaxArrivalId: async () => this.maxArrivalId,
      lockMark: async ({ vendorId, categoryId }) => {
        this.vendorsTouched.push(vendorId);
        const mark = staged.get(`${vendorId}:${categoryId}`);
        return mark ? { categoryId, seenThroughArrivalId: mark.seen, notifiedThroughArrivalId: mark.notified } : null;
      },
      upsertMark: async ({ vendorId, categoryId, seenThroughArrivalId, notifiedThroughArrivalId }) => {
        this.vendorsTouched.push(vendorId);
        const key = `${vendorId}:${categoryId}`;
        const before = staged.get(key);
        const after = { seen: Math.max(before?.seen ?? 0, seenThroughArrivalId), notified: Math.max(before?.notified ?? 0, notifiedThroughArrivalId) };
        if (before && before.seen === after.seen && before.notified === after.notified) return false;
        staged.set(key, after);
        return true;
      },
      insertAudit: async (input) => {
        this.vendorsTouched.push(input.vendorId);
        audits.push({ ...input });
      },
    };
    const result = await work(tx);
    // COMMIT: the mark and its audit row together; a throw above leaves both as they were.
    this.marks = staged;
    this.audits.push(...audits);
    return result;
  }
}

function realNewItemsService(repository: DropshipCatalogArrivalsRepository): DropshipCatalogArrivalsService {
  return new DropshipCatalogArrivalsService({
    repository,
    notifications: { listEventsByKey: async () => [], send: async () => { throw new Error("not used"); } },
    followUp: { runStage: async () => { throw new Error("not used"); } },
    clock: { now: () => NOW },
    timer: () => 0,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    catalogUrl: null,
  });
}

describe("the new-items notice routes (PLAN-B v4.1 §11.4)", () => {
  let server: { url: string; close: () => Promise<void> } | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
    vi.restoreAllMocks();
  });

  async function start(newItems: DropshipCatalogNewItemsRouteService, options: { atp?: FakeAtpService; member?: string | null } = {}) {
    server = await startServer(buildApp(options.atp ?? new FakeAtpService(), newItems, options.member === undefined ? "member-1" : options.member));
    return server.url;
  }

  it("answers the session vendor's notice, parsed with its contract, never cached", async () => {
    const atp = new FakeAtpService();
    const newItems = new FakeNewItemsService();
    // A field a later release adds is dropped on the way out, never sent unchecked.
    newItems.readAnswer = { categories: [{ ...NEW_ITEMS_ANSWER.categories[0], internalNote: "x" }], debug: true };
    const url = await start(newItems, { atp });

    const response = await get(`${url}${NEW_ITEMS}?clientVersion=${DROPSHIP_CATALOG_CODE_VERSION}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(NEW_ITEMS_ANSWER);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(atp.vendorReads).toEqual(["member-1"]);
    expect(newItems.readInputs).toEqual([{ vendorId: SESSION_VENDOR }]);
  });

  it("sends Got it for the session vendor and member only; a body naming a vendor is refused before any read", async () => {
    const atp = new FakeAtpService();
    const newItems = new FakeNewItemsService();
    const url = await start(newItems, { atp });

    const saved = await post(url + ACKNOWLEDGE, { clientVersion: 2, categoryId: 7, throughArrivalId: 41 });
    expect(saved).toMatchObject({ status: 200, body: { outcome: "acknowledged", categoryId: 7, seenThroughArrivalId: 41 } });
    expect(newItems.acknowledgeInputs).toEqual([{
      vendorId: SESSION_VENDOR, actor: { actorType: "vendor", actorId: "member-1" }, categoryId: 7, throughArrivalId: 41,
    }]);

    // Another vendor's category can never be named: the body is strict and the vendor is always the session's.
    const forged = await post(url + ACKNOWLEDGE, { categoryId: 7, throughArrivalId: 41, vendorId: 20 });
    expect(forged).toMatchObject({ status: 400, body: { error: { code: "DROPSHIP_CATALOG_NEW_ITEMS_INVALID_INPUT",
      context: { issues: ["unrecognized_keys"], classification: "permanent" } } } });
    expect(atp.vendorReads).toEqual(["member-1"]);
    expect(newItems.acknowledgeInputs).toHaveLength(1);
  });

  it(`answers a page newer than version ${DROPSHIP_CATALOG_CODE_VERSION} with 503 on both routes before the body, the vendor read or the service`, async () => {
    const atp = new FakeAtpService();
    const newItems = new FakeNewItemsService();
    const url = await start(newItems, { atp });
    const newer = DROPSHIP_CATALOG_CODE_VERSION + 1;

    const read = await get(`${url}${NEW_ITEMS}?clientVersion=${newer}`);
    // A later page's Got it with a field this server does not know: still 503 "try again", never a permanent 400.
    const acknowledged = await post(url + ACKNOWLEDGE, { clientVersion: newer, categoryId: 7, throughArrivalId: 41, aFieldOfPrC: true });
    for (const response of [read, acknowledged]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(response.body.error).toMatchObject({ code: "DROPSHIP_SELECTION_WRITES_PAUSED", message: CATALOG_READ_WORDS.pageNewerThanServer,
        context: { reason: "page_newer_than_server", clientVersion: newer, serverVersion: DROPSHIP_CATALOG_CODE_VERSION } });
    }
    expect(atp.vendorReads).toEqual([]);
    expect([...newItems.readInputs, ...newItems.acknowledgeInputs]).toEqual([]);

    // This release's page: an unknown field is the strict schema's to refuse, and a malformed version is refused.
    expect(await post(url + ACKNOWLEDGE, { clientVersion: 2, categoryId: 7, throughArrivalId: 41, aFieldOfPrC: true }))
      .toMatchObject({ status: 400, body: { error: { code: "DROPSHIP_CATALOG_NEW_ITEMS_INVALID_INPUT" } } });
    expect(await post(url + ACKNOWLEDGE, { clientVersion: "3", categoryId: 7, throughArrivalId: 41 }))
      .toMatchObject({ status: 400, body: { error: { code: "DROPSHIP_CATALOG_NEW_ITEMS_INVALID_INPUT", context: { issues: ["clientVersion"] } } } });
    expect(await get(`${url}${NEW_ITEMS}?clientVersion=two`))
      .toMatchObject({ status: 400, body: { error: { code: "DROPSHIP_CATALOG_QUERY_INVALID", context: { parameter: "clientVersion" } } } });
    for (const body of [{ categoryId: 0, throughArrivalId: 41 }, { categoryId: 7, throughArrivalId: 0 }, { categoryId: 7 },
      { categoryId: 7, throughArrivalId: 1.5 }, { categoryId: 7, throughArrivalId: Number.MAX_SAFE_INTEGER + 2 }]) {
      expect((await post(url + ACKNOWLEDGE, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect([...newItems.readInputs, ...newItems.acknowledgeInputs]).toEqual([]);
  });

  it(`spends ${CATALOG_NEW_ITEMS_RATE_LIMIT}/min on reads and ${CATALOG_NOTICE_ACKNOWLEDGE_RATE_LIMIT}/min on Got it, per member`, async () => {
    const newItems = new FakeNewItemsService();
    const url = await start(newItems);
    for (let call = 0; call < CATALOG_NEW_ITEMS_RATE_LIMIT; call += 1) expect((await get(url + NEW_ITEMS)).status).toBe(200);
    expect(await get(url + NEW_ITEMS)).toMatchObject({ status: 429, body: { error: { code: "DROPSHIP_CATALOG_READ_RATE_LIMITED" } } });
    for (let call = 0; call < CATALOG_NOTICE_ACKNOWLEDGE_RATE_LIMIT; call += 1) {
      expect((await post(url + ACKNOWLEDGE, { categoryId: 7, throughArrivalId: 41 })).status).toBe(200);
    }
    expect((await post(url + ACKNOWLEDGE, { categoryId: 7, throughArrivalId: 41 })).status).toBe(429);
    expect(newItems.readInputs).toHaveLength(CATALOG_NEW_ITEMS_RATE_LIMIT);
    expect(newItems.acknowledgeInputs).toHaveLength(CATALOG_NOTICE_ACKNOWLEDGE_RATE_LIMIT);
  });

  it("refuses both routes without a vendor session before the budget or a service call", async () => {
    const newItems = new FakeNewItemsService();
    const url = await start(newItems, { member: null });
    expect((await get(url + NEW_ITEMS)).status).toBe(401);
    expect((await post(url + ACKNOWLEDGE, { categoryId: 7, throughArrivalId: 41 })).status).toBe(401);
    expect([...newItems.readInputs, ...newItems.acknowledgeInputs]).toEqual([]);
  });

  it("writes one audit row with the mark on the first Got it; a second press is already_seen with no row; past the newest arrival is 400", async () => {
    const repository = new InMemoryNoticeRepository();
    repository.marks.set(`${SESSION_VENDOR}:7`, { seen: 30, notified: 41 });
    // Another vendor's mark of the same category, which nothing here may read or move.
    repository.marks.set("20:7", { seen: 5, notified: 5 });
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const url = await start(realNewItemsService(repository));

    expect(await get(url + NEW_ITEMS)).toMatchObject({ status: 200, body: { categories: [
      { categoryId: 7, categoryName: "Armalope", productCount: 1, sizeCount: 2, throughArrivalId: 41 },
    ] } });
    const first = await post(url + ACKNOWLEDGE, { clientVersion: 2, categoryId: 7, throughArrivalId: 41 });
    expect(first).toMatchObject({ status: 200, body: { outcome: "acknowledged", categoryId: 7, seenThroughArrivalId: 41 } });
    expect(repository.audits).toEqual([{
      vendorId: SESSION_VENDOR, categoryId: 7, actor: { actorType: "vendor", actorId: "member-1" }, now: NOW,
      payload: { categoryId: 7, throughArrivalId: 41, before: { seenThroughArrivalId: 30, notifiedThroughArrivalId: 41 },
        after: { seenThroughArrivalId: 41, notifiedThroughArrivalId: 41 } },
    }]);
    expect(await get(url + NEW_ITEMS)).toMatchObject({ status: 200, body: { categories: [] } });

    const again = await post(url + ACKNOWLEDGE, { categoryId: 7, throughArrivalId: 41 });
    expect(again).toMatchObject({ status: 200, body: { outcome: "already_seen", categoryId: 7, seenThroughArrivalId: 41 } });
    expect(repository.audits).toHaveLength(1);

    const past = await post(url + ACKNOWLEDGE, { categoryId: 7, throughArrivalId: 42 });
    expect(past).toMatchObject({ status: 400, body: { error: { code: CATALOG_ARRIVALS_ERROR_CODES.acknowledgeInvalid,
      context: { maxArrivalId: 41, throughArrivalId: 42 } } } });
    expect(past.headers.get("retry-after")).toBeNull();
    expect(debug).toHaveBeenCalledWith("dropship.vendor_catalog.request_refused", expect.objectContaining({
      error_code: "DROPSHIP_CATALOG_NOTICE_ACK_INVALID", error_class: "permanent", status: 400, actor_id: "member-1" }));
    expect(repository.audits).toHaveLength(1);

    expect(repository.marks.get("20:7")).toEqual({ seen: 5, notified: 5 });
    expect(new Set(repository.vendorsTouched)).toEqual(new Set([SESSION_VENDOR]));
  });

  it("answers a broken answer 500 at ERROR, never a guessed shape", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const newItems = new FakeNewItemsService();
    newItems.readAnswer = { categories: [{ categoryId: 7, categoryName: "Armalope", productCount: 0, sizeCount: 3, throughArrivalId: 41 }] };
    newItems.acknowledgeAnswer = { outcome: "moved", categoryId: 7, seenThroughArrivalId: 41 };
    const url = await start(newItems);

    expect(await get(url + NEW_ITEMS)).toMatchObject({ status: 500, body: { error: { code: "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR" } } });
    expect(await post(url + ACKNOWLEDGE, { categoryId: 7, throughArrivalId: 41 }))
      .toMatchObject({ status: 500, body: { error: { code: "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR" } } });
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("dropship.vendor_catalog.request_failed", expect.objectContaining({
      error_class: "fatal", path: NEW_ITEMS }));
  });

  it("answers the notice's codes: invalid input and Got it past the newest arrival 400, a ledger contract fault 500", async () => {
    const levels = {
      debug: vi.spyOn(logger, "debug").mockImplementation(() => undefined),
      error: vi.spyOn(logger, "error").mockImplementation(() => undefined),
    };
    expect(statusForDropshipVendorCatalogError(DROPSHIP_CATALOG_READ_ERROR_CODES.noticeAcknowledgeInvalid)).toBe(400);
    expect(statusForDropshipVendorCatalogError(DROPSHIP_CATALOG_READ_ERROR_CODES.newItemsInvalidInput)).toBe(400);
    expect(statusForDropshipVendorCatalogError(CATALOG_ARRIVALS_ERROR_CODES.invariantFailed)).toBe(500);
    // The domain reads its two codes from the shared contract the page reads.
    expect(CATALOG_ARRIVALS_ERROR_CODES.acknowledgeInvalid).toBe("DROPSHIP_CATALOG_NOTICE_ACK_INVALID");
    expect(CATALOG_ARRIVALS_ERROR_CODES.newItemsInvalidInput).toBe("DROPSHIP_CATALOG_NEW_ITEMS_INVALID_INPUT");

    const newItems = new FakeNewItemsService();
    newItems.failure = new DropshipError(CATALOG_ARRIVALS_ERROR_CODES.invariantFailed, "An arrival id broke its contract.", {
      classification: "fatal", retryable: false });
    const url = await start(newItems);
    expect(await get(url + NEW_ITEMS)).toMatchObject({ status: 500, body: { error: { code: "DROPSHIP_CATALOG_ARRIVALS_INVARIANT_FAILED" } } });
    expect(levels.error).toHaveBeenCalledWith("dropship.vendor_catalog.request_failed", expect.objectContaining({
      error_code: "DROPSHIP_CATALOG_ARRIVALS_INVARIANT_FAILED", error_class: "fatal", status: 500 }));
    expect(levels.debug).not.toHaveBeenCalled();
  });

  it("keeps Got it on the global parser: not a bulk path, and a body over its limit never reaches the route", async () => {
    expect(isDropshipBulkJsonRequest("POST", ACKNOWLEDGE)).toBe(false);
    const newItems = new FakeNewItemsService();
    const url = await start(newItems);
    const big = await post(url + ACKNOWLEDGE, { categoryId: 7, throughArrivalId: 41, padding: "x".repeat(GLOBAL_JSON_LIMIT_BYTES + 1) });
    expect(big.status).toBe(413);
    expect(newItems.acknowledgeInputs).toEqual([]);
  });
});

function buildApp(atp: FakeAtpService, newItems: DropshipCatalogNewItemsRouteService, member: string | null): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = member === null
      ? {}
      : { dropship: { authIdentityId: 1, memberId: member, authMethod: "password", entitlementStatus: "active" } };
    next();
  });
  // Production's global parser (100 KiB), which skips only the bulk paths (server/index.ts).
  installGlobalJsonBodyParser(app);
  registerDropshipVendorCatalogRoutes(app, atp as unknown as DropshipSelectionAtpService,
    {} as DropshipSelectionChangeService, newItems);
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

/** An answer's JSON: a refusal's `error`, or an answer's fields. */
interface AnswerBody { error: { code: string; message?: string; context?: unknown }; [field: string]: unknown }

async function get(url: string) {
  return request(url, "GET");
}

async function post(url: string, body: unknown) {
  return request(url, "POST", JSON.stringify(body));
}

async function request(url: string, method: string, body?: string): Promise<{ status: number; headers: Headers; body: AnswerBody }> {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body });
  const text = await response.text();
  let parsed: AnswerBody;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Deliberate: express's own 413 page is HTML; the case reads the status only.
    parsed = { error: { code: "NOT_JSON" } };
  }
  return { status: response.status, headers: response.headers, body: parsed };
}
