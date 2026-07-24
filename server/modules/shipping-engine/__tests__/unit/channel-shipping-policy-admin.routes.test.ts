import http from "http";
import { AddressInfo } from "net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelShippingPolicyAdminError } from "../../application/channel-shipping-policy-admin.service";
import { registerChannelShippingPolicyAdminRoutes } from "../../interfaces/http/channel-shipping-policy-admin.routes";

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

describe("channel shipping policy admin routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: ReturnType<typeof fakeService>;

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = fakeService();
    server = await startServer(buildApp(service));
  });

  afterEach(async () => server.close());

  it("validates and forwards a draft-save command with the audit actor", async () => {
    service.savePolicyDraft.mockResolvedValue({ id: 12 });
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/channel-policies/12/draft`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedLockVersion: 3,
          notes: "US checkout",
          routes: [{
            originWarehouseId: null,
            destinationScopeId: 9,
            mode: "engine_quoted",
            eligibilityMode: "intersection",
            rateBookId: 4,
          }],
        }),
      },
    );

    expect(response).toEqual({ status: 200, body: { id: 12 } });
    expect(requirePermissionMock).toHaveBeenCalledWith("settings", "edit");
    expect(service.savePolicyDraft).toHaveBeenCalledWith({
      policyId: 12,
      expectedLockVersion: 3,
      notes: "US checkout",
      routes: [{
        originWarehouseId: null,
        destinationScopeId: 9,
        mode: "engine_quoted",
        eligibilityMode: "intersection",
        rateBookId: 4,
      }],
    }, "operator-1");
  });

  it("rejects unsupported route modes before calling the service", async () => {
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/channel-policies/12/draft`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedLockVersion: 1,
          notes: null,
          routes: [{
            originWarehouseId: null,
            destinationScopeId: null,
            mode: "guess",
            eligibilityMode: "none",
            rateBookId: null,
          }],
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "SHIPPING_CHANNEL_POLICY_INVALID_INPUT" },
    });
    expect(service.savePolicyDraft).not.toHaveBeenCalled();
  });

  it("rejects mutation requests without an authenticated audit actor", async () => {
    await server.close();
    server = await startServer(buildApp(service, false));

    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/channel-policies/drafts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: 36,
          purpose: "customer_checkout",
          cloneActive: true,
          notes: null,
        }),
      },
    );

    expect(response).toMatchObject({
      status: 401,
      body: {
        error: { code: "SHIPPING_CHANNEL_POLICY_ACTOR_REQUIRED" },
      },
    });
    expect(service.createPolicyDraft).not.toHaveBeenCalled();
  });

  it("preserves classified activation failures and their details", async () => {
    service.activatePolicyDraft.mockRejectedValue(
      new ChannelShippingPolicyAdminError(
        409,
        "SHIPPING_CHANNEL_POLICY_NOT_READY",
        "Resolve the policy validation errors before activation.",
        ["Fallback route missing."],
      ),
    );
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/channel-policies/12/activate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedLockVersion: 2 }),
      },
    );

    expect(response).toEqual({
      status: 409,
      body: {
        error: {
          code: "SHIPPING_CHANNEL_POLICY_NOT_READY",
          message: "Resolve the policy validation errors before activation.",
          details: ["Fallback route missing."],
        },
      },
    });
  });

  it("forwards an authenticated draft-discard command", async () => {
    service.discardPolicyDraft.mockResolvedValue({ id: 12, status: "retired" });
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/channel-policies/12/discard`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedLockVersion: 4 }),
      },
    );

    expect(response).toEqual({
      status: 200,
      body: { id: 12, status: "retired" },
    });
    expect(service.discardPolicyDraft).toHaveBeenCalledWith({
      policyId: 12,
      expectedLockVersion: 4,
    }, "operator-1");
  });

  it("normalizes empty optional draft fields at the HTTP boundary", async () => {
    service.createPolicyDraft.mockResolvedValue({ id: 31 });
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/channel-policies/drafts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: 36,
          purpose: "vendor_fulfillment_charge",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(service.createPolicyDraft).toHaveBeenCalledWith({
      channelId: 36,
      purpose: "vendor_fulfillment_charge",
      cloneActive: true,
      notes: null,
    }, "operator-1");
  });
});

function fakeService() {
  return {
    listOverview: vi.fn(),
    getPolicy: vi.fn(),
    createDestinationScope: vi.fn(),
    updateDestinationScope: vi.fn(),
    retireDestinationScope: vi.fn(),
    createPolicyDraft: vi.fn(),
    savePolicyDraft: vi.fn(),
    activatePolicyDraft: vi.fn(),
    discardPolicyDraft: vi.fn(),
    retireActivePolicy: vi.fn(),
    previewPolicyResolution: vi.fn(),
    comparePolicyToLegacy: vi.fn(),
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
  registerChannelShippingPolicyAdminRoutes(app, { service });
  return app;
}

async function startServer(
  app: express.Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve));
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
          body: rawBody === ""
            ? {}
            : JSON.parse(rawBody) as Record<string, unknown>,
        });
      });
    });
    request.on("error", reject);
    if (init?.body !== undefined) request.write(init.body);
    request.end();
  });
}
