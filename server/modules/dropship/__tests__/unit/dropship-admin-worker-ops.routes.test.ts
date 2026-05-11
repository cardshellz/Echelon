import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipWorkerOpsService } from "../../application/dropship-worker-ops-service";
import { registerDropshipAdminWorkerOpsRoutes } from "../../interfaces/http/dropship-admin-worker-ops.routes";

vi.mock("../../../../db", () => ({
  pool: {},
  db: {},
}));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

describe("dropship admin worker ops routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeDropshipWorkerOpsService;

  beforeEach(async () => {
    service = new FakeDropshipWorkerOpsService();
    server = await startServer(buildApp(service as unknown as DropshipWorkerOpsService));
  });

  afterEach(async () => {
    await server.close();
  });

  it("routes admin worker sweep requests with idempotency and actor context", async () => {
    const response = await jsonRequest(
      `${server.url}/api/dropship/admin/worker-sweeps/listing_push/run`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "worker-sweep-route-1",
        },
        body: JSON.stringify({ batchSize: 5, reason: "dogfood catch-up" }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      worker: "listing_push",
      workerId: "dropship-admin-listing_push:admin-1",
      batchSize: 5,
      metrics: { processed: 2, failed: 0 },
      status: "completed",
    });
    expect(service.lastInput).toMatchObject({
      worker: "listing_push",
      batchSize: 5,
      reason: "dogfood catch-up",
      idempotencyKey: "worker-sweep-route-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
  });

  it("rejects unknown worker names before service access", async () => {
    const response = await jsonRequest(
      `${server.url}/api/dropship/admin/worker-sweeps/not-real/run`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "worker-sweep-route-2",
        },
        body: JSON.stringify({ batchSize: 5 }),
      },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "DROPSHIP_WORKER_SWEEP_INVALID_REQUEST",
    });
    expect(service.lastInput).toBeNull();
  });
});

class FakeDropshipWorkerOpsService {
  lastInput: unknown = null;

  async runSweep(input: unknown) {
    this.lastInput = input;
    return {
      worker: "listing_push",
      workerId: "dropship-admin-listing_push:admin-1",
      batchSize: 5,
      metrics: { processed: 2, failed: 0 },
      status: "completed",
      requestedAt: new Date("2026-05-11T15:00:00.000Z"),
    };
  }
}

function buildApp(service: DropshipWorkerOpsService): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request & { session?: { user?: { id: string } } }, _res, next) => {
    req.session = { user: { id: "admin-1" } };
    next();
  });
  registerDropshipAdminWorkerOpsRoutes(app, service);
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

async function jsonRequest(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.json(),
  };
}
