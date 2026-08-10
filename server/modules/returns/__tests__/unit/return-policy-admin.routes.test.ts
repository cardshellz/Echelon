import http from "http";
import { AddressInfo } from "net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReturnPolicyAdminError, type ReturnPolicyAdminService } from "../../application/return-policy-admin.service";
import { registerReturnPolicyAdminRoutes } from "../../interfaces/http/return-policy-admin.routes";

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: requirePermissionMock,
}));

describe("return policy admin routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: ReturnType<typeof fakeService>;

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = fakeService();
    server = await startServer(buildApp(service));
  });

  afterEach(async () => server.close());

  it("requires an idempotency key for version creation", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPolicy()),
    });

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: "RETURN_POLICY_IDEMPOTENCY_REQUIRED" } },
    });
    expect(service.createVersion).not.toHaveBeenCalled();
  });

  it("rejects mutation requests without an authenticated audit actor", async () => {
    await server.close();
    server = await startServer(buildApp(service, false));

    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "returns-test-1" },
      body: JSON.stringify(validPolicy()),
    });

    expect(response).toMatchObject({
      status: 401,
      body: { error: { code: "RETURN_POLICY_ACTOR_REQUIRED" } },
    });
    expect(service.createVersion).not.toHaveBeenCalled();
  });

  it("validates, normalizes, and forwards a new version with its audit actor", async () => {
    service.createVersion.mockResolvedValue({ policy: { id: 42 }, replayed: false });

    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": " returns-test-2 " },
      body: JSON.stringify(validPolicy()),
    });

    expect(response).toEqual({ status: 201, body: { policy: { id: 42 }, replayed: false } });
    expect(requirePermissionMock).toHaveBeenCalledWith("settings", "edit");
    expect(service.createVersion).toHaveBeenCalledWith({
      ...validPolicy(),
      idempotencyKey: "returns-test-2",
      actor: "operator-1",
    });
  });

  it("returns 200 when the idempotent command is replayed", async () => {
    service.createVersion.mockResolvedValue({ policy: { id: 42 }, replayed: true });

    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "returns-test-3" },
      body: JSON.stringify(validPolicy()),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ replayed: true });
  });

  it("preserves classified policy conflicts", async () => {
    service.createVersion.mockRejectedValue(new ReturnPolicyAdminError(
      "RETURN_POLICY_IDEMPOTENCY_CONFLICT",
      "The key was already used.",
      409,
      { key: "returns-test-4" },
    ));

    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "returns-test-4" },
      body: JSON.stringify(validPolicy()),
    });

    expect(response).toEqual({
      status: 409,
      body: {
        error: {
          code: "RETURN_POLICY_IDEMPOTENCY_CONFLICT",
          message: "The key was already used.",
          context: { key: "returns-test-4" },
        },
      },
    });
  });

  it("rejects structurally invalid scopes before calling the service", async () => {
    const response = await jsonRequest(`${server.url}/api/returns/admin/policies/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessContext: "retail", channelId: 0, vendorId: null, storeConnectionId: null }),
    });

    expect(response).toMatchObject({ status: 400, body: { error: { code: "RETURN_POLICY_INVALID" } } });
    expect(service.resolve).not.toHaveBeenCalled();
  });
});

function validPolicy() {
  return {
    name: "Shopify direct returns",
    scopeKind: "channel_context",
    businessContext: "retail",
    channelId: 36,
    vendorId: null,
    storeConnectionId: null,
    returnWindowDays: 30,
    returnDestination: "card_shellz",
    approvalAuthority: "card_shellz",
    labelProvider: "shipstation",
    returnShippingPayer: "customer",
    inspectionRequirement: "required",
    inspectionOwner: "card_shellz",
    customerRefundAuthority: "card_shellz",
    vendorSettlementTrigger: "none",
    returnlessRefundAllowed: false,
    notes: null,
  };
}

function fakeService() {
  return {
    listOverview: vi.fn(),
    listActivePolicies: vi.fn(),
    resolve: vi.fn(),
    createVersion: vi.fn(),
  };
}

function buildApp(service: ReturnType<typeof fakeService>, authenticated = true): express.Express {
  const app = express();
  app.use(express.json());
  if (authenticated) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, "session", {
        configurable: true,
        value: { user: { id: "operator-1" } },
      });
      next();
    });
  }
  registerReturnPolicyAdminRoutes(app, service as unknown as ReturnPolicyAdminService);
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
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: init?.method ?? "GET",
      headers: init?.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body: rawBody === "" ? {} : JSON.parse(rawBody) as Record<string, unknown>,
        });
      });
    });
    request.on("error", reject);
    if (init?.body !== undefined) request.write(init.body);
    request.end();
  });
}
