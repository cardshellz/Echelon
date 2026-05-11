import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipOpsSurfaceService } from "../../application/dropship-ops-surface-service";
import { registerDropshipOpsSurfaceRoutes } from "../../interfaces/http/dropship-ops-surface.routes";

const requirePermissionMock = vi.hoisted(() =>
  vi.fn((_resource: string, _action: string) =>
    (_req: Request, _res: Response, next: NextFunction) => next(),
  ),
);

vi.mock("../../../../db", () => ({
  pool: {},
  db: {},
}));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: requirePermissionMock,
}));

vi.mock("../../interfaces/http/dropship-auth.routes", () => ({
  requireDropshipAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../../infrastructure/dropship-ops-surface.factory", () => ({
  createDropshipOpsSurfaceServiceFromEnv: () => {
    throw new Error("Route tests must inject a fake dropship ops surface service");
  },
}));

describe("dropship ops surface routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeDropshipOpsSurfaceService;

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = new FakeDropshipOpsSurfaceService();
    server = await startServer(buildApp(service as unknown as DropshipOpsSurfaceService));
  });

  afterEach(async () => {
    await server.close();
  });

  it("normalizes admin dogfood readiness filters before service access", async () => {
    const response = await jsonRequest(
      `${server.url}/api/dropship/admin/dogfood-readiness?status=all&platform=all&search=%20Vendor%20&page=2&limit=25`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 0, page: 1, limit: 50 });
    expect(service.lastReadinessInput).toEqual({
      status: undefined,
      platform: undefined,
      search: "Vendor",
      page: 2,
      limit: 25,
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("dropship", "view");
  });

  it("normalizes admin dogfood smoke filters before service access", async () => {
    const response = await jsonRequest(
      `${server.url}/api/dropship/admin/dogfood-smoke?vendorId=10&storeConnectionId=22&platform=shopify&search=%20Store%20&limit=5&staleAfterHours=48`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 0, staleAfterHours: 72 });
    expect(service.lastSmokeInput).toEqual({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      search: "Store",
      limit: 5,
      staleAfterHours: 48,
    });
  });

  it("normalizes admin dogfood launch status filters before service access", async () => {
    const response = await jsonRequest(
      `${server.url}/api/dropship/admin/dogfood-launch-status?platform=all&search=%20Vendor%20&staleAfterHours=24`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "warning",
      message: "No vendor/store row is both readiness-ready and fresh smoke-ready yet.",
    });
    expect(service.lastLaunchStatusInput).toEqual({
      platform: undefined,
      search: "Vendor",
      staleAfterHours: 24,
    });
  });

  it("rejects invalid admin dogfood launch status freshness before service access", async () => {
    const response = await jsonRequest(
      `${server.url}/api/dropship/admin/dogfood-launch-status?staleAfterHours=0`,
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "DROPSHIP_OPS_SURFACE_INVALID_REQUEST",
      context: {
        parameter: "staleAfterHours",
        value: "0",
      },
    });
    expect(service.lastLaunchStatusInput).toBeNull();
  });
});

class FakeDropshipOpsSurfaceService {
  lastReadinessInput: unknown = null;
  lastSmokeInput: unknown = null;
  lastLaunchStatusInput: unknown = null;

  async listDogfoodReadiness(input: unknown) {
    this.lastReadinessInput = input;
    return makeReadinessResult();
  }

  async listDogfoodSmokeCandidates(input: unknown) {
    this.lastSmokeInput = input;
    return makeSmokeResult();
  }

  async getDogfoodLaunchStatus(input: unknown) {
    this.lastLaunchStatusInput = input;
    return {
      generatedAt: new Date("2026-05-11T12:00:00.000Z"),
      status: "warning",
      message: "No vendor/store row is both readiness-ready and fresh smoke-ready yet.",
      launchCandidates: [],
      launchGate: {
        status: "warning",
        readyVendorStoreCount: 1,
        warningVendorStoreCount: 0,
        blockedVendorStoreCount: 0,
        systemBlockedCount: 0,
        systemWarningCount: 0,
        blockerCount: 0,
        warningCount: 0,
        message: "1 vendor/store row(s) are ready for dogfood.",
        firstBlockers: [],
        runbookSteps: [],
      },
      readiness: makeReadinessResult(),
      smoke: makeSmokeResult(),
      runbookSteps: [],
    };
  }
}

function buildApp(service: DropshipOpsSurfaceService): express.Express {
  const app = express();
  app.use(express.json());
  registerDropshipOpsSurfaceRoutes(app, service);
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(url: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url);
  return {
    status: response.status,
    body: await response.json(),
  };
}

function makeReadinessResult() {
  return {
    generatedAt: new Date("2026-05-11T12:00:00.000Z"),
    items: [],
    summary: [],
    systemChecks: [],
    launchGate: {
      status: "warning",
      readyVendorStoreCount: 0,
      warningVendorStoreCount: 0,
      blockedVendorStoreCount: 0,
      systemBlockedCount: 0,
      systemWarningCount: 0,
      blockerCount: 0,
      warningCount: 0,
      message: "No vendor/store row is ready for dogfood.",
      firstBlockers: [],
      runbookSteps: [],
    },
    total: 0,
    page: 1,
    limit: 50,
    readyCount: 0,
    warningCount: 0,
    blockedCount: 0,
  };
}

function makeSmokeResult() {
  return {
    generatedAt: new Date("2026-05-11T12:00:00.000Z"),
    staleAfterHours: 72,
    candidates: [],
    total: 0,
    readyCandidateCount: 0,
    warningCandidateCount: 0,
    blockedCandidateCount: 0,
    message: "No dogfood smoke candidates found.",
  };
}
