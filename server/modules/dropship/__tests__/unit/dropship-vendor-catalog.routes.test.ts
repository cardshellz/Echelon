import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipSelectionAtpService } from "../../application/dropship-selection-atp-service";
import { registerDropshipVendorCatalogRoutes } from "../../interfaces/http/dropship-vendor-catalog.routes";

vi.mock("../../../../db", () => ({
  db: {},
  pool: {},
}));

vi.mock("../../../inventory/atp.service", () => ({
  createInventoryAtpService: () => ({}),
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

  it("requires sensitive-action proof before replacing catalog selection rules", async () => {
    server = await startServer(buildApp(service as unknown as DropshipSelectionAtpService, false));

    const response = await jsonRequest(`${server.url}/api/dropship/catalog/selection-rules`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "catalog-selection-001",
      },
      body: JSON.stringify({ rules: [] }),
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({
      code: "DROPSHIP_STEP_UP_REQUIRED",
    });
    expect(service.lastReplaceInput).toBeNull();
  });

  it("replaces catalog selection rules after a valid sensitive-action proof", async () => {
    server = await startServer(buildApp(service as unknown as DropshipSelectionAtpService, true));

    const response = await jsonRequest(`${server.url}/api/dropship/catalog/selection-rules`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "catalog-selection-002",
      },
      body: JSON.stringify({ rules: [] }),
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      revisionId: 77,
      idempotentReplay: false,
      rules: [],
    });
    expect(service.lastReplaceInput).toMatchObject({
      vendorId: 10,
      idempotencyKey: "catalog-selection-002",
      actor: {
        actorType: "vendor",
        actorId: "member-1",
      },
      rules: [],
    });
  });
});

class FakeDropshipSelectionAtpService {
  lastReplaceInput: unknown = null;

  async requireVendorForMember(memberId: string) {
    return {
      vendorId: 10,
      memberId,
      status: "active",
      entitlementStatus: "active",
    };
  }

  async replaceSelectionRules(input: unknown) {
    this.lastReplaceInput = input;
    return {
      revisionId: 77,
      idempotentReplay: false,
      rules: [],
    };
  }
}

function buildApp(
  service: DropshipSelectionAtpService,
  includeSensitiveProof: boolean,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { session: Record<string, unknown> }).session = {
      dropship: {
        authIdentityId: 1,
        memberId: "member-1",
        cardShellzEmail: "vendor@cardshellz.test",
        hasPasskey: false,
        authMethod: "password",
        entitlementStatus: "active",
        authenticatedAt: "2026-05-08T12:00:00.000Z",
      },
      dropshipSensitiveProofs: includeSensitiveProof
        ? {
            manage_catalog_selection: {
              method: "email_mfa",
              verifiedAt: "2026-05-08T12:00:00.000Z",
              expiresAt: "2099-05-08T12:10:00.000Z",
            },
          }
        : {},
    };
    next();
  });
  registerDropshipVendorCatalogRoutes(app, service);
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
