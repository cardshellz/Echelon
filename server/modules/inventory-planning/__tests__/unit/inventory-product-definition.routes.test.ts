import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProductDefinitionRoutes } from "../../interfaces/http/inventory-product-definition.routes";
import { registerSafetyDefinitionRoutes } from "../../interfaces/http/inventory-safety-definition.routes";
import { registerChannelDefinitionRoutes } from "../../interfaces/http/inventory-channel-definition.routes";
import { registerChannelRuleDefinitionRoutes } from "../../interfaces/http/inventory-channel-rule.routes";
import { ProductDefinitionError } from "../../application/inventory-product-definition.service";
import { ChannelDefinitionError } from "../../application/inventory-channel-definition.service";
import { InventoryCutoverManifestError } from "../../domain/inventory-cutover-manifest";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
vi.mock("../../../identity", () => ({ hasPermission }));
describe.each(["product", "safety", "channel", "channel-rule"] as const)("%s definition permission boundary", kind => {
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
    else if (kind === "channel-rule") registerChannelRuleDefinitionRoutes(app, service as never);
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

describe("single channel rule error classification", () => {
  let server: http.Server;
  let url: string;
  const service = { review: vi.fn(), apply: vi.fn(), progress: vi.fn() };
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    for (const method of Object.values(service)) method.mockReset();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.defineProperty(req, "session", { value: { user: { id: "operator" } }, configurable: true }); next(); });
    registerChannelRuleDefinitionRoutes(app, service as never);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory-planning/admin/channel-rule-definitions`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const apply = () => fetch(`${url}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

  it("returns the rule's own conflict codes with their status", async () => {
    service.apply.mockRejectedValue(new ChannelDefinitionError("CHANNEL_RULE_REVIEW_BLOCKED", "Fix the problems this rule would create before applying it."));
    const response = await apply();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "CHANNEL_RULE_REVIEW_BLOCKED", message: "Fix the problems this rule would create before applying it." } });
  });

  it("reports a head that moved during promotion as a definite stale rejection, not an unknown outcome", async () => {
    service.apply.mockRejectedValue(new InventoryCutoverManifestError("CUTOVER_REVIEWED_HEAD_CHANGED", "changed"));
    const response = await apply();
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("CHANNEL_RULE_REVIEW_STALE");
  });

  it("keeps an unverified result retryable with the same key", async () => {
    service.apply.mockRejectedValue(new ChannelDefinitionError("CHANNEL_RULE_RESULT_INVALID", "The result could not be verified.", 500));
    expect((await apply()).status).toBe(500);
  });

  it("passes the progress scope key through unchanged", async () => {
    service.progress.mockResolvedValue(null);
    const response = await fetch(`${url}/progress?scopeKey=${encodeURIComponent("channel:36:variant:22")}`);
    expect(response.status).toBe(200);
    expect(service.progress).toHaveBeenCalledWith("channel:36:variant:22");
    expect(hasPermission).toHaveBeenCalledWith("operator", "inventory_planning", "view");
  });
});
