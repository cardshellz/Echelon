import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipWalletPolicyService } from "../../application/dropship-wallet-policy-service";
import { DropshipError } from "../../domain/errors";
import { registerDropshipAdminWalletPolicyRoutes } from "../../interfaces/http/dropship-admin-wallet-policy.routes";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const permissionChecks: Array<[string, string]> = [];
vi.mock("../../../../routes/middleware", () => ({
  requirePermission: (resource: string, action: string) =>
    (_req: Request, _res: Response, next: NextFunction) => {
      permissionChecks.push([resource, action]);
      next();
    },
}));

const POLICY_URL = "/api/dropship/admin/wallet/policy";

const validBody = {
  autoReloadMinTriggerCents: 9_000,
  autoReloadMinAmountCents: 20_000,
  manualFundingMinCents: 2_500,
  manualFundingMaxCents: 60_000,
  defaultPaymentHoldTimeoutMinutes: 1_440,
  holdExpiryWarningMinutes: 45,
};

describe("dropship admin wallet policy routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeService;

  beforeEach(async () => {
    permissionChecks.length = 0;
    service = new FakeService();
    server = await startServer(buildApp(service as unknown as DropshipWalletPolicyService));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("gates the read on dropship:view and serves the overview as the service built it", async () => {
    const response = await jsonRequest(`${server.url}${POLICY_URL}`);

    expect(response.status).toBe(200);
    expect(permissionChecks).toContainEqual(["dropship", "view"]);
    expect(response.body).toMatchObject({
      limitsSource: "policy",
      cardFundingFee: { bps: 300, editable: false },
      impact: { vendorsBelowMinimumFloor: 4, vendorsBelowMinimumSingleTopUpLimit: 7 },
    });
  });

  it("passes a proposal through so staff see the impact before they save", async () => {
    const response = await jsonRequest(
      `${server.url}${POLICY_URL}?proposedAutoReloadMinTriggerCents=25000&proposedAutoReloadMinAmountCents=40000`,
    );

    expect(response.status).toBe(200);
    expect(service.overviewInput).toEqual({
      autoReloadMinTriggerCents: 25_000,
      autoReloadMinAmountCents: 40_000,
    });
  });

  it("omits a proposal that was not supplied rather than inventing one", async () => {
    await jsonRequest(`${server.url}${POLICY_URL}`);
    expect(service.overviewInput).toEqual({});
  });

  it("refuses a proposal that is not positive integer cents", async () => {
    const response = await jsonRequest(`${server.url}${POLICY_URL}?proposedAutoReloadMinTriggerCents=-1`);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: "DROPSHIP_WALLET_POLICY_INVALID_INPUT" });
  });

  it("gates the write on dropship:manage_operations and passes the session actor and key", async () => {
    const response = await jsonRequest(`${server.url}${POLICY_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "wallet-policy-route-001" },
      body: JSON.stringify(validBody),
    });

    expect(response.status).toBe(201);
    expect(permissionChecks).toContainEqual(["dropship", "manage_operations"]);
    expect(service.createInput).toMatchObject({
      ...validBody,
      idempotencyKey: "wallet-policy-route-001",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
  });

  it("accepts the idempotency key from the body when no header is sent", async () => {
    const response = await jsonRequest(`${server.url}${POLICY_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, idempotencyKey: "wallet-policy-route-002" }),
    });

    expect(response.status).toBe(201);
    expect(service.createInput).toMatchObject({ idempotencyKey: "wallet-policy-route-002" });
  });

  it("answers 200 on a replay and 201 on a create", async () => {
    service.replay = true;
    const response = await jsonRequest(`${server.url}${POLICY_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "wallet-policy-route-003" },
      body: JSON.stringify(validBody),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ idempotentReplay: true });
  });

  it("refuses a write with no idempotency key at all", async () => {
    const response = await jsonRequest(`${server.url}${POLICY_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED" });
    expect(service.createInput).toBeNull();
  });

  it("maps each structured error class to its status", async () => {
    const cases: Array<[string, number]> = [
      ["DROPSHIP_WALLET_POLICY_INVALID_INPUT", 400],
      ["DROPSHIP_WALLET_POLICY_NOT_FOUND", 404],
      ["DROPSHIP_WALLET_POLICY_IDEMPOTENCY_CONFLICT", 409],
      ["DROPSHIP_WALLET_POLICY_COMMAND_INCOMPLETE", 409],
      ["DROPSHIP_WALLET_POLICY_CONFLICT", 409],
      ["DROPSHIP_WALLET_POLICY_TABLE_MISSING", 503],
      ["DROPSHIP_WALLET_POLICY_INVALID_STORED_VALUE", 500],
    ];
    for (const [code, status] of cases) {
      service.createError = new DropshipError(code, "failed", { classification: "permanent" });
      const response = await jsonRequest(`${server.url}${POLICY_URL}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "wallet-policy-route-004" },
        body: JSON.stringify(validBody),
      });
      expect(response.status, code).toBe(status);
      expect(response.body.error).toMatchObject({ code, context: { classification: "permanent" } });
    }
  });

  it("does not leak an unrecognized failure to the caller", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.createError = new Error("connection reset");

    const response = await jsonRequest(`${server.url}${POLICY_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "wallet-policy-route-005" },
      body: JSON.stringify(validBody),
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: "DROPSHIP_WALLET_POLICY_INTERNAL_ERROR",
      message: "Dropship wallet policy request failed.",
    });
  });
});

class FakeService {
  overviewInput: unknown = null;
  createInput: unknown = null;
  createError: unknown = null;
  replay = false;

  async getOverview(input: unknown) {
    this.overviewInput = input;
    return {
      policy: { policyId: 7, version: 3 },
      limits: {},
      limitsSource: "policy",
      envLimits: {},
      envKeys: {},
      cardFundingFee: { bps: 300, envKey: "DROPSHIP_CARD_FUNDING_FEE_BPS", editable: false, readOnlyReason: "…" },
      impact: { vendorsBelowMinimumFloor: 4, vendorsBelowMinimumSingleTopUpLimit: 7 },
      generatedAt: new Date("2026-09-19T10:00:00.000Z"),
    };
  }

  async getImpact() {
    return { vendorsBelowMinimumFloor: 4, vendorsBelowMinimumSingleTopUpLimit: 7 };
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

function buildApp(service: DropshipWalletPolicyService): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    // These routes read only `session.user.id`; the rest of the principal is
    // irrelevant here, so the stub asserts that narrow shape rather than
    // fabricating auth fields no assertion looks at.
    req.session = { user: { id: "admin-1" } } as unknown as Request["session"];
    next();
  });
  registerDropshipAdminWalletPolicyRoutes(app, service);
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
