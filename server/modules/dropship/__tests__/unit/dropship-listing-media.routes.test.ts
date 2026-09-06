import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDropshipListingRoutes } from "../../interfaces/http/dropship-listing.routes";
import type { DropshipListingPreviewService } from "../../application/dropship-listing-preview-service";
import { DropshipError } from "../../domain/errors";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../infrastructure/dropship-listing-preview.factory", () => ({ createDropshipListingPreviewServiceFromEnv: () => ({}) }));

describe("private dropship listing media route", () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  async function start(authenticated: boolean, imageForMember: ReturnType<typeof vi.fn>) {
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { session: Record<string, unknown> }).session = authenticated ? {
        dropship: { authIdentityId: 1, memberId: "member-1", cardShellzEmail: "vendor@example.test",
          hasPasskey: false, authMethod: "password", entitlementStatus: "active", authenticatedAt: "2026-09-06T12:00:00Z" },
      } : {};
      next();
    });
    registerDropshipListingRoutes(app, { imageForMember } as unknown as DropshipListingPreviewService);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dropship/listings/stores/9/variants/7/assets/3/file`;
  }

  it("requires the dropship session before reading an image", async () => {
    const imageForMember = vi.fn();
    const url = await start(false, imageForMember);
    const response = await fetch(url);
    expect(response.status).toBe(401);
    expect(imageForMember).not.toHaveBeenCalled();
  });

  it("serves authorized image bytes privately with a non-executable response", async () => {
    const imageForMember = vi.fn(async () => ({ data: Buffer.from("png-data"), mimeType: "image/png" }));
    const url = await start(true, imageForMember);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(await response.text()).toBe("png-data");
    expect(imageForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 9, productVariantId: 7, assetId: 3 });
  });

  it("does not serve bytes when the application rejects an asset", async () => {
    const imageForMember = vi.fn(async () => { throw new DropshipError("DROPSHIP_LISTING_IMAGE_NOT_FOUND", "Listing image is unavailable."); });
    const url = await start(true, imageForMember);
    const response = await fetch(url);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "DROPSHIP_LISTING_IMAGE_NOT_FOUND" } });
  });
});
