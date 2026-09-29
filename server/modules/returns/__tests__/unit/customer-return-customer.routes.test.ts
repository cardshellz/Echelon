import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCustomerReturnCustomerRoutes, type CustomerReturnCustomerRouteDependencies } from "../../interfaces/http/customer-return-customer.routes";
import { CustomerReturnCustomerAccessError } from "../../application/customer-return-customer-auth.service";
import { CustomerReturnCustomerProfileError } from "../../application/customer-return-customer-profile.service";

const principal = { channelId: 36, externalCustomerId: "123", shopDomain: "test.myshopify.com", sessionKey: "a".repeat(43), authenticatedAt: 1, expiresAt: 2 };
describe("customer returns HTTP boundaries", () => {
  let server: http.Server;
  const admin = vi.fn(async () => {});
  const authenticate = vi.fn(async () => principal);
  const sessionPrincipal = vi.fn(async () => principal);
  const order = vi.fn(async () => ({ test: "owned-order" }));
  const review = vi.fn(async () => ({}));
  const submit = vi.fn(async () => ({}));
  const artifact = vi.fn(async () => ({ downloadUrl: "https://approved-provider/label.pdf" }));
  const download = vi.fn(async () => new TextEncoder().encode("%PDF-test"));
  const readProfile = vi.fn(async () => ({ name: "Jane Doe", email: "jane@example.com" }));
  const profile = vi.fn(async () => ({ read: readProfile }));
  const services = vi.fn(async () => ({ orders: { order, review, list: vi.fn(async () => ({ orders: [] })) },
    operations: { submit, artifact, listReturns: vi.fn(async () => ({ returns: [] })), labelStatus: vi.fn(),
      progressLabels: vi.fn(), submissionStatus: vi.fn(), resumeSubmission: vi.fn() }, download }));
  async function start() {
    vi.clearAllMocks();
    admin.mockResolvedValue(); sessionPrincipal.mockResolvedValue(principal);
    readProfile.mockResolvedValue({ name: "Jane Doe", email: "jane@example.com" });
    const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: false }));
    const session = { customerReturnSession: principal, returnLoginBrowserKey: "browser", user: { id: "admin" }, cookie: {},
      save: (done: (error?: Error) => void) => done(), regenerate: (done: (error?: Error) => void) => done() };
    app.use((req, _res, next) => { req.session = session as unknown as typeof req.session; next(); });
    registerCustomerReturnCustomerRoutes(app, { privateTesting: () => true, authorizeStaff: admin,
      context: async () => ({ config: { publicOrigin: "https://returns.example.com" }, auth: {
        principal: sessionPrincipal, authenticate, start: vi.fn(async () => "https://store.example.com/apps/echelon-returns?state=test"),
      } }) as unknown as Awaited<ReturnType<NonNullable<CustomerReturnCustomerRouteDependencies["context"]>>>,
      services: services as unknown as NonNullable<CustomerReturnCustomerRouteDependencies["services"]>,
      profile: profile as unknown as NonNullable<CustomerReturnCustomerRouteDependencies["profile"]>,
    });
    app.use((_req, res) => res.send("application shell"));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (path: string, options: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...options,
      headers: { "X-Return-Session": principal.sessionKey, ...options.headers } });
  }
  afterEach(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  it("reads the verified account profile independently of orders/labels and prevents caching", async () => {
    const request = await start();
    const result = await request("/api/returns/customer/profile");
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ name: "Jane Doe", email: "jane@example.com" });
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(readProfile).toHaveBeenCalledWith(principal);
    expect(services).not.toHaveBeenCalled();
  });
  it.each(["private", "unauthenticated", "stale", "missing-header", "query-identity"])(
    "rejects %s profile requests before reading customer data", async reason => {
      const request = await start();
      if (reason === "private") admin.mockRejectedValue(new CustomerReturnCustomerAccessError("PRIVATE", "Private testing", 403));
      if (reason === "unauthenticated") sessionPrincipal.mockRejectedValue(new CustomerReturnCustomerAccessError("LOGIN", "Sign in", 401));
      const headers: Record<string, string> = reason === "stale" ? { "X-Return-Session": "b".repeat(43) } : reason === "missing-header" ? { "X-Return-Session": "" } : {};
      const result = await request(`/api/returns/customer/profile${reason === "query-identity" ? "?customerId=999" : ""}`, { headers });
      expect(result.status).toBe(reason === "private" ? 403 : reason === "query-identity" ? 400 : 401);
      expect(profile).not.toHaveBeenCalled(); expect(readProfile).not.toHaveBeenCalled(); expect(services).not.toHaveBeenCalled();
    });
  it("keeps a profile failure separate from session/orders", async () => {
    const request = await start(); readProfile.mockRejectedValue(new CustomerReturnCustomerProfileError());
    const result = await request("/api/returns/customer/profile");
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: { code: "RETURN_CUSTOMER_PROFILE_UNAVAILABLE",
      message: "Your account details are temporarily unavailable. Please try again." } });
    expect((await request("/api/returns/customer/orders/1")).status).toBe(200);
    expect((await request("/api/returns/customer/session")).status).toBe(200);
  });
  it("keeps page and API staff-gated during private testing", async () => {
    const request = await start(); admin.mockRejectedValue(new CustomerReturnCustomerAccessError("PRIVATE", "Private testing", 403));
    expect((await request("/customer-returns")).status).toBe(403);
    const result = await request("/api/returns/customer/orders/1");
    expect(result.status).toBe(403); expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(sessionPrincipal).not.toHaveBeenCalled(); expect(services).not.toHaveBeenCalled();
  });
  it("requires customer identity independently of administrator access", async () => {
    const request = await start(); sessionPrincipal.mockRejectedValue(new CustomerReturnCustomerAccessError("LOGIN", "Sign in", 401));
    expect((await request("/api/returns/customer/orders/1")).status).toBe(401);
    expect(services).not.toHaveBeenCalled();
  });
  it("derives identity from the server session and rejects channel/customer query injection", async () => {
    const request = await start();
    expect((await request("/api/returns/customer/orders/7")).status).toBe(200);
    expect(services).toHaveBeenCalledWith(principal); expect(order).toHaveBeenCalledWith(7);
    order.mockClear();
    expect((await request("/api/returns/customer/orders/7?channelId=37&customerId=999")).status).toBe(400);
    expect(order).not.toHaveBeenCalled();
  });
  it("requires JSON, exact Origin, and the custom command header before side effects", async () => {
    const request = await start();
    const headers = { "Content-Type": "application/json", "Origin": "https://returns.example.com", "X-Return-Command": "1" };
    for (const overrides of [{ Origin: "https://other.example.com" }, { "X-Return-Command": "0" }, { "Content-Type": "text/plain" }]) {
      expect((await request("/api/returns/customer/orders/7/returns", { method: "POST", headers: { ...headers, ...overrides }, body: "{}" })).status).toBe(403);
    }
    expect(submit).not.toHaveBeenCalled();
    expect((await request("/api/returns/customer/orders/7/returns", { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect(submit).toHaveBeenCalledWith(7, {});
  });
  it("rejects a stale tab's session partition before any read, submission or logout", async () => {
    const request = await start();
    const headers = { "X-Return-Session": "b".repeat(43), "Content-Type": "application/json", Origin: "https://returns.example.com", "X-Return-Command": "1" };
    expect((await request("/api/returns/customer/orders/7", { headers })).status).toBe(401);
    expect((await request("/api/returns/customer/orders/7/returns", { method: "POST", headers, body: "{}" })).status).toBe(401);
    expect((await request("/api/returns/customer/logout", { method: "POST", headers, body: "{}" })).status).toBe(401);
    expect(services).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });
  it("callback form only relays; it cannot authenticate without the same-origin browser session", async () => {
    const request = await start(); admin.mockRejectedValue(new CustomerReturnCustomerAccessError("PRIVATE", "Private testing", 403));
    const response = await request("/customer-returns/callback", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "proof=c2lnbmVk" });
    expect(response.status).toBe(200); expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain("/api/returns/customer/session");
    expect(authenticate).not.toHaveBeenCalled(); expect(services).not.toHaveBeenCalled();
    expect((await request("/api/returns/customer/session", { method: "POST", headers: { "Content-Type": "application/json", "Origin": "https://returns.example.com", "X-Return-Command": "1" }, body: JSON.stringify({ proof: "c2lnbmVk" }) })).status).toBe(403);
  });
  it("rejects malformed callback content without reflecting it", async () => {
    const request = await start();
    const response = await request("/customer-returns/callback", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "proof=%3Cscript%3Ealert(1)%3C%2Fscript%3E" });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain("alert(1)");
  });
  it("GET cannot create returns, progress labels, or start a session", async () => {
    const request = await start();
    expect((await request("/api/returns/customer/returns/1/progress")).status).toBe(404);
    expect((await request("/api/returns/customer/orders/1/returns")).status).toBe(404);
    expect(submit).not.toHaveBeenCalled(); expect(authenticate).not.toHaveBeenCalled();
  });
  it("downloads only after the ownership-bound artifact service authorizes", async () => {
    const request = await start();
    const response = await request("/api/returns/customer/returns/12/parcels/3/download");
    expect(artifact).toHaveBeenCalledWith(12, 3); expect(download).toHaveBeenCalledWith("https://approved-provider/label.pdf");
    expect(response.headers.get("content-type")).toContain("application/pdf"); expect(await response.text()).toBe("%PDF-test");
  });
});
