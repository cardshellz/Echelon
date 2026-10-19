import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  actorId: "owner-1" as string | undefined,
  permission: vi.fn(),
  denyPermission: false,
  unitOptions: vi.fn(),
  repository: { reserve: vi.fn(), executeClaim: vi.fn(), rejectClaim: vi.fn(), markRetryable: vi.fn() },
}));
vi.mock("../../../../routes/middleware", () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePermission: (resource: string, action: string) => (req: Request, _res: Response, next: NextFunction) => {
    mocks.permission(resource, action);
    if (mocks.denyPermission) return _res.status(403).json({ error: "Permission denied" });
    (req as Request & { user: unknown }).user = mocks.actorId ? { id: mocks.actorId } : undefined;
    next();
  },
}));
vi.mock("../../../../middleware/idempotency", () => ({ requireIdempotency: () => (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../shipment-unit-options.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../shipment-unit-options.service")>(),
  readShipmentPackingUnitOptions: mocks.unitOptions,
}));
vi.mock("../../../../platform/commands/command-results.repository", () => ({
  financialCommandRepository: mocks.repository,
  createDrizzleFinancialCommandRepository: () => mocks.repository,
}));
vi.mock("../../ap-ledger.service", () => ({}));
vi.mock("../../../notifications/notifications.service", () => ({}));

import { ShipmentTrackingError } from "../../shipment-tracking.service";
import { ShipmentUnitOptionsError } from "../../shipment-unit-options.service";
import { shipmentUnitOptionsRequestSchema } from "@shared/procurement/shipment-unit-options";
import { shipmentLinePatchSchema } from "@shared/procurement/shipment-line-command";
import { registerInboundShipmentRoutes } from "../../inbound-shipment.routes";
import { FinancialCommandError } from "../../../../platform/commands/transactional-command.service";

let server: Server | undefined;
let url: string;
const service = { executeLineCommandInTransaction: vi.fn() };
const KEY = "shipment-line-http-fixture";

async function send(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  return new Promise<{ status: number; headers: Headers; body: unknown }>((resolve, reject) => {
    const req = request(`${url}${path}`, { method, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers } }, (res) => {
      let content = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { content += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, headers: new Headers(res.headers as Record<string, string>), body: JSON.parse(content) }); }
        catch (error) { reject(error); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload);
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.actorId = "owner-1";
  mocks.denyPermission = false;
  mocks.unitOptions.mockReset();
  mocks.repository.reserve.mockResolvedValue({ kind: "claimed", claim: { commandId: 1, leaseToken: "fixture" } });
  mocks.repository.executeClaim.mockImplementation(async (_claim, _descriptor, work) => ({ commandId: 1, replayed: false, terminalState: "succeeded", ...await work({ name: "fixture-transaction" }) }));
  mocks.repository.rejectClaim.mockImplementation(async (_claim, _descriptor, rejection) => ({ commandId: 1, replayed: false, terminalState: "rejected", httpStatus: rejection.httpStatus, body: rejection.body }));
  service.executeLineCommandInTransaction.mockResolvedValue({ id: 31, inboundShipmentId: 7, version: "a".repeat(64) });
  const app = express();
  app.use(express.json());
  app.locals.services = { shipmentTracking: service };
  registerInboundShipmentRoutes(app);
  server = createServer(app);
  await new Promise<void>((resolve) => { server!.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (!server?.listening) { server = undefined; return; }
  const activeServer = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => activeServer.close((error) => error ? reject(error) : resolve()));
});

describe("shipment line HTTP command contract", () => {
  it.each([
    ["POST", "/api/inbound-shipments/7/lines/from-po", "add-from-po", "shipment:7", 201],
    ["POST", "/api/inbound-shipments/7/lines/import-packing-list", "import", "shipment:7", 200],
    ["POST", "/api/inbound-shipments/7/lines/resolve-dimensions", "resolve-dimensions", "shipment:7", 200],
    ["PATCH", "/api/inbound-shipments/lines/31", "update", "shipment_line:31", 200],
    ["DELETE", "/api/inbound-shipments/lines/31", "delete", "shipment_line:31", 200],
  ])("binds %s to its command scope and preserves the request body", async (method, path, operation, resourceKey, status) => {
    const body = operation === "import" ? { rows: [{ sku: "SKU", qtyShipped: 501 }] } : { expectedVersion: "b".repeat(64) };
    const result = await send(method as string, path as string, body, { "Idempotency-Key": KEY });
    expect(result.status).toBe(status);
    expect(result.headers.get("Idempotency-Replayed")).toBe("false");
    expect(mocks.permission).toHaveBeenCalledWith("purchasing", "edit");
    expect(mocks.repository.reserve).toHaveBeenCalledWith(expect.objectContaining({
      method, resourceKey, commandName: `procurement.shipment_line.${operation}`,
      actorType: "service", actorId: "procurement.shipment-line", idempotencyKey: KEY,
    }));
    expect(service.executeLineCommandInTransaction).toHaveBeenCalledWith(
      expect.any(Object), { operation, resourceId: operation === "update" || operation === "delete" ? 31 : 7, body }, "owner-1", expect.any(Date),
    );
  });

  it.each(["0", "-1", "1.5", "01", "7junk", "2147483648", "9007199254740993"]) ("rejects invalid ID %s before reservation", async (id) => {
    const result = await send("POST", `/api/inbound-shipments/${id}/lines/import-packing-list`, { rows: [{ sku: "SKU", qtyShipped: 501 }] }, { "Idempotency-Key": KEY });
    expect(result).toMatchObject({ status: 400, body: { code: "SHIPMENT_LINE_ID_INVALID" } });
    expect(mocks.repository.reserve).not.toHaveBeenCalled();
  });

  it("rejects a missing key without reaching the domain", async () => {
    const result = await send("POST", "/api/inbound-shipments/7/lines/import-packing-list", { rows: [{ sku: "SKU", qtyShipped: 501 }] });
    expect(result).toMatchObject({ status: 400, body: { code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REQUIRED" } });
    expect(mocks.repository.reserve).not.toHaveBeenCalled();
    expect(service.executeLineCommandInTransaction).not.toHaveBeenCalled();
  });

  it("requires an actual authenticated actor even though the replay scope uses the service owner", async () => {
    mocks.actorId = undefined;
    const result = await send("DELETE", "/api/inbound-shipments/lines/31", { expectedVersion: "b".repeat(64) }, { "Idempotency-Key": KEY });
    expect(result).toMatchObject({ status: 401, body: { code: "SHIPMENT_LINE_ACTOR_REQUIRED" } });
    expect(mocks.repository.reserve).not.toHaveBeenCalled();
  });

  it("returns exact stored status/body and signals replay to a delegated caller", async () => {
    const body = { imported: 1, lines: [{ id: 31, qtyShipped: 501 }], errors: [] };
    mocks.actorId = "delegate-2";
    mocks.repository.reserve.mockResolvedValue({ kind: "replay", result: { commandId: 1, replayed: true, terminalState: "succeeded", httpStatus: 201, body } });
    const result = await send("POST", "/api/inbound-shipments/7/lines/import-packing-list", { rows: [{ sku: "SKU", qtyShipped: 501 }] }, { "Idempotency-Key": KEY });
    expect(result.status).toBe(201);
    expect(result.body).toEqual(body);
    expect(result.headers.get("Idempotency-Replayed")).toBe("true");
    expect(service.executeLineCommandInTransaction).not.toHaveBeenCalled();
  });

  it("preserves the command retry header and structured conflict response", async () => {
    mocks.repository.reserve.mockRejectedValue(new FinancialCommandError("Still running", 409, "FINANCIAL_COMMAND_IN_PROGRESS", undefined, { "Retry-After": "3" }));
    const result = await send("POST", "/api/inbound-shipments/7/lines/import-packing-list", { rows: [{ sku: "SKU", qtyShipped: 501 }] }, { "Idempotency-Key": KEY });
    expect(result).toMatchObject({ status: 409, body: { code: "FINANCIAL_COMMAND_IN_PROGRESS", error: "Still running" } });
    expect(result.headers.get("Retry-After")).toBe("3");
    expect(service.executeLineCommandInTransaction).not.toHaveBeenCalled();
  });
  it("marks only recorded input rejection with the original request key", async () => {
    const invalid = shipmentLinePatchSchema.safeParse({ expectedVersion: "a".repeat(64), qtyShipped: 1,
      unitSelection: { productVariantId: 20, unitsPerVariant: 1000, quantity: 2147483647 } });
    expect(invalid.success).toBe(false);
    service.executeLineCommandInTransaction.mockRejectedValue(invalid.error);
    const result = await send("PATCH", "/api/inbound-shipments/lines/31", {}, { "Idempotency-Key": KEY });
    expect(result).toMatchObject({ status: 400, body: { code: "SHIPMENT_LINE_INPUT_INVALID",
      details: { shipmentLineOutcome: "rejected", idempotencyKey: KEY } } });
    expect(mocks.repository.rejectClaim).toHaveBeenCalledOnce();
  });

  it("preserves source review details when a durable rejection is replayed", async () => {
    const body = { code: "SHIPMENT_UNIT_SOURCE_CHANGED", error: "Review pack factor", details: { productVariantId: 20 } };
    mocks.repository.reserve.mockResolvedValue({ kind: "replay", result: { commandId: 1, replayed: true, terminalState: "rejected", httpStatus: 409, body } });
    const result = await send("PATCH", "/api/inbound-shipments/lines/31", {}, { "Idempotency-Key": KEY });
    expect(result).toMatchObject({ status: 409, body: { code: "SHIPMENT_UNIT_SOURCE_CHANGED",
      details: { productVariantId: 20, shipmentLineOutcome: "rejected", idempotencyKey: KEY } } });
    expect(result.headers.get("Idempotency-Replayed")).toBe("true");
    expect(service.executeLineCommandInTransaction).not.toHaveBeenCalled();
  });

  it.each(["FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED", "FINANCIAL_COMMAND_IN_PROGRESS"])("does not invent a rejection marker for pre-ledger %s", async (code) => {
    mocks.repository.reserve.mockRejectedValue(new FinancialCommandError("Request not reserved", 409, code));
    const result = await send("PATCH", "/api/inbound-shipments/lines/31", {}, { "Idempotency-Key": KEY });
    expect(result.body).not.toHaveProperty("details.shipmentLineOutcome");
    expect(mocks.repository.rejectClaim).not.toHaveBeenCalled();
  });

  it("does not mark a failed rejection persistence attempt as safely rejected", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    service.executeLineCommandInTransaction.mockRejectedValue(new ShipmentTrackingError("Pack changed", 409, { code: "SHIPMENT_UNIT_SOURCE_CHANGED" }));
    mocks.repository.rejectClaim.mockRejectedValue(new Error("connection lost before recording rejection"));
    const result = await send("PATCH", "/api/inbound-shipments/lines/31", {}, { "Idempotency-Key": KEY });
    expect(result).toMatchObject({ status: 500, body: { code: "SHIPMENT_LINE_TRANSIENT_FAILURE" } });
    expect(result.body).not.toHaveProperty("details.shipmentLineOutcome");
    log.mockRestore();
  });

});


describe("purchasing-scoped shipment unit preview HTTP contract", () => {
  const path = "/api/inbound-shipments/7/lines/unit-options";
  const body = { rows: [{ purchaseOrderLineId: 21, selectedVariantId: 201, sku: "PIECE" }] };
  const result = { shipmentId: 7, rows: [{ row: 1, units: {
    productId: 10, selectedVariantId: 201, unitsPerVariantSnapshot: null,
    variants: [{ id: 201, sku: "PIECE", name: "Piece", unitsPerVariant: 1 }], issue: null,
  } }] };

  it("uses purchasing view permission and returns canonical row evidence without reserving a command", async () => {
    mocks.unitOptions.mockResolvedValue(result);
    const response = await send("POST", path, body);
    expect(response).toMatchObject({ status: 200, body: result });
    expect(mocks.permission.mock.calls).toEqual([["purchasing", "view"]]);
    expect(mocks.unitOptions).toHaveBeenCalledWith({}, 7, body);
    expect(mocks.repository.reserve).not.toHaveBeenCalled();
    expect(service.executeLineCommandInTransaction).not.toHaveBeenCalled();
  });

  it("does not read catalog evidence when purchasing permission is denied", async () => {
    mocks.denyPermission = true;
    const response = await send("POST", path, body);
    expect(response.status).toBe(403);
    expect(mocks.unitOptions).not.toHaveBeenCalled();
    expect(mocks.repository.reserve).not.toHaveBeenCalled();
  });

  it.each(["0", "01", "1.5", "7junk", "2147483648"])("rejects malformed shipment ID %s before source reads", async (id) => {
    const response = await send("POST", `/api/inbound-shipments/${id}/lines/unit-options`, body);
    expect(response).toMatchObject({ status: 400, body: { code: "SHIPMENT_UNIT_OPTIONS_INPUT_INVALID" } });
    expect(mocks.unitOptions).not.toHaveBeenCalled();
  });

  it("rejects unrecognized query options before source reads", async () => {
    const response = await send("POST", `${path}?all=true`, body);
    expect(response).toMatchObject({ status: 400, body: { code: "SHIPMENT_UNIT_OPTIONS_INPUT_INVALID" } });
    expect(mocks.unitOptions).not.toHaveBeenCalled();
  });

  it.each([0, 501])("classifies the service's bounded request rejection for %i rows", async (count) => {
    mocks.unitOptions.mockImplementation(async (_db, _shipmentId, input) => shipmentUnitOptionsRequestSchema.parse(input));
    const response = await send("POST", path, { rows: Array.from({ length: count }, () => ({ sku: "PIECE" })) });
    expect(response).toMatchObject({ status: 400, body: { code: "SHIPMENT_UNIT_OPTIONS_INPUT_INVALID" } });
    expect(mocks.repository.reserve).not.toHaveBeenCalled();
  });

  it.each([[404, "SHIPMENT_LINE_NOT_FOUND"], [409, "SHIPMENT_UNIT_OPTIONS_LIMIT"]])("preserves classified read failure %s", async (status, code) => {
    mocks.unitOptions.mockRejectedValue(new ShipmentUnitOptionsError("Review source rows", Number(status), String(code)));
    const response = await send("POST", path, body);
    expect(response).toMatchObject({ status, body: { code, error: "Review source rows" } });
    expect(response.body).not.toHaveProperty("details.shipmentLineOutcome");
  });

  it("sanitizes unexpected read errors and leaves mutation/recovery ownership untouched", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.unitOptions.mockRejectedValue(new Error("private connection credentials must not escape"));
      const response = await send("POST", path, body);
      expect(response).toMatchObject({ status: 503, body: { code: "SHIPMENT_UNIT_OPTIONS_UNAVAILABLE" } });
      expect(JSON.stringify(response.body)).not.toContain("credentials");
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"procurement.shipment_unit_options.failed"'));
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("credentials"));
      expect(mocks.repository.reserve).not.toHaveBeenCalled();
      expect(response.body).not.toHaveProperty("details.shipmentLineOutcome");
    } finally { log.mockRestore(); }
  });
});
