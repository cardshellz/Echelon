import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyListingPushRunCounts } from "../../../../../shared/dropship/listing-push-runs";
import type { DropshipListingPushRunService } from "../../application/dropship-listing-push-run-service";
import { DropshipError } from "../../domain/errors";
import { logger } from "../../../../platform/observability/logger";

const stepUpActions = vi.hoisted(() => [] as string[]);
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../interfaces/http/dropship-auth.routes", () => ({
  requireDropshipAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.session = { dropship: { memberId: req.header("x-test-member") ?? "member-10" } } as unknown as Request["session"];
    next();
  },
  requireDropshipSensitiveActionProof: (action: string) => (req: Request, res: Response, next: NextFunction) => {
    stepUpActions.push(action);
    if (req.header("x-test-proof") !== "live") {
      return res.status(403).json({ error: { code: "DROPSHIP_STEP_UP_REQUIRED", message: "Confirm it's you." } });
    }
    return next();
  },
}));

import {
  RUN_CREATE_RATE_LIMIT,
  registerDropshipListingPushRunRoutes,
  statusForListingPushRunError,
} from "../../interfaces/http/dropship-listing.routes";

const RUN = {
  runId: 4, storeConnectionId: 22, scope: "not_live", status: "processing", stopReason: null, selectionRevisionId: 7,
  targetCount: 1_234, chunkSize: 500, chunkCount: 3, nextChunkIndex: 0, cancelRequestedAt: null,
  createdAt: "2026-10-20T12:00:00.000Z", updatedAt: "2026-10-20T12:00:00.000Z", completedAt: null,
};
const BODY = { storeConnectionId: 22, scope: "not_live", idempotencyKey: "publish-0001", expectedSelectionRevisionId: 7 };

class FakeRunService {
  creates: Array<{ memberId: string; body: Record<string, unknown> }> = [];
  lists: unknown[] = [];
  details: unknown[] = [];
  stops: unknown[] = [];
  replay = false;
  createError: unknown = null;
  answer: unknown = null;

  async createRunForMember(memberId: string, body: Record<string, unknown>) {
    this.creates.push({ memberId, body });
    if (this.createError) throw this.createError;
    return this.answer ?? { run: RUN, idempotentReplay: this.replay };
  }
  async listRunsForMember(memberId: string, query: unknown) {
    this.lists.push({ memberId, query });
    return { runs: [{ run: RUN, counts: emptyListingPushRunCounts() }] };
  }
  async getRunForMember(memberId: string, query: { runId: number }) {
    this.details.push({ memberId, query });
    if (memberId !== "member-10" || query.runId !== 4) throw new DropshipError("DROPSHIP_LISTING_PUSH_RUN_NOT_FOUND", "That publish was not found.", { runId: query.runId });
    return { run: RUN, counts: emptyListingPushRunCounts(), problems: { items: [], nextCursor: 512 }, waitingUntil: null, drafts: 0 };
  }
  async stopRunForMember(memberId: string, runId: number) {
    this.stops.push({ memberId, runId });
    if (runId !== 4) throw new DropshipError("DROPSHIP_LISTING_PUSH_RUN_NOT_FOUND", "That publish was not found.", { runId });
    return { run: { ...RUN, cancelRequestedAt: "2026-10-20T12:05:00.000Z", stopReason: "vendor_stop" }, counts: emptyListingPushRunCounts() };
  }
}

describe("publish run routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeRunService;

  beforeEach(async () => {
    stepUpActions.length = 0;
    service = new FakeRunService();
    const app = express();
    app.use(express.json());
    registerDropshipListingPushRunRoutes(app, service as unknown as DropshipListingPushRunService);
    server = await startServer(app);
  });

  afterEach(async () => {
    await server.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${server.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-test-proof": "live", ...headers }, body: JSON.stringify(body) });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${server.url}${path}`, { headers });

  it("needs the bulk push step-up proof to create, and answers 202 for a new run and 200 for a replay", async () => {
    const refused = await post("/api/dropship/listing-push-runs", BODY, { "x-test-proof": "none" });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("DROPSHIP_STEP_UP_REQUIRED");
    expect(service.creates).toEqual([]);
    expect(stepUpActions).toEqual(["bulk_listing_push"]);

    const created = await post("/api/dropship/listing-push-runs", BODY);
    expect(created.status).toBe(202);
    expect(created.headers.get("cache-control")).toBe("private, no-store");
    expect(await created.json()).toEqual({ run: RUN, idempotentReplay: false });
    expect(service.creates).toEqual([{ memberId: "member-10", body: BODY }]);
    service.replay = true;
    expect((await post("/api/dropship/listing-push-runs", BODY)).status).toBe(200);
  });

  it("takes the key from the Idempotency-Key header when the body has none, and refuses neither", async () => {
    const { idempotencyKey: _key, ...withoutKey } = BODY;
    expect((await post("/api/dropship/listing-push-runs", withoutKey, { "Idempotency-Key": "header-key-0001" })).status).toBe(202);
    expect(service.creates[0].body.idempotencyKey).toBe("header-key-0001");
    const missing = await post("/api/dropship/listing-push-runs", withoutKey);
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe("DROPSHIP_IDEMPOTENCY_KEY_REQUIRED");
  });

  it("limits creates to six a minute per member", async () => {
    for (let press = 0; press < RUN_CREATE_RATE_LIMIT; press += 1) {
      expect((await post("/api/dropship/listing-push-runs", BODY)).status).toBe(202);
    }
    const limited = await post("/api/dropship/listing-push-runs", BODY);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("DROPSHIP_LISTING_PUSH_RUN_RATE_LIMITED");
    // Another member has a budget of their own.
    expect((await post("/api/dropship/listing-push-runs", BODY, { "x-test-member": "member-12" })).status).toBe(202);
  });

  it("answers each refusal with its status and only the context the page needs", async () => {
    service.createError = new DropshipError("DROPSHIP_LISTING_PUSH_RUN_ACTIVE", "A publish is already running for this store. It's shown below.",
      { runId: 3, classification: "permanent", internal: "x" });
    const active = await post("/api/dropship/listing-push-runs", BODY);
    expect(active.status).toBe(409);
    expect(await active.json()).toEqual({ error: { code: "DROPSHIP_LISTING_PUSH_RUN_ACTIVE",
      message: "A publish is already running for this store. It's shown below.", context: { runId: 3 } } });

    service.createError = new DropshipError("DROPSHIP_LISTING_PUSH_RUN_EMPTY", "Everything selected is already on eBay. Use Publish all to re-send it.",
      { scope: "not_live", liveCount: 12, selectedCount: 12, classification: "permanent" });
    const empty = await post("/api/dropship/listing-push-runs", BODY);
    expect(empty.status).toBe(422);
    expect((await empty.json()).error.context).toEqual({ scope: "not_live", liveCount: 12, selectedCount: 12 });

    service.createError = new DropshipError("DROPSHIP_LISTING_PUSH_RUN_BUSY", "Your choices are being saved.", { retryable: true });
    const busy = await post("/api/dropship/listing-push-runs", BODY);
    expect(busy.status).toBe(409);
    expect(busy.headers.get("retry-after")).toBe("2");

    service.createError = new Error("pool exhausted");
    const failed = await post("/api/dropship/listing-push-runs", BODY);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: { code: "DROPSHIP_LISTING_PUSH_RUN_INTERNAL_ERROR",
      message: "Publishing could not be read or started. Try again." } });
  });

  it("logs a refusal at DEBUG, a passing database failure at WARN with 503 and Retry-After, and only a real fault at ERROR (review CT8, CT9)", async () => {
    const levels = { debug: vi.spyOn(logger, "debug"), warn: vi.spyOn(logger, "warn"), error: vi.spyOn(logger, "error") };
    const actions = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => call[0]);
    try {
      service.createError = new DropshipError("DROPSHIP_LISTING_PUSH_RUN_TOO_LARGE", "More than 10,000 sizes are selected. Remove some in step 1, then publish.",
        { limit: 10_000, selectedCount: 10_001, classification: "permanent" });
      const tooLarge = await post("/api/dropship/listing-push-runs", BODY);
      expect(tooLarge.status).toBe(422);
      // Only the limit reaches the page.
      expect((await tooLarge.json()).error.context).toEqual({ limit: 10_000 });
      expect(actions(levels.debug)).toContain("dropship.listing_push_runs.request_refused");

      // A deadlock, a serialization failure, a lock or statement timeout: nothing was done, the page sends it again.
      for (const sqlState of ["40P01", "40001", "55P03", "57014"]) {
        service.createError = Object.assign(new Error("deadlock detected"), { code: sqlState });
        const passing = await post("/api/dropship/listing-push-runs", BODY);
        expect(passing.status).toBe(503);
        expect(passing.headers.get("retry-after")).toBe("2");
        expect(await passing.json()).toEqual({ error: { code: "DROPSHIP_LISTING_PUSH_RUN_UNAVAILABLE",
          message: "Publishing is busy for a moment. Try again." } });
      }
      expect(actions(levels.warn).filter((action) => action === "dropship.listing_push_runs.request_deferred")).toHaveLength(4);
      expect(levels.error).not.toHaveBeenCalled();

      service.createError = new Error("pool exhausted");
      expect((await post("/api/dropship/listing-push-runs", BODY)).status).toBe(500);
      expect(actions(levels.error)).toEqual(["dropship.listing_push_runs.request_failed"]);
    } finally {
      for (const spy of Object.values(levels)) spy.mockRestore();
    }
  });

  it("never sends an answer that breaks its contract", async () => {
    service.answer = { run: { ...RUN, createdAt: "yesterday" }, idempotentReplay: false };
    const broken = await post("/api/dropship/listing-push-runs", BODY);
    expect(broken.status).toBe(500);
  });

  it("maps every run code to its status", () => {
    expect(statusForListingPushRunError("DROPSHIP_LISTING_PUSH_RUN_INVALID_INPUT")).toBe(400);
    expect(statusForListingPushRunError("DROPSHIP_AUTH_REQUIRED")).toBe(401);
    expect(statusForListingPushRunError("DROPSHIP_LISTING_STORE_BLOCKED")).toBe(403);
    expect(statusForListingPushRunError("DROPSHIP_STORE_CONNECTION_REQUIRED")).toBe(404);
    expect(statusForListingPushRunError("DROPSHIP_LISTING_PUSH_RUN_NOT_FOUND")).toBe(404);
    expect(statusForListingPushRunError("DROPSHIP_IDEMPOTENCY_CONFLICT")).toBe(409);
    expect(statusForListingPushRunError("DROPSHIP_SELECTION_REVISION_CONFLICT")).toBe(409);
    expect(statusForListingPushRunError("DROPSHIP_LISTING_PUSH_RUN_TOO_LARGE")).toBe(422);
    expect(statusForListingPushRunError("SOMETHING_ELSE")).toBe(500);
  });

  it("lists a store's runs and reads one run, paging problems by size id; another vendor's run reads as not found", async () => {
    const list = await get("/api/dropship/listing-push-runs?storeConnectionId=22&limit=1");
    expect(list.status).toBe(200);
    expect(service.lists).toEqual([{ memberId: "member-10", query: { storeConnectionId: 22, limit: 1 } }]);
    const detail = await get("/api/dropship/listing-push-runs/4?problemsAfter=500");
    expect(detail.status).toBe(200);
    expect((await detail.json()).problems.nextCursor).toBe(512);
    expect(service.details[0]).toEqual({ memberId: "member-10", query: { runId: 4, problemsAfter: 500 } });
    const other = await get("/api/dropship/listing-push-runs/4", { "x-test-member": "member-11" });
    expect(other.status).toBe(404);
    // Anything but digits reaches the service as NaN, which its schema refuses.
    await get("/api/dropship/listing-push-runs/4e2");
    expect(service.details.at(-1)).toEqual({ memberId: "member-10", query: { runId: Number.NaN } });
  });

  it("stops without a step-up, and a second stop answers 200 again", async () => {
    const first = await post("/api/dropship/listing-push-runs/4/stop", {}, { "x-test-proof": "none" });
    expect(first.status).toBe(200);
    expect((await first.json()).run.stopReason).toBe("vendor_stop");
    expect((await post("/api/dropship/listing-push-runs/4/stop", {}, { "x-test-proof": "none" })).status).toBe(200);
    expect(stepUpActions).toEqual([]);
    expect((await post("/api/dropship/listing-push-runs/9/stop", {})).status).toBe(404);
  });
});

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
