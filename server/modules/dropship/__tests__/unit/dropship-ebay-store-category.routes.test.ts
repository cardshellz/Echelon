import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipEbayStoreCategoryService } from "../../application/dropship-ebay-store-category-service";
import { DropshipError } from "../../domain/errors";
import { registerDropshipEbayStoreCategoryRoutes } from "../../interfaces/http/dropship-ebay-store-category.routes";
import { logger } from "../../../../platform/observability/logger";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../infrastructure/dropship-ebay-store-category.factory", () => ({
  createDropshipEbayStoreCategoryServiceFromEnv: vi.fn(),
}));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("dropship eBay Store category routes", () => {
  let service: FakeService;
  let server: { url: string; close: () => Promise<void> } | null;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FakeService();
    server = null;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it("no longer serves the per-size shelf write, deleted in Listing settings PR 12", async () => {
    server = await startServer(buildApp(service, true));

    const response = await fetch(`${server.url}/api/dropship/ebay/store-category-assignments/501`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "store-category-route-001" },
      body: JSON.stringify({ storeConnectionId: 44, storeCategoryIds: ["22"] }),
    });

    expect(response.status).toBe(404);
    expect(service.listCall).toBeNull();
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

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: {
        code: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
        context: { storeConnectionId: 44, retryable: false },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("provider-secret-diagnostic");
  });

  it("hides an unexpected failure behind a generic 500 and logs one structured ERROR line, never console (PR 12 verify VS4)", async () => {
    const consoleSpies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined));
    service.listError = new Error("unexpected directory failure");
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(`${server.url}/api/dropship/ebay/store-categories/44`);

    expect(response).toEqual({ status: 500, body: { error: {
      code: "DROPSHIP_EBAY_STORE_CATEGORY_INTERNAL_ERROR", message: "eBay Store category request failed." } } });
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    // CLAUDE.md section 10: the platform logger, the listing settings routes' entry (dropship-route-failure-log.ts).
    expect(vi.mocked(logger.error).mock.calls).toEqual([["dropship.ebay_store_categories.request_failed", {
      outcome: "failed", error_code: "DROPSHIP_EBAY_STORE_CATEGORY_INTERNAL_ERROR", status: 500, method: "GET",
      path: "/api/dropship/ebay/store-categories/:storeConnectionId", store_connection_id: 44, actor_id: "member-1",
      error_class: "fatal", error_message: "unexpected directory failure" }]]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs nothing for a refusal it answers with its own status", async () => {
    service.listError = new DropshipError("DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED", "Reauthorize.",
      { storeConnectionId: 44, retryable: false });
    server = await startServer(buildApp(service, true));

    const response = await jsonRequest(`${server.url}/api/dropship/ebay/store-categories/44`);

    expect(response.status).toBe(403);
    for (const level of ["info", "warn", "error"] as const) expect(logger[level]).not.toHaveBeenCalled();
  });
});

class FakeService {
  listCall: unknown = null;
  listError: Error | null = null;

  async listForMember(memberId: string, input: unknown) {
    this.listCall = { memberId, input };
    if (this.listError) throw this.listError;
    return { storeConnectionId: 44, categories: [], assignments: [], fetchedAt: new Date(0) };
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
