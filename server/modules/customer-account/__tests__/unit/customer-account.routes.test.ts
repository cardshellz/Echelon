import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { CUSTOMER_ACCOUNT_PROXY_API, CUSTOMER_ACCOUNT_COMMAND_HEADER } from "@shared/customer-account/customer-account.contract";
import { CustomerReturnCustomerAuthService } from "../../../returns/application/customer-return-customer-auth.service";
import type { CustomerReturnCustomerSession } from "../../../returns/application/customer-return-customer-auth.service";
import { registerCustomerAccountRoutes, type CustomerAccountRouteDependencies } from "../../interfaces/customer-account.routes";
import { previewCalculation, previewInput, PREVIEW_NOW } from "../../../order-edits/__tests__/fixtures/order-edit-preview.fixture";

const now = new Date("2026-10-12T12:00:00Z");
const config = { storageSecret: "fixture-storage-only-secret-32-characters", publicOrigin: "https://backend.test",
  shops: { "fixture.myshopify.com": { proxyUrl: "https://shop.test/apps/echelon-returns", shopifySecret: "fixture-proxy-secret" } } };
const staging = { themeId: "174740308127", shops: { "fixture.myshopify.com": { enabled: true } } };
function proof(override: Record<string, string> = {}) {
  const values = { shop: "fixture.myshopify.com", logged_in_customer_id: "100", timestamp: String(Math.floor(now.getTime() / 1000)), path_prefix: "/apps/echelon-returns", ...override };
  const signed = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("");
  const query = new URLSearchParams(values);
  query.set("signature", createHmac("sha256", config.shops["fixture.myshopify.com"].shopifySecret).update(signed).digest("hex"));
  return query.toString();
}
describe("customer account signed storefront HTTP boundary", () => {
  let server: Server; let base: string;
  const connection = vi.fn(async () => ({ connectionId: 4, channelId: 2, shopDomain: "fixture.myshopify.com", name: "Shopify", enabled: true, paymentWindowMinutes: 30 }));
  const services = vi.fn((_principal: CustomerReturnCustomerSession) => ({ edits: { connection }, returns: vi.fn() }));
  const report = vi.fn();
  let enabled = true;
  beforeEach(async () => {
    vi.clearAllMocks(); enabled = true;
    services.mockImplementation(() => ({ edits: { connection }, returns: vi.fn() }));
    const auth = new CustomerReturnCustomerAuthService({ config, challenges: { create: vi.fn(), consume: vi.fn() },
      shops: async () => [{ channelId: 2, connectionId: 4, shopDomain: "fixture.myshopify.com", displayName: "Shopify" }], now: () => now, randomState: () => "a".repeat(43) });
    const app = express(); app.use(express.json());
    registerCustomerAccountRoutes(app, { services, context: async () => ({ config, auth }), staging: () => enabled ? staging : null, report } as unknown as CustomerAccountRouteDependencies);
    server = await new Promise<Server>(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${CUSTOMER_ACCOUNT_PROXY_API}`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  async function request(body: Record<string, unknown> = {}, signed = proof(), headers: Record<string, string> = {}) {
    return fetch(`${base}?${signed}`, { method: "POST", headers: { Origin: "https://shop.test", "Content-Type": "application/json", [CUSTOMER_ACCOUNT_COMMAND_HEADER]: "1", ...headers },
      body: JSON.stringify({ themeId: staging.themeId, expectedCustomerId: "100", method: "GET", path: "/account/bootstrap", query: {}, ...body }) });
  }
  it("verifies Shopify per request without accepting staff cookies or a theme ID as identity", async () => {
    const response = await request(); expect(response.status).toBe(200);
    expect((await response.json()).session).toMatchObject({ authenticated: true, privateTesting: true });
    expect(response.headers.get("cache-control")).toContain("no-store");
    const anonymous = await request({}, proof({ logged_in_customer_id: "" }), { Cookie: "staff-session=fake" });
    expect(anonymous.status).toBe(401);
    expect(services).toHaveBeenCalledTimes(1);
  });
  it("records a database failure code without exposing SQL or connection details", async () => {
    connection.mockRejectedValueOnce(Object.assign(new Error("private database query and credentials"), { code: "55P03" }));
    const response = await request();
    expect(response.status).toBe(503);
    expect(report).toHaveBeenLastCalledWith({ code: "CUSTOMER_ACCOUNT_REQUEST_FAILED", path: "/account/bootstrap", causeCode: "55P03" });
    expect(JSON.stringify(await response.json())).not.toContain("private database");
  });
  it.each([
    { signed: () => `${proof()}&signature=duplicate` },
    { signed: () => proof({ timestamp: String(Math.floor(now.getTime() / 1000) - 301) }) },
    { signed: () => proof({ path_prefix: "/apps/member-portal" }) },
    { signed: () => proof({ extra: "unrecognized" }) },
    { signed: () => proof().replace(/signature=[a-f0-9]+/, "signature=" + "0".repeat(64)) },
  ])("rejects malformed, stale or wrong-proxy proof", async ({ signed }) => {
    expect((await request({}, signed())).status).toBe(401); expect(services).not.toHaveBeenCalled();
  });
  it("keeps the staging surface off by default and checks origin and account switch", async () => {
    enabled = false; expect((await request()).status).toBe(403); enabled = true;
    expect((await request({}, proof({ logged_in_customer_id: "101" }))).status).toBe(401);
    expect((await request({ expectedCustomerId: "101" })).status).toBe(401);
    expect((await request({}, proof(), { Origin: "https://other.test" })).status).toBe(403);
    expect(services).not.toHaveBeenCalled();
  });
  it("admits any signed customer for the enabled shop without a tester allowlist", async () => {
    const response = await request({ expectedCustomerId: "101" }, proof({ logged_in_customer_id: "101" }));
    expect(response.status).toBe(200);
    expect(services.mock.calls[0]?.[0]).toMatchObject({ externalCustomerId: "101", channelId: 2 });
  });
  it("admits the signed shop's HTTPS preview host while preserving account and signature checks", async () => {
    const response = await request({}, proof(), { Origin: "https://fixture.myshopify.com" });
    expect(response.status).toBe(200);
    expect((await response.json()).session.authenticated).toBe(true);
    expect((await request({ expectedCustomerId: "101" }, proof(), { Origin: "https://fixture.myshopify.com" })).status).toBe(401);
    expect((await request({}, proof({ logged_in_customer_id: "" }), { Origin: "https://fixture.myshopify.com" })).status).toBe(401);
  });
  it("logs bounded origin/header classifications and rejects another store or a missing command header", async () => {
    expect((await request({}, proof(), { Origin: "https://other.myshopify.com" })).status).toBe(403);
    expect(report).toHaveBeenLastCalledWith({ code: "CUSTOMER_ACCOUNT_ORIGIN_REJECTED", path: "/account/bootstrap", context: { origin: "rejected", commandHeader: "valid" } });
    expect((await request({}, proof(), { Origin: "https://fixture.myshopify.com", [CUSTOMER_ACCOUNT_COMMAND_HEADER]: "" })).status).toBe(403);
    expect(report).toHaveBeenLastCalledWith({ code: "CUSTOMER_ACCOUNT_ORIGIN_REJECTED", path: "/account/bootstrap", context: { origin: "shopify_storefront", commandHeader: "rejected" } });
  });
  it("requires the same customer partition on every resource call", async () => {
    expect((await request({ path: "/account/resolve", method: "POST", body: { orderReference: "#10", externalOrderId: "99" } })).status).toBe(401);
    expect(services).not.toHaveBeenCalled();
  });
  it("does not expose staff settings or global order search through the adapter", async () => {
    const bootstrap = await (await request()).json();
    expect((await request({ path: "/order-edits/settings/4", method: "POST", body: {}, sessionKey: bootstrap.session.sessionKey })).status).toBe(404);
    expect((await request({ path: "/order-edits/orders", sessionKey: bootstrap.session.sessionKey })).status).toBe(404);
  });
  it.each([undefined, "v1", "v2"])("negotiates pricing display through the signed customer bridge, opt-in=%s", async (optIn) => {
    const bootstrap = await (await request()).json();
    const calculation = previewCalculation();
    const financials = { ...calculation.financials, taxLines: [{ title: "State tax", ratePercentage: 6, amountCents: calculation.financials.taxCents }], orderDiscounts: [], lines: calculation.financials.lines.map(line => ({ ...line, productNetCents: line.netCents })) };
    const preview = vi.fn(async (input) => ({ phase: "preview", input, calculatedAt: new Date(PREVIEW_NOW).toISOString(), expiresAt: new Date(PREVIEW_NOW + 60000).toISOString(), ...calculation, financials }));
    services.mockImplementation(() => ({ edits: { connection, preview }, returns: vi.fn() }));
    const response = await request({ path: "/order-edits/previews", method: "POST", sessionKey: bootstrap.session.sessionKey, query: optIn ? { pricingDisplayVersion: optIn } : {}, body: previewInput() });
    expect(response.status).toBe(200);
    const result = (await response.json()).financials;
    expect(result.totalCents).toBe(financials.totalCents);
    expect(result.orderDiscounts).toEqual(optIn ? [] : undefined);
    expect(result.taxLines).toEqual(optIn === "v2" ? financials.taxLines : undefined);
    expect(result.lines[0].productNetCents).toBe(optIn ? financials.lines[0].netCents : undefined);
    expect(preview).toHaveBeenCalledWith(previewInput());
    const unsupported = await request({ path: "/order-edits/previews", method: "POST", sessionKey: bootstrap.session.sessionKey, query: { pricingDisplayVersion: "unrecognized" }, body: previewInput() });
    expect(unsupported.status).toBe(400);
    expect(preview).toHaveBeenCalledTimes(1);
  });
});
