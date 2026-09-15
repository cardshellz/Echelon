import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerInventoryChannelExposureRoutes } from "../../interfaces/http/inventory-channel-exposure.routes";

const HASH = "a".repeat(64);
const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown, _res: unknown, next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({ requirePermission: requirePermissionMock }));

describe("inventory channel exposure routes", () => {
  let server: { url: string; close(): Promise<void> };
  let service: {
    getView: ReturnType<typeof vi.fn>;
    preview: ReturnType<typeof vi.fn>;
    savePolicyDraft: ReturnType<typeof vi.fn>;
    saveSourceBindingDraft: ReturnType<typeof vi.fn>;
    createPublicationTarget: ReturnType<typeof vi.fn>;
    setPublicationTargetPreviewState: ReturnType<typeof vi.fn>;
    saveVariantMappingDraft: ReturnType<typeof vi.fn>;
  };
  let targetStopService: { stop: ReturnType<typeof vi.fn> };
  let targetResumeService: {
    review: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = {
      getView: vi.fn(async () => ({
        products: [], selectedProduct: null, channels: [],
        dropshipDestinationChannelId: null, dropshipStores: [], publicationTargets: [],
        fulfillmentNodes: [], policyHeads: [], policySubjects: [], sourceBindingHeads: [],
        variantMappingHeads: [], legacyMappingCandidates: [],
        runtimeAuthority: "legacy", runtimeAuthorityRevision: "1", providerWriteEnabled: false,
      })),
      preview: vi.fn(),
      savePolicyDraft: vi.fn(async () => saveResult()),
      saveSourceBindingDraft: vi.fn(async () => saveResult()),
      createPublicationTarget: vi.fn(async () => targetResult()),
      setPublicationTargetPreviewState: vi.fn(async () => targetResult("preview", "2")),
      saveVariantMappingDraft: vi.fn(async () => saveResult()),
    };
    targetStopService = { stop: vi.fn(async () => targetResult("disabled", "4")) };
    targetResumeService = {
      review: vi.fn(async (request, actorId) => blockedResumeReview(request, actorId)),
      resume: vi.fn(async (request) => resumeResult(request)),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, "session", { value: { user: { id: "operator-1" } } });
      next();
    });
    registerInventoryChannelExposureRoutes(app, { service, targetStopService, targetResumeService });
    server = await startServer(app);
  });

  afterEach(async () => server.close());

  it("gates the view with inventory-planning view permission", async () => {
    const response = await jsonRequest(`${server.url}/api/inventory-planning/admin/channel-exposure`);
    expect(response.status).toBe(200);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "view");
    expect(service.getView).toHaveBeenCalledWith(null);
  });

  it("gates draft saves with edit permission and forwards the authenticated actor", async () => {
    const request = policyDraftRequest("route-policy-1");
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/policy-draft`,
      { method: "PUT", body: request },
    );
    expect(response.status).toBe(201);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "edit");
    expect(service.savePolicyDraft).toHaveBeenCalledWith(request, "operator-1");
  });

  it("accepts routine draft saves without a written reason and normalizes blank notes to null", async () => {
    const { changeReason: _omitted, ...withoutReason } = policyDraftRequest("route-policy-2");
    const omitted = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/policy-draft`,
      { method: "PUT", body: withoutReason },
    );
    expect(omitted.status).toBe(201);
    expect(service.savePolicyDraft).toHaveBeenLastCalledWith(
      { ...withoutReason, changeReason: null },
      "operator-1",
    );

    const blank = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/source-binding-draft`,
      { method: "PUT", body: {
        publicationTargetId: 12,
        fulfillmentNodeIds: [4, 8],
        expectedHeadRevision: "0",
        expectedDraftBindingId: null,
        expectedDraftDefinitionHash: null,
        changeReason: "   ",
        idempotencyKey: "route-source-2",
      } },
    );
    expect(blank.status).toBe(201);
    expect(service.saveSourceBindingDraft).toHaveBeenCalledWith(
      expect.objectContaining({ publicationTargetId: 12, changeReason: null }),
      "operator-1",
    );
  });

  it("still requires a written reason for readiness, stop, and resume commands", async () => {
    const previewState = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/publication-target-preview-state`,
      { method: "PUT", body: {
        publicationTargetId: 5, expectedRevision: "1", state: "preview", idempotencyKey: "no-reason-1",
      } },
    );
    expect(previewState.status).toBe(400);
    const stop = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/publication-target-stop`,
      { method: "PUT", body: {
        publicationTargetId: 5, expectedRevision: "1", changeReason: "", idempotencyKey: "no-reason-2",
      } },
    );
    expect(stop.status).toBe(400);
    const review = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/publication-target-resume-review`,
      { method: "POST", body: { publicationTargetId: 5, expectedRevision: "3", idempotencyKey: "no-reason-3" } },
    );
    expect(review.status).toBe(400);
    expect(service.setPublicationTargetPreviewState).not.toHaveBeenCalled();
    expect(targetStopService.stop).not.toHaveBeenCalled();
    expect(targetResumeService.review).not.toHaveBeenCalled();
  });

  it("rejects malformed source-binding inputs before the service", async () => {
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/source-binding-draft`,
      { method: "PUT", body: { publicationTargetId: 1, fulfillmentNodeIds: [] } },
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "INVENTORY_CHANNEL_EXPOSURE_INVALID_REQUEST" },
    });
    expect(service.saveSourceBindingDraft).not.toHaveBeenCalled();
  });

  it("creates disabled targets with edit permission and never exposes live state", async () => {
    const request = {
      channelId: 36,
      channelConnectionId: 44,
      legacyFulfillmentNodeId: 1,
      providerScopeType: "location",
      externalScopeId: "location-1",
      publicationAuthority: "echelon",
      changeReason: "Register exact Shopify destination",
      idempotencyKey: "route-target-1",
    };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/publication-target`,
      { method: "POST", body: request },
    );
    expect(response.status).toBe(201);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "edit");
    expect(service.createPublicationTarget).toHaveBeenCalledWith({
      ...request,
      destinationKind: "channel_connection",
      dropshipStoreConnectionId: null,
    }, "operator-1");
    expect(response.body).toMatchObject({ state: "disabled", providerWriteAttempted: false });
  });

  it("requires activate permission for the reversible readiness-preview state only", async () => {
    const request = {
      publicationTargetId: 5,
      expectedRevision: "1",
      state: "preview",
      changeReason: "Include reviewed destination in readiness evidence",
      idempotencyKey: "route-target-state-1",
    };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/publication-target-preview-state`,
      { method: "PUT", body: request },
    );
    expect(response.status).toBe(200);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "activate");
    expect(service.setPublicationTargetPreviewState).toHaveBeenCalledWith(request, "operator-1");

    const malformed = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/publication-target-preview-state`,
      { method: "PUT", body: { ...request, state: "live" } },
    );
    expect(malformed.status).toBe(400);
    expect(service.setPublicationTargetPreviewState).toHaveBeenCalledTimes(1);
  });

  it("role-gates target resume review and the exact evidence-bound resume command", async () => {
    const reviewRequest = {
      publicationTargetId: 5,
      expectedRevision: "3",
      idempotencyKey: "route-resume-review-1",
      reason: "Revalidate the stopped target before resuming publication",
    };
    const reviewResponse = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/publication-target-resume-review`,
      { method: "POST", body: reviewRequest },
    );
    expect(reviewResponse.status).toBe(201);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "activate");
    expect(targetResumeService.review).toHaveBeenCalledWith(reviewRequest, "operator-1");
    expect(reviewResponse.body).toMatchObject({ state: "blocked", providerWriteAttempted: false });

    const resumeRequest = {
      publicationTargetId: 5,
      expectedRevision: "3",
      resumeReviewId: "71",
      expectedEvidenceHash: HASH,
      idempotencyKey: "route-resume-1",
      reason: "Restore the reviewed target after resolving the incident",
    };
    const resumeResponse = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/publication-target-resume`,
      { method: "POST", body: resumeRequest },
    );
    expect(resumeResponse.status).toBe(200);
    expect(targetResumeService.resume).toHaveBeenCalledWith(resumeRequest, "operator-1");
    expect(resumeResponse.body).toMatchObject({ state: "live", outboxEnqueued: true });

    const malformed = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/publication-target-resume`,
      { method: "POST", body: { ...resumeRequest, expectedEvidenceHash: "bad" } },
    );
    expect(malformed.status).toBe(400);
    expect(targetResumeService.resume).toHaveBeenCalledTimes(1);
  });

  it("validates exact target/SKU mapping drafts before persistence", async () => {
    const request = {
      publicationTargetId: 5,
      productVariantId: 101,
      externalInventoryItemId: "inventory-item-1",
      externalSku: "EA",
      expectedHeadRevision: "0",
      expectedDraftMappingId: null,
      expectedDraftDefinitionHash: null,
      changeReason: "Map the exact provider inventory item",
      idempotencyKey: "route-mapping-1",
    };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/variant-mapping-draft`,
      { method: "PUT", body: request },
    );
    expect(response.status).toBe(201);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "edit");
    expect(service.saveVariantMappingDraft).toHaveBeenCalledWith(request, "operator-1");

    const malformed = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/variant-mapping-draft`,
      { method: "PUT", body: { ...request, externalInventoryItemId: "" } },
    );
    expect(malformed.status).toBe(400);
    expect(service.saveVariantMappingDraft).toHaveBeenCalledTimes(1);
  });
});

function policyDraftRequest(idempotencyKey: string) {
  return {
    scope: { scopeType: "channel", channelId: 3 },
    value: {
      allocationSemantics: "exposure", eligible: true, shareBps: 10000,
      holdbackSellableUnits: "0", maxPublish: { mode: "unlimited" },
      minPublishSellableUnits: "0",
    },
    expectedHeadRevision: "0",
    expectedDraftPolicyId: null,
    expectedDraftDefinitionHash: null,
    changeReason: "Initial reviewed channel default",
    idempotencyKey,
  };
}

function saveResult() {
  return {
    definitionId: 1,
    version: 1,
    definitionHash: HASH,
    headRevision: "1",
    alreadyApplied: false,
    runtimeAuthorityChanged: false,
    providerWriteAttempted: false,
  };
}

function targetResult(state: "disabled" | "preview" = "disabled", revision = "1") {
  return {
    publicationTargetId: 5,
    revision,
    state,
    alreadyApplied: false,
    runtimeAuthorityChanged: false as const,
    providerWriteAttempted: false as const,
    outboxEnqueued: false as const,
  };
}

function blockedResumeReview(
  request: { publicationTargetId: number; expectedRevision: string; reason: string },
  actorId: string,
) {
  return {
    resumeReviewId: "71",
    publicationTargetId: request.publicationTargetId,
    publicationTargetRevision: request.expectedRevision,
    authorityRevision: "9",
    activationRunId: "44",
    state: "blocked" as const,
    configurationHash: HASH,
    readinessHash: HASH,
    evidenceHash: HASH,
    requestedBy: actorId,
    reason: request.reason,
    capturedAt: "2026-09-14T12:00:00.000Z",
    identityCensus: [],
    products: [],
    blockers: [{ code: "MAPPING_MISSING", message: "A mapping is missing.", context: {} }],
    runtimeAuthorityChanged: false as const,
    providerWriteAttempted: false as const,
    outboxEnqueued: false as const,
    alreadyApplied: false,
  };
}

function resumeResult(request: {
  publicationTargetId: number;
  resumeReviewId: string;
  expectedEvidenceHash: string;
}) {
  return {
    publicationTargetId: request.publicationTargetId,
    revision: "4",
    state: "live" as const,
    activationRunId: "44",
    authorityRevision: "9",
    resumeReviewId: request.resumeReviewId,
    evidenceHash: request.expectedEvidenceHash,
    publicationRows: 1,
    alreadyApplied: false,
    runtimeAuthorityChanged: false as const,
    providerWriteAttempted: false as const,
    outboxEnqueued: true as const,
  };
}

async function startServer(app: express.Express) {
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => listener.close((error) =>
      error ? reject(error) : resolve())),
  };
}

async function jsonRequest(url: string, input?: { method: string; body: unknown }) {
  const target = new URL(url);
  const body = input ? JSON.stringify(input.body) : null;
  return new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: input?.method ?? "GET",
      headers: body === null ? {} : { "Content-Type": "application/json" },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>,
      }));
    });
    request.on("error", reject);
    if (body !== null) request.write(body);
    request.end();
  });
}
