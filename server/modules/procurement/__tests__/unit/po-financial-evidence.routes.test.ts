import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PoFinancialEvidence } from "@shared/procurement/po-financial-evidence";

const access = vi.hoisted(() => ({ allowed: true, calls: [] as string[] }));
vi.mock("../../../../routes/middleware", () => ({
  requirePermission:
    (resource: string, action: string) =>
    (req: Request, res: Response, next: NextFunction) => {
      access.calls.push(`${resource}:${action}`);
      if (!access.allowed)
        return res.status(403).json({ error: "Permission denied" });
      next();
    },
}));
vi.mock("../../../../db", () => ({ db: {} }));
import { logger } from "../../../../platform/observability/logger";
import { registerPoFinancialEvidenceRoutes } from "../../po-financial-evidence.routes";
import { PoFinancialEvidenceSourceError } from "../../po-financial-evidence.repository";

const complete = (): PoFinancialEvidence => ({
  purchaseOrderId: 10,
  currency: "USD",
  state: "complete",
  invoicedAmountCents: 1000,
  paidAmountCents: 0,
  outstandingAmountCents: 1000,
  invoiceCount: 1,
  reviewReasons: [],
});

describe("purchase order financial evidence HTTP boundary", () => {
  const read = vi.fn<(id: number) => Promise<PoFinancialEvidence | null>>();
  let server: Server, base: string;
  beforeAll(async () => {
    const app = express();
    registerPoFinancialEvidenceRoutes(app, { read });
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    read.mockReset();
    access.allowed = true;
    access.calls = [];
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const request = (id = "10") =>
    requestLocalHttp(`${base}/api/purchase-orders/${id}/financial-evidence`);

  it("returns validated known PO amounts under purchasing view permission", async () => {
    read.mockResolvedValue(complete());
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(complete());
    expect(read).toHaveBeenCalledWith(10);
    expect(access.calls).toEqual(["purchasing:view"]);
  });
  it("preserves unknown settlement rather than returning zero", async () => {
    const evidence: PoFinancialEvidence = {
      ...complete(),
      state: "review_required",
      paidAmountCents: null,
      outstandingAmountCents: null,
      reviewReasons: [
        {
          code: "SHARED_INVOICE_PAYMENT_UNALLOCATED",
          message: "Review shared invoice.",
          invoiceId: 7,
        },
      ],
    };
    read.mockResolvedValue(evidence);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(evidence);
  });
  it("denies a reader without permission before querying evidence", async () => {
    access.allowed = false;
    expect((await request()).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "01", "1.5", "nope", "2147483648", "9007199254740992"])(
    "rejects malformed ID %s before reading",
    async (id) => {
      const response = await request(id);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "PO_FINANCIAL_EVIDENCE_ID_INVALID",
      });
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("distinguishes a missing PO from a zero financial balance", async () => {
    read.mockResolvedValue(null);
    const response = await request();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "PO_NOT_FOUND" });
  });
  it("reports missing linked source as unavailable and logs its classified identity", async () => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    read.mockRejectedValue(new PoFinancialEvidenceSourceError());
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "PO_FINANCIAL_EVIDENCE_SOURCE_MISSING",
    });
    expect(log).toHaveBeenCalledWith(
      "procurement.po_financial_evidence",
      expect.objectContaining({
        purchase_order_id: 10,
        error_code: "PO_FINANCIAL_EVIDENCE_SOURCE_MISSING",
      }),
    );
  });
  it("does not expose internal database error details or turn failure into zero", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    read.mockRejectedValue(new Error("private database connection details"));
    const response = await request();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ code: "PO_FINANCIAL_EVIDENCE_UNAVAILABLE" });
    expect(JSON.stringify(body)).not.toContain("private database");
    expect(body).not.toHaveProperty("invoicedAmountCents");
  });
  it("rejects malformed successful service output at the HTTP boundary", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    read.mockResolvedValue({
      ...complete(),
      paidAmountCents: null,
    } as PoFinancialEvidence);
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "PO_FINANCIAL_EVIDENCE_UNAVAILABLE",
    });
  });
});
