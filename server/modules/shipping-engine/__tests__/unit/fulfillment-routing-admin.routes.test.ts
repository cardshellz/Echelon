import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FulfillmentRoutingError } from "../../application/fulfillment-routing.service";
import { registerFulfillmentRoutingAdminRoutes } from "../../interfaces/http/fulfillment-routing-admin.routes";

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

describe("fulfillment routing admin routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: ReturnType<typeof fakeService>;

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = fakeService();
    server = await startServer(buildApp(service));
  });

  afterEach(async () => server.close());

  it("loads one service-level routing profile with view permission", async () => {
    service.getAdminView.mockResolvedValue({ serviceLevel: { id: 7 } });

    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/service-levels/7/fulfillment-routing`,
    );

    expect(response).toEqual({ status: 200, body: { serviceLevel: { id: 7 } } });
    expect(service.getAdminView).toHaveBeenCalledWith(7);
    expect(requirePermissionMock).toHaveBeenCalledWith("settings", "view");
  });

  it("validates and forwards an exact routing command with its audit actor", async () => {
    service.replaceProfile.mockResolvedValue({ commandRevision: 2 });
    const command = {
      expectedRevision: 1,
      idempotencyKey: "routing-command-00000001",
      methods: [{
        provider: "shipstation_v2",
        providerAccountId: "se-fedex-1",
        serviceCode: "fedex_ground",
      }],
    };

    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/service-levels/7/fulfillment-routing`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      },
    );

    expect(response).toEqual({ status: 200, body: { commandRevision: 2 } });
    expect(service.replaceProfile).toHaveBeenCalledWith({
      serviceLevelId: 7,
      command,
      actorUserId: "operator-1",
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("settings", "edit");
  });

  it("rejects invented providers before calling the application service", async () => {
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/service-levels/7/fulfillment-routing`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          idempotencyKey: "routing-command-00000002",
          methods: [{
            provider: "other",
            providerAccountId: "account",
            serviceCode: "service",
          }],
        }),
      },
    );

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: "SHIPPING_FULFILLMENT_ROUTING_INVALID_INPUT" } },
    });
    expect(service.replaceProfile).not.toHaveBeenCalled();
  });

  it("requires an authenticated operator for mutation audit evidence", async () => {
    await server.close();
    server = await startServer(buildApp(service, false));

    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/service-levels/7/fulfillment-routing`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          idempotencyKey: "routing-command-00000003",
          methods: [],
        }),
      },
    );

    expect(response).toMatchObject({
      status: 401,
      body: { error: { code: "SHIPPING_FULFILLMENT_ROUTING_ACTOR_REQUIRED" } },
    });
    expect(service.replaceProfile).not.toHaveBeenCalled();
  });

  it("preserves classified concurrency failures and details", async () => {
    service.replaceProfile.mockRejectedValue(new FulfillmentRoutingError(
      409,
      "SHIPPING_FULFILLMENT_ROUTING_REVISION_CONFLICT",
      "Refresh before saving.",
      ["Expected 1; current is 2."],
    ));

    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/service-levels/7/fulfillment-routing`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 1,
          idempotencyKey: "routing-command-00000004",
          methods: [],
        }),
      },
    );

    expect(response).toEqual({
      status: 409,
      body: {
        error: {
          code: "SHIPPING_FULFILLMENT_ROUTING_REVISION_CONFLICT",
          message: "Refresh before saving.",
          details: ["Expected 1; current is 2."],
        },
      },
    });
  });
});

function fakeService() {
  return {
    getAdminView: vi.fn(),
    replaceProfile: vi.fn(),
  };
}

function buildApp(
  service: ReturnType<typeof fakeService>,
  authenticated = true,
): express.Express {
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
  registerFulfillmentRoutingAdminRoutes(app, { service });
  return app;
}

async function startServer(
  app: express.Express,
): Promise<{ url: string; close: () => Promise<void> }> {
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
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body: body ? JSON.parse(body) as Record<string, unknown> : {},
        });
      });
    });
    request.on("error", reject);
    if (init?.body !== undefined) request.write(init.body);
    request.end();
  });
}
