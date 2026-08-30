import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerInventoryAvailabilityBackfillRoutes } from "../../interfaces/http/inventory-availability-backfill.routes";

const HASH = "a".repeat(64);
const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({ requirePermission: requirePermissionMock }));

describe("inventory availability backfill routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: ReturnType<typeof fakeService>;

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = fakeService();
    server = await startServer(buildApp(service));
  });
  afterEach(async () => server.close());

  it("serves the full queue under view permission", async () => {
    service.getMigrationQueue.mockResolvedValue(queue());
    const response = await jsonRequest(`${server.url}/api/inventory-planning/admin/migration-queue`);
    expect(response).toMatchObject({
      status: 200,
      body: { summary: { totalActiveProducts: 1 }, products: [{ productId: 10 }] },
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "view");
  });

  it("forwards draft evidence and the authenticated actor under edit permission", async () => {
    service.applyProductDraft.mockResolvedValue({
      modelId: 50,
      version: 1,
      definitionHash: HASH,
      alreadyApplied: false,
      inputHash: HASH,
      resultHash: HASH,
    });
    const request = {
      expectedInputHash: HASH,
      expectedResultHash: HASH,
      changeReason: "Phase 3 mapping",
      idempotencyKey: "phase3-10",
    };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/migration-queue/10/drafts`,
      jsonPost(request),
    );
    expect(response.status).toBe(201);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "edit");
    expect(service.applyProductDraft).toHaveBeenCalledWith(10, request, "operator-1");
  });

  it("records hash-bound review evidence", async () => {
    service.reviewProductDraft.mockResolvedValue({
      alreadyApplied: false,
      review: {
        reviewId: "1",
        decision: "approved",
        reason: "Verified",
        reviewedBy: "operator-1",
        reviewedAt: "2026-08-28T12:00:00.000Z",
        modelId: 50,
        modelVersion: 1,
        modelDefinitionHash: HASH,
      },
    });
    const request = {
      expectedModelId: 50,
      expectedModelVersion: 1,
      expectedDefinitionHash: HASH,
      expectedHeadRevision: "1",
      decision: "approved",
      reason: "Verified",
      idempotencyKey: "review-10",
    };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/migration-queue/10/reviews`,
      jsonPost(request),
    );
    expect(response.status).toBe(201);
    expect(service.reviewProductDraft).toHaveBeenCalledWith(10, request, "operator-1");
  });

  it("serves blocker-only channel preview under view permission", async () => {
    service.getChannelPreview.mockResolvedValue({
      productId: 10,
      shadowRunId: "9",
      snapshotFingerprint: HASH,
      shadowCapturedAt: "2026-08-28T12:00:00.000Z",
      modelId: null,
      modelVersion: null,
      modelDefinitionHash: null,
      policyAuthority: "legacy_channel_allocation_rules",
      runtimeAuthorityChanged: false,
      providerWriteAttempted: false,
      allocationAuditWritten: false,
      blockers: [{ code: "SHADOW_MODEL_STALE", severity: "blocking", message: "Run a current shadow.", context: {} }],
      rows: [],
    });
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/migration-queue/10/channel-preview`,
    );
    expect(response).toMatchObject({
      status: 200,
      body: { runtimeAuthorityChanged: false, providerWriteAttempted: false, allocationAuditWritten: false },
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "view");
  });

  it("rejects unauthenticated draft writers before calling the service", async () => {
    await server.close();
    server = await startServer(buildApp(service, false));
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/migration-queue/10/drafts`,
      jsonPost({}),
    );
    expect(response).toMatchObject({
      status: 401,
      body: { error: { code: "INVENTORY_AVAILABILITY_ACTOR_REQUIRED" } },
    });
    expect(service.applyProductDraft).not.toHaveBeenCalled();
  });

  it("returns a retryable conflict when a serializable review loses a concurrency race", async () => {
    service.reviewProductDraft.mockRejectedValue(Object.assign(
      new Error("could not serialize access due to concurrent update"),
      { code: "40001" },
    ));

    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/migration-queue/10/reviews`,
      jsonPost({}),
    );

    expect(response).toMatchObject({
      status: 409,
      body: { error: { code: "INVENTORY_AVAILABILITY_CONCURRENT_CHANGE" } },
    });
  });
});

function fakeService() {
  return {
    getMigrationQueue: vi.fn(),
    applyProductDraft: vi.fn(),
    reviewProductDraft: vi.fn(),
    getChannelPreview: vi.fn(),
  };
}

function queue() {
  return {
    algorithmVersion: "inventory_availability_backfill_v2" as const,
    capturedAt: "2026-08-28T12:00:00.000Z",
    catalogInputHash: HASH,
    catalogResultHash: HASH,
    summary: {
      totalActiveProducts: 1,
      blocked: 0,
      excluded: 0,
      notBackfilled: 1,
      conflictingDraft: 0,
      awaitingReview: 0,
      changesRequired: 0,
      approved: 0,
    },
    products: [{
      productId: 10,
      productSku: "PRODUCT",
      productName: "Product",
      legacyInventoryStrategy: "physical_only" as const,
      activeVariantCount: 1,
      activeRecipeCount: 0,
      classification: "exact_only" as const,
      inputHash: HASH,
      resultHash: HASH,
      candidateDefinitionHash: HASH,
      candidateDefinition: { buildToPromiseEnabled: false, paths: [], recipeBindings: [] },
      issues: [],
      queueState: "not_backfilled" as const,
      draft: null,
      review: null,
      latestShadow: null,
    }],
  };
}

function buildApp(service: ReturnType<typeof fakeService>, authenticated = true): express.Express {
  const app = express();
  app.use(express.json());
  if (authenticated) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, "session", {
        configurable: true,
        value: { user: { id: "operator-1" } },
      });
      next();
    });
  }
  registerInventoryAvailabilityBackfillRoutes(app, { service });
  return app;
}

async function startServer(app: express.Express) {
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

async function jsonRequest(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: init?.method ?? "GET",
      headers: init?.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body: rawBody === "" ? {} : JSON.parse(rawBody) as Record<string, unknown>,
        });
      });
    });
    request.on("error", reject);
    if (init?.body !== undefined) request.write(init.body);
    request.end();
  });
}

function jsonPost(body: unknown) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
