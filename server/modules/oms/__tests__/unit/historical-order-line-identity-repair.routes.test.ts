import type { Express, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  apply: vi.fn(),
  createService: vi.fn(),
  permission: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock("../../../../db", () => ({ db: { marker: "database" } }));
vi.mock("../../../../routes/middleware", () => ({
  requireAuth: vi.fn(),
  requirePermission: mocks.permission,
}));
vi.mock("../../application/historical-order-line-identity-repair.service", () => ({
  createHistoricalOrderLineIdentityRepairService: mocks.createService,
}));
vi.mock("../../oms-flow-reconciliation.service", () => ({ remediateOmsFlowIssue: vi.fn() }));
vi.mock("../../ops-health.service", () => ({ getOmsOpsHealth: vi.fn() }));
vi.mock("../../flow-waterfall.service", () => ({ getFlowWaterfall: vi.fn(), getFlowBucketSamples: vi.fn() }));
vi.mock("../../flow-trace.service", () => ({ getFlowTrace: vi.fn() }));
vi.mock("../../webhook-inbox.service", () => ({ enqueueWebhookInboxReplay: vi.fn() }));
vi.mock("../../webhook-retry.worker", () => ({ requeueDeadWebhookRetry: vi.fn() }));
vi.mock("../../../identity", () => ({ hasPermission: vi.fn() }));
vi.mock("../../shipstation-unmapped-remediation.service", () => ({
  adoptShipStationUnmappedPhysicalAsReship: vi.fn(),
  getShipStationUnmappedPhysicalPreview: vi.fn(),
  resolveShipStationUnmappedPhysicalAsProviderEcho: vi.fn(),
  resolveShipStationUnmappedPhysicalAsReturnLabel: vi.fn(),
  resolveShipStationUnmappedPhysicalAsVoidedLabel: vi.fn(),
}));

import { registerOmsRoutes } from "../../../../routes/oms.routes";
import { HistoricalIdentityRepairError } from "../../domain/historical-order-line-identity-repair";

type Handler = (request: Request, response: Response) => Promise<void>;

function harness(userId: unknown = 7) {
  const app = { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  registerOmsRoutes(app as unknown as Express);
  const getRegistration = app.get.mock.calls.find((args) =>
    args[0] === "/api/oms/ops/historical-line-identity-repair/:omsOrderId/preview");
  const postRegistration = app.post.mock.calls.find((args) =>
    args[0] === "/api/oms/ops/historical-line-identity-repair/:omsOrderId/apply");
  if (!getRegistration || !postRegistration) throw new Error("Historical repair routes were not registered");
  const services = { reservation: { reconcileOrderDemand: vi.fn() } };
  const request = {
    params: { omsOrderId: "77" },
    body: {
      expectedPreviewHash: "a".repeat(64),
      idempotencyKey: "ba01e537-6af2-46f1-bc92-9de0105aff19",
      reason: "Reviewed historical repair",
      actor: "user:1",
    },
    session: { user: { id: userId, username: "mutable-name" } },
    app: { locals: { services } },
  } as unknown as Request;
  const response = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  response.status.mockReturnValue(response);
  return {
    getHandler: getRegistration.at(-1) as Handler,
    postHandler: postRegistration.at(-1) as Handler,
    request,
    response: response as unknown as Response,
    services,
  };
}

describe("historical order-line identity repair routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createService.mockReturnValue({ preview: mocks.preview, apply: mocks.apply });
  });

  it("role-gates the preview and returns no-store evidence", async () => {
    const h = harness();
    mocks.preview.mockResolvedValue({ previewHash: "a".repeat(64), safeCount: 4 });
    await h.getHandler(h.request, h.response);
    expect(mocks.permission).toHaveBeenCalledWith("operations", "triage");
    expect(mocks.createService).toHaveBeenCalledWith({ marker: "database" }, h.services.reservation);
    expect(mocks.preview).toHaveBeenCalledWith(77);
    expect(h.response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(h.response.json).toHaveBeenCalledWith({ previewHash: "a".repeat(64), safeCount: 4 });
  });

  it("uses the authenticated stable actor and ignores client-supplied actor fields", async () => {
    const h = harness();
    mocks.apply.mockResolvedValue({ commandId: 91, status: "succeeded" });
    await h.postHandler(h.request, h.response);
    expect(mocks.apply).toHaveBeenCalledWith(77, h.request.body, {
      operator: "user:7",
      userId: "7",
    });
    expect(h.response.json).toHaveBeenCalledWith({ commandId: 91, status: "succeeded" });
  });

  it.each([0, null, "7", Number.NaN])("rejects an invalid audit actor: %j", async (userId) => {
    const h = harness(userId);
    await h.postHandler(h.request, h.response);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(h.response.status).toHaveBeenCalledWith(403);
    expect(h.response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: "REPAIR_OPERATOR_REQUIRED",
    }));
  });

  it.each([400, 404, 409, 503])("preserves structured repair failures with HTTP %s", async (status) => {
    const h = harness();
    mocks.apply.mockRejectedValue(new HistoricalIdentityRepairError(
      "TEST_REPAIR_ERROR",
      "Repair failed safely",
      status,
      { commandId: 91 },
    ));
    await h.postHandler(h.request, h.response);
    expect(h.response.status).toHaveBeenCalledWith(status);
    expect(h.response.json).toHaveBeenCalledWith({
      error: "Repair failed safely",
      code: "TEST_REPAIR_ERROR",
      context: { commandId: 91 },
    });
  });

  it("fails closed when the canonical claim owner is unavailable", async () => {
    const h = harness();
    (h.request.app.locals.services as any).reservation = null;
    await h.getHandler(h.request, h.response);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(h.response.status).toHaveBeenCalledWith(503);
    expect(h.response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: "REPAIR_CLAIM_OWNER_UNAVAILABLE",
    }));
  });
});
