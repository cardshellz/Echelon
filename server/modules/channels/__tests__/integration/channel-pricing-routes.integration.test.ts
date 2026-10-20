import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import { request as httpRequest, type Server } from "node:http";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import * as schema from "@shared/schema";
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../../routes/ebay/ebay-utils", () => ({ EBAY_CHANNEL_ID: 67 }));
// These unrelated route imports are not used by pricing. The actual shared
// pricing service is injected below; no pricing writer or persistence is mocked.
vi.mock("../../index", () => ({ channelsStorage: {} }));
vi.mock("../../../orders", () => ({ ordersStorage: {}, orderPageQuerySchema: {} }));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../inventory", () => ({ inventoryStorage: {} }));
vi.mock("../../../oms/oms.service", () => ({ createOmsService: () => ({}) }));
vi.mock("../../../inventory-planning/infrastructure/inventory-legacy-admin-control.repository",
  () => ({ createInventoryLegacyAdminControlService: () => ({}) }));
vi.mock("../../../../websocket", () => ({ broadcastOrdersUpdated: vi.fn() }));
// Only the authentication boundary is substituted. HTTP routes, validation,
// writer, repository, audit and capture trigger all execute production code.
vi.mock("../../../../routes/middleware", () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (req.headers["x-test-auth"] === "deny") { res.status(401).json({ error: "Unauthorized" }); return; }
    Object.defineProperty(req, "session", { value: { user: { id: req.headers["x-test-actor"] ?? "route-operator" } }, configurable: true });
    next();
  },
  requirePermission: () => (req: Request, res: Response, next: NextFunction) => {
    Object.defineProperty(req, "session", { value: { user: { id: req.headers["x-test-actor"] ?? "route-operator" } }, configurable: true });
    if (req.headers["x-test-permission"] === "deny") { res.status(403).json({ error: "Forbidden" }); return; }
    next();
  },
}));
import { registerChannelPricingRoutes } from "../../channels.routes";
import { registerEbayPricingRuleRoutes } from "../../../../routes/ebay/ebay-pricing.routes";
import { createChannelPricingService, type ChannelPricingService } from "../../channel-pricing.service";
import { createChannelPricingTestDatabase, pricingSnapshot } from "../fixtures/channel-pricing-owner.fixture";
import type { InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

const configured = Boolean(process.env.ECHELON_TEST_DATABASE_URL) && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const savedRule = z.object({ rule: z.object({ id: z.number(), rule_type: z.string(), value: z.string() }) });

(configured ? describe : describe.skip).sequential("Channel pricing HTTP to canonical PostgreSQL owner", () => {
  let database: InventoryCutoverTestDatabase;
  let service: ChannelPricingService;
  let server: Server;
  let port: number;
  const errors: string[] = [];
  beforeEach(async () => {
    errors.length = 0;
    vi.spyOn(console, "error").mockImplementation((value: unknown) => { errors.push(String(value)); });
    database = await createChannelPricingTestDatabase();
    service = createChannelPricingService(drizzle(database.pool, { schema }));
    const app = express();
    app.use(express.json());
    registerEbayPricingRuleRoutes(app, service, 67);
    registerChannelPricingRoutes(app, service);
    server = await new Promise<Server>(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback HTTP test listener");
    port = address.port;
  });
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await database?.close();
    vi.restoreAllMocks();
  });

  async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: {
        ...(serialized === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(serialized)) }), ...headers,
      } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
          catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.end(serialized);
    });
  }

  it.each([
    { scope: "channel", scopeId: null }, { scope: "category", scopeId: "sleeves" },
    { scope: "product", scopeId: "20" }, { scope: "variant", scopeId: "101" },
  ])("saves and updates $scope through the legacy API using production partial indexes", async target => {
    const command = { ...target, ruleType: "percentage", value: "10.00", expected: null };
    const inserted = await request("PUT", "/api/ebay/pricing-rules", target.scope === "channel"
      ? { scope: "channel", ruleType: "percentage", value: 10 }
      : command);
    expect(inserted.status).toBe(200);
    if (target.scope === "channel") expect(inserted.body).toMatchObject({ rule: { scope: "channel", scope_id: null, value: "10.00" } });
    const first = savedRule.parse(inserted.body).rule;
    const updated = await request("PUT", "/api/ebay/pricing-rules", { ...command, value: "12.50", expected: { id: first.id, ruleType: first.rule_type, value: first.value } });
    expect(updated).toMatchObject({ status: 200, body: { rule: { id: first.id, channel_id: 67, value: "12.50" } } });
    const listed = await request("GET", "/api/ebay/pricing-rules");
    expect(listed).toMatchObject({ status: 200, body: { rules: [expect.objectContaining({ id: first.id, value: "12.50" })] } });
    const beforeReplay = await pricingSnapshot(database.pool);
    expect((await request("PUT", "/api/ebay/pricing-rules", { ...command, value: "12.50" })).status).toBe(200);
    expect(await pricingSnapshot(database.pool)).toEqual(beforeReplay);
    const deleted = await request("DELETE", `/api/ebay/pricing-rules/${first.id}`, { expected: { id: first.id, ruleType: "percentage", value: "12.50" } });
    expect(deleted).toEqual({ status: 200, body: { success: true } });
    const state = await pricingSnapshot(database.pool);
    expect(state.rules).toEqual([]);
    expect(state.facts.map(row => row.operation)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect(state.audits.every(row => row.actor === "route-operator")).toBe(true);
  });

  it("preserves authentication, edit permission, strict identity and actionable stale/missing responses", async () => {
    const command = { scope: "product", scopeId: "20", ruleType: "fixed", value: "1.00", expected: null };
    expect((await request("PUT", "/api/ebay/pricing-rules", command, { "x-test-auth": "deny" })).status).toBe(401);
    expect((await request("PUT", "/api/ebay/pricing-rules", command, { "x-test-permission": "deny" })).status).toBe(403);
    expect(await pricingSnapshot(database.pool)).toEqual({ rules: [], prices: [], audits: [], facts: [] });
    expect(await request("PUT", "/api/ebay/pricing-rules", { ...command, channelId: 68 })).toMatchObject({ status: 400, body: { code: "CHANNEL_PRICING_INPUT_INVALID" } });
    expect(await request("PUT", "/api/ebay/pricing-rules", { ...command, scopeId: "999" })).toMatchObject({ status: 404, body: { code: "CHANNEL_PRICING_TARGET_MISSING" } });
    expect(await request("PUT", "/api/ebay/pricing-rules", { scope: "product", ruleType: "fixed", value: 1 }))
      .toMatchObject({ status: 400, body: { code: "CHANNEL_PRICING_INPUT_INVALID" } });
    const inserted = await request("PUT", "/api/ebay/pricing-rules", command);
    expect(inserted.status).toBe(200);
    const before = await pricingSnapshot(database.pool);
    expect(await request("PUT", "/api/ebay/pricing-rules", { ...command, value: "2.00" })).toMatchObject({ status: 409, body: { code: "CHANNEL_PRICING_CONFLICT" } });
    expect(await pricingSnapshot(database.pool)).toEqual(before);
    const other = await service.saveRule(68, command, "other-operator", new Date("2026-10-20T12:00:00Z"));
    expect(await request("DELETE", `/api/ebay/pricing-rules/${other.id}`)).toEqual({ status: 200, body: { success: true } });
    expect((await service.listRules(68))[0].id).toBe(other.id);
  });

  it("saves, preserves and deletes explicit prices through the generic route without crossing channels", async () => {
    const path = "/api/channels/67/variants/101/pricing";
    const other = await service.savePrice(68, 101, { price: 700, cost: 40, currency: "EUR" }, "other-operator", new Date("2026-10-20T12:00:00Z"));
    expect(await request("PUT", path, { price: 1234, compareAtPrice: 1500, cost: 345, currency: "CAD" }))
      .toMatchObject({ status: 200, body: { channelId: 67, productVariantId: 101, price: 1234, compareAtPrice: 1500, cost: 345, currency: "CAD" } });
    expect(await request("PUT", path, { price: 1300 }))
      .toMatchObject({ status: 200, body: { channelId: 67, productVariantId: 101, price: 1300, compareAtPrice: 1500, cost: 345, currency: "CAD" } });
    const before = await pricingSnapshot(database.pool);
    expect((await request("PUT", path, { price: 1300 })).status).toBe(200);
    expect(await pricingSnapshot(database.pool)).toEqual(before);
    expect(await request("DELETE", path)).toEqual({ status: 200, body: { deleted: true } });
    const after = await pricingSnapshot(database.pool);
    expect(after.prices).toEqual([expect.objectContaining({ id: other.price.id, channel_id: 68, price: "700", cost: "40", currency: "EUR" })]);
    expect(after.facts.filter(row => row.before_scope?.channel_id === 67 || row.after_scope?.channel_id === 67).map(row => row.operation)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect(after.audits.filter(row => row.actor === "route-operator").map(row => row.action))
      .toEqual(["channel_pricing.price_saved", "channel_pricing.price_saved", "channel_pricing.price_deleted"]);
  });

  it("rejects body identity overrides before the generic URL-scoped writer can change another selection", async () => {
    await service.savePrice(68, 102, { price: 987 }, "other-operator", new Date("2026-10-20T12:00:00Z"));
    const before = await pricingSnapshot(database.pool);
    for (const body of [{ price: 100, channelId: 68 }, { price: 100, productVariantId: 102 }, { price: 100, variantId: 102 }, { price: 100, channelId: 68, productVariantId: 102 }]) {
      expect(await request("PUT", "/api/channels/67/variants/101/pricing", body))
        .toMatchObject({ status: 400, body: { code: "CHANNEL_PRICING_INPUT_INVALID" } });
      expect(await pricingSnapshot(database.pool)).toEqual(before);
    }
    expect(await request("DELETE", "/api/channels/67/variants/101/pricing", { channelId: 68, productVariantId: 102 }))
      .toMatchObject({ status: 400, body: { code: "CHANNEL_PRICING_INPUT_INVALID" } });
    expect(await pricingSnapshot(database.pool)).toEqual(before);
  });

  it("returns a safe unexpected-database error and rolls back the actual write and source fact", async () => {
    await database.pool.query("ALTER TABLE public.audit_events ADD CONSTRAINT private_audit_constraint CHECK(actor <> 'private-actor-value')");
    const before = await pricingSnapshot(database.pool);
    const response = await request("PUT", "/api/ebay/pricing-rules",
      { scope: "channel", scopeId: null, ruleType: "fixed", value: "9876.54" }, { "x-test-actor": "private-actor-value" });
    expect(response).toEqual({ status: 500, body: { code: "CHANNEL_PRICING_UNAVAILABLE", error: "Pricing could not be saved or loaded. Please try again." } });
    expect(await pricingSnapshot(database.pool)).toEqual(before);
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0])).toMatchObject({ operation: "ebay_pricing_rule_save", code: "CHANNEL_PRICING_UNAVAILABLE", sqlState: "23514" });
    expect(errors.join(" ")).not.toMatch(/private-actor-value|private_audit_constraint|9876|INSERT|audit_events/);
  });
});
