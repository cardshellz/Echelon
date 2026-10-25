import { createServer, request as httpRequest, type Server } from "node:http";
import express, { type Request } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ permission: vi.fn() }));
vi.mock("../../../identity", () => ({ hasPermission: mocks.permission }));
vi.mock("../../supplier-return.service", () => ({ supplierReturnReader: {} }));
vi.mock("../../supplier-return.commands", () => ({ supplierReturnCommands: {}, SUPPLIER_RETURN_COMMAND_SCOPE: { method: "POST", routeTemplate: "/api/supplier-returns", resourceKey: "supplier-return:new", commandName: "supplier_return.record" } }));
vi.mock("../../supplier-return-difference.service", () => ({ supplierReturnDifferenceReader: {} }));
vi.mock("../../supplier-return-difference.commands", () => ({ supplierReturnReviewCommands: {}, SUPPLIER_RETURN_REVIEW_COMMAND_SCOPE: { method: "POST", routeTemplate: "/api/supplier-return-entitlements/:id/review", resourceKey: "supplier-return-credit-review", commandName: "supplier_return.review_credit_difference" } }));
import { registerSupplierReturnRoutes } from "../../supplier-return.routes";
import { SupplierReturnError } from "../../supplier-return.errors";
import { FinancialCommandError } from "../../../../platform/commands/transactional-command.service";
import { returnPreview, returnRequest, returnResult } from "../../../../../test/fixtures/supplier-return";

describe("supplier return HTTP boundary", () => {
  let server: Server, base: string;
  const reader = { preview: vi.fn(), options: vi.fn(), list: vi.fn(), detail: vi.fn() };
  const commands = { record: vi.fn() }, differenceReader = { read: vi.fn() }, reviewCommands = { review: vi.fn() };
  beforeAll(async () => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      const actor = req.headers["x-test-actor"];
      req.session = (typeof actor === "string" ? { user: { id: actor } } : {}) as Request["session"];
      Object.assign(req, { user: { id: "untrusted-second-identity" } });
      next();
    });
    registerSupplierReturnRoutes(app, { reader, commands, differenceReader, reviewCommands });
    server = createServer(app);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind TCP");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  beforeEach(() => {
    vi.resetAllMocks(); mocks.permission.mockResolvedValue(true);
    reader.preview.mockResolvedValue(returnPreview()); reader.options.mockResolvedValue({ items: [], nextAfterLotId: null }); reader.list.mockResolvedValue({ items: [], nextAfterId: null }); reader.detail.mockResolvedValue(returnResult().return);
    commands.record.mockResolvedValue({ commandId: 1, replayed: false, terminalState: "succeeded", httpStatus: 201, body: returnResult() });
    differenceReader.read.mockResolvedValue({ entitlementId: 1 }); reviewCommands.review.mockResolvedValue({ commandId: 2, replayed: true, terminalState: "succeeded", httpStatus: 201, body: { entitlementId: 1 } });
  });
  function request(method: string, path: string, body?: unknown, actor: string | null = "operator", key: string | null = "supplier-return-http-1") {
    const payload = body === undefined ? "" : JSON.stringify(body);
    return new Promise<{ status: number; body: any; headers: Record<string, unknown> }>((resolve, reject) => {
      const outgoing = httpRequest(new URL(path, base), { method, agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload),
        ...(actor === null ? {} : { "x-test-actor": actor }), ...(key === null ? {} : { "Idempotency-Key": key }) } }, response => {
        let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; }); response.on("error", reject);
        response.on("end", () => { try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(text), headers: response.headers }); } catch (error) { reject(error); } });
      });
      outgoing.setTimeout(5000, () => outgoing.destroy(new Error("Supplier return HTTP fixture timed out")));
      outgoing.on("error", reject); outgoing.end(payload);
    });
  }
  it.each(["/api/supplier-returns", "/api/supplier-return-entitlements/1/review"])("requires authenticated purchasing approval for %s", async path => {
    expect((await request("POST", path, {}, null)).status).toBe(401);
    mocks.permission.mockResolvedValue(false);
    expect((await request("POST", path, {})).status).toBe(403);
    expect(commands.record).not.toHaveBeenCalled(); expect(reviewCommands.review).not.toHaveBeenCalled();
  });
  it("binds collection to the same session actor as its permission check", async () => {
    expect((await request("POST", "/api/supplier-returns", returnRequest())).status).toBe(201);
    expect(commands.record.mock.calls[0][1]).toMatchObject({ actorId: "operator", actorType: "user", idempotencyKey: "supplier-return-http-1" });
    expect(mocks.permission).toHaveBeenCalledWith("operator", "purchasing", "approve");
  });
  it.each(["/api/supplier-returns", "/api/supplier-return-entitlements/1/review"])("requires an explicit durable request key for %s", async path => {
    expect((await request("POST", path, {}, "operator", null)).status).toBe(400);
    expect(commands.record).not.toHaveBeenCalled(); expect(reviewCommands.review).not.toHaveBeenCalled();
  });
  it.each(["/api/supplier-returns/1junk", "/api/supplier-returns/2147483648", "/api/supplier-return-entitlements/01/review"])("rejects malformed or out-of-range resource %s", async path => {
    expect((await request("GET", path)).status).toBe(422);
    expect(reader.detail).not.toHaveBeenCalled(); expect(differenceReader.read).not.toHaveBeenCalled();
  });
  it.each([
    "/api/supplier-returns/options?vendorId=2147483648",
    "/api/supplier-returns/options?vendorId=5&purchaseOrderId=2147483648",
    "/api/supplier-returns/options?vendorId=5&receivingOrderId=2147483648",
    "/api/supplier-returns/options?vendorId=5&afterLotId=2147483648",
    "/api/supplier-returns?vendorId=2147483648",
    "/api/supplier-returns?purchaseOrderId=2147483648",
    "/api/supplier-returns?receivingOrderId=2147483648",
    "/api/supplier-returns?afterId=2147483648",
  ])("rejects overflowing query identities before database access: %s", async path => {
    expect(await request("GET", path)).toMatchObject({ status: 422,
      body: { details: { code: "SUPPLIER_RETURN_INPUT_INVALID" } } });
    expect(reader.options).not.toHaveBeenCalled(); expect(reader.list).not.toHaveBeenCalled();
  });
  it.each([
    { vendorId: 2147483648, lines: [{ inventoryLotId: 501, quantity: 1 }] },
    { vendorId: 5, lines: [{ inventoryLotId: 2147483648, quantity: 1 }] },
  ])("rejects overflowing preview identities before database access", async input => {
    expect(await request("POST", "/api/supplier-returns/preview", input)).toMatchObject({ status: 422,
      body: { details: { code: "SUPPLIER_RETURN_INPUT_INVALID" } } });
    expect(reader.preview).not.toHaveBeenCalled();
  });
  it("accepts maximum PostgreSQL integer identities at the HTTP boundary", async () => {
    const maximumId = 2147483647;
    expect((await request("GET", `/api/supplier-returns/options?vendorId=${maximumId}&afterLotId=${maximumId}`)).status).toBe(200);
    expect(reader.options).toHaveBeenCalledWith({ vendorId: maximumId, afterLotId: maximumId, limit: 25 }, "operator");
    expect((await request("GET", `/api/supplier-returns?purchaseOrderId=${maximumId}&afterId=${maximumId}`)).status).toBe(200);
    expect(reader.list).toHaveBeenCalledWith({ purchaseOrderId: maximumId, afterId: maximumId, limit: 25 }, "operator");
    const input = { vendorId: maximumId, lines: [{ inventoryLotId: maximumId, quantity: 1 }] };
    expect((await request("POST", "/api/supplier-returns/preview", input)).status).toBe(200);
    expect(reader.preview).toHaveBeenCalledWith(input, "operator");
  });
  it("returns an explicit not-found response for a missing return", async () => {
    reader.detail.mockResolvedValue(undefined);
    expect(await request("GET", "/api/supplier-returns/999")).toMatchObject({ status: 404,
      body: { details: { code: "SUPPLIER_RETURN_NOT_FOUND" } } });
  });
  it("parses the options route before the document id route and rejects unbounded queries", async () => {
    expect((await request("GET", "/api/supplier-returns/options?vendorId=5&limit=25")).status).toBe(200);
    expect(reader.options).toHaveBeenCalledWith({ vendorId: 5, limit: 25 }, "operator");
    expect((await request("GET", "/api/supplier-returns/options?vendorId=5&limit=1000")).status).toBe(422);
    expect(reader.detail).not.toHaveBeenCalled();
  });
  it("keeps recorded review replay identity in its HTTP response", async () => {
    const response = await request("POST", "/api/supplier-return-entitlements/1/review", { expectedVersion: "a".repeat(64) });
    expect(response.status).toBe(201); expect(response.headers["idempotency-replayed"]).toBe("true");
    expect(reviewCommands.review.mock.calls[0]).toMatchObject([1, { expectedVersion: "a".repeat(64) }, { actorId: "operator", routeTemplate: "/api/supplier-return-entitlements/:id/review" }]);
  });
  it("returns known conflicts without an invented durable rejection receipt", async () => {
    reader.preview.mockRejectedValue(new SupplierReturnError("SOURCE_CHANGED", "Reload source"));
    expect(await request("POST", "/api/supplier-returns/preview", { vendorId: 2, lines: [{ inventoryLotId: 501, quantity: 1 }] })).toMatchObject({ status: 409, body: { error: "Reload source", details: { code: "SOURCE_CHANGED" } } });
  });
  it("preserves in-flight command retry headers", async () => {
    commands.record.mockRejectedValue(new FinancialCommandError("In progress", 409, "FINANCIAL_COMMAND_IN_PROGRESS", undefined, { "Retry-After": "2" }));
    const response = await request("POST", "/api/supplier-returns", returnRequest());
    expect(response.headers["retry-after"]).toBe("2"); expect(response.body.details.supplierReturnCommandOutcome).toBeUndefined();
  });
  it("logs infrastructure failure and returns recovery guidance without database details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      commands.record.mockRejectedValue(new Error("private database diagnostic"));
      const response = await request("POST", "/api/supplier-returns", returnRequest());
      expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain("private database");
      expect(response.body.details.supplierReturnCommandOutcome).toBeUndefined(); expect(log).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });
});
