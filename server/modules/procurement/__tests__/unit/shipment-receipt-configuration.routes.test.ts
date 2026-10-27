import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import type { ServiceRegistry } from "../../../../services";

vi.mock("../../../../routes/middleware", () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  const gate = (resource: string, action: string) => (req: Request, res: Response, next: NextFunction) =>
    req.headers["x-test-permission"] === `${resource}:${action}` ? next() : res.sendStatus(403);
  return { requirePermission: gate, requireAnyPermission: () => pass, requireAuth: pass, requireInternalApiKey: pass, upload: { single: () => pass } };
});
vi.mock("../../../../middleware/idempotency", () => ({ requireIdempotency: () => (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../inventory", () => ({ inventoryStorage: {} }));
vi.mock("../../procurement", () => ({ procurementStorage: {} }));
vi.mock("../../ap-ledger.service", () => ({}));
vi.mock("../../po-document", () => ({ renderPoHtml: vi.fn() }));
vi.mock("../../../notifications/email.service", () => ({}));
vi.mock("../../../notifications/notifications.service", () => ({}));

import { registerPurchaseOrderRoutes } from "../../purchase-order.routes";
import { ReceivingUnitError } from "../../receiving-unit-contract";

function serviceMock<T extends object>(methods: Partial<T>): T {
  return new Proxy(methods, { get(target, key) {
    if (!(key in target)) throw new Error(`Unexpected service access: ${String(key)}`);
    return Reflect.get(target, key);
  } }) as T;
}

describe("shipment receiving configuration HTTP boundary", () => {
  const preview = vi.fn(), create = vi.fn();
  let server: http.Server;
  let origin: string;
  const choice = { shipmentLineId: 7, productVariantId: 3, unitsPerVariant: 50, expectedBaseQty: 1000 };
  beforeEach(async () => {
    vi.clearAllMocks();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).session = { user: { id: "receiver" } }; next(); });
    app.locals.services = serviceMock<ServiceRegistry>({
      purchasing: serviceMock<ServiceRegistry["purchasing"]>({ getShipmentReceiptPackResolution: preview, createReceiptFromShipment: create }),
      shipmentTracking: serviceMock<ServiceRegistry["shipmentTracking"]>({}),
    });
    registerPurchaseOrderRoutes(app, { readWorkflow: vi.fn() });
    server = http.createServer(app);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { if (server?.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); });
  const post = (path: string, body: unknown, permission = "purchasing:view") => requestLocalHttp(origin + path, {
    method: "POST", headers: { "Content-Type": "application/json", "x-test-permission": permission }, body: JSON.stringify(body),
  });
  it("checks view permission before preview and receive permission before creation", async () => {
    expect((await post("/api/inbound-shipments/42/receipt-pack-resolution", {}, "inventory:receive")).status).toBe(403);
    expect((await post("/api/inbound-shipments/42/create-receipt", {}, "purchasing:view")).status).toBe(403);
    expect(preview).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it("passes the reviewed product configuration to preview and to the authorized receipt owner", async () => {
    const body = { purchaseOrderId: 17, receiptUnitSelections: [choice] };
    preview.mockResolvedValue({ canCreateReceipt: true }); create.mockResolvedValue({ id: 31 });
    expect((await post("/api/inbound-shipments/42/receipt-pack-resolution", body)).status).toBe(200);
    expect(preview).toHaveBeenCalledExactlyOnceWith(42, body);
    expect((await post("/api/inbound-shipments/42/create-receipt", body, "inventory:receive")).status).toBe(201);
    expect(create).toHaveBeenCalledExactlyOnceWith(42, "receiver", body);
  });
  it.each([
    [choice, choice], [{ ...choice, unitsPerVariant: 0 }], [{ ...choice, expectedBaseQty: 1.5 }], [{ ...choice, productVariantId: 2_147_483_648 }],
  ].map(receiptUnitSelections => ({ receiptUnitSelections })))("rejects invalid or duplicated selections %j", async ({ receiptUnitSelections }) => {
    const body = { purchaseOrderId: 17, receiptUnitSelections };
    expect((await post("/api/inbound-shipments/42/receipt-pack-resolution", body)).status).toBe(400);
    expect((await post("/api/inbound-shipments/42/create-receipt", body, "inventory:receive")).status).toBe(400);
    expect(preview).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it("returns catalog drift as an actionable conflict and hides unexpected database errors", async () => {
    preview.mockRejectedValueOnce(new ReceivingUnitError("Review the changed pack size", 409, { code: "RECEIVING_UNIT_SOURCE_CHANGED" }));
    const rejected = await post("/api/inbound-shipments/42/receipt-pack-resolution", { purchaseOrderId: 17, receiptUnitSelections: [choice] });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ details: { code: "RECEIVING_UNIT_SOURCE_CHANGED" } });
    preview.mockRejectedValueOnce(new Error("private database connection details"));
    const failed = await post("/api/inbound-shipments/42/receipt-pack-resolution", {});
    expect(failed.status).toBe(500); expect(JSON.stringify(await failed.json())).not.toContain("private");
  });
});
