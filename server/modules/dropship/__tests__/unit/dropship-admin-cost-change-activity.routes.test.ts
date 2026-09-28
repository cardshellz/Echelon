import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipCostChangeListingActionService } from "../../application/dropship-cost-change-listing-action-service";
import type { DropshipCostDetectionService } from "../../application/dropship-cost-detection-service";
import { DropshipError } from "../../domain/errors";
import {
  registerDropshipAdminCostChangeActivityRoutes,
  statusForCostChangeActivityError,
} from "../../interfaces/http/dropship-admin-cost-change-activity.routes";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const permissionChecks: Array<[string, string]> = [];
vi.mock("../../../../routes/middleware", () => ({
  requirePermission: (resource: string, action: string) =>
    (_req: Request, _res: Response, next: NextFunction) => {
      permissionChecks.push([resource, action]);
      next();
    },
}));

const DETECTION_URL = "/api/dropship/admin/cost-changes/detection";
const LISTING_ACTIONS_URL = "/api/dropship/admin/cost-changes/listing-actions";
const listingActionCalls: unknown[] = [];
const listingActionsService = {
  listListingActions: async (input: unknown) => {
    listingActionCalls.push(input);
    if ((input as { limit?: unknown }).limit === 0) throw new DropshipError("DROPSHIP_COST_CHANGE_INVALID_INPUT", "bad", { classification: "permanent" });
    return { items: [{ actionId: 71, action: "reprice_queued" }], nextBeforeId: null, generatedAt: new Date("2026-10-13T00:05:00.000Z") };
  },
};
const LOG_URL = "/api/dropship/admin/cost-changes/log";

describe("dropship admin cost change activity routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeService;

  beforeEach(async () => {
    permissionChecks.length = 0;
    service = new FakeService();
    const app = express();
    listingActionCalls.length = 0;
    registerDropshipAdminCostChangeActivityRoutes(app, service as unknown as DropshipCostDetectionService,
      listingActionsService as unknown as DropshipCostChangeListingActionService);
    server = await startServer(app);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("gates the detection view on dropship:view and serves it as the service built it", async () => {
    const response = await jsonRequest(`${server.url}${DETECTION_URL}`);
    expect(response.status).toBe(200);
    expect(permissionChecks).toEqual([["dropship", "view"]]);
    expect(response.body).toMatchObject({ workerEnabled: true, state: { passNumber: 2 }, pending: [], generatedAt: "2026-09-28T10:00:00.000Z" });
  });

  it("gates the log on dropship:view and passes the page size and cursor as numbers", async () => {
    const response = await jsonRequest(`${server.url}${LOG_URL}?limit=20&beforeId=345`);
    expect(response.status).toBe(200);
    expect(permissionChecks).toEqual([["dropship", "view"]]);
    expect(service.logInputs).toEqual([{ limit: 20, beforeId: 345 }]);
    expect(response.body).toMatchObject({ items: [], nextBeforeId: null });
  });

  it("passes no page parameters when none are sent, and leaves a malformed one for the contract to refuse", async () => {
    await jsonRequest(`${server.url}${LOG_URL}`);
    expect(service.logInputs).toEqual([{}]);
    service.logInputs.length = 0;
    const response = await jsonRequest(`${server.url}${LOG_URL}?beforeId=abc`);
    expect(service.logInputs).toEqual([{ beforeId: "abc" }]);
    expect(response.status).toBe(400);
  });

  it("maps classified errors to statuses and hides unexpected ones", async () => {
    service.fail = new DropshipError("DROPSHIP_COST_SCHEDULE_TABLE_MISSING", "not yet", { classification: "transient" });
    expect((await jsonRequest(`${server.url}${DETECTION_URL}`)).status).toBe(503);
    service.fail = new Error("boom");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await jsonRequest(`${server.url}${DETECTION_URL}`);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: "DROPSHIP_COST_CHANGE_ACTIVITY_INTERNAL_ERROR", message: "Dropship cost change activity request failed." },
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("knows the status of every error it can produce", () => {
    expect(statusForCostChangeActivityError("DROPSHIP_COST_DETECTION_INVALID_INPUT")).toBe(400);
    expect(statusForCostChangeActivityError("DROPSHIP_COST_SCHEDULE_INVALID_INPUT")).toBe(400);
    expect(statusForCostChangeActivityError("DROPSHIP_COST_SCHEDULE_TABLE_MISSING")).toBe(503);
    expect(statusForCostChangeActivityError("DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING")).toBe(503);
    expect(statusForCostChangeActivityError("DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE")).toBe(500);
  });
});

class FakeService {
  logInputs: unknown[] = [];
  fail: Error | null = null;

  async getOverview() {
    if (this.fail) throw this.fail;
    return {
      workerEnabled: true,
      state: { passNumber: 2, passStartedAt: new Date("2026-09-28T09:00:00.000Z"), passCompletedAt: new Date("2026-09-28T09:01:00.000Z"),
        cursorVendorId: null, policyId: 3, passVendorsProcessed: 4, passVariantsRead: 40, passUnavailableReadings: 1,
        passChangesRecorded: 2, lastTickAt: new Date("2026-09-28T09:59:00.000Z") },
      pending: [],
      pendingLimit: 200,
      generatedAt: new Date("2026-09-28T10:00:00.000Z"),
    };
  }

  async listChangeLog(input: unknown) {
    this.logInputs.push(input);
    if (this.fail) throw this.fail;
    const record = input as { beforeId?: unknown };
    if (record.beforeId !== undefined && typeof record.beforeId !== "number") {
      throw new DropshipError("DROPSHIP_COST_DETECTION_INVALID_INPUT", "bad cursor", { classification: "permanent" });
    }
    return { items: [], nextBeforeId: null, generatedAt: new Date("2026-09-28T10:00:00.000Z") };
  }
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function jsonRequest(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("dropship admin cost change listing actions route", () => {
  let server: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    permissionChecks.length = 0;
    listingActionCalls.length = 0;
    const app = express();
    registerDropshipAdminCostChangeActivityRoutes(app, new FakeService() as unknown as DropshipCostDetectionService,
      listingActionsService as unknown as DropshipCostChangeListingActionService);
    server = await startServer(app);
  });

  afterEach(async () => {
    await server.close();
  });

  it("serves a page of listing actions behind the dropship view permission, forwarding the cursor as numbers", async () => {
    const response = await jsonRequest(`${server.url}${LISTING_ACTIONS_URL}?limit=2&beforeId=40`);
    expect(response.status).toBe(200);
    expect(permissionChecks).toContainEqual(["dropship", "view"]);
    expect(listingActionCalls).toEqual([{ limit: 2, beforeId: 40 }]);
    expect((response.body as { items: unknown[] }).items).toEqual([{ actionId: 71, action: "reprice_queued" }]);
  });

  it("answers 400 to input the service refuses", async () => {
    const response = await jsonRequest(`${server.url}${LISTING_ACTIONS_URL}?limit=0`);
    expect(response.status).toBe(400);
  });
});
