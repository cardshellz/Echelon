import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFulfillmentProviderConnectionAdminRoutes } from "../../interfaces/http/fulfillment-provider-connections-admin.routes";

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({ requirePermission: requirePermissionMock }));

describe("fulfillment provider connection admin routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: ReturnType<typeof fakeService>;

  beforeEach(async () => {
    service = fakeService();
    server = await startServer(buildApp(service));
  });

  afterEach(async () => server.close());

  it("loads connection metadata with view permission", async () => {
    service.getAdminView.mockResolvedValue({ providers: [], connections: [] });

    const response = await jsonRequest(`${server.url}/api/shipping/admin/fulfillment-provider-connections`);

    expect(response).toEqual({ status: 200, body: { providers: [], connections: [] } });
    expect(requirePermissionMock).toHaveBeenCalledWith("settings", "view");
  });

  it("validates and forwards a credential without echoing it in the response", async () => {
    service.createConnection.mockResolvedValue({
      idempotentReplay: false,
      connection: { id: 11, name: "Primary ShipStation" },
    });
    const credential = "secret-api-key";
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/fulfillment-provider-connections`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "shipstation_v2",
          name: "Primary ShipStation",
          credential,
          idempotencyKey: "provider-create-00000001",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(JSON.stringify(response.body)).not.toContain(credential);
    expect(service.createConnection).toHaveBeenCalledWith({
      command: {
        provider: "shipstation_v2",
        name: "Primary ShipStation",
        credential,
        idempotencyKey: "provider-create-00000001",
      },
      actorUserId: "operator-1",
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("settings", "edit");
  });

  it("rejects malformed provider keys at the HTTP boundary", async () => {
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/fulfillment-provider-connections`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "Ship Station",
          name: "Primary",
          credential: "secret",
          idempotencyKey: "provider-create-00000002",
        }),
      },
    );

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_INVALID_INPUT" } },
    });
    expect(service.createConnection).not.toHaveBeenCalled();
  });
});

function fakeService() {
  return {
    getAdminView: vi.fn(),
    createConnection: vi.fn(),
    replaceCredential: vi.fn(),
    verifyConnection: vi.fn(),
    setConnectionEnabled: vi.fn(),
  };
}

function buildApp(service: ReturnType<typeof fakeService>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, "session", {
      configurable: true,
      value: { user: { id: "operator-1" } },
    });
    next();
  });
  registerFulfillmentProviderConnectionAdminRoutes(app, { service });
  return app;
}

async function startServer(app: express.Express) {
  const instance = http.createServer(app);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      instance.close((error) => error ? reject(error) : resolve());
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
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
      });
    });
    request.on("error", reject);
    if (init?.body) request.write(init.body);
    request.end();
  });
}
