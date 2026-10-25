import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipSelectionAtpService } from "../../application/dropship-selection-atp-service";
import type { DropshipSelectionChangeService } from "../../application/dropship-selection-change-service";
import { registerDropshipVendorCatalogRoutes } from "../../interfaces/http/dropship-vendor-catalog.routes";

vi.mock("../../../../db", () => ({
  db: {},
  pool: {},
}));

vi.mock("../../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository", () => ({
  createAuthorityAwareInventoryAtpService: () => ({}),
}));

describe("dropship vendor catalog routes", () => {
  let service: FakeDropshipSelectionAtpService;
  let server: { url: string; close: () => Promise<void> } | null;

  beforeEach(async () => {
    service = new FakeDropshipSelectionAtpService();
    server = null;
  });

  afterEach(async () => {
    await server?.close();
  });

  it("answers the retired rules save with 410 before any service call (PLAN-B v4.1 §8.4)", async () => {
    server = await startServer(buildApp(service as unknown as DropshipSelectionAtpService, true));

    const response = await jsonRequest(`${server.url}/api/dropship/catalog/selection-rules`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "catalog-selection-001",
      },
      body: JSON.stringify({ rules: [] }),
    });

    expect(response.status).toBe(410);
    expect(response.body.error).toMatchObject({ code: "DROPSHIP_SELECTION_RULES_RETIRED" });
    expect(service.vendorReads).toBe(0);
  });

  it("rejects catalog selection updates without an authenticated vendor session", async () => {
    server = await startServer(buildApp(service as unknown as DropshipSelectionAtpService, false));

    const response = await jsonRequest(`${server.url}/api/dropship/catalog/selection-rules`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "catalog-selection-002",
      },
      body: JSON.stringify({ rules: [] }),
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({
      code: "DROPSHIP_AUTH_REQUIRED",
    });
    expect(service.vendorReads).toBe(0);
  });

  it("returns a safe retryable conflict when stock publication is finishing", async () => {
    const changes = {
      preview: vi.fn(),
      applyChange: vi.fn().mockRejectedValue(new Error("private SQL", {
        cause: { code: "55P03", message: "PUBLICATION_SELECTION_BUSY" },
      })),
    };
    server = await startServer(buildApp(service as unknown as DropshipSelectionAtpService, true, changes as unknown as DropshipSelectionChangeService));
    const response = await jsonRequest(`${server.url}/api/dropship/catalog/selection/changes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevisionId: null, add: { productVariantIds: [1] }, remove: { productVariantIds: [] },
        idempotencyKey: "retry-selection", expectedEffectsHash: "0".repeat(64) }),
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: "PUBLICATION_SELECTION_BUSY", retryable: true,
      message: "A stock update is finishing. Your selection was not saved; retry it in a moment." } });
  });
});

class FakeDropshipSelectionAtpService {
  vendorReads = 0;

  async requireVendorForMember(memberId: string) {
    this.vendorReads += 1;
    return {
      vendorId: 10,
      memberId,
      status: "active",
      entitlementStatus: "active",
    };
  }
}

function buildApp(
  service: DropshipSelectionAtpService,
  authenticated: boolean,
  changes?: DropshipSelectionChangeService,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { session: Record<string, unknown> }).session = authenticated
      ? {
          dropship: {
            authIdentityId: 1,
            memberId: "member-1",
            cardShellzEmail: "vendor@cardshellz.test",
            hasPasskey: false,
            authMethod: "password",
            entitlementStatus: "active",
            authenticatedAt: "2026-05-08T12:00:00.000Z",
          },
          dropshipSensitiveProofs: {},
        }
      : {};
    next();
  });
  registerDropshipVendorCatalogRoutes(app, service, changes);
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

async function jsonRequest(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.json(),
  };
}
