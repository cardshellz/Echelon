import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShopifyProductConnectionError } from "../../shopify-product-connection.domain";
import { registerShopifyProductConnectionRoutes } from "../../shopify-product-connection.routes";
import { CONNECTION_COMMAND_KEY } from "../support/shopify-product-connection.fixture";

const mocks = vi.hoisted(() => ({ context: vi.fn(), search: vi.fn(), preview: vi.fn(), submit: vi.fn(), status: vi.fn(),
  grants: new Set(["inventory:view", "inventory:edit", "channels:view", "channels:edit", "inventory_planning:activate", "inventory_planning:view"]), authenticated: true }));
vi.mock("../../../../services/shopify-product-connection", () => ({ createDefaultShopifyProductConnectionService: () => mocks }));
vi.mock("../../../../routes/middleware", () => ({ requirePermission: (resource: string, action: string) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!mocks.authenticated) return res.status(401).json({ error: "Authentication required" });
    if (!mocks.grants.has(`${resource}:${action}`)) return res.status(403).json({ error: "Forbidden" });
    Object.assign(req, { session: { user: { id: "operator" } } }); next();
  } }));

describe("reviewed Shopify product command HTTP boundary", () => {
  let server: Server; let url: string;
  const request = { mode: "link", channelId: 7, currency: "USD", targetProductRef: "900", prices: [], bindings: [], publicationId: null, productOnlyRequiresShipping: true };
  const intent = { request, previewHash: "a".repeat(64), commandKey: CONNECTION_COMMAND_KEY };
  const command = { ...intent, productId: 41, channelId: 7, mode: "link", state: "pending", remoteProductId: null,
    lastErrorCode: null, lastErrorMessage: null, retryable: true, completedAt: null };
  beforeEach(async () => {
    vi.clearAllMocks(); mocks.authenticated = true; mocks.grants = new Set(["inventory:view", "inventory:edit", "channels:view", "channels:edit", "inventory_planning:activate", "inventory_planning:view"]);
    const app = express(); app.use(express.json()); registerShopifyProductConnectionRoutes(app);
    server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/products/41/shopify-connection`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  async function post(path: string, body: unknown) {
    const response = await fetch(`${url}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown>, headers: response.headers };
  }
  it("requires both edit grants and an authenticated actor before admitting writes", async () => {
    mocks.grants.delete("channels:edit"); expect((await post("execute", intent)).status).toBe(403);
    mocks.grants.add("channels:edit"); mocks.authenticated = false; expect((await post("preview", request)).status).toBe(401);
    expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.preview).not.toHaveBeenCalled();
  });
  it("requires inventory activation permission before reviewing or admitting a linking sync", async () => {
    mocks.grants.delete("inventory_planning:activate");
    expect((await post("preview", request)).status).toBe(403);
    expect((await post("execute", intent)).status).toBe(403);
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("serves bounded read-only search and strips private fields", async () => {
    mocks.search.mockResolvedValue({ products: [{ id: "900", title: "Draft binder", status: "DRAFT", token: "private" }], nextCursor: "next", credentials: {} });
    const response = await fetch(`${url}/search?channelId=7&query=PSA%20Binder&cursor=page`);
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ products: [{ id: "900", title: "Draft binder", status: "DRAFT" }], nextCursor: "next" });
    expect(mocks.search).toHaveBeenCalledWith(41, { channelId: 7, query: "PSA Binder", cursor: "page" });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("rejects untrusted search scope, malformed queries and missing view grants", async () => {
    for (const query of ["query=PSA", "channelId=0&query=PSA", "channelId=7&query=x", "channelId=7&query=PSA&query=Other",
      "channelId=7&query=PSA&shopDomain=evil.com", `channelId=7&query=${"x".repeat(201)}`, `channelId=7&query=PSA&cursor=${"c".repeat(2049)}`]) {
      expect((await fetch(`${url}/search?${query}`)).status).toBe(400);
    }
    for (const grant of ["inventory:view", "channels:view"]) {
      mocks.grants.delete(grant);
      expect((await fetch(`${url}/search?channelId=7&query=PSA`)).status).toBe(403);
      mocks.grants.add(grant);
    }
    mocks.authenticated = false;
    expect((await fetch(`${url}/search?channelId=7&query=PSA`)).status).toBe(401);
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("fails closed on an invalid search result", async () => {
    mocks.search.mockResolvedValue({ products: [{ id: "bad", title: "Draft", status: "DRAFT" }], nextCursor: null });
    expect((await fetch(`${url}/search?channelId=7&query=PSA`)).status).toBe(503);
  });
  it("rejects spoofed authority, malformed IDs and missing review evidence", async () => {
    for (const body of [{ ...intent, actor: "admin" }, { ...intent, previewHash: "short" }, { ...intent, commandKey: "not-a-uuid" },
      { ...intent, request: { ...request, channelId: -1 } }, { ...intent, request: { ...request, verifiedShopifyProduct: {} } }]) {
      expect((await post("execute", body)).status).toBe(400);
    }
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("queues the exact intent as 202 and strips internal receipt fields", async () => {
    mocks.submit.mockResolvedValue({ command: { ...command, leaseToken: "private-lease", source: { private: true } }, replayed: false });
    const response = await post("execute", intent);
    expect(response.status).toBe(202); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.submit).toHaveBeenCalledWith(41, intent, "user:operator");
    expect(response.body.command).not.toHaveProperty("leaseToken"); expect(response.body.command).not.toHaveProperty("source");
  });
  it("reports busy admission as a retryable conflict and refuses invalid output", async () => {
    mocks.submit.mockRejectedValueOnce(new ShopifyProductConnectionError("SHOPIFY_COMMAND_IN_PROGRESS", "Already running", 409, true));
    const busy = await post("execute", intent); expect(busy.status).toBe(409); expect(busy.headers.get("Retry-After")).toBe("2");
    mocks.submit.mockResolvedValueOnce({ command: { commandKey: "invalid" }, replayed: false });
    expect((await post("execute", intent))).toMatchObject({ status: 503, body: { code: "SHOPIFY_CONNECTION_OUTPUT_INVALID", retryable: true } });
  });
});
