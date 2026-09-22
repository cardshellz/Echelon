import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCustomerReturnPreviewRoutes, type CustomerReturnPreviewRouteDependencies } from "../../interfaces/http/customer-return-preview.routes";
import { CustomerReturnPreviewService } from "../../application/customer-return-preview.service";

const API = "/api/returns/admin/portal-preview";
const PAGE = "/returns/portal-preview";
const admin = () => ({ id: "admin-1", active: 1, role: "admin", roles: [{ name: "Administrator", isSystem: 1 }] });
const identityStorage = vi.hoisted(() => ({ getUser: vi.fn(), getUserRoles: vi.fn() }));
vi.mock("../../../identity", () => ({ identityStorage }));
type IdentityReader = NonNullable<CustomerReturnPreviewRouteDependencies["identityReader"]>;
type FailureReporter = NonNullable<CustomerReturnPreviewRouteDependencies["reportFailure"]>;

describe("private customer return preview HTTP boundaries", () => {
  let server: http.Server;
  let baseUrl: string;
  let session: unknown;
  let identity: unknown;
  let identityError: Error | null;
  let readIdentity: ReturnType<typeof vi.fn<IdentityReader>>;
  let reportFailure: ReturnType<typeof vi.fn<FailureReporter>>;
  let fallback: ReturnType<typeof vi.fn<() => void>>;
  let service: {
    getState: ReturnType<typeof vi.fn<CustomerReturnPreviewService["getState"]>>;
    lookup: ReturnType<typeof vi.fn<CustomerReturnPreviewService["lookup"]>>;
    review: ReturnType<typeof vi.fn<CustomerReturnPreviewService["review"]>>;
  };
  const actual = new CustomerReturnPreviewService();
  const scenario = actual.getState().scenarios[0];
  const lookup = { scenarioId: scenario.id, orderReference: scenario.orderReference };

  async function start(useDefaultReader = false) {
    const app = express();
    // Match production's parser-before-session ordering without connecting a session DB.
    app.use(express.json({ limit: "100kb" }));
    app.use((req, _res, next) => { req.session = session as typeof req.session; next(); });
    registerCustomerReturnPreviewRoutes(app, { service, reportFailure,
      ...(useDefaultReader ? {} : { identityReader: readIdentity }) });
    app.use((_req, res) => { fallback(); res.type("html").send("<html>application shell</html>"); });
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  async function request(path = API, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(baseUrl + path, { method, redirect: "manual", headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text,
      body: response.headers.get("content-type")?.includes("application/json") && text ? JSON.parse(text) : undefined };
  }
  function expectPrivate(response: { headers: Headers }) {
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("vary")).toContain("Cookie");
  }
  function expectNoService() {
    expect(service.getState).not.toHaveBeenCalled();
    expect(service.lookup).not.toHaveBeenCalled();
    expect(service.review).not.toHaveBeenCalled();
  }

  beforeEach(async () => {
    session = { user: { id: "admin-1", role: "admin", active: 1 } };
    identity = admin(); identityError = null;
    readIdentity = vi.fn<IdentityReader>(async () => { if (identityError) throw identityError; return identity; });
    reportFailure = vi.fn<FailureReporter>(); fallback = vi.fn<() => void>();
    service = { getState: vi.fn(() => actual.getState()), lookup: vi.fn(raw => actual.lookup(raw)), review: vi.fn(raw => actual.review(raw)) };
    identityStorage.getUser.mockReset(); identityStorage.getUserRoles.mockReset();
    await start();
  });
  afterEach(close);

  it.each(["anonymous", "customer", "dropship", "vendor", "internal_key", "missing_id", "numeric_id"])(
    "rejects %s authentication on both API and direct page before reading identity", async kind => {
      session = kind === "customer" ? { customer: { id: "admin-1" } }
        : kind === "dropship" ? { dropshipUser: { id: "admin-1" } }
        : kind === "vendor" ? { vendor: { id: "admin-1" } }
        : kind === "missing_id" ? { user: { role: "admin", active: 1 } }
        : kind === "numeric_id" ? { user: { id: 123, role: "admin" } } : {};
      const headers: Record<string, string> = kind === "internal_key" ? { Authorization: "Bearer synthetic-internal-key" } : {};
      for (const path of [API, `${API}/order`, `${API}/review`, PAGE, `${PAGE}/nested`]) {
        const response = await request(path, "GET", undefined, headers);
        expect(response.status).toBe(401); expectPrivate(response);
        expect(response.text).not.toContain("application shell");
      }
      expect(readIdentity).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled(); expectNoService();
    });

  it.each(["staff", "inactive", "legacy_demoted", "rbac_demoted", "custom_administrator", "wrong_role_name", "missing_account", "wrong_identity"])(
    "rejects current %s evidence despite cached admin session values", async kind => {
      identity = kind === "staff" ? { ...admin(), role: "lead", roles: [{ name: "Team Lead", isSystem: 1 }] }
        : kind === "inactive" ? { ...admin(), active: 0 }
        : kind === "legacy_demoted" ? { ...admin(), role: "picker" }
        : kind === "rbac_demoted" ? { ...admin(), roles: [] }
        : kind === "custom_administrator" ? { ...admin(), roles: [{ name: "Administrator", isSystem: 0 }] }
        : kind === "wrong_role_name" ? { ...admin(), roles: [{ name: "administrator", isSystem: 1 }] }
        : kind === "wrong_identity" ? { ...admin(), id: "another-user" } : null;
      for (const path of [API, PAGE]) {
        const response = await request(path); expect(response.status).toBe(403); expectPrivate(response);
      }
      expect(readIdentity).toHaveBeenCalledTimes(2);
      expect(readIdentity).toHaveBeenCalledWith("admin-1"); expectNoService(); expect(fallback).not.toHaveBeenCalled();
    });

  it.each(["read_failure", "malformed_active", "malformed_membership", "extra_private_data", "undefined"])(
    "sanitizes %s into a private503 without service access or raw logs", async kind => {
      if (kind === "read_failure") identityError = new Error("secret-database-connection customer@example.test");
      else if (kind === "malformed_active") identity = { ...admin(), active: "1" };
      else if (kind === "malformed_membership") identity = { ...admin(), roles: [{ name: "Administrator", isSystem: true }] };
      else if (kind === "extra_private_data") identity = { ...admin(), password: "secret-password" };
      else identity = undefined;
      for (const path of [API, PAGE]) {
        const response = await request(path); expect(response.status).toBe(503); expectPrivate(response);
        expect(response.text).not.toMatch(/secret|customer@/);
      }
      expect(reportFailure.mock.calls).toEqual([[{ operation: "state", code: "RETURN_PREVIEW_UNAVAILABLE" }],
        [{ operation: "page", code: "RETURN_PREVIEW_UNAVAILABLE" }]]);
      expectNoService(); expect(fallback).not.toHaveBeenCalled();
    });

  it("permits an active current admin and uses only session identity, then rereads on every request", async () => {
    session = { user: { id: "admin-1", role: "picker", active: 0 } };
    const state = await request(); expect(state.status).toBe(200); expectPrivate(state);
    expect(state.body).toEqual(actual.getState());
    const page = await request(PAGE); expect(page.status).toBe(200); expectPrivate(page);
    expect(page.text).toBe("<html>application shell</html>");
    identity = { ...admin(), active: 0 };
    expect((await request()).status).toBe(403);
    identity = { ...admin(), roles: [] };
    expect((await request(PAGE)).status).toBe(403);
    expect(readIdentity).toHaveBeenCalledTimes(4); expect(service.getState).toHaveBeenCalledTimes(1); expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("defaults to fresh existing Identity readers and projects only authorization fields", async () => {
    await close();
    identityStorage.getUser.mockResolvedValue({ ...admin(), password: "must-not-leave-identity", username: "private-name" });
    identityStorage.getUserRoles.mockResolvedValue([{ id: 1, name: "Administrator", isSystem: 1, description: "Full access" }]);
    await start(true);
    expect((await request()).status).toBe(200);
    expect(identityStorage.getUser).toHaveBeenCalledWith("admin-1");
    expect(identityStorage.getUserRoles).toHaveBeenCalledWith("admin-1");
    identityStorage.getUser.mockResolvedValue(undefined);
    expect((await request(PAGE)).status).toBe(403);
    expect(identityStorage.getUserRoles).toHaveBeenCalledTimes(1);
  });

  it("authorizes HEAD on state and page and never falls back for unauthorized HEAD", async () => {
    for (const path of [API, PAGE]) {
      const response = await request(path, "HEAD"); expect(response.status).toBe(200); expectPrivate(response); expect(response.text).toBe("");
    }
    session = {};
    for (const path of [API, PAGE]) {
      const response = await request(path, "HEAD"); expect(response.status).toBe(401); expectPrivate(response); expect(response.text).toBe("");
    }
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("validates sample lookup and review outputs through the real effect-free service", async () => {
    const order = await request(`${API}/order`, "POST", lookup);
    expect(order.status).toBe(200); expectPrivate(order);
    const line = order.body.lines.find((candidate: { eligibleQuantity: number }) => candidate.eligibleQuantity > 0);
    const review = await request(`${API}/review`, "POST", { ...lookup,
      selections: [{ lineId: line.id, quantity: 1, reasonCode: null }],
      parcels: [{ items: [{ lineId: line.id, quantity: 1 }] }] });
    expect(review.status).toBe(200); expectPrivate(review);
    expect(review.body).toMatchObject({ effects: "none", mode: "admin_preview", selectedQuantity: 1 });
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([{}, { ...lookup, actor: "admin-1" }, { ...lookup, live: true }, { ...lookup, channelId: 36 },
    { ...lookup, scenarioId: "production" }])("rejects invalid lookup or authority overrides before service access %#", async body => {
    const response = await request(`${API}/order`, "POST", body);
    expect(response.status).toBe(400); expectPrivate(response); expectNoService();
  });

  it("rejects invalid review input and query overrides before service access", async () => {
    expect((await request(`${API}/review`, "POST", { ...lookup, selections: [], parcels: [] })).status).toBe(400);
    for (const path of [API, `${API}/order`, `${API}/review`]) {
      const response = await request(path + "?actor=admin-1", path === API ? "GET" : "POST", path === API ? undefined : lookup);
      expect(response.status).toBe(400); expectPrivate(response);
    }
    expectNoService();
  });

  it("preserves classified sample errors while sanitizing unexpected or malformed service responses", async () => {
    const missing = await request(`${API}/order`, "POST", { ...lookup, orderReference: "9999999" });
    expect(missing.status).toBe(404); expect(missing.body.error.code).toBe("RETURN_PREVIEW_ORDER_NOT_FOUND");
    service.getState.mockImplementationOnce(() => { throw new Error("secret-provider-token"); });
    const failed = await request(); expect(failed.status).toBe(503); expect(failed.text).not.toContain("secret-provider-token"); expectPrivate(failed);
    service.getState.mockReturnValueOnce({ customerAccess: "enabled" } as never);
    const malformed = await request(); expect(malformed.status).toBe(503); expectPrivate(malformed);
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain("secret-provider-token");
  });

  it.each(["customer_access", "live_order", "real_effects"])("rejects service output violating the %s boundary", async kind => {
    let path = API; let body: unknown;
    if (kind === "customer_access") service.getState.mockReturnValueOnce({ ...actual.getState(), customerAccess: "enabled" } as never);
    else if (kind === "live_order") {
      path = `${API}/order`; body = lookup;
      service.lookup.mockReturnValueOnce({ ...actual.lookup(lookup), mode: "live" } as never);
    } else {
      path = `${API}/review`;
      const line = actual.lookup(lookup).lines.find(candidate => candidate.eligibleQuantity > 0)!;
      body = { ...lookup, selections: [{ lineId: line.id, quantity: 1, reasonCode: null }], parcels: [{ items: [{ lineId: line.id, quantity: 1 }] }] };
      service.review.mockReturnValueOnce({ ...actual.review(body), effects: "label_purchased" } as never);
    }
    const response = await request(path, body ? "POST" : "GET", body);
    expect(response.status).toBe(503); expectPrivate(response);
    expect(response.text).not.toMatch(/label_purchased|enabled|"live"/);
  });

  it.each(["POST", "PUT", "DELETE", "OPTIONS"])("denies page %s before SPA fallback", async method => {
    const response = await request(PAGE, method);
    expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("GET, HEAD"); expectPrivate(response);
    expectNoService(); expect(fallback).not.toHaveBeenCalled();
  });

  it.each([[API, "POST", "GET, HEAD"], [API, "OPTIONS", "GET, HEAD"], [`${API}/order`, "GET", "POST"],
    [`${API}/order`, "HEAD", "POST"], [`${API}/review`, "DELETE", "POST"]])("terminates unsupported %s %s with405", async (path, method, allow) => {
    const response = await request(path, method);
    expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe(allow); expectPrivate(response);
    expectNoService(); expect(fallback).not.toHaveBeenCalled();
  });

  it.each(["launch", "submit", "labels", "refunds", "unknown/nested"])("exposes no %s endpoint or SPA fallback", async endpoint => {
    const response = await request(`${API}/${endpoint}`, "POST", { enable: true });
    expect(response.status).toBe(404); expectPrivate(response); expectNoService(); expect(fallback).not.toHaveBeenCalled();
  });

  it.each(["malformed", "oversized"])("sanitizes the global parser's %s error with private headers", async kind => {
    for (const path of [API + "/order", PAGE]) {
      const response = await fetch(baseUrl + path, { method: "POST", headers: { "Content-Type": "application/json" },
        body: kind === "malformed" ? '{"secret-private-value":' : JSON.stringify({ value: "x".repeat(110_000) }) });
      expect(response.status).toBe(kind === "malformed" ? 400 : 413); expectPrivate(response);
      expect(await response.text()).not.toContain("secret-private-value"); expectNoService(); expect(fallback).not.toHaveBeenCalled();
    }
  });
});
