import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryCutoverOpeningError, type InventoryCutoverOpeningService } from "../../application/inventory-cutover-opening.service";
import { registerInventoryCutoverOpeningRoutes } from "../../interfaces/http/inventory-cutover-opening.routes";
import { isInventoryCutoverOpeningBulkJsonRequest, OPENING_JSON_LIMIT_BYTES } from "../../interfaces/http/inventory-cutover-opening-body.middleware";
import { installGlobalJsonBodyParser } from "../../../shipping-engine/interfaces/http/rate-table-admin-body.middleware";
import { openingAssessment, openingSaved, openingSource, openingVerification } from "../fixtures/inventory-cutover-opening-interface.fixture";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
vi.mock("../../../identity", () => ({ hasPermission }));
const ROOT = "/api/inventory-planning/admin/cutover-opening";
const saveRequest = () => ({ verification: openingVerification(), reason: "Reviewed independent current evidence", idempotencyKey: "verify-1" });

describe("authenticated complete opening verification routes", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let session: { user?: { id?: string } };
  let service: { capture: ReturnType<typeof vi.fn>; preview: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true); vi.spyOn(console, "error").mockImplementation(() => undefined);
    session = { user: { id: "operator-1" } };
    service = { capture: vi.fn(async () => openingSource()), preview: vi.fn(async () => openingAssessment()), save: vi.fn(async () => openingSaved()) };
    server = await startServer(service, () => session);
  });
  afterEach(async () => { await server.close(); vi.restoreAllMocks(); });
  it("captures only through activate permission and the session actor, without preview/save calls", async () => {
    const response = await request(server.url + ROOT + "/source", undefined, "GET");
    expect(response).toMatchObject({ status: 200, body: openingSource() }); expect(response.headers["cache-control"]).toBe("no-store");
    expect(hasPermission).toHaveBeenCalledExactlyOnceWith("operator-1", "inventory_planning", "activate");
    expect(service.capture).toHaveBeenCalledExactlyOnceWith("operator-1"); expect(service.preview).not.toHaveBeenCalled(); expect(service.save).not.toHaveBeenCalled();
  });
  it("previews without persistence and reports fresh versus replayed audit save separately", async () => {
    expect(await request(server.url + ROOT + "/preview", openingVerification())).toMatchObject({ status: 200, body: openingAssessment() });
    expect(service.preview).toHaveBeenCalledExactlyOnceWith(openingVerification(), "operator-1"); expect(service.save).not.toHaveBeenCalled();
    expect(await request(server.url + ROOT + "/verify", saveRequest())).toMatchObject({ status: 201, body: { stockChanged: false, authorityChanged: false } });
    service.save.mockResolvedValueOnce({ ...openingSaved(), alreadyApplied: true });
    expect(await request(server.url + ROOT + "/verify", saveRequest())).toMatchObject({ status: 200, body: { alreadyApplied: true } });
    expect(service.save).toHaveBeenCalledWith(saveRequest(), "operator-1");
  });
  it.each(["source", "preview", "verify"])("rejects missing authentication for %s before reading any body", async action => {
    session = {};
    const response = await request(server.url + ROOT + `/${action}`, "{invalid", action === "source" ? "GET" : "POST", true);
    expect(response.status).toBe(401); expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.capture).not.toHaveBeenCalled(); expect(service.preview).not.toHaveBeenCalled(); expect(service.save).not.toHaveBeenCalled();
  });
  it.each(["source", "preview", "verify"])("rejects denied permission for %s before parsing bulk JSON", async action => {
    hasPermission.mockResolvedValue(false);
    expect((await request(server.url + ROOT + `/${action}`, "{invalid", action === "source" ? "GET" : "POST", true)).status).toBe(403);
    expect(service.capture).not.toHaveBeenCalled(); expect(service.preview).not.toHaveBeenCalled(); expect(service.save).not.toHaveBeenCalled();
  });
  it.each(["source", "preview", "verify"])("rejects partial query filters for %s", async action => {
    const response = await request(server.url + ROOT + `/${action}?warehouseId=1`, action === "preview" ? openingVerification() : saveRequest(), action === "source" ? "GET" : "POST");
    expect(response).toMatchObject({ status: 400, body: { error: { code: "CUTOVER_OPENING_REQUEST_INVALID" } } });
  });
  it.each([{}, { ...openingVerification(), actor: "admin" }, { ...openingVerification(), historicalDisposition: "resolved" }])("rejects incomplete and unsafe preview input %#", async value => {
    expect((await request(server.url + ROOT + "/preview", value)).status).toBe(400); expect(service.preview).not.toHaveBeenCalled();
  });
  it.each([{}, { ...saveRequest(), actor: "admin" }, { ...saveRequest(), reason: " " }, { ...saveRequest(), idempotencyKey: "" }])("rejects invalid save input %#", async value => {
    expect((await request(server.url + ROOT + "/verify", value)).status).toBe(400); expect(service.save).not.toHaveBeenCalled();
  });
  it("parses complete authorized payloads over100KB and preserves the exact facts", async () => {
    const verification = openingVerification(); verification.lots = Array.from({ length: 1_000 }, (_, index) => ({ ...verification.lots[0], id: index + 1 }));
    expect(Buffer.byteLength(JSON.stringify(verification))).toBeGreaterThan(100 * 1024);
    expect((await request(server.url + ROOT + "/preview", verification)).status).toBe(200);
    expect(service.preview).toHaveBeenCalledExactlyOnceWith(verification, "operator-1");
  });
  it("rejects malformed JSON and too-large documents without partial service calls", async () => {
    expect(await request(server.url + ROOT + "/preview", "{bad", "POST", true)).toMatchObject({ status: 400,
      body: { error: { code: "CUTOVER_OPENING_JSON_INVALID" } } });
    expect(await request(server.url + ROOT + "/verify", { padding: "x".repeat(OPENING_JSON_LIMIT_BYTES) })).toMatchObject({ status: 413,
      body: { error: { code: "CUTOVER_OPENING_REQUEST_TOO_LARGE" } } });
    expect(service.preview).not.toHaveBeenCalled(); expect(service.save).not.toHaveBeenCalled();
  });
  it("keeps unrelated requests at the existing global100KB bound", async () => {
    expect((await request(server.url + "/api/unrelated", { padding: "x".repeat(110_000) })).status).toBe(413);
  });
  it.each(["preview", "verify"])("returns typed rejection for %s without leaking private context", async action => {
    service[action === "verify" ? "save" : "preview"].mockRejectedValue(new InventoryCutoverOpeningError("CUTOVER_OPENING_EVIDENCE_CHANGED", "Refresh the current records", 409, { private: "secret" }));
    const response = await request(server.url + ROOT + `/${action}`, action === "verify" ? saveRequest() : openingVerification());
    expect(response).toMatchObject({ status: 409, body: { error: { code: "CUTOVER_OPENING_EVIDENCE_CHANGED" } } });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
  it("does not trust spoofed exceptions or report stock-changing output as an audit save", async () => {
    service.preview.mockRejectedValue(Object.assign(new Error("secret SQL"), { code: "CUTOVER_OPENING_EVIDENCE_CHANGED", status: 409 }));
    const response = await request(server.url + ROOT + "/preview", openingVerification());
    expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain("secret");
    service.save.mockResolvedValueOnce({ ...openingSaved(), stockChanged: true });
    expect((await request(server.url + ROOT + "/verify", saveRequest())).status).toBe(500);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
  });
});

describe("opening bulk parser route scope", () => {
  it.each(["preview", "verify"])("bypasses the global parser only for exactPOST%s", action => {
    expect(isInventoryCutoverOpeningBulkJsonRequest("POST", ROOT + `/${action}`)).toBe(true);
    expect(isInventoryCutoverOpeningBulkJsonRequest("POST", ROOT + `/${action}/`)).toBe(true);
    expect(isInventoryCutoverOpeningBulkJsonRequest("PUT", ROOT + `/${action}`)).toBe(false);
    expect(isInventoryCutoverOpeningBulkJsonRequest("POST", ROOT + `/${action}/extra`)).toBe(false);
  });
});

async function startServer(service: Pick<InventoryCutoverOpeningService, "capture" | "preview" | "save">, session: () => unknown) {
  const app = express(); installGlobalJsonBodyParser(app);
  app.use((req, _res, next) => { Object.defineProperty(req, "session", { configurable: true, value: session() }); next(); });
  registerInventoryCutoverOpeningRoutes(app, service); app.post("/api/unrelated", (_req, res) => { res.json({ ok: true }); });
  app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: "Parser rejected" }); });
  const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
async function request(url: string, input?: unknown, method = "POST", raw = false) {
  const target = new URL(url); const body = method === "GET" ? "" : raw ? String(input) : JSON.stringify(input);
  return new Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: res.headers })); res.on("error", reject);
    }); req.on("error", reject); req.end(body);
  });
}
