import http from "node:http";
import type { AddressInfo } from "node:net";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDropshipEbayOAuthBrandingConfiguration,
  type DropshipEbayOAuthBrandingConfiguration,
} from "../../application/dropship-ebay-oauth-branding-service";
import { registerDropshipAdminEbayOAuthBrandingRoutes } from "../../interfaces/http/dropship-admin-ebay-oauth-branding.routes";

const requirePermissionMock = vi.hoisted(() =>
  vi.fn((_resource: string, _action: string) =>
    (_req: Request, _res: Response, next: NextFunction) => next(),
  ),
);

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: requirePermissionMock,
}));

describe("dropship admin eBay OAuth branding routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let configuration: DropshipEbayOAuthBrandingConfiguration;
  let service: {
    getConfiguration: ReturnType<typeof vi.fn>;
    requestCustomerFacingAppName: ReturnType<typeof vi.fn>;
    confirmExternalUpdate: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    configuration = buildDropshipEbayOAuthBrandingConfiguration({
      DROPSHIP_EBAY_CLIENT_ID: "CardShellz-ops-production-client-id",
      DROPSHIP_EBAY_CLIENT_SECRET: "never-return-this-secret",
      EBAY_VENDOR_RUNAME: "CardShellz_CardShellz-ops-oauth",
    });
    service = {
      getConfiguration: vi.fn().mockResolvedValue(configuration),
      requestCustomerFacingAppName: vi.fn().mockResolvedValue({
        configuration,
        idempotentReplay: false,
      }),
      confirmExternalUpdate: vi.fn().mockResolvedValue({
        configuration,
        idempotentReplay: false,
      }),
    };
    const app = express();
    app.use(express.json());
    registerDropshipAdminEbayOAuthBrandingRoutes(app, service);
    server = await startServer(app);
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns safe .ops branding configuration behind dropship view permission", async () => {
    const response = await fetch(
      `${server.url}/api/dropship/admin/integrations/ebay/oauth-branding`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.configuration).toMatchObject({
      status: "ready",
      customerFacingAppName: {
        value: "Card Shellz .ops",
        revision: 0,
      },
      ruName: {
        source: "EBAY_VENDOR_RUNAME",
        value: "CardShellz_CardShellz-ops-oauth",
      },
    });
    expect(JSON.stringify(body)).not.toContain("never-return-this-secret");
    expect(requirePermissionMock).toHaveBeenCalledWith("dropship", "view");
  });

  it("saves an editable customer-facing app name with idempotency and admin permission", async () => {
    const response = await fetch(
      `${server.url}/api/dropship/admin/integrations/ebay/oauth-branding`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerFacingAppName: "Card Shellz",
          expectedRevision: 0,
          idempotencyKey: "branding-request-1",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(service.requestCustomerFacingAppName).toHaveBeenCalledWith({
      customerFacingAppName: "Card Shellz",
      expectedRevision: 0,
      idempotencyKey: "branding-request-1",
      actor: { actorType: "admin", actorId: undefined },
    });
    expect(requirePermissionMock).toHaveBeenCalledWith(
      "dropship",
      "manage_operations",
    );
  });

  it("rejects a mutation that has no idempotency key", async () => {
    const response = await fetch(
      `${server.url}/api/dropship/admin/integrations/ebay/oauth-branding`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerFacingAppName: "Card Shellz",
          expectedRevision: 0,
        }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("DROPSHIP_IDEMPOTENCY_KEY_REQUIRED");
    expect(service.requestCustomerFacingAppName).not.toHaveBeenCalled();
  });

  it("records manual completion through a separate idempotent endpoint", async () => {
    const response = await fetch(
      `${server.url}/api/dropship/admin/integrations/ebay/oauth-branding/external-update-verification`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "branding-verify-1",
        },
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    );

    expect(response.status).toBe(201);
    expect(service.confirmExternalUpdate).toHaveBeenCalledWith({
      expectedRevision: 1,
      idempotencyKey: "branding-verify-1",
      actor: { actorType: "admin", actorId: undefined },
    });
  });
});

async function startServer(
  app: express.Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
