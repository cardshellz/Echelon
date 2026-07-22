import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  service: {
    getReport: vi.fn(),
    evaluateMatured: vi.fn(),
  },
}));

vi.mock("../../../../routes/middleware", () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return { requirePermission: () => pass };
});

vi.mock("../../../../db", () => ({ db: {} }));

import { registerPurchaseForecastBacktestingRoutes } from "../../purchase-forecast-backtesting.routes";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: "buyer-1" };
    next();
  });
  registerPurchaseForecastBacktestingRoutes(app, { service: mocks.service as any });
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

async function requestJson(baseUrl: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("purchase forecast backtesting routes", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("returns a filtered read-only report", async () => {
    mocks.service.getReport.mockResolvedValue({ summaries: [], items: [] });
    server = await startServer(buildApp());

    const response = await requestJson(server.url, "GET", "/api/purchasing/forecast-backtests?horizonDays=30&limit=25");

    expect(response).toEqual({ status: 200, body: { summaries: [], items: [] } });
    expect(mocks.service.getReport).toHaveBeenCalledWith({ horizonDays: "30", limit: 25 });
  });

  it("runs an attributed, bounded on-demand evaluation", async () => {
    mocks.service.evaluateMatured.mockResolvedValue({ insertedCount: 4 });
    server = await startServer(buildApp());

    const response = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/forecast-backtests/evaluate",
      { horizons: [7, 30], limit: 100 },
    );

    expect(response).toEqual({ status: 201, body: { insertedCount: 4 } });
    expect(mocks.service.evaluateMatured).toHaveBeenCalledWith({
      horizons: [7, 30],
      limit: 100,
      actor: "buyer-1",
    });
  });

  it("rejects unsupported horizons before invoking the service", async () => {
    server = await startServer(buildApp());

    const response = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/forecast-backtests/evaluate",
      { horizons: [14] },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid forecast backtesting request");
    expect(mocks.service.evaluateMatured).not.toHaveBeenCalled();
  });
});
