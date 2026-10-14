import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServiceRegistry } from "../../../../services";
import express, { type Request, type Response, type NextFunction } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { supplierDocumentSource } from "../fixtures/supplier-po-document.fixture";
import { SupplierPoDocumentError } from "../../supplier-po-document";
const sourceReader = vi.hoisted(() => vi.fn());
vi.mock("../../supplier-po-document.repository", () => ({ loadSupplierPoDocumentSource: sourceReader }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../inventory", () => ({ inventoryStorage: {} }));
vi.mock("../../../orders", () => ({ ordersStorage: {} }));
vi.mock("../../procurement", () => ({ procurementStorage: {} }));
vi.mock("../../ap-ledger.service", () => ({}));
vi.mock("../../po-email-outbox.service", () => ({
  enqueuePurchaseOrderEmail: vi.fn(), listPurchaseOrderEmailDeliveries: vi.fn(), replayDeadLetterPurchaseOrderEmail: vi.fn(),
  PoEmailOutboxError: class extends Error { constructor(message: string, readonly statusCode: number, readonly code: string) { super(message); } },
}));
vi.mock("../../../../routes/middleware", () => ({
  requireAnyPermission: () => (req: Request, _res: Response, next: NextFunction) => {
    req.session = { user: { id: "document-reader" } } as typeof req.session; next();
  },
  requirePermission: () => (req: Request, _res: Response, next: NextFunction) => {
    req.session = { user: { id: "document-reader" } } as typeof req.session; next();
  },
}));
vi.mock("../../../../middleware/idempotency", () => ({ requireIdempotency: () => (_req: Request, _res: Response, next: NextFunction) => next() }));
import { registerPurchaseOrderRoutes } from "../../purchase-order.routes";

function unusedService(name: string): object {
  return new Proxy({}, {
    get(_target, method) {
      throw new Error(`Supplier document route unexpectedly accessed ${name}.${String(method)}`);
    },
  });
}

describe("supplier document HTTP boundary", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const services = {
      purchasing: unusedService("purchasing"),
      shipmentTracking: unusedService("shipmentTracking"),
    } satisfies Partial<Record<keyof ServiceRegistry, object>>;
    // Registration captures these services, but document requests use only the
    // mocked repository. Keep this harness partial and reject unexpected calls.
    app.locals.services = services as ServiceRegistry;
    registerPurchaseOrderRoutes(app);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => { sourceReader.mockReset(); });
  afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  it("returns validated escaped draft preview and source identity without private source fields", async () => {
    sourceReader.mockResolvedValue(supplierDocumentSource());
    const response = await fetch(`${base}/api/purchase-orders/1/document`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ purpose: "draft_preview", sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(body.html).toContain("$123.45"); expect(body.html).not.toContain("PRIVATE_");
    expect(sourceReader.mock.calls[0][1]).toBe(1);
  });
  it("returns an actionable source review error and no printable HTML", async () => {
    sourceReader.mockResolvedValue({ ...supplierDocumentSource(), po: { ...supplierDocumentSource().po, totalCents: null } });
    const response = await fetch(`${base}/api/purchase-orders/1/document`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Review the saved PO"), details: { code: "INVALID_SUPPLIER_DOCUMENT_SOURCE" } });
  });
  it("returns not found from the repository without inventing a document", async () => {
    sourceReader.mockRejectedValue(new SupplierPoDocumentError("PURCHASE_ORDER_NOT_FOUND", "Purchase order not found.", 404));
    const response = await fetch(`${base}/api/purchase-orders/999/document`);
    expect(response.status).toBe(404); expect(await response.json()).not.toHaveProperty("html");
  });
  it.each(["invalid", "-1", "0", "1.5"])("rejects invalid identifier %s before reading", async id => {
    const response = await fetch(`${base}/api/purchase-orders/${id}/document`);
    expect(response.status).toBe(400); expect(sourceReader).not.toHaveBeenCalled();
  });
});
