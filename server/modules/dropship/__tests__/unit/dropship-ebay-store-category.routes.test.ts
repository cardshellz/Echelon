import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipEbayStoreCategoryService } from "../../application/dropship-ebay-store-category-service";
import { DropshipError } from "../../domain/errors";
import { registerDropshipEbayStoreCategoryRoutes } from "../../interfaces/http/dropship-ebay-store-category.routes";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../infrastructure/dropship-ebay-store-category.factory", () => ({
  createDropshipEbayStoreCategoryServiceFromEnv: vi.fn(),
}));

describe("dropship eBay Store category routes", () => {
  let service: FakeService;
  let server: { url: string; close: () => Promise<void> } | null;

  beforeEach(() => {
    service = new FakeService();
    server = null;
  });

  afterEach(async () => {
    await server?.close();
  });

  it("lists categories for the authenticated member-owned store", async () => {
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(`${server.url}/api/dropship/ebay/store-categories/44`);

    expect(response.status).toBe(200);
    expect(service.listCall).toEqual({
      memberId: "member-1",
      input: { storeConnectionId: 44 },
    });
  });

  it("passes assignment identity and one unambiguous idempotency key", async () => {
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(
      `${server.url}/api/dropship/ebay/store-category-assignments/501`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "store-category-route-001",
        },
        body: JSON.stringify({
          storeConnectionId: 44,
          storeCategoryIds: ["22"],
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(service.replaceCall).toEqual({
      memberId: "member-1",
      input: {
        storeConnectionId: 44,
        productVariantId: 501,
        storeCategoryIds: ["22"],
        idempotencyKey: "store-category-route-001",
      },
    });
  });

  it("rejects conflicting body and header idempotency keys before the service call", async () => {
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(
      `${server.url}/api/dropship/ebay/store-category-assignments/501`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "store-category-route-002",
        },
        body: JSON.stringify({
          storeConnectionId: 44,
          storeCategoryIds: ["22"],
          idempotencyKey: "store-category-route-003",
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { code: "DROPSHIP_EBAY_STORE_CATEGORY_IDEMPOTENCY_CONFLICT" },
    });
    expect(service.replaceCall).toBeNull();
  });

  it("rejects category access without a dropship session", async () => {
    server = await startServer(buildApp(service, false));

    const response = await jsonRequest(`${server.url}/api/dropship/ebay/store-categories/44`);

    expect(response.status).toBe(401);
    expect(service.listCall).toBeNull();
  });

  it("does not expose provider response bodies in public error context", async () => {
    service.listError = new DropshipError(
      "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
      "eBay token refresh failed.",
      {
        storeConnectionId: 44,
        retryable: false,
        body: "provider-secret-diagnostic",
      },
    );
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(`${server.url}/api/dropship/ebay/store-categories/44`);

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      error: {
        code: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
        context: { storeConnectionId: 44, retryable: false },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("provider-secret-diagnostic");
  });
});

class FakeService {
  listCall: unknown = null;
  replaceCall: unknown = null;
  listError: Error | null = null;

  async listForMember(memberId: string, input: unknown) {
    this.listCall = { memberId, input };
    if (this.listError) throw this.listError;
    return { storeConnectionId: 44, categories: [], assignments: [], fetchedAt: new Date(0) };
  }

  async replaceForMember(memberId: string, input: unknown) {
    this.replaceCall = { memberId, input };
    return { assignment: null, revisionId: 9, idempotentReplay: false };
  }
}

function buildApp(service: FakeService, authenticated: boolean): express.Express {
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
            authenticatedAt: "2026-08-29T12:00:00.000Z",
          },
          dropshipSensitiveProofs: {},
        }
      : {};
    next();
  });
  registerDropshipEbayStoreCategoryRoutes(
    app,
    service as unknown as DropshipEbayStoreCategoryService,
  );
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}
