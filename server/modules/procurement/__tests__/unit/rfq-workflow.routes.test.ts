import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  detail: vi.fn(),
  history: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("../../../../modules/identity", () => ({ hasPermission: mocks.hasPermission }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../rfq-workflow.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../rfq-workflow.service")>(),
  createRfqWorkflowService: () => ({ getDetail: mocks.detail, getQuoteHistory: mocks.history }),
}));
vi.mock("../../rfq-workflow.commands", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../rfq-workflow.commands")>(),
  createRfqWorkflowCommands: () => ({ execute: mocks.execute }),
}));

import { registerRfqWorkflowRoutes } from "../../rfq-workflow.routes";
import { RfqEvidenceIntegrityError } from "../../rfq-workflow.repository";
import { RfqWorkflowError } from "../../rfq-workflow.service";

describe("RFQ workflow HTTP authority and durable command identity", () => {
  let server: http.Server;
  let origin: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.hasPermission.mockResolvedValue(true);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { user: req.header("X-Test-Actor") ? { id: req.header("X-Test-Actor") } : undefined } as never;
      next();
    });
    app.locals.services = { purchasing: {} };
    registerRfqWorkflowRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    vi.restoreAllMocks();
  });
  function request(path: string, options: { actor?: string | null; key?: string; body?: unknown } = {}) {
    return fetch(origin + path, {
      method: options.body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(options.actor === null ? {} : { "X-Test-Actor": options.actor ?? "reviewer" }), ...(options.key ? { "Idempotency-Key": options.key } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  it.each(["/api/purchasing/rfqs/10/convert", "/api/purchasing/rfqs/10/lines/20/quotes"])("requires edit permission before invoking %s", async (path) => {
    mocks.hasPermission.mockResolvedValue(false);
    expect((await request(path, { body: {}, key: "rfq-command-123" })).status).toBe(403);
    expect(mocks.hasPermission).toHaveBeenCalledWith("reviewer", "purchasing", "edit");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("requires an authenticated session before reading or mutating", async () => {
    expect((await request("/api/purchasing/rfqs/10", { actor: null })).status).toBe(401);
    expect((await request("/api/purchasing/rfqs/10/convert", { actor: null, body: {} })).status).toBe(401);
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("reads exact RFQ and history identifiers with view permission", async () => {
    mocks.detail.mockResolvedValue({ id: 10 });
    mocks.history.mockResolvedValue({ revisions: [], nextBeforeRevision: null });
    expect((await request("/api/purchasing/rfqs/10")).status).toBe(200);
    expect((await request("/api/purchasing/rfqs/10/lines/20/quotes?beforeRevision=9")).status).toBe(200);
    expect(mocks.detail).toHaveBeenCalledWith(10);
    expect(mocks.history).toHaveBeenCalledWith(10, 20, 9);
    expect(mocks.hasPermission).toHaveBeenCalledWith("reviewer", "inventory", "view");
  });
  it.each(["0", "-1", "1e2", "2147483648"])("rejects invalid RFQ identity %s", async (id) => {
    expect((await request(`/api/purchasing/rfqs/${id}`)).status).toBe(400);
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it("requires a financial command key before mutation", async () => {
    const response = await request("/api/purchasing/rfqs/10/convert", { body: {} });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REQUIRED" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("preserves the authenticated actor, exact route scope and replay response", async () => {
    mocks.execute.mockResolvedValue({ httpStatus: 201, body: { purchaseOrderId: 30 }, replayed: true });
    const body = { expectedVersion: "a".repeat(64), lines: [{ rfqLineId: 20, quoteRevisionId: 7 }], quantityOverrideReason: null };
    const response = await request("/api/purchasing/rfqs/10/convert", { actor: "delegate", key: "rfq-command-123", body });
    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(mocks.execute).toHaveBeenCalledWith({ operation: "convert", rfqId: 10, body }, "delegate", expect.objectContaining({
      actorType: "service", actorId: "procurement.rfq-workflow", resourceKey: "rfq:10", routeTemplate: "/api/purchasing/rfqs/:rfqId/convert", commandName: "procurement.rfq.convert", idempotencyKey: "rfq-command-123", requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });
  it("maps review conflicts separately from invalid stored evidence without leaking details", async () => {
    mocks.detail.mockRejectedValueOnce(new RfqWorkflowError("RFQ_NOT_FOUND", "Quote request was not found", 404));
    expect((await request("/api/purchasing/rfqs/10")).status).toBe(404);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.detail.mockRejectedValueOnce(new RfqEvidenceIntegrityError());
    const response = await request("/api/purchasing/rfqs/10");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "RFQ_TRANSIENT_FAILURE" });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('"event":"procurement.rfq.workflow_failed"'));
  });
});
