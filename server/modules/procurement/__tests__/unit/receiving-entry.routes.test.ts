import { createServer, request as httpRequest, type Server } from "node:http";
import express, { type Request } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), permission: vi.fn(), log: vi.fn() }));
vi.mock("../../../identity", () => ({ hasPermission: mocks.permission }));
vi.mock("../../../../platform/observability", () => ({ logger: { error: mocks.log } }));
vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: {} }));
vi.mock("../../receiving-entry.commands", async original => ({ ...await original<typeof import("../../receiving-entry.commands")>(),
  createReceivingEntryCommands: () => ({ execute: mocks.execute }) }));
import { FinancialCommandError } from "../../../../platform/commands/transactional-command.service";
import { hashReceivingEntryCommandIdentity, receivingEntryCommandScope, RECEIVING_ENTRY_COMMAND_PRINCIPAL } from "../../receiving-entry.commands";
import { registerReceivingEntryRoutes } from "../../receiving-entry.routes";

const key = "receiving-entry-http-001";
const routes = [
  { action: "create", path: "/api/receiving", targetId: null, payload: { sourceType: "blind", warehouseId: 1 } },
  { action: "add-line", path: "/api/receiving/31/lines", targetId: 31, payload: { sku: "CASE", receivedQty: 5 } },
] as const;

describe("receiving entry HTTP boundary", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const actor = req.headers["x-test-actor"];
      req.session = (typeof actor === "string" ? { user: { id: actor } } : {}) as Request["session"];
      next();
    });
    // The mocked command boundary owns all mutation and authority behavior in
    // this HTTP fixture; PostgreSQL coverage uses the actual ReceivingService.
    Object.assign(app.locals, { services: {} });
    registerReceivingEntryRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test did not bind TCP");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  beforeEach(() => { vi.clearAllMocks(); mocks.permission.mockResolvedValue(true);
    mocks.execute.mockResolvedValue({ commandId: 1, replayed: false, terminalState: "succeeded", httpStatus: 201, body: { id: 9 } }); });
  function post(path: string, body: unknown, headers: Record<string, string> = { "Idempotency-Key": key }, actor: string | null = "operator") {
    const payload = JSON.stringify(body);
    return new Promise<{ status: number; body: Record<string, unknown>; replayed?: string }>((resolve, reject) => {
      const request = httpRequest(new URL(path, base), { method: "POST", agent: false, headers: {
        "content-type": "application/json", "content-length": Buffer.byteLength(payload),
        ...(actor === null ? {} : { "x-test-actor": actor }), ...headers,
      } }, response => {
        let text = "";
        response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; }); response.on("error", reject);
        response.on("end", () => { try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(text), replayed: response.headers["idempotency-replayed"] as string | undefined }); } catch (error) { reject(error); } });
      });
      request.setTimeout(5_000, () => request.destroy(new Error("Receiving entry HTTP test timed out")));
      request.on("error", reject); request.end(payload);
    });
  }
  it.each(routes)("requires current inventory adjustment permission for $action", async route => {
    expect((await post(route.path, route.payload, {}, null)).status).toBe(401);
    mocks.permission.mockResolvedValue(false);
    expect((await post(route.path, route.payload)).status).toBe(403);
    expect(mocks.permission).toHaveBeenCalledWith("operator", "inventory", "adjust");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each(routes)("passes exact $action intent and current actor into one shared key namespace", async route => {
    expect(await post(route.path, route.payload)).toMatchObject({ status: 201, replayed: "false" });
    const command = { action: route.action, targetId: route.targetId, payload: route.payload };
    expect(mocks.execute).toHaveBeenCalledWith(command, "operator", { ...receivingEntryCommandScope(), actorType: "service", actorId: RECEIVING_ENTRY_COMMAND_PRINCIPAL,
      idempotencyKey: key, contractVersion: 1, requestHash: hashReceivingEntryCommandIdentity(command, "operator") });
  });
  it.each([{}, { "Idempotency-Key": "short" }, { "Idempotency-Key": key, "X-Idempotency-Key": "different-key" }] as Array<Record<string, string>>)("rejects missing or malformed command identity %j", async headers => {
    expect((await post(routes[0].path, routes[0].payload, headers)).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "01", "1.5", "1e2", "2147483648", "invalid"])("rejects malformed target %s before reservation", async id => {
    expect(await post(`/api/receiving/${id}/lines`, {})).toMatchObject({ status: 400, body: { code: "RECEIVING_ENTRY_TARGET_INVALID" } });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each(routes)("rejects query parameters for $action", async route => {
    expect(await post(route.path + "?receivedQty=99", route.payload)).toMatchObject({ status: 400, body: { code: "RECEIVING_ENTRY_QUERY_INVALID" } });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("preserves raw input and the legacy header alias for exact request identity", async () => {
    const raw = { receivedQty: "5", unit_cost_mills: 375, actorId: "spoofed" };
    await post(routes[1].path, raw, { "X-Idempotency-Key": key });
    expect(mocks.execute.mock.calls[0].slice(0, 2)).toEqual([{ action: "add-line", targetId: 31, payload: raw }, "operator"]);
  });
  it("returns saved rejection and replay acknowledgement unchanged", async () => {
    const body = { code: "RECEIVING_UNIT_CHANGED", error: "Review pack", details: { receivingEntryOutcome: "rejected", idempotencyKey: key } };
    mocks.execute.mockResolvedValue({ replayed: true, terminalState: "rejected", httpStatus: 409, body });
    expect(await post(routes[1].path, routes[1].payload)).toEqual({ status: 409, body, replayed: "true" });
  });
  it("keeps a transient failure uncertain and logs no request or raw database exception", async () => {
    mocks.execute.mockRejectedValue(new Error("sensitive database failure"));
    expect(await post(routes[0].path, routes[0].payload)).toMatchObject({ status: 503, body: { code: "RECEIVING_ENTRY_UNAVAILABLE" } });
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("sensitive database failure");
  });
  it("preserves command conflicts without inventing a definitive business rejection", async () => {
    mocks.execute.mockRejectedValue(new FinancialCommandError("In progress", 409, "FINANCIAL_COMMAND_IN_PROGRESS", undefined, { "Retry-After": "1" }));
    expect(await post(routes[1].path, routes[1].payload)).toMatchObject({ status: 409, body: { code: "FINANCIAL_COMMAND_IN_PROGRESS" } });
  });
});
