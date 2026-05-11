import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipOrderOpsService } from "../../application";
import { registerDropshipAdminOrderOpsRoutes } from "../../interfaces/http/dropship-admin-order-ops.routes";

vi.mock("../../../../db", () => ({
  pool: {},
  db: {},
}));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

describe("dropship admin order ops routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeDropshipOrderOpsService;

  beforeEach(async () => {
    service = new FakeDropshipOrderOpsService();
    server = await startServer(buildApp(service as unknown as DropshipOrderOpsService));
  });

  afterEach(async () => {
    await server.close();
  });

  it("loads admin intake detail with optional scope filters", async () => {
    const response = await jsonRequest(
      `${server.url}/api/dropship/admin/order-intake/42?vendorId=10&storeConnectionId=22`,
    );

    expect(response.status).toBe(200);
    expect(response.body.order).toMatchObject({
      intakeId: 42,
      vendor: { vendorId: 10 },
      storeConnection: { storeConnectionId: 22 },
      trackingPushes: [
        {
          pushId: 40,
          wmsShipmentId: 700,
          status: "succeeded",
          trackingNumber: "94001111",
        },
      ],
    });
    expect(response.body.order.receivedAt).toBe("2026-05-02T12:00:00.000Z");
    expect(service.lastDetailInput).toEqual({
      intakeId: 42,
      vendorId: 10,
      storeConnectionId: 22,
    });
  });

  it("rejects invalid admin intake detail ids before service access", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/admin/order-intake/not-a-number`);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "DROPSHIP_ORDER_OPS_INVALID_REQUEST",
    });
    expect(service.lastDetailInput).toBeNull();
  });

  it("routes admin WMS sync retry with idempotency and actor context", async () => {
    const response = await jsonRequest(
      `${server.url}/api/dropship/admin/order-intake/42/retry-wms-sync`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "retry-wms-route-42",
        },
        body: JSON.stringify({ reason: "dogfood repair" }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      intakeId: 42,
      omsOrderId: 9001,
      outcome: "queued",
      retryQueued: true,
    });
    expect(service.lastWmsSyncInput).toMatchObject({
      intakeId: 42,
      reason: "dogfood repair",
      idempotencyKey: "retry-wms-route-42",
      actor: { actorType: "admin" },
    });
  });
});

class FakeDropshipOrderOpsService {
  lastDetailInput: unknown = null;
  lastWmsSyncInput: unknown = null;

  async getIntakeDetail(input: unknown) {
    this.lastDetailInput = input;
    return makeOrderDetail();
  }

  async retryWmsSync(input: unknown) {
    this.lastWmsSyncInput = input;
    return {
      intakeId: 42,
      vendorId: 10,
      storeConnectionId: 22,
      omsOrderId: 9001,
      outcome: "queued",
      wmsOrderId: null,
      retryQueued: true,
      failureMessage: "WMS sync service unavailable",
      updatedAt: new Date("2026-05-02T12:00:00.000Z"),
    };
  }
}

function buildApp(service: DropshipOrderOpsService): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request & { session?: { user?: { id: string } } }, _res, next) => {
    req.session = { user: { id: "admin-1" } };
    next();
  });
  registerDropshipAdminOrderOpsRoutes(app, service);
  return app;
}

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
  return {
    status: response.status,
    body: await response.json(),
  };
}

function makeOrderDetail() {
  const receivedAt = new Date("2026-05-02T12:00:00.000Z");
  return {
    intakeId: 42,
    vendor: {
      vendorId: 10,
      memberId: "member-1",
      businessName: "Vendor Co",
      email: "vendor@example.test",
      status: "active",
      entitlementStatus: "active",
    },
    storeConnection: {
      storeConnectionId: 22,
      platform: "ebay",
      status: "connected",
      setupStatus: "ready",
      launchReady: true,
      externalDisplayName: "Vendor eBay",
      shopDomain: null,
    },
    platform: "ebay",
    externalOrderId: "ORDER-42",
    externalOrderNumber: "1001",
    sourceOrderId: "source-42",
    status: "accepted",
    paymentHoldExpiresAt: null,
    rejectionReason: null,
    cancellationStatus: null,
    omsOrderId: 9001,
    receivedAt,
    acceptedAt: receivedAt,
    updatedAt: receivedAt,
    lineCount: 1,
    totalQuantity: 2,
    shipTo: { country: "US", postalCode: "10001" },
    orderedAt: "2026-05-02T11:30:00.000Z",
    marketplaceStatus: "paid",
    latestAuditEvent: {
      eventType: "order_accepted",
      severity: "info",
      createdAt: receivedAt,
      payload: {},
    },
    totals: {
      retailSubtotalCents: 2598,
      shippingPaidCents: 599,
      taxCents: 0,
      discountCents: 0,
      grandTotalCents: 3197,
      currency: "USD",
    },
    lines: [{
      lineIndex: 0,
      externalLineItemId: "line-1",
      externalListingId: "listing-1",
      externalOfferId: null,
      sku: "SKU-1",
      productVariantId: 123,
      quantity: 2,
      unitRetailPriceCents: 1299,
      lineRetailTotalCents: 2598,
      title: "Card Shell",
    }],
    economicsSnapshot: null,
    shippingQuoteSnapshot: null,
    walletLedgerEntry: null,
    trackingPushes: [{
      pushId: 40,
      wmsShipmentId: 700,
      platform: "ebay",
      status: "succeeded",
      carrier: "USPS",
      trackingNumber: "94001111",
      shippedAt: receivedAt,
      externalFulfillmentId: "fulfillment-1",
      attemptCount: 1,
      retryable: false,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: receivedAt,
      updatedAt: receivedAt,
      completedAt: receivedAt,
    }],
    auditEvents: [{
      eventType: "order_accepted",
      actorType: "system",
      actorId: null,
      severity: "info",
      payload: {},
      createdAt: receivedAt,
    }],
  };
}
