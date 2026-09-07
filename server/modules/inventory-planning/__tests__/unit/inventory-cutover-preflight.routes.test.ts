import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryCutoverPreflight } from "@shared/types/inventory-cutover-preflight";
import { registerInventoryCutoverPreflightRoutes } from "../../interfaces/http/inventory-cutover-preflight.routes";
import { InventoryCutoverPreflightError, InventoryCutoverPreflightService } from "../../application/inventory-cutover-preflight.service";
import type { InventoryCutoverPreflightFacts } from "../../domain/inventory-cutover-preflight";
import { WmsCutoverDemandCaptureError } from "../../../wms/inventory-cutover-demand-reader";
import { InventoryCutoverEncumbranceCaptureError } from "../../../inventory/infrastructure/inventory-cutover-encumbrance.repository";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
// Keep the real requirePermission middleware; isolate only its identity-owner call.
vi.mock("../../../identity", () => ({ hasPermission }));
const PATH = "/api/inventory-planning/admin/cutover-preflight";
const TIME = "2026-09-07T12:00:00.000Z";

function report(): InventoryCutoverPreflight {
  return { contractVersion: "inventory_cutover_preflight_v1", scope: "nonterminal_wms_demand_and_current_inventory_encumbrances",
    capturedAt: TIME, evidenceHash: "a".repeat(64), runtimeAuthority: "legacy", authorityRevision: "1",
    outcome: "evidence_captured", operationalWriteAttempted: false, activationReadinessEvaluated: false,
    excludedTerminalOrderCount: "17", summary: { orders: 0, lines: 0, unstartedDemandLines: 0,
      noInventoryDemandLines: 0, reviewLines: 0, inventoryLevels: 0, unattributedReservationLevels: 0 },
    lines: [], inventoryLevels: [], findings: [], notEvaluated: ["Terminal custody is outside this read scope."] };
}
function facts(): InventoryCutoverPreflightFacts {
  return { capturedAt: TIME, runtimeAuthority: "legacy", authorityRevision: "1", variants: [],
    demand: { schemaVersion: "wms_inventory_cutover_demand_v1", scope: "nonterminal_wms_orders", capturedAt: TIME,
      excludedTerminalOrderCount: "17", orders: [], items: [], sourceItems: [], physicalItems: [] },
    encumbrance: { schemaVersion: "inventory_cutover_encumbrance_v1", inventoryLevels: [], buildReservations: [], canonicalResources: [],
      canonicalTablesStatus: "captured", totals: { quantitySemantics: "mixed_sku_units_not_atp", inventoryLevelCount: "0",
        variantQty: "0", reservedQty: "0", pickedQty: "0", packedQty: "0" },
      attributionCaveats: ["legacy_order_reservation_attribution_not_captured", "picked_packed_custody_not_attributed",
        "build_claim_hold_overlap_requires_deduplication", "unexplained_reserved_balance_is_not_free_supply"] } };
}

describe("inventory cutover preflight routes", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let service: { preview: ReturnType<typeof vi.fn> };
  let session: { user?: { id?: string } };

  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    service = { preview: vi.fn(async () => report()) };
    session = { user: { id: "operator-1" } };
    server = await startServer(service, () => session);
  });
  afterEach(async () => { await server.close(); vi.restoreAllMocks(); });

  it("uses the real view-permission middleware and only the authenticated session actor", async () => {
    const response = await request(server.url + PATH);
    expect(response.status).toBe(200); expect(response.body).toEqual(report());
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(hasPermission).toHaveBeenCalledExactlyOnceWith("operator-1", "inventory_planning", "view");
    expect(service.preview).toHaveBeenCalledExactlyOnceWith("operator-1");
  });
  it("rejects an unauthenticated session before permission lookup or evidence capture", async () => {
    session = {};
    const response = await request(server.url + PATH);
    expect(response.status).toBe(401); expect(hasPermission).not.toHaveBeenCalled(); expect(service.preview).not.toHaveBeenCalled();
  });
  it("does not bypass a denied view permission", async () => {
    hasPermission.mockResolvedValue(false);
    expect((await request(server.url + PATH)).status).toBe(403);
    expect(hasPermission).toHaveBeenCalledWith("operator-1", "inventory_planning", "view");
    expect(service.preview).not.toHaveBeenCalled();
  });
  it("independently rejects a missing session actor even if the permission owner returns true", async () => {
    session = { user: {} };
    const response = await request(server.url + PATH);
    expect(response).toMatchObject({ status: 401, body: { error: { code: "INVENTORY_CUTOVER_ACTOR_REQUIRED" } } });
    expect(service.preview).not.toHaveBeenCalled();
  });
  it.each(["?warehouseId=1", "?actorId=admin", "?limit=1", "?activate=true", "?orderId="])("rejects scope or actor query injection %s", async (query) => {
    const response = await request(server.url + PATH + query);
    expect(response).toMatchObject({ status: 400, body: { error: { code: "INVENTORY_CUTOVER_INVALID_REQUEST" } } });
    expect(service.preview).not.toHaveBeenCalled();
  });
  it.each([{ warehouseId: 1 }, { actorId: "admin" }, { activate: true }, { limits: { orders: 1 } }, ["order-1"]])("rejects a GET command/filter body %j", async (body) => {
    const response = await request(server.url + PATH, { body });
    expect(response).toMatchObject({ status: 400, body: { error: { code: "INVENTORY_CUTOVER_INVALID_REQUEST" } } });
    expect(service.preview).not.toHaveBeenCalled();
  });
  it.each(["POST", "PUT", "PATCH", "DELETE"])("does not register a mutating %s endpoint", async (method) => {
    expect((await request(server.url + PATH, { method, body: { activate: true } })).status).toBe(404);
    expect(service.preview).not.toHaveBeenCalled();
  });
  it.each([
    { operationalWriteAttempted: true }, { activationReadinessEvaluated: true }, { outcome: "ready" },
    { evidenceHash: "invalid" }, { secret: "private snapshot" }, { summary: { ...report().summary, lines: 1 } },
  ])("rejects malformed or misleading service output %j without returning partial data", async (patch) => {
    service.preview.mockResolvedValue({ ...report(), ...patch });
    const response = await request(server.url + PATH);
    expect(response).toMatchObject({ status: 500, body: { error: { code: "INVENTORY_CUTOVER_CAPTURE_FAILED" } } });
    expect(response.body).not.toHaveProperty("lines"); expect(JSON.stringify(response.body)).not.toContain("private snapshot");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it.each(["40001", "40P01", "57014"])("returns a sanitized retriable response for SQLSTATE %s without retrying a partial capture", async (code) => {
    service.preview.mockRejectedValue(Object.assign(new Error("secret SQL and customer evidence"), { code }));
    const response = await request(server.url + PATH);
    expect(response).toMatchObject({ status: 503, body: { error: { code: "INVENTORY_CUTOVER_CAPTURE_RETRYABLE" } } });
    expect(service.preview).toHaveBeenCalledTimes(1); expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
  });
  it.each([
    new WmsCutoverDemandCaptureError("WMS_CUTOVER_CAPTURE_LIMIT_EXCEEDED", "private row census", { secret: "private rows" }),
    new InventoryCutoverEncumbranceCaptureError("INVENTORY_CUTOVER_CAPTURE_LIMIT_EXCEEDED", "private position census", { secret: "private positions" }),
  ])("returns explicit nonpartial overflow for %s", async (error) => {
    service.preview.mockRejectedValue(error);
    const response = await request(server.url + PATH);
    expect(response).toMatchObject({ status: 422, body: { error: { code: error.code } } });
    expect(JSON.stringify(response.body)).not.toContain("private"); expect(response.body).not.toHaveProperty("summary");
  });
  it.each([
    Object.assign(new Error("database password and query"), { code: "WMS_CUTOVER_CAPTURE_LIMIT_EXCEEDED" }),
    new InventoryCutoverPreflightError(500, "PRIVATE_INTERNAL_FAILURE", "database password and query"),
    new Error("database password and query"),
  ])("sanitizes untrusted or internal failures without treating code spoofing as typed overflow", async (error) => {
    service.preview.mockRejectedValue(error);
    const response = await request(server.url + PATH);
    expect(response).toMatchObject({ status: 500, body: { error: { code: "INVENTORY_CUTOVER_CAPTURE_FAILED" } } });
    expect(JSON.stringify(response.body)).not.toMatch(/password|query|PRIVATE_INTERNAL_FAILURE/);
  });
  it("returns a classified public service validation error without its underlying cause", async () => {
    service.preview.mockRejectedValue(new InventoryCutoverPreflightError(401, "INVENTORY_CUTOVER_ACTOR_REQUIRED", "An authenticated operator is required.", { cause: new Error("private") }));
    const response = await request(server.url + PATH);
    expect(response).toMatchObject({ status: 401, body: { error: { code: "INVENTORY_CUTOVER_ACTOR_REQUIRED" } } });
    expect(JSON.stringify(response.body)).not.toContain("private");
  });
  it("uses the actual read-only service for repeatable reads without exposing a claim or activation command", async () => {
    const store = { capture: vi.fn(async () => facts()), activate: vi.fn(), reserve: vi.fn(), publish: vi.fn() };
    const actual = new InventoryCutoverPreflightService(store);
    service.preview.mockImplementation((actor) => actual.preview(actor));
    const first = await request(server.url + PATH); const second = await request(server.url + PATH);
    expect(first.status).toBe(200); expect(second.body).toEqual(first.body);
    expect(first.body).toMatchObject({ activationReadinessEvaluated: false, operationalWriteAttempted: false,
      scope: "nonterminal_wms_demand_and_current_inventory_encumbrances", excludedTerminalOrderCount: "17" });
    expect(store.capture).toHaveBeenCalledTimes(2);
    expect(store.activate).not.toHaveBeenCalled(); expect(store.reserve).not.toHaveBeenCalled(); expect(store.publish).not.toHaveBeenCalled();
  });
});

async function startServer(service: Pick<InventoryCutoverPreflightService, "preview">, session: () => unknown) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.defineProperty(req, "session", { configurable: true, value: session() }); next(); });
  registerInventoryCutoverPreflightRoutes(app, service);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function request(url: string, init: { method?: string; body?: unknown } = {}) {
  const target = new URL(url); const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search,
      method: init.method ?? "GET", headers: body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8");
        const json = res.headers["content-type"]?.includes("application/json") ? JSON.parse(text) as Record<string, unknown> : {};
        resolve({ status: res.statusCode ?? 0, body: json, headers: res.headers }); });
      res.on("error", reject);
    });
    req.on("error", reject); req.end(body);
  });
}
