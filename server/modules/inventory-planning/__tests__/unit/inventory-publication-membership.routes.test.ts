import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInventoryPublicationMembershipRoutes } from "../../interfaces/http/inventory-publication-membership.routes";
import { InventoryPublicationMembershipError } from "../../application/inventory-publication-membership.service";

const { hasPermission } = vi.hoisted(() => ({
  hasPermission: vi.fn(async () => true),
}));
vi.mock("../../../identity", () => ({ hasPermission }));
describe("inventory membership permission boundary", () => {
  let server: http.Server, url: string;
  let service: {
    inspect: ReturnType<typeof vi.fn>;
    review: ReturnType<typeof vi.fn>;
    apply: ReturnType<typeof vi.fn>;
  };
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    service = {
      inspect: vi.fn(async () => ({})),
      review: vi.fn(async () => ({})),
      apply: vi.fn(async () => ({})),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, "session", {
        value: { user: { id: "operator" } },
      });
      next();
    });
    registerInventoryPublicationMembershipRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory-planning/admin/publication-membership`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const post = (path: string) =>
    fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  it.each(["inspect", "review"])(
    "allows %s with inventory view without activating anything",
    async (path) => {
      const response = await post(`/${path}`);
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(hasPermission).toHaveBeenCalledWith(
        "operator",
        "inventory_planning",
        "view",
      );
      expect(service.apply).not.toHaveBeenCalled();
    },
  );
  it("requires activation permission and uses only the authenticated actor", async () => {
    expect((await post("/apply")).status).toBe(410);
    expect(hasPermission).toHaveBeenCalledWith(
      "operator",
      "inventory_planning",
      "activate",
    );
    expect(service.apply).not.toHaveBeenCalled();
  });
  it("rejects unauthorized mutation before the service runs", async () => {
    hasPermission.mockResolvedValue(false);
    expect((await post("/apply")).status).toBe(403);
    expect(service.apply).not.toHaveBeenCalled();
  });
  it("returns directions without invoking a retired owner", async () => {
    const response = await post("/apply");
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({error:{code:"PUBLICATION_MEMBERSHIP_RETIRED",message:expect.stringContaining("channel listing selection")}});
    expect(service.apply).not.toHaveBeenCalled();
  });
});
