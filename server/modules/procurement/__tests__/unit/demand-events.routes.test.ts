import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  permissions: [] as Array<[string, string]>,
  listDemandEvents: vi.fn(),
  getDemandEventById: vi.fn(),
  createDemandEvent: vi.fn(),
  replaceDemandEvent: vi.fn(),
  updateDemandEvent: vi.fn(),
  deleteDemandEvent: vi.fn(),
  addDemandEventLine: vi.fn(),
  updateDemandEventLine: vi.fn(),
  deleteDemandEventLine: vi.fn(),
  getForwardDemandByProduct: vi.fn(),
}));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: (resource: string, action: string) => {
    mocks.permissions.push([resource, action]);
    return (req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { session: { user: { id: string; role: string } } }).session = {
        user: { id: "buyer-1", role: "admin" },
      };
      next();
    };
  },
}));

vi.mock("../../demand-events.service", () => {
  class DemandEventError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
    }
  }
  return { ...mocks, DemandEventError };
});

import { registerDemandEventRoutes } from "../../demand-events.routes";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  registerDemandEventRoutes(app, {
    getForecastPolicy: vi.fn(async () => ({
      forwardDemandEnabled: true,
      forwardDemandHorizonDays: 120,
      forwardDemandConfidenceWeights: { high: 100, medium: 65, low: 25 },
    })),
  });
  return app;
}

function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function requestJson(url: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("demand event routes", () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.permissions.length = 0;
    server = await startServer(buildApp());
  });

  afterEach(async () => {
    await server.close();
  });

  it("uses purchasing permissions for every demand-planning route", () => {
    expect(mocks.permissions.length).toBeGreaterThan(0);
    expect(mocks.permissions.every(([resource]) => resource === "purchasing")).toBe(true);
    expect(mocks.permissions).toContainEqual(["purchasing", "view"]);
    expect(mocks.permissions).toContainEqual(["purchasing", "edit"]);
  });

  it("creates an event with the authenticated operator and normalized line values", async () => {
    mocks.createDemandEvent.mockResolvedValue({ id: 41 });
    const result = await requestJson(server.url, "POST", "/api/demand-events", {
      name: "Wholesale launch",
      eventType: "wholesale",
      startDate: "2026-09-01",
      lines: [{ productId: 10, productVariantId: 101, expectedPieces: 5000, confidence: "high" }],
    });

    expect(result.status).toBe(201);
    expect(mocks.createDemandEvent).toHaveBeenCalledWith({
      event: {
        name: "Wholesale launch",
        eventType: "wholesale",
        startDate: "2026-09-01",
        endDate: null,
        status: "planned",
        notes: null,
      },
      lines: [{
        productId: 10,
        productVariantId: 101,
        expectedPieces: 5000,
        confidence: "high",
        notes: null,
      }],
    }, { actorId: "buyer-1" });
  });

  it("passes optimistic version evidence when status changes", async () => {
    mocks.updateDemandEvent.mockResolvedValue({ id: 41, status: "active" });
    const result = await requestJson(server.url, "PATCH", "/api/demand-events/41", {
      status: "active",
      expectedUpdatedAt: "2026-07-22T12:00:00.000Z",
    });

    expect(result.status).toBe(200);
    expect(mocks.updateDemandEvent).toHaveBeenCalledWith(41, { status: "active" }, {
      actorId: "buyer-1",
      expectedUpdatedAt: "2026-07-22T12:00:00.000Z",
    });
  });

  it("returns the configured forecast horizon and weights with the preview", async () => {
    mocks.getForwardDemandByProduct.mockResolvedValue(new Map([[10, {
      productId: 10,
      productName: "Toploaders",
      productSku: "TOP-35PT",
      totalExpectedPieces: 1000,
      weightedExpectedPieces: 650,
      highConfidencePieces: 0,
      mediumConfidencePieces: 1000,
      lowConfidencePieces: 0,
      eventCount: 1,
    }]]));

    const result = await requestJson(server.url, "GET", "/api/demand-events/forward-demand");

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      enabled: true,
      horizonDays: 120,
      confidenceWeights: { high: 100, medium: 65, low: 25 },
      totalProducts: 1,
    });
    expect(mocks.getForwardDemandByProduct).toHaveBeenCalledWith({
      horizonDays: 120,
      confidenceWeights: { high: 100, medium: 65, low: 25 },
    });
  });
});
