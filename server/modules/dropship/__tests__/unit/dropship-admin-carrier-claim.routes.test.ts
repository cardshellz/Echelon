import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipCarrierClaimService } from "../../application/dropship-carrier-claim-service";
import { registerDropshipAdminCarrierClaimRoutes } from "../../interfaces/http/dropship-admin-carrier-claim.routes";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../../../routes/middleware", () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

describe("carrier claim admin routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeService;

  beforeEach(async () => {
    service = new FakeService();
    server = await startServer(buildApp(service as unknown as DropshipCarrierClaimService));
  });

  afterEach(async () => server.close());

  it("passes shipment identity, idempotency, and authenticated actor without accepting money", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/admin/carrier-protection/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "carrier-claim-route-001" },
      body: JSON.stringify({ wmsShipmentId: 501, eventType: "loss" }),
    });

    expect(response.status).toBe(201);
    expect(service.createInput).toEqual({
      wmsShipmentId: 501,
      eventType: "loss",
      idempotencyKey: "carrier-claim-route-001",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
  });

  it("lists claims with a bounded requested limit", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/admin/carrier-protection/claims?limit=25`);
    expect(response.status).toBe(200);
    expect(service.listInput).toEqual({ limit: "25" });
    expect(response.body).toEqual({ claims: [{ claimId: 9 }] });
  });

  it("rejects conflicting body and header idempotency keys", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/admin/carrier-protection/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "carrier-claim-route-003" },
      body: JSON.stringify({
        wmsShipmentId: 501,
        eventType: "loss",
        idempotencyKey: "carrier-claim-route-004",
      }),
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { code: "DROPSHIP_CARRIER_CLAIM_IDEMPOTENCY_CONFLICT" },
    });
    expect(service.createInput).toBeNull();
  });
});

class FakeService {
  createInput: unknown = null;
  listInput: unknown = null;

  async createClaim(input: unknown) {
    this.createInput = input;
    return { record: { claimId: 9 }, idempotentReplay: false };
  }

  async listClaims(input: unknown) {
    this.listInput = input;
    return [{ claimId: 9 }];
  }
}

function buildApp(service: DropshipCarrierClaimService): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request & { session?: { user?: { id: string } } }, _res, next) => {
    req.session = { user: { id: "admin-1" } };
    next();
  });
  registerDropshipAdminCarrierClaimRoutes(app, service);
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
