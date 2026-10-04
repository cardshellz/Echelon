import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipOrderOpsIntakeDetail, DropshipOrderOpsService } from "../../application/dropship-order-ops-service";
import type { DropshipOrderAcceptanceWorkflowService } from "../../application/dropship-order-acceptance-workflow-service";
import type { DropshipOrderRejectionService } from "../../application/dropship-order-rejection-service";
import type { DropshipVendorProvisioningService } from "../../application/dropship-vendor-provisioning-service";
import { registerDropshipOrderRoutes } from "../../interfaces/http/dropship-order.routes";
import { makeDropshipOrderOpsDetail } from "../fixtures/order-ops-detail.fixture";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

vi.mock("../../interfaces/http/dropship-auth.routes", () => ({
  requireDropshipAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.session = { dropship: { memberId: "member-1" } } as unknown as Request["session"];
    next();
  },
  requireDropshipSensitiveActionProof: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const expiresAt = new Date("2026-09-18T12:00:00.000Z");

describe("dropship vendor order routes: payment hold summary", () => {
  let server: { url: string; close: () => Promise<void> };
  let summaryInputs: unknown[];
  let summaryError: unknown;
  let detailInputs: unknown[];

  beforeEach(async () => {
    summaryInputs = [];
    summaryError = null;
    detailInputs = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const orderOpsService = {
      getPaymentHoldSummary: async (input: unknown) => {
        summaryInputs.push(input);
        if (summaryError) throw summaryError;
        return {
          heldCount: 2,
          totalDebitCents: 19_000,
          availableBalanceCents: 4_000,
          shortfallCents: 15_000,
          earliestExpiresAt: expiresAt,
          currency: "USD",
        };
      },
      getIntakeDetail: async (input: unknown) => {
        detailInputs.push(input);
        throw new DropshipError("DROPSHIP_ORDER_OPS_INTAKE_NOT_FOUND", "Dropship order intake was not found.");
      },
    } as unknown as DropshipOrderOpsService;
    const vendorProvisioningService = {
      provisionForMember: async () => ({ vendor: { vendorId: 10 }, created: false, changedFields: [] }),
    } as unknown as DropshipVendorProvisioningService;
    const app = express();
    app.use(express.json());
    registerDropshipOrderRoutes(app, {
      orderOpsService,
      vendorProvisioningService,
      orderAcceptanceWorkflowService: {} as DropshipOrderAcceptanceWorkflowService,
      orderRejectionService: {} as DropshipOrderRejectionService,
    });
    server = await startServer(app);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("serves the vendor's held-order summary scoped to their own vendor id", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/orders/payment-hold-summary`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      summary: {
        heldCount: 2,
        totalDebitCents: 19_000,
        availableBalanceCents: 4_000,
        shortfallCents: 15_000,
        earliestExpiresAt: "2026-09-18T12:00:00.000Z",
        currency: "USD",
      },
    });
    expect(summaryInputs).toEqual([{ vendorId: 10 }]);
    // The summary path is not mistaken for an intake id by the parameter route.
    expect(detailInputs).toEqual([]);
  });

  it("still validates intake ids on the parameter route that follows it", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/orders/not-an-id`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("DROPSHIP_ORDER_INVALID_REQUEST");
    expect(detailInputs).toEqual([]);
  });

  it("reports a summary input failure as bad input, not a server fault", async () => {
    summaryError = new DropshipError(
      "DROPSHIP_ORDER_OPS_PAYMENT_HOLD_SUMMARY_INVALID_INPUT",
      "Dropship order ops input failed validation.",
      { issues: [] },
    );

    const response = await jsonRequest(`${server.url}/api/dropship/orders/payment-hold-summary`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("DROPSHIP_ORDER_OPS_PAYMENT_HOLD_SUMMARY_INVALID_INPUT");
  });
});

describe("dropship vendor order routes: order detail", () => {
  let server: { url: string; close: () => Promise<void> };
  let detailInputs: unknown[];
  let detail: DropshipOrderOpsIntakeDetail;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    detailInputs = [];
    detail = makeDropshipOrderOpsDetail();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const orderOpsService = {
      getIntakeDetail: async (input: unknown) => {
        detailInputs.push(input);
        return detail;
      },
    } as unknown as DropshipOrderOpsService;
    const vendorProvisioningService = {
      provisionForMember: async () => ({ vendor: { vendorId: 10 }, created: false, changedFields: [] }),
    } as unknown as DropshipVendorProvisioningService;
    const app = express();
    app.use(express.json());
    registerDropshipOrderRoutes(app, {
      orderOpsService,
      vendorProvisioningService,
      orderAcceptanceWorkflowService: {} as DropshipOrderAcceptanceWorkflowService,
      orderRejectionService: {} as DropshipOrderRejectionService,
    });
    server = await startServer(app);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("sends the vendor shipping as one amount, with no insurance pool or rate parts", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/orders/42`);

    expect(response.status).toBe(200);
    expect(detailInputs).toEqual([{ intakeId: 42, vendorId: 10 }]);
    expect(response.body.order.economicsSnapshot).toEqual({
      economicsSnapshotId: 501,
      shippingQuoteSnapshotId: 301,
      warehouseId: 1,
      currency: "USD",
      retailSubtotalCents: 1299,
      wholesaleSubtotalCents: 699,
      shippingCents: 925,
      feesCents: 0,
      totalDebitCents: 1624,
      createdAt: "2026-10-03T15:00:00.000Z",
    });
    expect(response.body.order.shippingQuoteSnapshot).toEqual({
      quoteSnapshotId: 301,
      warehouseId: 1,
      currency: "USD",
      destinationCountry: "US",
      destinationPostalCode: "10001",
      packageCount: 1,
      totalShippingCents: 925,
      createdAt: "2026-10-03T15:00:00.000Z",
    });
    const raw = JSON.stringify(response.body);
    for (const field of ["insurancePoolCents", "baseRateCents", "markupCents", "dunnageCents", "quotePayload", "pricingSnapshot"]) {
      expect(raw).not.toContain(`"${field}"`);
    }
    // The rest of the order still reaches the vendor.
    expect(response.body.order).toMatchObject({
      intakeId: 42,
      externalOrderNumber: "1001",
      lines: [{ sku: "SKU-1", quantity: 1 }],
      walletLedgerEntry: { walletLedgerEntryId: 801, amountCents: -1624 },
      auditEvents: [{ eventType: "order_accepted", payload: { totalDebitCents: 1624 } }],
    });
    expect(response.body.order).not.toHaveProperty("latestAuditEvent");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("sends nothing and logs an error when the detail does not fit the vendor contract", async () => {
    detail = makeDropshipOrderOpsDetail();
    detail = { ...detail, economicsSnapshot: { ...detail.economicsSnapshot!, shippingCents: 9.25 } };

    const response = await jsonRequest(`${server.url}/api/dropship/orders/42`);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: "DROPSHIP_ORDER_INTERNAL_ERROR", message: "Dropship order request failed." },
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(consoleError.mock.calls[0][0]));
    expect(logged).toEqual({
      level: "error",
      code: "DROPSHIP_VENDOR_ORDER_DETAIL_CONTRACT_INVALID",
      message: "Order detail did not fit the vendor contract; nothing was sent.",
      context: {
        intakeId: 42,
        vendorId: 10,
        issues: [{ path: "order.economicsSnapshot.shippingCents", code: "invalid_type" }],
      },
    });
  });
});

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}
