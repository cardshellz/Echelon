import http from "node:http";
import type { AddressInfo } from "node:net";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropshipEbayOAuthBrandingService } from "../../application/dropship-ebay-oauth-branding-service";
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

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    const service = new DropshipEbayOAuthBrandingService({
      DROPSHIP_EBAY_CLIENT_ID: "CardShellz-ops-production-client-id",
      DROPSHIP_EBAY_CLIENT_SECRET: "never-return-this-secret",
      EBAY_VENDOR_RUNAME: "CardShellz_CardShellz-ops-oauth",
    });
    const app = express();
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
      suggestedDisplayTitle: "Card Shellz .ops",
      ruName: {
        source: "EBAY_VENDOR_RUNAME",
        value: "CardShellz_CardShellz-ops-oauth",
      },
    });
    expect(JSON.stringify(body)).not.toContain("never-return-this-secret");
    expect(requirePermissionMock).toHaveBeenCalledWith("dropship", "view");
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
