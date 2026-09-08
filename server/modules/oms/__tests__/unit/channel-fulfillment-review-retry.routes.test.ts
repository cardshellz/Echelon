import type { Express, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  remediate: vi.fn(),
  permission: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../routes/middleware", () => ({
  requireAuth: vi.fn(), requirePermission: mocks.permission,
}));
vi.mock("../../oms-flow-reconciliation.service", () => ({ remediateOmsFlowIssue: mocks.remediate }));
vi.mock("../../ops-health.service", () => ({ getOmsOpsHealth: vi.fn() }));
vi.mock("../../flow-waterfall.service", () => ({ getFlowWaterfall: vi.fn(), getFlowBucketSamples: vi.fn() }));
vi.mock("../../flow-trace.service", () => ({ getFlowTrace: vi.fn() }));
vi.mock("../../webhook-inbox.service", () => ({ enqueueWebhookInboxReplay: vi.fn() }));
vi.mock("../../webhook-retry.worker", () => ({ requeueDeadWebhookRetry: vi.fn() }));
vi.mock("../../../identity", () => ({ hasPermission: vi.fn() }));
vi.mock("../../shipstation-unmapped-remediation.service", () => ({
  adoptShipStationUnmappedPhysicalAsReship: vi.fn(), getShipStationUnmappedPhysicalPreview: vi.fn(),
  resolveShipStationUnmappedPhysicalAsProviderEcho: vi.fn(), resolveShipStationUnmappedPhysicalAsReturnLabel: vi.fn(),
  resolveShipStationUnmappedPhysicalAsVoidedLabel: vi.fn(),
}));

import { registerOmsRoutes } from "../../../../routes/oms.routes";
import { CHANNEL_FULFILLMENT_REVIEW_RETRY, ChannelFulfillmentReviewRetryError } from "../../channel-fulfillment-review-retry.domain";

type Handler = (request: Request, response: Response) => Promise<void>;
function harness(userId: unknown = 7) {
  const post = vi.fn();
  const app = { get: vi.fn(), post, put: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  registerOmsRoutes(app as unknown as Express);
  const registered = post.mock.calls.find((args) => args[0] === "/api/oms/ops/reconciliation/remediate");
  if (!registered) throw new Error("OMS reconciliation route was not registered");
  const handler = registered[registered.length - 1] as Handler;
  const reviewRetry = { review: vi.fn() };
  const request = {
    body: { code: CHANNEL_FULFILLMENT_REVIEW_RETRY, commandId: 3024, omsOrderId: 901 },
    session: { user: { id: userId, username: "Display name is not an audit identity" } },
    app: { locals: { services: { channelFulfillmentAuthority: {}, channelFulfillmentReviewRetry: reviewRetry } } },
  } as unknown as Request;
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return { handler, request, response, reviewRetry };
}

describe("reviewed fulfillment recovery through existing Ops route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the triage permission and uses the authenticated stable actor", async () => {
    const h = harness();
    mocks.remediate.mockResolvedValue({ changed: false, reviewRetry: { mode: "preview" } });
    await h.handler(h.request, h.response as unknown as Response);
    expect(mocks.permission).toHaveBeenCalledWith("operations", "triage");
    expect(mocks.remediate).toHaveBeenCalledWith({}, expect.objectContaining({
      code: CHANNEL_FULFILLMENT_REVIEW_RETRY, commandId: 3024, omsOrderId: 901,
      previewOnly: undefined, operator: "user:7",
    }), expect.objectContaining({ reviewRetry: h.reviewRetry }));
    expect(h.response.json).toHaveBeenCalledWith({ changed: false, reviewRetry: { mode: "preview" } });
  });

  it("passes only explicit reviewed retry fields and ignores a client-supplied actor", async () => {
    const h = harness();
    h.request.body = {
      ...h.request.body, previewOnly: false, expectedStateFingerprint: "a".repeat(64),
      reason: "Reviewed corrected adapter", operator: "user:1", actor: "user:1",
    };
    await h.handler(h.request, h.response as unknown as Response);
    expect(mocks.remediate).toHaveBeenCalledWith({}, expect.objectContaining({
      operator: "user:7", previewOnly: false, expectedStateFingerprint: "a".repeat(64),
      reason: "Reviewed corrected adapter",
    }), expect.anything());
  });

  it.each([0, null, "7", NaN])("does not fall back to an unknown or unchecked actor: %j", async (userId) => {
    const h = harness(userId);
    await h.handler(h.request, h.response as unknown as Response);
    expect(mocks.remediate).not.toHaveBeenCalled();
    expect(h.response.status).toHaveBeenCalledWith(403);
    expect(h.response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "REVIEW_RETRY_ACTOR_REQUIRED" }));
  });

  it.each([400, 404, 409, 503])("returns structured owner failures with HTTP %s", async (status) => {
    const h = harness();
    mocks.remediate.mockRejectedValue(new ChannelFulfillmentReviewRetryError(
      "TEST_REVIEW_RETRY_ERROR", "A reviewed retry failed", status, { commandId: 3024 },
    ));
    await h.handler(h.request, h.response as unknown as Response);
    expect(h.response.status).toHaveBeenCalledWith(status);
    expect(h.response.json).toHaveBeenCalledWith({
      error: "A reviewed retry failed", code: "TEST_REVIEW_RETRY_ERROR", context: { commandId: 3024 },
    });
  });
});
