import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipCarrierProtectionService } from "../../application/dropship-carrier-protection-service";
import { registerDropshipAdminCarrierProtectionRoutes } from "../../interfaces/http/dropship-admin-carrier-protection.routes";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../../../routes/middleware", () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

describe("carrier-protection admin routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeService;

  beforeEach(async () => {
    service = new FakeService();
    server = await startServer(buildApp(service as unknown as DropshipCarrierProtectionService));
  });

  afterEach(async () => server.close());

  it("passes idempotency and authenticated actor to policy creation", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/admin/carrier-protection/policies`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "carrier-route-001" },
      body: JSON.stringify({ policyKey: "STANDARD", name: "Standard" }),
    });

    expect(response.status).toBe(201);
    expect(service.createInput).toMatchObject({
      policyKey: "STANDARD",
      idempotencyKey: "carrier-route-001",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
  });

  it("exposes deterministic policy resolution for admin validation", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/admin/carrier-protection/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "loss", channelId: 103, warehouseId: 1 }),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ match: { policy: { policyId: 7 }, assignment: { assignmentId: 9 } } });
    expect(service.resolveInput).toMatchObject({ eventType: "loss", channelId: 103, warehouseId: 1 });
  });
});

class FakeService {
  createInput: unknown = null;
  resolveInput: unknown = null;

  async getOverview() { return { policies: [], assignments: [], generatedAt: new Date() }; }
  async createPolicy(input: unknown) {
    this.createInput = input;
    return { record: { policyId: 7 }, idempotentReplay: false };
  }
  async activatePolicy() { return { record: { policyId: 7 }, idempotentReplay: false }; }
  async retirePolicy() { return { record: { policyId: 7 }, idempotentReplay: false }; }
  async createAssignment() { return { record: { assignmentId: 9 }, idempotentReplay: false }; }
  async deactivateAssignment() { return { record: { assignmentId: 9 }, idempotentReplay: false }; }
  async resolvePolicy(input: unknown) {
    this.resolveInput = input;
    return { policy: { policyId: 7 }, assignment: { assignmentId: 9 } };
  }
}

function buildApp(service: DropshipCarrierProtectionService): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request & { session?: { user?: { id: string } } }, _res, next) => {
    req.session = { user: { id: "admin-1" } };
    next();
  });
  registerDropshipAdminCarrierProtectionRoutes(app, service);
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

async function jsonRequest(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
