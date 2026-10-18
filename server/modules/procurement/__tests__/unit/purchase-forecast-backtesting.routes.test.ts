import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import http from "node:http";

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
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once("error", (error) => reject(new Error(`Test HTTP server could not listen on loopback: ${error.message}`)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Test HTTP server did not expose its loopback address"));
        return;
      }
      const url = `http://127.0.0.1:${address.port}`;
      resolve({
        url,
        close: () => new Promise<void>((done, fail) => server.close((error) => {
          if (error) fail(new Error(`Test HTTP server at ${url} could not close: ${error.message}`));
          else done();
        })),
      });
    });
  });
}

async function requestJson(baseUrl: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const url = new URL(path, baseUrl);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  // Exercise Express over real HTTP on every OS-assigned port. Fetch can reject
  // an ephemeral port through its browser blocked-port policy before sending.
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method,
      agent: false,
      headers: payload === undefined ? undefined : {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("error", (error) => reject(new Error(`Test HTTP response for ${method} ${url} failed: ${error.message}`)));
      response.on("end", () => {
        try {
          if (response.statusCode === undefined) throw new Error("Response has no HTTP status code");
          resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
        } catch (error) {
          reject(new Error(`Invalid test HTTP response for ${method} ${url}: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });
    request.on("error", (error) => reject(new Error(`Test HTTP request ${method} ${url} failed: ${error.message}`)));
    request.setTimeout(5_000, () => request.destroy(new Error("Test HTTP request timed out after 5000 ms")));
    request.end(payload);
  });
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
    const fingerprint = "a".repeat(64);

    const response = await requestJson(
      server.url,
      "GET",
      `/api/purchasing/forecast-backtests?horizonDays=30&limit=25&forecastPolicyFingerprint=${fingerprint}&forecastVersion=2`,
    );

    expect(response).toEqual({ status: 200, body: { summaries: [], items: [] } });
    expect(mocks.service.getReport).toHaveBeenCalledWith({
      horizonDays: "30",
      limit: 25,
      forecastPolicyFingerprint: fingerprint,
      forecastVersion: 2,
    });
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

  it("rejects a malformed policy fingerprint before invoking the service", async () => {
    server = await startServer(buildApp());

    const response = await requestJson(
      server.url,
      "GET",
      "/api/purchasing/forecast-backtests?forecastPolicyFingerprint=ABC",
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid forecast backtesting request");
    expect(mocks.service.getReport).not.toHaveBeenCalled();
  });
});
