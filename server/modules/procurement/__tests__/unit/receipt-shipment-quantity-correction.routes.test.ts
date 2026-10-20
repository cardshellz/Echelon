import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../routes/middleware", () => ({
  requirePermission:
    (resource: string, action: string) =>
    (req: Request, res: Response, next: NextFunction) =>
      req.headers["x-permission"] === `${resource}:${action}`
        ? next()
        : res.status(403).json({ error: "Forbidden" }),
}));
import { registerReceiptShipmentQuantityCorrectionRoutes } from "../../receipt-shipment-quantity-correction.routes";
import { QuantityCorrectionError } from "../../domain/receipt-shipment-quantity-correction";
import { correctionInput } from "../../../../../test/fixtures/quantity-correction";

describe.each(["receipt", "shipment"] as const)(
  "%s quantity HTTP boundary",
  (purpose) => {
    const suffix =
      purpose === "shipment" ? "shipment-edit" : "quantity-correction";
    const { receipts: _, ...shipmentInput } = correctionInput;
    const expectedInput =
      purpose === "shipment" ? shipmentInput : correctionInput;
    const service = {
      context: vi.fn(),
      receiptContext: vi.fn(),
      options: vi.fn(),
      preview: vi.fn(),
      approve: vi.fn(),
    };
    let server: http.Server, base: string;
    beforeEach(async () => {
      vi.resetAllMocks();
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.session = {
          user: req.headers["x-actor"]
            ? { id: String(req.headers["x-actor"]) }
            : undefined,
        } as typeof req.session;
        next();
      });
      registerReceiptShipmentQuantityCorrectionRoutes(app, service, purpose);
      server = http.createServer(app);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const post = (
      options: {
        id?: string;
        body?: unknown;
        permission?: string;
        actor?: string;
        key?: string;
      } = {},
    ) =>
      fetch(`${base}/api/shipment-lines/${options.id ?? "1"}/${suffix}`, {
        method: "POST",
        body: JSON.stringify(options.body ?? expectedInput),
        headers: {
          "content-type": "application/json",
          "x-actor": options.actor ?? "admin",
          "x-permission": options.permission ?? "purchasing:approve",
          "idempotency-key": options.key ?? "quantity-test-key",
        },
      });
    it("requires authentication, approval permission and idempotency identity", async () => {
      for (const permission of [
        "purchasing:view",
        "purchasing:edit",
        "inventory:approve",
      ])
        expect((await post({ permission })).status).toBe(403);
      expect((await post({ actor: "" })).status).toBe(401);
      expect((await post({ key: "" })).status).toBe(400);
      expect(service.approve).not.toHaveBeenCalled();
    });
    it.each(["0", "-1", "01", "1x", "1.5", "2147483648"])(
      "rejects invalid identifiers %s",
      async (id) => {
        expect((await post({ id })).status).toBe(400);
        expect(service.approve).not.toHaveBeenCalled();
      },
    );
    it.each([
      { ...expectedInput, evidenceConfirmed: false },
      { ...expectedInput, shippedPieces: 1.5 },
      { ...expectedInput, previewVersion: undefined },
      { ...expectedInput, historicalCostDestination: "ignore" },
      { ...expectedInput, reason: "" },
      { ...expectedInput, force: true },
    ])("rejects an unreviewed/invalid correction", async (body) => {
      expect((await post({ body })).status).toBe(400);
      expect(service.approve).not.toHaveBeenCalled();
    });
    it("binds actor and shipment scope and preserves replay outcome", async () => {
      service.approve.mockResolvedValue({
        httpStatus: 200,
        replayed: true,
        body: { shipmentLineId: 1 },
      });
      const response = await post();
      expect(response.status).toBe(200);
      expect(response.headers.get("Idempotency-Replayed")).toBe("true");
      expect(service.approve).toHaveBeenCalledWith(
        1,
        expectedInput,
        "admin",
        expect.objectContaining({
          actorId: "admin",
          actorType: "user",
          resourceKey: "shipment_line:1",
          commandName:
            purpose === "shipment"
              ? "procurement.shipment.quantity_edit"
              : "procurement.receipt_shipment.quantity_correct",
          idempotencyKey: "quantity-test-key",
        }),
      );
    });
    it("returns actionable known conflicts and hides unexpected database details", async () => {
      service.approve.mockRejectedValueOnce(
        new QuantityCorrectionError(
          "QUANTITY_CORRECTION_STALE",
          "Reload the source",
        ),
      );
      expect(await (await post()).json()).toEqual({
        code: "QUANTITY_CORRECTION_STALE",
        error: "Reload the source",
      });
      service.approve.mockRejectedValueOnce(
        new Error("password=secret database failure"),
      );
      const response = await post();
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain("secret");
    });
    it("gates the receipt, shipment and PO reads before accessing their owners", async () => {
      for (const path of purpose === "shipment"
        ? ["/api/shipment-lines/1/shipment-edit"]
        : [
            "/api/receiving-lines/32/quantity-correction",
            "/api/shipment-lines/1/quantity-correction",
            "/api/purchase-orders/17/quantity-corrections",
          ]) {
        expect(
          (
            await fetch(base + path, {
              headers: { "x-actor": "admin", "x-permission": "inventory:view" },
            })
          ).status,
        ).toBe(403);
      }
      expect(service.context).not.toHaveBeenCalled();
      expect(service.options).not.toHaveBeenCalled();
      expect(service.receiptContext).not.toHaveBeenCalled();
    });
  },
);
