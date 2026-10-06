import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerListingUpdateRoutes } from "../../interfaces/http/listing-update.routes";

vi.mock("../../../../routes/middleware", () => ({
  requirePermission:
    (resource: string, action: string) =>
    (
      request: express.Request,
      response: express.Response,
      next: express.NextFunction,
    ) => {
      if (request.headers["x-permission"] !== `${resource}:${action}`) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
      Object.assign(request, { session: { user: { id: "operator-1" } } });
      next();
    },
}));

describe("listing update HTTP boundary", () => {
  let server: Server, base: string;
  const service = {
    list: vi.fn(),
    context: vi.fn(),
    requirements: vi.fn(),
    review: vi.fn(),
    submit: vi.fn(),
    refresh: vi.fn(),
  };
  beforeEach(async () => {
    vi.resetAllMocks();
    const app = express();
    app.use(express.json());
    Object.assign(app.locals, { services: { listingUpdates: service } });
    registerListingUpdateRoutes(app);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/channels/104/listing-updates`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  it.each(["/review", "/id/submit", "/id/status"])(
    "requires edit permission for %s",
    async (path) => {
      const response = await fetch(base + path, {
        method: "POST",
        headers: {
          "x-permission": "channels:view",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(response.status).toBe(403);
      expect(service.review).not.toHaveBeenCalled();
      expect(service.submit).not.toHaveBeenCalled();
      expect(service.refresh).not.toHaveBeenCalled();
    },
  );
  it("passes only the authenticated actor and URL channel to the update owner", async () => {
    service.review.mockResolvedValue({ id: "review" });
    const body = {
      sku: "SKU-10",
      changes: { priceCents: 2799 },
      actor: "forged",
      channelId: 999,
    };
    const response = await fetch(`${base}/review`, {
      method: "POST",
      headers: {
        "x-permission": "channels:edit",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(service.review).toHaveBeenCalledExactlyOnceWith(
      104,
      body,
      "operator-1",
    );
  });
  it("rejects invalid channel IDs before calling the owner", async () => {
    const response = await fetch(base.replace("104", "-1"), {
      headers: { "x-permission": "channels:view" },
    });
    expect(response.status).toBe(400);
    expect(service.list).not.toHaveBeenCalled();
  });
  it("never returns unknown exception bodies", async () => {
    service.list.mockRejectedValue(new Error("secret-database-string"));
    const response = await fetch(base, {
      headers: { "x-permission": "channels:view" },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret-database-string");
  });
});
