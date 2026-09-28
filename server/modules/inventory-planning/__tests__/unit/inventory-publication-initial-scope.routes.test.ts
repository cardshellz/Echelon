import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInventoryPublicationInitialScopeRoutes } from "../../interfaces/http/inventory-publication-initial-scope.routes";
import { InitialPublicationScopeError } from "../../application/inventory-publication-initial-scope.service";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
vi.mock("../../../identity", () => ({ hasPermission }));

describe("initial publication scope HTTP boundary", () => {
  let server: http.Server;
  let url: string;
  let signedIn: boolean;
  let service: { review: ReturnType<typeof vi.fn>; prepare: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    signedIn = true;
    service = { review: vi.fn(async () => ({})), prepare: vi.fn(async () => ({})) };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, "session", { value: signedIn ? { user: { id: "operator" } } : {} });
      next();
    });
    registerInventoryPublicationInitialScopeRoutes(app, service as never);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory-planning/admin/publication-initial-scope`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.restoreAllMocks();
  });
  // Windows can assign an ephemeral port on fetch's browser-style blocked-port
  // list. Native HTTP still exercises Express without that unrelated lottery.
  function post(path: string, body: unknown = {}): Promise<{ status: number; cacheControl?: string; body: unknown }> {
    return new Promise((resolve, reject) => {
      const request = http.request(`${url}/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
      }, response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { text += chunk; });
        response.on("error", reject);
        response.on("end", () => {
          try { resolve({ status: response.statusCode ?? 0, cacheControl: response.headers["cache-control"], body: JSON.parse(text) }); }
          catch (error) { reject(error); }
        });
      });
      request.on("error", reject);
      request.end(JSON.stringify(body));
    });
  }

  it.each(["review", "prepare"] as const)("requires activation permission for %s", async path => {
    const response = await post(path);
    expect(response.status).toBe(200);
    expect(response.cacheControl).toBe("no-store");
    expect(hasPermission).toHaveBeenCalledWith("operator", "inventory_planning", "activate");
  });
  it("supplies only the session actor, never a body-provided actor", async () => {
    await post("prepare", { actor: "spoofed" });
    expect(service.prepare).toHaveBeenCalledWith({ actor: "spoofed" }, "operator");
    expect(service.review).not.toHaveBeenCalled();
    // The service's strict command schema separately rejects that extra body field.
  });
  it.each(["review", "prepare"] as const)("rejects an unauthorized %s before invoking its service", async path => {
    hasPermission.mockResolvedValue(false);
    expect((await post(path)).status).toBe(403);
    expect(service.review).not.toHaveBeenCalled();
    expect(service.prepare).not.toHaveBeenCalled();
  });
  it("requires an authenticated session", async () => {
    signedIn = false;
    expect((await post("prepare")).status).toBe(401);
    expect(service.prepare).not.toHaveBeenCalled();
  });
  it("classifies invalid input without disclosing validation data", async () => {
    const result = z.number().safeParse("private invalid value");
    if (result.success) throw new Error("Invalid fixture");
    service.prepare.mockRejectedValue(result.error);
    const response = await post("prepare");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: {
      code: "INITIAL_SCOPE_INVALID_REQUEST", message: "A valid destination review and authenticated actor are required.",
    } });
  });
  it("returns stale evidence as a structured conflict", async () => {
    service.prepare.mockRejectedValue(new InitialPublicationScopeError("INITIAL_SCOPE_REVIEW_STALE", "Review again."));
    const response = await post("prepare");
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: "INITIAL_SCOPE_REVIEW_STALE", message: "Review again." } });
  });
  it.each(["40001", "40P01", "55P03", "55000", "57014"])("makes database conflict %s actionable without leaking SQL", async code => {
    service.prepare.mockRejectedValue(Object.assign(new Error("private SQL"), { code }));
    const response = await post("prepare");
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: {
      code: "INITIAL_SCOPE_BUSY", message: "Authority, listing work or cutover state changed. Review again before retrying.",
    } });
  });
  it("logs a classified unexpected failure and preserves retry identity guidance", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    service.prepare.mockRejectedValue(Object.assign(new Error("private credentials"), { code: "unsafe\nsecret" }));
    const response = await post("prepare");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: {
      code: "INITIAL_SCOPE_FAILED", message: "Preparation is not confirmed. Retry using the same command key.",
    } });
    expect(logger).toHaveBeenCalledWith(JSON.stringify({ event: "publication_initial_scope_failed", code: "UNKNOWN" }));
  });
});
