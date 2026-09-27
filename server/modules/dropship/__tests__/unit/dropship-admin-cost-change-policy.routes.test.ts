import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipCostChangePolicyService } from "../../application/dropship-cost-change-policy-service";
import { DropshipError } from "../../domain/errors";
import {
  registerDropshipAdminCostChangePolicyRoutes,
  statusForCostChangePolicyError,
} from "../../interfaces/http/dropship-admin-cost-change-policy.routes";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const permissionChecks: Array<[string, string]> = [];
vi.mock("../../../../routes/middleware", () => ({
  requirePermission: (resource: string, action: string) =>
    (_req: Request, _res: Response, next: NextFunction) => {
      permissionChecks.push([resource, action]);
      next();
    },
}));

const POLICY_URL = "/api/dropship/admin/cost-changes/policy";

const validBody = {
  settings: {
    increaseNoticeDays: 21,
    decreaseTiming: "after_notice",
    priceProtection: true,
    retailChangesGetNotice: false,
    notifyByEmail: true,
    notifyInPortal: true,
    notifyOnDecrease: false,
    noticeMinimumChangeCents: 25,
    noticeMinimumChangeBps: 150,
    rulePricedListings: "wait_for_review",
    belowCostFixedListings: "pause_listing",
    detectionIntervalMinutes: 30,
  },
  changeNote: "Three weeks' notice for the holiday catalog.",
};

describe("dropship admin cost change policy routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeService;

  beforeEach(async () => {
    permissionChecks.length = 0;
    service = new FakeService();
    server = await startServer(buildApp(service as unknown as DropshipCostChangePolicyService));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("gates the read on dropship:view and serves the overview as the service built it", async () => {
    const response = await jsonRequest(`${server.url}${POLICY_URL}`);

    expect(response.status).toBe(200);
    expect(permissionChecks).toEqual([["dropship", "view"]]);
    expect(response.body).toMatchObject({
      settingsSource: "policy",
      enforcement: { detection: false },
      generatedAt: "2026-09-27T10:00:00.000Z",
    });
  });

  it("gates the write on dropship:manage_operations and passes the body, the session actor and the key", async () => {
    const response = await jsonRequest(`${server.url}${POLICY_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "cost-change-route-001" },
      body: JSON.stringify(validBody),
    });

    expect(response.status).toBe(201);
    expect(permissionChecks).toEqual([["dropship", "manage_operations"]]);
    expect(service.createInput).toEqual({
      ...validBody,
      idempotencyKey: "cost-change-route-001",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
  });

  it("never lets the body choose the actor", async () => {
    await jsonRequest(`${server.url}${POLICY_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "cost-change-route-002" },
      body: JSON.stringify({ ...validBody, actor: { actorType: "system", actorId: "someone-else" } }),
    });

    expect(service.createInput).toMatchObject({ actor: { actorType: "admin", actorId: "admin-1" } });
  });

  it("forwards unknown body fields so the strict contract can refuse them", async () => {
    await jsonRequest(`${server.url}${POLICY_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "cost-change-route-003" },
      body: JSON.stringify({ ...validBody, surprise: true }),
    });

    expect(service.createInput).toMatchObject({ surprise: true });
  });

  it("accepts the idempotency key from the body when no header is sent", async () => {
    const response = await jsonRequest(`${server.url}${POLICY_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, idempotencyKey: "cost-change-route-004" }),
    });

    expect(response.status).toBe(201);
    expect(service.createInput).toMatchObject({ idempotencyKey: "cost-change-route-004" });
  });

  it("answers 200 on a replay and 201 on a create", async () => {
    service.replay = true;
    const response = await jsonRequest(`${server.url}${POLICY_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "cost-change-route-005" },
      body: JSON.stringify(validBody),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ idempotentReplay: true });
  });

  it("refuses a write with no idempotency key at all, before touching the service", async () => {
    const response = await jsonRequest(`${server.url}${POLICY_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED" });
    expect(service.createInput).toBeNull();
  });

  it("maps each structured error class to its status on both routes", async () => {
    const cases: Array<[string, number]> = [
      ["DROPSHIP_COST_CHANGE_POLICY_INVALID_INPUT", 400],
      ["DROPSHIP_COST_CHANGE_POLICY_NOT_FOUND", 404],
      ["DROPSHIP_COST_CHANGE_POLICY_IDEMPOTENCY_CONFLICT", 409],
      ["DROPSHIP_COST_CHANGE_POLICY_COMMAND_INCOMPLETE", 409],
      ["DROPSHIP_COST_CHANGE_POLICY_CONFLICT", 409],
      ["DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING", 503],
      ["DROPSHIP_COST_CHANGE_POLICY_INVALID_STORED_VALUE", 500],
    ];
    for (const [code, status] of cases) {
      service.createError = new DropshipError(code, "failed", { classification: "permanent" });
      service.overviewError = service.createError;

      const write = await jsonRequest(`${server.url}${POLICY_URL}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "cost-change-route-006" },
        body: JSON.stringify(validBody),
      });
      expect(write.status, code).toBe(status);
      expect(write.body.error).toMatchObject({ code, context: { classification: "permanent" } });

      const read = await jsonRequest(`${server.url}${POLICY_URL}`);
      expect(read.status, code).toBe(status);
      expect(read.body.error).toMatchObject({ code });
    }
  });

  it("does not leak an unrecognized failure to the caller, and logs it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    service.createError = new Error("connection reset");

    const response = await jsonRequest(`${server.url}${POLICY_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "cost-change-route-007" },
      body: JSON.stringify(validBody),
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: "DROPSHIP_COST_CHANGE_POLICY_INTERNAL_ERROR",
      message: "Dropship cost change policy request failed.",
    });
    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      level: "error",
      code: "DROPSHIP_COST_CHANGE_POLICY_INTERNAL_ERROR",
      context: { error: "connection reset" },
    });
  });

  it("maps an unknown code to 500", () => {
    expect(statusForCostChangePolicyError("SOMETHING_ELSE")).toBe(500);
  });
});

class FakeService {
  createInput: unknown = null;
  createError: unknown = null;
  overviewError: unknown = null;
  replay = false;

  async getOverview() {
    if (this.overviewError) throw this.overviewError;
    return {
      policy: { policyId: 7, version: 3 },
      settings: validBody.settings,
      settingsSource: "policy",
      defaults: {},
      versions: [],
      enforcement: { detection: false, priceProtection: false, vendorNotices: false, listingActions: false },
      generatedAt: new Date("2026-09-27T10:00:00.000Z"),
    };
  }

  async createPolicyVersion(input: unknown) {
    if (this.createError) throw this.createError;
    this.createInput = input;
    return {
      policy: { policyId: 9, version: 4 },
      previousPolicy: null,
      idempotentReplay: this.replay,
    };
  }
}

function buildApp(service: DropshipCostChangePolicyService): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    // These routes read only `session.user.id`; the stub asserts that narrow
    // shape rather than fabricating auth fields no assertion looks at.
    req.session = { user: { id: "admin-1" } } as unknown as Request["session"];
    next();
  });
  registerDropshipAdminCostChangePolicyRoutes(app, service);
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function jsonRequest(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}
