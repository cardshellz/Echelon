import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProductDefinitionRoutes } from "../../interfaces/http/inventory-product-definition.routes";
import { registerSafetyDefinitionRoutes } from "../../interfaces/http/inventory-safety-definition.routes";
import { registerChannelDefinitionRoutes } from "../../interfaces/http/inventory-channel-definition.routes";
import { ProductDefinitionError } from "../../application/inventory-product-definition.service";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
vi.mock("../../../identity", () => ({ hasPermission }));
describe.each(["product", "safety", "channel"] as const)("%s definition permission boundary", kind => {
  let server: http.Server;
  let url: string;
  let service: { review: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn>; progress: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    service = { review: vi.fn(async () => ({})), apply: vi.fn(async () => ({})), progress: vi.fn(async () => null) };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, "session", { value: { user: { id: "operator" } }, configurable: true });
      next();
    });
    if (kind === "product") registerProductDefinitionRoutes(app, service as never);
    else if (kind === "channel") registerChannelDefinitionRoutes(app, service as never);
    else registerSafetyDefinitionRoutes(app, service as never);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory-planning/admin/${kind}-definitions`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  function post(path: string) { return fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); }
  it("uses view permission for read-only review", async () => {
    const response = await post("/review");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(hasPermission).toHaveBeenCalledWith("operator", "inventory_planning", "view");
    expect(service.apply).not.toHaveBeenCalled();
  });
  it("requires activate and passes only the session actor", async () => {
    expect((await post("/apply")).status).toBe(200);
    expect(hasPermission).toHaveBeenCalledWith("operator", "inventory_planning", "activate");
    expect(service.apply).toHaveBeenCalledWith({}, "operator");
  });
  it("rejects missing permission before invoking the mutation", async () => {
    hasPermission.mockResolvedValue(false);
    expect((await post("/apply")).status).toBe(403);
    expect(service.apply).not.toHaveBeenCalled();
  });
  it("returns stale review as a conflict, not a successful apply", async () => {
    service.apply.mockRejectedValue(new ProductDefinitionError("DEFINITION_REVIEW_STALE", "Review again."));
    const response = await post("/apply");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "DEFINITION_REVIEW_STALE", message: "Review again." } });
  });
});
